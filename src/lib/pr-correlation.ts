/**
 * Correlate Cloudflare builds to a GitHub pull request.
 *
 * Cloudflare does NOT store a PR number on a build. What a build carries is
 * `build_trigger_metadata.{branch, commit_hash}` and — when Cloudflare itself
 * associated one — a `pull_request.pull_request_url`. Everything else is
 * inference, so every correlation returned here states which signal fired and
 * how strong it is rather than asserting a match.
 *
 * The rule that shapes the whole file: **a branch name alone does not prove a
 * match.** Branches are reused, deleted and recreated, and a fork's branch name
 * says nothing about this repository. Branch-only evidence is reported as `low`.
 *
 * Pure module: no bindings, no I/O.
 */

import type { Build } from './cf-builds'
import type { GitHubPull } from './github'

export type Confidence = 'exact' | 'high' | 'medium' | 'low'

export interface Correlation {
  build_uuid: string
  created_on?: string
  status?: string
  build_outcome?: string | null
  branch?: string
  commit_hash?: string
  /** Cloudflare's own PR association, when it set one. */
  pull_request_url?: string | null
  /** production | preview | unknown — see `deployKindCaveat`. */
  deploy_kind: 'production' | 'preview' | 'unknown'
  deploy_command?: string | null
  confidence: Confidence
  /** Each signal that fired, in plain language. This is the evidence. */
  evidence: string[]
}

export interface CorrelationInput {
  pull: GitHubPull
  /** Commit shas on the PR branch, when GitHub could be reached. */
  prCommitShas?: string[]
  /** `owner/repo` of the repository Cloudflare builds. */
  baseRepoFullName: string
  /** Branch the Worker's production trigger builds, when known. */
  productionBranch?: string
}

const confidenceRank: Record<Confidence, number> = { exact: 0, high: 1, medium: 2, low: 3 }

/** True when the PR's head lives in a different repository (a fork PR). */
export function isForkPull(pull: GitHubPull, baseRepoFullName: string): boolean {
  const headRepo = pull.head.repo?.full_name
  return Boolean(headRepo && headRepo.toLowerCase() !== baseRepoFullName.toLowerCase())
}

function classifyDeployKind(
  build: Build,
  productionBranch?: string
): { kind: Correlation['deploy_kind']; caveat?: string } {
  const branch = build.build_trigger_metadata?.branch
  if (!branch) return { kind: 'unknown' }
  if (productionBranch) {
    return { kind: branch === productionBranch ? 'production' : 'preview' }
  }
  const includes = build.trigger?.branch_includes ?? []
  if (includes.length && includes.includes(branch)) return { kind: 'production' }
  return {
    kind: 'unknown',
    caveat:
      'No production branch was resolvable for this Worker, so production vs preview could not be determined from the build alone.'
  }
}

/**
 * Score one build against one PR. Returns null when no signal fires at all.
 */
export function correlateBuild(build: Build, input: CorrelationInput): Correlation | null {
  const meta = build.build_trigger_metadata
  const sha = (meta?.commit_hash ?? '').toLowerCase()
  const branch = meta?.branch
  const evidence: string[] = []
  let confidence: Confidence | null = null

  const prUrl = build.pull_request?.pull_request_url ?? null
  if (prUrl && new RegExp(`/pull/${input.pull.number}(?:$|[/?#])`).test(prUrl)) {
    evidence.push(`Cloudflare recorded this build against ${prUrl}`)
    confidence = 'exact'
  }

  const headSha = input.pull.head.sha.toLowerCase()
  if (sha && sha === headSha) {
    evidence.push(`Build commit ${sha.slice(0, 12)} is the PR's current head commit`)
    confidence = confidence ?? 'high'
  } else if (
    sha &&
    input.pull.merge_commit_sha &&
    sha === input.pull.merge_commit_sha.toLowerCase()
  ) {
    evidence.push(`Build commit ${sha.slice(0, 12)} is the PR's merge commit`)
    confidence = confidence ?? 'high'
  } else if (sha && input.prCommitShas?.some((s) => s.toLowerCase() === sha)) {
    evidence.push(
      `Build commit ${sha.slice(0, 12)} is an earlier commit on the PR branch (superseded by a later push or a force-push)`
    )
    confidence = confidence ?? 'medium'
  }

  const fork = isForkPull(input.pull, input.baseRepoFullName)
  if (branch && branch === input.pull.head.ref) {
    if (fork) {
      evidence.push(
        `Build branch "${branch}" equals the PR head ref, but this is a fork PR (head repo ${input.pull.head.repo?.full_name}) — a matching branch name in a different repository is weak evidence`
      )
      confidence = confidence ?? 'low'
    } else {
      evidence.push(
        `Build branch "${branch}" equals the PR head ref, but a branch name alone can be reused or recreated`
      )
      confidence = confidence ?? 'low'
    }
  }

  if (!confidence) return null

  const kind = classifyDeployKind(build, input.productionBranch)
  if (kind.caveat) evidence.push(kind.caveat)
  if (input.pull.merged && confidence !== 'exact') {
    evidence.push(
      'The PR is merged; builds on the base branch after the merge are attributable to the merge/squash commit, not to the PR branch.'
    )
  }

  return {
    build_uuid: build.build_uuid,
    created_on: build.created_on,
    status: build.status,
    build_outcome: build.build_outcome ?? null,
    branch,
    commit_hash: meta?.commit_hash,
    pull_request_url: prUrl,
    deploy_kind: kind.kind,
    deploy_command: meta?.deploy_command ?? null,
    confidence,
    evidence
  }
}

/**
 * Correlate a whole build list, strongest evidence first.
 *
 * Multiple builds for one PR is the normal case, not an error — each push
 * produces one, and a merged PR adds builds on the base branch. They are all
 * returned, ordered, so the caller can pick rather than being handed one build
 * that was guessed at.
 */
export function correlatePullRequest(
  builds: Build[],
  input: CorrelationInput
): { correlations: Correlation[]; best: Correlation | null } {
  const correlations = builds
    .map((b) => correlateBuild(b, input))
    .filter((c): c is Correlation => c !== null)
    .sort(
      (a, b) =>
        confidenceRank[a.confidence] - confidenceRank[b.confidence] ||
        Date.parse(b.created_on ?? '') - Date.parse(a.created_on ?? '')
    )
  return { correlations, best: correlations[0] ?? null }
}
