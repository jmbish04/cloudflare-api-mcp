import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

export const prerender = false

export const OPTIONS: APIRoute = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, Accept, X-Requested-With, Origin',
      'Access-Control-Max-Age': '86400'
    }
  })
}

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, any> = {}
  const contentType = request.headers.get('content-type') || ''

  try {
    if (contentType.includes('application/json')) {
      body = (await request.json()) as Record<string, any>
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData()
      for (const [k, v] of formData.entries()) {
        body[k] = v.toString()
      }
    } else {
      const text = await request.text()
      try {
        body = JSON.parse(text)
      } catch {
        body = {}
      }
    }
  } catch (err) {
    console.warn('Error reading registration request body:', err)
  }

  const clientId = body.client_id || `claude_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  const clientSecret = `sec_${crypto.randomUUID().replace(/-/g, '')}`
  const clientName = body.client_name || 'Claude'
  const redirectUris =
    Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0
      ? body.redirect_uris
      : typeof body.redirect_uri === 'string' && body.redirect_uri
        ? [body.redirect_uri]
        : ['https://claude.ai/api/mcp/oauth_callback', 'https://desktop.claude.ai/oauth/callback']

  const clientData = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: body.scope || 'read write',
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0
  }

  // Persist client registration in KV
  if (env?.OAUTH_KV) {
    try {
      await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(clientData))
    } catch (err) {
      console.warn('Could not persist client to KV:', err)
    }
  }

  return new Response(JSON.stringify(clientData), {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  })
}
