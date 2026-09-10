/**
 * Workers CI/CD inspection and control tools.
 *
 * Every read is live from the Cloudflare API. D1 stores only what is needed to
 * pause and later restore safely: the pre-pause trigger snapshot, the leases
 * held against the Worker, and an audit trail.
 */

import { and, eq, sql } from 'drizzle-orm'
import { cicdState } from '../../db/schema'
import { CloudflareApiError, type Trigger } from '../cf-builds'
import {
  detectDrift,
  expectedPaused,
  isPausedTrigger,
  mergeConfigPatch,
  pausePatch,
  PAUSE_SENTINEL,
  restorePatch,
  snapshotTrigger,
  type TriggerSnapshot
} from '../cicd-pause'
import {
  acquireLease,
  audit,
  clearSavedConfig,
  getState,
  isExpired,
  listActiveLeases,
  recentAudit,
  releaseAllLeases,
  releaseLease,
  transition,
  type LeaseRow
} from '../cicd-state'
import { GitHubUnavailable, parseRepoRef } from '../github'
import { isSecretName, redactObject } from '../redact'
import {
  optBool,
  optString,
  optStringArray,
  requireString,
  requireWorkerTag,
  S,
  ToolError,
  type ToolContext,
  type ToolDefinition
} from './context'

const PAUSE_MECHANISM_NOTE =
  "A Workers Builds trigger has no enable/disable field (verified against the live API). Pausing narrows every trigger's branch_includes to a sentinel no real branch can match; resuming restores the saved matchers verbatim. branch_excludes is deliberately left alone: Cloudflare rejects excluding every branch with HTTP 400 code 12002. All other trigger fields — build command, deploy command, root directory, build token, repo connection — are left untouched, which is why a restore never needs secret material it cannot read back."
const MANUAL_BUILD_NOTE =
  'This suppresses AUTOMATIC builds (production and preview) because a pushed branch can no longer match a trigger. It is NOT verified to block an explicit manual build via POST /builds/triggers/{uuid}/builds, which names its branch directly.'

function describeLease(l: LeaseRow) {
  return {
    lease_id: l.leaseId,
    owner: l.owner,
    reason: l.reason,
    acquired_at: l.acquiredAt,
    expires_at: l.expiresAt,
    expired: isExpired(l)
  }
}

/** Public view of a trigger: secret-looking values stripped, tokens as references. */
function presentTrigger(t: Trigger) {
  return redactObject({
    trigger_uuid: t.trigger_uuid,
    trigger_name: t.trigger_name,
    build_command: t.build_command ?? null,
    deploy_command: t.deploy_command ?? null,
    root_directory: t.root_directory ?? null,
    branch_includes: t.branch_includes ?? [],
    branch_excludes: t.branch_excludes ?? [],
    path_includes: t.path_includes ?? [],
    path_excludes: t.path_excludes ?? [],
    build_caching_enabled: t.build_caching_enabled ?? null,
    // A REFERENCE, never a credential: the build token's secret is not readable
    // from the API and is never handled by this Worker.
    // Named "_reference" deliberately: this is a uuid + display name, never a
    // credential, and a key ending in "token" would be blanked by redactObject.
    build_token_reference: t.build_token_uuid
      ? { build_token_uuid: t.build_token_uuid, build_token_name: t.build_token_name ?? null }
      : null,
    repository: t.repo_connection
      ? {
          repo_connection_uuid: t.repo_connection.repo_connection_uuid,
          provider: t.repo_connection.provider_type,
          owner: t.repo_connection.provider_account_name,
          repo_name: t.repo_connection.repo_name,
          repo_id: t.repo_connection.repo_id
        }
      : null,
    paused_by_this_server: isPausedTrigger(t),
    created_on: t.created_on,
    modified_on: t.modified_on
  })
}

/** Build variables, names and secret flags only — values are never returned. */
function presentBuildVariables(t: Trigger) {
  const raw = (t as unknown as { environment_variables?: Record<string, unknown> })
    .environment_variables
  if (!raw || typeof raw !== 'object') return []
  return Object.keys(raw).map((name) => ({
    name,
    is_secret: isSecretName(name) || Boolean((raw[name] as { is_secret?: boolean })?.is_secret),
    value: '[not returned]'
  }))
}

async function loadStateAndLeases(ctx: ToolContext, workerName: string) {
  const state = await getState(ctx.db, ctx.accountId, workerName)
  const leases = await listActiveLeases(ctx.db, ctx.accountId, workerName)
  return { state, leases }
}

// ---------------------------------------------------------------------------
// workers_cicd_get
// ---------------------------------------------------------------------------

