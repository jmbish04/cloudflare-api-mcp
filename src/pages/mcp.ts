import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { timingSafeEqual } from '../lib/oauth'
import {
  buildDocsHeaders,
  buildDocsRequestBody,
  deriveDocsQuery,
  detectSearchCall,
  extractToolText,
  mergeDocsIntoSearch,
  parseRpc
} from '../lib/docs-pairing'
import { isBufferableResponse, shouldRetryWithUserToken } from '../lib/upstream-auth'

export const prerender = false

const DEFAULT_UPSTREAM = 'https://mcp.cloudflare.com/mcp'

// Automatically enrich `search` tool results with Cloudflare documentation. Flip
// to false to disable pairing without touching the proxy logic.
const DOCS_PAIRING_ENABLED = true

// Cloudflare's documentation MCP is a SEPARATE, public server from the API MCP
// (`UPSTREAM_MCP_URL`) that this proxy forwards to. `search` results are enriched
// by querying this server's documentation tool. It is NOT sent the privileged
// Cloudflare API token — it is a different, unauthenticated service.
const DOCS_MCP_URL = 'https://docs.mcp.cloudflare.com/mcp'

// The documentation search tool that server exposes.
const DOCS_TOOL_NAME = 'search_cloudflare_documentation'

/**
 * Inject the configured account id into upstream `execute` tool calls.
 *
 * The upstream codemode server (mcp.cloudflare.com) resolves the sandbox
 * `accountId` from the optional `account_id` argument on the `execute` tool.
 * On a multi-account user token, omitting it leaves `accountId` unresolved and
 * account-scoped API paths 404. We splice `account_id` into the JSON-RPC body
 * before forwarding so the invoking model never has to know or supply it.
 *
 * Only `execute` takes `account_id`; other tools (`search`, `docs_search`) are
 * left untouched. Existing `account_id` args are never overwritten. Handles
 * both single JSON-RPC messages and batch arrays.
 *
 * ponytail: no-op for account-scoped tokens (upstream doesn't expose the param
 * there). If a pinned-account setup ever rejects the extra arg, gate on token
 * type — but the reported failure is the user-token case, so inject unconditionally.
 *
 * @param bodyText raw request body
 * @param accountId account id to inject
 * @returns rewritten body, or the original text if nothing applied / unparseable
 */
export function injectAccountId(bodyText: string, accountId: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return bodyText // not JSON (shouldn't happen for tools/call) — pass through
  }

  const patch = (msg: unknown): void => {
    if (!msg || typeof msg !== 'object') return
    const m = msg as {
      method?: unknown
      params?: { name?: unknown; arguments?: Record<string, unknown> }
    }
    if (m.method !== 'tools/call' || m.params?.name !== 'execute') return
    const args = (m.params.arguments ??= {})
    if (args.account_id == null) args.account_id = accountId
  }

  if (Array.isArray(parsed)) parsed.forEach(patch)
  else patch(parsed)

  return JSON.stringify(parsed)
}

/**
 * Decide whether a presented bearer may proxy to the privileged upstream.
 *
 * Two credential paths are accepted, mirroring the two ways this server issues
 * access:
 *
 * 1. **Direct API-key mode** — the bearer equals the shared `WORKER_API_KEY`
 *    secret. This is the path the "review finding #2" guard protected: without a
 *    check here, any bearer would proxy using our Cloudflare API token.
 * 2. **OAuth mode** — the bearer is an `mcp_at_...` token this server minted at
 *    `/token` and persisted in `OAUTH_KV` under `token:<token>`. This is the path
 *    every real MCP client (Claude) uses. The previous gate only accepted case 1,
 *    so OAuth-issued tokens were rejected with 401 and clients saw "no tools
 *    available" — the connector authenticated but could never list or call tools.
 *
 * A token is honored unless it was explicitly deactivated (`active: false`).
 *
 * @param presentedToken bearer stripped of the `Bearer ` prefix
 * @param workerApiKey resolved `WORKER_API_KEY` secret, or null when unavailable
 * @param kv `OAUTH_KV` namespace holding issued tokens, or undefined in tests
 * @returns whether the request may proceed to the upstream proxy
 */
