import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

export const prerender = false

const DEFAULT_UPSTREAM = 'https://mcp.cloudflare.com/mcp'

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

  // Validate the presented bearer against WORKER_API_KEY before handing the
  // privileged upstream token to the request. Without this, any bearer would
  // proxy with our Cloudflare API token. Review finding #2.
  const workerApiKey = await env.WORKER_API_KEY.get()
  const presentedToken = authHeader.slice('Bearer '.length).trim()
  if (!workerApiKey || presentedToken !== workerApiKey) {
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

  // Behind-the-scenes account-id injection for `execute` tool calls. Only bodies
  // that carry a request (POST) and only when the account id is configured.
  let forwardedBody: BodyInit | null | undefined = request.body
  // A missing/rotated secret or a transient store error must not 500 the whole
  // proxy — account injection is an enhancement, not load-bearing. Fall back to
  // no injection on any failure.
  const accountId = await env.CLOUDFLARE_ACCOUNT_ID.get().catch(() => null)
  if (accountId && request.method === 'POST' && request.body) {
    const rewritten = injectAccountId(await request.text(), accountId)
    forwardedBody = rewritten
    // Body length changed vs. the original stream — let fetch recompute it.
    forwardedHeaders.delete('Content-Length')
  }

  try {
    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: forwardedHeaders,
      body: forwardedBody,
      redirect: 'follow'
    })

    const responseHeaders = new Headers(upstreamResponse.headers)
    if (origin) {
      responseHeaders.set('Access-Control-Allow-Origin', origin)
      responseHeaders.set('Vary', 'Origin')
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders
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