const cicdGet: ToolDefinition = {
  name: 'workers_cicd_get',
  title: 'Inspect Workers CI/CD configuration',
  description:
    'Read the live Workers Builds (CI/CD) configuration for a Worker by NAME: connected git repository, production branch, trigger UUIDs, build/deploy/preview commands, root directory, branch and path filters, build caching, build-token reference and build-variable names. Also reports the locally recorded pause state, who holds pause leases, and any discrepancy between Cloudflare and what this server recorded. Credential values are never returned. Fetched live on every call; nothing is cached.',
  inputSchema: S.obj(
    'Inspect one Worker.',
    {
      worker_name: S.str('The Worker name (not its tag).'),
      include_audit: S.bool('Include the recent local audit trail for this Worker. Default false.')
    },
    ['worker_name']
  ),
  async handler(args, ctx) {
    const workerName = requireString(args, 'worker_name')
    const workerTag = await requireWorkerTag(ctx, workerName)
    const triggers = await ctx.cf.listTriggers(workerTag)
    const { state, leases } = await loadStateAndLeases(ctx, workerName)

    if (!triggers.length) {
      return {
        worker_name: workerName,
        worker_tag: workerTag,
        configured: false,
        message:
          'Workers Builds is NOT configured for this Worker: it has no build triggers. Use workers_cicd_configure to connect a repository.',
        local_state: state ? { phase: state.phase, revision: state.revision } : null,
        active_leases: leases.map(describeLease)
      }
    }

    // Production vs preview is inferred from the branch matchers: the trigger
    // whose branch_includes names concrete branches is the production one; a
    // wildcard include with the production branch excluded is the preview one.
    const production = triggers.find((t) =>
      (t.branch_includes ?? []).some((b) => b !== '*' && b !== PAUSE_SENTINEL)
    )
    const preview = triggers.find((t) => t !== production)

    const discrepancies: string[] = []
    const remotePaused = triggers.some(isPausedTrigger)
    if (state && state.phase === 'paused' && !remotePaused) {
      discrepancies.push(
        'This server has the Worker recorded as PAUSED, but no trigger carries the pause sentinel remotely — the pause was undone outside this server. Run workers_cicd_reconcile.'
      )
    }
    if ((!state || state.phase === 'active') && remotePaused) {
      discrepancies.push(
        'A trigger carries the pause sentinel remotely, but this server has no pause recorded — restoring it needs the original branch matchers, which were not saved here. Restore them manually or re-pause and resume through this server.'
      )
    }
    if (state && state.workerTag !== workerTag) {
      discrepancies.push(
        `The Worker tag changed (recorded ${state.workerTag}, now ${workerTag}). The Worker was deleted and recreated; any saved configuration belongs to the previous Worker and will NOT be restored.`
      )
    }
    if (state && (state.phase === 'pausing' || state.phase === 'resuming')) {
      discrepancies.push(
        `A ${state.phase} transition was recorded but never completed — a previous call failed part-way. Run workers_cicd_reconcile.`
      )
    }

    return {
      worker_name: workerName,
      worker_tag: workerTag,
      configured: true,
      git_provider:
        production?.repo_connection?.provider_type ??
        preview?.repo_connection?.provider_type ??
        null,
      repository: production?.repo_connection
        ? `${production.repo_connection.provider_account_name}/${production.repo_connection.repo_name}`
        : null,
      production_branch:
        (production?.branch_includes ?? []).find((b) => b !== '*' && b !== PAUSE_SENTINEL) ?? null,
      production_trigger_uuid: production?.trigger_uuid ?? null,
      preview_trigger_uuid: preview?.trigger_uuid ?? null,
      triggers: triggers.map(presentTrigger),
      build_variables: triggers.flatMap((t) =>
        presentBuildVariables(t).map((v) => ({ trigger_uuid: t.trigger_uuid, ...v }))
      ),
      pause: {
        remote_shows_paused: remotePaused,
        local_phase: state?.phase ?? 'active',
        pausedAt: state?.pausedAt ?? null,
        saved_config_present: Boolean(state?.savedConfig),
        active_leases: leases.map(describeLease),
        mechanism: PAUSE_MECHANISM_NOTE
      },
      discrepancies,
      audit: optBool(args, 'include_audit')
        ? await recentAudit(ctx.db, ctx.accountId, workerName)
        : undefined
    }
  }
}

// ---------------------------------------------------------------------------
// workers_cicd_configure
// ---------------------------------------------------------------------------

