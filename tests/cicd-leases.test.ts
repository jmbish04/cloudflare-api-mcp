import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import schemaSql from '../migrations/0001_cicd_and_patterns.sql?raw'
import {
  acquireLease,
  audit,
  clearSavedConfig,
  getState,
  isExpired,
  listActiveLeases,
  recentAudit,
  releaseAllLeases,
  releaseLease,
  transition
} from '../src/lib/cicd-state'

const db = (env as unknown as { CICD_DB: D1Database }).CICD_DB
const KEY = { accountId: 'acct1', workerName: 'my-worker', workerTag: 'tag-aaa' }

beforeEach(async () => {
  for (const table of [
    'cicd_state',
    'cicd_leases',
    'cicd_audit',
    'build_patterns',
    'build_pattern_events'
  ]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run()
  }
  // Strip comments BEFORE splitting: a `--` comment in this file contains a
  // semicolon, and splitting first would cut a CREATE TABLE in half.
  const statements = schemaSql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const stmt of statements) {
    await db.prepare(stmt).run()
  }
})

describe('pause leases', () => {
  const lease = (owner: string, extra: Record<string, unknown> = {}) =>
    acquireLease(db, { leaseId: crypto.randomUUID(), ...KEY, owner, ...extra })

  it('lets two agents hold leases on the same Worker at once', async () => {
    const a = await lease('agent-a')
    const b = await lease('agent-b')
    expect(a.created && b.created).toBe(true)
    const active = await listActiveLeases(db, KEY.accountId, KEY.workerName)
    expect(active.map((l) => l.owner).sort()).toEqual(['agent-a', 'agent-b'])
  })

  it('is idempotent for a repeated idempotency_key', async () => {
    const first = await lease('agent-a', { idempotencyKey: 'run-1' })
    const again = await lease('agent-a', { idempotencyKey: 'run-1' })
    expect(again.created).toBe(false)
    expect(again.lease.lease_id).toBe(first.lease.lease_id)
    expect(await listActiveLeases(db, KEY.accountId, KEY.workerName)).toHaveLength(1)
  })

  it("releasing one agent's lease leaves the other's pause standing", async () => {
    const a = await lease('agent-a')
    await lease('agent-b')
    expect(await releaseLease(db, KEY.accountId, KEY.workerName, a.lease.lease_id)).toBe(true)
    const remaining = await listActiveLeases(db, KEY.accountId, KEY.workerName)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].owner).toBe('agent-b')
  })

  it('releasing the last lease empties the holder list, which is what permits a restore', async () => {
    const a = await lease('agent-a')
    const b = await lease('agent-b')
    await releaseLease(db, KEY.accountId, KEY.workerName, a.lease.lease_id)
    await releaseLease(db, KEY.accountId, KEY.workerName, b.lease.lease_id)
    expect(await listActiveLeases(db, KEY.accountId, KEY.workerName)).toHaveLength(0)
  })

  it('release is idempotent and does not resurrect a released lease', async () => {
    const a = await lease('agent-a')
    expect(await releaseLease(db, KEY.accountId, KEY.workerName, a.lease.lease_id)).toBe(true)
    expect(await releaseLease(db, KEY.accountId, KEY.workerName, a.lease.lease_id)).toBe(false)
  })

  it('force release clears every outstanding lease', async () => {
    await lease('agent-a')
    await lease('agent-b')
    expect(await releaseAllLeases(db, KEY.accountId, KEY.workerName)).toBe(2)
    expect(await listActiveLeases(db, KEY.accountId, KEY.workerName)).toHaveLength(0)
  })

  it('reports expiry without releasing anything', async () => {
    const a = await lease('agent-a', { expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect(isExpired(a.lease)).toBe(true)
    // Expiry is reporting only: the lease is still held, so a resume still blocks.
    expect(await listActiveLeases(db, KEY.accountId, KEY.workerName)).toHaveLength(1)
  })
})

describe('pause state transitions', () => {
  it('captures the saved config once and never overwrites it while paused', async () => {
    const original = JSON.stringify([
      { trigger_uuid: 't1', branch_includes: ['main'], branch_excludes: [] }
    ])
    expect(
      await transition(db, KEY, null, { phase: 'paused', saved_config: original, saved_at: 'ts1' })
    ).toBe(true)

    let state = (await getState(db, KEY.accountId, KEY.workerName))!
    expect(state.saved_config).toBe(original)

    // A SECOND pause arrives while already paused, carrying the PAUSED config.
    const alreadyPaused = JSON.stringify([
      {
        trigger_uuid: 't1',
        branch_includes: ['cicd-paused-by-mcp..do-not-build'],
        branch_excludes: ['*']
      }
    ])
    await transition(
      db,
      KEY,
      { revision: state.revision },
      { phase: 'paused', saved_config: alreadyPaused }
    )

    state = (await getState(db, KEY.accountId, KEY.workerName))!
    expect(state.saved_config).toBe(original)
  })

  it('rejects a transition from a stale revision (concurrent callers)', async () => {
    await transition(db, KEY, null, { phase: 'active' })
    const state = (await getState(db, KEY.accountId, KEY.workerName))!
    expect(await transition(db, KEY, { revision: state.revision }, { phase: 'pausing' })).toBe(true)
    // The loser read the same revision and must fail rather than clobber.
    expect(await transition(db, KEY, { revision: state.revision }, { phase: 'resuming' })).toBe(
      false
    )
    expect((await getState(db, KEY.accountId, KEY.workerName))!.phase).toBe('pausing')
  })

  it('records an interrupted transition so it can be reconciled', async () => {
    await transition(db, KEY, null, { phase: 'pausing', saved_config: '[]', saved_at: 'ts' })
    const state = (await getState(db, KEY.accountId, KEY.workerName))!
    // A crash between the D1 write and the Cloudflare call leaves exactly this.
    expect(state.phase).toBe('pausing')
    expect(state.saved_config).toBe('[]')
  })

  it('clears the saved config only when told to, and returns to active', async () => {
    await transition(db, KEY, null, { phase: 'paused', saved_config: '[{"a":1}]', saved_at: 'ts' })
    await clearSavedConfig(db, KEY.accountId, KEY.workerName)
    const state = (await getState(db, KEY.accountId, KEY.workerName))!
    expect(state.saved_config).toBeNull()
    expect(state.phase).toBe('active')
  })
})

describe('audit trail', () => {
  it('keeps the restored configuration after the snapshot is cleared', async () => {
    await audit(db, {
      accountId: KEY.accountId,
      workerName: KEY.workerName,
      action: 'resume',
      actor: 'client-abc',
      detail: { restored_config: [{ trigger_uuid: 't1', branch_includes: ['main'] }] }
    })
    const rows = await recentAudit(db, KEY.accountId, KEY.workerName)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('resume')
    expect((rows[0].detail as { restored_config: unknown[] }).restored_config).toHaveLength(1)
  })
})
