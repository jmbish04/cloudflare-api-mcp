-- Workers CI/CD control, pause leases, build-log cache and reusable failure patterns.
-- All state is keyed by (account_id, worker_name); worker_tag is recorded alongside so a
-- delete/recreate of the Worker (which mints a new immutable tag) is detectable.

CREATE TABLE IF NOT EXISTS cicd_state (
  account_id      TEXT NOT NULL,
  worker_name     TEXT NOT NULL,
  worker_tag      TEXT NOT NULL,
  -- active | pausing | paused | resuming. The two -ing phases are persisted BEFORE the
  -- Cloudflare call so a partial failure is recoverable instead of silently inconsistent.
  phase           TEXT NOT NULL DEFAULT 'active',
  -- JSON snapshot of the trigger list as it was on the FIRST transition into pause.
  -- Never overwritten while paused, or a second pause would save the paused config.
  saved_config    TEXT,
  saved_at        TEXT,
  -- JSON snapshot of what we expect the remote to look like while paused, for drift detection.
  expected_config TEXT,
  revision        INTEGER NOT NULL DEFAULT 1,
  paused_at       TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (account_id, worker_name)
);

CREATE TABLE IF NOT EXISTS cicd_leases (
  lease_id        TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  worker_name     TEXT NOT NULL,
  worker_tag      TEXT NOT NULL,
  owner           TEXT NOT NULL,
  reason          TEXT,
  idempotency_key TEXT,
  acquired_at     TEXT NOT NULL,
  expires_at      TEXT,
  released_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_leases_active ON cicd_leases (account_id, worker_name, released_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_idem
  ON cicd_leases (account_id, worker_name, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS cicd_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  action      TEXT NOT NULL,
  actor       TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_worker ON cicd_audit (account_id, worker_name, id DESC);

CREATE TABLE IF NOT EXISTS build_patterns (
  pattern_id           TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  explanation          TEXT,
  match_method         TEXT NOT NULL,           -- substring | regex
  match_expression     TEXT NOT NULL,
  case_sensitive       INTEGER NOT NULL DEFAULT 0,
  scope_type           TEXT NOT NULL DEFAULT 'global', -- global|account|worker|repository|framework|tool
  scope_value          TEXT,
  severity             TEXT NOT NULL DEFAULT 'medium', -- low|medium|high|critical
  root_cause           TEXT,
  resolution_steps     TEXT,                    -- JSON array of strings
  lessons_learned      TEXT,
  verification_steps   TEXT,                    -- JSON array of strings
  supporting_build_ids TEXT,                    -- JSON array of build uuids
  doc_urls             TEXT,                    -- JSON array of urls
  version_constraints  TEXT,
  confidence           REAL NOT NULL DEFAULT 0.5,
  status               TEXT NOT NULL DEFAULT 'proposed', -- proposed|verified|deprecated
  superseded_by        TEXT,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  last_verified_at     TEXT,
  occurrence_count     INTEGER NOT NULL DEFAULT 0,
  success_count        INTEGER NOT NULL DEFAULT 0,
  failure_count        INTEGER NOT NULL DEFAULT 0,
  revision             INTEGER NOT NULL DEFAULT 1,
  deleted_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_patterns_live ON build_patterns (deleted_at, status, scope_type, scope_value);

CREATE TABLE IF NOT EXISTS build_pattern_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id TEXT NOT NULL,
  event      TEXT NOT NULL,   -- created|updated|deleted|deprecated|matched|resolved|not_resolved
  build_uuid TEXT,
  actor      TEXT,
  notes      TEXT,
  evidence   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pattern_events ON build_pattern_events (pattern_id, id DESC);
