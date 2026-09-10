/**
 * Pause/resume coordination state, persisted in D1 through Drizzle.
 *
 * D1 and the Cloudflare API cannot share a transaction, so every mutation writes
 * an intent row FIRST (`phase` = 'pausing' / 'resuming'), then calls Cloudflare,
 * then records the outcome. A crash between the two leaves a row that says
 * exactly what was in flight, which `workers_cicd_reconcile` can act on — as
 * opposed to a silent mismatch nobody can detect afterwards.
 *
 * **Billing:** every read here is a primary-key or partial-index lookup, so it is
 * billed for the rows it actually wants rather than a table scan. Writes are rare
 * (pause, resume, configure) — the hot path in this Worker is pattern matching,
 * not this file.
 *
 * The Drizzle handle is a parameter, never imported.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { cicdAudit, cicdLeases, cicdState } from '../db/schema'
import type { CicdStateRow, LeaseRow } from '../db/schema'

export type Phase = 'active' | 'pausing' | 'paused' | 'resuming'
export type { CicdStateRow, LeaseRow }

const nowIso = () => new Date().toISOString()

export async function getState(
  db: Db,
  accountId: string,
  workerName: string
): Promise<CicdStateRow | null> {
  // Composite primary key: one row read, never a scan.
  const rows = await db
    .select()
    .from(cicdState)
    .where(and(eq(cicdState.accountId, accountId), eq(cicdState.workerName, workerName)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Move the row to a new phase, but only from an expected revision.
 *
 * The `revision = ?` predicate is the whole concurrency story: two agents that
 * read the same row and both try to transition it produce one winner and one
 * `false`, and the loser re-reads rather than clobbering.
 */
export async function transition(
  db: Db,
  key: { accountId: string; workerName: string; workerTag: string },
  from: { revision: number } | null,
  next: Partial<
    Pick<CicdStateRow, 'phase' | 'savedConfig' | 'savedAt' | 'expectedConfig' | 'pausedAt'>
  >
): Promise<boolean> {
  const ts = nowIso()

  if (!from) {
    // First sighting of this Worker. `onConflictDoNothing` so two concurrent
    // first-pauses cannot both insert.
    const res = await db
      .insert(cicdState)
      .values({
        accountId: key.accountId,
        workerName: key.workerName,
        workerTag: key.workerTag,
        phase: next.phase ?? 'active',
        savedConfig: next.savedConfig ?? null,
        savedAt: next.savedAt ?? null,
        expectedConfig: next.expectedConfig ?? null,
        revision: 1,
        pausedAt: next.pausedAt ?? null,
        updatedAt: ts
      })
      .onConflictDoNothing({ target: [cicdState.accountId, cicdState.workerName] })
    return (res.meta?.changes ?? 0) > 0
  }

  const res = await db
    .update(cicdState)
    .set({
      phase: next.phase ?? 'active',
      workerTag: key.workerTag,
      // Written only while it is still NULL: a second pause must never overwrite
      // the original pre-pause snapshot, or "resume" would restore a pause.
      savedConfig: sql`CASE WHEN ${cicdState.savedConfig} IS NULL THEN ${next.savedConfig ?? null} ELSE ${cicdState.savedConfig} END`,
      savedAt: sql`CASE WHEN ${cicdState.savedConfig} IS NULL THEN ${next.savedAt ?? null} ELSE ${cicdState.savedAt} END`,
      expectedConfig: sql`COALESCE(${next.expectedConfig ?? null}, ${cicdState.expectedConfig})`,
      pausedAt: next.pausedAt ?? null,
      revision: sql`${cicdState.revision} + 1`,
      updatedAt: ts
    })
    .where(
      and(
        eq(cicdState.accountId, key.accountId),
        eq(cicdState.workerName, key.workerName),
        eq(cicdState.revision, from.revision)
      )
    )
  return (res.meta?.changes ?? 0) > 0
}

/** Clear the saved snapshot once a restore has been verified against the remote. */
export async function clearSavedConfig(
  db: Db,
  accountId: string,
  workerName: string
): Promise<void> {
  await db
    .update(cicdState)
    .set({
      savedConfig: null,
      savedAt: null,
      expectedConfig: null,
      pausedAt: null,
      phase: 'active',
      revision: sql`${cicdState.revision} + 1`,
      updatedAt: nowIso()
    })
    .where(and(eq(cicdState.accountId, accountId), eq(cicdState.workerName, workerName)))
}

/**
 * Who still holds this Worker paused?
 *
 * Served by the PARTIAL index `idx_leases_active (account_id, worker_name)
 * WHERE released_at IS NULL`: released leases are not in the index at all, so
 * this reads only live leases however long the history grows.
 */