const cicdConfigure: ToolDefinition = {
  name: 'workers_cicd_configure',
  title: 'Create or update Workers CI/CD configuration',
  description:
    'Create or update the Workers Builds configuration for a Worker by NAME: connect a GitHub repository, set the production branch, build/deploy/preview commands, root directory, branch and path filters, and build caching. Updates are partial — a field you omit keeps its current value, and only an explicit null removes one. Supports dry_run to preview the exact change with sensitive values redacted. Refuses to run while the Worker is paused unless update_saved_config_while_paused is set, and never resumes a paused Worker as a side effect.',
  inputSchema: S.obj(
    'Configure CI/CD for one Worker.',
    {
      worker_name: S.str('The Worker name (not its tag).'),
      repository: S.str('GitHub repository as "owner/repo" (or its URL). Required when creating.'),
      production_branch: S.str('Branch that deploys to production, e.g. "main".'),
      build_command: S.str('Build command, e.g. "pnpm run build". Pass null to clear.'),
      deploy_command: S.str(
        'Production deploy command, e.g. "pnpm run deploy". Pass null to clear.'
      ),
      preview_deploy_command: S.str('Deploy command for the preview (non-production) trigger.'),
      root_directory: S.str('Project root inside the repository, e.g. "/".'),
      branch_includes: S.strArray('Branch patterns that trigger builds.'),
      branch_excludes: S.strArray('Branch patterns to exclude.'),
      path_includes: S.strArray('File path patterns that trigger builds.'),
      path_excludes: S.strArray('File path patterns to ignore.'),
      build_caching_enabled: S.bool('Enable or disable build caching.'),
      build_token_uuid: S.str(
        'UUID of an existing build token to deploy with (a reference — never a token value). Required when creating a trigger.'
      ),
      trigger_uuid: S.str('Update this specific trigger instead of the production one.'),
      dry_run: S.bool('Preview the change without writing it. Default false.'),
      update_saved_config_while_paused: S.bool(
        'When the Worker is paused, update the SAVED configuration that a later resume will restore, instead of refusing. Does not resume, and does not touch the live paused trigger. Default false.'
      )
    },
    ['worker_name']
  ),
  async handler(args, ctx) {
    const workerName = requireString(args, 'worker_name')
    const dryRun = optBool(args, 'dry_run') ?? false
    const workerTag = await requireWorkerTag(ctx, workerName)
    const { state } = await loadStateAndLeases(ctx, workerName)
    const paused = state?.phase === 'paused' || state?.phase === 'pausing'
    const updateSaved = optBool(args, 'update_saved_config_while_paused') ?? false

    if (paused && !updateSaved) {
      throw new ToolError(
        'worker_paused',
        `CI/CD for "${workerName}" is paused by ${(await listActiveLeases(ctx.db, ctx.accountId, workerName)).length} active lease(s). The update was REJECTED rather than applied, because applying it to the live trigger would either fight the pause or silently resume the Worker. Re-run with update_saved_config_while_paused=true to change what a later resume restores, or resume first.`,
        { worker_name: workerName, phase: state?.phase }
      )
    }

    const requested: Record<string, unknown> = {}
    for (const key of [
      'build_command',
      'deploy_command',
      'root_directory',
      'build_token_uuid'
    ] as const) {
      if (key in args) requested[key] = args[key] === null ? null : optString(args, key)
    }
    for (const key of [
      'branch_includes',
      'branch_excludes',
      'path_includes',
      'path_excludes'
    ] as const) {
      const v = optStringArray(args, key)
      if (v) requested[key] = v
    }
    if ('build_caching_enabled' in args)
      requested.build_caching_enabled = optBool(args, 'build_caching_enabled')
    const productionBranch = optString(args, 'production_branch')
    if (productionBranch && !requested.branch_includes)
      requested.branch_includes = [productionBranch]

    const existing = await ctx.cf.listTriggers(workerTag)
    const targetUuid = optString(args, 'trigger_uuid')
    const target = targetUuid
      ? existing.find((t) => t.trigger_uuid === targetUuid)
      : (existing.find((t) =>
          (t.branch_includes ?? []).some((b) => b !== '*' && b !== PAUSE_SENTINEL)
        ) ?? existing[0])

    if (targetUuid && !target) {
      throw new ToolError(
        'trigger_not_found',
        `No trigger ${targetUuid} on Worker "${workerName}".`
      )
    }

    // ---- Update path -------------------------------------------------------
    if (target) {
      const { patch, unchanged } = mergeConfigPatch(target, requested)
      if (paused && updateSaved) {
        // Rewrite the SAVED snapshot only. The live (paused) trigger is untouched,
        // so this cannot resume the Worker by accident.
        const saved: TriggerSnapshot[] = state?.savedConfig ? JSON.parse(state.savedConfig) : []
        const updated = saved.map((s) =>
          s.trigger_uuid === target.trigger_uuid ? { ...s, ...patch } : s
        )
        if (!dryRun) {
          await ctx.db
            .update(cicdState)
            .set({
              savedConfig: JSON.stringify(updated),
              revision: sql`${cicdState.revision} + 1`,
              updatedAt: new Date().toISOString()
            })
            .where(
              and(eq(cicdState.accountId, ctx.accountId), eq(cicdState.workerName, workerName))
            )
          await audit(ctx.db, {
            accountId: ctx.accountId,
            workerName,
            action: 'configure_saved_while_paused',
            actor: ctx.actor,
            detail: redactObject(patch)
          })
        }
        return {
          worker_name: workerName,
          mode: 'update_saved_config_while_paused',
          dry_run: dryRun,
          applied_to:
            'saved configuration only — the live paused trigger was NOT modified and the Worker was NOT resumed',
          trigger_uuid: target.trigger_uuid,
          changes: redactObject(patch),
          unchanged_fields: unchanged
        }
      }

      if (!Object.keys(patch).length) {
        return {
          worker_name: workerName,
          mode: 'update',
          dry_run: dryRun,
          trigger_uuid: target.trigger_uuid,
          changed: false,
          message:
            'Every requested value already matches the live configuration. Nothing was written (idempotent).',
          unchanged_fields: unchanged
        }
      }
      if (dryRun) {
        return {
          worker_name: workerName,
          mode: 'update',
          dry_run: true,
          trigger_uuid: target.trigger_uuid,
          would_change: redactObject(patch),
          current: presentTrigger(target),
          unchanged_fields: unchanged
        }
      }
      const updated = await ctx.cf.updateTrigger(target.trigger_uuid, patch)
      await audit(ctx.db, {
        accountId: ctx.accountId,
        workerName,
        action: 'configure_update',
        actor: ctx.actor,
        detail: redactObject(patch)
      })
      return {
        worker_name: workerName,
        mode: 'update',
        dry_run: false,
        changed: true,
        trigger_uuid: updated.trigger_uuid,
        applied: redactObject(patch),
        unchanged_fields: unchanged,
        configuration: presentTrigger(updated)
      }
    }

    // ---- Create path -------------------------------------------------------
    const repository = optString(args, 'repository')
    if (!repository) {
      throw new ToolError(
        'missing_prerequisite',
        `Worker "${workerName}" has no build trigger yet, so a repository must be supplied to create one. Pass repository as "owner/repo".`
      )
    }
    const parsed = parseRepoRef(repository)
    if (!parsed) {
      throw new ToolError(
        'invalid_argument',
        `"${repository}" is not a valid "owner/repo" reference.`
      )
    }
    const buildToken = optString(args, 'build_token_uuid')
    if (!buildToken) {
      const available = await ctx.cf.listBuildTokens().catch(() => [])
      throw new ToolError(
        'missing_prerequisite',
        "Creating a build trigger requires build_token_uuid — the token Cloudflare uses to deploy your Worker. It is a reference, not a secret value. Create one in the dashboard under the Worker's Settings > Builds, then pass its UUID.",
        {
          available_build_tokens: available.map((t) => ({
            build_token_uuid: t.build_token_uuid,
            build_token_name: t.build_token_name
          }))
        }
      )
    }

    let repo
    try {
      repo = await ctx.gh.getRepo(parsed.owner, parsed.repo)
    } catch (e) {
      if (e instanceof GitHubUnavailable) {
        throw new ToolError(
          'missing_prerequisite',
          `The numeric GitHub repository id is required to connect a repository, and GitHub could not be reached: ${e.message}`,
          { github: e.toJSON() }
        )
      }
      throw e
    }

    const connectionBody = {
      provider_type: 'github',
      provider_account_id: String(repo.owner.id),
      provider_account_name: repo.owner.login,
      repo_id: String(repo.id),
      repo_name: parsed.repo
    }
    const branchIncludes = (requested.branch_includes as string[]) ?? [
      productionBranch ?? repo.default_branch
    ]
    const triggerBody: Record<string, unknown> = {
      external_script_id: workerTag,
      trigger_name: optString(args, 'trigger_name') ?? workerTag,
      build_token_uuid: buildToken,
      build_command: requested.build_command ?? null,
      deploy_command: requested.deploy_command ?? null,
      root_directory: requested.root_directory ?? '/',
      branch_includes: branchIncludes,
      branch_excludes: requested.branch_excludes ?? [],
      path_includes: requested.path_includes ?? ['*'],
      path_excludes: requested.path_excludes ?? [],
      build_caching_enabled: requested.build_caching_enabled ?? true
    }

    if (dryRun) {
      return {
        worker_name: workerName,
        mode: 'create',
        dry_run: true,
        would_create_repo_connection: connectionBody,
        would_create_trigger: redactObject(triggerBody),
        note: 'Nothing was written. Re-run without dry_run to apply.'
      }
    }

    let connection
    try {
      connection = await ctx.cf.upsertRepoConnection(connectionBody)
    } catch (e) {
      if (e instanceof CloudflareApiError) {
        throw new ToolError(
          'missing_prerequisite',
          `Cloudflare refused to connect ${parsed.owner}/${parsed.repo}. The usual cause is that the Cloudflare Workers GitHub App is not installed on that account, or does not have access to that repository — that authorization can only be granted by a human, from the Cloudflare dashboard (Workers > the Worker > Settings > Builds > Connect). Cloudflare's exact response follows.`,
          { cloudflare: e.toJSON() }
        )
      }
      throw e
    }

    const created = await ctx.cf.createTrigger({
      ...triggerBody,
      repo_connection_uuid: connection.repo_connection_uuid
    })
    await audit(ctx.db, {
      accountId: ctx.accountId,
      workerName,
      action: 'configure_create',
      actor: ctx.actor,
      detail: { trigger_uuid: created.trigger_uuid, repository: `${parsed.owner}/${parsed.repo}` }
    })
    return {
      worker_name: workerName,
      mode: 'create',
      dry_run: false,
      trigger_uuid: created.trigger_uuid,
      configuration: presentTrigger(created),
      preview_deploy_command_note: optString(args, 'preview_deploy_command')
        ? 'preview_deploy_command was supplied but Cloudflare creates at most one trigger per call; create the preview trigger with a second call using branch_includes ["*"] and branch_excludes [production_branch].'
        : undefined
    }
  }
}

