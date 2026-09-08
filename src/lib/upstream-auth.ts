/**
 * Detect a Cloudflare-API authorization failure in an upstream MCP response.
 *
 * Some Cloudflare API surfaces are only reachable with a **user** API token, not
 * an account-scoped one — Workers Builds build logs being the case that prompted
 * this. The proxy forwards with the least-privileged token first
 * (`CLOUDFLARE_WRANGLER_API_TOKEN`) and only falls back to the user token
 * (`CLOUDFLARE_USER_WRANGLER_API_TOKEN`) when the first attempt was refused.
 *
 * A refusal shows up in two different places, which is why this takes both:
 *
 * 1. **Transport level** — the upstream MCP server itself rejects the bearer and
 *    answers `401`/`403`.
 * 2. **Payload level** — the upstream accepts the bearer, the sandboxed `execute`
 *    code calls the Cloudflare API, and *that* call is refused. The JSON-RPC
 *    response is a perfectly ordinary `200` whose tool result text carries the
 *    API's error (`code: 10000` / "Authentication error", `code: 9109`,
 *    `403 Forbidden`, …). Nothing but the body distinguishes it.
 *
 * Matching is deliberately narrow: it looks for authentication/authorization
 * wording only, so an ordinary tool error (a 404, a bad payload, a script that
 * threw) does not burn a second upstream round trip.
 */

/** Cloudflare API error codes that mean "this token may not do that". */
const CF_AUTH_ERROR_CODES = [
  10000, // Authentication error
  10001, // Method not allowed / unable to authenticate
  9109, // Unauthorized to access requested resource
  9106, // Missing/invalid API token
  12006 // "Invalid token" — what the Workers Builds API returns to an
  // account-scoped token. Measured 2026-09-08 against
  // /accounts/{id}/builds/builds: the account token gets 12006, the user token
  // gets past auth entirely (12013 "Invalid query parameter"). This code is the
  // whole reason the fallback exists, so it must stay in this list.
]

/**
 * Phrases that indicate an authorization refusal.
 *
 * Lower-cased before matching. Kept to wording that is unambiguous about
 * *permission* — 'forbidden', 'unauthorized', 'authentication error' — rather
 * than generic failure words, so a normal tool error never triggers a retry.
 */
const AUTH_FAILURE_PHRASES = [
  'authentication error',
  'unauthorized',
  'unauthorised',
  'forbidden',
  'permission denied',
  'insufficient permissions',
  'not entitled',
  'invalid api token',
  'invalid token',
  'requires a user token',
  'user api token',
  'authentication_error',
  '"status":401',
  '"status":403',
  '"status": 401',
  '"status": 403'
]

/** HTTP statuses from the upstream MCP server that mean the bearer was refused. */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403
}

/**
 * Whether an upstream response body looks like a Cloudflare authorization refusal.
 *
 * @param bodyText raw response body (JSON-RPC, already read as text)
 * @returns true when the body carries an auth/permission error worth retrying
 *   with the user token
 */
export function bodyLooksLikeAuthFailure(bodyText: string): boolean {
  if (!bodyText) return false

  // Cap the scan: tool results can be large, and an auth error is always
  // announced near the error object, not buried in megabytes of payload.
  //
  // Backslashes are stripped because the interesting payload is usually a JSON
  // document embedded as a *string* inside the JSON-RPC tool result, so the
  // Cloudflare error arrives double-encoded as `{\"code\":10000}`. Removing the
  // escapes lets one set of patterns match both the plain and nested forms.
  const haystack = bodyText.slice(0, 64_000).replaceAll('\\', '').toLowerCase()

  if (AUTH_FAILURE_PHRASES.some((phrase) => haystack.includes(phrase))) return true

  // Numeric Cloudflare error codes, e.g. {"code":10000,"message":"..."}.
  return CF_AUTH_ERROR_CODES.some(
    (code) => haystack.includes(`"code":${code}`) || haystack.includes(`"code": ${code}`)
  )
}

/**
 * Whether an upstream response body can be buffered for inspection.
 *
 * MCP's Streamable HTTP transport answers a POST with either plain JSON or a
 * `text/event-stream` that **terminates once the response is delivered** — most
 * real clients (Claude included) negotiate the SSE form, so refusing to buffer
 * it would mean the fallback never fires in practice.
 *
 * A GET, by contrast, opens the long-lived server-to-client notification stream.
 * That one must never be buffered: it has no end, so reading it to completion
 * would hang the request forever. Method is the whole distinction.
 *
 * @param method the request method being proxied
 * @param contentType the upstream response's `Content-Type`
 */
export function isBufferableResponse(method: string, contentType: string): boolean {
  if (contentType.includes('application/json')) return true
  return method === 'POST' && contentType.includes('text/event-stream')
}

/**
 * Combined decision: should this response be retried with the fallback token?
 *
 * @param status upstream HTTP status
 * @param bodyText response body when the caller buffered it, otherwise null.
 *   A null body means nothing but the status can be judged — an unbuffered
 *   stream is never retried on a guess.
 */
export function shouldRetryWithUserToken(status: number, bodyText: string | null): boolean {
  if (isAuthFailureStatus(status)) return true
  if (bodyText === null) return false
  return bodyLooksLikeAuthFailure(bodyText)
}
