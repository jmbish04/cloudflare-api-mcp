import type { APIRoute } from 'astro'

export const prerender = false

export const OPTIONS: APIRoute = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept'
    }
  })
}

export const GET: APIRoute = async ({ url }) => {
  return new Response(
    JSON.stringify({
      resource: `${url.origin}/mcp`,
      authorization_servers: [url.origin],
      scopes_supported: ['read', 'write'],
      bearer_methods_supported: ['header']
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      }
    }
  )
}
