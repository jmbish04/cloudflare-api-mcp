/**
 * D1 schema (Drizzle ORM).
 *
 * Only two things are persisted: pause/resume coordination state, and the
 * reusable failure-pattern library. Build logs, build metadata, PR metadata and
 * documentation are fetched live per tool call and never stored.
 *
 * ## D1 billing shapes this file
 *
 * D1 bills by rows **read (scanned)** and rows **written** — not rows returned —
 * and a written row costs 1000x a read row ($1.00/M vs $0.001/M). Two
 * consequences drive every index below:
 *
 * 1. **A query without a usable index is billed for every row it scans.** Each
 *    index here exists because a specific hot query would otherwise do a full
 *    `SCAN`; the query-plan check is `pnpm run db:explain`.
 * 2. **Every index a write touches costs an extra written row.** So indexes are
 *    kept off columns that change on the hot path, and are `WHERE`-partial where
 *    that keeps dead rows out of the index entirely.
 *
 * The hot write path is pattern matching during log retrieval. It updates
 * `occurrence_count` / `last_matched_at`, and **neither is indexed**, so a match
 * costs exactly one written row.
 */

import { desc, sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'

// ---------------------------------------------------------------------------
// Pause / resume coordination
// ---------------------------------------------------------------------------

/**
 * One row per (account, Worker). `worker_tag` is recorded alongside so a
 * delete-and-recreate of the Worker — which mints a new immutable tag — is
 * detectable instead of silently corrupting a saved configuration.
 *
 * No secondary index: every access is by the composite primary key, which is
 * already a `SEARCH ... USING PRIMARY KEY` (one row read).
 */
export const cicdState = sqliteTable(
  'cicd_state',
  {
    accountId: text('account_id').notNull(),
    workerName: text('worker_name').notNull(),
    workerTag: text('worker_tag').notNull(),
    /** active | pausing | paused | resuming. The -ing phases are written BEFORE
     *  the Cloudflare call so a partial failure is recoverable. */
    phase: text('phase').notNull().default('active'),
    /** JSON snapshot of the trigger list as it was on the FIRST transition into
     *  pause. Never overwritten while paused. */
    savedConfig: text('saved_config'),
    savedAt: text('saved_at'),
    /** What the remote is expected to look like while paused, for drift detection. */
    expectedConfig: text('expected_config'),
    revision: integer('revision').notNull().default(1),
    pausedAt: text('paused_at'),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [
    // Composite primary key: SQLite makes it the table's own unique index, so
    // every access is a one-row `SEARCH ... USING INDEX sqlite_autoindex`, and
    // it is also the conflict target for the insert-if-absent in cicd-state.ts.
    primaryKey({ columns: [t.accountId, t.workerName] })
  ]
)

/**
 * Pause leases. Several agents may hold one at once; the saved configuration is
 * restored only when the last is released.
 */
export const cicdLeases = sqliteTable(
  'cicd_leases',
  {
    leaseId: text('lease_id').primaryKey(),
    accountId: text('account_id').notNull(),
    workerName: text('worker_name').notNull(),
    workerTag: text('worker_tag').notNull(),
    /** Descriptive metadata for the audit trail. NEVER an authorization check. */
    owner: text('owner').notNull(),
    reason: text('reason'),
    idempotencyKey: text('idempotency_key'),
    acquiredAt: text('acquired_at').notNull(),
    expiresAt: text('expires_at'),
    releasedAt: text('released_at')
  },
  (t) => [
    // "Who still holds this Worker?" runs on every pause and every resume.
    // PARTIAL (`WHERE released_at IS NULL`): released leases accumulate forever
    // and are never queried, so keeping them out of the index means the lookup
    // scans only live leases AND releasing one costs no index write.
    index('idx_leases_active')
      .on(t.accountId, t.workerName)
      .where(sql`released_at IS NULL`),
    // Idempotent re-pause. Partial so the unique constraint applies only to rows
    // that actually carry a key, and unkeyed leases cost no index write.
    uniqueIndex('idx_leases_idem')
      .on(t.accountId, t.workerName, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`)
  ]
)

/** Append-only audit trail. Written on pause/resume/configure only — never per read. */
export const cicdAudit = sqliteTable(
  'cicd_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: text('account_id').notNull(),
    workerName: text('worker_name').notNull(),
    action: text('action').notNull(),
    actor: text('actor'),
    detail: text('detail'),
    createdAt: text('created_at').notNull()
  },
  (t) => [
    // Reads are always "newest N for this Worker". Ordering by the rowid alias
    // descending inside the index means the read stops after N rows instead of
    // scanning and sorting the Worker's whole history.
    index('idx_audit_worker').on(t.accountId, t.workerName, sql`id DESC`)
  ]
)

// ---------------------------------------------------------------------------
// Failure pattern library
// ---------------------------------------------------------------------------

/**
 * A pattern is a *diagnosis hypothesis*: a redacted signature plus the confirmed
 * cause, fix and verification steps. It holds supporting build IDs, never build
 * transcripts and never credentials.
 */
export const buildPatterns = sqliteTable(
  'build_patterns',
  {
    patternId: text('pattern_id').primaryKey(),
    title: text('title').notNull(),
    explanation: text('explanation'),
    /** substring | regex */
    matchMethod: text('match_method').notNull(),
    matchExpression: text('match_expression').notNull(),
    caseSensitive: integer('case_sensitive').notNull().default(0),
    /** global | account | worker | repository | framework | tool — descriptive. */
    scopeType: text('scope_type').notNull().default('global'),
    scopeValue: text('scope_value'),
    /**
     * The single indexed selector: `'*'` for a pattern that applies everywhere,
     * otherwise the account id / Worker name / repository it is scoped to.
     *
     * This column exists purely for billing. Selecting applicable patterns used
     * to be a six-way `OR` across `scope_type`, which SQLite cannot satisfy from
     * one index — so every log retrieval scanned the whole table. Collapsing the
     * choice into one value makes it a single indexed `IN (…)` lookup.
     */
    scopeKey: text('scope_key').notNull().default('*'),
    /** low | medium | high | critical */
    severity: text('severity').notNull().default('medium'),
    rootCause: text('root_cause'),
    /** JSON array of strings. */
    resolutionSteps: text('resolution_steps'),
    lessonsLearned: text('lessons_learned'),
    /** JSON array of strings. */
    verificationSteps: text('verification_steps'),
    /** JSON array of build uuids. */
    supportingBuildIds: text('supporting_build_ids'),
    /** JSON array of urls. */
    docUrls: text('doc_urls'),
    versionConstraints: text('version_constraints'),
    confidence: real('confidence').notNull().default(0.5),
    /** proposed | verified | deprecated */
    status: text('status').notNull().default('proposed'),
    supersededBy: text('superseded_by'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastVerifiedAt: text('last_verified_at'),
    // --- hot-path counters: deliberately UNINDEXED -------------------------
    // These two are the only columns a log retrieval writes. Indexing either
    // would add a second written row to every match, on the one path that runs
    // often enough for it to show up on the bill.
    occurrenceCount: integer('occurrence_count').notNull().default(0),
    lastMatchedAt: text('last_matched_at'),
    // -----------------------------------------------------------------------
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    deletedAt: text('deleted_at')
  },
  (t) => [
    // The hot read: "which patterns apply to this build?", on every log
    // retrieval. PARTIAL on live rows so soft-deleted patterns are neither
    // scanned nor index-written, and (scope_key, status) leftmost-first so the
    // `scope_key IN (…)` lookup alone is enough to use it.
    index('idx_patterns_applicable')
      .on(t.scopeKey, t.status)
      .where(sql`deleted_at IS NULL`),
    // Listing orders by severity ascending then confidence DESCENDING. The
    // direction has to match or the index only satisfies the first term: with a
    // plain ascending index the plan was `SCAN ... USING INDEX` plus
    // `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`, which means SQLite reads and
    // sorts every live pattern before applying LIMIT — the LIMIT saves nothing.
    // Matching the direction lets it walk the index and stop after LIMIT rows.
    // Caught by `pnpm run db:explain`.
    index('idx_patterns_browse')
      .on(t.severity, desc(t.confidence))
      .where(sql`deleted_at IS NULL`)
  ]
)

/**
 * Management history for a pattern: created / updated / deleted / deprecated /
 * resolved / not_resolved.
 *
 * Deliberately NOT written when a pattern merely matches a log. A `matched` row
 * per match tripled the written rows on the hottest path while duplicating what
 * `occurrence_count` and `last_matched_at` already record, and accumulating
 * per-build match rows is the log telemetry this Worker is not supposed to keep.
 */
export const buildPatternEvents = sqliteTable(
  'build_pattern_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    patternId: text('pattern_id').notNull(),
    event: text('event').notNull(),
    buildUuid: text('build_uuid'),
    actor: text('actor'),
    notes: text('notes'),
    evidence: text('evidence'),
    createdAt: text('created_at').notNull()
  },
  (t) => [
    // Newest-first history for one pattern; without this, reading one pattern's
    // history scans every event row in the table.
    index('idx_pattern_events').on(t.patternId, sql`id DESC`)
  ]
)

export type CicdStateRow = typeof cicdState.$inferSelect
export type LeaseRow = typeof cicdLeases.$inferSelect
export type AuditRow = typeof cicdAudit.$inferSelect
export type PatternRow = typeof buildPatterns.$inferSelect
export type PatternEventRow = typeof buildPatternEvents.$inferSelect

// ---------------------------------------------------------------------------
// Self-reported tool failures
// ---------------------------------------------------------------------------

/**
 * One row per distinct failure *signature*, not per occurrence.
 *
 * ## Why deduped
 *
 * D1 bills a written row at 1000x a read row, and a failure that fires on every
 * call would otherwise write unboundedly. The signature is a hash of the stable
 * parts (tool, kind, redacted detail) so a recurring failure increments a counter
 * on one row instead of accumulating rows — and so the fixit issue is filed once
 * rather than once per call.
 *
 * `occurrence_count` and `last_seen_at` are deliberately NOT indexed: they change
 * on every occurrence, and an index on them would add a written row to the hot
 * path for no read benefit. Reads are "newest unresolved", served by the partial
 * index below, which only covers rows still needing attention.
 *
 * Nothing here holds a credential or a response body: `detail` is redacted before
 * it arrives (`lib/redact.ts`) and is a short signature, not a transcript.
 */
export const toolFailures = sqliteTable(
  'tool_failures',
  {
    /** sha256 of (tool, kind, detail), hex-truncated. Stable across occurrences. */
    signature: text('signature').primaryKey(),
    /** Tool the failure happened in, or 'proxy' for the forwarding path. */
    tool: text('tool').notNull(),
    /** Coarse class: malformed_response | tool_error | upstream_refusal | rescue_failed. */
    kind: text('kind').notNull(),
    /** Short redacted description. Never a body, never a credential. */
    detail: text('detail').notNull(),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    /** Set once a fixit task has been filed, so it is never filed twice. */
    fixitFiledAt: text('fixit_filed_at'),
    /** The colby-maestro task id, when one was created. */
    fixitTaskId: text('fixit_task_id'),
    /** Set by a human/agent once addressed; keeps resolved rows out of the index. */
    resolvedAt: text('resolved_at')
  },
  (t) => [
    // Partial: only unresolved failures are ever listed, so resolved rows leave
    // the index entirely rather than being scanned and filtered out.
    index('idx_tool_failures_open')
      .on(t.kind, desc(t.lastSeenAt))
      .where(sql`resolved_at IS NULL`)
  ]
)

// ---------------------------------------------------------------------------
// Token quota audit
// ---------------------------------------------------------------------------

/**
 * One row per audit run, and one per token actually deleted.
 *
 * ## Why this table exists at all
 *
 * A deletion nobody can explain months later is worse than a full quota. The
 * question this table has to answer is "why was this token deleted?", asked long
 * after the fact by someone with only a token name. So a deleted token's NAME,
 * idle age and the verdict reason are recorded permanently — the audit's reasoning
 * outlives the token.
 *
 * Writes are bounded by design: a run writes one summary row plus one row per
 * deletion, and deletions are rare (nothing is deleted unless provably dead). It
 * never records the tokens it decided to keep — that would be ~48 rows per run for
 * no benefit, and a D1 write costs 1000x a read.
 *
 * No token value is ever stored. Only ids, names and reasoning.
 */
export const tokenAuditRuns = sqliteTable(
  'token_audit_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    startedAt: text('started_at').notNull(),
    /** 'dry_run' when nothing was deleted, 'applied' when deletions happened. */
    mode: text('mode').notNull(),
    /** Who or what ran it: a caller label, or 'cron'. */
    actor: text('actor').notNull(),
    tokensSeen: integer('tokens_seen').notNull(),
    quota: integer('quota').notNull(),
    headroomBefore: integer('headroom_before').notNull(),
    /** Counts by verdict, as JSON, so a run is readable without joining. */
    verdictCounts: text('verdict_counts').notNull(),
    deletedCount: integer('deleted_count').notNull().default(0),
    retentionDays: integer('retention_days').notNull(),
    error: text('error')
  },
  (t) => [index('idx_token_audit_runs_recent').on(desc(t.startedAt))]
)

/**
 * One row per token this audit deleted — the permanent explanation.
 *
 * `token_name` and `reason` are the columns that matter: the token is gone, so its
 * name is the only handle anyone will have when asking why it disappeared.
 */
export const tokenAuditDeletions = sqliteTable(
  'token_audit_deletions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id').notNull(),
    deletedAt: text('deleted_at').notNull(),
    tokenId: text('token_id').notNull(),
    /** Kept deliberately: the only identifier a human will recognise later. */
    tokenName: text('token_name').notNull(),
    idleDays: integer('idle_days'),
    /** The classifier's full reasoning, verbatim. */
    reason: text('reason').notNull(),
    /** Set when the delete call itself failed, so a failure is not silent. */
    failed: integer('failed', { mode: 'boolean' }).notNull().default(false)
  },
  (t) => [index('idx_token_audit_deletions_name').on(t.tokenName, desc(t.deletedAt))]
)
