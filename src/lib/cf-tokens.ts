/**
 * Cloudflare API token administration — creation, verification, permissions.
 *
 * ## The two token kinds, and why it is confusing
 *
 * Per Cloudflare's own docs (`/fundamentals/api/get-started/account-owned-tokens/`):
 *
 * - **Account-owned tokens** (`cfat_` prefix) are durable service principals with
 *   their own permissions, independent of any person. Intended for CI/CD and
 *   integrations — they keep working after the person who made them leaves.
 *   Cloudflare steers you here.
 * - **User tokens** act on behalf of a user and inherit a subset of *that user's*
 *   permissions. Documented as better for ad hoc scripting.
 *
 * The trap is in one sentence of those docs: **"Some services may not support
 * account API tokens yet."** There is a compatibility matrix, and Workers Builds
 * is in the gap. That is the documented explanation for what we measured on
 * 2026-09-30: every `/builds/*` path refuses an account-scoped token with
 * `12006 "Invalid token"` while a user token succeeds. So the guidance ("prefer
 * account tokens") and the requirement ("builds needs a user token") genuinely
 * point in opposite directions, and neither is wrong.
 *
 * ## The rule this file enforces
 *
 * **Creating a token of a kind requires a credential of that same kind.**
 *
 * | Creating | Endpoint | Credential that must be presented |
 * |---|---|---|
 * | account-owned | `POST /accounts/{id}/tokens` | `CLOUDFLARE_WRANGLER_API_TOKEN` |
 * | user | `POST /user/tokens` | `CLOUDFLARE_USER_WRANGLER_API_TOKEN` |
 *
 * Getting this backwards is an easy mistake with a confusing failure, so the
 * credential is selected from the requested kind rather than left to the caller.
 *
 * ## Quotas, and why reuse is the default
 *
 * **User API tokens are capped at 50 per account** (documented:
 * `/fundamentals/api/rate-limits/`). Measured 2026-09-30: 48 in use — two from the
 * wall. Hitting it is how a Workers Builds setup fails in a way that looks like
 * "the dashboard cannot pull my tokens": creation is refused, and the fix is to
 * clean up or reuse, not to try again.
 *
 * So the intended operation is **reuse one shared build token**, never mint one per
 * build. When no usable token exists and the quota is full, the recovery is to
 * **roll an existing token's value** (`PUT .../{id}/value`) rather than create —
 * that keeps the count flat and still yields a working credential.
 *
 * Account-owned tokens are not on that 50 cap (114 existed at the same moment), so
 * the pressure is specific to the user surface — which is exactly the surface
 * Workers Builds forces you onto.
 *
 * ## Which credential administers which, measured not assumed
 *
 * | Operation | Credential that works |
 * |---|---|
 * | administer USER tokens | `CLOUDFLARE_USER_TOKEN_ADMIN` only |
 * | administer ACCOUNT tokens | `CLOUDFLARE_WRANGLER_API_TOKEN` or `..._ACCOUNT_TOKEN_ADMIN_TOKEN` |
 *
 * Measured 2026-09-30 against both endpoints: the *wrangler user* token is refused
 * on `/user/tokens` with `9109 Unauthorized` — it reaches `/builds/*` but cannot
 * administer tokens at all. Assuming "user things need the user token" is the
 * natural mistake and it does not hold here.
 *
 * ## Why a second client
 *
 * `CloudflareBuildsClient` prefixes every path with `/accounts/{account_id}`.
 * The user-token endpoints are `/user/tokens...` — not account-scoped at all — so
 * they cannot be expressed through it. This client takes absolute v4 paths.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4'

/** Which surface a token belongs to. Selects endpoint AND credential. */
export type TokenKind = 'account' | 'user'

export interface CloudflareEnvelope<T> {
  success: boolean
  result: T
  errors: Array<{ code?: number; message?: string }>
  messages?: Array<{ code?: number; message?: string }>
  result_info?: Record<string, unknown>
}

/** A token as the API reports it. Never carries the secret except on creation. */
export interface ApiToken {
  id: string
  name?: string
  status?: string
  issued_on?: string
  modified_on?: string
  expires_on?: string | null
  not_before?: string | null
  last_used_on?: string | null
  /** Present ONLY in a creation response — Cloudflare shows it once. */
  value?: string
  policies?: unknown[]
}

export interface PermissionGroup {
  id: string
  name?: string
  scopes?: string[]
}

/** Raised when the API answers with a non-2xx or `success: false`. */
export class TokenApiError extends Error {
  readonly status: number
  readonly errors: Array<{ code?: number; message?: string }>
  readonly path: string

  constructor(status: number, path: string, errors: Array<{ code?: number; message?: string }>) {
    const detail = errors.map((e) => `${e.code ?? '?'}: ${e.message ?? 'unknown'}`).join('; ')
    super(`Cloudflare API ${status} on ${path}${detail ? ` — ${detail}` : ''}`)
    this.name = 'TokenApiError'
    this.status = status
    this.path = path
    this.errors = errors
  }
}

