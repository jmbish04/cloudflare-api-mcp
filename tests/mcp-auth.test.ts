import { describe, expect, it, vi } from 'vitest'
import { isAuthorizedBearer } from '../src/pages/mcp'

const WORKER_KEY = 'super-secret-worker-key'

const kvWith = (store: Record<string, string>): KVNamespace =>
  ({
    get: vi.fn(async (key: string) => store[key] ?? null)
  }) as unknown as KVNamespace

describe('isAuthorizedBearer', () => {
  it('accepts the shared worker API key (direct mode)', async () => {
    expect(await isAuthorizedBearer(WORKER_KEY, WORKER_KEY, undefined)).toBe(true)
  })

  it('accepts an OAuth token this server issued and stored in KV', async () => {
    const token = 'mcp_at_abc123'
    const kv = kvWith({ [`token:${token}`]: JSON.stringify({ active: true }) })
    expect(await isAuthorizedBearer(token, WORKER_KEY, kv)).toBe(true)
  })

  it('rejects an OAuth token that was explicitly deactivated', async () => {
    const token = 'mcp_at_revoked'
    const kv = kvWith({ [`token:${token}`]: JSON.stringify({ active: false }) })
    expect(await isAuthorizedBearer(token, WORKER_KEY, kv)).toBe(false)
  })

  it('rejects a bearer that is neither the worker key nor a stored token', async () => {
    const kv = kvWith({})
    expect(await isAuthorizedBearer('mcp_at_unknown', WORKER_KEY, kv)).toBe(false)
  })

  it('rejects an empty bearer', async () => {
    expect(await isAuthorizedBearer('', WORKER_KEY, kvWith({}))).toBe(false)
  })

  it('still accepts a valid OAuth token when the worker key is unavailable', async () => {
    const token = 'mcp_at_def456'
    const kv = kvWith({ [`token:${token}`]: JSON.stringify({ active: true }) })
    expect(await isAuthorizedBearer(token, null, kv)).toBe(true)
  })

  it('rejects OAuth tokens when no KV namespace is bound', async () => {
    expect(await isAuthorizedBearer('mcp_at_xyz', WORKER_KEY, undefined)).toBe(false)
  })

  it('does not throw on malformed stored token JSON', async () => {
    const token = 'mcp_at_bad'
    const kv = kvWith({ [`token:${token}`]: 'not json' })
    expect(await isAuthorizedBearer(token, WORKER_KEY, kv)).toBe(false)
  })
})