// ---------------------------------------------------------------------------
// workers_cicd_pause
// ---------------------------------------------------------------------------

const cicdPause: ToolDefinition = {
  name: 'workers_cicd_pause',
  title: 'Pause Workers CI/CD (lease-based)',
  description:
    "Suppress automatic Workers Builds for a Worker while you work on it, holding a named lease. Several agents can pause the same Worker at once; each gets its own lease and the configuration is only restored when the LAST lease is released, so releasing your lease never resumes someone else's work. The pre-pause configuration is saved before Cloudflare is touched, and is captured only on the first transition into pause — a second pause can never overwrite it. Running builds are reported but NOT cancelled unless you ask. Repeat calls with the same idempotency_key are safe.",
  inputSchema: S.obj(
    'Acquire a pause lease on one Worker.',
    {
      worker_name: S.str('The Worker name (not its tag).'),
      owner: S.str(
        'Who is holding this lease, e.g. an agent or session name. Recorded as metadata only.'
      ),
      reason: S.str('Why CI/CD is being paused. Recorded in the audit trail.'),
      idempotency_key: S.str(
        'Repeat calls with this key return the existing lease instead of adding another.'
      ),
      expires_in_seconds: S.num(
        'Advisory expiry recorded on the lease. Expiry is REPORTED ONLY — nothing resumes automatically when it passes.'
      ),
      cancel_running_builds: S.bool(
        'Also cancel builds that are already running. Default false: running builds are returned so you can decide.'
      )
    },
    ['worker_name', 'owner']
  ),
  async handler(args, ctx) {
    const workerName = requireString(args, 'worker_name')
    const owner = requireString(args, 'owner')
    const workerTag = await requireWorkerTag(ctx, workerName)
    const triggers = await ctx.cf.listTriggers(workerTag)
    if (!triggers.length) {
      throw new ToolError(
        'not_configured',
        `Worker "${workerName}" has no build triggers, so there is nothing to pause.`
      )
    }

    const expiresIn = args.expires_in_seconds
    const lease = await acquireLease(ctx.db, {
      leaseId: crypto.randomUUID(),
      accountId: ctx.accountId,
      workerName,
      workerTag,
      owner,
      reason: optString(args, 'reason'),
      idempotencyKey: optString(args, 'idempotency_key'),
      expiresAt:
        typeof expiresIn === 'number' && expiresIn > 0
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : undefined
    })

    let state = await getState(ctx.db, ctx.accountId, workerName)
    const alreadyPaused = state?.phase === 'paused' && triggers.every((t) => isPausedTrigger(t))
    let applied = false

    if (!alreadyPaused) {
      // Snapshot BEFORE touching Cloudflare, and only when nothing is saved yet —
      // capturing a config that is already paused would make resume restore a pause.
      const snapshots = triggers.map(snapshotTrigger)
      const alreadyHasSnapshot = Boolean(state?.savedConfig)
      const snapshotJson = alreadyHasSnapshot ? null : JSON.stringify(snapshots)
      const expectedJson = JSON.stringify(
        (alreadyHasSnapshot
          ? (JSON.parse(state!.savedConfig!) as TriggerSnapshot[])
          : snapshots
        ).map(expectedPaused)
      )

      const ok = await transition(
        ctx.db,
        { accountId: ctx.accountId, workerName, workerTag },
        state ? { revision: state.revision } : null,
        {
          phase: 'pausing',
          savedConfig: snapshotJson ?? undefined,
          savedAt: snapshotJson ? new Date().toISOString() : undefined,
          expectedConfig: expectedJson,
          pausedAt: state?.pausedAt ?? new Date().toISOString()
        }
      )
      if (!ok) {
        throw new ToolError(
          'concurrent_modification',
          "Another caller changed this Worker's pause state at the same time. The lease was recorded; re-run workers_cicd_pause to complete the transition.",
          { lease_id: lease.lease.leaseId }
        )
      }

      const failures: Array<{ trigger_uuid: string; error: unknown }> = []
      for (const t of triggers) {
        if (isPausedTrigger(t)) continue
        try {
          await ctx.cf.updateTrigger(t.trigger_uuid, pausePatch())
          applied = true
        } catch (e) {
          failures.push({
            trigger_uuid: t.trigger_uuid,
            error: e instanceof CloudflareApiError ? e.toJSON() : String(e)
          })
        }
      }

      state = await getState(ctx.db, ctx.accountId, workerName)
      if (failures.length) {
        // Stay in 'pausing': the row now records a partial application that
        // workers_cicd_reconcile can finish. Nothing is silently marked done.
        await audit(ctx.db, {
          accountId: ctx.accountId,
          workerName,
          action: 'pause_partial_failure',
          actor: ctx.actor,
          detail: { failures }
        })
        throw new ToolError(
          'partial_failure',
          `Cloudflare rejected the pause for ${failures.length} of ${triggers.length} trigger(s). The saved configuration is intact and this Worker is recorded in the "pausing" phase; run workers_cicd_reconcile to finish or unwind it. Your lease is held.`,
          { lease_id: lease.lease.leaseId, failures, phase: 'pausing' }
        )
      }

      await transition(
        ctx.db,
        { accountId: ctx.accountId, workerName, workerTag },
        { revision: state!.revision },
        { phase: 'paused', pausedAt: state!.pausedAt ?? new Date().toISOString() }
      )
    }

    // Running builds are reported, never cancelled by default.
    const { builds } = await ctx.cf.listBuildsPage(workerTag, 1, 20)
    const running = builds.filter((b) => b.status && b.status !== 'stopped')
    const cancelled: string[] = []
    if (optBool(args, 'cancel_running_builds') && running.length) {
      for (const b of running) {
        await ctx.cf.cancelBuild(b.build_uuid).then(
          () => cancelled.push(b.build_uuid),
          () => undefined
        )
      }
    }

    await audit(ctx.db, {
      accountId: ctx.accountId,
      workerName,
      action: 'pause',
      actor: ctx.actor,
      detail: { lease_id: lease.lease.leaseId, owner, applied, cancelled }
    })
    const leases = await listActiveLeases(ctx.db, ctx.accountId, workerName)

    return {
      worker_name: workerName,
      lease_id: lease.lease.leaseId,
      lease_created: lease.created,
      idempotent_replay: !lease.created,
      phase: 'paused',
      triggers_paused: triggers.map((t) => t.trigger_uuid),
      already_paused_by_another_lease: alreadyPaused,
      active_leases: leases.map(describeLease),
      running_builds: running.map((b) => ({
        build_uuid: b.build_uuid,
        status: b.status,
        branch: b.build_trigger_metadata?.branch,
        created_on: b.created_on
      })),
      cancelled_builds: cancelled,
      mechanism: PAUSE_MECHANISM_NOTE,
      scope: MANUAL_BUILD_NOTE,
      expiry_policy:
        'An expires_in_seconds value is advisory. Leases are never auto-released and CI/CD is never auto-resumed by elapsed time; an expired lease is simply reported as expired so a human or a force-resume can act on it.'
    }
  }
}

