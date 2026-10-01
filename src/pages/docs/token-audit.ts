import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { desc } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { tokenAuditDeletions, tokenAuditRuns } from '../../db/schema'
import { USER_TOKEN_QUOTA } from '../../lib/cf-tokens'

export const prerender = false

/**
 * The answer to "why was this token deleted?", served from D1.
 *
 * This route exists because a deletion nobody can explain is worse than a full
 * quota. Months after the fact the only handle anyone has is a token NAME, so the
 * deletions table keeps the name, its idle age and the classifier's verbatim
 * reasoning — and this page makes that searchable without writing SQL.
 *
 * Read-only, and deliberately unauthenticated like `/health`: it discloses token
 * names and audit reasoning, never a token value, id-to-secret mapping, or
 * anything that could be used to authenticate.
 *
 * `?format=json` returns the same data for scripts; the default is a page.
 */
export const GET: APIRoute = async ({ url }) => {
  const db = getDb(env.CICD_DB)
  let runs: Array<Record<string, unknown>> = []
  let deletions: Array<Record<string, unknown>> = []
  let error: string | null = null

  try {
    runs = await db.select().from(tokenAuditRuns).orderBy(desc(tokenAuditRuns.startedAt)).limit(25)
    deletions = await db
      .select()
      .from(tokenAuditDeletions)
      .orderBy(desc(tokenAuditDeletions.deletedAt))
      .limit(200)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const payload = {
    service: 'cloudflare-api-mcp',
    document: 'token audit policy and history',
    user_token_quota: USER_TOKEN_QUOTA,
    policy: {
      why: 'User API tokens are capped at 50 per account. A Workers Builds setup mints one per Worker, so the quota fills and the dashboard then refuses to configure builds with an error that does not mention tokens.',
      deletes_only: [
        'Expired — expires_on is in the past.',
        'Non-active status — already non-functional.',
        'A recognisably generated build token ("<worker> build token", "Workers Builds - <date>") that is unreferenced AND unused past the retention window (default 180 days).'
      ],
      never_deletes: [
        'Tokens whose name asserts keeping them (KEEP, do-not-delete, permanent, protected).',
        'Tokens this server itself authenticates with.',
        'Tokens referenced by a Workers Builds build token.',
        'Long-lived credentials whose last_used_on does not track real use — tunnels, DNS, certificates, origin, WARP, gateway.',
        'Anything idle whose name is not a recognisably generated build token — reported for human review instead.',
        'Never-used generated tokens — ambiguous, may belong to a build that has not run yet.'
      ],
      dry_run_default: true,
      tool: 'cloudflare_token_audit (apply=true to reclaim)'
    },
    runs,
    deletions,
    ...(error ? { error } : {})
  }

  if ((url.searchParams.get('format') ?? '').toLowerCase() === 'json') {
    return new Response(JSON.stringify(payload, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const esc = (s: unknown) =>
    String(s ?? '').replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
    )

  const deletionRows =
    deletions.length === 0
      ? '<tr><td colspan="5" class="muted">No token has been deleted by the audit.</td></tr>'
      : deletions
          .map(
            (d) =>
              `<tr><td>${esc(d.deletedAt)}</td><td><strong>${esc(d.tokenName)}</strong></td>` +
              `<td>${esc(d.idleDays ?? '—')}</td><td>${d.failed ? 'FAILED' : 'deleted'}</td>` +
              `<td>${esc(d.reason)}</td></tr>`
          )
          .join('')

  const runRows =
    runs.length === 0
      ? '<tr><td colspan="6" class="muted">No audit has run yet.</td></tr>'
      : runs
          .map(
            (r) =>
              `<tr><td>${esc(r.startedAt)}</td><td>${esc(r.mode)}</td><td>${esc(r.actor)}</td>` +
              `<td>${esc(r.tokensSeen)}/${esc(r.quota)}</td><td>${esc(r.deletedCount)}</td>` +
              `<td>${esc(r.verdictCounts)}</td></tr>`
          )
          .join('')

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token audit — cloudflare-api-mcp</title>
<style>
:root{color-scheme:light dark;--bg:#0b0d10;--fg:#e8eaed;--mut:#9aa0a6;--line:#2a2f36;--card:#13161a;--warn:#f5a623}
@media(prefers-color-scheme:light){:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#e3e5e8;--card:#f7f8fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.05rem;margin:32px 0 10px}
.sub{color:var(--mut);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 18px}
ul{margin:6px 0 0;padding-left:20px}li{margin:3px 0}
table{width:100%;border-collapse:collapse;font-size:13px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;white-space:nowrap}
.muted{color:var(--mut)}code{background:var(--card);padding:1px 5px;border-radius:4px;font-size:.92em}
.q{font-size:1.1rem}.warn{color:var(--warn)}
</style></head><body><div class="wrap">
<h1>Token audit</h1>
<p class="sub">Why a Cloudflare API token was deleted, and the policy that decided it.
<a href="?format=json">JSON</a></p>

<div class="card">
<p class="q"><strong>User API token quota: ${USER_TOKEN_QUOTA} per account.</strong></p>
<p class="muted">${esc(payload.policy.why)}</p>
</div>

<h2>What the audit deletes</h2>
<div class="card"><ul>${payload.policy.deletes_only.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>

<h2>What it never deletes</h2>
<div class="card"><ul>${payload.policy.never_deletes.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
<p class="muted">Dry-run by default. Deleting requires <code>apply=true</code> on <code>cloudflare_token_audit</code>.</p></div>

<h2>Deleted tokens</h2>
<p class="muted">The permanent record. The token is gone, so its name is the handle — search this list.</p>
<div class="scroll"><table><thead><tr><th>When</th><th>Token name</th><th>Idle days</th><th>Result</th><th>Reason</th></tr></thead>
<tbody>${deletionRows}</tbody></table></div>

<h2>Audit runs</h2>
<div class="scroll"><table><thead><tr><th>Started</th><th>Mode</th><th>Actor</th><th>Seen/quota</th><th>Deleted</th><th>Verdicts</th></tr></thead>
<tbody>${runRows}</tbody></table></div>

${error ? `<p class="warn">Audit history unavailable: ${esc(error)}</p>` : ''}
</div></body></html>`

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
