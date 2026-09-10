/**
 * Pause/resume coordination state, persisted in D1.
 *
 * D1 and the Cloudflare API cannot share a transaction, so every mutation writes
 * an intent row FIRST (`phase` = 'pausing' / 'resuming'), then calls Cloudflare,
 * then records the outcome. A crash between the two leaves a row that says
 * exactly what was in flight, which `reconcile()` can act on — as opposed to a
 * silent mismatch nobody can detect afterwards.
 *
 * The D1 binding is a parameter, never imported, so all of this is testable
 * against a local D1 without the Worker runtime.
 */

export type Phase = 'active' | 'pausing' | 'paused' | 'resuming'

export interface CicdStateRow {
  account_id: string
  worker_name: string
  worker_tag: string
  phase: Phase
  saved_config: string | null
  saved_at: string | null
  expected_config: string | null
  revision: number
  paused_at: string | null
  updated_at: string
}

export interface LeaseRow {
  lease_id: string
  account_id: string
  worker_name: string
  worker_tag: string
  owner: string
  reason: string | null
  idempotency_key: string | null
  acquired_at: string
  expires_at: string | null
  released_at: string | null
}

const nowIso = () => new Date().toISOString()

export async function getState(
  db: D1Database,
  accountId: string,
  workerName: string
): Promise<CicdStateRow | null> {
  return await db
    .prepare('SELECT * FROM cicd_state WHERE account_id = ? AND worker_name = ?')
    .bind(accountId, workerName)
    .first<CicdStateRow>()
}

/**
 * Move the row to a new phase, but only from an expected revision.
 *
 * The `revision = ?` predicate is the whole concurrency story: two agents that
 * read the same row and both try to transition it will produce one winner and
 * one `false`, and the loser re-reads rather than clobbering.
 */
export async function transition(
  db: D1Database,
  key: { accountId: string; workerName: string; workerTag: string },
  from: { revision: number } | null,
  next: Partial<
    Pick<CicdStateRow, 'phase' | 'saved_config' | 'saved_at' | 'expected_config' | 'paused_at'>
  >
): Promise<boolean> {
  const ts = nowIso()
  if (!from) {
    // First sighting of this Worker. INSERT ... ON CONFLICT DO NOTHING so two
    // concurrent first-pauses cannot both insert.
    const res = await db
      .prepare(
        `INSERT INTO cicd_state
           (account_id, worker_name, worker_tag, phase, saved_config, saved_at, expected_config, revision, paused_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(account_id, worker_name) DO NOTHING`
      )
      .bind(
        key.accountId,
        key.workerName,
        key.workerTag,
        next.phase ?? 'active',
        next.saved_config ?? null,
        next.saved_at ?? null,
        next.expected_config ?? null,
        next.paused_at ?? null,
        ts
      )
      .run()
    return (res.meta.changes ?? 0) > 0
  }

  // COALESCE(?, col): a field the caller did not supply keeps its stored value.
  // In particular saved_config is only ever written when it is currently NULL,
  // so a second pause can never overwrite the original (pre-pause) snapshot.
  const res = await db
    .prepare(
      `UPDATE cicd_state
          SET phase = ?,
              worker_tag = ?,
              saved_config = CASE WHEN saved_config IS NULL THEN ? ELSE saved_config END,
              saved_at     = CASE WHEN saved_config IS NULL THEN ? ELSE saved_at END,
              expected_config = COALESCE(?, expected_config),
              paused_at = ?,
              revision = revision + 1,
              updated_at = ?
        WHERE account_id = ? AND worker_name = ? AND revision = ?`
    )
    .bind(
      next.phase ?? 'active',
      key.workerTag,
      next.saved_config ?? null,
      next.saved_at ?? null,
      next.expected_config ?? null,
      next.paused_at ?? null,
      ts,
      key.accountId,
      key.workerName,
      from.revision
    )
    .run()
  return (res.meta.changes ?? 0) > 0
}

