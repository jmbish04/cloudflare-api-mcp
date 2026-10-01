/**
 * Build-token management and a pass/fail validation of a Worker's CI/CD setup.
 *
 * `workers_cicd_configure` can already set every field of a trigger. What was
 * missing was the two things around it: getting a build token to associate in the
 * first place, and being able to ask "is this actually set up correctly?" and get
 * an answer rather than a config dump to interpret by eye.
 *
 * The validator is the point of this file. A build configuration can be present
 * and still not work — a deploy command that skips the build while no build
 * command is set is the case that bit `core-ai-tools`: CI looked configured, and
 * the first command of the deploy would have failed on a missing `dist/`. So the
 * checks are **semantic**, not just presence checks, and every one of them states
 * its reasoning either way.
 */

import { CloudflareApiError, type Trigger } from '../cf-builds'
import {
  optString,
  requireString,
  requireWorkerTag,
  S,
  ToolError,
  type ToolContext,
  type ToolDefinition
} from './context'

/** One check's verdict. `pass: null` means it could not be determined. */
export interface CheckResult {
  check: string
  pass: boolean | null
  /** Why it passed or failed — always populated, for both outcomes. */
  reason: string
  /** What to do about it, when it failed. */
  remedy?: string
}

/**
 * Semantic checks over a production trigger.
 *
 * Pure, so every rule is testable without an account. Exported for that reason.
 *
 * @param trigger the production trigger, or null when none is configured
 * @param opts repository association and preview-trigger presence
 */
export function evaluateTrigger(
  trigger: Trigger | null,
  opts: { previewTriggerPresent: boolean }
): CheckResult[] {
  const checks: CheckResult[] = []

  if (!trigger) {
    return [
      {
        check: 'trigger_exists',
        pass: false,
        reason: 'No production build trigger exists for this Worker.',
        remedy: 'Call workers_cicd_configure with worker_name and repository to create one.'
      }
    ]
  }
  checks.push({
    check: 'trigger_exists',
    pass: true,
    reason: `Production trigger ${trigger.trigger_uuid} exists.`
  })

  // --- repository association
  const repo = trigger.repo_connection
  checks.push(
    repo?.repo_name
      ? {
          check: 'repository_associated',
          pass: true,
          reason: `Connected to ${repo.provider_type ?? 'git'} repository ${
            repo.provider_account_name ? `${repo.provider_account_name}/` : ''
          }${repo.repo_name}.`
        }
      : {
          check: 'repository_associated',
          pass: false,
          reason: 'The trigger has no repository connection, so nothing can start a build.',
          remedy: 'Call workers_cicd_configure with repository set to "owner/repo".'
        }
  )

  // --- build token
  checks.push(
    trigger.build_token_uuid || trigger.build_token_name
      ? {
          check: 'build_token_associated',
          pass: true,
          reason: `Build token "${trigger.build_token_name ?? trigger.build_token_uuid}" is associated.`
        }
      : {
          check: 'build_token_associated',
          pass: false,
          reason: 'No build token is associated, so a build cannot authenticate to deploy.',
          remedy:
            'List candidates with workers_build_tokens_list, then pass build_token_uuid ' +
            'to workers_cicd_configure. Create one with workers_build_token_create if none fits.'
        }
  )

  // --- branch matchers
  const includes = trigger.branch_includes ?? []
  checks.push(
    includes.length > 0
      ? {
          check: 'branch_matchers_set',
          pass: true,
          reason: `Builds trigger on branch pattern(s): ${includes.join(', ')}.`
        }
      : {
          check: 'branch_matchers_set',
          pass: false,
          reason: 'branch_includes is empty, so no push can ever match and no build will run.',
          remedy: 'Set branch_includes (e.g. ["main"]) via workers_cicd_configure.'
        }
  )

  // --- the semantic one: does anything actually build?
  const build = (trigger.build_command ?? '').trim()
  const deploy = (trigger.deploy_command ?? '').trim()

  if (!deploy) {
    checks.push({
      check: 'deploy_command_set',
      pass: false,
      reason: 'No deploy command is set, so a successful build would never be deployed.',
      remedy: 'Set deploy_command (e.g. "pnpm run deploy") via workers_cicd_configure.'
    })
  } else {
    checks.push({
      check: 'deploy_command_set',
      pass: true,
      reason: `Deploy command is "${deploy}".`
    })

    // A deploy command that self-builds covers an empty build command. One that
    // does not, with no build command set, means nothing produces the output the
    // deploy then tries to upload — configured-looking, and broken. This is the
    // exact shape that would have broken core-ai-tools.
    const deploySelfBuilds = /(^|&&|;|\s)(pnpm|npm|yarn|bun)\s+(run\s+)?build\b/.test(deploy)
    if (!build && !deploySelfBuilds) {
      checks.push({
        check: 'something_builds_the_output',
        pass: false,
        reason:
          `No build command is set, and the deploy command ("${deploy}") does not ` +
          `appear to build. Nothing would produce the output the deploy uploads, so ` +
          `the deploy will fail or ship stale output.`,
        remedy:
          'Either set build_command (e.g. "pnpm run build"), or use a deploy command ' +
          'that builds first. Both via workers_cicd_configure.'
      })
    } else {
      checks.push({
        check: 'something_builds_the_output',
        pass: true,
        reason: build
          ? `Build command "${build}" produces the output before the deploy runs.`
          : `No separate build command, but the deploy command builds first.`
      })
    }

    // Both building is not an error, just wasted CI minutes — reported as a pass
    // with the observation, because failing a valid configuration is worse.
    if (build && /(^|&&|;|\s)(pnpm|npm|yarn|bun)\s+(run\s+)?build\b/.test(deploy)) {
      checks.push({
        check: 'no_duplicate_build',
        pass: true,
        reason:
          `Both build_command and deploy_command build. This works but builds twice; ` +
          `a deploy command that skips the build (e.g. "deploy:ci") would be faster.`
      })
    }
  }

  // --- preview trigger: informational, never a failure
  checks.push({
    check: 'preview_trigger',
    pass: null,
    reason: opts.previewTriggerPresent
      ? 'A non-production trigger is configured.'
      : 'No preview trigger is exposed by the API. That is not evidence preview builds ' +
        'do not run — Cloudflare can build pull requests under an implicit trigger it ' +
        'does not list. Check the PR check run in GitHub.'
  })

  return checks
}

