import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import schemaSql from '../migrations/0000_init.sql?raw'
import { getDb } from '../src/db/client'
import { CloudflareBuildsClient } from '../src/lib/cf-builds'
import {
  createResource,
  createWorker,
  findWorker,
  listResources,
  MAX_PAGES,
  runToolForRpc
} from '../src/lib/cf-ops'
import type { GitHubClient } from '../src/lib/github'
import type { ToolContext } from '../src/lib/tools/context'

type Call = { method: string; path: string; query: URLSearchParams; body: unknown }

/**
 * A fake Cloudflare v4 API. `routes` maps "METHOD /path" to a handler that gets
 * the query and returns `{ result, result_info }`. Every call is recorded so a
 * test can pin the WHOLE write set, not just the write it expected.
 */
function fakeApi(routes: Record<string, (q: URLSearchParams, body: unknown) => unknown>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/acct/, '')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? undefined)
    calls.push({ method, path, query: url.searchParams, body })
    const handler = routes[`${method} ${path}`]
    if (!handler) {
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 7003, message: 'no route' }] }),
        { status: 404 }
      )
    }
    const out = handler(url.searchParams, body) as {
      result?: unknown
      result_info?: unknown
      error?: { status: number; code: number; message: string }
    }
    if (out.error) {
      const { status, ...e } = out.error
      return new Response(JSON.stringify({ success: false, errors: [e] }), { status })
    }
    return new Response(JSON.stringify({ success: true, errors: [], ...out }), { status: 200 })
  }) as typeof fetch
  return { cf: new CloudflareBuildsClient({ token: 't', accountId: 'acct', fetchImpl }), calls }
}

/** Page-numbered listing of `all`, honouring page/per_page like the real API. */
function paged<T>(all: T[], opts: { cap?: number; info?: 'total_pages' | 'total_count' | 'none' }) {
  return (q: URLSearchParams) => {
    const per = Math.min(Number(q.get('per_page') ?? 20), opts.cap ?? Infinity)
    const page = Number(q.get('page') ?? 1)
    const slice = all.slice((page - 1) * per, page * per)
    const info: Record<string, number> = { page, per_page: per, count: slice.length }
    if (opts.info === 'total_pages') {
      info.total_pages = Math.ceil(all.length / per)
      info.total_count = all.length
    }
    if (opts.info === 'total_count') info.total_count = all.length
    return { result: slice, result_info: info }
  }
}

const d1s = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `db-${i}`, uuid: `u-${i}` }))

describe('listResources paging', () => {
  it('reads every D1 page when total_count is the only hint (D1 sends no total_pages)', async () => {
    const { cf, calls } = fakeApi({
      'GET /d1/database': paged(d1s(2500), { info: 'total_count' })
    })
    const all = await listResources(cf, 'd1')
    expect(all).toHaveLength(2500)
    expect(all[2499]).toEqual({ name: 'db-2499', id: 'u-2499' })
    expect(calls.map((c) => c.query.get('page'))).toEqual(['1', '2', '3'])
  })

  it('follows total_pages when the server silently caps per_page (Queues caps at 500)', async () => {
    const queues = Array.from({ length: 1200 }, (_, i) => ({ queue_name: `q-${i}` }))
    const { cf, calls } = fakeApi({
      'GET /queues': paged(queues, { cap: 500, info: 'total_pages' })
    })
    const all = await listResources(cf, 'queue')
    expect(all).toHaveLength(1200)
    expect(all[1199]).toEqual({ name: 'q-1199', id: 'q-1199' })
    expect(calls).toHaveLength(3)
  })

  it('stops at total_count without an extra empty request when the last page is exactly full', async () => {
    const { cf, calls } = fakeApi({
      'GET /d1/database': paged(d1s(2000), { info: 'total_count' })
    })
    expect(await listResources(cf, 'd1')).toHaveLength(2000)
    expect(calls.map((c) => c.query.get('page'))).toEqual(['1', '2'])
  })

  it('with no totals, trusts the per_page the server ECHOED, not the one requested', async () => {
    // Server caps at 500 and says so; a full page of 500 is not the last page.
    const { cf } = fakeApi({
      'GET /d1/database': paged(d1s(1200), { cap: 500, info: 'none' })
    })
    const all = await listResources(cf, 'd1')
    expect(all).toHaveLength(1200)
    expect(all[1199].name).toBe('db-1199')
  })

  it('follows the R2 cursor to the end', async () => {
    const { cf, calls } = fakeApi({
      'GET /r2/buckets': (q) =>
        q.get('cursor') === 'c1'
          ? { result: { buckets: [{ name: 'b-2' }] }, result_info: { per_page: 1000 } }
          : {
              result: { buckets: [{ name: 'b-1' }] },
              result_info: { cursor: 'c1', per_page: 1000 }
            }
    })
    expect(await listResources(cf, 'r2')).toEqual([
      { name: 'b-1', id: 'b-1' },
      { name: 'b-2', id: 'b-2' }
    ])
    expect(calls).toHaveLength(2)
  })

  it('refuses to answer from a listing that never reaches its end', async () => {
    const { cf } = fakeApi({
      // Every page full, and total_count always one page ahead: it never ends.
      'GET /storage/kv/namespaces': (q) => {
        const page = Number(q.get('page'))
        const per = Number(q.get('per_page'))
        return {
          result: Array.from({ length: per }, (_, i) => ({
            id: `${page}-${i}`,
            title: `${page}-${i}`
          })),
          result_info: { page, per_page: per, total_count: (page + 1) * per }
        }
      }
    })
    await expect(listResources(cf, 'kv')).rejects.toThrow(`within ${MAX_PAGES} pages`)
  })
})

