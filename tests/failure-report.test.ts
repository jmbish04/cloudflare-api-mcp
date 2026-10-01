import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import failuresSql from '../migrations/0002_tool_failures.sql?raw'
import { getDb } from '../src/db/client'
import { failureSignature, normaliseReport, reportFailure } from '../src/lib/failure-report'

const raw = (env as unknown as { CICD_DB: D1Database }).CICD_DB
const db = getDb(raw)

/** Rows for a signature, read straight from D1 so the test trusts storage. */
async function row(signature: string) {
  return await raw
    .prepare(
      'SELECT occurrence_count, fixit_filed_at, fixit_task_id FROM tool_failures WHERE signature = ?'
    )
    .bind(signature)
    .first<{
      occurrence_count: number
      fixit_filed_at: string | null
      fixit_task_id: string | null
    }>()
}

beforeEach(async () => {
  await raw.exec('DROP TABLE IF EXISTS tool_failures')
  // `exec` wants one statement per call on a single line. Strip `--` comments
  // FIRST: collapsing newlines before stripping them lets a leading comment
  // swallow the whole statement ("SQL code did not contain a statement").
  const statements = failuresSql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  for (const stmt of statements) await raw.exec(stmt)
})

afterEach(() => vi.restoreAllMocks())

/** Stub colby-maestro so no task is actually filed. */
function stubMaestro(taskId: string | null, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    taskId === null
      ? new Response('nope', { status: 500 })
      : new Response(JSON.stringify({ task: { id: taskId } }), {
          status,
          headers: { 'Content-Type': 'application/json' }
        })
  )
}

describe('normaliseReport', () => {
  it('redacts, collapses whitespace and caps the detail', () => {
    const r = normaliseReport({ kind: 'tool_error', tool: 'x', detail: '  a\n\n  b  ' })
    expect(r.detail).toBe('a b')
    const long = normaliseReport({ kind: 'tool_error', tool: 'x', detail: 'z'.repeat(5000) })
    expect(long.detail.length).toBeLessThanOrEqual(500)
  })

  it('defaults an empty tool to the proxy path', () => {
    expect(normaliseReport({ kind: 'tool_error', tool: '', detail: 'd' }).tool).toBe('proxy')
  })
})

describe('failureSignature', () => {
  it('is stable for the same defect and different across defects', async () => {
    const a = await failureSignature({ kind: 'tool_error', tool: 't', detail: 'd' })
    const b = await failureSignature({ kind: 'tool_error', tool: 't', detail: 'd' })
    const c = await failureSignature({ kind: 'tool_error', tool: 't', detail: 'OTHER' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('reportFailure — deduped because a D1 write costs 1000x a read', () => {
  const report = { kind: 'malformed_response' as const, tool: 'workers_builds_list', detail: 'bad' }

  it('records the first occurrence and files one task', async () => {
    const fetchSpy = stubMaestro('task_123')
    const out = await reportFailure(db, report, 'key')
    expect(out.recorded).toBe(true)
    expect(out.filed).toBe(true)
    const r = await row(out.signature)
    expect(r?.occurrence_count).toBe(1)
    expect(r?.fixit_task_id).toBe('task_123')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // The whole point of the signature: a defect firing repeatedly must increment one
  // row, not accumulate rows, and must never file a second task.
  it('increments one row and files exactly once across many occurrences', async () => {
    const fetchSpy = stubMaestro('task_123')
    const first = await reportFailure(db, report, 'key')
    for (let i = 0; i < 4; i++) await reportFailure(db, report, 'key')

    const r = await row(first.signature)
    expect(r?.occurrence_count).toBe(5)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const count = await raw
      .prepare('SELECT COUNT(*) AS n FROM tool_failures')
      .first<{ n: number }>()
    expect(count?.n).toBe(1)
  })

  it('keeps distinct defects as distinct rows', async () => {
    stubMaestro('t')
    await reportFailure(db, report, 'key')
    await reportFailure(db, { ...report, detail: 'a different failure' }, 'key')
    const count = await raw
      .prepare('SELECT COUNT(*) AS n FROM tool_failures')
      .first<{ n: number }>()
    expect(count?.n).toBe(2)
  })

  // A maestro outage must not lose the record, and must leave the task unfiled so a
  // later occurrence can still file it. (A D1 outage is the opposite case: see below.)
  it('still records when filing fails, and retries filing next time', async () => {
    const failing = stubMaestro(null)
    const out = await reportFailure(db, report, 'key')
    expect(out.recorded).toBe(true)
    expect(out.filed).toBe(false)
    expect((await row(out.signature))?.fixit_filed_at).toBeNull()

    failing.mockRestore()
    const ok = stubMaestro('task_later')
    const second = await reportFailure(db, report, 'key')
    expect(second.filed).toBe(true)
    expect(ok).toHaveBeenCalledTimes(1)
  })

  // Without the D1 row there is no dedupe, so filing would be unbounded: a defect
  // firing on every request would file a task per request. Not filing is the lesser
  // failure, and `recorded: false` makes the problem visible.
  it('does not file when D1 cannot record, to avoid unbounded task spam', async () => {
    const fetchSpy = stubMaestro('task_x')
    await raw.exec('DROP TABLE IF EXISTS tool_failures')
    const out = await reportFailure(db, report, 'key')
    expect(out.recorded).toBe(false)
    expect(out.filed).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not attempt to file without a key', async () => {
    const fetchSpy = stubMaestro('t')
    const out = await reportFailure(db, report, null)
    expect(out.recorded).toBe(true)
    expect(out.filed).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends a task the maestro API will accept', async () => {
    const fetchSpy = stubMaestro('t')
    await reportFailure(db, report, 'key')
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    // POST /api/tasks refuses a task missing any of these.
    for (const field of ['project_key', 'task_type', 'priority', 'plan_id', 'section_ids']) {
      expect(body[field]).toBeTruthy()
    }
    expect(body.section_ids.length).toBeGreaterThan(0)
    expect(body.tags).toContain('fixit')
  })
})
