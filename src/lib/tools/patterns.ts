/**
 * Management tools for the reusable build-failure pattern library.
 *
 * The library is the one thing this Worker deliberately remembers. A pattern
 * holds a redacted matching signature, the confirmed cause, the fix, the
 * verification steps and supporting build IDs — never a build transcript and
 * never a credential.
 */

import { and, desc, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import { buildPatternEvents, buildPatterns } from '../../db/schema'
import { assembleLogs } from '../builds-query'
import {
  DUPLICATE_SCAN_LIMIT,
  findLikelyDuplicates,
  loadApplicablePatterns,
  matchPatterns,
  parseJsonArray,
  patternHistory,
  recordPatternEvent,
  scopeKeyFor,
  validateExpression,
  type PatternRow
} from '../patterns'
import { redactText } from '../redact'
import {
  optBool,
  optNumber,
  optString,
  optStringArray,
  requireString,
  S,
  ToolError,
  type ToolContext,
  type ToolDefinition
} from './context'

const CONTRIBUTION_INSTRUCTION =
  'After resolving a previously unknown build failure, submit a reusable pattern containing the observed signature, the confirmed cause, the fix and verification evidence. If an existing pattern helped, record the outcome with build_patterns_record_outcome. Do not mark a fix verified without evidence.'

function present(p: PatternRow) {
  return {
    pattern_id: p.patternId,
    title: p.title,
    explanation: p.explanation,
    match_method: p.matchMethod,
    match_expression: p.matchExpression,
    case_sensitive: p.caseSensitive === 1,
    scope: { type: p.scopeType, value: p.scopeValue },
    severity: p.severity,
    root_cause: p.rootCause,
    resolution_steps: parseJsonArray(p.resolutionSteps),
    lessons_learned: p.lessonsLearned,
    verification_steps: parseJsonArray(p.verificationSteps),
    supporting_build_ids: parseJsonArray(p.supportingBuildIds),
    doc_urls: parseJsonArray(p.docUrls),
    version_constraints: p.versionConstraints,
    confidence: p.confidence,
    status: p.status,
    superseded_by: p.supersededBy,
    created_by: p.createdBy,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    last_verified_at: p.lastVerifiedAt,
    occurrence_count: p.occurrenceCount,
    last_matched_at: p.lastMatchedAt,
    successful_fixes: p.successCount,
    unsuccessful_fixes: p.failureCount,
    revision: p.revision,
    deleted: Boolean(p.deletedAt)
  }
}

async function loadPattern(
  ctx: ToolContext,
  id: string,
  includeDeleted = false
): Promise<PatternRow> {
  // Primary-key lookup: one row read.
  const where = includeDeleted
    ? eq(buildPatterns.patternId, id)
    : and(eq(buildPatterns.patternId, id), isNull(buildPatterns.deletedAt))
  const rows = await ctx.db.select().from(buildPatterns).where(where).limit(1)
  if (!rows[0]) throw new ToolError('pattern_not_found', `No pattern "${id}".`)
  return rows[0]
}

const SCOPES = ['global', 'account', 'worker', 'repository', 'framework', 'tool']
const SEVERITIES = ['low', 'medium', 'high', 'critical']
const STATUSES = ['proposed', 'verified', 'deprecated']

const patternsCreate: ToolDefinition = {
  name: 'build_patterns_create',
  title: 'Create a build failure pattern',
  description: `Store a reusable build-failure pattern so the next agent does not re-derive it. ${CONTRIBUTION_INSTRUCTION} The match expression is validated for safety (bounded length, no catastrophically-backtracking regex shapes) and is stored redacted. Likely duplicates are reported back so you can extend an existing pattern instead. A pattern you have not confirmed against a real build belongs in status "proposed" — do not claim "verified" without supporting build IDs.`,
  inputSchema: S.obj(
    'Create one pattern.',
    {
      title: S.str('Short name for the failure, e.g. "Worker startup CPU limit exceeded (10021)".'),
      match_method: S.str('How to match: "substring" or "regex".', {
        enum: ['substring', 'regex']
      }),
      match_expression: S.str(
        'The signature to look for in build logs. Keep it minimal and non-secret.'
      ),
      explanation: S.str('What this failure is, in plain language.'),
      case_sensitive: S.bool('Case-sensitive matching. Default false.'),
      scope_type: S.str('Applicability scope.', { enum: SCOPES }),
      scope_value: S.str(
        'The account id, Worker name, repository, framework or tool this is scoped to.'
      ),
      severity: S.str('Severity.', { enum: SEVERITIES }),
      root_cause: S.str('The confirmed underlying cause — not a restatement of the error text.'),
      resolution_steps: S.strArray('Ordered steps that fix it.'),
      verification_steps: S.strArray('How to prove the fix worked.'),
      lessons_learned: S.str('What the next person should know.'),
      supporting_build_ids: S.strArray(
        'Build UUIDs where this was observed. Required to create with status "verified".'
      ),
      doc_urls: S.strArray('Supporting documentation URLs.'),
      version_constraints: S.str('Versions this applies to, e.g. "wrangler >= 4.100".'),
      confidence: S.num('0-1 confidence in the diagnosis. Default 0.5.'),
      status: S.str('Lifecycle status. Default "proposed".', { enum: STATUSES }),
      created_by: S.str('Who is submitting this.'),
      allow_duplicate: S.bool('Create even though a similar pattern exists. Default false.')
    },
    ['title', 'match_method', 'match_expression']
  ),
  async handler(args, ctx) {
    const title = requireString(args, 'title')
    const method = requireString(args, 'match_method')
    if (method !== 'substring' && method !== 'regex') {
      throw new ToolError('invalid_argument', 'match_method must be "substring" or "regex".')
    }
    const expression = redactText(requireString(args, 'match_expression'))
    const valid = validateExpression(method, expression)
    if (!valid.ok) throw new ToolError('unsafe_expression', valid.reason)

    const status = optString(args, 'status') ?? 'proposed'
    if (!STATUSES.includes(status))
      throw new ToolError('invalid_argument', `status must be one of ${STATUSES.join(', ')}.`)
    const supporting = optStringArray(args, 'supporting_build_ids') ?? []
    if (status === 'verified' && !supporting.length) {
      throw new ToolError(
        'unverified',
        'A pattern cannot be created with status "verified" and no supporting_build_ids. Verification needs evidence — create it as "proposed", then confirm it with build_patterns_record_outcome.'
      )
    }

    const duplicates = await findLikelyDuplicates(ctx.db, { title, matchExpression: expression })
    if (duplicates.length && !optBool(args, 'allow_duplicate')) {
      return {
        created: false,
        reason: 'likely_duplicate',
        message:
          'A similar pattern already exists. Extend it with build_patterns_update (adding your build id and lessons) rather than creating a near-duplicate, or re-run with allow_duplicate=true.',
        candidates: duplicates
      }
    }

    const now = new Date().toISOString()
    const id = `bp_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
    const scopeType = optString(args, 'scope_type') ?? 'global'
    if (!SCOPES.includes(scopeType))
      throw new ToolError('invalid_argument', `scope_type must be one of ${SCOPES.join(', ')}.`)
    const severity = optString(args, 'severity') ?? 'medium'
    if (!SEVERITIES.includes(severity))
      throw new ToolError('invalid_argument', `severity must be one of ${SEVERITIES.join(', ')}.`)

    await ctx.db.insert(buildPatterns).values({
      patternId: id,
      title,
      explanation: optString(args, 'explanation') ?? null,
      matchMethod: method,
      matchExpression: expression,
      caseSensitive: optBool(args, 'case_sensitive') ? 1 : 0,
      scopeType,
      scopeValue: optString(args, 'scope_value') ?? null,
      // The indexed selector the hot read filters on. Everything else about
      // scope is descriptive; this is the one column an index can use.
      scopeKey: scopeKeyFor(scopeType, optString(args, 'scope_value')),
      severity,
      rootCause: optString(args, 'root_cause') ?? null,
      resolutionSteps: JSON.stringify(optStringArray(args, 'resolution_steps') ?? []),
      lessonsLearned: optString(args, 'lessons_learned') ?? null,
      verificationSteps: JSON.stringify(optStringArray(args, 'verification_steps') ?? []),
      supportingBuildIds: JSON.stringify(supporting),
      docUrls: JSON.stringify(optStringArray(args, 'doc_urls') ?? []),
      versionConstraints: optString(args, 'version_constraints') ?? null,
      confidence: Math.max(0, Math.min(optNumber(args, 'confidence') ?? 0.5, 1)),
      status,
      createdBy: optString(args, 'created_by') ?? ctx.actor,
      createdAt: now,
      updatedAt: now
    })

    await recordPatternEvent(ctx.db, {
      patternId: id,
      event: 'created',
      actor: ctx.actor,
      notes: `status=${status}`
    })
    return {
      created: true,
      pattern: present(await loadPattern(ctx, id)),
      duplicates_ignored: duplicates
    }
  }
}

const patternsGet: ToolDefinition = {
  name: 'build_patterns_get',
  title: 'Get a build failure pattern',
  description: 'Read one stored pattern by id, with its full management history.',
  inputSchema: S.obj(
    'Read one pattern.',
    {
      pattern_id: S.str('The pattern id.'),
      include_history: S.bool(
        'Include the audit trail of changes and recorded outcomes. Default true.'
      )
    },
    ['pattern_id']
  ),
  async handler(args, ctx) {
    const row = await loadPattern(ctx, requireString(args, 'pattern_id'), true)
    const history =
      (optBool(args, 'include_history') ?? true)
        ? await patternHistory(ctx.db, row.patternId)
        : undefined
    return { pattern: present(row), history }
  }
}

const patternsList: ToolDefinition = {
  name: 'build_patterns_list',
  title: 'List or search build failure patterns',
  description:
    'List stored patterns, optionally filtered by free-text query, scope, severity or status. Soft-deleted patterns are hidden unless asked for.',
  inputSchema: S.obj(
    'List or search patterns.',
    {
      query: S.str(
        'Free text matched against title, explanation, root cause and match expression.'
      ),
      scope_type: S.str('Filter by scope type.', { enum: SCOPES }),
      scope_value: S.str('Filter by scope value.'),
      severity: S.str('Filter by severity.', { enum: SEVERITIES }),
      status: S.str('Filter by status.', { enum: STATUSES }),
      include_deleted: S.bool('Include soft-deleted patterns. Default false.'),
      limit: S.num('Max rows. Default 25, cap 100.'),
      offset: S.num('Offset for paging.')
    },
    []
  ),
  async handler(args, ctx) {
    const where: SQL[] = []
    if (!optBool(args, 'include_deleted')) where.push(isNull(buildPatterns.deletedAt))
    for (const [col, key] of [
      [buildPatterns.scopeType, 'scope_type'],
      [buildPatterns.scopeValue, 'scope_value'],
      [buildPatterns.severity, 'severity'],
      [buildPatterns.status, 'status']
    ] as const) {
      const v = optString(args, key)
      if (v) where.push(eq(col, v))
    }

    const q = optString(args, 'query')
    if (q) {
      // A leading-wildcard LIKE cannot use a B-tree index, so this branch is a
      // scan by construction — hence the hard row cap below. The pattern library
      // is an authored, bounded set (hundreds, not millions); if it ever grows
      // enough for this to matter, the fix is FTS5, which trades write cost for
      // read cost and should be measured before adopting.
      const needle = `%${q}%`
      where.push(
        or(
          like(buildPatterns.title, needle),
          like(buildPatterns.explanation, needle),
          like(buildPatterns.rootCause, needle),
          like(buildPatterns.matchExpression, needle)
        ) as SQL
      )
    }

    const limit = Math.max(1, Math.min(optNumber(args, 'limit') ?? 25, 100))
    const offset = Math.max(0, optNumber(args, 'offset') ?? 0)
    const predicate = where.length ? and(...where) : undefined

    // ONE query, not two. A separate `SELECT COUNT(*)` would repeat the same
    // scan and double the rows billed for a single listing; `COUNT(*) OVER ()`
    // carries the total on each returned row instead.
    const rows = await ctx.db
      .select({ pattern: buildPatterns, total: sql<number>`COUNT(*) OVER ()`.as('total') })
      .from(buildPatterns)
      .where(predicate)
      .orderBy(
        buildPatterns.severity,
        desc(buildPatterns.confidence),
        desc(buildPatterns.updatedAt)
      )
      .limit(limit)
      .offset(offset)

    const total = rows[0]?.total ?? 0
    const patterns = rows.map((r) => r.pattern)

    return {
      patterns: patterns.map(present),
      returned: patterns.length,
      total,
      scan_note: q
        ? `Free-text search cannot use an index (leading wildcard), so this read scanned live patterns up to the cap. ${DUPLICATE_SCAN_LIMIT} is the same ceiling used for duplicate detection.`
        : undefined,
      next_offset: offset + patterns.length < total ? offset + patterns.length : null
    }
  }
}

const patternsUpdate: ToolDefinition = {
  name: 'build_patterns_update',
  title: 'Update a build failure pattern',
  description:
    "Update a stored pattern. Requires the current revision number — a mismatch is rejected rather than overwriting a concurrent edit. Every change is recorded in the pattern's history. Use supersedes/status to deprecate a stale pattern in favour of a newer one; verifying a pattern requires supporting build IDs.",
  inputSchema: S.obj(
    'Update one pattern.',
    {
      pattern_id: S.str('The pattern id.'),
      revision: S.num('The revision you read. The update is rejected if it has moved on.'),
      title: S.str('New title.'),
      explanation: S.str('New explanation.'),
      match_method: S.str('New match method.', { enum: ['substring', 'regex'] }),
      match_expression: S.str('New match expression (validated for safety).'),
      case_sensitive: S.bool('New case sensitivity.'),
      scope_type: S.str('New scope type.', { enum: SCOPES }),
      scope_value: S.str('New scope value.'),
      severity: S.str('New severity.', { enum: SEVERITIES }),
      root_cause: S.str('New root cause.'),
      resolution_steps: S.strArray('New resolution steps.'),
      verification_steps: S.strArray('New verification steps.'),
      lessons_learned: S.str('New lessons learned.'),
      supporting_build_ids: S.strArray('New supporting build ids.'),
      doc_urls: S.strArray('New documentation urls.'),
      version_constraints: S.str('New version constraints.'),
      confidence: S.num('New confidence, 0-1.'),
      status: S.str('New status.', { enum: STATUSES }),
      superseded_by: S.str('Pattern id that replaces this one (use with status "deprecated").'),
      notes: S.str('Why this change was made. Recorded in the history.')
    },
    ['pattern_id', 'revision']
  ),
  async handler(args, ctx) {
    const id = requireString(args, 'pattern_id')
    const revision = optNumber(args, 'revision')
    if (revision === undefined) throw new ToolError('invalid_argument', '"revision" is required.')
    const current = await loadPattern(ctx, id)

    const set: Record<string, unknown> = {}

    const method = (optString(args, 'match_method') ?? current.matchMethod) as 'substring' | 'regex'
    if ('match_expression' in args || 'match_method' in args) {
      const expr = redactText(optString(args, 'match_expression') ?? current.matchExpression)
      const valid = validateExpression(method, expr)
      if (!valid.ok) throw new ToolError('unsafe_expression', valid.reason)
      set.matchExpression = expr
      set.matchMethod = method
    }

    const textFields = [
      ['title', 'title'],
      ['explanation', 'explanation'],
      ['scope_type', 'scopeType'],
      ['scope_value', 'scopeValue'],
      ['severity', 'severity'],
      ['root_cause', 'rootCause'],
      ['lessons_learned', 'lessonsLearned'],
      ['version_constraints', 'versionConstraints'],
      ['superseded_by', 'supersededBy']
    ] as const
    for (const [arg, col] of textFields) {
      const v = optString(args, arg)
      if (v !== undefined) set[col] = v
    }
    // scope_key is derived, never supplied: it must stay consistent with the
    // scope fields or the indexed hot read would silently stop finding this row.
    if ('scope_type' in args || 'scope_value' in args) {
      set.scopeKey = scopeKeyFor(
        (set.scopeType as string) ?? current.scopeType,
        (set.scopeValue as string) ?? current.scopeValue
      )
    }

    const jsonFields = [
      ['resolution_steps', 'resolutionSteps'],
      ['verification_steps', 'verificationSteps'],
      ['supporting_build_ids', 'supportingBuildIds'],
      ['doc_urls', 'docUrls']
    ] as const
    for (const [arg, col] of jsonFields) {
      const v = optStringArray(args, arg)
      if (v) set[col] = JSON.stringify(v)
    }

    if ('case_sensitive' in args) set.caseSensitive = optBool(args, 'case_sensitive') ? 1 : 0
    const confidence = optNumber(args, 'confidence')
    if (confidence !== undefined) set.confidence = Math.max(0, Math.min(confidence, 1))

    const status = optString(args, 'status')
    if (status) {
      if (!STATUSES.includes(status)) {
        throw new ToolError('invalid_argument', `status must be one of ${STATUSES.join(', ')}.`)
      }
      const supporting =
        optStringArray(args, 'supporting_build_ids') ?? parseJsonArray(current.supportingBuildIds)
      if (status === 'verified' && !supporting.length) {
        throw new ToolError(
          'unverified',
          'A pattern cannot be marked "verified" without supporting build IDs. Record a successful resolution with build_patterns_record_outcome instead.'
        )
      }
      set.status = status
      if (status === 'verified') set.lastVerifiedAt = new Date().toISOString()
    }

    if (!Object.keys(set).length) {
      return { updated: false, message: 'No fields to update.', pattern: present(current) }
    }

    set.updatedAt = new Date().toISOString()
    set.revision = sql`${buildPatterns.revision} + 1`

    // The `revision = ?` predicate is the concurrency guard: a caller working
    // from a stale read loses instead of clobbering a concurrent edit.
    const res = await ctx.db
      .update(buildPatterns)
      .set(set)
      .where(
        and(
          eq(buildPatterns.patternId, id),
          eq(buildPatterns.revision, revision),
          isNull(buildPatterns.deletedAt)
        )
      )

    if (!(res.meta?.changes ?? 0)) {
      throw new ToolError(
        'revision_conflict',
        `Pattern "${id}" is at revision ${current.revision}, not ${revision} — someone else changed it. Re-read it with build_patterns_get and retry.`,
        { current_revision: current.revision }
      )
    }
    await recordPatternEvent(ctx.db, {
      patternId: id,
      event: 'updated',
      actor: ctx.actor,
      notes: optString(args, 'notes') ?? `fields: ${Object.keys(set).join(', ')}`
    })
    return { updated: true, pattern: present(await loadPattern(ctx, id)) }
  }
}

const patternsDelete: ToolDefinition = {
  name: 'build_patterns_delete',
  title: 'Delete a build failure pattern',
  description:
    'Soft-delete a pattern: it stops matching and stops being listed, but the record and its history are kept. Prefer deprecating with build_patterns_update (status "deprecated", superseded_by) when a pattern is merely stale rather than wrong. Hard deletion requires an explicit flag and is irreversible.',
  inputSchema: S.obj(
    'Delete one pattern.',
    {
      pattern_id: S.str('The pattern id.'),
      reason: S.str('Why it is being removed. Recorded in the history.'),
      hard: S.bool('Permanently remove the row and its history. Irreversible. Default false.')
    },
    ['pattern_id']
  ),
  async handler(args, ctx) {
    const id = requireString(args, 'pattern_id')
    await loadPattern(ctx, id, true)
    if (optBool(args, 'hard')) {
      await ctx.db.delete(buildPatternEvents).where(eq(buildPatternEvents.patternId, id))
      await ctx.db.delete(buildPatterns).where(eq(buildPatterns.patternId, id))
      return { deleted: true, mode: 'hard', pattern_id: id }
    }
    // Soft delete. The partial indexes are `WHERE deleted_at IS NULL`, so this
    // also REMOVES the row from both of them: it stops being read by the hot
    // query and stops costing index writes.
    await ctx.db
      .update(buildPatterns)
      .set({ deletedAt: new Date().toISOString(), revision: sql`${buildPatterns.revision} + 1` })
      .where(eq(buildPatterns.patternId, id))
    await recordPatternEvent(ctx.db, {
      patternId: id,
      event: 'deleted',
      actor: ctx.actor,
      notes: optString(args, 'reason')
    })
    return {
      deleted: true,
      mode: 'soft',
      pattern_id: id,
      note: 'The record and its history are retained.'
    }
  }
}

const patternsTest: ToolDefinition = {
  name: 'build_patterns_test',
  title: 'Test a pattern against a build',
  description:
    "Check whether a pattern matches a real build's log before committing to it. Accepts either a stored pattern_id or a proposed match_method/match_expression. The log is fetched live and matched in memory; nothing is stored and no counters move.",
  inputSchema: S.obj(
    'Test one pattern against one build.',
    {
      build_uuid: S.str('Build to test against.'),
      pattern_id: S.str('An existing pattern to test.'),
      match_method: S.str('Proposed match method.', { enum: ['substring', 'regex'] }),
      match_expression: S.str('Proposed match expression.'),
      case_sensitive: S.bool('Case-sensitive matching. Default false.')
    },
    ['build_uuid']
  ),
  async handler(args, ctx) {
    const buildUuid = requireString(args, 'build_uuid')
    const log = await assembleLogs((cursor) => ctx.cf.getBuildLogsPage(buildUuid, cursor))
    if (!log.lineCount) {
      return {
        build_uuid: buildUuid,
        matched: false,
        message: 'Cloudflare returned no log lines for this build.'
      }
    }
    const text = redactText(log.text)

    const patternId = optString(args, 'pattern_id')
    const expression = optString(args, 'match_expression')
    if (!patternId && !expression) {
      throw new ToolError('invalid_argument', 'Supply either pattern_id or match_expression.')
    }

    const candidate: PatternRow = patternId
      ? await loadPattern(ctx, patternId)
      : {
          patternId: '(proposed)',
          title: '(proposed)',
          explanation: null,
          matchMethod: optString(args, 'match_method') ?? 'substring',
          matchExpression: expression as string,
          caseSensitive: optBool(args, 'case_sensitive') ? 1 : 0,
          scopeType: 'global',
          scopeValue: null,
          scopeKey: '*',
          severity: 'medium',
          rootCause: null,
          resolutionSteps: null,
          lessonsLearned: null,
          verificationSteps: null,
          supportingBuildIds: null,
          docUrls: null,
          versionConstraints: null,
          confidence: 0.5,
          status: 'proposed',
          supersededBy: null,
          createdBy: null,
          createdAt: '',
          updatedAt: '',
          lastVerifiedAt: null,
          occurrenceCount: 0,
          lastMatchedAt: null,
          successCount: 0,
          failureCount: 0,
          revision: 0,
          deletedAt: null
        }

    const valid = validateExpression(
      candidate.matchMethod as 'substring' | 'regex',
      candidate.matchExpression
    )
    if (!valid.ok) throw new ToolError('unsafe_expression', valid.reason)

    const [match] = matchPatterns(text, [candidate], { maxEvidencePerPattern: 5 })
    return {
      build_uuid: buildUuid,
      log_complete: log.complete,
      log_lines: log.lineCount,
      matched: Boolean(match),
      match: match ?? null,
      message: match
        ? 'The signature is present in this build log. That is evidence, not proof of the root cause.'
        : 'The signature does not appear in this build log.',
      note: 'Nothing was stored and no occurrence counters were changed by this test.'
    }
  }
}

const patternsRecordOutcome: ToolDefinition = {
  name: 'build_patterns_record_outcome',
  title: 'Record whether a pattern resolved a failure',
  description: `Record that a stored pattern's fix did or did not resolve a build failure. ${CONTRIBUTION_INSTRUCTION} Marking a pattern verified requires evidence — a build UUID plus what you observed — and evidence is what moves it from "proposed" to "verified".`,
  inputSchema: S.obj(
    'Record a resolution outcome.',
    {
      pattern_id: S.str('The pattern that was applied.'),
      resolved: S.bool("True if the pattern's fix resolved the failure, false if it did not."),
      build_uuid: S.str('The build this outcome relates to. Required to mark a pattern verified.'),
      evidence: S.str(
        'What you observed that proves the outcome, e.g. the subsequent build succeeded.'
      ),
      notes: S.str('Anything the next person should know.'),
      mark_verified: S.bool(
        'Promote a "proposed" pattern to "verified". Requires resolved=true, build_uuid and evidence.'
      )
    },
    ['pattern_id', 'resolved']
  ),
  async handler(args, ctx) {
    const id = requireString(args, 'pattern_id')
    const resolved = optBool(args, 'resolved')
    if (resolved === undefined) throw new ToolError('invalid_argument', '"resolved" is required.')
    const pattern = await loadPattern(ctx, id)
    const buildUuid = optString(args, 'build_uuid')
    const evidence = optString(args, 'evidence')
    const markVerified = optBool(args, 'mark_verified') ?? false

    if (markVerified && (!resolved || !buildUuid || !evidence)) {
      throw new ToolError(
        'unverified',
        'mark_verified requires resolved=true, a build_uuid and evidence. A fix is not verified because someone asserted it was.'
      )
    }

    const supporting = parseJsonArray(pattern.supportingBuildIds)
    if (buildUuid && !supporting.includes(buildUuid)) supporting.push(buildUuid)

    const now = new Date().toISOString()
    await ctx.db
      .update(buildPatterns)
      .set({
        successCount: sql`${buildPatterns.successCount} + ${resolved ? 1 : 0}`,
        failureCount: sql`${buildPatterns.failureCount} + ${resolved ? 0 : 1}`,
        supportingBuildIds: JSON.stringify(supporting),
        status: markVerified ? 'verified' : pattern.status,
        lastVerifiedAt: markVerified ? now : pattern.lastVerifiedAt,
        // Nudge confidence toward the observed outcome, bounded — never a jump to 1.
        confidence: Math.max(0.05, Math.min(pattern.confidence + (resolved ? 0.1 : -0.15), 0.95)),
        updatedAt: now,
        revision: sql`${buildPatterns.revision} + 1`
      })
      .where(eq(buildPatterns.patternId, id))

    await recordPatternEvent(ctx.db, {
      patternId: id,
      event: resolved ? 'resolved' : 'not_resolved',
      buildUuid,
      actor: ctx.actor,
      notes: optString(args, 'notes'),
      evidence
    })

    return { recorded: true, pattern: present(await loadPattern(ctx, id)) }
  }
}

const patternsMatch: ToolDefinition = {
  name: 'build_patterns_match',
  title: 'Match stored patterns against text',
  description:
    'Run the stored pattern library against a block of log text you already have, without fetching anything. Deterministic; returns the same evidence and caveats as build log retrieval.',
  inputSchema: S.obj(
    'Match patterns against supplied text.',
    {
      log_text: S.str('The log text to match against. Bounded; redacted before matching.'),
      worker_name: S.str('Scope worker-specific patterns to this Worker.'),
      repository: S.str('Scope repository-specific patterns to this repository.')
    },
    ['log_text']
  ),
  async handler(args, ctx) {
    const text = redactText(requireString(args, 'log_text').slice(0, 500_000))
    const patterns = await loadApplicablePatterns(ctx.db, {
      accountId: ctx.accountId,
      workerName: optString(args, 'worker_name'),
      repository: optString(args, 'repository')
    })
    const matches = matchPatterns(text, patterns)
    return {
      matches,
      patterns_evaluated: patterns.length,
      pattern_submission_hint: matches.length ? undefined : CONTRIBUTION_INSTRUCTION,
      note: 'Nothing was stored. Occurrence counters are only advanced when a pattern matches a real build log fetched by this server.'
    }
  }
}

export const patternTools: ToolDefinition[] = [
  patternsCreate,
  patternsGet,
  patternsList,
  patternsUpdate,
  patternsDelete,
  patternsTest,
  patternsRecordOutcome,
  patternsMatch
]
