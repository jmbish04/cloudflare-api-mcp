/**
 * Shared plumbing for the locally-served MCP tools.
 *
 * These tools are answered by THIS Worker rather than forwarded to Cloudflare's
 * upstream Code Mode MCP. Everything they touch is fetched live per call: CI/CD
 * settings, build lists, build logs, PR metadata and documentation all come from
 * their upstream APIs at call time. Nothing is tailed, subscribed to, polled or
 * cached, and no retrieved log body is written to storage or to this Worker's
 * own logs.
 *
 * D1 holds exactly two things: pause/resume coordination state, and the reusable
 * failure-pattern library.
 */

import type { Db } from '../../db/client'
import type { CloudflareBuildsClient } from '../cf-builds'
import type { GitHubClient } from '../github'

export interface ToolContext {
  /** Drizzle handle over the CICD_DB binding. */
  db: Db
  cf: CloudflareBuildsClient
  gh: GitHubClient
  accountId: string
  /**
   * Caller label recorded in the audit trail. Descriptive metadata only — it is
   * NEVER treated as an identity or an authorization. Authorization happened at
   * the bearer check before dispatch.
   */
  actor: string
}

export interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}

/** JSON-schema helper: keeps the definitions below readable. */
export const S = {
  str: (description: string, extra: Record<string, unknown> = {}) => ({
    type: 'string',
    description,
    ...extra
  }),
  num: (description: string, extra: Record<string, unknown> = {}) => ({
    type: 'number',
    description,
    ...extra
  }),
  bool: (description: string) => ({ type: 'boolean', description }),
  strArray: (description: string) => ({ type: 'array', items: { type: 'string' }, description }),
  obj: (
    description: string,
    properties: Record<string, unknown>,
    required: string[] = []
  ): Record<string, unknown> => ({
    type: 'object',
    description,
    properties,
    required,
    additionalProperties: false
  })
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ToolError'
  }

  toJSON() {
    return { error: this.code, message: this.message, ...this.details }
  }
}

/**
 * Resolve a user-facing Worker name to Cloudflare's immutable tag.
 *
 * The Worker NAME is the only identifier a caller ever supplies or sees. The tag
 * is an internal detail, resolved here on every call, and recorded alongside
 * persisted state so a delete-and-recreate of the Worker (which mints a new tag)
 * is detectable rather than silently corrupting a saved configuration.
 */
export async function requireWorkerTag(ctx: ToolContext, workerName: string): Promise<string> {
  const tag = await ctx.cf.resolveWorkerTag(workerName)
  if (!tag) {
    throw new ToolError(
      'worker_not_found',
      `No Worker named "${workerName}" exists in account ${ctx.accountId}. Check the name (the Worker name, not its tag).`,
      { worker_name: workerName, account_id: ctx.accountId }
    )
  }
  return tag
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || !v.trim()) {
    throw new ToolError('invalid_argument', `"${key}" is required and must be a non-empty string.`)
  }
  return v.trim()
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? (args[key] as boolean) : undefined
}

export function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key]
  if (!Array.isArray(v)) return undefined
  return v.filter((x): x is string => typeof x === 'string')
}
