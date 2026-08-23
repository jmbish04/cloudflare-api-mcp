import OAuthProvider, {
  type AuthRequest,
  type OAuthHelpers,
  type OAuthProviderOptions
} from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'

type AppEnv = Env & {
  OAUTH_PROVIDER: OAuthHelpers
}

const DEFAULT_UPSTREAM = 'https://mcp.cloudflare.com/mcp'
const MCP_ROUTE = '/mcp'
const ONE_YEAR_IN_SECONDS = 31_536_000 // 365 days

function createOAuthBackend() {
  const app = new Hono<{ Bindings: AppEnv }>()

  // Handle OAuth /authorize request parsing & UI routing
  app.get('/authorize', async (c) => {
    try {
      const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
      const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId)
      const clientName = client?.clientName || 'Claude MCP Client'
      const statePayload = JSON.stringify(oauthReqInfo)

      const redirectUrl = new URL('/authorize', c.req.url)
      redirectUrl.searchParams.set('client_name', clientName)
      redirectUrl.searchParams.set('state', statePayload)

      return new Response(null, {
        status: 302,
        headers: { Location: redirectUrl.toString() }
      })
    } catch (err) {
      console.error('Error parsing auth request:', err)
      return c.text('Invalid authorization request parameters.', 400)
    }
  })

  // Handle OAuth /authorize form submission & key verification
  app.post('/authorize', async (c) => {
    try {
      const body = await c.req.parseBody()
      const apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'].trim() : ''
      const statePayload = typeof body['state'] === 'string' ? body['state'] : ''

      if (!statePayload) {
        return c.text('Missing OAuth session state.', 400)
      }

      let oauthReqInfo: AuthRequest
      try {
        oauthReqInfo = JSON.parse(statePayload) as AuthRequest
      } catch {
        return c.text('Invalid session state format.', 400)
      }

      const expectedApiKey = await c.env.WORKER_API_KEY.get()
      if (!expectedApiKey || apiKey !== expectedApiKey) {
        const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId)
        const clientName = client?.clientName || 'Claude MCP Client'

        const retryUrl = new URL('/authorize', c.req.url)
        retryUrl.searchParams.set('client_name', clientName)
        retryUrl.searchParams.set('state', statePayload)
        retryUrl.searchParams.set('error', 'Invalid Worker API Key. Please try again.')

        return new Response(null, {
          status: 302,
          headers: { Location: retryUrl.toString() }
        })
      }

      // Complete authorization with 1-year grant
      const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: 'admin',
        metadata: { label: 'Claude MCP User' },
        scope: oauthReqInfo.scope ?? [],
        props: { authorized: true }
      })

      return new Response(null, {
        status: 302,
        headers: { Location: redirectTo }
      })
    } catch (err) {
      console.error('Error completing authorization:', err)
      return c.text('Failed to complete authorization.', 500)
    }
  })

  return app
}

/** Proxy handler for authenticated /mcp calls */
const mcpProxyHandler = {
  async fetch(request: Request, env: AppEnv, _ctx: ExecutionContext): Promise<Response> {
    const cfApiToken = await env.CLOUDFLARE_WRANGLER_API_TOKEN.get()
    if (!cfApiToken) {
      return new Response(
        JSON.stringify({ error: 'CLOUDFLARE_WRANGLER_API_TOKEN secret is not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const incomingUrl = new URL(request.url)
    const upstreamBase = env.UPSTREAM_MCP_URL || DEFAULT_UPSTREAM
    const targetUrl = new URL(upstreamBase)
    targetUrl.search = incomingUrl.search

    const forwardedHeaders = new Headers(request.headers)
    forwardedHeaders.set('Host', targetUrl.hostname)
    forwardedHeaders.set('Authorization', `Bearer ${cfApiToken}`)

    try {
      const upstreamResponse = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: forwardedHeaders,
        body: request.body,
        redirect: 'follow'
      })

      const responseHeaders = new Headers(upstreamResponse.headers)
      const origin = request.headers.get('Origin')
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
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    const oauthOptions: OAuthProviderOptions<AppEnv> = {
      apiHandlers: {
        [MCP_ROUTE]: mcpProxyHandler
      },
      defaultHandler: createOAuthBackend(),
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: {
        resource: `${url.origin}${MCP_ROUTE}`,
        resource_name: 'Cloudflare API MCP Server'
      },
      accessTokenTTL: ONE_YEAR_IN_SECONDS, // 1 year
      refreshTokenTTL: ONE_YEAR_IN_SECONDS, // 1 year
      clientRegistrationTTL: undefined // Persistent client registrations
    }

    return new OAuthProvider(oauthOptions).fetch(request, env, ctx)
  }
}
