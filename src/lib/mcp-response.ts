/**
 * Serialise and validate the responses this server generates itself.
 *
 * ## The bug this exists to prevent, measured 2026-09-30
 *
 * MCP's Streamable HTTP transport lets a POST be answered with either
 * `application/json` or `text/event-stream`, and the client says which it can
 * take via `Accept`. Real clients negotiate the event-stream form.
 *
 * Locally-served tool results used to be emitted with a hardcoded
 * `Content-Type: application/json`, ignoring `Accept` entirely. Upstream tools
 * (`execute`, `search`, `docs`) are proxied, so they came back in whatever
 * framing the client asked for and worked fine. The result was a precise,
 * baffling asymmetry:
 *
 *     client sends  Accept: text/event-stream
 *     execute            -> text/event-stream   works
 *     workers_* (local)  -> application/json    client cannot read it
 *
 * At least two independent agents reported "your Cloudflare build tools are
 * broken / return results missing a required field" and worked around it, while
 * `execute` kept working — which sent them hunting for a credential problem.
 * A `curl` that accepts both types cannot see this at all, which is why it
 * survived earlier testing.
 *
 * So: **never hardcode the framing of a response we generate.** Negotiate it,
 * and validate the envelope before it leaves.
 */

/** `event: message` + a single `data:` line + the blank-line terminator. */
const SSE_EVENT = 'message'

/**
 * Does this client want the event-stream framing?
 *
 * True when `Accept` mentions `text/event-stream`. A client that accepts both
 * (the conformant case, `application/json, text/event-stream`) is given the
 * event stream, because that is what the MCP Streamable HTTP transport expects a
 * server to prefer and what every proxied upstream response already uses — so
 * local and upstream tools behave identically for the same client.
 *
 * @param accept the request's `Accept` header, or null when absent
 */
export function wantsEventStream(accept: string | null): boolean {
  if (!accept) return false
  return accept.toLowerCase().includes('text/event-stream')
}

/** A response body plus the Content-Type it must be served with. */
export interface EncodedResponse {
  body: string
  contentType: string
}

/**
 * Encode a JSON-RPC payload in the framing the client asked for.
 *
 * @param payload the JSON-RPC response object (or batch)
 * @param accept the request's `Accept` header
 */
export function encodeMcpResponse(payload: unknown, accept: string | null): EncodedResponse {
  const json = JSON.stringify(payload)
  if (!wantsEventStream(accept)) {
    return { body: json, contentType: 'application/json' }
  }
  // A single terminated SSE event. The blank line is the frame terminator and is
  // not optional — without it a client buffers the event forever.
  return {
    body: `event: ${SSE_EVENT}\ndata: ${json}\n\n`,
    contentType: 'text/event-stream'
  }
}

/**
 * Check a tool response envelope against what an MCP client requires.
 *
 * This is the guardrail, not a formality: the content-negotiation bug above
 * shipped because nothing inspected a locally-generated response before it left.
 * Anything this rejects would be unreadable to some client, so a rejection is
 * repaired (see `repairToolResponse`) and reported rather than sent.
 *
 * @returns a list of problems; empty means the envelope is well-formed
 */
export function validateToolResponse(payload: unknown): string[] {
  const problems: string[] = []
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['response is not a JSON-RPC object']
  }
  const p = payload as Record<string, unknown>

  if (p.jsonrpc !== '2.0') problems.push(`jsonrpc must be "2.0", got ${JSON.stringify(p.jsonrpc)}`)
  // `id` must be present (null is legal for a response to a malformed request)
  // but must never be undefined — a client matches replies to requests by it.
  if (!('id' in p)) problems.push('id is missing')

  const hasResult = 'result' in p
  const hasError = 'error' in p
  if (hasResult === hasError) {
    problems.push('exactly one of result or error must be present')
  }

  if (hasResult) {
    const r = p.result
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      problems.push('result must be an object')
    } else {
      const res = r as Record<string, unknown>
      if (!Array.isArray(res.content)) {
        problems.push('result.content must be an array')
      } else {
        res.content.forEach((block, i) => {
          if (!block || typeof block !== 'object') {
            problems.push(`result.content[${i}] is not an object`)
            return
          }
          const b = block as Record<string, unknown>
          if (typeof b.type !== 'string') problems.push(`result.content[${i}].type is missing`)
          if (b.type === 'text' && typeof b.text !== 'string') {
            problems.push(`result.content[${i}].text must be a string`)
          }
        })
      }
      if ('isError' in res && typeof res.isError !== 'boolean') {
        problems.push('result.isError must be a boolean when present')
      }
      if (
        'structuredContent' in res &&
        (res.structuredContent === null || typeof res.structuredContent !== 'object')
      ) {
        problems.push('result.structuredContent must be an object when present')
      }
    }
  }
  return problems
}

/**
 * Produce a well-formed error response in place of an invalid one.
 *
 * Last-resort only: a client must never receive something it cannot parse. This
 * says what broke in one line and stops. It deliberately does NOT tell the
 * caller to report it, retry, try another tool, or ask anyone for a credential —
 * the failure is recorded server-side automatically, and an agent reading a
 * scripted instruction to go bother the operator is the failure mode this whole
 * module exists to remove.
 *
 * @param id the request id the broken response was answering
 * @param problems what `validateToolResponse` objected to
 * @param toolName the tool whose response was malformed, when known
 */
export function repairToolResponse(id: unknown, problems: string[], toolName?: string): unknown {
  const payload = {
    error: 'malformed_tool_response',
    tool: toolName ?? null,
    message: 'Internal response-shape bug in cloudflare-api-mcp. Recorded automatically.',
    problems
  }
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true
    }
  }
}
