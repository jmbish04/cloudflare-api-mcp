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
import {
  buildToolContext,
  detectLocalToolCall,
  isToolsListRequest,
  mergeLocalToolsIntoList
} from '../lib/mcp-local'
import { runLocalTool } from '../lib/mcp-local'
import { ToolError } from '../lib/tools/context'
import {
  annotateExecuteDescription,
  appendGuidanceToResult,
  buildsGuidanceText,
  matchBuildsRoute
} from '../lib/builds-guidance'
import { isAuthRefusal, isBufferableResponse } from '../lib/upstream-auth'
import {
  extractSingleCloudflareRequest,
  requiresUserToken,
  type RescuedRequest
} from '../lib/cf-request-rescue'
import { CloudflareBuildsClient } from '../lib/cf-builds'
import { encodeMcpResponse, repairToolResponse, validateToolResponse } from '../lib/mcp-response'
import { reportFailure, type FailureKind } from '../lib/failure-report'
import { getDb } from '../db/client'

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
 * Proxy a `search` tool call and, when possible, enrich its result with docs.
 *
 * The search request runs against the API upstream; the docs request runs in
 * parallel against Cloudflare's separate documentation MCP (`docsTarget`), which
 * is public and receives no privileged token. On any uncertainty — no derivable
 * query, a non-JSON (e.g. streamed) search response, or a failed/empty docs call —
 * the untouched search response is returned, so `search` behaviour never regresses.
 */
async function proxySearchWithDocs(
  apiTarget: string,
  apiHeaders: Headers,
  searchBody: string,
  docsTarget: string,
  docsHeaders: Headers,
  docsToolName: string,
  args: Record<string, unknown>,
  origin: string
): Promise<Response> {
  const query = deriveDocsQuery(args)
  const searchPromise = fetch(apiTarget, {
    method: 'POST',
    headers: apiHeaders,
    body: searchBody,
    redirect: 'follow'
  })

  const docsPromise: Promise<Response | null> = query
    ? fetchDocsWithTimeout(docsTarget, docsHeaders, buildDocsRequestBody(docsToolName, query))
    : Promise.resolve(null)

  const searchResp = await searchPromise
  const contentType = searchResp.headers.get('Content-Type') ?? ''
  const passthrough = () =>
    new Response(searchResp.body, {
      status: searchResp.status,
      statusText: searchResp.statusText,
      headers: withCorsHeaders(searchResp.headers, origin)
    })

  // Only merge into a plain-JSON search response; stream anything else through.
  if (!query || !contentType.includes('application/json')) {
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
  // The body here is decoded plaintext we re-serialized, so drop any framing/
  // encoding headers copied from the upstream response — otherwise a client could
  // try to gunzip an identity body and fail to decode a result we promised to keep.
  outHeaders.delete('Content-Length')
  outHeaders.delete('Content-Encoding')
  outHeaders.delete('Transfer-Encoding')
  return new Response(outText, {
    status: searchResp.status,
    statusText: searchResp.statusText,
    headers: outHeaders
  })
}

/**
 * Rewrite an upstream `tools/list` response so it also advertises this server's
 * local CI/CD tools.
 *
 * It also annotates the upstream `execute` tool's description to say that
 * Cloudflare `/builds/*` paths are not reachable through it and name the local
 * tools that do reach them — catching the misdiagnosis at tool-selection time
 * rather than only when the call has already failed.
 *
 * The upstream answers either plain JSON or an SSE stream (`text/event-stream`),
 * and a client that only ever sees the streamed form would never learn the local
 * tools exist — so both framings are handled. Anything unrecognised is streamed
 * through untouched: failing to advertise a local tool is a degradation, but
 * corrupting the upstream's tool list would break the session.
 */
async function mergeToolsListResponse(upstream: Response, origin: string): Promise<Response> {
  const contentType = upstream.headers.get('Content-Type') ?? ''
  const passthrough = () =>
    new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: withCorsHeaders(upstream.headers, origin)
    })

  const isJson = contentType.includes('application/json')
  const isSse = contentType.includes('text/event-stream')
  if (!isJson && !isSse) return passthrough()

  const text = await upstream.text()
  let outText: string

  if (isJson) {
    const parsed = parseRpc(text)
    if (!parsed)
      return new Response(text, {
        status: upstream.status,
        headers: withCorsHeaders(upstream.headers, origin)
      })
    outText = JSON.stringify(annotateExecuteDescription(mergeLocalToolsIntoList(parsed)))
  } else {
    // SSE: rewrite only `data:` payloads that parse as a tools/list result.
    outText = text
      .split('\n')
      .map((line) => {
        if (!line.startsWith('data:')) return line
        const payload = line.slice(5).trim()
        const parsed = parseRpc(payload)
        if (!parsed) return line
        return `data: ${JSON.stringify(annotateExecuteDescription(mergeLocalToolsIntoList(parsed)))}`
      })
      .join('\n')
  }

  const headers = withCorsHeaders(upstream.headers, origin)
  // The body was decoded and re-serialised, so drop framing headers copied from
  // upstream — a stale Content-Length or Content-Encoding makes it undecodable.
  headers.delete('Content-Length')
  headers.delete('Content-Encoding')
  headers.delete('Transfer-Encoding')
  return new Response(outText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  })
}

