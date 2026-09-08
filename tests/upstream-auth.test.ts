import { describe, expect, it } from 'vitest'
import {
  bodyLooksLikeAuthFailure,
  isAuthFailureStatus,
  isBufferableResponse,
  shouldRetryWithUserToken
} from '../src/lib/upstream-auth'

const JSON_CT = 'application/json'

/** A JSON-RPC tool result whose text content carries a Cloudflare API error. */
const toolResult = (text: string) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }] }
  })

describe('isAuthFailureStatus', () => {
  it('flags 401 and 403 only', () => {
    expect(isAuthFailureStatus(401)).toBe(true)
    expect(isAuthFailureStatus(403)).toBe(true)
    expect(isAuthFailureStatus(200)).toBe(false)
    expect(isAuthFailureStatus(404)).toBe(false)
    expect(isAuthFailureStatus(500)).toBe(false)
  })
})

describe('bodyLooksLikeAuthFailure', () => {
  it('detects the Cloudflare "Authentication error" code inside a tool result', () => {
    const body = toolResult(
      JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
    )
    expect(bodyLooksLikeAuthFailure(body)).toBe(true)
  })

  it('detects code 9109 (unauthorized to access requested resource)', () => {
    const body = toolResult('{"errors":[{"code":9109,"message":"nope"}]}')
    expect(bodyLooksLikeAuthFailure(body)).toBe(true)
  })

  // The measured Workers Builds refusal: an account-scoped token gets 12006
  // "Invalid token" here while the user token gets past auth. This is the exact
  // case the user-token fallback was added for.
  it('detects Workers Builds code 12006 ("Invalid token")', () => {
    const body = toolResult(
      JSON.stringify({ success: false, errors: [{ code: 12006, message: 'Invalid token' }] })
    )
    expect(bodyLooksLikeAuthFailure(body)).toBe(true)
  })

  it('does not confuse 12013 (invalid query parameter) for an auth failure', () => {
    const body = toolResult(
      JSON.stringify({
        success: false,
        errors: [{ code: 12013, message: 'Invalid query parameter' }]
      })
    )
    expect(bodyLooksLikeAuthFailure(body)).toBe(false)
  })

  it('detects a spaced code form, as pretty-printed JSON produces', () => {
    expect(bodyLooksLikeAuthFailure('{"code": 10000}')).toBe(true)
  })

  it('detects a bare 403 from a fetch inside the sandbox', () => {
    const body = toolResult('Request failed: 403 Forbidden')
    expect(bodyLooksLikeAuthFailure(body)).toBe(true)
  })

  it('detects an embedded status field', () => {
    expect(bodyLooksLikeAuthFailure(toolResult('{"status":403,"body":"nope"}'))).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(bodyLooksLikeAuthFailure(toolResult('UNAUTHORIZED'))).toBe(true)
  })

  // The retry costs a whole extra upstream round trip and re-runs sandboxed code,
  // so ordinary failures must not trigger it.
  it('ignores a successful result', () => {
    expect(bodyLooksLikeAuthFailure(toolResult('{"success":true,"result":[]}'))).toBe(false)
  })

  it('ignores a 404 / not-found error', () => {
    const body = toolResult('{"errors":[{"code":7003,"message":"Could not route to resource"}]}')
    expect(bodyLooksLikeAuthFailure(body)).toBe(false)
  })

  it('ignores a script error unrelated to permissions', () => {
    expect(bodyLooksLikeAuthFailure(toolResult('TypeError: x is not a function'))).toBe(false)
  })

  it('ignores an empty body', () => {
    expect(bodyLooksLikeAuthFailure('')).toBe(false)
  })
})

describe('isBufferableResponse', () => {
  it('buffers plain JSON on any method', () => {
    expect(isBufferableResponse('POST', JSON_CT)).toBe(true)
    expect(isBufferableResponse('GET', JSON_CT)).toBe(true)
  })

  // Real clients negotiate SSE, and a POST's event stream ends with the response.
  // If this were not buffered the token fallback would never fire in practice.
  it('buffers a POST event-stream response', () => {
    expect(isBufferableResponse('POST', 'text/event-stream')).toBe(true)
  })

  // A GET opens the open-ended server-to-client notification stream. Reading it
  // to completion would hang the request forever.
  it('never buffers a GET event-stream response', () => {
    expect(isBufferableResponse('GET', 'text/event-stream')).toBe(false)
  })
})

describe('shouldRetryWithUserToken', () => {
  it('retries on a transport-level 401 even with no body', () => {
    expect(shouldRetryWithUserToken(401, null)).toBe(true)
  })

  it('retries on a 200 whose payload carries the auth error', () => {
    expect(shouldRetryWithUserToken(200, toolResult('{"code":10000}'))).toBe(true)
  })

  // The shape actually seen on the wire: SSE framing around the JSON-RPC message.
  it('retries on a buffered SSE frame carrying the auth error', () => {
    const sse = `event: message\ndata: ${toolResult('{"code":12006,"message":"Invalid token"}')}\n\n`
    expect(shouldRetryWithUserToken(200, sse)).toBe(true)
  })

  it('does not retry a healthy 200', () => {
    expect(shouldRetryWithUserToken(200, toolResult('{"success":true}'))).toBe(false)
  })

  // An unbuffered stream gives nothing to judge; it must pass through, not be
  // retried on a guess.
  it('does not retry a response that was never buffered', () => {
    expect(shouldRetryWithUserToken(200, null)).toBe(false)
  })
})
