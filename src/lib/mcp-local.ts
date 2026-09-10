/**
 * Locally-served MCP tools.
 *
 * This Worker is normally a pure proxy: it forwards JSON-RPC to Cloudflare's
 * upstream Code Mode MCP. The CI/CD tools cannot be forwarded — the upstream does
 * not have them — so they are answered here and spliced into the same session:
 *
 *   - `tools/list`  → the upstream's tools plus these, in one list.
 *   - `tools/call`  → dispatched here when the name is one of ours, otherwise
 *                     forwarded untouched.
 *
 * A local tool never sees the upstream's privileged token, and dispatch happens
 * only after the request has already passed the bearer check in `mcp.ts`.
 */

import { CloudflareApiError, CloudflareBuildsClient } from './cf-builds'
import { GitHubClient, GitHubUnavailable } from './github'
import { buildTools } from './tools/builds'
import { cicdTools } from './tools/cicd'
import { patternTools } from './tools/patterns'
import { ToolError, type ToolContext, type ToolDefinition } from './tools/context'

export const LOCAL_TOOLS: ToolDefinition[] = [...cicdTools, ...buildTools, ...patternTools]

const BY_NAME = new Map(LOCAL_TOOLS.map((t) => [t.name, t]))

export function isLocalTool(name: unknown): name is string {
  return typeof name === 'string' && BY_NAME.has(name)
}

/** MCP `tools/list` entries for the local tools. */
export function localToolDescriptors(): Array<Record<string, unknown>> {
  return LOCAL_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema
  }))
}

interface Rpc {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: { name?: unknown; arguments?: Record<string, unknown> }
}

/** The single `tools/call` for a local tool in this body, if there is one. */
export function detectLocalToolCall(
  parsed: unknown
): { id: unknown; name: string; args: Record<string, unknown> } | null {
  const pick = (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return null
    const m = msg as Rpc
    if (m.method !== 'tools/call' || !isLocalTool(m.params?.name)) return null
    return { id: m.id, name: m.params!.name as string, args: m.params?.arguments ?? {} }
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

export function isToolsListRequest(parsed: unknown): boolean {
  const is = (msg: unknown) =>
    Boolean(msg && typeof msg === 'object' && (msg as Rpc).method === 'tools/list')
  return Array.isArray(parsed) ? parsed.some(is) : is(parsed)
}

/**
 * Append the local tools to an upstream `tools/list` result.
 *
 * Returns the input unchanged if the response is not the shape we expect — a
 * failure to merge must degrade to the upstream's own list, never to an error.
 */
export function mergeLocalToolsIntoList(parsed: unknown): unknown {
  const merge = (msg: unknown): unknown => {
    if (!msg || typeof msg !== 'object') return msg
    const m = msg as { result?: { tools?: unknown[] } }
    if (!m.result || !Array.isArray(m.result.tools)) return msg
    const existing = new Set(
      m.result.tools.map((t) => (t as { name?: string })?.name).filter(Boolean) as string[]
    )
    const additions = localToolDescriptors().filter((t) => !existing.has(t.name as string))
    return { ...m, result: { ...m.result, tools: [...m.result.tools, ...additions] } }
  }
  return Array.isArray(parsed) ? parsed.map(merge) : merge(parsed)
}

/** Serialise a tool result as an MCP tool response. */
function toolResponse(id: unknown, payload: unknown, isError = false) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError
    }
  }
}

/**
 * Run one local tool.
 *
 * Every failure is turned into a structured MCP tool error rather than an HTTP
 * error, so a client keeps the session and can act on the detail. Nothing thrown
 * here can leak a credential: `CloudflareApiError` and `GitHubUnavailable` both
 * serialise only status, path and message.
 */
export async function runLocalTool(
  call: { id: unknown; name: string; args: Record<string, unknown> },
  ctx: ToolContext
): Promise<unknown> {
  const tool = BY_NAME.get(call.name)
  if (!tool) {
    return toolResponse(
      call.id,
      { error: 'unknown_tool', message: `No local tool "${call.name}".` },
      true
    )
  }
  try {
    return toolResponse(call.id, await tool.handler(call.args, ctx))
  } catch (e) {
    if (e instanceof ToolError) return toolResponse(call.id, e.toJSON(), true)
    if (e instanceof CloudflareApiError) return toolResponse(call.id, e.toJSON(), true)
    if (e instanceof GitHubUnavailable) return toolResponse(call.id, e.toJSON(), true)
    return toolResponse(
      call.id,
      {
        error: 'tool_failed',
        tool: call.name,
        message: e instanceof Error ? e.message : String(e)
      },
      true
    )
  }
}