// ---------------------------------------------------------------------------
// workers_cicd_resume
// ---------------------------------------------------------------------------

const cicdResume: ToolDefinition = {
  name: 'workers_cicd_resume',
  title: 'Resume Workers CI/CD',
  description:
    'Release your pause lease on a Worker and, only when no other lease remains, restore the saved CI/CD configuration and verify the restore against Cloudflare. If another agent still holds a lease, the configuration is deliberately left paused and the remaining holders are returned. Configuration drift made by someone else while paused is detected and is never silently overwritten. Use force=true only with explicit authorization to release every lease and restore anyway.',
  inputSchema: S.obj(
    'Release a lease and restore when it was the last one.',
    {
      worker_name: S.str('The Worker name (not its tag).'),
      lease_id: S.str('The lease_id returned by workers_cicd_pause.'),
      force: S.bool(
        'Administrative override: release EVERY outstanding lease and restore regardless of other holders. Requires force_reason.'
      ),
      force_reason: S.str('Why the override is authorized. Recorded in the audit trail.'),
      overwrite_drift: S.bool(
        'Restore even though unrelated configuration changed while paused. Default false, which reports the drift and stops.'
      )
    },
    ['worker_name']
  ),
  async handler(args, ctx) {
    const workerName = requireString(args, 'worker_name')
    const workerTag = await requireWorkerTag(ctx, workerName)
    const leaseId = optString(args, 'lease_id')
    const force = optBool(args, 'force') ?? false

    if (force && !optString(args, 'force_reason')) {
      throw new ToolError(
        'invalid_argument',
        "force=true requires force_reason. A force-resume overrides other agents' active leases and must be attributable."
      )
    }

    let state = await getState(ctx.db, ctx.accountId, workerName)
    if (!state || !state.savedConfig) {
      // Still release the caller's lease so a stale one cannot linger.
      if (leaseId) await releaseLease(ctx.db, ctx.accountId, workerName, leaseId)
      return {
        worker_name: workerName,
        restored: false,
        message:
          'No saved configuration is held for this Worker, so there is nothing to restore. If a trigger is paused remotely, its original branch matchers were not recorded here and must be restored manually.',
        active_leases: (await listActiveLeases(ctx.db, ctx.accountId, workerName)).map(
          describeLease
        )
      }
    }
    if (state.workerTag !== workerTag) {
      throw new ToolError(
        'worker_recreated',
        `The saved configuration belongs to Worker tag ${state.workerTag}, but "${workerName}" now has tag ${workerTag}. The Worker was deleted and recreated, so the saved configuration is not applicable and was NOT applied. Delete the stale state deliberately or reconfigure from scratch.`,
        { saved_tag: state.workerTag, current_tag: workerTag }
      )
    }

    let released = 0
    if (force) {
      released = await releaseAllLeases(ctx.db, ctx.accountId, workerName)
    } else if (leaseId) {
      const ok = await releaseLease(ctx.db, ctx.accountId, workerName, leaseId)
      released = ok ? 1 : 0
    }

    const remaining = await listActiveLeases(ctx.db, ctx.accountId, workerName)
    if (remaining.length && !force) {
      await audit(ctx.db, {
        accountId: ctx.accountId,
        workerName,
        action: 'resume_blocked_by_lease',
        actor: ctx.actor,
        detail: { released, remaining: remaining.map((l) => l.leaseId) }
      })
      return {
        worker_name: workerName,
        lease_released: released > 0,
        restored: false,
        reason: 'other_leases_active',
        message: `Your lease was released, but ${remaining.length} other pause lease(s) are still held, so CI/CD was deliberately left paused — resuming would restart builds under another agent's feet.`,
        remaining_holders: remaining.map(describeLease),
        how_to_override:
          'If those leases are known to be abandoned, re-run with force=true and force_reason to release them all and restore.'
      }
    }

    const saved = JSON.parse(state.savedConfig) as TriggerSnapshot[]
    const expected = state.expectedConfig
      ? (JSON.parse(state.expectedConfig) as TriggerSnapshot[])
      : saved.map(expectedPaused)
    const live = await ctx.cf.listTriggers(workerTag)
    const drift = detectDrift(expected, live)
    const overwrite = optBool(args, 'overwrite_drift') ?? false

    if ((drift.unrelatedDrift.length || drift.missing.length) && !overwrite) {
      await audit(ctx.db, {
        accountId: ctx.accountId,
        workerName,
        action: 'resume_blocked_by_drift',
        actor: ctx.actor,
        detail: drift
      })
      return {
        worker_name: workerName,
        lease_released: released > 0,
        restored: false,
        reason: 'configuration_drift',
        message:
          'The live configuration changed while this Worker was paused in ways unrelated to the pause. Restoring the saved snapshot would silently revert those edits, so nothing was written and the Worker remains paused.',
        drift: {
          changed_while_paused: drift.unrelatedDrift,
          pause_field_changes: drift.pauseFieldDrift,
          missing_triggers: drift.missing,
          new_triggers: drift.added
        },
        how_to_proceed:
          'Review the changes. Re-run with overwrite_drift=true to restore the saved branch matchers anyway (only the branch matchers are written — the drifted fields are left as they are), or reconfigure with workers_cicd_configure.'
      }
    }

    // Persist the intent before calling Cloudflare so a partial failure is visible.
    await transition(
      ctx.db,
      { accountId: ctx.accountId, workerName, workerTag },
      { revision: state.revision },
      { phase: 'resuming' }
    )
    state = await getState(ctx.db, ctx.accountId, workerName)

    const failures: Array<{ trigger_uuid: string; error: unknown }> = []
    for (const snap of saved) {
      try {
        await ctx.cf.updateTrigger(snap.trigger_uuid, restorePatch(snap))
      } catch (e) {
        failures.push({
          trigger_uuid: snap.trigger_uuid,
          error: e instanceof CloudflareApiError ? e.toJSON() : String(e)
        })
      }
    }

    // Verify against the remote before declaring success or discarding recovery data.
    const after = await ctx.cf.listTriggers(workerTag)
    const verification = detectDrift(saved, after)
    const verified = !failures.length && verification.pauseFieldDrift.length === 0

    await audit(ctx.db, {
      accountId: ctx.accountId,
      workerName,
      action: force ? 'resume_forced' : 'resume',
      actor: ctx.actor,
      detail: {
        released,
        verified,
        failures,
        force_reason: optString(args, 'force_reason'),
        restored_config: saved
      }
    })

    if (!verified) {
      return {
        worker_name: workerName,
        restored: false,
        verified: false,
        reason: 'restore_not_verified',
        message:
          'The restore did not fully verify against Cloudflare. The saved configuration was deliberately KEPT so it can be retried — run workers_cicd_reconcile.',
        failures,
        remaining_differences: verification.pauseFieldDrift,
        phase: 'resuming'
      }
    }

    // Only now, with the restore verified, is the recovery snapshot cleared. The
    // audit row above still carries the full restored configuration.
    await clearSavedConfig(ctx.db, ctx.accountId, workerName)

    return {
      worker_name: workerName,
      lease_released: released > 0,
      leases_released: released,
      forced: force,
      restored: true,
      verified: true,
      phase: 'active',
      restored_triggers: after.map(presentTrigger),
      note: 'Automatic production and preview builds are active again. The saved snapshot was cleared only after the restore verified; the full history remains in the audit trail (workers_cicd_get with include_audit).'
    }
  }
}

