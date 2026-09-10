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
