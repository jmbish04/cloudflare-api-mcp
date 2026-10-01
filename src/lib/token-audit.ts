/**
 * Audit the user API token quota and reclaim only what is provably dead.
 *
 * ## Why this exists
 *
 * User API tokens are capped at **50 per account**. Measured 2026-09-30: 48 in
 * use, and 20 of them unused for 181-365 days. The accumulation is structural —
 * a Workers Builds setup mints a token per Worker — and when the cap is reached
 * the Cloudflare dashboard simply refuses to configure builds, with an error that
 * does not say "you are out of tokens".
 *
 * So the quota needs tending, and tending it is pure bookkeeping: no judgement, no
 * model, just rules over timestamps and references. That is what this is.
 *
 * ## The safety stance: refuse unless provably dead
 *
 * Deleting a live token breaks whatever holds it, silently, until something fails
 * far away. The classifier is therefore built to **protect by default** and only
 * nominate a token for deletion when every signal agrees. Four protections exist
 * because each corresponds to a real token in the measured set:
 *
 * 1. **Human keep-markers.** One token is literally named `KEEP - wrangler d1
 *    access`. A name that says keep is an instruction, and it outranks every
 *    heuristic here.
 * 2. **This server's own credentials.** Deleting the token the audit is
 *    authenticating with would be self-destruction, and deleting the Worker's
 *    build credential would break the thing that fixes builds.
 * 3. **Tokens whose `last_used_on` does not track real use.** A `cloudflared`
 *    tunnel token authenticates a long-lived tunnel, not a stream of API calls, so
 *    a stale `last_used_on` is NOT evidence of disuse. Same for anything named as
 *    infrastructure. These are reported, never nominated.
 * 4. **Anything still referenced.** A token wrapped by a Workers Builds build
 *    token is in use by definition, whatever its timestamps say.
 *
 * What remains nominatable is deliberately narrow: a **recognisably generated**
 * build token, unreferenced, unused past the retention window. That is the class
 * that actually accumulated, and the only one safe to delete without a human
 * looking.
 *
 * Everything else is *reported* with its reason. The audit is useful even when it
 * deletes nothing.
 */

/** A user API token as the list endpoint reports it. */
export interface AuditableToken {
  id: string
  name?: string
  status?: string
  issued_on?: string
  modified_on?: string
  expires_on?: string | null
  last_used_on?: string | null
}

/** What the audit decided about one token, and why. */
export interface TokenVerdict {
  id: string
  name: string
  /** `delete` is only ever set for the narrow provably-dead class. */
  verdict: 'protected' | 'keep' | 'review' | 'delete'
  reason: string
  idle_days: number | null
  /** Which protection applied, when one did. */
  protection?: 'keep_marker' | 'in_use_by_this_server' | 'untracked_usage' | 'referenced'
}

export interface AuditPolicy {
  /** Idle days after which a generated build token becomes nominatable. */
  retentionDays: number
  /** Token ids this server itself depends on. Never nominated. */
  protectedIds: string[]
  /** Cloudflare token ids referenced by a Workers Builds build token. */
  referencedIds: string[]
  /** Now, injected so classification is deterministic in tests. */
  now: Date
}

/** Names that assert "do not delete". Checked case-insensitively. */
const KEEP_MARKERS = [/\bkeep\b/i, /do[\s_-]?not[\s_-]?delete/i, /\bpermanent\b/i, /\bprotected\b/i]

/**
 * Names whose `last_used_on` cannot be trusted as a usage signal.
 *
 * A tunnel or similar long-lived credential authenticates a persistent connection
 * rather than repeated API calls, so an old timestamp means nothing. Treating
 * these as idle would delete working infrastructure.
 */
const UNTRACKED_USAGE = [
  /tunnel/i,
  /cloudflared/i,
  /\bdns\b/i,
  /certificate/i,
  /\borigin\b/i,
  /warp/i,
  /gateway/i
]

/**
 * Names Cloudflare or this ecosystem generates per Worker for builds.
 *
 * Narrow on purpose: this is the ONLY family that may be auto-deleted, so the
 * pattern must not accidentally match a hand-made token. Matches
 * "<worker> build token" and the dashboard's "Workers Builds - <timestamp>".
 */
const GENERATED_BUILD_TOKEN = [/\bbuild token\b/i, /^workers builds\s*-\s*\d/i]

/** Whole days between two instants, floored; null when the timestamp is absent. */
export function idleDays(lastUsedOn: string | null | undefined, now: Date): number | null {
  if (!lastUsedOn) return null
  const then = Date.parse(lastUsedOn)
  if (Number.isNaN(then)) return null
  return Math.floor((now.getTime() - then) / 86_400_000)
}