// ---------------------------------------------------------------------------
// workers_cicd_reconcile
// ---------------------------------------------------------------------------

const cicdReconcile: ToolDefinition = {
  name: 'workers_cicd_reconcile',
  title: 'Reconcile an interrupted pause or resume',
  description:
    'Recover a Worker whose pause or resume failed part-way. D1 and the Cloudflare API cannot share a transaction, so an interrupted call leaves a recorded "pausing"/"resuming" phase; this compares the recorded intent with the live Cloudflare configuration, reports the difference, and with apply=true finishes the transition. Read-only by default.',
  inputSchema: S.obj(
    'Inspect and optionally finish an interrupted transition.',
    {
      worker_name: S.str('The Worker name (not its tag).'),
      apply: S.bool('Finish the recorded transition. Default false (report only).')
    },
    ['worker_name']
  ),
  async handler(args, ctx) {
    const workerName = requireString(args, 'worker_name')
    const workerTag = await requireWorkerTag(ctx, workerName)
    const state = await getState(ctx.db, ctx.accountId, workerName)
    const live = await ctx.cf.listTriggers(workerTag)
    const leases = await listActiveLeases(ctx.db, ctx.accountId, workerName)
    const apply = optBool(args, 'apply') ?? false

    if (!state) {
      return {
        worker_name: workerName,
        phase: 'active',
        action: 'none',
        message: 'No recorded state; nothing to reconcile.'
      }
    }

    const remotePaused = live.filter(isPausedTrigger).map((t) => t.trigger_uuid)
    const notPaused = live.filter((t) => !isPausedTrigger(t)).map((t) => t.trigger_uuid)
    const intent =
      state.phase === 'pausing' || (state.phase === 'paused' && notPaused.length)
        ? 'complete_pause'
        : state.phase === 'resuming'
          ? 'complete_resume'
          : 'none'

    const report = {
      worker_name: workerName,
      recorded_phase: state.phase,
      recorded_tag: state.workerTag,
      current_tag: workerTag,
      remote_paused_triggers: remotePaused,
      remote_unpaused_triggers: notPaused,
      active_leases: leases.map(describeLease),
      recommended_action: intent
    }
    if (!apply || intent === 'none') {
      return {
        ...report,
        applied: false,
        message:
          intent === 'none'
            ? 'Recorded state and Cloudflare agree. No action needed.'
            : 'Re-run with apply=true to finish this transition.'
      }
    }

    if (intent === 'complete_pause') {
      for (const uuid of notPaused) await ctx.cf.updateTrigger(uuid, pausePatch())
      await transition(
        ctx.db,
        { accountId: ctx.accountId, workerName, workerTag },
        { revision: state.revision },
        { phase: 'paused', pausedAt: state.pausedAt ?? new Date().toISOString() }
      )
    } else {
      const saved = state.savedConfig ? (JSON.parse(state.savedConfig) as TriggerSnapshot[]) : []
      for (const snap of saved) await ctx.cf.updateTrigger(snap.trigger_uuid, restorePatch(snap))
      const after = await ctx.cf.listTriggers(workerTag)
      if (detectDrift(saved, after).pauseFieldDrift.length === 0) {
        await clearSavedConfig(ctx.db, ctx.accountId, workerName)
      }
    }

    await audit(ctx.db, {
      accountId: ctx.accountId,
      workerName,
      action: `reconcile_${intent}`,
      actor: ctx.actor,
      detail: report
    })
    const after = await ctx.cf.listTriggers(workerTag)
    return { ...report, applied: true, triggers: after.map(presentTrigger) }
  }
}

export const cicdTools: ToolDefinition[] = [
  cicdGet,
  cicdConfigure,
  cicdPause,
  cicdResume,
  cicdReconcile
]
