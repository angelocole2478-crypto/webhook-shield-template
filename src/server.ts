import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { db, deliveryQueue, ensureSchema } from './infra.js';

export function buildApp() {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.x-webhook-secret', 'req.headers.x-monitor-secret'] } });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => { try { await db.query('SELECT 1'); return { status: 'ready' }; } catch { return reply.code(503).send({ status: 'not_ready' }); } });
  app.post('/webhooks', async (req, reply) => {
    if (req.headers['x-webhook-secret'] !== config.ingestSecret) return reply.code(401).send({ error: 'invalid webhook secret' });
    const externalId = String(req.headers['x-event-id'] ?? randomUUID());
    const id = randomUUID();
    try {
      const inserted = await db.query('INSERT INTO webhook_events (id, external_event_id, payload) VALUES ($1,$2,$3) ON CONFLICT (external_event_id) DO NOTHING RETURNING id', [id, externalId, req.body ?? {}]);
      const eventId = inserted.rows[0]?.id;
      if (!eventId) return reply.code(200).send({ status: 'already_accepted', external_event_id: externalId });
      await deliveryQueue.add('deliver', { eventId }, { attempts: config.maxAttempts, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: false });
      return reply.code(202).send({ status: 'queued', event_id: eventId });
    } catch (error) { req.log.error({ err: error }, 'webhook enqueue failed'); return reply.code(500).send({ error: 'could not queue webhook' }); }
  });
  app.get('/events/:id', async (req: any, reply) => {
    if (req.headers['x-monitor-secret'] !== config.monitorSecret) return reply.code(401).send({ error: 'unauthorized' });
    const result = await db.query('SELECT id, external_event_id, status, attempts, last_error, created_at, delivered_at FROM webhook_events WHERE id=$1', [req.params.id]);
    if (!result.rows[0]) return reply.code(404).send({ error: 'not found' });
    return result.rows[0];
  });
  app.post('/events/:id/replay', async (req: any, reply) => {
    if (req.headers['x-monitor-secret'] !== config.monitorSecret) return reply.code(401).send({ error: 'unauthorized' });
    const result = await db.query('SELECT id, status FROM webhook_events WHERE id=$1', [req.params.id]);
    if (!result.rows[0]) return reply.code(404).send({ error: 'not found' });
    if (result.rows[0].status !== 'dead_letter') return reply.code(409).send({ error: 'event is not in dead letter state' });
    await db.query('UPDATE webhook_events SET status=$1, attempts=0, last_error=NULL, delivered_at=NULL WHERE id=$2', ['queued', req.params.id]);
    await deliveryQueue.add('deliver', { eventId: req.params.id }, { attempts: config.maxAttempts, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: false });
    return reply.code(202).send({ status: 'replay_queued', event_id: req.params.id });
  });
  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  ensureSchema().then(() => buildApp().listen({ port: config.port, host: '0.0.0.0' })).catch((error) => { console.error(error.message); process.exit(1); });
}
