import { Worker } from 'bullmq';
import { config } from './config.js';
import { cleanupExpiredEvents, db, redis } from './infra.js';

export function createWorker() {
  const worker = new Worker('webhook-delivery', async (job) => {
  const event = await db.query('SELECT * FROM webhook_events WHERE id=$1', [job.data.eventId]);
  if (!event.rows[0]) throw new Error('event not found');
  const row = event.rows[0];
  const attempt = job.attemptsMade + 1;
  await db.query('UPDATE webhook_events SET status=$1, attempts=$2 WHERE id=$3', ['delivering', attempt, row.id]);
  try {
    const response = await fetch(config.deliveryUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-event-id': row.external_event_id }, body: JSON.stringify(row.payload) });
    if (!response.ok) {
      const error = new Error(`delivery returned HTTP ${response.status}`) as Error & { retryable?: boolean; statusCode?: number };
      error.statusCode = response.status;
      error.retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      throw error;
    }
    await db.query('INSERT INTO delivery_attempts(event_id,attempt_number,status_code) VALUES($1,$2,$3)', [row.id, attempt, response.status]);
    await db.query('UPDATE webhook_events SET status=$1, delivered_at=now() WHERE id=$2', ['delivered', row.id]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'delivery failed';
    await db.query('INSERT INTO delivery_attempts(event_id,attempt_number,error) VALUES($1,$2,$3)', [row.id, attempt, message]);
    const retryable = error instanceof Error && (error as Error & { retryable?: boolean }).retryable !== false;
    const terminal = !retryable || attempt >= config.maxAttempts;
    await db.query('UPDATE webhook_events SET status=$1, last_error=$2 WHERE id=$3', [terminal ? 'dead_letter' : 'retrying', message, row.id]);
    if (!terminal) throw error;
  }
  }, { connection: redis });

  worker.on('failed', (job, error) => console.error(JSON.stringify({ event: 'delivery_failed', jobId: job?.id, error: error.message })));
  void cleanupExpiredEvents().catch((error) => console.error(JSON.stringify({ event: 'retention_cleanup_failed', error: error instanceof Error ? error.message : 'unknown error' })));
  const cleanupTimer = setInterval(() => void cleanupExpiredEvents().catch((error) => console.error(JSON.stringify({ event: 'retention_cleanup_failed', error: error instanceof Error ? error.message : 'unknown error' }))), 60 * 60 * 1000);
  worker.on('closed', () => clearInterval(cleanupTimer));
  return worker;
}

if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  createWorker();
  console.log('Webhook Shield worker started');
}
