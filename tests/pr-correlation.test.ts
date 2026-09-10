import { describe, expect, it } from 'vitest'
import { correlateBuild, correlatePullRequest, isForkPull } from '../src/lib/pr-correlation'
import type { Build } from '../src/lib/cf-builds'
import type { GitHubPull } from '../src/lib/github'

const pull = (over: Partial<GitHubPull> = {}): GitHubPull => ({
  number: 42,
  state: 'open',
  merged: false,
  merge_commit_sha: null,
  title: 'Add thing',
  head: { ref: 'feature/x', sha: 'aaaa1111bbbb2222', repo: { full_name: 'owner/repo' } },
  base: { ref: 'main', repo: { full_name: 'owner/repo' } },
  ...over
})

const build = (over: Partial<Build> & { build_uuid: string }): Build => ({
  created_on: '2026-09-01T00:00:00.000Z',
  status: 'stopped',
  build_outcome: 'success',
  build_trigger_metadata: { branch: 'feature/x', commit_hash: 'aaaa1111bbbb2222' },
  ...over
})

const input = { pull: pull(), baseRepoFullName: 'owner/repo', productionBranch: 'main' }

describe('correlateBuild confidence', () => {
  it("treats Cloudflare's own pull_request association as exact", () => {
    const b = build({
      build_uuid: 'b1',
      pull_request: { pull_request_url: 'https://github.com/owner/repo/pull/42' }
    })
    const c = correlateBuild(b, input)!
    expect(c.confidence).toBe('exact')
    expect(c.evidence[0]).toMatch(/Cloudflare recorded/)
  })

  it('does not match a different PR number that shares a prefix', () => {
    const b = build({
      build_uuid: 'b1',
      pull_request: { pull_request_url: 'https://github.com/owner/repo/pull/420' },
      build_trigger_metadata: { branch: 'other', commit_hash: 'ffff' }
    })
    expect(correlateBuild(b, input)).toBeNull()
  })

  it('rates the head commit high', () => {
    const c = correlateBuild(build({ build_uuid: 'b' }), input)!
    expect(c.confidence).toBe('high')
    expect(c.evidence.join(' ')).toMatch(/current head commit/)
  })

  it('rates a superseded commit on the branch medium and says why', () => {
    const b = build({
      build_uuid: 'b',
      build_trigger_metadata: { branch: 'feature/x', commit_hash: 'cccc3333' }
    })
    const c = correlateBuild(b, { ...input, prCommitShas: ['cccc3333', 'aaaa1111bbbb2222'] })!
    expect(c.confidence).toBe('medium')
    expect(c.evidence.join(' ')).toMatch(/force-push/)
  })

  it('rates branch-name-only evidence LOW and never claims proof', () => {
    const b = build({
      build_uuid: 'b',
      build_trigger_metadata: { branch: 'feature/x', commit_hash: 'unrelated999' }
    })
    const c = correlateBuild(b, input)!
    expect(c.confidence).toBe('low')
    expect(c.evidence.join(' ')).toMatch(/branch name alone/)
  })

  it('flags a fork PR in the evidence', () => {
    const forked = pull({
      head: { ref: 'feature/x', sha: 'zzz', repo: { full_name: 'someoneelse/repo' } }
    })
    const b = build({
      build_uuid: 'b',
      build_trigger_metadata: { branch: 'feature/x', commit_hash: 'nope' }
    })
    const c = correlateBuild(b, { ...input, pull: forked })!
    expect(c.confidence).toBe('low')
    expect(c.evidence.join(' ')).toMatch(/fork PR/)
    expect(isForkPull(forked, 'owner/repo')).toBe(true)
  })

  it('recognises the merge commit of a merged PR', () => {
    const merged = pull({ merged: true, merge_commit_sha: 'dddd4444' })
    const b = build({
      build_uuid: 'b',
      build_trigger_metadata: { branch: 'main', commit_hash: 'dddd4444' }
    })
    const c = correlateBuild(b, { ...input, pull: merged })!
    expect(c.confidence).toBe('high')
    expect(c.deploy_kind).toBe('production')
    expect(c.evidence.join(' ')).toMatch(/merge commit/)
  })

  it('classifies a non-production branch as preview', () => {
    expect(correlateBuild(build({ build_uuid: 'b' }), input)!.deploy_kind).toBe('preview')
  })

  it('returns null when nothing at all lines up', () => {
    const b = build({
      build_uuid: 'b',
      build_trigger_metadata: { branch: 'other', commit_hash: 'zzz' }
    })
    expect(correlateBuild(b, input)).toBeNull()
  })
})

describe('correlatePullRequest', () => {
  it('returns every matching build, strongest evidence first', () => {
    const builds = [
      build({
        build_uuid: 'weak',
        build_trigger_metadata: { branch: 'feature/x', commit_hash: 'zzz' }
      }),
      build({ build_uuid: 'strong' }),
      build({
        build_uuid: 'exact',
        pull_request: { pull_request_url: 'https://github.com/owner/repo/pull/42' }
      })
    ]
    const { correlations, best } = correlatePullRequest(builds, input)
    expect(correlations.map((c) => c.build_uuid)).toEqual(['exact', 'strong', 'weak'])
    expect(best!.build_uuid).toBe('exact')
  })
})
