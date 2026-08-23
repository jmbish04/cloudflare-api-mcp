import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

export const prerender = false

const ONE_YEAR_IN_SECONDS = 31_536_000 // 365 days

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

  const token = `mcp_at_${crypto.randomUUID().replace(/-/g, '')}`
  const refreshToken = `mcp_rt_${crypto.randomUUID().replace(/-/g, '')}`

  // Cache token in KV
  if (env?.OAUTH_KV) {
    try {
      await env.OAUTH_KV.put(
        `token:${token}`,
        JSON.stringify({
          active: true,
          issued_at: Date.now(),
          client_id: bodyParams['client_id'] || 'claude'
        }),
        { expirationTtl: ONE_YEAR_IN_SECONDS }
      )
    } catch (err) {
      console.warn('Could not persist token to KV:', err)
    }
  }

  return new Response(
    JSON.stringify({
      access_token: token,
      token_type: 'Bearer',
      expires_in: ONE_YEAR_IN_SECONDS,
      refresh_token: refreshToken,
      scope: 'read write'
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      }
    }
  )
}
