import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { config } from './config.js';

export const db = new Pool({ connectionString: config.databaseUrl, max: 5 });
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: process.env.NODE_ENV === 'test' });
export const deliveryQueue = process.env.NODE_ENV === 'test'
  ? { add: async () => undefined, close: async () => undefined }
  : new Queue('webhook-delivery', { connection: redis });

export async function ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS webhook_events (id UUID PRIMARY KEY, external_event_id TEXT NOT NULL UNIQUE, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), delivered_at TIMESTAMPTZ); CREATE INDEX IF NOT EXISTS webhook_events_created_at_idx ON webhook_events(created_at); CREATE TABLE IF NOT EXISTS delivery_attempts (id BIGSERIAL PRIMARY KEY, event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE, attempt_number INTEGER NOT NULL, status_code INTEGER, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
}

export async function cleanupExpiredEvents() {
  await db.query("DELETE FROM webhook_events WHERE created_at < now() - ($1::text || ' days')::interval", [String(config.retentionDays)]);
}

export async function closeInfra() {
  await deliveryQueue.close();
  if (process.env.NODE_ENV !== 'test') redis.disconnect();
  await db.end();
}
