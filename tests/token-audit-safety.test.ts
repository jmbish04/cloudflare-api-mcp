import { describe, expect, it, vi } from 'vitest'
import { runToolForRpc } from '../src/lib/cf-ops'
import type { CloudflareBuildsClient } from '../src/lib/cf-builds'
import type { GitHubClient } from '../src/lib/github'
import type { Db } from '../src/db/client'
import type { ToolContext } from '../src/lib/tools/context'

/**
 * The audit must never destroy a token it cannot account for.
 *
 * This is the one behaviour in the audit that is irreversible, so it gets its own
 * test: if the run row cannot be written, the per-deletion rows cannot be written
 * either (they key off it), and deleting anyway would make tokens vanish with no
 * explanation at /docs/token-audit — the exact mystery the feature exists to stop.
 */

/** A Db whose inserts always fail, standing in for an unavailable D1. */
function brokenDb(): Db {
  const boom = () => {
    throw new Error('D1_ERROR: no such table: token_audit_runs')
  }
  return {
    insert: boom,
    select: boom,
    update: boom,
    delete: boom
  } as unknown as Db
}

/**
 * Context whose Cloudflare calls are recorded, so the test can assert that NO
 * DELETE was issued rather than merely that an error was thrown.
 */
function ctxWithRecorder(tokens: Array<Record<string, unknown>>) {
  const calls: Array<{ method: string; path: string }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, path: u.pathname })
    if (method === 'GET' && u.pathname === '/client/v4/user/tokens') {
      return new Response(
        JSON.stringify({
          success: true,
          result: tokens,
          errors: [],
          result_info: { total_count: tokens.length }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (u.pathname.endsWith('/verify')) {
      return new Response(
        JSON.stringify({
          success: true,
          result: { id: 'self-token', status: 'active' },
          errors: []
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    return new Response(JSON.stringify({ success: true, result: {}, errors: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as unknown as typeof fetch

  const ctx: ToolContext = {
    db: brokenDb(),
    cf: { listBuildTokens: async () => [] } as unknown as CloudflareBuildsClient,
    gh: {} as unknown as GitHubClient,
    accountId: 'acct',
    actor: 'test',
    cfTokens: { account: 'a', user: 'u', userAdmin: 'ua' }
  }
  return { ctx, calls, fetchImpl }
}

/** A long-idle generated build token — the one class the audit may delete. */
const deletable = {
  id: 'dead-1',
  name: 'old-worker build token',
  status: 'active',
  last_used_on: new Date(Date.now() - 400 * 86_400_000).toISOString()
}

describe('cloudflare_token_audit — refuses to delete what it cannot record', () => {
  it('throws instead of deleting when the audit run cannot be written', async () => {
    const { ctx, calls, fetchImpl } = ctxWithRecorder([deletable])
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl)
    try {
      await expect(runToolForRpc('cloudflare_token_audit', { apply: true }, ctx)).rejects.toThrow(
        /could not be written to D1|audit_not_recordable/
      )

      // The decisive assertion: no DELETE reached Cloudflare. Throwing after
      // deleting would still have destroyed the token.
      expect(calls.filter((c) => c.method === 'DELETE')).toEqual([])
    } finally {
      vi.restoreAllMocks()
    }
  })

  // A dry run must stay useful when D1 is down — it deletes nothing either way, so
  // failing it would remove the operator's only way to see the quota.
  it('still reports in dry-run mode when D1 is unavailable', async () => {
    const { ctx, calls, fetchImpl } = ctxWithRecorder([deletable])
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl)
    try {
      const out = (await runToolForRpc('cloudflare_token_audit', {}, ctx)) as {
        mode: string
        run_id: number | null
        reclaimable: number
      }
      expect(out.mode).toBe('dry_run')
      expect(out.run_id).toBeNull()
      expect(out.reclaimable).toBe(1)
      expect(calls.filter((c) => c.method === 'DELETE')).toEqual([])
    } finally {
      vi.restoreAllMocks()
    }
  })
})
