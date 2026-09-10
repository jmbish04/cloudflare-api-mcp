/**
 * Pure query logic for build listing, log assembly and log search.
 *
 * The Cloudflare list-builds endpoint accepts ONLY `page` and `per_page` — no
 * branch/status/commit filter, no date range, no sort. So every filter a caller
 * asks for is applied here, over as many upstream pages as the requested window
 * needs, and the result carries an honest description of the coverage actually
 * achieved. The failure mode this exists to prevent is sorting a single page and
 * reporting it as "the last 30 days".
 *
 * No bindings, no I/O: the caller injects a page fetcher.
 */

import type { Build, BuildLogsPage } from './cf-builds'

export interface BuildFilters {
  /** Inclusive ISO lower bound on `created_on`. Defaults to now-30d upstream. */
  since?: string
  /** Inclusive ISO upper bound on `created_on`. */
  until?: string
  branch?: string
  /** `status` (queued/initializing/running/stopped) or `build_outcome`. */
  status?: string
  /** Full or abbreviated commit sha (prefix match, case-insensitive). */
  commit?: string
}

export interface Coverage {
  /** Upstream pages actually read. */
  pagesFetched: number
  /** Builds examined before filtering. */
  buildsScanned: number
  /** Total builds the account reports for this Worker, when known. */
  totalAvailable?: number
  /**
   * True when scanning stopped before the whole requested window was covered
   * (page budget hit). A caller must not describe a truncated scan as complete.
   */
  truncated: boolean
  /** Oldest `created_on` actually examined — the real floor of this answer. */
  oldestScanned?: string
  windowStart?: string
  windowEnd?: string
  note?: string
}

export const DEFAULT_LOOKBACK_DAYS = 30
/** Upstream max is 200; a smaller page keeps a single tool call responsive. */
export const BUILDS_PAGE_SIZE = 50
/** Hard ceiling on upstream pages per call — no unbounded account-wide scans. */
export const MAX_BUILD_PAGES = 20

export function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString()
}

/** Newest-first by `created_on`; ties broken on build_uuid for a stable order. */
export function compareBuildsNewestFirst(a: Build, b: Build): number {
  const ta = Date.parse(a.created_on ?? '') || 0
  const tb = Date.parse(b.created_on ?? '') || 0
  if (tb !== ta) return tb - ta
  return (b.build_uuid ?? '').localeCompare(a.build_uuid ?? '')
}

export function buildMatchesFilters(build: Build, f: BuildFilters): boolean {
  const created = Date.parse(build.created_on ?? '')
  if (f.since && Number.isFinite(created) && created < Date.parse(f.since)) return false
  if (f.until && Number.isFinite(created) && created > Date.parse(f.until)) return false

  const meta = build.build_trigger_metadata
  if (f.branch && meta?.branch !== f.branch) return false
  if (f.status) {
    const want = f.status.toLowerCase()
    if (
      build.status?.toLowerCase() !== want &&
      (build.build_outcome ?? '').toLowerCase() !== want
    ) {
      return false
    }
  }
  if (f.commit) {
    const sha = (meta?.commit_hash ?? '').toLowerCase()
    if (!sha.startsWith(f.commit.toLowerCase())) return false
  }
  return true
}

export type PageFetcher = (page: number) => Promise<{
  builds: Build[]
  info?: { total_count?: number; total_pages?: number; next_page?: boolean }
}>

/**
 * Scan upstream pages newest-first until the window is covered, the page budget
 * is spent, or the account runs out of builds.
 *
 * Upstream returns builds newest-first, so once a page's OLDEST build predates
 * `since` there is nothing older left to want and scanning stops — that early
 * exit is what keeps a 30-day question from paging through a year of history.
 */
