import assert from 'node:assert/strict';
import http from 'node:http';
import { buildApp } from '../src/server.js';
import { ensureSchema, db, deliveryQueue, redis } from '../src/infra.js';
import { createWorker } from '../src/worker.js';

const destinationCounts = new Map<string, number>();
let destinationMode: 'retry' | 'dead' | 'recover' = 'retry';
const destination = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const eventId = req.headers['x-webhook-event-id'] as string;
    const count = (destinationCounts.get(eventId) ?? 0) + 1;
    destinationCounts.set(eventId, count);
    if (destinationMode === 'retry' && count < 3) { res.statusCode = 503; return res.end('temporary failure'); }
    if (destinationMode === 'dead') { res.statusCode = 503; return res.end('permanent failure'); }
    res.statusCode = 200; res.end('ok');
  });
});

await new Promise<void>(resolve => destination.listen(3999, '127.0.0.1', () => resolve()));
await ensureSchema();
await db.query('TRUNCATE delivery_attempts, webhook_events CASCADE');
let worker = createWorker();
const app = buildApp();
await app.ready();

async function waitForStatus(id: string, status: string, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await db.query('SELECT status, attempts FROM webhook_events WHERE id=$1', [id]);
    if (result.rows[0]?.status === status) return result.rows[0];
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for ${id}=${status}`);
}

const retryResponse = await app.inject({ method: 'POST', url: '/webhooks', headers: { 'x-webhook-secret': process.env.INGEST_SECRET!, 'x-event-id': 'integration-retry' }, payload: { type: 'retry-demo' } });
assert.equal(retryResponse.statusCode, 202);
const retryId = retryResponse.json().event_id;
const delivered = await waitForStatus(retryId, 'delivered');
assert.equal(delivered.attempts, 3);

await worker.close();
const restartResponse = await app.inject({ method: 'POST', url: '/webhooks', headers: { 'x-webhook-secret': process.env.INGEST_SECRET!, 'x-event-id': 'integration-restart' }, payload: { type: 'restart-demo' } });
assert.equal(restartResponse.statusCode, 202);
const restartId = restartResponse.json().event_id;
worker = createWorker();
await waitForStatus(restartId, 'delivered');

 destinationMode = 'dead';
const deadResponse = await app.inject({ method: 'POST', url: '/webhooks', headers: { 'x-webhook-secret': process.env.INGEST_SECRET!, 'x-event-id': 'integration-dead' }, payload: { type: 'dead-demo' } });
assert.equal(deadResponse.statusCode, 202);
const deadId = deadResponse.json().event_id;
const dead = await waitForStatus(deadId, 'dead_letter');
assert.equal(dead.attempts, 3);

destinationMode = 'recover';
const replayResponse = await app.inject({ method: 'POST', url: `/events/${deadId}/replay`, headers: { 'x-monitor-secret': process.env.MONITOR_SECRET! } });
assert.equal(replayResponse.statusCode, 202);
await waitForStatus(deadId, 'delivered');

const duplicate = await app.inject({ method: 'POST', url: '/webhooks', headers: { 'x-webhook-secret': process.env.INGEST_SECRET!, 'x-event-id': 'integration-retry' }, payload: { type: 'duplicate' } });
assert.equal(duplicate.statusCode, 200);
assert.equal(duplicate.json().status, 'already_accepted');

console.log(JSON.stringify({ integration: 'pass', retryAttempts: delivered.attempts, restart: 'delivered_after_worker_restart', deadLetterAttempts: dead.attempts, replay: 'delivered', duplicate: 'deduplicated' }));
await app.close();
await worker.close();
await deliveryQueue.close();
redis.disconnect();
await db.end();
await new Promise<void>(resolve => destination.close(() => resolve()));
