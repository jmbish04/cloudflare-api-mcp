import { describe, expect, it } from 'vitest'
import schemaSqlText from '../migrations/0000_init.sql?raw'
import {
  buildMatcher,
  matchPatterns,
  MAX_EXPRESSION_LENGTH,
  similarity,
  validateExpression,
  type PatternRow
} from '../src/lib/patterns'

const pattern = (over: Partial<PatternRow> & { patternId: string }): PatternRow => ({
  title: 'Startup CPU limit',
  explanation: null,
  matchMethod: 'substring',
  matchExpression: 'Script startup exceeded CPU time limit',
  caseSensitive: 0,
  scopeType: 'global',
  scopeValue: null,
  scopeKey: '*',
  severity: 'high',
  rootCause: 'Too much module-scope work',
  resolutionSteps: JSON.stringify(['Defer with dynamic import()']),
  lessonsLearned: null,
  verificationSteps: JSON.stringify(['wrangler check startup']),
  supportingBuildIds: JSON.stringify(['b1']),
  docUrls: JSON.stringify(['https://developers.cloudflare.com/workers/platform/limits/']),
  versionConstraints: null,
  confidence: 0.8,
  status: 'verified',
  supersededBy: null,
  createdBy: 'test',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastVerifiedAt: null,
  occurrenceCount: 0,
  lastMatchedAt: null,
  successCount: 0,
  failureCount: 0,
  revision: 1,
  deletedAt: null,
  ...over
})

describe('validateExpression', () => {
  it('rejects a nested quantifier that can backtrack catastrophically', () => {
    const res = validateExpression('regex', '(a+)+$')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/backtrack/i)
  })

  it('rejects an over-long expression', () => {
    const res = validateExpression('regex', 'a'.repeat(MAX_EXPRESSION_LENGTH + 1))
    expect(res.ok).toBe(false)
  })

  it('rejects an invalid regex', () => {
    expect(validateExpression('regex', '([unclosed').ok).toBe(false)
  })

  it('accepts an ordinary regex and any substring', () => {
    expect(validateExpression('regex', 'error TS\\d{4}:').ok).toBe(true)
    expect(validateExpression('substring', '(a+)+').ok).toBe(true)
  })
})

describe('buildMatcher', () => {
  it('is case-insensitive by default and case-sensitive on request', () => {
    expect(buildMatcher('substring', 'ERROR', false)!('an error here')).toBe(true)
    expect(buildMatcher('substring', 'ERROR', true)!('an error here')).toBe(false)
  })

  it('does not carry lastIndex between lines', () => {
    // A global regex would return false on every other call here.
    const m = buildMatcher('regex', 'err', false)!
    expect([m('err'), m('err'), m('err')]).toEqual([true, true, true])
  })

  it('returns null for an unsafe expression rather than compiling it', () => {
    expect(buildMatcher('regex', '(a+)+', false)).toBeNull()
  })
})

describe('matchPatterns', () => {
  const log = [
    '2026-09-01 Building...',
    '2026-09-01 Error: Script startup exceeded CPU time limit [code: 10021]',
    '2026-09-01 Build failed'
  ].join('\n')

  it('returns evidence and an explicit caveat, never a claim of proof', () => {
    const [m] = matchPatterns(log, [pattern({ patternId: 'p1' })])
    expect(m.pattern_id).toBe('p1')
    expect(m.evidence[0]).toContain('10021')
    expect(m.matchedLineNumbers).toEqual([2])
    expect(m.caveat).toMatch(/not proof/i)
    expect(m.resolution_steps).toEqual(['Defer with dynamic import()'])
  })

  it('returns nothing when the signature is absent', () => {
    expect(matchPatterns('all fine', [pattern({ patternId: 'p1' })])).toHaveLength(0)
  })

  it('is deterministic: severity, then confidence, then id', () => {
    const patterns = [
      pattern({ patternId: 'z', severity: 'medium', confidence: 0.9, matchExpression: 'Build' }),
      pattern({
        patternId: 'a',
        severity: 'critical',
        confidence: 0.1,
        matchExpression: 'Build'
      }),
      pattern({ patternId: 'm', severity: 'medium', confidence: 0.95, matchExpression: 'Build' })
    ]
    const ids = matchPatterns(log, patterns).map((m) => m.pattern_id)
    expect(ids).toEqual(['a', 'm', 'z'])
    expect(matchPatterns(log, [...patterns].reverse()).map((m) => m.pattern_id)).toEqual(ids)
  })

  it('skips a stored pattern whose expression is unsafe instead of running it', () => {
    const bad = pattern({ patternId: 'bad', matchMethod: 'regex', matchExpression: '(a+)+' })
    expect(matchPatterns('aaaaaaaaaaaaaaaaaaaaaaaa!', [bad])).toHaveLength(0)
  })

  it('redacts credentials that appear in the matched evidence', () => {
    const p = pattern({ patternId: 'p', matchExpression: 'auth failed' })
    const withSecret = 'auth failed for ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    expect(matchPatterns(withSecret, [p])[0].evidence[0]).not.toContain('ghp_abcdefghijklmnop')
  })
})

describe('similarity', () => {
  it('scores near-identical expressions high and unrelated ones low', () => {
    expect(
      similarity('Script startup exceeded CPU time limit', 'Script startup exceeded CPU limit')
    ).toBeGreaterThan(0.5)
    expect(similarity('module not found', 'disk quota exceeded')).toBeLessThan(0.2)
  })
})

describe('extractDocUrls', () => {
  it('trims the closing tag the docs MCP wraps links in, and drops assets', async () => {
    const { extractDocUrls } = await import('../src/lib/build-docs')
    const text = [
      '<url>https://developers.cloudflare.com/workers/ci-cd/builds/</url>',
      'https://developers.cloudflare.com/logo.svg',
      'https://developers.cloudflare.com/',
      'https://example.com/not-cloudflare'
    ].join('\n')
    expect(extractDocUrls(text)).toEqual([
      'https://developers.cloudflare.com/workers/ci-cd/builds/'
    ])
  })
})

describe('billing shape of the pattern hot path', () => {
  it('never indexes the columns a log match writes', () => {
    // D1 charges 1000x more per WRITTEN row than per read row, and an index adds
    // a second written row whenever a write touches an indexed column. A log
    // match writes occurrence_count and last_matched_at, so if either ever ends
    // up in an index, every match silently doubles in cost.
    // Asserted on the generated migration SQL — that is what actually reaches D1.
    const indexLines = schemaSqlText
      .split('\n')
      .filter((l) => l.startsWith('CREATE INDEX') || l.startsWith('CREATE UNIQUE INDEX'))
    const patternIndexes = indexLines.filter((l) => l.includes('`build_patterns`'))
    expect(patternIndexes.length).toBeGreaterThan(0)
    for (const line of patternIndexes) {
      expect(line).not.toContain('occurrence_count')
      expect(line).not.toContain('last_matched_at')
    }
  })

  it('keeps every build_patterns index partial on live rows', () => {
    // `WHERE deleted_at IS NULL` keeps soft-deleted patterns out of the index, so
    // they are neither scanned by the hot read nor index-written when deleted.
    for (const line of schemaSqlText.split('\n').filter((l) => l.includes('ON `build_patterns`'))) {
      expect(line).toContain('WHERE deleted_at IS NULL')
    }
  })
})
