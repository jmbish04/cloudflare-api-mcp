import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { timingSafeEqual } from '../lib/oauth'
import {
  buildDocsRequestBody,
  deriveDocsQuery,
  detectSearchCall,
  extractToolText,
  mergeDocsIntoSearch,
  parseRpc,
  pickDocsToolName
} from '../lib/docs-pairing'

export const prerender = false

const DEFAULT_UPSTREAM = 'https://mcp.cloudflare.com/mcp'

// Automatically enrich `search` tool results with upstream documentation. Flip to
// false to disable pairing without touching the proxy logic.
const DOCS_PAIRING_ENABLED = true

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

// Per-isolate cache of the resolved upstream docs tool name. `undefined` = not
// yet discovered; a string = the tool name; a failed discovery is not cached
// (the promise is cleared) so a later request retries.
let docsToolDiscovery: Promise<string | null> | null = null

async function discoverDocsToolName(target: string, baseHeaders: Headers): Promise<string | null> {
  try {
    const headers = new Headers(baseHeaders)
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'application/json, text/event-stream')
    headers.delete('Content-Length')
    const resp = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'docs-discovery', method: 'tools/list' })
    })
    if (!resp.ok) return null
    return pickDocsToolName(parseRpc(await resp.text()))
  } catch {
    return null
  }
}

async function resolveDocsToolName(target: string, baseHeaders: Headers): Promise<string | null> {
  if (!docsToolDiscovery) docsToolDiscovery = discoverDocsToolName(target, baseHeaders)
  const name = await docsToolDiscovery
  if (name === null) docsToolDiscovery = null // allow a later retry after a miss
  return name
}

/**
 * Proxy a `search` tool call and, when possible, enrich its result with upstream
 * documentation. The search request always runs; the docs request runs in
 * parallel. On any uncertainty — no derivable query, no docs tool, a non-JSON
 * (e.g. streamed) search response, or a failed/empty docs call — the untouched
 * search response is returned, so `search` behaviour never regresses.
 */
async function proxySearchWithDocs(
  target: string,
  headers: Headers,
  body: string,
  args: Record<string, unknown>,
  origin: string
): Promise<Response> {
  const query = deriveDocsQuery(args)
  const searchPromise = fetch(target, { method: 'POST', headers, body, redirect: 'follow' })

  let docsToolName: string | null = null
  let docsPromise: Promise<Response | null> = Promise.resolve(null)
  if (query) {
    docsToolName = await resolveDocsToolName(target, headers)
    if (docsToolName) {
      const docsHeaders = new Headers(headers)
      docsHeaders.set('Content-Type', 'application/json')
      docsHeaders.set('Accept', 'application/json, text/event-stream')
      docsHeaders.delete('Content-Length')
      docsPromise = fetch(target, {
        method: 'POST',
        headers: docsHeaders,
        body: buildDocsRequestBody(docsToolName, query),
        redirect: 'follow'
      }).catch(() => null)
    }
  }

  const searchResp = await searchPromise
  const contentType = searchResp.headers.get('Content-Type') ?? ''
  const passthrough = () =>
    new Response(searchResp.body, {
      status: searchResp.status,
      statusText: searchResp.statusText,
      headers: withCorsHeaders(searchResp.headers, origin)
    })

  // Only merge into a plain-JSON search response; stream anything else through.
  if (!query || !docsToolName || !contentType.includes('application/json')) {
    return passthrough()
  }

  const searchText = await searchResp.text()
  const searchRpc = parseRpc(searchText)
  let outText = searchText
  const docsResp = await docsPromise
  if (docsResp && searchRpc) {
    const docsText = extractToolText(parseRpc(await docsResp.text().catch(() => '')))
    if (docsText) outText = JSON.stringify(mergeDocsIntoSearch(searchRpc, docsText, query))
  }

  const outHeaders = withCorsHeaders(searchResp.headers, origin)
  outHeaders.set('Content-Type', 'application/json')
  outHeaders.delete('Content-Length') // body length changed
  return new Response(outText, {
    status: searchResp.status,
    statusText: searchResp.statusText,
    headers: outHeaders
  })
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

  const upstreamBase = env?.UPSTREAM_MCP_URL || DEFAULT_UPSTREAM
  const targetUrl = new URL(upstreamBase)
  targetUrl.search = url.search

  const forwardedHeaders = new Headers(request.headers)
  forwardedHeaders.set('Host', targetUrl.hostname)
  forwardedHeaders.set('Authorization', `Bearer ${cfApiToken}`)

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
    // `search` calls are enriched with upstream docs; everything else is a plain
    // proxy. Pairing owns the search fetch, so it isn't also run below.
    if (searchCall) {
      return await proxySearchWithDocs(
        targetUrl.toString(),
        forwardedHeaders,
        typeof forwardedBody === 'string' ? forwardedBody : '',
        searchCall.args,
        origin
      )
    }

    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: forwardedHeaders,
      body: forwardedBody,
      redirect: 'follow'
    })

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: withCorsHeaders(upstreamResponse.headers, origin)
    })
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
