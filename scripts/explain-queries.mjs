#!/usr/bin/env node
/**
 * Verify that every hot query still uses an index.
 *
 * D1 bills by rows **read (scanned)**, not rows returned, so a query that
 * degrades from `SEARCH ... USING INDEX` to `SCAN` is billed for the whole table
 * from then on — silently, with no test failure and no error. This script runs
 * EXPLAIN QUERY PLAN against the real database for each query the Worker runs
 * often, and exits non-zero if any of them starts scanning.
 *
 * Run: `pnpm run db:explain`
 */

import { execFileSync } from 'node:child_process'

const CONFIG = './wrangler.jsonc'
const BINDING = 'CICD_DB'

/**
 * Each entry is a query the Worker runs on a hot path. `mustNotScan` names the
 * table that has to be reached through an index; a plan line saying
 * `SCAN <table>` for it is a billing regression.
 */
const QUERIES = [
  {
    name: 'loadApplicablePatterns (runs on every build-log retrieval)',
    mustNotScan: 'build_patterns',
    sql: `SELECT * FROM build_patterns WHERE deleted_at IS NULL AND scope_key IN ('*','acct','worker','repo') AND status <> 'deprecated' LIMIT 200`
  },
  {
    name: 'listActiveLeases (every pause and resume)',
    mustNotScan: 'cicd_leases',
    sql: `SELECT * FROM cicd_leases WHERE account_id = 'a' AND worker_name = 'w' AND released_at IS NULL ORDER BY acquired_at`
  },
  {
    name: 'acquireLease idempotency lookup',
    mustNotScan: 'cicd_leases',
    sql: `SELECT * FROM cicd_leases WHERE account_id = 'a' AND worker_name = 'w' AND idempotency_key = 'k' LIMIT 1`
  },
  {
    name: 'getState (every CI/CD tool call)',
    mustNotScan: 'cicd_state',
    sql: `SELECT * FROM cicd_state WHERE account_id = 'a' AND worker_name = 'w' LIMIT 1`
  },
  {
    name: 'recentAudit (newest-first, must not sort the whole history)',
    mustNotScan: 'cicd_audit',
    sql: `SELECT action, actor, detail, created_at FROM cicd_audit WHERE account_id = 'a' AND worker_name = 'w' ORDER BY id DESC LIMIT 20`
  },
  {
    name: 'patternHistory (newest-first for one pattern)',
    mustNotScan: 'build_pattern_events',
    sql: `SELECT * FROM build_pattern_events WHERE pattern_id = 'p' ORDER BY id DESC LIMIT 50`
  },
  {
    name: 'build_patterns_list browse order',
    mustNotScan: 'build_patterns',
    sql: `SELECT * FROM build_patterns WHERE deleted_at IS NULL ORDER BY severity, confidence DESC LIMIT 25`
  }
]

function explain(sql) {
  const out = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      BINDING,
      '--remote',
      '-c',
      CONFIG,
      '--json',
      '--command',
      `EXPLAIN QUERY PLAN ${sql}`
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const parsed = JSON.parse(out.slice(out.indexOf('[')))
  return (parsed[0]?.results ?? []).map((r) => r.detail)
}

let failed = 0
for (const q of QUERIES) {
  let plan
  try {
    plan = explain(q.sql)
  } catch (e) {
    console.error(`✗ ${q.name}\n  could not EXPLAIN: ${e.message.split('\n')[0]}`)
    failed++
    continue
  }
  // Two different failures, both billed as "read every row":
  //
  //  - `SCAN <table>` with no index at all — a full table scan.
  //  - `SCAN <table> USING INDEX ...` *together with* a TEMP B-TREE for the
  //    ORDER BY. Walking an index in order lets SQLite stop after LIMIT rows;
  //    if it still has to sort, it reads every row first and the LIMIT saves
  //    nothing. An index scan on its own is fine — an unfiltered listing has to
  //    touch the rows it lists.
  const scansTable = plan.some((d) => new RegExp(`^SCAN ${q.mustNotScan}\\b`).test(d))
  const usesIndex = plan.some((d) =>
    new RegExp(`^(SCAN|SEARCH) ${q.mustNotScan}\\b.*USING (COVERING )?INDEX`).test(d)
  )
  const sortsEverything = plan.some((d) => /TEMP B-TREE FOR (LAST TERM OF )?ORDER BY/.test(d))
  const ok = (!scansTable || usesIndex) && !(scansTable && sortsEverything)
  console.log(`${ok ? '✓' : '✗'} ${q.name}`)
  for (const d of plan) console.log(`    ${d}`)
  if (!ok) {
    console.error(
      `    ^ BILLING REGRESSION: this reads every row of ${q.mustNotScan}${
        sortsEverything ? ' and sorts them before applying LIMIT' : ''
      }. Add or restore an index that matches the query's filter and ORDER BY direction.`
    )
    failed++
  }
}

if (failed) {
  console.error(
    `\n${failed} hot quer${failed === 1 ? 'y' : 'ies'} would be billed for a full scan.`
  )
  process.exit(1)
}
console.log('\nAll hot queries reach their table through an index.')