export async function collectBuilds(
  fetchPage: PageFetcher,
  filters: BuildFilters,
  opts: { maxPages?: number; limit?: number; offset?: number } = {}
): Promise<{ builds: Build[]; matchedTotal: number; coverage: Coverage }> {
  const maxPages = Math.min(opts.maxPages ?? MAX_BUILD_PAGES, MAX_BUILD_PAGES)
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 200))
  const offset = Math.max(0, opts.offset ?? 0)

  const matched: Build[] = []
  let pagesFetched = 0
  let buildsScanned = 0
  let totalAvailable: number | undefined
  let oldestScanned: string | undefined
  let exhausted = false
  let windowCovered = false

  for (let page = 1; page <= maxPages; page++) {
    const { builds, info } = await fetchPage(page)
    pagesFetched++
    totalAvailable = info?.total_count ?? totalAvailable
    if (!builds.length) {
      exhausted = true
      break
    }
    buildsScanned += builds.length

    for (const b of builds) {
      if (b.created_on && (!oldestScanned || b.created_on < oldestScanned))
        oldestScanned = b.created_on
      if (buildMatchesFilters(b, filters)) matched.push(b)
    }

    // Upstream order is newest-first: an oldest-on-page older than the window
    // floor means every remaining page is older still.
    if (filters.since && oldestScanned && Date.parse(oldestScanned) < Date.parse(filters.since)) {
      windowCovered = true
      break
    }
    if (info?.next_page === false || (info?.total_pages && page >= info.total_pages)) {
      exhausted = true
      windowCovered = true
      break
    }
  }

  matched.sort(compareBuildsNewestFirst)
  const truncated = !windowCovered && !exhausted

  return {
    builds: matched.slice(offset, offset + limit),
    matchedTotal: matched.length,
    coverage: {
      pagesFetched,
      buildsScanned,
      totalAvailable,
      truncated,
      oldestScanned,
      windowStart: filters.since,
      windowEnd: filters.until,
      note: truncated
        ? `Stopped after the ${maxPages}-page budget; builds older than ${oldestScanned ?? 'the last page scanned'} were NOT examined. Narrow the window or page with offset.`
        : undefined
    }
  }
}

export interface AssembledLog {
  text: string
  lineCount: number
  /** Every upstream page was drained (no `truncated` flag left set). */
  complete: boolean
  cursor: string | null
  events: BuildLogsPage['events']
  pagesFetched: number
  /** Set when the byte cap stopped assembly before the log ended. */
  cappedAtBytes?: number
}

/** Bounded so one enormous build log cannot exhaust the isolate's memory. */
export const MAX_LOG_BYTES = 1_500_000
export const MAX_LOG_PAGES = 20

/**
 * Drain the logs endpoint across pages.
 *
 * The endpoint's `cursor` is a TAIL cursor: replaying the cursor you were just
 * handed returns zero lines. Paging therefore continues only while `truncated`
 * is set AND the page actually produced lines — otherwise a completed build
 * would spin forever on its own final cursor.
 */
export async function assembleLogs(
  fetchPage: (cursor?: string) => Promise<BuildLogsPage>,
  opts: { maxPages?: number; maxBytes?: number } = {}
): Promise<AssembledLog> {
  const maxPages = Math.min(opts.maxPages ?? MAX_LOG_PAGES, MAX_LOG_PAGES)
  const maxBytes = Math.min(opts.maxBytes ?? MAX_LOG_BYTES, MAX_LOG_BYTES)

  const chunks: string[] = []
  let bytes = 0
  let lineCount = 0
  let cursor: string | undefined
  let events: BuildLogsPage['events'] = []
  let pagesFetched = 0
  let complete = true
  let cappedAtBytes: number | undefined

  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(cursor)
    pagesFetched++
    if (res.events.length) events = res.events

    for (const [ts, text] of res.lines) {
      const line = `${new Date(ts).toISOString()} ${text}`
      bytes += line.length + 1
      if (bytes > maxBytes) {
        cappedAtBytes = maxBytes
        complete = false
        break
      }
      chunks.push(line)
      lineCount++
    }

    cursor = res.cursor ?? undefined
    if (cappedAtBytes) break
    // No progress, or upstream says there is nothing more: stop.
    if (!res.truncated || res.lines.length === 0) break
    if (page === maxPages - 1) complete = false
  }

  return {
    text: chunks.join('\n'),
    lineCount,
    complete,
    cursor: cursor ?? null,
    events,
    pagesFetched,
    cappedAtBytes
  }
}

export interface LogMatch {
  lineNumber: number
  line: string
  before: string[]
  after: string[]
}

/**
 * Search assembled log text.
 *
 * `contextLines` and `maxMatches` are both bounded: an unbounded context window
 * over a large log is how a "search" tool accidentally returns the whole log.
 */
export function searchLogText(
  text: string,
  matcher: (line: string) => boolean,
  opts: { contextLines?: number; maxMatches?: number } = {}
): { matches: LogMatch[]; totalMatches: number; capped: boolean } {
  const ctx = Math.max(0, Math.min(opts.contextLines ?? 2, 10))
  const max = Math.max(1, Math.min(opts.maxMatches ?? 25, 200))
  const lines = text.split('\n')
  const matches: LogMatch[] = []
  let total = 0

  for (let i = 0; i < lines.length; i++) {
    if (!matcher(lines[i])) continue
    total++
    if (matches.length < max) {
      matches.push({
        lineNumber: i + 1,
        line: lines[i],
        before: lines.slice(Math.max(0, i - ctx), i),
        after: lines.slice(i + 1, i + 1 + ctx)
      })
    }
  }
  return { matches, totalMatches: total, capped: total > matches.length }
}
