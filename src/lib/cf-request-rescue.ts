/**
 * Make a refused Cloudflare API call succeed instead of explaining why it failed.
 *
 * ## Why this exists
 *
 * `execute` is forwarded to the upstream Code Mode server carrying the
 * **account-scoped** token. Every Cloudflare `/builds/*` path refuses that token
 * with `12006 "Invalid token"` (measured 2026-09-30 across eight endpoints, while
 * `/workers/scripts/*` and `/d1/*` return `200` on the same token). The user
 * token that *would* work cannot be substituted upstream — `mcp.cloudflare.com`
 * rejects it outright with `403 insufficient_scope`.
 *
 * This server, however, holds both tokens and can call the API directly. So when
 * a forwarded call is refused on credentials, the right answer is not a note
 * telling the agent which tool to use instead — it is to **perform the call here,
 * with the token that works, and return the real data.** The agent's call
 * succeeds and it never learns there was a problem.
 *
 * ## The ceiling, stated honestly
 *
 * We cannot run the caller's JavaScript. So a rescue is attempted only when the
 * code's entire body is a *single* `cloudflare.request({...})` with literal
 * arguments — the shape in which the raw API response is exactly what the code
 * would have returned, so substituting it changes nothing observable.
 *
 * Code that post-processes the response (`return { n: r.result.length }`), makes
 * several calls, or builds its arguments from runtime values is NOT rescued:
 * returning the raw response there would silently hand back a different shape
 * than the code asked for, which is worse than failing. Those fall through.
 *
 * ponytail: a regex-and-brace-balance extractor, not a JS parser. The ceiling is
 * the single-call shape above; if richer code needs rescuing, the upgrade path is
 * a real parser, not more regexes.
 */

/** A Cloudflare v4 call recovered from `execute` code. */
export interface RescuedRequest {
  method: string
  /** Path **relative to `/accounts/{account_id}`**, as the API client expects. */
  path: string
  query?: Record<string, string | number>
  body?: unknown
}

/** Methods we will replay. A write is replayed only if the caller asked for one. */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Cloudflare path families that require a user-scoped token.
 *
 * Measured, not assumed: every `/builds/*` endpoint refuses an account-scoped
 * token. Everything else tested (`/workers/scripts/*`, `/d1/*`, `/storage/kv/*`)
 * works with it, so the narrower token stays the default.
 */