/** Clear the saved snapshot once a restore has been verified against the remote. */
export async function clearSavedConfig(
  db: D1Database,
  accountId: string,
  workerName: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE cicd_state
          SET saved_config = NULL, saved_at = NULL, expected_config = NULL,
              paused_at = NULL, phase = 'active', revision = revision + 1, updated_at = ?
        WHERE account_id = ? AND worker_name = ?`
    )
    .bind(nowIso(), accountId, workerName)
    .run()
}

export async function listActiveLeases(
  db: D1Database,
  accountId: string,
  workerName: string
): Promise<LeaseRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM cicd_leases
        WHERE account_id = ? AND worker_name = ? AND released_at IS NULL
        ORDER BY acquired_at ASC`
    )
    .bind(accountId, workerName)
    .all<LeaseRow>()
  return results ?? []
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
  db: D1Database,
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
    const existing = await db
      .prepare(
        'SELECT * FROM cicd_leases WHERE account_id = ? AND worker_name = ? AND idempotency_key = ?'
      )
      .bind(lease.accountId, lease.workerName, lease.idempotencyKey)
      .first<LeaseRow>()
    if (existing) return { lease: existing, created: false }
  }

  await db
    .prepare(
      `INSERT INTO cicd_leases
         (lease_id, account_id, worker_name, worker_tag, owner, reason, idempotency_key, acquired_at, expires_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .bind(
      lease.leaseId,
      lease.accountId,
      lease.workerName,
      lease.workerTag,
      lease.owner,
      lease.reason ?? null,
      lease.idempotencyKey ?? null,
      nowIso(),
      lease.expiresAt ?? null
    )
    .run()

  const row = await db
    .prepare('SELECT * FROM cicd_leases WHERE lease_id = ?')
    .bind(lease.leaseId)
    .first<LeaseRow>()
  return { lease: row as LeaseRow, created: true }
}

/** Release one lease. Idempotent: releasing an already-released lease is a no-op. */
export async function releaseLease(
  db: D1Database,
  accountId: string,
  workerName: string,
  leaseId: string
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE cicd_leases SET released_at = ?
        WHERE lease_id = ? AND account_id = ? AND worker_name = ? AND released_at IS NULL`
    )
    .bind(nowIso(), leaseId, accountId, workerName)
    .run()
  return (res.meta.changes ?? 0) > 0
}

/** Release every outstanding lease. Only reachable through an explicit force-resume. */
export async function releaseAllLeases(
  db: D1Database,
  accountId: string,
  workerName: string
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE cicd_leases SET released_at = ?
        WHERE account_id = ? AND worker_name = ? AND released_at IS NULL`
    )
    .bind(nowIso(), accountId, workerName)
    .run()
  return res.meta.changes ?? 0
}

/**
 * Expiry is REPORTING ONLY.
 *
 * An expired lease is surfaced as expired so a human or a force-resume can act
 * on it, but time passing never resumes a Worker on its own — an agent that is
 * still mid-refactor when its lease clock runs out must not have CI switched
 * back on underneath it.
 */
export function isExpired(lease: LeaseRow, now = Date.now()): boolean {
  return Boolean(lease.expires_at && Date.parse(lease.expires_at) < now)
}

export async function audit(
  db: D1Database,
  entry: {
    accountId: string
    workerName: string
    action: string
    actor?: string
    detail?: unknown
  }
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO cicd_audit (account_id, worker_name, action, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(
      entry.accountId,
      entry.workerName,
      entry.action,
      entry.actor ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      nowIso()
    )
    .run()
}

export async function recentAudit(
  db: D1Database,
  accountId: string,
  workerName: string,
  limit = 20
): Promise<Array<Record<string, unknown>>> {
  const { results } = await db
    .prepare(
      'SELECT action, actor, detail, created_at FROM cicd_audit WHERE account_id = ? AND worker_name = ? ORDER BY id DESC LIMIT ?'
    )
    .bind(accountId, workerName, Math.min(limit, 100))
    .all<Record<string, unknown>>()
  return (results ?? []).map((r) => ({
    ...r,
    detail: typeof r.detail === 'string' ? safeParse(r.detail) : r.detail
  }))
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
