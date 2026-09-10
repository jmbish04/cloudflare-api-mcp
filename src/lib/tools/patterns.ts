/**
 * Management tools for the reusable build-failure pattern library.
 *
 * The library is the one thing this Worker deliberately remembers. A pattern
 * holds a redacted matching signature, the confirmed cause, the fix, the
 * verification steps and supporting build IDs — never a build transcript and
 * never a credential.
 */

import { assembleLogs } from '../builds-query'
import {
  findLikelyDuplicates,
  loadApplicablePatterns,
  matchPatterns,
  parseJsonArray,
  recordPatternEvent,
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
    pattern_id: p.pattern_id,
    title: p.title,
    explanation: p.explanation,
    match_method: p.match_method,
    match_expression: p.match_expression,
    case_sensitive: p.case_sensitive === 1,
    scope: { type: p.scope_type, value: p.scope_value },
    severity: p.severity,
    root_cause: p.root_cause,
    resolution_steps: parseJsonArray(p.resolution_steps),
    lessons_learned: p.lessons_learned,
    verification_steps: parseJsonArray(p.verification_steps),
    supporting_build_ids: parseJsonArray(p.supporting_build_ids),
    doc_urls: parseJsonArray(p.doc_urls),
    version_constraints: p.version_constraints,
    confidence: p.confidence,
    status: p.status,
    superseded_by: p.superseded_by,
    created_by: p.created_by,
    created_at: p.created_at,
    updated_at: p.updated_at,
    last_verified_at: p.last_verified_at,
    occurrence_count: p.occurrence_count,
    successful_fixes: p.success_count,
    unsuccessful_fixes: p.failure_count,
    revision: p.revision,
    deleted: Boolean(p.deleted_at)
  }
}

