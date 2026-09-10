/**
 * Reusable build-failure patterns: matching engine and D1 access (Drizzle).
 *
 * A pattern is a *diagnosis hypothesis*, never a proof. Matching text in a log
 * says the signature is present; it does not establish the root cause, and every
 * result this module produces says so. Nothing here ever executes a suggested
 * fix — resolutions are returned as text for a human or agent to decide on.
 *
 * Patterns hold a redacted signature, supporting build IDs and doc links. They
 * never hold build transcripts.
 *
 * ## Billing
 *
 * `loadApplicablePatterns` runs on every build-log retrieval — it is the hot
 * read — and `recordMatches` is the hot write. Both are shaped for D1's
 * rows-read / rows-written billing; see the comments on each.
 */

import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { buildPatternEvents, buildPatterns } from '../db/schema'
import type { PatternRow } from '../db/schema'
import { redactText } from './redact'

export type { PatternRow }

export type MatchMethod = 'substring' | 'regex'
export type PatternStatus = 'proposed' | 'verified' | 'deprecated'
export type ScopeType = 'global' | 'account' | 'worker' | 'repository' | 'framework' | 'tool'
export type Severity = 'low' | 'medium' | 'high' | 'critical'

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
  const severityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

  const ordered = [...patterns]
    .sort(
      (a, b) =>
        (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) ||
        b.confidence - a.confidence ||
        a.patternId.localeCompare(b.patternId)
    )
    .slice(0, MAX_PATTERNS_EVALUATED)

  const out: PatternMatch[] = []
  for (const p of ordered) {
    const matcher = buildMatcher(
      p.matchMethod as MatchMethod,
      p.matchExpression,
      p.caseSensitive === 1
    )
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
      pattern_id: p.patternId,
      title: p.title,
      severity: p.severity as Severity,
      status: p.status as PatternStatus,
      confidence: p.confidence,
      evidence,
      matchedLineNumbers,
      root_cause: p.rootCause,
      resolution_steps: parseJsonArray(p.resolutionSteps),
      verification_steps: parseJsonArray(p.verificationSteps),
      lessons_learned: p.lessonsLearned,
      version_constraints: p.versionConstraints,
      doc_urls: parseJsonArray(p.docUrls),
      occurrence_count: p.occurrenceCount,
      success_count: p.successCount,
      failure_count: p.failureCount,
      last_verified_at: p.lastVerifiedAt,
      caveat: MATCH_CAVEAT
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Scope selection
// ---------------------------------------------------------------------------

/** The `scope_key` value a scoped pattern is stored under. `'*'` means global. */
export const GLOBAL_SCOPE_KEY = '*'

export function scopeKeyFor(scopeType: string, scopeValue: string | null | undefined): string {
  return scopeType === 'global' || !scopeValue ? GLOBAL_SCOPE_KEY : scopeValue
}

/**
 * Load the patterns applicable to one build. **This is the hot read.**
 *
 * It runs on every build-log retrieval, so its cost is what a busy day actually
 * bills. Two things make it a `SEARCH ... USING INDEX` instead of a full `SCAN`:
 *
 * - **One indexed selector.** Applicability used to be a six-way `OR` across
 *   `scope_type`, which SQLite cannot satisfy from a single index — so this query
 *   read every row in the table. `scope_key` collapses that choice into one
 *   value, making it a single `IN (…)` lookup on `idx_patterns_applicable`.
 * - **A partial index.** `idx_patterns_applicable` is `WHERE deleted_at IS NULL`,
 *   so soft-deleted patterns are not in the index and are never read here.
 *
 * Verify with `pnpm run db:explain`, which fails if this plan degrades to a SCAN.
 */
export async function loadApplicablePatterns(
  db: Db,
  ctx: { accountId?: string; workerName?: string; repository?: string; includeDeprecated?: boolean }
): Promise<PatternRow[]> {
  const keys = [GLOBAL_SCOPE_KEY, ctx.accountId, ctx.workerName, ctx.repository].filter(
    (k): k is string => Boolean(k)
  )

  const where = [isNull(buildPatterns.deletedAt), inArray(buildPatterns.scopeKey, keys)]
  if (!ctx.includeDeprecated) where.push(ne(buildPatterns.status, 'deprecated'))

  return await db
    .select()
    .from(buildPatterns)
    .where(and(...where))
    .limit(MAX_PATTERNS_EVALUATED)
}

/**
 * Record that patterns matched a build.
 *
 * **This is the hot write, and D1 charges 1000x more per written row than per
 * read row**, so it is deliberately one written row per match:
 *
 * - `occurrence_count` and `last_matched_at` are the only columns written, and
 *   **neither is indexed** — an indexed column would add a second written row to
 *   every match.
 * - There is no per-match row in `build_pattern_events`. An earlier version wrote
 *   one, which tripled the cost of the hottest path to record what these two
 *   columns already say — and accumulating per-build match rows is exactly the
 *   log telemetry this Worker does not keep.
 * - The updates go through `db.batch()`: one round trip instead of N.
 */
export async function recordMatches(
  db: Db,
  patternIds: string[],
  at = new Date().toISOString()
): Promise<void> {
  if (!patternIds.length) return
  const statements = patternIds.map((id) =>
    db
      .update(buildPatterns)
      .set({
        occurrenceCount: sql`${buildPatterns.occurrenceCount} + 1`,
        lastMatchedAt: at
      })
      .where(eq(buildPatterns.patternId, id))
  )
  await db.batch(statements as [(typeof statements)[number], ...typeof statements])
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
 *
 * Similarity is textual, so the candidate set cannot be narrowed by an index —
 * this read is bounded instead, and only ever runs on a create, which is an
 * authoring action rather than a hot path.
 */
export async function findLikelyDuplicates(
  db: Db,
  candidate: { title: string; matchExpression: string },
  threshold = 0.6
): Promise<Array<{ pattern_id: string; title: string; score: number; match_expression: string }>> {
  const rows = await db
    .select({
      patternId: buildPatterns.patternId,
      title: buildPatterns.title,
      matchExpression: buildPatterns.matchExpression
    })
    .from(buildPatterns)
    .where(isNull(buildPatterns.deletedAt))
    .limit(DUPLICATE_SCAN_LIMIT)

  return rows
    .map((r) => ({
      pattern_id: r.patternId,
      title: r.title,
      match_expression: r.matchExpression,
      score: Math.max(
        similarity(candidate.matchExpression, r.matchExpression),
        similarity(candidate.title, r.title)
      )
    }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

/** Hard bound on the duplicate-detection read, so a large library cannot surprise the bill. */
export const DUPLICATE_SCAN_LIMIT = 300

/**
 * Append a management event: created / updated / deleted / deprecated /
 * resolved / not_resolved.
 *
 * Deliberately NOT called when a pattern merely matches a log — see
 * `recordMatches`. These are authoring actions and happen rarely.
 */
export async function recordPatternEvent(
  db: Db,
  e: {
    patternId: string
    event: string
    buildUuid?: string
    actor?: string
    notes?: string
    evidence?: string
  }
): Promise<void> {
  await db.insert(buildPatternEvents).values({
    patternId: e.patternId,
    event: e.event,
    buildUuid: e.buildUuid ?? null,
    actor: e.actor ?? null,
    notes: e.notes ? redactText(e.notes).slice(0, 4000) : null,
    evidence: e.evidence ? redactText(e.evidence).slice(0, 4000) : null,
    createdAt: new Date().toISOString()
  })
}

/** Newest-first management history for one pattern (`idx_pattern_events`). */
export async function patternHistory(
  db: Db,
  patternId: string,
  limit = 50
): Promise<Array<Record<string, unknown>>> {
  return await db
    .select({
      event: buildPatternEvents.event,
      build_uuid: buildPatternEvents.buildUuid,
      actor: buildPatternEvents.actor,
      notes: buildPatternEvents.notes,
      evidence: buildPatternEvents.evidence,
      created_at: buildPatternEvents.createdAt
    })
    .from(buildPatternEvents)
    .where(eq(buildPatternEvents.patternId, patternId))
    .orderBy(desc(buildPatternEvents.id))
    .limit(Math.min(limit, 100))
}
