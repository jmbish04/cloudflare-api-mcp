/**
 * Record this server's own failures, and file a fixit task once per distinct one.
 *
 * ## Why automatic
 *
 * Three separate agents hit the same two defects (locally-served results framed as
 * JSON for clients that negotiated SSE, and `/builds/*` refusing the forwarded
 * token) and each spent its session diagnosing it before reporting to the
 * operator. Nothing on the server noticed. A failure an operator has to be told
 * about by hand is a failure that gets hit many times first.
 *
 * So the Worker reports on itself: every failure is deduped into one D1 row with
 * an occurrence count, and the **first** occurrence of a signature files a task
 * in colby-maestro against this project's plan.
 *
 * ## Three rules this follows
 *
 * 1. **Never affect the response.** Reporting is best-effort and runs after the
 *    reply is on its way (`waitUntil`). A telemetry failure must never turn a
 *    working call into a broken one — the whole point is to improve success rate.
 * 2. **Deduped, because D1 writes cost 1000x reads.** One row per signature with a
 *    counter, not one row per occurrence.
 * 3. **One task per signature, ever.** `fixit_filed_at` gates filing, so a defect
 *    that fires a thousand times produces one task, not a thousand.
 *
 * Nothing recorded holds a credential or a response body — `detail` is a short
 * redacted signature, passed through `redactText` on the way in.
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { toolFailures } from '../db/schema'
import { redactText } from './redact'

/** Coarse failure classes. Each maps to a plan section in colby-maestro. */
export type FailureKind = 'malformed_response' | 'tool_error' | 'upstream_refusal' | 'rescue_failed'

export interface FailureReport {
  kind: FailureKind
  /** Tool the failure occurred in, or 'proxy' for the forwarding path. */
  tool: string
  /** Short description. Redacted here; never pass a response body. */
  detail: string
}

const MAESTRO_BASE = 'https://colby-maestro.hacolby.workers.dev'
const PLAN_ID = '88da93328bb4'

/**
 * Plan sections for the "cloudflare-api-mcp reliability" plan.
 *
 * A protocol-shape bug and a token-scope bug are different work with different
 * fixes, so they file under different headings rather than one undifferentiated
 * backlog.
 */
const SECTION_BY_KIND: Record<FailureKind, string> = {
  malformed_response: 'sd90e7e69', // MCP protocol compliance
  upstream_refusal: 's42f0fa66', // Token scope and /builds/*
  rescue_failed: 's42f0fa66',
  tool_error: 's6151513f' // top-level reliability
}

/** `detail` is capped so a signature stays a signature and not a transcript. */
const DETAIL_MAX = 500

/**
 * Stable signature for a failure.
 *
 * Hashes only the parts that identify the *defect* — tool, kind, redacted detail —
 * so the same bug hit from different calls collapses onto one row.
 */
export async function failureSignature(report: FailureReport): Promise<string> {
  const basis = `${report.tool}\u0000${report.kind}\u0000${report.detail}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

/** Normalise a report: redact, trim, and cap the detail. */
export function normaliseReport(report: FailureReport): FailureReport {
  const detail = redactText(report.detail ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX)
  return { kind: report.kind, tool: report.tool || 'proxy', detail: detail || '(no detail)' }
}

/**
 * Record a failure and, on its first occurrence, file a fixit task.
 *
 * Every step is independently guarded: a D1 error does not stop the task being
 * filed, and a maestro outage does not stop the row being written. Both are
 * swallowed — a reporting failure must never surface to the caller.
 *
 * @param db Drizzle handle over CICD_DB
 * @param report what failed
 * @param workerApiKey bearer for colby-maestro, or null to skip filing
 * @returns what happened, for tests and for `/health`
 */
export async function reportFailure(
  db: Db,
  report: FailureReport,
  workerApiKey: string | null
): Promise<{ signature: string; recorded: boolean; filed: boolean }> {
  const norm = normaliseReport(report)
  const signature = await failureSignature(norm)
  const now = new Date().toISOString()
  let recorded = false
  let shouldFile = false

  try {
    // Upsert: first occurrence inserts, later ones bump the counter on the one row.
    await db
      .insert(toolFailures)
      .values({
        signature,
        tool: norm.tool,
        kind: norm.kind,
        detail: norm.detail,
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now
      })
      .onConflictDoUpdate({
        target: toolFailures.signature,
        set: {
          occurrenceCount: sql`${toolFailures.occurrenceCount} + 1`,
          lastSeenAt: now
        }
      })
    recorded = true

    // File only when no task has been filed for this signature yet. Read after the
    // upsert so a concurrent first-hit does not double-file.
    const row = await db
      .select({ filed: toolFailures.fixitFiledAt, count: toolFailures.occurrenceCount })
      .from(toolFailures)
      .where(sql`${toolFailures.signature} = ${signature}`)
      .limit(1)
    shouldFile = !!row[0] && row[0].filed === null
  } catch {
    // D1 unavailable or schema not migrated. Still try to file — an unreported
    // defect is worse than an unrecorded one.
    shouldFile = true
  }

  let filed = false
  if (shouldFile && workerApiKey) {
    const taskId = await fileFixitTask(norm, signature, workerApiKey)
    if (taskId) {
      filed = true
      try {
        await db
          .update(toolFailures)
          .set({ fixitFiledAt: now, fixitTaskId: taskId })
          .where(sql`${toolFailures.signature} = ${signature}`)
      } catch {
        // The task exists; losing the marker risks one duplicate later, which is
        // acceptable against losing the report entirely.
      }
    }
  }
  return { signature, recorded, filed }
}

/**
 * Create the colby-maestro task.
 *
 * `POST /api/tasks` refuses a task without `task_type`, `priority`, and a plan
 * heading (`plan_id` + `section_ids`), so all four are always sent.
 *
 * @returns the task id, or null when filing did not succeed
 */
async function fileFixitTask(
  report: FailureReport,
  signature: string,
  workerApiKey: string
): Promise<string | null> {
  const body = {
    project_key: 'cloudflare-api-mcp',
    repo_path: '/Volumes/Projects/workers/cloudflare-api-mcp',
    title: `FIXIT: ${report.kind} in ${report.tool} (${signature.slice(0, 8)})`,
    description: [
      `Reported automatically by cloudflare-api-mcp when the failure first occurred.`,
      ``,
      `kind:      ${report.kind}`,
      `tool:      ${report.tool}`,
      `signature: ${signature}`,
      ``,
      `detail (redacted):`,
      report.detail,
      ``,
      `Occurrences are counted on one row in D1 (\`tool_failures\`, keyed by`,
      `signature) rather than accumulating rows. Query that row for the current`,
      `count and first/last seen timestamps. Set \`resolved_at\` once fixed.`
    ].join('\n'),
    status: 'backlog',
    priority: report.kind === 'malformed_response' ? 'high' : 'medium',
    task_type: 'bug',
    tags: ['fixit', 'auto-reported', report.kind],
    plan_id: PLAN_ID,
    section_ids: [SECTION_BY_KIND[report.kind]]
  }

  try {
    const resp = await fetch(`${MAESTRO_BASE}/api/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workerApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    })
    if (!resp.ok) return null
    const json = (await resp.json()) as { task?: { id?: string }; id?: string }
    return json.task?.id ?? json.id ?? null
  } catch {
    return null // maestro unreachable or slow — never block on it
  }
}