/** Stable pseudonymous label for a bearer: `client-<8 hex>` of its SHA-256. */
async function callerLabel(bearer: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `client-${hex.slice(0, 8)}`
}

/** JSON response for a locally-handled JSON-RPC message. */
function localJsonResponse(
  payload: unknown,
  origin: string,
  accept: string | null,
  onInvalid?: (problems: string[]) => void,
  toolName?: string
): Response {
  // Validate before anything leaves. A locally-generated response that a client
  // cannot read is the exact bug that made every workers_* tool look broken while
  // the proxied tools worked (see lib/mcp-response.ts).
  let out = payload
  const problems = validateToolResponse(payload)
  if (problems.length > 0) {
    onInvalid?.(problems)
    const id = (payload as { id?: unknown } | null)?.id
    out = repairToolResponse(id, problems, toolName)
  }

  // Match the client's negotiated framing. Hardcoding JSON here is what broke
  // every SSE client: the proxied tools came back as text/event-stream and these
  // did not, so only the local tools appeared malformed.
  const { body, contentType } = encodeMcpResponse(out, accept)
  const headers = new Headers({ 'Content-Type': contentType })
  if (contentType.includes('event-stream')) {
    headers.set('Cache-Control', 'no-cache')
    headers.set('Connection', 'keep-alive')
  }
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Vary', 'Origin')
  }
  return new Response(body, { status: 200, headers })
}

/**
 * Spot an `execute` call whose code reaches for a Cloudflare `/builds/*` path.
 *
 * Only `execute` is considered: `search` reads the OpenAPI spec (where a
 * `/builds/*` string is the *subject* of a successful query, not an attempt to
 * call it), and the local `workers_*` tools reach those paths perfectly well.
 *
 * @returns the matching route, or null when this is not such a call
 */
function detectBuildsExecuteCall(parsed: unknown): ReturnType<typeof matchBuildsRoute> {
  const pick = (msg: unknown): ReturnType<typeof matchBuildsRoute> => {
    if (!msg || typeof msg !== 'object') return null
    const m = msg as { method?: unknown; params?: { name?: unknown; arguments?: unknown } }
    if (m.method !== 'tools/call' || m.params?.name !== 'execute') return null
    const args = m.params?.arguments
    if (!args || typeof args !== 'object') return null
    const code = (args as { code?: unknown }).code
    return typeof code === 'string' ? matchBuildsRoute(code) : null
  }
  if (Array.isArray(parsed)) {
    for (const msg of parsed) {
      const hit = pick(msg)
      if (hit) return hit
    }
    return null
  }
  return pick(parsed)
}

