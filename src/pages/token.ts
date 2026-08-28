import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { handleTokenRequest } from '../lib/token-grants'

export const prerender = false

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

  return handleTokenRequest(bodyParams, env?.OAUTH_KV)
}
