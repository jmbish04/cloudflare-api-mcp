/**
 * Reusable build-failure patterns: matching engine and D1 access.
 *
 * A pattern is a *diagnosis hypothesis*, never a proof. Matching text in a log
 * says the signature is present; it does not establish the root cause, and every
 * result this module produces says so. Nothing here ever executes a suggested
 * fix — resolutions are returned as text for a human or agent to decide on.
 *
 * Patterns hold a redacted signature, supporting build IDs and doc links. They
 * never hold build transcripts.
 */

import { redactText } from './redact'

export type MatchMethod = 'substring' | 'regex'
export type PatternStatus = 'proposed' | 'verified' | 'deprecated'
export type ScopeType = 'global' | 'account' | 'worker' | 'repository' | 'framework' | 'tool'
export type Severity = 'low' | 'medium' | 'high' | 'critical'

export interface PatternRow {
  pattern_id: string
  title: string
  explanation: string | null
  match_method: MatchMethod
  match_expression: string
  case_sensitive: number
  scope_type: ScopeType
  scope_value: string | null
  severity: Severity
  root_cause: string | null
  resolution_steps: string | null
  lessons_learned: string | null
  verification_steps: string | null
  supporting_build_ids: string | null
  doc_urls: string | null
  version_constraints: string | null
  confidence: number
  status: PatternStatus
  superseded_by: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  last_verified_at: string | null
  occurrence_count: number
  success_count: number
  failure_count: number
  revision: number
  deleted_at: string | null
}

// ---------------------------------------------------------------------------
// Bounded matching
// ---------------------------------------------------------------------------

/** Longest accepted regex source. Long patterns are where backtracking hides. */
export const MAX_EXPRESSION_LENGTH = 300
/** Lines are truncated before matching so one pathological line cannot dominate. */
export const MAX_LINE_LENGTH = 4000
/** Ceiling on lines examined per pattern-match pass. */
export const MAX_LINES_SCANNED = 20_000
/** Ceiling on patterns evaluated against one log. */
export const MAX_PATTERNS_EVALUATED = 200

/**
 * Reject regexes whose shape invites catastrophic backtracking.
 *
 * V8 has no regex timeout, so the only defence available inside a Worker is to
 * refuse the dangerous shapes up front and bound the input. This is a
 * conservative structural check — a quantified group that is itself quantified
 * (`(a+)+`, `(a|aa)*`), plus a hard length cap — not a proof of safety, and it
 * is paired with the input bounds above rather than relied on alone.
 */
export function validateExpression(
  method: MatchMethod,
  expression: string
): { ok: true } | { ok: false; reason: string } {
  if (!expression) return { ok: false, reason: 'match_expression must not be empty' }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, reason: `match_expression exceeds ${MAX_EXPRESSION_LENGTH} characters` }
  }
  if (method === 'substring') return { ok: true }

  // Nested quantifier: a group ending in * + ? or {n,m} that is itself quantified.
  if (/\([^)]*[*+?}][^)]*\)\s*[*+{]/.test(expression)) {
    return {
      ok: false,
      reason:
        'Regex has a quantified group that is itself quantified (e.g. "(a+)+"), which can backtrack catastrophically. Rewrite it or use match_method "substring".'
    }
  }
  if (/\(\?<?[=!]/.test(expression) && expression.length > 120) {
    return {
      ok: false,
      reason: 'Long look-around assertions are not accepted; simplify the pattern.'
    }
  }
  try {
    new RegExp(expression)
  } catch (e) {
    return { ok: false, reason: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true }
}

export function buildMatcher(
  method: MatchMethod,
  expression: string,
  caseSensitive: boolean
): ((line: string) => boolean) | null {
  const valid = validateExpression(method, expression)
  if (!valid.ok) return null
  if (method === 'substring') {
    const needle = caseSensitive ? expression : expression.toLowerCase()
    return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle)
  }
  // Non-global regex: `.test` on a global regex carries lastIndex between calls
  // and silently skips matches on alternating lines.
  const re = new RegExp(expression, caseSensitive ? '' : 'i')
  return (line) => re.test(line)
}

export interface PatternMatch {
  pattern_id: string
  title: string
  severity: Severity
  status: PatternStatus
  confidence: number
  /** Redacted excerpts of the lines that matched. Evidence, not proof. */
  evidence: string[]
  matchedLineNumbers: number[]
  root_cause: string | null
  resolution_steps: string[]
  verification_steps: string[]
  lessons_learned: string | null
  version_constraints: string | null
  doc_urls: string[]
  occurrence_count: number
  success_count: number
  failure_count: number
  last_verified_at: string | null
  /** Always present. A text match is evidence of a possible diagnosis only. */
  caveat: string
}

const MATCH_CAVEAT =
  'This pattern matched the log text. That is evidence the signature is present, not proof of the root cause — confirm against the build before acting, and check the version constraints.'

export function parseJsonArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/**
 * Deterministically match patterns against log text.
 *
 * Deterministic and ordered: patterns are evaluated in a fixed order (severity,
 * then confidence, then id) so the same log and the same pattern set always
 * produce the same answer. No inference, no model call.
 */