const USER_TOKEN_PATHS = [/^\/builds\//]

/** Does reaching this path require the user-scoped token? */
export function requiresUserToken(relativePath: string): boolean {
  return USER_TOKEN_PATHS.some((re) => re.test(relativePath))
}

/**
 * Extract the object literal passed to the single `cloudflare.request(` call.
 *
 * @returns the literal's source text, or null when there is not exactly one call
 *   or its braces do not balance
 */
function singleRequestLiteral(code: string): string | null {
  const marker = /cloudflare\s*\.\s*request\s*\(/g
  const hits = [...code.matchAll(marker)]
  // Exactly one call, or we cannot know which response to substitute.
  if (hits.length !== 1) return null

  const openParen = hits[0].index! + hits[0][0].length
  const braceStart = code.indexOf('{', openParen)
  if (braceStart === -1) return null
  // Nothing but whitespace may sit between `(` and `{` — a variable argument
  // means the arguments are not literals.
  if (code.slice(openParen, braceStart).trim() !== '') return null

  let depth = 0
  for (let i = braceStart; i < code.length; i++) {
    const ch = code[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return code.slice(braceStart, i + 1)
    }
  }
  return null
}

/**
 * Is the call the whole body of the function, with no post-processing?
 *
 * Everything outside the `cloudflare.request(...)` expression must be the arrow
 * wrapper and optional `return` / `await` / braces / semicolons. Anything else is
 * code whose result would differ from the raw response.
 */
function callIsEntireBody(code: string, literal: string): boolean {
  const callStart = code.search(/cloudflare\s*\.\s*request\s*\(/)
  const literalEnd = code.indexOf(literal) + literal.length
  const closeParen = code.indexOf(')', literalEnd)
  if (callStart === -1 || closeParen === -1) return false

  const before = code.slice(0, callStart)
  const after = code.slice(closeParen + 1)

  // `async () => `, `async () => {`, `() =>`, plus optional return/await.
  const beforeOk = /^\s*(?:async\s*)?\(\s*\)\s*=>\s*\{?\s*(?:return\s+)?(?:await\s+)?$/.test(before)
  // Trailing `}`, `;`, whitespace only.
  const afterOk = /^[\s;}]*$/.test(after)
  return beforeOk && afterOk
}

/** Pull a string value for `key` from an object literal, literal or template. */
function readStringField(literal: string, key: string): string | null {
  const quoted = new RegExp(`${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(literal)
  return quoted ? quoted[2] : null
}

/**
 * Normalise an extracted path to the client's `/accounts/{acct}`-relative form.
 *
 * The account segment is stripped rather than validated, so a path that
 * interpolated the account id (`/accounts/${acc}/builds/...` — the common shape)
 * is still usable: the client re-adds the configured account id itself. Any
 * remaining `${...}` means a runtime value we cannot resolve, so the rescue is
 * abandoned.
 *
 * @returns the relative path, or null when it is not resolvable
 */
export function normaliseAccountPath(rawPath: string): string | null {
  let p = rawPath.trim()
  if (!p.startsWith('/')) p = `/${p}`
  // Strip a leading /accounts/<anything-but-slash>
  p = p.replace(/^\/accounts\/[^/]+/, '')
  if (p === '') return null
  if (p.includes('${')) return null // unresolved interpolation outside the account id
  return p.startsWith('/') ? p : `/${p}`
}

/** Parse a JSON-ish object literal (unquoted keys, single quotes) if it is one. */
function readObjectField(literal: string, key: string): Record<string, unknown> | null {
  const at = new RegExp(`${key}\\s*:\\s*\\{`).exec(literal)
  if (!at) return null
  const start = literal.indexOf('{', at.index)
  let depth = 0
  for (let i = start; i < literal.length; i++) {
    if (literal[i] === '{') depth++
    else if (literal[i] === '}') {
      depth--
      if (depth === 0) {
        const src = literal.slice(start, i + 1)
        if (src.includes('${')) return null
        const json = src
          .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":') // quote bare keys
          .replace(/'/g, '"')
          .replace(/,(\s*[}\]])/g, '$1') // trailing commas
        try {
          const parsed = JSON.parse(json)
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Recover a replayable Cloudflare call from `execute` code.
 *
 * @param code the `code` argument the caller passed to `execute`
 * @returns the call to replay, or null when the code is not the single-call shape
 *   this can faithfully substitute
 */
export function extractSingleCloudflareRequest(code: string): RescuedRequest | null {
  if (!code || !code.includes('cloudflare')) return null
  const literal = singleRequestLiteral(code)
  if (!literal) return null
  if (!callIsEntireBody(code, literal)) return null

  const method = (readStringField(literal, 'method') ?? 'GET').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) return null

  const rawPath = readStringField(literal, 'path')
  if (!rawPath) return null
  const path = normaliseAccountPath(rawPath)
  if (!path) return null

  const out: RescuedRequest = { method, path }

  // A `query`/`body` key that is present but unparseable means arguments we would
  // silently drop — abandon rather than replay a different call.
  if (/\bquery\s*:/.test(literal)) {
    const q = readObjectField(literal, 'query')
    if (!q) return null
    const flat: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(q)) {
      if (typeof v !== 'string' && typeof v !== 'number') return null
      flat[k] = v
    }
    out.query = flat
  }
  if (/\bbody\s*:/.test(literal)) {
    const bodyObj = readObjectField(literal, 'body')
    if (!bodyObj) return null
    out.body = bodyObj
  }
  return out
}