async function loadPattern(
  ctx: ToolContext,
  id: string,
  includeDeleted = false
): Promise<PatternRow> {
  const row = await ctx.db
    .prepare(
      `SELECT * FROM build_patterns WHERE pattern_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`
    )
    .bind(id)
    .first<PatternRow>()
  if (!row) throw new ToolError('pattern_not_found', `No pattern "${id}".`)
  return row
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

    const duplicates = await findLikelyDuplicates(ctx.db, { title, match_expression: expression })
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

    await ctx.db
      .prepare(
        `INSERT INTO build_patterns
           (pattern_id, title, explanation, match_method, match_expression, case_sensitive, scope_type, scope_value,
            severity, root_cause, resolution_steps, lessons_learned, verification_steps, supporting_build_ids,
            doc_urls, version_constraints, confidence, status, created_by, created_at, updated_at,
            last_verified_at, occurrence_count, success_count, failure_count, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 1)`
      )
      .bind(
        id,
        title,
        optString(args, 'explanation') ?? null,
        method,
        expression,
        optBool(args, 'case_sensitive') ? 1 : 0,
        scopeType,
        optString(args, 'scope_value') ?? null,
        severity,
        optString(args, 'root_cause') ?? null,
        JSON.stringify(optStringArray(args, 'resolution_steps') ?? []),
        optString(args, 'lessons_learned') ?? null,
        JSON.stringify(optStringArray(args, 'verification_steps') ?? []),
        JSON.stringify(supporting),
        JSON.stringify(optStringArray(args, 'doc_urls') ?? []),
        optString(args, 'version_constraints') ?? null,
        Math.max(0, Math.min(optNumber(args, 'confidence') ?? 0.5, 1)),
        status,
        optString(args, 'created_by') ?? ctx.actor,
        now,
        now
      )
      .run()

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
        ? (
            await ctx.db
              .prepare(
                'SELECT event, build_uuid, actor, notes, evidence, created_at FROM build_pattern_events WHERE pattern_id = ? ORDER BY id DESC LIMIT 50'
              )
              .bind(row.pattern_id)
              .all<Record<string, unknown>>()
          ).results
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
    const where: string[] = []
    const binds: unknown[] = []
    if (!optBool(args, 'include_deleted')) where.push('deleted_at IS NULL')
    for (const [col, key] of [
      ['scope_type', 'scope_type'],
      ['scope_value', 'scope_value'],
      ['severity', 'severity'],
      ['status', 'status']
    ] as const) {
      const v = optString(args, key)
      if (v) {
        where.push(`${col} = ?`)
        binds.push(v)
      }
    }
    const q = optString(args, 'query')
    if (q) {
      where.push(
        '(title LIKE ? OR explanation LIKE ? OR root_cause LIKE ? OR match_expression LIKE ?)'
      )
      binds.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }
    const limit = Math.max(1, Math.min(optNumber(args, 'limit') ?? 25, 100))
    const offset = Math.max(0, optNumber(args, 'offset') ?? 0)

    const sql = `SELECT * FROM build_patterns${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY severity, confidence DESC, updated_at DESC LIMIT ? OFFSET ?`
    const { results } = await ctx.db
      .prepare(sql)
      .bind(...binds, limit, offset)
      .all<PatternRow>()
    const total = await ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM build_patterns${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
      )
      .bind(...binds)
      .first<{ n: number }>()

    return {
      patterns: (results ?? []).map(present),
      returned: results?.length ?? 0,
      total: total?.n ?? 0,
      next_offset:
        offset + (results?.length ?? 0) < (total?.n ?? 0) ? offset + (results?.length ?? 0) : null
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

    const sets: string[] = []
    const binds: unknown[] = []
    const push = (col: string, value: unknown) => {
      sets.push(`${col} = ?`)
      binds.push(value)
    }

    const method = (optString(args, 'match_method') ?? current.match_method) as
      | 'substring'
      | 'regex'
    if ('match_expression' in args || 'match_method' in args) {
      const expr = redactText(optString(args, 'match_expression') ?? current.match_expression)
      const valid = validateExpression(method, expr)
      if (!valid.ok) throw new ToolError('unsafe_expression', valid.reason)
      push('match_expression', expr)
      push('match_method', method)
    }
    for (const key of [
      'title',
      'explanation',
      'scope_type',
      'scope_value',
      'severity',
      'root_cause',
      'lessons_learned',
      'version_constraints',
      'superseded_by'
    ] as const) {
      const v = optString(args, key)
      if (v !== undefined) push(key, v)
    }
    for (const key of [
      'resolution_steps',
      'verification_steps',
      'supporting_build_ids',
      'doc_urls'
    ] as const) {
      const v = optStringArray(args, key)
      if (v) push(key, JSON.stringify(v))
    }
    if ('case_sensitive' in args) push('case_sensitive', optBool(args, 'case_sensitive') ? 1 : 0)
    const confidence = optNumber(args, 'confidence')
    if (confidence !== undefined) push('confidence', Math.max(0, Math.min(confidence, 1)))

    const status = optString(args, 'status')
    if (status) {
      if (!STATUSES.includes(status))
        throw new ToolError('invalid_argument', `status must be one of ${STATUSES.join(', ')}.`)
      const supporting =
        optStringArray(args, 'supporting_build_ids') ?? parseJsonArray(current.supporting_build_ids)
      if (status === 'verified' && !supporting.length) {
        throw new ToolError(
          'unverified',
          'A pattern cannot be marked "verified" without supporting build IDs. Record a successful resolution with build_patterns_record_outcome instead.'
        )
      }
      push('status', status)
      if (status === 'verified') push('last_verified_at', new Date().toISOString())
    }

    if (!sets.length)
      return { updated: false, message: 'No fields to update.', pattern: present(current) }

    push('updated_at', new Date().toISOString())
    const res = await ctx.db
      .prepare(
        `UPDATE build_patterns SET ${sets.join(', ')}, revision = revision + 1 WHERE pattern_id = ? AND revision = ? AND deleted_at IS NULL`
      )
      .bind(...binds, id, revision)
      .run()

    if (!(res.meta.changes ?? 0)) {
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
      notes: optString(args, 'notes') ?? `fields: ${sets.map((s) => s.split(' ')[0]).join(', ')}`
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
      await ctx.db.prepare('DELETE FROM build_pattern_events WHERE pattern_id = ?').bind(id).run()
      await ctx.db.prepare('DELETE FROM build_patterns WHERE pattern_id = ?').bind(id).run()
      return { deleted: true, mode: 'hard', pattern_id: id }
    }
    await ctx.db
      .prepare(
        'UPDATE build_patterns SET deleted_at = ?, revision = revision + 1 WHERE pattern_id = ?'
      )
      .bind(new Date().toISOString(), id)
      .run()
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
      : ({
          pattern_id: '(proposed)',
          title: '(proposed)',
          explanation: null,
          match_method: (optString(args, 'match_method') ?? 'substring') as 'substring' | 'regex',
          match_expression: expression as string,
          case_sensitive: optBool(args, 'case_sensitive') ? 1 : 0,
          scope_type: 'global',
          scope_value: null,
          severity: 'medium',
          root_cause: null,
          resolution_steps: null,
          lessons_learned: null,
          verification_steps: null,
          supporting_build_ids: null,
          doc_urls: null,
          version_constraints: null,
          confidence: 0.5,
          status: 'proposed',
          superseded_by: null,
          created_by: null,
          created_at: '',
          updated_at: '',
          last_verified_at: null,
          occurrence_count: 0,
          success_count: 0,
          failure_count: 0,
          revision: 0,
          deleted_at: null
        } satisfies PatternRow)

    const valid = validateExpression(candidate.match_method, candidate.match_expression)
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

    const supporting = parseJsonArray(pattern.supporting_build_ids)
    if (buildUuid && !supporting.includes(buildUuid)) supporting.push(buildUuid)

    const now = new Date().toISOString()
    await ctx.db
      .prepare(
        `UPDATE build_patterns
            SET success_count = success_count + ?,
                failure_count = failure_count + ?,
                supporting_build_ids = ?,
                status = ?,
                last_verified_at = ?,
                confidence = ?,
                updated_at = ?,
                revision = revision + 1
          WHERE pattern_id = ?`
      )
      .bind(
        resolved ? 1 : 0,
        resolved ? 0 : 1,
        JSON.stringify(supporting),
        markVerified ? 'verified' : pattern.status,
        markVerified ? now : pattern.last_verified_at,
        // Nudge confidence toward the observed outcome, bounded — never a jump to 1.
        Math.max(0.05, Math.min(pattern.confidence + (resolved ? 0.1 : -0.15), 0.95)),
        now,
        id
      )
      .run()

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
