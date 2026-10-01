import { describe, expect, it } from 'vitest'
import {
  EXECUTE_DESCRIPTION_HINT,
  annotateExecuteDescription,
  appendGuidanceToResult,
  buildsGuidanceText,
  matchBuildsRoute
} from '../src/lib/builds-guidance'

const ACC = 'b3304b14848de15c72c24a14b0cd187d'
const execCode = (path: string) =>
  `async () => await cloudflare.request({ method: "GET", path: "${path}" })`

describe('matchBuildsRoute — picks the tool that covers the path', () => {
  it('routes a build-log path to the log tools, not the list tool', () => {
    const r = matchBuildsRoute(execCode(`/accounts/${ACC}/builds/builds/abc-123/logs`))
    expect(r?.tools).toEqual(['workers_build_logs_get', 'workers_build_logs_search'])
  })

  // Ordering regression: /builds/builds/{uuid}/logs also matches the broader
  // list pattern, so the specific route has to be tested first.
  it('does not fall through to workers_builds_list for a log path', () => {
    const r = matchBuildsRoute(execCode(`/accounts/${ACC}/builds/builds/abc-123/logs`))
    expect(r?.tools).not.toContain('workers_builds_list')
  })

  it('routes a builds listing to workers_builds_list', () => {
    for (const p of [
      `/accounts/${ACC}/builds/builds`,
      `/accounts/${ACC}/builds/builds/latest`,
      `/accounts/${ACC}/builds/workers/abc/builds`
    ]) {
      expect(matchBuildsRoute(execCode(p))?.tools).toEqual(['workers_builds_list'])
    }
  })

  it('routes trigger and connection paths to the cicd tools', () => {
    for (const p of [
      `/accounts/${ACC}/builds/triggers`,
      `/accounts/${ACC}/builds/workers/abc/triggers`,
      `/accounts/${ACC}/builds/workers/abc`,
      `/accounts/${ACC}/builds/repos/connections`
    ]) {
      expect(matchBuildsRoute(execCode(p))?.tools).toEqual([
        'workers_cicd_get',
        'workers_cicd_configure'
      ])
    }
  })

  // Honesty requirement: endpoints no local tool wraps must not be sent to a
  // tool that cannot serve them.
  it('claims no tool for endpoints nothing wraps', () => {
    for (const p of [`/accounts/${ACC}/builds/tokens`, `/accounts/${ACC}/builds/account/limits`]) {
      expect(matchBuildsRoute(execCode(p))?.tools).toEqual([])
    }
    expect(matchBuildsRoute(execCode(`/accounts/${ACC}/builds/builds/x/cancel`))?.tools).toEqual([])
  })

  it('still matches an unrecognised /builds/ path via the catch-all', () => {
    const r = matchBuildsRoute(execCode(`/accounts/${ACC}/builds/some/future/thing`))
    expect(r).not.toBeNull()
    expect(r?.tools.length).toBeGreaterThan(0)
  })

  // A path assembled at runtime is the common case in generated code; missing it
  // would leave the agent with the bare 12006 this module exists to explain.
  it('matches a path built by interpolation', () => {
    expect(matchBuildsRoute('const p = `/accounts/${id}/builds/triggers`')).not.toBeNull()
  })

  it('ignores code that touches no builds path', () => {
    for (const p of [
      `/accounts/${ACC}/workers/scripts`,
      `/accounts/${ACC}/d1/database`,
      `/accounts/${ACC}/storage/kv/namespaces`
    ]) {
      expect(matchBuildsRoute(execCode(p))).toBeNull()
    }
    expect(matchBuildsRoute('')).toBeNull()
  })
})