/** Re-emit an SSE body, rewriting each `data:` payload the mapper handles. */
function rewriteSseData(text: string, map: (payload: string) => string | null): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:')) return line
      const next = map(line.slice(5).trim())
      return next === null ? line : `data: ${next}`
    })
    .join('\n')
}

/**
 * Rebuild a response around a body already read as text.
 *
 * Framing and encoding headers are dropped: the body is decoded plaintext being
 * re-serialized, so a copied `Content-Encoding` would have a client trying to
 * gunzip an identity body.
 */
function respondWithText(upstream: Response, text: string, origin: string): Response {
  const headers = withCorsHeaders(upstream.headers, origin)
  headers.delete('Content-Length')
  headers.delete('Content-Encoding')
  headers.delete('Transfer-Encoding')
  return new Response(text, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  })
}

/** The `code` argument and rpc id of an `execute` call, when the body is one. */
function executeCodeOf(parsed: unknown): { id: unknown; code: string } | null {
  const pick = (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return null
    const m = msg as {
      id?: unknown
      method?: unknown
      params?: { name?: unknown; arguments?: unknown }
    }
    if (m.method !== 'tools/call' || m.params?.name !== 'execute') return null
    const code = (m.params?.arguments as { code?: unknown } | undefined)?.code
    return typeof code === 'string' ? { id: m.id, code } : null
  }
  if (Array.isArray(parsed)) {
    for (const msg of parsed) {
      const hit = pick(msg)
      if (hit) return hit
    }
    return null
  }
  return pick(parsed)
}

/**
 * Handle a refused Cloudflare call: replay it if we can, else point at the tool.
 *
 * Order matters. Replaying makes the caller's call succeed, which is the whole
 * point; the pointer is the fallback for code we cannot faithfully substitute.
 *
 * @returns a response to send, or null to pass the upstream's own through
 */
async function rescueOrGuide(
  upstream: Response,
  method: string,
  route: NonNullable<ReturnType<typeof matchBuildsRoute>>,
  rescuable: RescuedRequest | null,
  rpcId: unknown,
  origin: string,
  accept: string | null
): Promise<Response | null> {
  const contentType = upstream.headers.get('Content-Type') ?? ''
  if (!isBufferableResponse(method, contentType)) return null

  // Once this read starts the body is consumed, so every path below MUST return a
  // Response. Returning null here would send the caller on to stream a body that is
  // already disturbed, turning a transient read failure into a 502.
  let text: string
  try {
    text = await upstream.text()
  } catch {
    return new Response(null, {
      status: 502,
      statusText: 'Upstream body unreadable',
      headers: withCorsHeaders(upstream.headers, origin)
    })
  }
  // Not a credential refusal — hand back the body we had to consume to find out.
  if (!isAuthRefusal(upstream.status, text)) return respondWithText(upstream, text, origin)

  if (rescuable) {
    const rescued = await rescueRefusedCall(rescuable)
    if (rescued) {
      const payload = {
        jsonrpc: '2.0',
        id: rpcId ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(rescued.payload, null, 2) }],
          structuredContent: rescued.payload as Record<string, unknown>,
          isError: false
        }
      }
      const { body, contentType: ct } = encodeMcpResponse(payload, accept)
      const headers = withCorsHeaders(upstream.headers, origin)
      headers.set('Content-Type', ct)
      headers.delete('Content-Length')
      headers.delete('Content-Encoding')
      headers.delete('Transfer-Encoding')
      return new Response(body, { status: 200, headers })
    }
  }

  // Could not replay: append the one-line pointer to the original error.
  const guidance = buildsGuidanceText(route)
  const isSse = contentType.includes('text/event-stream')
  const outText = isSse
    ? rewriteSseData(text, (payload) => {
        const parsed = parseRpc(payload)
        return parsed ? JSON.stringify(appendGuidanceToResult(parsed, guidance)) : null
      })
    : (() => {
        const parsed = parseRpc(text)
        return parsed ? JSON.stringify(appendGuidanceToResult(parsed, guidance)) : text
      })()
  return respondWithText(upstream, outText, origin)
}

