import { describe, expect, it } from 'vitest'
import { evaluateTrigger, type CheckResult } from '../src/lib/tools/cicd-setup'
import type { Trigger } from '../src/lib/cf-builds'

const base = (over: Partial<Trigger> = {}): Trigger => ({
  trigger_uuid: 't-1',
  external_script_id: 'tag-1',
  build_token_uuid: 'bt-1',
  build_token_name: 'a token',
  build_command: 'pnpm run build',
  deploy_command: 'pnpm run deploy:ci',
  branch_includes: ['main'],
  repo_connection: {
    repo_connection_uuid: 'rc-1',
    repo_id: '1',
    repo_name: 'core-ai-tools',
    provider_type: 'github',
    provider_account_id: '1',
    provider_account_name: 'jmbish04',
    grant_id: null
  },
  ...over
})

const get = (checks: CheckResult[], name: string) => checks.find((c) => c.check === name)!
const failures = (checks: CheckResult[]) =>
  checks.filter((c) => c.pass === false).map((c) => c.check)

describe('evaluateTrigger — a fully configured trigger', () => {
  it('passes everything', () => {
    expect(failures(evaluateTrigger(base(), { previewTriggerPresent: true }))).toEqual([])
  })

  // Every check must explain itself on a PASS too — the operator asked for
  // transparency both ways, not just on failure.
  it('gives a reason for passing checks, not only failing ones', () => {
    for (const c of evaluateTrigger(base(), { previewTriggerPresent: true })) {
      expect(c.reason.length).toBeGreaterThan(10)
    }
  })
})

describe('evaluateTrigger — the semantic check that matters', () => {
  // THE core-ai-tools case: build_command empty and deploy:ci does not build, so
  // nothing produces dist/ and the deploy fails on its first command — while every
  // field looks populated. A presence-only validator would pass this.
  it('fails when nothing builds the output', () => {
    const checks = evaluateTrigger(
      base({ build_command: '', deploy_command: 'pnpm run deploy:ci' }),
      { previewTriggerPresent: false }
    )
    expect(failures(checks)).toContain('something_builds_the_output')
    expect(get(checks, 'something_builds_the_output').reason).toMatch(/does not appear to build/)
    expect(get(checks, 'something_builds_the_output').remedy).toMatch(/build_command/)
  })

  // The config core-ai-tools actually had before the change: build_command empty,
  // but `deploy` self-builds. That genuinely works and must NOT be failed.
  it('passes an empty build command when the deploy command self-builds', () => {
    const checks = evaluateTrigger(
      base({ build_command: '', deploy_command: 'pnpm run build && npx wrangler deploy' }),
      { previewTriggerPresent: false }
    )
    expect(failures(checks)).toEqual([])
    expect(get(checks, 'something_builds_the_output').pass).toBe(true)
  })

  it('passes a split build and deploy, and notes the double build', () => {
    const checks = evaluateTrigger(
      base({
        build_command: 'pnpm run build',
        deploy_command: 'pnpm run build && wrangler deploy'
      }),
      { previewTriggerPresent: false }
    )
    expect(failures(checks)).toEqual([])
    expect(get(checks, 'no_duplicate_build').reason).toMatch(/builds twice/)
  })

  it('fails a missing deploy command', () => {
    const checks = evaluateTrigger(base({ deploy_command: '' }), { previewTriggerPresent: false })
    expect(failures(checks)).toContain('deploy_command_set')
  })
})

describe('evaluateTrigger — the other blocking conditions', () => {
  it('fails with no trigger at all, and says how to create one', () => {
    const checks = evaluateTrigger(null, { previewTriggerPresent: false })
    expect(failures(checks)).toEqual(['trigger_exists'])
    expect(get(checks, 'trigger_exists').remedy).toMatch(/workers_cicd_configure/)
  })

  it('fails a missing repository connection', () => {
    const checks = evaluateTrigger(base({ repo_connection: undefined }), {
      previewTriggerPresent: false
    })
    expect(failures(checks)).toContain('repository_associated')
  })

  it('fails a missing build token and names the tools that fix it', () => {
    const checks = evaluateTrigger(
      base({ build_token_uuid: undefined, build_token_name: undefined }),
      { previewTriggerPresent: false }
    )
    expect(failures(checks)).toContain('build_token_associated')
    expect(get(checks, 'build_token_associated').remedy).toMatch(/workers_build_tokens_list/)
  })

  // An empty branch_includes means no push can ever match, so builds silently
  // never run — which looks identical to "CI is fine" from the outside.
  it('fails empty branch matchers', () => {
    const checks = evaluateTrigger(base({ branch_includes: [] }), { previewTriggerPresent: false })
    expect(failures(checks)).toContain('branch_matchers_set')
  })

  // A missing preview trigger is NOT a failure — the API does not expose implicit
  // PR triggers, so failing on it would report healthy repos as broken.
  it('never fails on a missing preview trigger', () => {
    const checks = evaluateTrigger(base(), { previewTriggerPresent: false })
    expect(get(checks, 'preview_trigger').pass).toBeNull()
    expect(failures(checks)).toEqual([])
  })
})