describe('buildsGuidanceText — a pointer, never a lecture', () => {
  it('names the tool that serves the same data', () => {
    const t = buildsGuidanceText(matchBuildsRoute(execCode('/builds/builds/x/logs'))!)
    expect(t).toContain('workers_build_logs_get')
  })

  // The operator was explicit about this: an agent reading a scripted instruction
  // to go ask a human for a token is the failure this whole area exists to remove.
  // The note must never send the caller to a person, a dashboard, or a credential.
  it('never tells the caller to ask for a token, use the dashboard, or escalate', () => {
    for (const path of ['/builds/builds/x/logs', '/builds/triggers', '/builds/tokens']) {
      const t = buildsGuidanceText(matchBuildsRoute(execCode(path))!).toLowerCase()
      for (const forbidden of [
        'dashboard',
        'export',
        'cloudflare_user_wrangler_api_token',
        'operator',
        'do not report',
        'ask anyone',
        'ask your'
      ]) {
        expect(t).not.toContain(forbidden)
      }
    }
  })

  it('stays short — it rides along on an error, not instead of one', () => {
    const t = buildsGuidanceText(matchBuildsRoute(execCode('/builds/triggers'))!)
    expect(t.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(2)
  })

  it('says plainly when nothing wraps the endpoint', () => {
    const t = buildsGuidanceText(matchBuildsRoute(execCode('/builds/tokens'))!)
    expect(t).toContain('no route from here')
  })
})

describe('appendGuidanceToResult', () => {
  const refusal = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: 'Error: Cloudflare API error: 12006: Invalid token' }],
      isError: true
    }
  }

  it('appends without altering the original error text', () => {
    const out = appendGuidanceToResult(refusal, '\nNOTE') as typeof refusal
    expect(out.result.content[0].text).toBe(
      'Error: Cloudflare API error: 12006: Invalid token\nNOTE'
    )
    expect(out.result.isError).toBe(true)
    expect(out.id).toBe(1)
  })

  it('leaves a response with no text content untouched', () => {
    const noText = { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'image' }] } }
    expect(appendGuidanceToResult(noText, '\nNOTE')).toEqual(noText)
  })

  it('leaves a response with no content array untouched', () => {
    const err = { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'bad' } }
    expect(appendGuidanceToResult(err, '\nNOTE')).toEqual(err)
  })

  it('handles a batch', () => {
    const out = appendGuidanceToResult([refusal, refusal], '\nNOTE') as Array<typeof refusal>
    expect(out).toHaveLength(2)
    for (const m of out) expect(m.result.content[0].text).toContain('NOTE')
  })
})

describe('annotateExecuteDescription', () => {
  const list = (tools: Array<{ name: string; description?: string }>) => ({
    jsonrpc: '2.0',
    id: 1,
    result: { tools }
  })

  it('appends the hint to execute only', () => {
    const out = annotateExecuteDescription(
      list([
        { name: 'execute', description: 'Execute JavaScript.' },
        { name: 'search', description: 'Search the spec.' }
      ])
    ) as ReturnType<typeof list>
    expect(out.result.tools[0].description).toBe('Execute JavaScript.' + EXECUTE_DESCRIPTION_HINT)
    expect(out.result.tools[1].description).toBe('Search the spec.')
  })

  // Idempotence matters: the tools/list rewrite can run more than once across a
  // session, and a description that stacks the hint repeatedly is a bug a reader
  // would notice before any test did.
  it('does not stack the hint when applied twice', () => {
    const once = annotateExecuteDescription(list([{ name: 'execute', description: 'Base.' }]))
    const twice = annotateExecuteDescription(once) as ReturnType<typeof list>
    expect(twice.result.tools[0].description).toBe('Base.' + EXECUTE_DESCRIPTION_HINT)
  })

  it('leaves a list with no execute tool untouched', () => {
    const l = list([{ name: 'docs', description: 'Docs.' }])
    expect(annotateExecuteDescription(l)).toEqual(l)
  })

  it('leaves a malformed result untouched', () => {
    const bad = { jsonrpc: '2.0', id: 1, result: {} }
    expect(annotateExecuteDescription(bad)).toEqual(bad)
  })
})