export function matchPatterns(
  logText: string,
  patterns: PatternRow[],
  opts: { maxEvidencePerPattern?: number } = {}
): PatternMatch[] {
  const maxEvidence = Math.max(1, Math.min(opts.maxEvidencePerPattern ?? 3, 10))
  const lines = logText.split('\n', MAX_LINES_SCANNED).map((l) => l.slice(0, MAX_LINE_LENGTH))
  const severityRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

  const ordered = [...patterns]
    .sort(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] ||
        b.confidence - a.confidence ||
        a.pattern_id.localeCompare(b.pattern_id)
    )
    .slice(0, MAX_PATTERNS_EVALUATED)

  const out: PatternMatch[] = []
  for (const p of ordered) {
    const matcher = buildMatcher(p.match_method, p.match_expression, p.case_sensitive === 1)
    if (!matcher) continue // an unsafe/invalid stored expression is skipped, never run

    const evidence: string[] = []
    const matchedLineNumbers: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (!matcher(lines[i])) continue
      matchedLineNumbers.push(i + 1)
      if (evidence.length < maxEvidence) evidence.push(redactText(lines[i]).slice(0, 500))
      if (matchedLineNumbers.length >= 50) break
    }
    if (!evidence.length) continue

    out.push({
      pattern_id: p.pattern_id,
      title: p.title,
      severity: p.severity,
      status: p.status,
      confidence: p.confidence,
      evidence,
      matchedLineNumbers,
      root_cause: p.root_cause,
      resolution_steps: parseJsonArray(p.resolution_steps),
      verification_steps: parseJsonArray(p.verification_steps),
      lessons_learned: p.lessons_learned,
      version_constraints: p.version_constraints,
      doc_urls: parseJsonArray(p.doc_urls),
      occurrence_count: p.occurrence_count,
      success_count: p.success_count,
      failure_count: p.failure_count,
      last_verified_at: p.last_verified_at,
      caveat: MATCH_CAVEAT
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Scope selection
// ---------------------------------------------------------------------------

/**
 * Load the patterns applicable to one build.
 *
 * Global patterns always apply; scoped ones apply when their `scope_value`
 * matches the build's context. A scoped pattern outranks a global one at the
 * same severity because it was written about exactly this Worker/repo — that is
 * how "global patterns with scoped overrides" is expressed without a second table.
 */
export async function loadApplicablePatterns(
  db: D1Database,
  ctx: { accountId?: string; workerName?: string; repository?: string; includeDeprecated?: boolean }
): Promise<PatternRow[]> {
  const values = [ctx.accountId ?? '', ctx.workerName ?? '', ctx.repository ?? '']
  const statusClause = ctx.includeDeprecated ? '' : " AND status != 'deprecated'"
  const { results } = await db
    .prepare(
      `SELECT * FROM build_patterns
        WHERE deleted_at IS NULL${statusClause}
          AND (scope_type = 'global'
               OR (scope_type = 'account'    AND scope_value = ?)
               OR (scope_type = 'worker'     AND scope_value = ?)
               OR (scope_type = 'repository' AND scope_value = ?)
               OR scope_type IN ('framework','tool'))
        LIMIT ?`
    )
    .bind(...values, MAX_PATTERNS_EVALUATED)
    .all<PatternRow>()
  return results ?? []
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/** Token overlap (Jaccard) between two expressions, for duplicate warnings. */
export function similarity(a: string, b: string): number {
  const norm = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])
  const sa = norm(a)
  const sb = norm(b)
  if (!sa.size || !sb.size) return a.toLowerCase() === b.toLowerCase() ? 1 : 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

/**
 * Warn about likely duplicates before creating a pattern. Advisory only: it
 * returns candidates for the caller to consider, it does not block the write.
 */
export async function findLikelyDuplicates(
  db: D1Database,
  candidate: { title: string; match_expression: string },
  threshold = 0.6
): Promise<Array<{ pattern_id: string; title: string; score: number; match_expression: string }>> {
  const { results } = await db
    .prepare(
      'SELECT pattern_id, title, match_expression FROM build_patterns WHERE deleted_at IS NULL LIMIT 500'
    )
    .all<{ pattern_id: string; title: string; match_expression: string }>()
  return (results ?? [])
    .map((r) => ({
      ...r,
      score: Math.max(
        similarity(candidate.match_expression, r.match_expression),
        similarity(candidate.title, r.title)
      )
    }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

export async function recordPatternEvent(
  db: D1Database,
  e: {
    patternId: string
    event: string
    buildUuid?: string
    actor?: string
    notes?: string
    evidence?: string
  }
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO build_pattern_events (pattern_id, event, build_uuid, actor, notes, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      e.patternId,
      e.event,
      e.buildUuid ?? null,
      e.actor ?? null,
      e.notes ? redactText(e.notes).slice(0, 4000) : null,
      e.evidence ? redactText(e.evidence).slice(0, 4000) : null,
      new Date().toISOString()
    )
    .run()
}