export const cicdSetupTools: ToolDefinition[] = [
  {
    name: 'workers_cicd_validate',
    title: 'Validate Workers CI/CD configuration',
    description:
      "Check whether a Worker's Workers Builds configuration is complete and " +
      'coherent, and return a single overall pass/fail plus the reasoning for every ' +
      'individual check — both why it passed and why it failed, with a remedy naming ' +
      'the tool that fixes it. Checks are semantic, not presence-only: a deploy ' +
      'command that skips the build while no build command is set is reported as a ' +
      'failure, because nothing would produce the output the deploy uploads even ' +
      'though every field looks populated. Read-only.',
    inputSchema: S.obj(
      "Validate a Worker's CI/CD configuration.",
      { worker_name: S.str('The Worker name (not its tag).') },
      ['worker_name']
    ),
    async handler(args, ctx: ToolContext) {
      const workerName = requireString(args, 'worker_name')
      const workerTag = await requireWorkerTag(ctx, workerName)
      const triggers = await ctx.cf.listTriggers(workerTag)

      // The production trigger is the one whose matchers include a default branch.
      // Fall back to the only trigger when there is exactly one.
      const production =
        triggers.find((t) =>
          (t.branch_includes ?? []).some((b) => b === 'main' || b === 'master')
        ) ?? (triggers.length === 1 ? triggers[0] : null)

      const checks = evaluateTrigger(production, {
        previewTriggerPresent: triggers.some((t) => t !== production)
      })
      const failures = checks.filter((c) => c.pass === false)

      return {
        worker_name: workerName,
        worker_tag: workerTag,
        // The simple answer the caller asked for, first.
        valid: failures.length === 0,
        summary:
          failures.length === 0
            ? `PASS — ${checks.filter((c) => c.pass === true).length} check(s) passed, nothing blocking.`
            : `FAIL — ${failures.length} blocking problem(s): ${failures
                .map((f) => f.check)
                .join(', ')}.`,
        checks,
        triggers_found: triggers.length,
        production_trigger_uuid: production?.trigger_uuid ?? null,
        note: 'Read-only. Fix anything failing with workers_cicd_configure.'
      }
    }
  },
  {
    name: 'workers_build_tokens_list',
    title: 'List build tokens',
    description:
      "List the account's Workers Builds tokens so one can be associated with a " +
      "trigger via workers_cicd_configure (build_token_uuid). Returns each token's " +
      'uuid and display name only — no token value is ever returned.',
    inputSchema: S.obj('List build tokens.', {}, []),
    async handler(_args, ctx: ToolContext) {
      const tokens = await ctx.cf.listBuildTokens()
      return {
        build_tokens: tokens.map((t) => ({
          build_token_uuid: t.build_token_uuid,
          build_token_name: t.build_token_name,
          owner_type: t.owner_type
        })),
        count: tokens.length,
        note: 'Token values are never returned. Associate one with workers_cicd_configure.'
      }
    }
  },
  {
    name: 'workers_build_token_create',
    title: 'Create a build token',
    description:
      'Create a Workers Builds token from an existing Cloudflare API token, for ' +
      'association with a build trigger. A build token WRAPS an API token rather ' +
      "than minting one, so the API requires that token's value and its id. The " +
      'value is passed straight to Cloudflare and is never logged, stored, echoed, ' +
      "or returned — the result carries only the new build token's uuid and name. " +
      'Check workers_build_tokens_list first: an existing token can usually be ' +
      'reused, which avoids handling a credential at all.',
    inputSchema: S.obj(
      'Create a build token from an existing Cloudflare API token.',
      {
        build_token_name: S.str('Display name for the new build token.'),
        cloudflare_token_id: S.str('The id of the existing Cloudflare API token to wrap.'),
        cloudflare_token_value: S.str(
          'The value of that API token. Never logged, stored, or returned.'
        ),
        associate_with_worker: S.str(
          "Optionally associate the new token with this Worker's production trigger."
        )
      },
      ['build_token_name', 'cloudflare_token_id', 'cloudflare_token_value']
    ),
    async handler(args, ctx: ToolContext) {
      const name = requireString(args, 'build_token_name')
      const tokenId = requireString(args, 'cloudflare_token_id')
      const secret = requireString(args, 'cloudflare_token_value')
      const associateWith = optString(args, 'associate_with_worker')

      let created
      try {
        created = await ctx.cf.createBuildToken({
          build_token_name: name,
          build_token_secret: secret,
          cloudflare_token_id: tokenId
        })
      } catch (err) {
        // Deliberately does not echo the request body: it held a credential.
        if (err instanceof CloudflareApiError) {
          throw new ToolError(
            'cloudflare_error',
            `Cloudflare refused the build token (HTTP ${err.status}). Check that ` +
              `cloudflare_token_id and its value belong to the same token and that it ` +
              `is still valid.`
          )
        }
        throw err
      }

      let associated: Record<string, unknown> | undefined
      if (associateWith) {
        const workerTag = await requireWorkerTag(ctx, associateWith)
        const triggers = await ctx.cf.listTriggers(workerTag)
        const production =
          triggers.find((t) =>
            (t.branch_includes ?? []).some((b) => b === 'main' || b === 'master')
          ) ?? (triggers.length === 1 ? triggers[0] : null)
        if (!production) {
          associated = {
            ok: false,
            reason: `No unambiguous production trigger on "${associateWith}" to associate with.`
          }
        } else {
          await ctx.cf.updateTrigger(production.trigger_uuid, {
            build_token_uuid: created.build_token_uuid
          })
          associated = {
            ok: true,
            worker_name: associateWith,
            trigger_uuid: production.trigger_uuid
          }
        }
      }

      return {
        build_token: {
          build_token_uuid: created.build_token_uuid,
          build_token_name: created.build_token_name
        },
        ...(associated ? { associated } : {}),
        note: 'The API token value was not logged, stored, or returned.'
      }
    }
  }
]
