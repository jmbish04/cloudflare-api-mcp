/**
 * Criticality rules and live Cloudflare documentation lookup for build failures.
 *
 * Two deliberate constraints:
 *
 * 1. **Criticality is rule-based, not keyword-based.** "the log contains the word
 *    error" is not a rule — build logs say "error" constantly while succeeding.
 *    Criticality is driven by the build's own outcome plus a small list of
 *    recognised severe signatures, and each firing rule is named in the result.
 * 2. **Nothing is persisted and nothing large leaves the Worker.** The docs
 *    lookup is made on demand per call, sends only a short redacted error
 *    signature, and its response is returned to the caller, never stored.
 *
 * No AI inference is involved: this is a deterministic signature extraction plus
 * a documentation search.
 */

import { buildDocsHeaders, buildDocsRequestBody, extractToolText, parseRpc } from './docs-pairing'
import { errorSignature } from './redact'
import type { Build } from './cf-builds'

/** Cloudflare's public documentation MCP. Unauthenticated; never sent a token. */
export const DOCS_MCP_URL = 'https://docs.mcp.cloudflare.com/mcp'
export const DOCS_TOOL_NAME = 'search_cloudflare_documentation'
const DOCS_TIMEOUT_MS = 4000

/** Outcomes that make a build critical on their own. */
const CRITICAL_OUTCOMES = new Set(['fail', 'terminated'])

/**
 * Signatures that are severe regardless of outcome. Each is a specific failure
 * mode with a known remedy, not a generic word.
 */
const SEVERE_SIGNATURES: Array<{ id: string; re: RegExp; note: string }> = [
  {
    id: 'startup_cpu_10021',
    re: /Script startup exceeded CPU time limit|\[code: ?10021\]/i,
    note: 'Worker startup CPU limit exceeded — module-scope work is too heavy.'
  },
  {
    id: 'missing_entrypoint',
    re: /Missing entry-point|Could not resolve .*entry/i,
    note: 'The deploy command could not find the Worker entry point.'
  },
  {
    id: 'oom',
    re: /JavaScript heap out of memory|Killed\b.*(?:npm|node|pnpm)|ENOMEM/i,
    note: 'The build ran out of memory.'
  },
  {
    id: 'disk_full',
    re: /ENOSPC|no space left on device/i,
    note: 'The build ran out of disk space.'
  },
  {
    id: 'auth_failure',
    re: /Authentication error|\bcode: ?10000\b|Invalid token|401 Unauthorized/i,
    note: 'The deploy credential was rejected.'
  },
  {
    id: 'dependency_resolution',
    re: /ERR_PNPM_[A-Z_]+|npm ERR! code E[A-Z]+|Cannot find module/i,
    note: 'Dependency installation or resolution failed.'
  },
  {
    id: 'typecheck_failure',
    re: /error TS\d{4}:/,
    note: 'TypeScript type checking failed during the build.'
  },
  {
    id: 'binding_error',
    re: /binding .* (?:not found|is not defined)|D1_ERROR/i,
    note: 'A Worker binding failed to resolve.'
  }
]

export interface Criticality {
  critical: boolean
  /** Every rule that fired, by id — an auditable answer, not a verdict. */
  reasons: Array<{ rule: string; detail: string }>
}

export function assessCriticality(
  build: Pick<Build, 'status' | 'build_outcome'> | null,
  logText: string,
  matchedSeverities: string[] = []
): Criticality {
  const reasons: Criticality['reasons'] = []

  const outcome = (build?.build_outcome ?? '').toLowerCase()
  if (CRITICAL_OUTCOMES.has(outcome)) {
    reasons.push({ rule: 'build_outcome', detail: `Build outcome is "${outcome}".` })
  }
  if (build?.status === 'stopped' && outcome === 'fail') {
    reasons.push({ rule: 'failed_deployment', detail: 'The build stopped without deploying.' })
  }
  for (const sig of SEVERE_SIGNATURES) {
    if (sig.re.test(logText)) reasons.push({ rule: `severe_signature:${sig.id}`, detail: sig.note })
  }
  for (const sev of matchedSeverities) {
    if (sev === 'critical' || sev === 'high') {
      reasons.push({
        rule: 'matched_pattern_severity',
        detail: `A known pattern of severity "${sev}" matched.`
      })
    }
  }

  return { critical: reasons.length > 0, reasons }
}

