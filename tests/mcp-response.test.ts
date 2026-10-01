import { describe, expect, it } from 'vitest'
import {
  encodeMcpResponse,
  repairToolResponse,
  validateToolResponse,
  wantsEventStream
} from '../src/lib/mcp-response'

const ok = {
  jsonrpc: '2.0',
  id: 1,
  result: { content: [{ type: 'text', text: 'hi' }], isError: false }
}

describe('wantsEventStream — the bug that made every local tool look broken', () => {
  // This is the exact header real MCP clients send. Getting it wrong is what made
  // workers_* unreadable while the proxied execute/search/docs kept working.
  it('honours a client that accepts only the event stream', () => {
    expect(wantsEventStream('text/event-stream')).toBe(true)
  })

  it('honours the conformant both-types Accept', () => {
    expect(wantsEventStream('application/json, text/event-stream')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(wantsEventStream('TEXT/EVENT-STREAM')).toBe(true)
  })

  it('falls back to JSON for a JSON-only client and for no header', () => {
    expect(wantsEventStream('application/json')).toBe(false)
    expect(wantsEventStream(null)).toBe(false)
    expect(wantsEventStream('')).toBe(false)
  })
})

describe('encodeMcpResponse', () => {
  it('emits a terminated SSE frame when the stream is wanted', () => {
    const { body, contentType } = encodeMcpResponse(ok, 'text/event-stream')
    expect(contentType).toBe('text/event-stream')
    expect(body.startsWith('event: message\ndata: ')).toBe(true)
    // The blank-line terminator is NOT optional — without it a client buffers the
    // event forever and the call appears to hang.
    expect(body.endsWith('\n\n')).toBe(true)
    expect(JSON.parse(body.slice(body.indexOf('data: ') + 6).trim())).toEqual(ok)
  })

  it('emits plain JSON otherwise', () => {
    const { body, contentType } = encodeMcpResponse(ok, 'application/json')
    expect(contentType).toBe('application/json')
    expect(JSON.parse(body)).toEqual(ok)
  })
})

describe('validateToolResponse', () => {
  it('accepts a well-formed result', () => {
    expect(validateToolResponse(ok)).toEqual([])
  })

  it('accepts structuredContent alongside content', () => {
    expect(
      validateToolResponse({ ...ok, result: { ...ok.result, structuredContent: { a: 1 } } })
    ).toEqual([])
  })

  it('rejects a missing id — a client matches replies by it', () => {
    const { id: _id, ...noId } = ok
    expect(validateToolResponse(noId)).toContain('id is missing')
  })

  it('accepts a null id, which is legal', () => {
    expect(validateToolResponse({ ...ok, id: null })).toEqual([])
  })

  it('rejects a wrong jsonrpc version', () => {
    expect(validateToolResponse({ ...ok, jsonrpc: '1.0' }).join()).toContain('jsonrpc')
  })

  it('rejects both result and error, and neither', () => {
    expect(validateToolResponse({ jsonrpc: '2.0', id: 1 }).join()).toContain('exactly one')
    expect(validateToolResponse({ ...ok, error: { code: -1, message: 'x' } }).join()).toContain(
      'exactly one'
    )
  })

  it('accepts an error response', () => {
    expect(
      validateToolResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })
    ).toEqual([])
  })

  it('rejects content that is not an array', () => {
    expect(validateToolResponse({ ...ok, result: { content: 'nope' } }).join()).toContain(
      'result.content must be an array'
    )
  })

  it('rejects a text block with no text', () => {
    expect(
      validateToolResponse({ ...ok, result: { content: [{ type: 'text' }] } }).join()
    ).toContain('text must be a string')
  })

  it('rejects a non-boolean isError and a non-object structuredContent', () => {
    expect(
      validateToolResponse({ ...ok, result: { ...ok.result, isError: 'yes' } }).join()
    ).toContain('isError')
    expect(
      validateToolResponse({ ...ok, result: { ...ok.result, structuredContent: 7 } }).join()
    ).toContain('structuredContent')
  })

  it('rejects a non-object payload', () => {
    expect(validateToolResponse(null).length).toBeGreaterThan(0)
    expect(validateToolResponse([]).length).toBeGreaterThan(0)
  })
})

describe('repairToolResponse', () => {
  it('produces something that itself validates', () => {
    const repaired = repairToolResponse(
      5,
      ['result.content must be an array'],
      'workers_builds_list'
    )
    expect(validateToolResponse(repaired)).toEqual([])
    expect((repaired as { id: unknown }).id).toBe(5)
  })

  // The operator was explicit: agents must not be handed a script telling them to
  // report it, retry, or ask a human for a credential.
  it('does not instruct the caller to escalate to a human', () => {
    const text = JSON.stringify(repairToolResponse(1, ['x']))
    for (const forbidden of ['dashboard', 'ask', 'export', 'operator', 'retry', 'report it']) {
      expect(text.toLowerCase()).not.toContain(forbidden)
    }
  })
})
