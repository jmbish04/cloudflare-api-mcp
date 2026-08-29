/**
 * Automatic docs pairing for the `/mcp` proxy.
 *
 * When a client calls the API `search` tool (which returns Cloudflare API
 * endpoints — the methods and payloads to use), the proxy also queries Cloudflare's
 * separate documentation MCP server with a query derived from the search, and
 * appends that documentation context to the search result. The agent then gets
 * both "which endpoint" and "how the product works" from one search.
 *
 * Everything here is pure (no Worker bindings, no fetch) so the transforms are
 * unit-testable. `mcp.ts` performs the I/O and falls back to the untouched search
 * response whenever anything is uncertain, so `search` can never be degraded.
 */

export const SEARCH_TOOL_NAME = 'search'
export const DOCS_QUERY_ARG = 'docs_query'
export const DOCS_TEXT_CAP = 4000
const MAX_QUERY_TERMS = 8

/** JS/spec-structure tokens to drop when deriving a docs query from search code. */
const CODE_STOPWORDS = new Set([
  'spec',
  'paths',
  'path',
  'method',
  'methods',
  'op',
  'ops',
  'tag',
  'tags',
  'some',
  'every',
  'map',
  'filter',
  'foreach',
  'entries',
  'object',
  'keys',
  'values',
  'includes',
  'tolowercase',
  'touppercase',
  'push',
  'pop',
  'results',
  'result',
  'response',
  'request',
  'async',
  'await',
  'return',
  'const',
  'let',
  'var',
  'function',
  'summary',
  'description',
  'startswith',
  'endswith',
  'match',
  'test',
  'tostring',
  'json',
  'stringify',
  'parse',
  'true',
  'false',
  'null',
  'undefined',
  'length',
  'index',
  'array',
  'string',
  'number',
  'boolean'
])

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * Parse a JSON-RPC message from a request/response body, tolerating both plain
 * JSON and SSE (`data:`-framed) transport. Returns the parsed value, or null.
 */
export function parseRpc(text: string): unknown {
  const tryParse = (s: string): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(s) }
    } catch {
      return { ok: false }
    }
  }

  const direct = tryParse(text.trim())
  if (direct.ok) return direct.value

  // SSE framing: use the last parseable `data:` line.
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.startsWith('data:')) continue
    const p = tryParse(line.slice('data:'.length).trim())
    if (p.ok) return p.value
  }
  return null
}

/**
 * If `parsed` is a single (non-batch) `tools/call` for the search tool, return
 * its id and arguments; otherwise null. Batch arrays are intentionally excluded —
 * pairing only applies to a lone search call.
 */
export function detectSearchCall(
  parsed: unknown
): { id: unknown; args: Record<string, unknown> } | null {
  const m = asRecord(parsed)
  if (!m || m.method !== 'tools/call') return null
  const params = asRecord(m.params)
  if (!params || params.name !== SEARCH_TOOL_NAME) return null
  return { id: m.id, args: asRecord(params.arguments) ?? {} }
}

/**
 * Derive a natural-language docs query from a search call's arguments.
 *
 * An explicit `docs_query` argument wins. Otherwise, terms are pulled from the
 * string literals in the search `code` (product names, tags, path fragments the
 * agent is filtering on), with JS/spec-structure tokens removed. Returns null
 * when nothing meaningful can be derived — in which case pairing is skipped.
 */
export function deriveDocsQuery(args: Record<string, unknown>): string | null {
  const explicit =
    typeof args[DOCS_QUERY_ARG] === 'string' ? (args[DOCS_QUERY_ARG] as string).trim() : ''
  if (explicit) return explicit.slice(0, 200)

  const code = typeof args.code === 'string' ? (args.code as string) : ''
  if (!code) return null

  const terms: string[] = []
  const seen = new Set<string>()
  const literalRe = /'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g
  let match: RegExpExecArray | null
  while ((match = literalRe.exec(code)) !== null) {
    const literal = match[1] ?? match[2] ?? match[3] ?? ''
    for (const word of literal.split(/[^A-Za-z0-9]+/)) {
      if (word.length < 3) continue
      const lower = word.toLowerCase()
      if (/^\d+$/.test(lower) || CODE_STOPWORDS.has(lower) || seen.has(lower)) continue
      seen.add(lower)
      terms.push(word)
      if (terms.length >= MAX_QUERY_TERMS) break
    }
    if (terms.length >= MAX_QUERY_TERMS) break
  }
  return terms.length ? terms.join(' ') : null
}

/**
 * Clean headers for the public docs MCP server. Constructed from scratch so it
 * can NEVER carry the privileged `Authorization` the API upstream receives — the
 * docs server is a different, unauthenticated service and must not see the token.
 */
export function buildDocsHeaders(protocolVersion: string | null): Headers {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'application/json, text/event-stream')
  if (protocolVersion) headers.set('MCP-Protocol-Version', protocolVersion)
  return headers
}

/** Build the JSON-RPC body for a docs tool call. */
export function buildDocsRequestBody(
  docsToolName: string,
  query: string,
  id: unknown = 'docs-pairing'
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: docsToolName, arguments: { query } }
  })
}

/** Concatenate the text content of a tool-call result, or null on error/no text. */
export function extractToolText(parsed: unknown): string | null {
  const m = asRecord(parsed)
  if (!m || m.error != null) return null
  const result = asRecord(m.result)
  if (!result || !Array.isArray(result.content)) return null

  const texts: string[] = []
  for (const item of result.content as unknown[]) {
    const c = asRecord(item)
    if (c && c.type === 'text' && typeof c.text === 'string') texts.push(c.text as string)
  }
  return texts.length ? texts.join('\n') : null
}

/**
 * Append the docs text to a search result as an extra `text` content block.
 * Leaves non-standard shapes (errors, missing `content` array) untouched, and
 * caps the docs text so the combined response stays reasonable.
 */
export function mergeDocsIntoSearch(
  searchParsed: unknown,
  docsText: string,
  query: string,
  cap = DOCS_TEXT_CAP
): unknown {
  const m = asRecord(searchParsed)
  const result = m ? asRecord(m.result) : null
  if (!result || !Array.isArray(result.content)) return searchParsed

  const trimmed =
    docsText.length > cap ? `${docsText.slice(0, cap)}\n\n…[docs truncated]` : docsText
  const block = {
    type: 'text',
    text: `\n---\n## Related Cloudflare docs (auto-added for: ${query})\n\n${trimmed}`
  }
  result.content = [...(result.content as unknown[]), block]
  return searchParsed
}
