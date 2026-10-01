-- Token quota audit: one row per run, one per token actually deleted.
-- The point of the deletions table is to answer "why was this token deleted?"
-- months later, when the only handle anyone has is the token's name. Tokens that
-- were KEPT are deliberately not recorded: that would be ~48 rows per run for no
-- benefit, and a D1 write costs 1000x a read.
CREATE TABLE IF NOT EXISTS token_audit_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at       TEXT NOT NULL,
  mode             TEXT NOT NULL,
  actor            TEXT NOT NULL,
  tokens_seen      INTEGER NOT NULL,
  quota            INTEGER NOT NULL,
  headroom_before  INTEGER NOT NULL,
  verdict_counts   TEXT NOT NULL,
  deleted_count    INTEGER NOT NULL DEFAULT 0,
  retention_days   INTEGER NOT NULL,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_token_audit_runs_recent
  ON token_audit_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS token_audit_deletions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL,
  deleted_at  TEXT NOT NULL,
  token_id    TEXT NOT NULL,
  token_name  TEXT NOT NULL,
  idle_days   INTEGER,
  reason      TEXT NOT NULL,
  failed      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_token_audit_deletions_name
  ON token_audit_deletions (token_name, deleted_at DESC);