export interface LocalToolEnv {
  CICD_DB?: D1Database
  CLOUDFLARE_USER_WRANGLER_API_TOKEN?: { get(): Promise<string> }
  CLOUDFLARE_WRANGLER_API_TOKEN?: { get(): Promise<string> }
  CLOUDFLARE_ACCOUNT_ID?: { get(): Promise<string> }
  GH_TOKEN?: { get(): Promise<string> }
}

/**
 * Assemble the tool context from bindings.
 *
 * The Builds API token is deliberately the USER-scoped one: measured 2026-09-10,
 * the account-scoped `CLOUDFLARE_WRANGLER_API_TOKEN` is refused by every
 * `/accounts/{id}/builds/*` path with 401 code 12006, while a user token with
 * "Workers Builds Configuration" succeeds. It falls back to the account token
 * only so a partially-configured deployment reports Cloudflare's own error
 * (which carries an explanatory hint) rather than failing to start.
 */
export async function buildToolContext(env: LocalToolEnv, actor: string): Promise<ToolContext> {
  if (!env.CICD_DB) {
    throw new ToolError(
      'not_configured',
      'The CICD_DB D1 binding is missing from this deployment, so CI/CD state and the pattern library are unavailable.'
    )
  }
  const accountId = await env.CLOUDFLARE_ACCOUNT_ID?.get().catch(() => undefined)
  if (!accountId) {
    throw new ToolError(
      'not_configured',
      'CLOUDFLARE_ACCOUNT_ID is not resolvable in this deployment.'
    )
  }
  const token =
    (await env.CLOUDFLARE_USER_WRANGLER_API_TOKEN?.get().catch(() => undefined)) ??
    (await env.CLOUDFLARE_WRANGLER_API_TOKEN?.get().catch(() => undefined))
  if (!token) {
    throw new ToolError(
      'not_configured',
      'No Cloudflare API token is resolvable. The Workers Builds API needs a USER-scoped token bound as CLOUDFLARE_USER_WRANGLER_API_TOKEN.'
    )
  }
  const ghToken = (await env.GH_TOKEN?.get().catch(() => undefined)) ?? null

  return {
    db: env.CICD_DB,
    cf: new CloudflareBuildsClient({ token, accountId }),
    gh: new GitHubClient(ghToken),
    accountId,
    actor
  }
}

/** Per-module health, for `/health`. Each check is real, not a hardcoded "ok". */
export async function moduleHealth(env: LocalToolEnv): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {}

  checks.tools = {
    ok: LOCAL_TOOLS.length > 0,
    count: LOCAL_TOOLS.length,
    names: LOCAL_TOOLS.map((t) => t.name)
  }

  try {
    const row = await env.CICD_DB?.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('cicd_state','cicd_leases','cicd_audit','build_patterns','build_pattern_events')"
    ).first<{ n: number }>()
    checks.d1 = { ok: (row?.n ?? 0) === 5, tables_present: row?.n ?? 0, expected: 5 }
  } catch (e) {
    checks.d1 = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  for (const [name, binding] of [
    ['cloudflare_user_token', env.CLOUDFLARE_USER_WRANGLER_API_TOKEN],
    ['cloudflare_account_id', env.CLOUDFLARE_ACCOUNT_ID],
    ['github_token', env.GH_TOKEN]
  ] as const) {
    try {
      const v = await binding?.get()
      // Presence only. The value is never echoed, and its length is not reported.
      checks[name] = { ok: Boolean(v), bound: Boolean(binding) }
    } catch (e) {
      checks[name] = {
        ok: false,
        bound: Boolean(binding),
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  const ok = Object.values(checks).every((c) => (c as { ok?: boolean }).ok !== false)
  return { ok, checks }
}
