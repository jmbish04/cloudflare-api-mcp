import { describe, expect, it } from 'vitest'
import {
  detectDrift,
  expectedPaused,
  isPausedTrigger,
  mergeConfigPatch,
  pausePatch,
  PAUSE_SENTINEL,
  restorePatch,
  snapshotTrigger
} from '../src/lib/cicd-pause'
import type { Trigger } from '../src/lib/cf-builds'

const trigger = (over: Partial<Trigger> = {}): Trigger => ({
  trigger_uuid: 't1',
  external_script_id: 'tag1',
  build_token_uuid: 'bt1',
  trigger_name: 'prod',
  build_command: 'pnpm run build',
  deploy_command: 'pnpm run deploy',
  root_directory: '/',
  branch_includes: ['main'],
  branch_excludes: [],
  path_includes: ['*'],
  path_excludes: [],
  build_caching_enabled: true,
  ...over
})

describe('pause and restore round trip', () => {
  it('pause narrows only branch_includes, and restore returns the matchers exactly', () => {
    const snap = snapshotTrigger(trigger())
    const patch = pausePatch()
    // MEASURED: Cloudflare rejects branch_excludes:["*"] with 400/12002, so the
    // pause must be expressed through branch_includes alone.
    expect(Object.keys(patch)).toEqual(['branch_includes'])
    expect(patch.branch_includes).toEqual([PAUSE_SENTINEL])
    expect(patch).not.toHaveProperty('branch_excludes')

    const paused = trigger({ ...patch })
    expect(isPausedTrigger(paused)).toBe(true)
    // Nothing else was touched — this is what makes restore possible without
    // re-supplying the build token, which is not readable back from the API.
    expect(paused.build_token_uuid).toBe('bt1')
    expect(paused.build_command).toBe('pnpm run build')

    expect(restorePatch(snap)).toEqual({ branch_includes: ['main'], branch_excludes: [] })
  })

  it('the pause sentinel cannot be a real git ref', () => {
    // git refuses refs containing ".." or a space.
    expect(PAUSE_SENTINEL).toMatch(/\.\./)
  })
})

describe('drift detection', () => {
  it('separates pause-field drift from unrelated edits made while paused', () => {
    const original = snapshotTrigger(trigger())
    const expected = [expectedPaused(original)]
    const live = [trigger({ ...pausePatch(), build_command: 'pnpm run build:fast' })]

    const drift = detectDrift(expected, live)
    expect(drift.pauseFieldDrift).toHaveLength(0)
    expect(drift.unrelatedDrift).toHaveLength(1)
    expect(drift.unrelatedDrift[0].field).toBe('build_command')
  })

  it('reports someone else changing the branch matchers while paused', () => {
    const expected = [expectedPaused(snapshotTrigger(trigger()))]
    const live = [trigger({ branch_includes: ['develop'], branch_excludes: [] })]
    const drift = detectDrift(expected, live)
    expect(drift.pauseFieldDrift.map((d) => d.field)).toContain('branch_includes')
  })

  it('reports a trigger that disappeared and one that appeared', () => {
    const expected = [expectedPaused(snapshotTrigger(trigger()))]
    const live = [trigger({ trigger_uuid: 't2' })]
    const drift = detectDrift(expected, live)
    expect(drift.missing).toEqual(['t1'])
    expect(drift.added).toEqual(['t2'])
  })

  it('finds no drift when the remote matches the expected paused state', () => {
    const expected = [expectedPaused(snapshotTrigger(trigger()))]
    const live = [trigger({ ...pausePatch() })]
    const drift = detectDrift(expected, live)
    expect(drift.pauseFieldDrift).toHaveLength(0)
    expect(drift.unrelatedDrift).toHaveLength(0)
  })
})

describe('mergeConfigPatch', () => {
  it('treats an omitted field as "keep" and an explicit null as "remove"', () => {
    const cur = trigger()
    const omitted = mergeConfigPatch(cur, { build_command: 'x' })
    expect(omitted.patch).toEqual({ build_command: 'x' })
    expect(omitted.unchanged).toContain('deploy_command')

    const removed = mergeConfigPatch(cur, { deploy_command: null })
    expect(removed.patch).toEqual({ deploy_command: null })
  })

  it('produces an empty patch when everything already matches (idempotent update)', () => {
    const cur = trigger()
    const res = mergeConfigPatch(cur, {
      build_command: 'pnpm run build',
      branch_includes: ['main'],
      build_caching_enabled: true
    })
    expect(res.patch).toEqual({})
  })
})
