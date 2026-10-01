import { describe, expect, it } from 'vitest'
import {
  auditTokens,
  classifyToken,
  idleDays,
  type AuditPolicy,
  type AuditableToken
} from '../src/lib/token-audit'

const NOW = new Date('2026-10-01T00:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

const policy = (over: Partial<AuditPolicy> = {}): AuditPolicy => ({
  retentionDays: 180,
  protectedIds: [],
  referencedIds: [],
  now: NOW,
  ...over
})

const tok = (over: Partial<AuditableToken> = {}): AuditableToken => ({
  id: 't-1',
  name: 'some-worker build token',
  status: 'active',
  last_used_on: daysAgo(300),
  ...over
})

describe('idleDays', () => {
  it('floors whole days and handles a missing or bad timestamp', () => {
    expect(idleDays(daysAgo(10), NOW)).toBe(10)
    expect(idleDays(null, NOW)).toBeNull()
    expect(idleDays('not-a-date', NOW)).toBeNull()
  })
})

describe('classifyToken — protections outrank every heuristic', () => {
  // The audit must never delete the credential it is authenticating with.
  it('protects this server own tokens even when long idle', () => {
    const v = classifyToken(tok({ id: 'mine' }), policy({ protectedIds: ['mine'] }))
    expect(v.verdict).toBe('protected')
    expect(v.protection).toBe('in_use_by_this_server')
  })

  // A real token in the measured set is named "KEEP - wrangler d1 access".
  it('honours a KEEP marker in the name', () => {
    for (const name of [
      'KEEP - wrangler d1 access',
      'do-not-delete ci token',
      'permanent build token'
    ]) {
      const v = classifyToken(tok({ name, last_used_on: daysAgo(900) }), policy())
      expect(v.verdict).toBe('protected')
      expect(v.protection).toBe('keep_marker')
    }
  })

  it('protects a token referenced by a build trigger', () => {
    const v = classifyToken(tok({ id: 'ref' }), policy({ referencedIds: ['ref'] }))
    expect(v.verdict).toBe('protected')
    expect(v.protection).toBe('referenced')
  })

  // A tunnel token authenticates a persistent connection, so a stale last_used_on
  // is not evidence of disuse. Deleting one breaks working infrastructure.
  it('protects credentials whose usage is not tracked by last_used_on', () => {
    for (const name of [
      'Cloudflare Tunnel API Token for hacolby.app',
      'cloudflared edge',
      'dns edit token',
      'origin certificate token'
    ]) {
      const v = classifyToken(tok({ name, last_used_on: daysAgo(999) }), policy())
      expect(v.verdict).toBe('protected')
      expect(v.protection).toBe('untracked_usage')
    }
  })

  // Order matters: both conditions true must resolve to protected, not deleted.
  it('protects when a keep marker and the delete heuristic both apply', () => {
    const v = classifyToken(
      tok({ name: 'KEEP - old build token', last_used_on: daysAgo(900) }),
      policy()
    )
    expect(v.verdict).toBe('protected')
  })
})

describe('classifyToken — what may be deleted', () => {
  it('deletes an expired token', () => {
    const v = classifyToken(
      tok({ name: 'anything', expires_on: daysAgo(1), last_used_on: daysAgo(5) }),
      policy()
    )
    expect(v.verdict).toBe('delete')
    expect(v.reason).toMatch(/Expired/)
  })

  it('deletes a non-active token', () => {
    expect(classifyToken(tok({ name: 'x', status: 'disabled' }), policy()).verdict).toBe('delete')
  })

  it('deletes a generated build token idle past retention', () => {
    const v = classifyToken(tok({ last_used_on: daysAgo(300) }), policy())
    expect(v.verdict).toBe('delete')
    expect(v.reason).toMatch(/Generated build token/)
  })

  it('recognises the dashboard naming pattern', () => {
    const v = classifyToken(
      tok({ name: 'Workers Builds - 2026-08-27 19:23', last_used_on: daysAgo(300) }),
      policy()
    )
    expect(v.verdict).toBe('delete')
  })
})

describe('classifyToken — what must NOT be auto-deleted', () => {
  // The heuristic is only safe for the recognisably generated family. A hand-made
  // token that happens to be idle must go to review, never delete.
  it('sends an idle token with an unrecognised name to review', () => {
    const v = classifyToken(tok({ name: 'hasssio_worker', last_used_on: daysAgo(290) }), policy())
    expect(v.verdict).toBe('review')
    expect(v.reason).toMatch(/not safe to delete automatically/)
  })

  // Never-used is ambiguous: it may have been created moments ago for a build that
  // has not run yet. Deleting it would break a setup in progress.
  it('sends a never-used generated token to review, not delete', () => {
    expect(classifyToken(tok({ last_used_on: null }), policy()).verdict).toBe('review')
  })

  it('keeps a recently used token', () => {
    expect(classifyToken(tok({ last_used_on: daysAgo(3) }), policy()).verdict).toBe('keep')
  })

  it('keeps a generated token inside the retention window', () => {
    expect(classifyToken(tok({ last_used_on: daysAgo(179) }), policy()).verdict).toBe('keep')
  })

  // Boundary: strictly greater than retention, so exactly at the window is kept.
  it('treats the retention boundary as inclusive of keeping', () => {
    expect(classifyToken(tok({ last_used_on: daysAgo(180) }), policy()).verdict).toBe('keep')
    expect(classifyToken(tok({ last_used_on: daysAgo(181) }), policy()).verdict).toBe('delete')
  })
})

describe('auditTokens', () => {
  it('summarises, counts and orders most-idle first', () => {
    const summary = auditTokens(
      [
        tok({ id: 'a', last_used_on: daysAgo(300) }),
        tok({ id: 'b', name: 'KEEP me', last_used_on: daysAgo(400) }),
        tok({ id: 'c', last_used_on: daysAgo(2) }),
        tok({ id: 'd', name: 'mystery', last_used_on: daysAgo(250) })
      ],
      policy()
    )
    expect(summary.total).toBe(4)
    expect(summary.headroom).toBe(46)
    expect(summary.counts).toEqual({ protected: 1, keep: 1, review: 1, delete: 1 })
    expect(summary.reclaimable).toBe(1)
    expect(summary.verdicts[0].idle_days).toBe(400)
  })

  it('reports headroom of zero at the cap without going negative', () => {
    const many = Array.from({ length: 52 }, (_, i) =>
      tok({ id: `t${i}`, last_used_on: daysAgo(1) })
    )
    expect(auditTokens(many, policy()).headroom).toBe(0)
  })
})
