-- Self-reported tool failures, deduped by signature.
-- Deduped because D1 bills a written row at 1000x a read row: a failure that
-- fires on every call must increment one row, not accumulate rows. The partial
-- index keeps resolved rows out of the only read path ("newest unresolved").
CREATE TABLE IF NOT EXISTS tool_failures (
  signature        TEXT PRIMARY KEY,
  tool             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  detail           TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  fixit_filed_at   TEXT,
  fixit_task_id    TEXT,
  resolved_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_failures_open
  ON tool_failures (kind, last_seen_at DESC)
  WHERE resolved_at IS NULL;
