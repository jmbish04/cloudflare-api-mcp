import { describe, expect, it } from 'vitest'
import {
  assembleLogs,
  buildMatchesFilters,
  collectBuilds,
  compareBuildsNewestFirst,
  isoDaysAgo,
  searchLogText
} from '../src/lib/builds-query'
import type { Build, BuildLogsPage } from '../src/lib/cf-builds'

const build = (over: Partial<Build> & { build_uuid: string }): Build => ({
  status: 'stopped',
  build_outcome: 'success',
  created_on: '2026-09-01T00:00:00.000Z',
  build_trigger_metadata: { branch: 'main', commit_hash: 'abc123def456' },
  ...over
})

describe('build ordering and filtering', () => {
  it('orders newest first by created_on', () => {
    const list = [
      build({ build_uuid: 'old', created_on: '2026-08-01T00:00:00.000Z' }),
      build({ build_uuid: 'new', created_on: '2026-09-05T00:00:00.000Z' }),
      build({ build_uuid: 'mid', created_on: '2026-09-01T00:00:00.000Z' })
    ]
    expect([...list].sort(compareBuildsNewestFirst).map((b) => b.build_uuid)).toEqual([
      'new',
      'mid',
      'old'
    ])
  })

  it('matches status against either status or build_outcome', () => {
    const b = build({ build_uuid: 'x', status: 'stopped', build_outcome: 'fail' })
    expect(buildMatchesFilters(b, { status: 'fail' })).toBe(true)
    expect(buildMatchesFilters(b, { status: 'stopped' })).toBe(true)
    expect(buildMatchesFilters(b, { status: 'success' })).toBe(false)
  })

  it('matches a commit by prefix, case-insensitively', () => {
    const b = build({ build_uuid: 'x' })
    expect(buildMatchesFilters(b, { commit: 'ABC123' })).toBe(true)
    expect(buildMatchesFilters(b, { commit: 'zzz' })).toBe(false)
  })

  it('excludes builds outside the window', () => {
    const b = build({ build_uuid: 'x', created_on: '2026-01-01T00:00:00.000Z' })
    expect(
      buildMatchesFilters(b, { since: isoDaysAgo(30, Date.parse('2026-09-10T00:00:00Z')) })
    ).toBe(false)
  })
})

describe('collectBuilds coverage honesty', () => {
  it('stops early once a page predates the window and reports full coverage', async () => {
    const pages: Build[][] = [
      [build({ build_uuid: 'a', created_on: '2026-09-09T00:00:00.000Z' })],
      [build({ build_uuid: 'b', created_on: '2026-09-08T00:00:00.000Z' })],
      // Older than the window floor — scanning must stop here.
      [build({ build_uuid: 'c', created_on: '2026-01-01T00:00:00.000Z' })],
      [build({ build_uuid: 'd', created_on: '2025-12-01T00:00:00.000Z' })]
    ]
    const res = await collectBuilds(
      async (page) => ({ builds: pages[page - 1] ?? [], info: { total_count: 4 } }),
      { since: '2026-09-01T00:00:00.000Z' }
    )
    expect(res.coverage.pagesFetched).toBe(3)
    expect(res.coverage.truncated).toBe(false)
    expect(res.builds.map((b) => b.build_uuid)).toEqual(['a', 'b'])
  })

  it('reports truncated=true when the page budget is spent before the window is covered', async () => {
    // Every page is inside the window, so the scan can never reach the floor.
    const res = await collectBuilds(
      async () => ({
        builds: [
          build({ build_uuid: crypto.randomUUID(), created_on: '2026-09-09T00:00:00.000Z' })
        ],
        info: { total_count: 9999, next_page: true }
      }),
      { since: '2026-09-01T00:00:00.000Z' },
      { maxPages: 3 }
    )
    expect(res.coverage.pagesFetched).toBe(3)
    expect(res.coverage.truncated).toBe(true)
    expect(res.coverage.note).toMatch(/were NOT examined/)
  })

  it('marks the scan complete when upstream runs out of pages', async () => {
    const res = await collectBuilds(
      async (page) => ({
        builds:
          page === 1 ? [build({ build_uuid: 'a', created_on: '2026-09-09T00:00:00.000Z' })] : [],
        info: { total_count: 1 }
      }),
      { since: '2026-09-01T00:00:00.000Z' }
    )
    expect(res.coverage.truncated).toBe(false)
  })
})

describe('assembleLogs cursor handling', () => {
  const page = (
    lines: Array<[number, string]>,
    cursor: string | null,
    truncated: boolean
  ): BuildLogsPage => ({
    lines,
    cursor,
    truncated,
    events: []
  })

  it('drains multiple pages and reports complete', async () => {
    const pages = [
      page([[1, 'one']], 'c1', true),
      page([[2, 'two']], 'c2', true),
      page([[3, 'three']], 'c3', false)
    ]
    let i = 0
    const res = await assembleLogs(async () => pages[i++])
    expect(res.pagesFetched).toBe(3)
    expect(res.lineCount).toBe(3)
    expect(res.complete).toBe(true)
    expect(res.text).toContain('three')
  })

  it('does not loop forever when a truncated page yields no new lines', async () => {
    // The endpoint's cursor is a TAIL cursor: replaying it returns zero lines.
    // A naive `while (truncated)` loop would spin here.
    let calls = 0
    const res = await assembleLogs(async () => {
      calls++
      return page([], 'same-cursor', true)
    })
    expect(calls).toBe(1)
    expect(res.lineCount).toBe(0)
  })

  it('marks incomplete when the byte cap is hit', async () => {
    const big: Array<[number, string]> = [[1, 'x'.repeat(500)]]
    const res = await assembleLogs(async () => page(big, 'c', true), { maxBytes: 100 })
    expect(res.complete).toBe(false)
    expect(res.cappedAtBytes).toBe(100)
  })
})

describe('searchLogText', () => {
  const text = ['a', 'b', 'ERROR here', 'd', 'e', 'ERROR again', 'g'].join('\n')

  it('returns context lines and honest capping', () => {
    const res = searchLogText(text, (l) => l.includes('ERROR'), { contextLines: 1, maxMatches: 1 })
    expect(res.totalMatches).toBe(2)
    expect(res.matches).toHaveLength(1)
    expect(res.capped).toBe(true)
    expect(res.matches[0].before).toEqual(['b'])
    expect(res.matches[0].after).toEqual(['d'])
    expect(res.matches[0].lineNumber).toBe(3)
  })
})