describe('createResource idempotency', () => {
  it('reuses a same-named D1 database on a LATER page and writes nothing', async () => {
    const { cf, calls } = fakeApi({
      'GET /d1/database': paged(d1s(1500), { info: 'total_count' }),
      'POST /d1/database': () => ({ result: { uuid: 'NEW' } })
    })
    const r = await createResource(cf, 'd1', 'db-1400')
    expect(r).toEqual({ type: 'd1', name: 'db-1400', id: 'u-1400', created: false })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('creates a missing KV namespace once, keyed by title, and returns its id', async () => {
    const { cf, calls } = fakeApi({
      'GET /storage/kv/namespaces': paged([{ id: 'k1', title: 'OTHER' }], { info: 'total_pages' }),
      'POST /storage/kv/namespaces': () => ({ result: { id: 'k2', title: 'SESSIONS' } })
    })
    const r = await createResource(cf, 'kv', 'SESSIONS')
    expect(r).toEqual({ type: 'kv', name: 'SESSIONS', id: 'k2', created: true })
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes).toHaveLength(1)
    expect(writes[0].body).toEqual({ title: 'SESSIONS' })
  })

  it('sends Vectorize defaults (768 / cosine) and uses the name as the id', async () => {
    const { cf, calls } = fakeApi({
      'GET /vectorize/v2/indexes': () => ({ result: [] }),
      'POST /vectorize/v2/indexes': () => ({ result: { name: 'idx' } })
    })
    expect(await createResource(cf, 'vectorize', 'idx')).toEqual({
      type: 'vectorize',
      name: 'idx',
      id: 'idx',
      created: true
    })
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      name: 'idx',
      config: { dimensions: 768, metric: 'cosine' }
    })
  })

  it('treats a lost create race as reuse when the name exists on re-read', async () => {
    const queues: Array<{ queue_name: string }> = []
    const { cf, calls } = fakeApi({
      'GET /queues': () => ({
        result: [...queues],
        result_info: { page: 1, per_page: 500, total_pages: 1 }
      }),
      // Another caller created it between our list and our POST.
      'POST /queues': () => {
        queues.push({ queue_name: 'jobs' })
        return { error: { status: 409, code: 11009, message: 'Queue name already taken' } }
      }
    })
    expect(await createResource(cf, 'queue', 'jobs')).toEqual({
      type: 'queue',
      name: 'jobs',
      id: 'jobs',
      created: false
    })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET'])
  })

  it('rethrows a create failure when the name is still absent on re-read', async () => {
    const { cf } = fakeApi({
      'GET /queues': () => ({
        result: [],
        result_info: { page: 1, per_page: 500, total_pages: 1 }
      }),
      'POST /queues': () => ({
        error: { status: 403, code: 10000, message: 'Authentication error' }
      })
    })
    await expect(createResource(cf, 'queue', 'jobs')).rejects.toThrow('Authentication error')
  })
})

