/**
 * How "pause" is implemented, and how a restore is proved safe.
 *
 * MEASURED 2026-09-10 against the live API: a Workers Builds trigger has NO
 * enabled/disabled/paused field. The full trigger object is
 * `{trigger_uuid, external_script_id, build_token_uuid, build_token_name,
 *   trigger_name, build_command, deploy_command, root_directory,
 *   branch_includes, branch_excludes, path_includes, path_excludes,
 *   build_caching_enabled, created_on, modified_on, deleted_on, repo_connection}` —
 * there is nothing to flip. So pausing is done by narrowing the trigger's branch
 * matchers to something no real branch satisfies, and resuming restores the
 * saved matchers verbatim.
 *
 * Why this mechanism and not deleting the trigger: deleting loses
 * `build_token_uuid` and the repo connection, and the build token's secret
 * material is NOT readable back out of the API — a delete/recreate pause would
 * be a pause you cannot reliably undo. Narrowing touches only two array fields
 * whose prior values we hold, and `PATCH` is a verified partial update, so
 * everything else on the trigger is left byte-identical.
 *
 * What it does and does not stop: it suppresses automatic builds for every
 * trigger on the Worker, production and preview alike, because a push's branch
 * can no longer match. It is NOT verified to block an explicit manual build
 * (`POST /builds/triggers/{uuid}/builds`), which names its branch directly —
 * tool results say so rather than implying a guarantee that was never tested.
 *
 * Pure module: no bindings, no I/O.
 */

import type { Trigger } from './cf-builds'

/**
 * Branch pattern written while paused. Chosen to be both impossible as a real
 * git ref (a ref cannot contain a space or two dots) and self-explanatory to a
 * human who finds it in the Cloudflare dashboard.
 */
export const PAUSE_SENTINEL = 'cicd-paused-by-mcp..do-not-build'

/** Fields this module ever writes. Everything else on a trigger is untouched. */
export const PAUSE_FIELDS = ['branch_includes'] as const

export interface TriggerSnapshot {
  trigger_uuid: string
  branch_includes: string[]
  branch_excludes: string[]
  /** Recorded for drift reporting only; never re-sent on restore. */
  trigger_name?: string
  build_command?: string | null
  deploy_command?: string | null
  root_directory?: string | null
  path_includes?: string[]
  path_excludes?: string[]
  build_caching_enabled?: boolean
  build_token_uuid?: string
  repo_connection_uuid?: string
}

export function snapshotTrigger(t: Trigger): TriggerSnapshot {
  return {
    trigger_uuid: t.trigger_uuid,
    branch_includes: t.branch_includes ?? [],
    branch_excludes: t.branch_excludes ?? [],
    trigger_name: t.trigger_name,
    build_command: t.build_command ?? null,
    deploy_command: t.deploy_command ?? null,
    root_directory: t.root_directory ?? null,
    path_includes: t.path_includes ?? [],
    path_excludes: t.path_excludes ?? [],
    build_caching_enabled: t.build_caching_enabled,
    build_token_uuid: t.build_token_uuid,
    repo_connection_uuid: t.repo_connection?.repo_connection_uuid
  }
}

/**
 * The PATCH body that pauses one trigger.
 *
 * MEASURED 2026-09-10: only `branch_includes` may be narrowed. Cloudflare
 * validates the matchers and rejects `branch_excludes: ["*"]` — excluding every
 * branch — with HTTP 400 code 12002 "Invalid request body". So the pause is
 * expressed purely as an include list no real branch can satisfy, and
 * `branch_excludes` is left exactly as the caller had it.
 */
export function pausePatch(): { branch_includes: string[] } {
  return { branch_includes: [PAUSE_SENTINEL] }
}

/**
 * The PATCH body that restores one trigger from its snapshot.
 *
 * `branch_excludes` is re-sent even though pausing never changed it: if someone
 * edited it while paused, `detectDrift` has already reported that and the caller
 * had to opt in, so writing the saved value back is the explicit choice — not a
 * silent revert.
 */
export function restorePatch(snap: TriggerSnapshot): {
  branch_includes: string[]
  branch_excludes: string[]
} {
  return { branch_includes: snap.branch_includes, branch_excludes: snap.branch_excludes }
}

/** What a paused trigger is expected to look like remotely, for drift detection. */
export function expectedPaused(snap: TriggerSnapshot): TriggerSnapshot {
  return { ...snap, ...pausePatch() }
}

