import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { moduleHealth } from '../lib/mcp-local'

export const prerender = false

/**
 * Health endpoint with REAL dependency checks — it queries D1 for the expected
 * tables and confirms each secret binding actually resolves, rather than
 * returning a hardcoded "ok". Secret VALUES are never returned or measured.
 */
export const GET: APIRoute = async () => {
  const upstream = env?.UPSTREAM_MCP_URL || 'https://mcp.cloudflare.com/mcp'
  let health: Record<string, unknown>
  try {
    health = await moduleHealth(env as never)
  } catch (e) {
    health = { ok: false, checks: { error: e instanceof Error ? e.message : String(e) } }
  }

  return new Response(
    JSON.stringify(
      {
        service: 'cloudflare-api-mcp',
        ok: health.ok,
        checked_at: new Date().toISOString(),
        upstream_mcp: upstream,
        modules: health.checks
      },
      null,
      2
    ),
    {
      status: health.ok ? 200 : 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    }
  )
}