export async function listActiveLeases(
  db: Db,
  accountId: string,
  workerName: string
): Promise<LeaseRow[]> {
  return await db
    .select()
    .from(cicdLeases)
    .where(
      and(
        eq(cicdLeases.accountId, accountId),
        eq(cicdLeases.workerName, workerName),
        isNull(cicdLeases.releasedAt)
      )
    )
    .orderBy(cicdLeases.acquiredAt)
}

/**
 * Acquire a pause lease.
 *
 * Returns the existing lease unchanged when `idempotencyKey` was already used
 * for this Worker, so a retried tool call never stacks a second lease. The
 * `owner` string is metadata for humans reading the audit trail — it is NOT an
 * authorization check, and nothing here trusts it.
 */
export async function acquireLease(
  db: Db,
  lease: {
    leaseId: string
    accountId: string
    workerName: string
    workerTag: string
    owner: string
    reason?: string
    idempotencyKey?: string
    expiresAt?: string
  }
): Promise<{ lease: LeaseRow; created: boolean }> {
  if (lease.idempotencyKey) {
    // Unique partial index on (account_id, worker_name, idempotency_key).
    const existing = await db
      .select()
      .from(cicdLeases)
      .where(
        and(
          eq(cicdLeases.accountId, lease.accountId),
          eq(cicdLeases.workerName, lease.workerName),
          eq(cicdLeases.idempotencyKey, lease.idempotencyKey)
        )
      )
      .limit(1)
    if (existing[0]) return { lease: existing[0], created: false }
  }

  const row: LeaseRow = {
    leaseId: lease.leaseId,
    accountId: lease.accountId,
    workerName: lease.workerName,
    workerTag: lease.workerTag,
    owner: lease.owner,
    reason: lease.reason ?? null,
    idempotencyKey: lease.idempotencyKey ?? null,
    acquiredAt: nowIso(),
    expiresAt: lease.expiresAt ?? null,
    releasedAt: null
  }
  // `returning()` avoids a second SELECT for a row we just wrote.
  const inserted = await db.insert(cicdLeases).values(row).returning()
  return { lease: inserted[0] ?? row, created: true }
}

/** Release one lease. Idempotent: releasing an already-released lease is a no-op. */
export async function releaseLease(
  db: Db,
  accountId: string,
  workerName: string,
  leaseId: string
): Promise<boolean> {
  const res = await db
    .update(cicdLeases)
    .set({ releasedAt: nowIso() })
    .where(
      and(
        eq(cicdLeases.leaseId, leaseId),
        eq(cicdLeases.accountId, accountId),
        eq(cicdLeases.workerName, workerName),
        isNull(cicdLeases.releasedAt)
      )
    )
  return (res.meta?.changes ?? 0) > 0
}

/** Release every outstanding lease. Only reachable through an explicit force-resume. */
export async function releaseAllLeases(
  db: Db,
  accountId: string,
  workerName: string
): Promise<number> {
  const res = await db
    .update(cicdLeases)
    .set({ releasedAt: nowIso() })
    .where(
      and(
        eq(cicdLeases.accountId, accountId),
        eq(cicdLeases.workerName, workerName),
        isNull(cicdLeases.releasedAt)
      )
    )
  return res.meta?.changes ?? 0
}

/**
 * Expiry is REPORTING ONLY.
 *
 * An expired lease is surfaced as expired so a human or a force-resume can act
 * on it, but time passing never resumes a Worker — an agent that is still
 * mid-refactor when its lease clock runs out must not have CI switched back on
 * underneath it.
 */
export function isExpired(lease: LeaseRow, now = Date.now()): boolean {
  return Boolean(lease.expiresAt && Date.parse(lease.expiresAt) < now)
}

export async function audit(
  db: Db,
  entry: { accountId: string; workerName: string; action: string; actor?: string; detail?: unknown }
): Promise<void> {
  await db.insert(cicdAudit).values({
    accountId: entry.accountId,
    workerName: entry.workerName,
    action: entry.action,
    actor: entry.actor ?? null,
    detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
    createdAt: nowIso()
  })
}

/**
 * Newest-first audit for one Worker.
 *
 * `idx_audit_worker (account_id, worker_name, id DESC)` carries the ordering, so
 * D1 walks the first `limit` index entries instead of reading the Worker's whole
 * history into a sort.
 */
export async function recentAudit(
  db: Db,
  accountId: string,
  workerName: string,
  limit = 20
): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .select({
      action: cicdAudit.action,
      actor: cicdAudit.actor,
      detail: cicdAudit.detail,
      created_at: cicdAudit.createdAt
    })
    .from(cicdAudit)
    .where(and(eq(cicdAudit.accountId, accountId), eq(cicdAudit.workerName, workerName)))
    .orderBy(desc(cicdAudit.id))
    .limit(Math.min(limit, 100))

  return rows.map((r) => ({ ...r, detail: r.detail ? safeParse(r.detail) : null }))
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
