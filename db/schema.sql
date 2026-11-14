-- Active-Active GeoCache Relational Schema
-- Supports Hybrid Logical Clocks, Dead-Letter Queues, Partitioned Outbox, and Deduplication

CREATE TABLE IF NOT EXISTS records (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  data_type TEXT NOT NULL DEFAULT 'lww',
  hlc_time BIGINT NOT NULL DEFAULT 0,
  hlc_count INTEGER NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 0,
  origin_region TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS records_updated_idx ON records (updated_at);

CREATE TABLE IF NOT EXISTS replication_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL,
  destination_region TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  data_type TEXT NOT NULL DEFAULT 'lww',
  hlc_time BIGINT NOT NULL DEFAULT 0,
  hlc_count INTEGER NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 0,
  origin_region TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead_letter')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 10,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  trace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  UNIQUE (event_id, destination_region)
);

CREATE INDEX IF NOT EXISTS outbox_ready_idx
  ON replication_outbox (destination_region, status, next_attempt_at);

CREATE INDEX IF NOT EXISTS outbox_status_idx
  ON replication_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS replication_dlq (
  id BIGSERIAL PRIMARY KEY,
  outbox_id BIGINT,
  event_id UUID NOT NULL,
  destination_region TEXT NOT NULL,
  key TEXT NOT NULL,
  payload JSONB NOT NULL,
  failure_reason TEXT NOT NULL,
  retry_count INTEGER NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applied_events (
  event_id UUID PRIMARY KEY,
  origin_region TEXT NOT NULL,
  key TEXT,
  hlc_time BIGINT,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS applied_events_prune_idx ON applied_events (applied_at);

CREATE TABLE IF NOT EXISTS replication_checkpoints (
  destination_region TEXT PRIMARY KEY,
  last_acked_id BIGINT NOT NULL DEFAULT 0,
  last_acked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