/**
 * Replay a refused Cloudflare call here, with the token that actually reaches it.
 *
 * This is the primary handling for a credential refusal on a forwarded `execute`:
 * the caller's call succeeds and returns real data, rather than returning an
 * error with advice attached. Only the faithfully-replayable shape is attempted
 * (see lib/cf-request-rescue.ts); anything else returns null and falls through.
 *
 * @returns an MCP tool result carrying the real API response, or null when the
 *   call could not be replayed
 */
async function rescueRefusedCall(
  rescued: RescuedRequest
): Promise<{ payload: unknown; usedUserToken: boolean } | null> {
  const accountId = await env.CLOUDFLARE_ACCOUNT_ID.get().catch(() => null)
  if (!accountId) return null

  // Pick the token by measured path requirement, not by trial: /builds/* needs the
  // user token, everything else is served by the narrower account token.
  const needsUser = requiresUserToken(rescued.path)
  const token = needsUser
    ? await env.CLOUDFLARE_USER_WRANGLER_API_TOKEN?.get?.().catch(() => null)
    : await env.CLOUDFLARE_WRANGLER_API_TOKEN?.get?.().catch(() => null)
  if (!token) return null

  try {
    const client = new CloudflareBuildsClient({ token, accountId })
    const { result, resultInfo } = await client.request<unknown>(rescued.method, rescued.path, {
      query: rescued.query,
      body: rescued.body
    })
    // Shaped like the upstream sandbox's own return value, so a caller that was
    // reading `.result` / `.success` sees what it expected.
    const payload = {
      success: true,
      result,
      ...(resultInfo ? { result_info: resultInfo } : {}),
      errors: [],
      messages: []
    }
    return { payload, usedUserToken: needsUser }
  } catch {
    // The replay failed on its own terms (a real 404, a bad payload). Fall through
    // so the caller sees the upstream's original response rather than ours.
    return null
  }
}

