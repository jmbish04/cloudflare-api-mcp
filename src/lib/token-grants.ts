/**
 * OAuth `/token` grant logic, isolated from Worker bindings (the KV namespace is
 * passed in) so the security-critical exchange paths can be unit-tested directly.
 *
 * Trust model: authorization codes are minted by `/authorize` only after the
 * WORKER_API_KEY check, are single-use, are bound to a registered redirect URI,
 * and REQUIRE a matching PKCE verifier. Refresh tokens descend only from a valid
 * code exchange and rotate on use. The `/mcp` gate authorizes bearers by looking
 * them up in KV, so persisting the access token is load-bearing.
 */
import { verifyPkce } from './oauth'

const ONE_YEAR_IN_SECONDS = 31_536_000 // 365 days

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*'
} as const

export interface StoredAuthCode {
  clientId?: string
  redirectUri?: string
  codeChallenge?: string
  codeChallengeMethod?: string
  issuedAt?: number
}

interface StoredRefresh {
  client_id?: string
  issued_at?: number
}

/** RFC 6749 §5.2 token error response. */
function oauthError(error: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: JSON_HEADERS
  })
}

/**
 * Mint an access/refresh token pair and persist both in KV.
 *
 * Access-token persistence is load-bearing: the `/mcp` gate authorizes a bearer
 * by looking it up here, so a token we cannot store is a token that can never
 * authenticate — surface that as a 500 rather than returning a dead token. The
 * refresh record is best-effort; if it is lost the client re-runs authorization.
 */
async function mintAndStore(kv: KVNamespace, clientId: string | undefined): Promise<Response> {
  const token = `mcp_at_${crypto.randomUUID().replace(/-/g, '')}`
  const refreshToken = `mcp_rt_${crypto.randomUUID().replace(/-/g, '')}`
  const now = Date.now()
  const owner = clientId || 'claude'

  try {
    await kv.put(
      `token:${token}`,
      JSON.stringify({ active: true, issued_at: now, client_id: owner }),
      {
        expirationTtl: ONE_YEAR_IN_SECONDS
      }
    )
  } catch (err) {
    console.error('Failed to persist access token to KV:', err)
    return oauthError('server_error', 'Could not persist access token', 500)
  }

  try {
    await kv.put(`refresh:${refreshToken}`, JSON.stringify({ client_id: owner, issued_at: now }), {
      expirationTtl: ONE_YEAR_IN_SECONDS
    })
  } catch (err) {
    console.warn('Could not persist refresh token to KV:', err)
  }

  return new Response(
    JSON.stringify({
      access_token: token,
      token_type: 'Bearer',
      expires_in: ONE_YEAR_IN_SECONDS,
      refresh_token: refreshToken,
      scope: 'read write'
    }),
    { status: 200, headers: JSON_HEADERS }
  )
}

/**
 * Exchange an authorization code for tokens.
 *
 * The code must exist in KV (minted by `/authorize`), is single-use, must match
 * the request's `redirect_uri`/`client_id`, and REQUIRES a valid PKCE verifier.
 * A code without a stored challenge is rejected outright — `/authorize` never
 * mints one, and honoring it would reintroduce the phishing path PKCE closes.
 */
export async function handleAuthorizationCode(
  body: Record<string, string>,
  kv: KVNamespace | undefined
): Promise<Response> {
  const code = body['code']
  if (!code) return oauthError('invalid_request', 'Missing authorization code')
  if (!kv) return oauthError('server_error', 'Authorization store unavailable', 500)

  const stored = await kv.get(`code:${code}`)
  if (!stored) return oauthError('invalid_grant', 'Authorization code is invalid or expired')

  // Single-use: consume the code up front, whatever the outcome below.
  await kv.delete(`code:${code}`).catch(() => {})

  let record: StoredAuthCode
  try {
    record = JSON.parse(stored) as StoredAuthCode
  } catch {
    return oauthError('invalid_grant', 'Authorization code is malformed')
  }

  const redirectUri = body['redirect_uri']
  if (redirectUri && record.redirectUri && redirectUri !== record.redirectUri) {
    return oauthError('invalid_grant', 'redirect_uri does not match the authorization request')
  }

  const clientId = body['client_id']
  if (clientId && record.clientId && clientId !== record.clientId) {
    return oauthError('invalid_grant', 'client_id does not match the authorization request')
  }

  // PKCE is mandatory. Every code carries a challenge (enforced at /authorize);
  // reject any that does not rather than silently downgrading.
  if (!record.codeChallenge) {
    return oauthError('invalid_grant', 'Authorization code is not bound to a PKCE challenge')
  }
  const verifier = body['code_verifier']
  if (!verifier) return oauthError('invalid_grant', 'Missing PKCE code_verifier')
  const ok = await verifyPkce(verifier, record.codeChallenge, record.codeChallengeMethod)
  if (!ok) return oauthError('invalid_grant', 'PKCE verification failed')

  return mintAndStore(kv, record.clientId)
}

/** Rotate a refresh token for a fresh access/refresh pair. */
export async function handleRefreshToken(
  body: Record<string, string>,
  kv: KVNamespace | undefined
): Promise<Response> {
  const refreshToken = body['refresh_token']
  if (!refreshToken) return oauthError('invalid_request', 'Missing refresh_token')
  if (!kv) return oauthError('server_error', 'Authorization store unavailable', 500)

  const stored = await kv.get(`refresh:${refreshToken}`)
  if (!stored) return oauthError('invalid_grant', 'refresh_token is invalid or expired')

  let record: StoredRefresh
  try {
    record = JSON.parse(stored) as StoredRefresh
  } catch {
    record = {}
  }

  // Rotate: the presented refresh token is spent on use.
  await kv.delete(`refresh:${refreshToken}`).catch(() => {})

  return mintAndStore(kv, record.client_id)
}

/** Dispatch a parsed token request to the right grant handler. */
export async function handleTokenRequest(
  body: Record<string, string>,
  kv: KVNamespace | undefined
): Promise<Response> {
  const grantType = body['grant_type']

  if (grantType === 'refresh_token') {
    return handleRefreshToken(body, kv)
  }

  if (grantType && grantType !== 'authorization_code') {
    return oauthError('unsupported_grant_type', `grant_type '${grantType}' is not supported`)
  }

  // Default to the authorization_code grant. A missing grant_type still requires
  // a valid code, so a token can never be minted without one.
  return handleAuthorizationCode(body, kv)
}