/**
 * The paths for one token kind.
 *
 * Centralised so a caller never hand-builds `/user/tokens` vs
 * `/accounts/{id}/tokens` and never mixes the two for one operation.
 */
export function tokenPaths(kind: TokenKind, accountId: string) {
  const root = kind === 'account' ? `/accounts/${accountId}/tokens` : '/user/tokens'
  return {
    root,
    verify: `${root}/verify`,
    permissionGroups: `${root}/permission_groups`,
    byId: (id: string) => `${root}/${id}`,
    value: (id: string) => `${root}/${id}/value`
  }
}

/**
 * Minimal Cloudflare v4 client over absolute paths.
 *
 * Deliberately has no retry loop: every call here is either a read or a token
 * mutation, and silently retrying a creation risks minting two tokens.
 */
export class CloudflareTokenClient {
  #token: string
  #fetch: typeof fetch

  constructor(opts: { token: string; fetchImpl?: typeof fetch }) {
    this.#token = opts.token
    // Bind: the Workers runtime rejects a detached `fetch` stored on an object
    // and called as a method with "Illegal invocation".
    this.#fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  async request<T>(
    method: string,
    path: string,
    init?: { body?: unknown; query?: Record<string, string | number | undefined> }
  ): Promise<CloudflareEnvelope<T>> {
    const url = new URL(`${API_BASE}${path}`)
    for (const [k, v] of Object.entries(init?.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }

    const resp = await this.#fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {})
    })

    const text = await resp.text()
    let parsed: CloudflareEnvelope<T> | null = null
    try {
      parsed = JSON.parse(text) as CloudflareEnvelope<T>
    } catch {
      // Non-JSON body: surface the status without echoing a body that could hold
      // anything, including a token value on a creation call.
      throw new TokenApiError(resp.status, path, [
        { message: 'Cloudflare returned a non-JSON response.' }
      ])
    }

    if (!resp.ok || parsed.success === false) {
      throw new TokenApiError(resp.status, path, parsed.errors ?? [])
    }
    return parsed
  }
}

/**
 * Verify a token by presenting it to its own kind's verify endpoint.
 *
 * `verify` authenticates with the token being checked — it answers "is the token
 * I am presenting valid", not "is some other token valid". So the token value is
 * the credential for this call, which is why verification of a *supplied* token
 * requires that value.
 *
 * @returns the verify result (`id`, `status`, expiry) on success
 */
export async function verifyToken(
  tokenValue: string,
  kind: TokenKind,
  accountId: string,
  fetchImpl?: typeof fetch
): Promise<{ ok: true; result: ApiToken } | { ok: false; status: number; errors: unknown[] }> {
  const client = new CloudflareTokenClient({ token: tokenValue, fetchImpl })
  try {
    const env = await client.request<ApiToken>('GET', tokenPaths(kind, accountId).verify)
    return { ok: true, result: env.result }
  } catch (err) {
    if (err instanceof TokenApiError) return { ok: false, status: err.status, errors: err.errors }
    throw err
  }
}

/** Documented user API token quota per account. */
export const USER_TOKEN_QUOTA = 50

/**
 * How much room is left on the user-token quota.
 *
 * @param inUse tokens currently existing on the user surface
 * @returns remaining slots, never negative, plus whether creation is possible
 */
export function userQuotaHeadroom(inUse: number): {
  quota: number
  in_use: number
  headroom: number
  can_create: boolean
} {
  const headroom = Math.max(0, USER_TOKEN_QUOTA - inUse)
  return { quota: USER_TOKEN_QUOTA, in_use: inUse, headroom, can_create: headroom > 0 }
}

/**
 * Roll a token's value in place, returning the new secret.
 *
 * The recovery path when the quota is full: the token keeps its id, policies and
 * every association, and only its value changes. Anything still presenting the old
 * value stops working immediately, which is why a caller must choose the token
 * deliberately rather than have one picked for them.
 */
export async function rollTokenValue(
  adminToken: string,
  kind: TokenKind,
  accountId: string,
  tokenId: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  const client = new CloudflareTokenClient({ token: adminToken, fetchImpl })
  const env = await client.request<string | { value?: string }>(
    'PUT',
    tokenPaths(kind, accountId).value(tokenId),
    { body: {} }
  )
  // The API returns the new value as a bare string in `result` on this endpoint.
  const value = typeof env.result === 'string' ? env.result : env.result?.value
  if (!value) {
    throw new TokenApiError(200, tokenPaths(kind, accountId).value(tokenId), [
      { message: 'The roll succeeded but no new value was returned.' }
    ])
  }
  return value
}

/**
 * Guess a token's kind from its value, for a better error when it is mismatched.
 *
 * Account-owned tokens use the `cfat_` scannable prefix (documented). A user
 * token has no distinguishing prefix, so absence of `cfat_` is *not* proof of a
 * user token — hence `null` rather than a guess of 'user'.
 */
export function kindFromTokenValue(value: string): TokenKind | null {
  return value.startsWith('cfat_') ? 'account' : null
}