export const ALL: APIRoute = async ({ request, url, locals }) => {
  const origin = request.headers.get('Origin') ?? '*'
  // Every response this server generates itself is framed to match this. See
  // lib/mcp-response.ts for why ignoring it broke every locally-served tool.
  const acceptHeader = request.headers.get('Accept')

  /**
   * Record one of this server's own failures without delaying the reply.
   *
   * Scheduled on the ExecutionContext so the response is already on its way:
   * telemetry must never make a working call slower, and must never make a
   * working call fail. Every path is swallowed.
   */
  const noteFailure = (kind: FailureKind, tool: string, detail: string): void => {
    const run = async () => {
      try {
        const key = await env.WORKER_API_KEY.get().catch(() => null)
        await reportFailure(getDb(env.CICD_DB), { kind, tool, detail }, key)
      } catch {
        // Reporting is best-effort by design.
      }
    }
    // The Cloudflare adapter puts the ExecutionContext on locals.runtime, but the
    // App.Locals declaration in env.d.ts is module-scoped so it does not merge —
    // hence the narrow cast rather than a global type change.
    const ctx = (locals as { runtime?: { ctx?: { waitUntil(p: Promise<unknown>): void } } }).runtime
      ?.ctx
    // Without a context the promise could be cancelled when the response returns,
    // so it is awaited nowhere but still started: a dropped report is acceptable,
    // a delayed response is not.
    if (ctx) ctx.waitUntil(run())
    else void run()
  }

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
  let localCall: { id: unknown; name: string; args: Record<string, unknown> } | null = null
  let toolsList = false
  let buildsRoute: ReturnType<typeof matchBuildsRoute> = null
  let rescuable: RescuedRequest | null = null
  let rpcId: unknown = null
  if (request.method === 'POST' && request.body) {
    const rawBody = await request.text()
    // A missing/rotated secret or a transient store error must not 500 the whole
    // proxy — account injection is an enhancement, not load-bearing.
    const accountId = await env.CLOUDFLARE_ACCOUNT_ID.get().catch(() => null)
    forwardedBody = accountId ? injectAccountId(rawBody, accountId) : rawBody
    // The forwarded body is a re-serialized string; its length may differ from the
    // original header, so let fetch recompute Content-Length.
    forwardedHeaders.delete('Content-Length')
    const parsedBody = parseRpc(forwardedBody)
    if (DOCS_PAIRING_ENABLED) searchCall = detectSearchCall(parsedBody)
    // An `execute` reaching for a Workers Builds path is the setup for a
    // misdiagnosis: the upstream will refuse it on credentials and agents have
    // repeatedly read that as "blocked". Remember the route so the refusal can be
    // answered with the local tool that does work. See lib/builds-guidance.ts.
    buildsRoute = detectBuildsExecuteCall(parsedBody)
    // Recovered up front so the refusal path has it without re-parsing the body.
    if (buildsRoute) {
      const ex = executeCodeOf(parsedBody)
      rescuable = ex ? extractSingleCloudflareRequest(ex.code) : null
      rpcId = ex?.id ?? null
    }
    // Tools this server implements itself are answered here; everything else,
    // including the upstream's own tools, is forwarded untouched.
    localCall = detectLocalToolCall(parsedBody)
    toolsList = isToolsListRequest(parsedBody)
  }

  // A local tool call never reaches the upstream and never sees its token. The
  // bearer check above has already passed at this point.
  if (localCall) {
    try {
      // Pseudonymous, stable caller label for the audit trail. Derived from the
      // bearer so two agents are distinguishable, hashed so no fragment of a
      // credential is ever written to D1.
      const actor = await callerLabel(presentedToken)
      const ctx = await buildToolContext(env as never, actor)
      return localJsonResponse(
        await runLocalTool(localCall, ctx),
        origin,
        acceptHeader,
        (problems) => noteFailure('malformed_response', localCall!.name, problems.join('; ')),
        localCall.name
      )
    } catch (err) {
      const payload =
        err instanceof ToolError
          ? err.toJSON()
          : {
              error: 'tool_context_failed',
              message: err instanceof Error ? err.message : String(err)
            }
      // A ToolError is an expected, caller-actionable outcome (bad argument, 404).
      // Anything else is this server failing, which is what wants reporting.
      if (!(err instanceof ToolError)) {
        noteFailure(
          'tool_error',
          localCall.name,
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        )
      }
      return localJsonResponse(
        {
          jsonrpc: '2.0',
          id: localCall.id ?? null,
          result: {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            isError: true
          }
        },
        origin,
        acceptHeader
      )
    }
  }

  try {
    // `search` calls are enriched with Cloudflare docs; everything else is a plain
    // proxy. Pairing owns the search fetch, so it isn't also run below. Docs go to
    // the separate, public docs MCP server (never the privileged API token).
    if (searchCall) {
      return await proxySearchWithDocs(
        targetUrl.toString(),
        forwardedHeaders,
        typeof forwardedBody === 'string' ? forwardedBody : '',
        DOCS_MCP_URL,
        buildDocsHeaders(request.headers.get('MCP-Protocol-Version')),
        DOCS_TOOL_NAME,
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

    // Advertise the local CI/CD tools alongside the upstream's own, and tell the
    // model up front that /builds/* is not reachable through `execute`.
    if (toolsList && upstreamResponse.ok) {
      return await mergeToolsListResponse(upstreamResponse, origin)
    }

    // A refused Cloudflare call is REPLAYED here with the token that reaches it,
    // so the caller's call succeeds and returns real data. Only when the code is
    // too complex to replay faithfully does a one-line pointer get appended
    // instead. Buffering is confined to this case so ordinary traffic streams on.
    if (buildsRoute) {
      const handled = await rescueOrGuide(
        upstreamResponse,
        request.method,
        buildsRoute,
        rescuable,
        rpcId,
        origin,
        acceptHeader
      )
      if (handled) return handled
    }

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
