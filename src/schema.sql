CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY,
  external_event_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_external_id ON webhook_events(external_event_id);
CREATE INDEX IF NOT EXISTS webhook_events_created_at_idx ON webhook_events(created_at);
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status_code INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
