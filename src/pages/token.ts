import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { verifyPkce } from '../lib/oauth'

export const prerender = false

const ONE_YEAR_IN_SECONDS = 31_536_000 // 365 days

interface StoredAuthCode {
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

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*'
} as const

export const OPTIONS: APIRoute = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      'Access-Control-Max-Age': '86400'
    }
  })
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
 * Persistence of the access token is load-bearing: the `/mcp` gate authorizes a
 * bearer by looking it up here, so a token we cannot store is a token that can
 * never authenticate — surface that as a 500 rather than returning a dead token.
 * The refresh record is best-effort; if it is lost the client simply re-runs the
 * full authorization flow.
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
      { expirationTtl: ONE_YEAR_IN_SECONDS }
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
 * The code must exist in KV (minted by `/authorize` after the WORKER_API_KEY
 * check), is single-use, and — when the authorization request carried a PKCE
 * challenge — requires a matching `code_verifier`. Without this validation any
 * caller could POST `/token` and receive a working bearer, bypassing the
 * `/authorize` gate entirely.
 */
async function handleAuthorizationCode(
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

  // Enforce PKCE whenever the authorization request supplied a challenge.
  if (record.codeChallenge) {
    const verifier = body['code_verifier']
    if (!verifier) return oauthError('invalid_grant', 'Missing PKCE code_verifier')
    const ok = await verifyPkce(
      verifier,
      record.codeChallenge,
      record.codeChallengeMethod || 'S256'
    )
    if (!ok) return oauthError('invalid_grant', 'PKCE verification failed')
  }

  return mintAndStore(kv, record.clientId)
}

/** Rotate a refresh token for a fresh access/refresh pair. */
async function handleRefreshToken(
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

export const POST: APIRoute = async ({ request }) => {
  let bodyParams: Record<string, string> = {}
  const contentType = request.headers.get('content-type') || ''

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const formData = await request.formData()
    for (const [key, val] of formData.entries()) {
      bodyParams[key] = val.toString()
    }
  } else if (contentType.includes('application/json')) {
    bodyParams = (await request.json().catch(() => ({}))) as Record<string, string>
  }

  const grantType = bodyParams['grant_type']
  const kv = env?.OAUTH_KV

  if (grantType === 'refresh_token') {
    return handleRefreshToken(bodyParams, kv)
  }

  if (grantType && grantType !== 'authorization_code') {
    return oauthError('unsupported_grant_type', `grant_type '${grantType}' is not supported`)
  }

  // Default to the authorization_code grant. A missing grant_type still requires
  // a valid code, so a token can never be minted without one.
  return handleAuthorizationCode(bodyParams, kv)
}