/**
 * Decide what to do with one token.
 *
 * Evaluation order is the safety property: every protection is checked before any
 * deletion rule can fire, so a token that is both long-idle and keep-marked is
 * protected rather than deleted.
 */
export function classifyToken(token: AuditableToken, policy: AuditPolicy): TokenVerdict {
  const name = token.name ?? '(unnamed)'
  const idle = idleDays(token.last_used_on, policy.now)
  const base = { id: token.id, name, idle_days: idle }

  // --- protections, in order of authority

  if (policy.protectedIds.includes(token.id)) {
    return {
      ...base,
      verdict: 'protected',
      protection: 'in_use_by_this_server',
      reason: 'This server authenticates with this token. Deleting it would break the audit itself.'
    }
  }

  if (KEEP_MARKERS.some((re) => re.test(name))) {
    return {
      ...base,
      verdict: 'protected',
      protection: 'keep_marker',
      reason: `The name asserts it should be kept ("${name}"). A human marker outranks every heuristic here.`
    }
  }

  if (policy.referencedIds.includes(token.id)) {
    return {
      ...base,
      verdict: 'protected',
      protection: 'referenced',
      reason:
        'Referenced by a Workers Builds build token, so it is in use regardless of its timestamps.'
    }
  }

  if (UNTRACKED_USAGE.some((re) => re.test(name))) {
    return {
      ...base,
      verdict: 'protected',
      protection: 'untracked_usage',
      reason:
        `Its name indicates a long-lived credential (tunnel, DNS, certificate) whose ` +
        `last_used_on does not track real use, so ${idle ?? '?'} idle days is not ` +
        `evidence of disuse. Never auto-deleted.`
    }
  }

  // --- provably dead, independent of the idle heuristic

  const expiresOn = token.expires_on ? Date.parse(token.expires_on) : null
  if (expiresOn !== null && !Number.isNaN(expiresOn) && expiresOn < policy.now.getTime()) {
    return {
      ...base,
      verdict: 'delete',
      reason: `Expired on ${token.expires_on} — it cannot authenticate anything any more.`
    }
  }

  const status = (token.status ?? '').toLowerCase()
  if (status && status !== 'active') {
    return {
      ...base,
      verdict: 'delete',
      reason: `Status is "${token.status}", so it is already non-functional.`
    }
  }

  // --- the one heuristic class, and only with every signal agreeing

  const generated = GENERATED_BUILD_TOKEN.some((re) => re.test(name))
  if (generated && idle !== null && idle > policy.retentionDays) {
    return {
      ...base,
      verdict: 'delete',
      reason:
        `Generated build token, unreferenced by any build trigger, and unused for ` +
        `${idle} days (retention ${policy.retentionDays}). This is the family that ` +
        `accumulates one-per-Worker and exhausts the quota.`
    }
  }

  if (generated && idle === null) {
    return {
      ...base,
      verdict: 'review',
      reason:
        'Generated build token that has never been used. Never-used is ambiguous — it ' +
        'may have been made moments ago for a build that has not run — so it is ' +
        'reported rather than deleted.'
    }
  }

  if (idle !== null && idle > policy.retentionDays) {
    return {
      ...base,
      verdict: 'review',
      reason:
        `Unused for ${idle} days, but the name does not identify it as a generated ` +
        `build token, so it is not safe to delete automatically. Decide by hand.`
    }
  }

  return {
    ...base,
    verdict: 'keep',
    reason: idle === null ? 'Never used, but inside policy.' : `Used ${idle} day(s) ago.`
  }
}

/** Audit outcome over the whole token set. */
export interface AuditSummary {
  total: number
  quota: number
  headroom: number
  counts: Record<TokenVerdict['verdict'], number>
  verdicts: TokenVerdict[]
  reclaimable: number
}

/**
 * Classify every token and summarise.
 *
 * Pure — the caller performs any deletion, so an audit can always be run and read
 * without the possibility of it changing anything.
 */
export function auditTokens(
  tokens: AuditableToken[],
  policy: AuditPolicy,
  quota = 50
): AuditSummary {
  const verdicts = tokens.map((t) => classifyToken(t, policy))
  const counts = { protected: 0, keep: 0, review: 0, delete: 0 } as Record<
    TokenVerdict['verdict'],
    number
  >
  for (const v of verdicts) counts[v.verdict]++
  return {
    total: tokens.length,
    quota,
    headroom: Math.max(0, quota - tokens.length),
    counts,
    // Most-idle first: the useful reading order for a human skimming it.
    verdicts: verdicts.sort((a, b) => (b.idle_days ?? -1) - (a.idle_days ?? -1)),
    reclaimable: counts.delete
  }
}