export function isPausedTrigger(t: Trigger): boolean {
  return (t.branch_includes ?? []).includes(PAUSE_SENTINEL)
}

export interface DriftFinding {
  trigger_uuid: string
  field: string
  expected: unknown
  actual: unknown
}

const sameArray = (a?: unknown[], b?: unknown[]) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

/**
 * Compare the live triggers against what we expect a paused Worker to look like.
 *
 * Two different problems are reported separately because they need different
 * responses: a `pause_field` difference means someone else changed the branch
 * matchers (a restore would fight them), while an `unrelated_field` difference
 * means someone legitimately edited the build command or root directory while we
 * were paused — a restore must NOT revert that, and this is what stops it
 * silently doing so.
 */
export function detectDrift(
  expected: TriggerSnapshot[],
  actual: Trigger[]
): {
  pauseFieldDrift: DriftFinding[]
  unrelatedDrift: DriftFinding[]
  missing: string[]
  added: string[]
} {
  const byUuid = new Map(actual.map((t) => [t.trigger_uuid, t]))
  const pauseFieldDrift: DriftFinding[] = []
  const unrelatedDrift: DriftFinding[] = []
  const missing: string[] = []

  for (const exp of expected) {
    const cur = byUuid.get(exp.trigger_uuid)
    if (!cur) {
      missing.push(exp.trigger_uuid)
      continue
    }
    if (!sameArray(exp.branch_includes, cur.branch_includes)) {
      pauseFieldDrift.push({
        trigger_uuid: exp.trigger_uuid,
        field: 'branch_includes',
        expected: exp.branch_includes,
        actual: cur.branch_includes
      })
    }
    if (!sameArray(exp.branch_excludes, cur.branch_excludes)) {
      pauseFieldDrift.push({
        trigger_uuid: exp.trigger_uuid,
        field: 'branch_excludes',
        expected: exp.branch_excludes,
        actual: cur.branch_excludes
      })
    }

    const compare: Array<[string, unknown, unknown]> = [
      ['build_command', exp.build_command ?? null, cur.build_command ?? null],
      ['deploy_command', exp.deploy_command ?? null, cur.deploy_command ?? null],
      ['root_directory', exp.root_directory ?? null, cur.root_directory ?? null],
      ['build_caching_enabled', exp.build_caching_enabled, cur.build_caching_enabled],
      ['build_token_uuid', exp.build_token_uuid, cur.build_token_uuid]
    ]
    for (const [field, e, a] of compare) {
      if (e !== a)
        unrelatedDrift.push({ trigger_uuid: exp.trigger_uuid, field, expected: e, actual: a })
    }
    for (const field of ['path_includes', 'path_excludes'] as const) {
      if (!sameArray(exp[field], cur[field])) {
        unrelatedDrift.push({
          trigger_uuid: exp.trigger_uuid,
          field,
          expected: exp[field],
          actual: cur[field]
        })
      }
    }
  }

  const expectedUuids = new Set(expected.map((e) => e.trigger_uuid))
  const added = actual.filter((t) => !expectedUuids.has(t.trigger_uuid)).map((t) => t.trigger_uuid)
  return { pauseFieldDrift, unrelatedDrift, missing, added }
}

/**
 * Merge a caller's requested configuration onto the current trigger.
 *
 * `undefined` means "not mentioned — keep what is there"; `null` means "remove
 * it". Conflating the two is how a partial update silently wipes a field the
 * caller never referred to.
 */
export function mergeConfigPatch(
  current: Trigger,
  requested: Record<string, unknown>
): { patch: Record<string, unknown>; unchanged: string[] } {
  const patch: Record<string, unknown> = {}
  const unchanged: string[] = []
  const fields = [
    'trigger_name',
    'build_command',
    'deploy_command',
    'root_directory',
    'branch_includes',
    'branch_excludes',
    'path_includes',
    'path_excludes',
    'build_caching_enabled',
    'build_token_uuid'
  ] as const

  for (const f of fields) {
    if (!(f in requested) || requested[f] === undefined) {
      unchanged.push(f)
      continue
    }
    const want = requested[f]
    const have = (current as unknown as Record<string, unknown>)[f]
    if (JSON.stringify(want) === JSON.stringify(have)) {
      unchanged.push(f)
      continue
    }
    patch[f] = want
  }
  return { patch, unchanged }
}
