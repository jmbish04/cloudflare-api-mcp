import { describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

describe('Cloudflare MCP OAuth Proxy Worker', () => {
  const mockKV = {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn()
  } as unknown as KVNamespace

  const mockOAuthProvider = {
    parseAuthRequest: vi.fn().mockResolvedValue({
      clientId: 'claude-client-123',
      redirectUri: 'https://claude.ai/api/mcp/oauth_callback',
      scope: ['read', 'write'],
      responseType: 'code',
      state: 'oauth_state_123'
    }),
    lookupClient: vi.fn().mockResolvedValue({
      clientId: 'claude-client-123',
      clientName: 'Claude Desktop'
    }),
    completeAuthorization: vi.fn().mockResolvedValue({
      redirectTo:
        'https://claude.ai/api/mcp/oauth_callback?code=cf_auth_code_123&state=oauth_state_123'
    })
  } as unknown as any

  const mockEnv: any = {
    OAUTH_KV: mockKV,
    OAUTH_PROVIDER: mockOAuthProvider,
    UPSTREAM_MCP_URL: 'https://mcp.cloudflare.com/mcp',
    WORKER_API_KEY: {
      get: vi.fn().mockResolvedValue('my-super-secret-worker-key')
    },
    CLOUDFLARE_WRANGLER_API_TOKEN: {
      get: vi.fn().mockResolvedValue('cf_secret_token_123')
    }
  }

  const mockCtx = {} as ExecutionContext

  it('serves OAuth authorization server metadata', async () => {
    const request = new Request('http://localhost:2529/.well-known/oauth-authorization-server')
    const response = await worker.fetch(request, mockEnv, mockCtx)

    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      authorization_endpoint: string
      token_endpoint: string
    }
    expect(json.authorization_endpoint).toContain('/authorize')
    expect(json.token_endpoint).toContain('/token')
  })

  it('redirects to Astro login UI on GET /authorize', async () => {
    const request = new Request(
      'http://localhost:2529/authorize?response_type=code&client_id=claude-client-123'
    )
    const response = await worker.fetch(request, mockEnv, mockCtx)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('client_name=Claude+Desktop')
  })

  it('redirects back to /authorize with error param on invalid API key', async () => {
    const authState = JSON.stringify({
      clientId: 'claude-client-123',
      redirectUri: 'https://claude.ai/api/mcp/oauth_callback'
    })

    const formData = new FormData()
    formData.append('apiKey', 'wrong-key')
    formData.append('state', authState)

    const request = new Request('http://localhost:2529/authorize', {
      method: 'POST',
      body: formData
    })

    const response = await worker.fetch(request, mockEnv, mockCtx)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('error=Invalid+Worker+API+Key')
  })

  it('approves POST /authorize with correct worker API key and redirects to client', async () => {
    const authState = JSON.stringify({
      clientId: 'claude-client-123',
      redirectUri: 'https://claude.ai/api/mcp/oauth_callback'
    })

    const formData = new FormData()
    formData.append('apiKey', 'my-super-secret-worker-key')
    formData.append('state', authState)

    const request = new Request('http://localhost:2529/authorize', {
      method: 'POST',
      body: formData
    })

    const response = await worker.fetch(request, mockEnv, mockCtx)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('https://claude.ai/api/mcp/oauth_callback')
  })
})