export interface DocsLookup {
  attempted: boolean
  ok: boolean
  /** The redacted signature actually sent outside the Worker. */
  query?: string
  guidance?: string
  source_urls?: string[]
  retrieved_at?: string
  source: 'cloudflare-docs-mcp'
  /** Structured failure. A docs outage never fails the surrounding tool call. */
  error?: { kind: 'timeout' | 'http' | 'empty' | 'exception'; message: string }
}

/** Pull `https://developers.cloudflare.com/...` links out of the docs response. */
export function extractDocUrls(text: string, max = 8): string[] {
  const raw = text.match(/https?:\/\/[^\s)"'\]<>]+/g) ?? []
  const cleaned = raw
    // The docs MCP wraps links as <url>…</url>; trim any tag or punctuation the
    // match ran into, or the citation is a dead link ending in "</url>".
    .map((u) => u.replace(/[<>,.;]+$/, '').replace(/<\/?[a-z]+>$/i, ''))
    // Documentation pages only: images, logos and the bare homepage are not
    // citations and only make the list look padded.
    .filter((u) => /developers\.cloudflare\.com|cloudflare\.com\/docs/.test(u))
    .filter((u) => !/\.(png|jpe?g|svg|ico|css|js)$/i.test(u))
    .filter((u) => !/^https:\/\/developers\.cloudflare\.com\/?(#\w+)?$/.test(u))
  return [...new Set(cleaned)].slice(0, max)
}

/**
 * Query the Cloudflare documentation MCP with a minimal redacted signature.
 *
 * Always resolves: a failure is reported as a structured `error` on the result
 * so the caller still returns its logs and pattern matches.
 */
export async function lookupDocs(
  logText: string,
  context: string[] = [],
  opts: { fetchImpl?: typeof fetch; url?: string; signature?: string } = {}
): Promise<DocsLookup> {
  const f = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const signature = opts.signature ?? errorSignature(logText)
  if (!signature) {
    return {
      attempted: false,
      ok: false,
      source: 'cloudflare-docs-mcp',
      error: { kind: 'empty', message: 'No error signature could be derived from the log.' }
    }
  }
  const query = [signature, ...context].join(' ').slice(0, 500)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOCS_TIMEOUT_MS)
  try {
    const resp = await f(opts.url ?? DOCS_MCP_URL, {
      method: 'POST',
      headers: buildDocsHeaders(null),
      body: buildDocsRequestBody(DOCS_TOOL_NAME, query),
      signal: controller.signal
    })
    if (!resp.ok) {
      return {
        attempted: true,
        ok: false,
        query,
        source: 'cloudflare-docs-mcp',
        error: { kind: 'http', message: `Documentation MCP returned HTTP ${resp.status}` }
      }
    }
    const text = extractToolText(parseRpc(await resp.text()))
    if (!text) {
      return {
        attempted: true,
        ok: false,
        query,
        source: 'cloudflare-docs-mcp',
        error: { kind: 'empty', message: 'Documentation MCP returned no usable content.' }
      }
    }
    return {
      attempted: true,
      ok: true,
      query,
      guidance: text.slice(0, 6000),
      source_urls: extractDocUrls(text),
      retrieved_at: new Date().toISOString(),
      source: 'cloudflare-docs-mcp'
    }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return {
      attempted: true,
      ok: false,
      query,
      source: 'cloudflare-docs-mcp',
      error: {
        kind: aborted ? 'timeout' : 'exception',
        message: aborted ? `Documentation lookup timed out after ${DOCS_TIMEOUT_MS}ms` : String(e)
      }
    }
  } finally {
    clearTimeout(timer)
  }
}
