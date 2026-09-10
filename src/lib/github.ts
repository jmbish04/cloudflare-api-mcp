/**
 * Minimal GitHub REST client — read-only.
 *
 * Used for exactly two things: resolving a repository to the numeric `repo_id`
 * Cloudflare's repo-connection endpoint requires, and reading a pull request's
 * commit/branch metadata so a build can be correlated to it.
 *
 * GitHub is optional. Every caller must handle `GitHubUnavailable` and degrade —
 * a missing GitHub token must never fail a build-log retrieval.
 */

export class GitHubUnavailable extends Error {
  constructor(
    readonly reason: 'no_token' | 'http_error' | 'not_found',
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'GitHubUnavailable'
  }

  toJSON() {
    return {
      error: 'github_unavailable',
      reason: this.reason,
      status: this.status,
      message: this.message
    }
  }
}

export interface GitHubRepo {
  id: number
  full_name: string
  default_branch: string
  owner: { id: number; login: string }
}

export interface GitHubPull {
  number: number
  state: string
  merged: boolean
  merge_commit_sha: string | null
  title: string
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { ref: string; repo: { full_name: string } | null }
}

const API = 'https://api.github.com'
const MAX_ATTEMPTS = 3

export class GitHubClient {
  #token: string | null
  #fetch: typeof fetch

  constructor(token: string | null, fetchImpl?: typeof fetch) {
    this.#token = token
    // Bind: a detached `fetch` stored on an object throws "Illegal invocation"
    // in the Workers runtime when called as a method.
    this.#fetch = fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  get available(): boolean {
    return Boolean(this.#token)
  }

  async #get<T>(path: string): Promise<T> {
    if (!this.#token) {
      throw new GitHubUnavailable(
        'no_token',
        'No GitHub token is bound to this Worker (GH_TOKEN). PR correlation and repository id resolution are unavailable; every other capability still works.'
      )
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const resp = await this.#fetch(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cloudflare-api-mcp',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      })
      if (resp.ok) return (await resp.json()) as T
      if (resp.status === 404) {
        throw new GitHubUnavailable(
          'not_found',
          `GitHub ${path} returned 404 (missing, or the token cannot see it)`,
          404
        )
      }
      const retryable =
        resp.status === 429 ||
        resp.status >= 500 ||
        (resp.status === 403 && resp.headers.get('X-RateLimit-Remaining') === '0')
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new GitHubUnavailable(
          'http_error',
          `GitHub ${path} returned HTTP ${resp.status}`,
          resp.status
        )
      }
      const reset = Number(resp.headers.get('X-RateLimit-Reset'))
      const waitMs = Number.isFinite(reset)
        ? Math.min(Math.max(reset * 1000 - Date.now(), 0), 5000)
        : 250 * 2 ** (attempt - 1)
      await new Promise((r) => setTimeout(r, waitMs))
    }
    throw new GitHubUnavailable('http_error', `GitHub ${path} exhausted retries`)
  }

  getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return this.#get<GitHubRepo>(`/repos/${owner}/${repo}`)
  }

  getPull(owner: string, repo: string, number: number): Promise<GitHubPull> {
    return this.#get<GitHubPull>(`/repos/${owner}/${repo}/pulls/${number}`)
  }

  /** Commits on the PR branch, oldest first. Bounded to one page (100). */
  listPullCommits(
    owner: string,
    repo: string,
    number: number
  ): Promise<Array<{ sha: string; commit: { message: string } }>> {
    return this.#get(`/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`)
  }
}

/** Split `owner/repo`, tolerating a full GitHub URL or a trailing `.git`. */
export function parseRepoRef(ref: string): { owner: string; repo: string } | null {
  const cleaned = ref
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
  const parts = cleaned.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], repo: parts[1] }
}
