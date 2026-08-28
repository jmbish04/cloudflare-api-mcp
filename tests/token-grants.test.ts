import { beforeEach, describe, expect, it } from 'vitest'
import { deriveS256Challenge } from '../src/lib/oauth'
import {
  handleAuthorizationCode,
  handleRefreshToken,
  handleTokenRequest
} from '../src/lib/token-grants'

// Minimal in-memory KV standing in for OAUTH_KV.
function makeKv() {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    }
  } as unknown as KVNamespace
  return { kv, store }
}

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const REDIRECT = 'https://claude.ai/api/mcp/oauth_callback'

async function seedCode(
  store: Map<string, string>,
  code: string,
  overrides: Record<string, unknown> = {}
) {
  store.set(
    `code:${code}`,
    JSON.stringify({
      clientId: 'claude',
      redirectUri: REDIRECT,
      codeChallenge: await deriveS256Challenge(VERIFIER),
      codeChallengeMethod: 'S256',
      issuedAt: Date.now(),
      ...overrides
    })
  )
}

interface TokenJson {
  error?: string
  access_token?: string
  refresh_token?: string
}
const readJson = (res: Response): Promise<TokenJson> => res.json() as Promise<TokenJson>

let kv: KVNamespace
let store: Map<string, string>
beforeEach(() => {
  ;({ kv, store } = makeKv())
})

describe('handleAuthorizationCode', () => {
  it('rejects a request with no code (closes the no-code bypass)', async () => {
    const res = await handleAuthorizationCode({}, kv)
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('invalid_request')
  })

  it('rejects an unknown code', async () => {
    const res = await handleAuthorizationCode({ code: 'nope', code_verifier: VERIFIER }, kv)
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('invalid_grant')
  })

  it('exchanges a valid code + correct verifier for tokens', async () => {
    await seedCode(store, 'good')
    const res = await handleAuthorizationCode(
      { code: 'good', code_verifier: VERIFIER, redirect_uri: REDIRECT },
      kv
    )
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.access_token).toMatch(/^mcp_at_/)
    expect(body.refresh_token).toMatch(/^mcp_rt_/)
    // Access token is persisted so the /mcp gate can validate it.
    expect(store.has(`token:${body.access_token}`)).toBe(true)
  })

  it('is single-use: replaying the same code fails', async () => {
    await seedCode(store, 'once')
    const first = await handleAuthorizationCode({ code: 'once', code_verifier: VERIFIER }, kv)
    expect(first.status).toBe(200)
    const replay = await handleAuthorizationCode({ code: 'once', code_verifier: VERIFIER }, kv)
    expect(replay.status).toBe(400)
    expect((await readJson(replay)).error).toBe('invalid_grant')
  })

  it('rejects a missing PKCE verifier', async () => {
    await seedCode(store, 'nopkce')
    const res = await handleAuthorizationCode({ code: 'nopkce' }, kv)
    expect(res.status).toBe(400)
  })

  it('rejects a wrong PKCE verifier', async () => {
    await seedCode(store, 'badv')
    const res = await handleAuthorizationCode({ code: 'badv', code_verifier: 'wrong' }, kv)
    expect(res.status).toBe(400)
  })

  it('rejects a code with no bound challenge (no silent downgrade)', async () => {
    await seedCode(store, 'challess', { codeChallenge: undefined, codeChallengeMethod: undefined })
    const res = await handleAuthorizationCode({ code: 'challess', code_verifier: VERIFIER }, kv)
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('invalid_grant')
  })

  it('rejects a mismatched redirect_uri', async () => {
    await seedCode(store, 'rmm')
    const res = await handleAuthorizationCode(
      { code: 'rmm', code_verifier: VERIFIER, redirect_uri: 'https://evil.example/cb' },
      kv
    )
    expect(res.status).toBe(400)
  })

  it('rejects a mismatched client_id', async () => {
    await seedCode(store, 'cmm')
    const res = await handleAuthorizationCode(
      { code: 'cmm', code_verifier: VERIFIER, client_id: 'someone-else' },
      kv
    )
    expect(res.status).toBe(400)
  })
})

describe('handleRefreshToken', () => {
  it('rotates a valid refresh token and invalidates the old one', async () => {
    await seedCode(store, 'rt')
    const issued = await readJson(
      await handleAuthorizationCode({ code: 'rt', code_verifier: VERIFIER }, kv)
    )

    const refreshed = await handleRefreshToken({ refresh_token: issued.refresh_token! }, kv)
    expect(refreshed.status).toBe(200)
    const body = await readJson(refreshed)
    expect(body.access_token).toMatch(/^mcp_at_/)

    // Old refresh token is spent.
    const replay = await handleRefreshToken({ refresh_token: issued.refresh_token! }, kv)
    expect(replay.status).toBe(400)
  })

  it('rejects an unknown refresh token', async () => {
    const res = await handleRefreshToken({ refresh_token: 'mcp_rt_bogus' }, kv)
    expect(res.status).toBe(400)
  })

  it('rejects a missing refresh token', async () => {
    const res = await handleRefreshToken({}, kv)
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('invalid_request')
  })
})

describe('handleTokenRequest dispatch', () => {
  it('routes refresh_token grants', async () => {
    const res = await handleTokenRequest({ grant_type: 'refresh_token' }, kv)
    // Missing refresh_token -> invalid_request from the refresh handler.
    expect((await readJson(res)).error).toBe('invalid_request')
  })

  it('rejects an unsupported grant_type', async () => {
    const res = await handleTokenRequest({ grant_type: 'client_credentials' }, kv)
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('unsupported_grant_type')
  })

  it('defaults to authorization_code and still requires a code', async () => {
    const res = await handleTokenRequest({}, kv)
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('invalid_request')
  })
})