describe('Workers', () => {
  it('findWorker reports a missing Worker as exists:false, tag:null', async () => {
    const { cf } = fakeApi({
      'GET /workers/scripts': () => ({ result: [{ id: 'other', tag: 'tag-other' }] })
    })
    expect(await findWorker(cf, 'nope')).toEqual({ name: 'nope', exists: false, tag: null })
    expect(await findWorker(cf, 'other')).toEqual({
      name: 'other',
      exists: true,
      tag: 'tag-other'
    })
  })

  it('createWorker returns an existing Worker untouched', async () => {
    const { cf, calls } = fakeApi({
      'GET /workers/scripts': () => ({ result: [{ id: 'app', tag: 'tag-app' }] })
    })
    expect(await createWorker(cf, 'app')).toEqual({
      name: 'app',
      exists: true,
      tag: 'tag-app',
      created: false
    })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('createWorker uploads a multipart placeholder module and returns its tag', async () => {
    const { cf, calls } = fakeApi({
      'GET /workers/scripts': () => ({ result: [] }),
      'PUT /workers/scripts/new-app': () => ({ result: { id: 'new-app', tag: 'tag-new' } })
    })
    expect(await createWorker(cf, 'new-app')).toEqual({
      name: 'new-app',
      exists: true,
      tag: 'tag-new',
      created: true
    })
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.body).toBeInstanceOf(FormData)
    const form = put.body as FormData
    expect(JSON.parse(await (form.get('metadata') as Blob).text())).toMatchObject({
      main_module: 'index.js'
    })
    expect(await (form.get('index.js') as Blob).text()).toContain('status: 503')
  })

  it('createWorker rejects an invalid name before writing', async () => {
    const { cf, calls } = fakeApi({ 'GET /workers/scripts': () => ({ result: [] }) })
    await expect(createWorker(cf, 'Bad_Name')).rejects.toThrow('not a valid Worker name')
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })
})

describe('runToolForRpc', () => {
  it('throws an actionable error for an unknown tool name', async () => {
    await expect(runToolForRpc('workers_cicd_nope', {}, {} as ToolContext)).rejects.toThrow(
      /Unknown tool "workers_cicd_nope".*workers_cicd_get/
    )
  })
})

describe('runToolForRpc build-token default for workers_cicd_configure', () => {
  const raw = (env as unknown as { CICD_DB: D1Database }).CICD_DB

  beforeEach(async () => {
    for (const t of [
      'cicd_state',
      'cicd_leases',
      'cicd_audit',
      'build_patterns',
      'build_pattern_events'
    ]) {
      await raw.prepare(`DROP TABLE IF EXISTS ${t}`).run()
    }
    const statements = schemaSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean)
    for (const stmt of statements) await raw.prepare(stmt).run()
  })

  const MAESTRO_TRIGGER = {
    trigger_uuid: 'tr-cm',
    external_script_id: 'tag-cm',
    build_token_uuid: 'tok-cm',
    build_token_name: 'agent-visibility build token',
    branch_includes: ['main']
  }

  function ctxWith(appTriggers: unknown[]) {
    const { cf, calls } = fakeApi({
      'GET /workers/scripts': () => ({
        result: [
          { id: 'app', tag: 'tag-app' },
          { id: 'colby-maestro', tag: 'tag-cm' }
        ]
      }),
      'GET /builds/workers/tag-app/triggers': () => ({ result: appTriggers }),
      'GET /builds/workers/tag-cm/triggers': () => ({ result: [MAESTRO_TRIGGER] }),
      'GET /builds/tokens': () => ({
        result: [{ build_token_uuid: 'tok-cm' }, { build_token_uuid: 'tok-x' }]
      })
    })
    const gh = {
      getRepo: async () => ({ id: 1, owner: { id: 2, login: 'o' }, default_branch: 'main' })
    } as unknown as GitHubClient
    const ctx: ToolContext = { db: getDb(raw), cf, gh, accountId: 'acct', actor: 'test' }
    return { ctx, calls }
  }

  it("borrows colby-maestro's build token on CREATE and says so", async () => {
    const { ctx } = ctxWith([])
    const out = (await runToolForRpc(
      'workers_cicd_configure',
      { worker_name: 'app', repository: 'o/app', dry_run: true },
      ctx
    )) as Record<string, unknown>
    expect(out.mode).toBe('create')
    expect(out.build_token_defaulted).toMatchObject({
      build_token_uuid: 'tok-cm',
      build_token_name: 'agent-visibility build token'
    })
  })

  it('never injects a token on UPDATE — an existing trigger keeps its own', async () => {
    const { ctx } = ctxWith([
      {
        trigger_uuid: 'tr-app',
        external_script_id: 'tag-app',
        build_token_uuid: 'tok-app',
        branch_includes: ['main'],
        build_command: 'old'
      }
    ])
    const out = (await runToolForRpc(
      'workers_cicd_configure',
      { worker_name: 'app', build_command: 'new', dry_run: true },
      ctx
    )) as Record<string, unknown>
    expect(out.mode).toBe('update')
    expect(out.build_token_defaulted).toBeUndefined()
    expect(Object.keys(out.would_change as object)).toEqual(['build_command'])
  })

  it('folds a ToolError code into the RPC error message', async () => {
    const { ctx } = ctxWith([])
    await expect(
      runToolForRpc('workers_cicd_configure', { worker_name: 'ghost' }, ctx)
    ).rejects.toThrow(/^worker_not_found: No Worker named "ghost"/)
  })
})
