/**
 * Redaction helpers.
 *
 * Build logs, trigger configuration and repository text are all returned to an
 * MCP client and some of it is persisted in D1. None of it is allowed to carry a
 * credential out of the Worker, so every value that leaves goes through here.
 *
 * Pure: no bindings, no I/O — unit-testable in isolation.
 */

/** Placeholder substituted for anything that looks like a credential. */
export const REDACTED = '[redacted]'

// Ordered most-specific first so a Cloudflare token is not merely caught by the
// generic "long opaque string" rule and reported as an unknown secret.
const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { label: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    label: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: 'bearer-header', re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  // `KEY=value` / `KEY: value` where the key name itself says "secret".
  {
    label: 'named-secret',
    re: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|[^\s"'&]+)/g
  },
  // Cloudflare API tokens are 40 chars of [A-Za-z0-9_-]; require a token-ish context
  // word nearby so ordinary base64 blobs in a build log are not mangled.
  { label: 'cloudflare-token', re: /\b[A-Za-z0-9_-]{40}\b(?=[^\n]{0,40}(?:token|key|secret)\b)/gi }
]

/** Whether a variable NAME (not its value) reads like a credential. */
export function isSecretName(name: string): boolean {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL|_KEY)$|^(?:.*_)?(?:PAT|PWD)$/i.test(
    name
  )
}

/**
 * Replace anything credential-shaped in free text.
 *
 * Deliberately conservative in one direction only: it is fine to redact a
 * harmless string, it is never fine to emit a live token. Bounded by
 * `maxBytes` because a regex sweep over an unbounded log is a DoS vector.
 */
export function redactText(input: string, maxBytes = 2_000_000): string {
  if (!input) return input
  const text = input.length > maxBytes ? input.slice(0, maxBytes) : input
  let out = text
  for (const { re, label } of SECRET_PATTERNS) {
    out = out.replace(re, (_match, ...rest) => {
      // The named-secret rule keeps the key so the reader still knows WHICH
      // variable was present — only the value is destroyed.
      if (label === 'named-secret' && typeof rest[0] === 'string') return `${rest[0]}=${REDACTED}`
      return REDACTED
    })
  }
  return out
}

/**
 * Redact a config object for display: any key whose NAME looks secret loses its
 * value entirely; every remaining string value is swept for embedded credentials.
 */
export function redactObject<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactText(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = isSecretName(k) && val != null ? REDACTED : walk(val)
      }
      return out
    }
    return v
  }
  return walk(value) as T
}

/**
 * Reduce a failing build's log to a minimal, redacted error signature.
 *
 * This is what may be sent OUTSIDE the Worker (to the Cloudflare documentation
 * MCP), so it is capped hard and stripped of anything host-, path-, or
 * credential-specific that would leak private context into a docs query.
 */
export function errorSignature(logText: string, maxChars = 400): string {
  const lines = logText.split('\n')
  const interesting = lines.filter((l) =>
    /\b(error|failed|failure|fatal|cannot|could not|not found|exited with|ERR_|E[A-Z]{3,})\b/i.test(
      l
    )
  )
  const picked = (interesting.length ? interesting : lines)
    .slice(-6)
    // Drop the leading ISO timestamp: it is noise in a docs query and, at 24
    // characters a line, it crowds the real error text out of the length cap.
    .map((l) => l.replace(/^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/, ''))
  return redactText(
    picked
      .join(' ')
      // URLs first: the path rule below would otherwise eat the "//host/path"
      // half of a URL and leave a mangled "https:/<path>" behind.
      .replace(/https?:\/\/\S+/g, '<url>')
      .replace(/(?:\/[\w.@-]+){2,}/g, '<path>') // absolute paths → placeholder
      .replace(/\s+/g, ' ')
      .trim()
  ).slice(0, maxChars)
}
