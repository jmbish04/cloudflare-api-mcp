import { describe, expect, it } from 'vitest'
import {
  buildMatcher,
  matchPatterns,
  MAX_EXPRESSION_LENGTH,
  similarity,
  validateExpression,
  type PatternRow
} from '../src/lib/patterns'

const pattern = (over: Partial<PatternRow> & { pattern_id: string }): PatternRow => ({
  title: 'Startup CPU limit',
  explanation: null,
  match_method: 'substring',
  match_expression: 'Script startup exceeded CPU time limit',
  case_sensitive: 0,
  scope_type: 'global',
  scope_value: null,
  severity: 'high',
  root_cause: 'Too much module-scope work',
  resolution_steps: JSON.stringify(['Defer with dynamic import()']),
  lessons_learned: null,
  verification_steps: JSON.stringify(['wrangler check startup']),
  supporting_build_ids: JSON.stringify(['b1']),
  doc_urls: JSON.stringify(['https://developers.cloudflare.com/workers/platform/limits/']),
  version_constraints: null,
  confidence: 0.8,
  status: 'verified',
  superseded_by: null,
  created_by: 'test',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_verified_at: null,
  occurrence_count: 0,
  success_count: 0,
  failure_count: 0,
  revision: 1,
  deleted_at: null,
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
    const [m] = matchPatterns(log, [pattern({ pattern_id: 'p1' })])
    expect(m.pattern_id).toBe('p1')
    expect(m.evidence[0]).toContain('10021')
    expect(m.matchedLineNumbers).toEqual([2])
    expect(m.caveat).toMatch(/not proof/i)
    expect(m.resolution_steps).toEqual(['Defer with dynamic import()'])
  })

  it('returns nothing when the signature is absent', () => {
    expect(matchPatterns('all fine', [pattern({ pattern_id: 'p1' })])).toHaveLength(0)
  })

  it('is deterministic: severity, then confidence, then id', () => {
    const patterns = [
      pattern({ pattern_id: 'z', severity: 'medium', confidence: 0.9, match_expression: 'Build' }),
      pattern({
        pattern_id: 'a',
        severity: 'critical',
        confidence: 0.1,
        match_expression: 'Build'
      }),
      pattern({ pattern_id: 'm', severity: 'medium', confidence: 0.95, match_expression: 'Build' })
    ]
    const ids = matchPatterns(log, patterns).map((m) => m.pattern_id)
    expect(ids).toEqual(['a', 'm', 'z'])
    expect(matchPatterns(log, [...patterns].reverse()).map((m) => m.pattern_id)).toEqual(ids)
  })

  it('skips a stored pattern whose expression is unsafe instead of running it', () => {
    const bad = pattern({ pattern_id: 'bad', match_method: 'regex', match_expression: '(a+)+' })
    expect(matchPatterns('aaaaaaaaaaaaaaaaaaaaaaaa!', [bad])).toHaveLength(0)
  })

  it('redacts credentials that appear in the matched evidence', () => {
    const p = pattern({ pattern_id: 'p', match_expression: 'auth failed' })
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