export async function isAuthorizedBearer(
  presentedToken: string,
  workerApiKey: string | null,
  kv: KVNamespace | undefined
): Promise<boolean> {
  if (!presentedToken) return false

  // Direct API-key mode: the shared worker secret is accepted, compared in
  // constant time to avoid leaking it through response timing.
  if (workerApiKey && timingSafeEqual(presentedToken, workerApiKey)) return true

  // OAuth mode: accept only tokens this server issued and still marks active.
  if (!kv) return false
  try {
    const stored = await kv.get(`token:${presentedToken}`)
    if (!stored) return false
    const parsed = JSON.parse(stored) as { active?: boolean } | null
    return parsed?.active === true
  } catch {
    return false
  }
}

/** Copy upstream headers and apply the request's CORS allowances. */
function withCorsHeaders(upstream: Headers, origin: string): Headers {
  const headers = new Headers(upstream)
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Vary', 'Origin')
  }
  return headers
}

// The docs enrichment is best-effort: a slow docs server must never hold the
// (already-ready) search response hostage, so the docs fetch is time-boxed and a
// timeout is treated exactly like a failure — search is returned unenriched.
const DOCS_FETCH_TIMEOUT_MS = 2500

async function fetchDocsWithTimeout(
  target: string,
  headers: Headers,
  body: string
): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOCS_FETCH_TIMEOUT_MS)
  try {
    return await fetch(target, {
      method: 'POST',
      headers,
      body,
      redirect: 'follow',
      signal: controller.signal
    })
  } catch {
    return null // network error or timeout/abort → no docs, search is unaffected
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The outcome of one upstream attempt.
 *
 * `text` holds the buffered body when the response was safe to read to
 * completion (see `isBufferableResponse`) and is `null` for a genuinely
 * open-ended stream, which therefore cannot be inspected for a payload-level
 * auth failure. `isJson` distinguishes a plain-JSON body — the only shape the
 * docs-pairing merge can rewrite — from buffered SSE, which is replayed verbatim.
 */
type UpstreamResult = {
  resp: Response
  text: string | null
  isJson: boolean
  usedFallback: boolean
}

/**
 * Forward to the upstream MCP with the account token, falling back to the user
 * token when the account token is refused.
 *
 * Cloudflare splits its API across two token kinds and some surfaces — Workers
 * Builds logs among them — are reachable *only* with a user-scoped token. Rather
 * than pick one globally, the least-privileged token is tried first and the user
 * token is used only for the calls that the first token cannot make.
 *
 * The refusal can arrive as an HTTP 401/403 from the upstream itself, or as an
 * ordinary 200 whose tool result carries the Cloudflare API's own auth error —
 * `shouldRetryWithUserToken` covers both.
 *
 * ponytail: a retry re-runs the sandboxed `execute` code from the top. That is
 * safe for the read-shaped calls this exists for (build logs, listings) but a
 * script that wrote something *before* hitting the refusal would write it twice.
 * Narrow matching keeps the retry rare; make it read-only-gated if that ever bites.
 *
 * @param body must be a string or null to be retryable — a streamed request body
 *   cannot be replayed, so such a request is never retried.
 */
async function fetchUpstreamWithFallback(
  target: string,
  headers: Headers,
  method: string,
  body: BodyInit | null | undefined,
  primaryToken: string,
  fallbackToken: string | null
): Promise<UpstreamResult> {
  const attempt = async (token: string): Promise<UpstreamResult> => {
    const attemptHeaders = new Headers(headers)
    attemptHeaders.set('Authorization', `Bearer ${token}`)
    const resp = await fetch(target, {
      method,
      headers: attemptHeaders,
      body,
      redirect: 'follow'
    })
    const contentType = resp.headers.get('Content-Type') ?? ''
    const text = isBufferableResponse(method, contentType) ? await resp.text() : null
    return { resp, text, isJson: contentType.includes('application/json'), usedFallback: false }
  }

  const refused = (r: UpstreamResult): boolean => shouldRetryWithUserToken(r.resp.status, r.text)

  const first = await attempt(primaryToken)
  const replayable = body == null || typeof body === 'string'
  if (!fallbackToken || !replayable || !refused(first)) return first

  const second = await attempt(fallbackToken)
  // Keep the retry only if the user token actually cleared the refusal. If it was
  // refused too, the original (least-privileged) response is the more honest error
  // to hand back — and it avoids reporting a user-token failure for an account-token call.
  return refused(second) ? first : { ...second, usedFallback: true }
}

/** Rebuild a client-facing response from an upstream attempt, applying CORS. */
function upstreamToResponse(result: UpstreamResult, origin: string): Response {
  const headers = withCorsHeaders(result.resp.headers, origin)
  if (result.text === null) {
    return new Response(result.resp.body, {
      status: result.resp.status,
      statusText: result.resp.statusText,
      headers
    })
  }
  // The body is decoded plaintext we are re-serializing, so drop any framing or
  // encoding headers copied from upstream — otherwise a client could try to
  // gunzip an identity body.
  headers.delete('Content-Length')
  headers.delete('Content-Encoding')
  headers.delete('Transfer-Encoding')
  return new Response(result.text, {
    status: result.resp.status,
    statusText: result.resp.statusText,
    headers
  })
}

/**
 * Proxy a `search` tool call and, when possible, enrich its result with docs.
 *
 * The search request runs against the API upstream; the docs request runs in
 * parallel against Cloudflare's separate documentation MCP (`docsTarget`), which
 * is public and receives no privileged token. On any uncertainty — no derivable
 * query, a non-JSON (e.g. streamed) search response, or a failed/empty docs call —
 * the untouched search response is returned, so `search` behaviour never regresses.
 */
async function proxySearchWithDocs(
  searchFetch: () => Promise<UpstreamResult>,
  docsTarget: string,
  docsHeaders: Headers,
  docsToolName: string,
  args: Record<string, unknown>,
  origin: string
): Promise<Response> {
  const query = deriveDocsQuery(args)
  // The search request goes through the token-fallback path like any other call,
  // so a search refused by the account token is retried with the user token.
  const searchPromise = searchFetch()

  const docsPromise: Promise<Response | null> = query
    ? fetchDocsWithTimeout(docsTarget, docsHeaders, buildDocsRequestBody(docsToolName, query))
    : Promise.resolve(null)

  const search = await searchPromise

  // Only merge into a plain-JSON search response. Buffered SSE is replayed
  // verbatim rather than rewritten — the merge operates on a JSON-RPC document,
  // not on event framing.
  if (!query || search.text === null || !search.isJson) {
    return upstreamToResponse(search, origin)
  }

  const searchText = search.text
  const searchRpc = parseRpc(searchText)
  let outText = searchText
  const docsResp = await docsPromise
  if (docsResp && searchRpc) {
    const docsText = extractToolText(parseRpc(await docsResp.text().catch(() => '')))
    if (docsText) outText = JSON.stringify(mergeDocsIntoSearch(searchRpc, docsText, query))
  }

  const merged = upstreamToResponse({ ...search, text: outText }, origin)
  merged.headers.set('Content-Type', 'application/json')
  return merged
}

export const ALL: APIRoute = async ({ request, url }) => {
  const origin = request.headers.get('Origin') ?? '*'

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id',
        'Access-Control-Expose-Headers': 'WWW-Authenticate, Link',
        'Access-Control-Max-Age': '86400'
      }
    })
  }

  // Check if client is authenticated
  const unauthorized = () =>
    new Response(
      JSON.stringify({
        error: 'unauthorized',
        message: 'Authentication required. Please authenticate via OAuth 2.1.'
      }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer realm="${url.origin}", error="unauthorized", as_uri="${url.origin}", resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
          Link: `<${url.origin}/.well-known/oauth-protected-resource>; rel="oauth-protected-resource", <${url.origin}/.well-known/oauth-authorization-server>; rel="oauth-authorization-server"`,
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Expose-Headers': 'WWW-Authenticate, Link'
        }
      }
    )

  const authHeader = request.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return unauthorized()
  }

  // Validate the presented bearer before handing the privileged upstream token
  // to the request. Without this, any bearer would proxy with our Cloudflare API
  // token (review finding #2). Accept both the shared WORKER_API_KEY (direct
  // mode) and OAuth tokens this server issued at /token (the path Claude uses) —
  // gating on WORKER_API_KEY alone rejected every OAuth token with 401, which
  // surfaced to clients as "no tools available".
  const workerApiKey = await env.WORKER_API_KEY.get().catch(() => null)
  const presentedToken = authHeader.slice('Bearer '.length).trim()
  if (!(await isAuthorizedBearer(presentedToken, workerApiKey, env.OAUTH_KV))) {
    return unauthorized()
  }

  const cfApiToken = await env?.CLOUDFLARE_WRANGLER_API_TOKEN?.get?.()
  if (!cfApiToken) {
    return new Response(
      JSON.stringify({ error: 'CLOUDFLARE_WRANGLER_API_TOKEN secret is not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Optional second credential. Some Cloudflare API surfaces (Workers Builds logs,
  // for one) are only reachable with a *user* token, so calls the account token is
  // refused for are retried with this one. Absent or unreadable → no fallback, and
  // the proxy behaves exactly as it did before.
  const cfUserApiToken =
    (await env?.CLOUDFLARE_USER_WRANGLER_API_TOKEN?.get?.().catch(() => null)) ?? null

  const upstreamBase = env?.UPSTREAM_MCP_URL || DEFAULT_UPSTREAM
  const targetUrl = new URL(upstreamBase)
  targetUrl.search = url.search

  const forwardedHeaders = new Headers(request.headers)
  forwardedHeaders.set('Host', targetUrl.hostname)
  // Authorization is set per attempt by fetchUpstreamWithFallback; the client's
  // own bearer must not survive onto the upstream request.
  forwardedHeaders.delete('Authorization')

  // Read the request body once (POST only). It is needed both for behind-the-scenes
  // account-id injection on `execute` calls and to detect a `search` call for docs
  // pairing. Non-POST / empty requests stream through untouched.
  let forwardedBody: BodyInit | null | undefined = request.body
  let searchCall: { id: unknown; args: Record<string, unknown> } | null = null
  if (request.method === 'POST' && request.body) {
    const rawBody = await request.text()
    // A missing/rotated secret or a transient store error must not 500 the whole
    // proxy — account injection is an enhancement, not load-bearing.
    const accountId = await env.CLOUDFLARE_ACCOUNT_ID.get().catch(() => null)
    forwardedBody = accountId ? injectAccountId(rawBody, accountId) : rawBody
    // The forwarded body is a re-serialized string; its length may differ from the
    // original header, so let fetch recompute Content-Length.
    forwardedHeaders.delete('Content-Length')
    if (DOCS_PAIRING_ENABLED) searchCall = detectSearchCall(parseRpc(forwardedBody))
  }

  try {
    // `search` calls are enriched with Cloudflare docs; everything else is a plain
    // proxy. Pairing owns the search fetch, so it isn't also run below. Docs go to
    // the separate, public docs MCP server (never the privileged API token).
    const callUpstream = (body: BodyInit | null | undefined) =>
      fetchUpstreamWithFallback(
        targetUrl.toString(),
        forwardedHeaders,
        request.method,
        body,
        cfApiToken,
        cfUserApiToken
      )

    if (searchCall) {
      return await proxySearchWithDocs(
        () => callUpstream(typeof forwardedBody === 'string' ? forwardedBody : ''),
        DOCS_MCP_URL,
        buildDocsHeaders(request.headers.get('MCP-Protocol-Version')),
        DOCS_TOOL_NAME,
        searchCall.args,
        origin
      )
    }

    return upstreamToResponse(await callUpstream(forwardedBody), origin)
  } catch (err) {
    console.error('Failed to proxy request to upstream MCP:', err)
    return new Response(
      JSON.stringify({
        error: 'Upstream MCP proxy failed',
        details: err instanceof Error ? err.message : String(err)
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
