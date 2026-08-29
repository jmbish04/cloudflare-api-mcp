import { describe, expect, it } from 'vitest'
import {
  buildDocsRequestBody,
  deriveDocsQuery,
  detectSearchCall,
  extractToolText,
  mergeDocsIntoSearch,
  parseRpc,
  pickDocsToolName
} from '../src/lib/docs-pairing'

describe('parseRpc', () => {
  it('parses plain JSON', () => {
    expect(parseRpc('{"jsonrpc":"2.0","id":1}')).toEqual({ jsonrpc: '2.0', id: 1 })
  })

  it('parses SSE data framing (last data line)', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n'
    expect(parseRpc(sse)).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  it('returns null for non-JSON', () => {
    expect(parseRpc('not json at all')).toBeNull()
  })
})

describe('detectSearchCall', () => {
  const call = (name: string, args: unknown = {}) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  })

  it('detects a single search tools/call', () => {
    const got = detectSearchCall(call('search', { code: 'x' }))
    expect(got).toEqual({ id: 1, args: { code: 'x' } })
  })

  it('ignores non-search tool calls', () => {
    expect(detectSearchCall(call('execute', { code: 'x' }))).toBeNull()
  })

  it('ignores batch arrays', () => {
    expect(detectSearchCall([call('search')])).toBeNull()
  })

  it('ignores non-tools/call methods', () => {
    expect(detectSearchCall({ method: 'tools/list' })).toBeNull()
  })

  it('defaults arguments to an empty object', () => {
    expect(detectSearchCall({ method: 'tools/call', params: { name: 'search' } })).toEqual({
      id: undefined,
      args: {}
    })
  })
})

describe('deriveDocsQuery', () => {
  it('prefers an explicit docs_query argument', () => {
    expect(deriveDocsQuery({ docs_query: 'workers kv namespaces', code: 'ignored' })).toBe(
      'workers kv namespaces'
    )
  })

  it('derives terms from string literals in the code', () => {
    const code = `async () => spec.paths.filter(p => p.tags.includes('Workers') && p.path.includes('/dns_records'))`
    expect(deriveDocsQuery({ code })).toBe('Workers dns records')
  })

  it('drops JS/spec stopwords and short tokens', () => {
    const code = `async () => { for (const [path, methods] of Object.entries(spec.paths)) {} }`
    // path/methods/object/spec/paths are all stopwords → nothing meaningful
    expect(deriveDocsQuery({ code })).toBeNull()
  })

  it('returns null when there is no code and no override', () => {
    expect(deriveDocsQuery({})).toBeNull()
  })
})

describe('buildDocsRequestBody', () => {
  it('builds a docs tools/call body', () => {
    const body = JSON.parse(buildDocsRequestBody('docs', 'workers kv', 42))
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'docs', arguments: { query: 'workers kv' } }
    })
  })
})

describe('pickDocsToolName', () => {
  const list = (tools: unknown[]) => ({ jsonrpc: '2.0', id: 1, result: { tools } })

  it('prefers an exact "docs" tool', () => {
    expect(pickDocsToolName(list([{ name: 'search' }, { name: 'docs' }]))).toBe('docs')
  })

  it('falls back to a name containing "doc"', () => {
    expect(pickDocsToolName(list([{ name: 'search' }, { name: 'docs_search' }]))).toBe(
      'docs_search'
    )
  })

  it('falls back to a description match', () => {
    expect(
      pickDocsToolName(list([{ name: 'lookup', description: 'Search developer documentation' }]))
    ).toBe('lookup')
  })

  it('returns null when no docs-like tool exists', () => {
    expect(pickDocsToolName(list([{ name: 'search' }, { name: 'execute' }]))).toBeNull()
  })
})

describe('extractToolText', () => {
  it('concatenates text content blocks', () => {
    const rpc = {
      result: {
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' }
        ]
      }
    }
    expect(extractToolText(rpc)).toBe('a\nb')
  })

  it('returns null on an error result', () => {
    expect(extractToolText({ error: { code: -32000, message: 'nope' } })).toBeNull()
  })

  it('returns null when there is no text content', () => {
    expect(extractToolText({ result: { content: [{ type: 'image' }] } })).toBeNull()
  })
})

describe('mergeDocsIntoSearch', () => {
  it('appends a docs content block to the search result', () => {
    const search = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'endpoints' }] }
    }
    const merged = mergeDocsIntoSearch(search, 'docs body', 'workers') as {
      result: { content: { type: string; text: string }[] }
    }
    expect(merged.result.content).toHaveLength(2)
    expect(merged.result.content[0].text).toBe('endpoints')
    expect(merged.result.content[1].text).toContain('Related Cloudflare docs')
    expect(merged.result.content[1].text).toContain('docs body')
  })

  it('caps long docs text', () => {
    const search = { result: { content: [] as unknown[] } }
    const merged = mergeDocsIntoSearch(search, 'x'.repeat(9000), 'q', 100) as {
      result: { content: { text: string }[] }
    }
    expect(merged.result.content[0].text).toContain('[docs truncated]')
    expect(merged.result.content[0].text.length).toBeLessThan(400)
  })

  it('leaves non-standard results untouched', () => {
    const err = { error: { message: 'boom' } }
    expect(mergeDocsIntoSearch(err, 'docs', 'q')).toBe(err)
  })
})
