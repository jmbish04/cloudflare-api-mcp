/**
 * Cloudflare Workers Scripts + Workers Builds REST client.
 *
 * Every endpoint and field here was verified against the live API on 2026-09-10
 * (account 126colby, Worker `cloudflare-api-mcp`), not inferred from docs:
 *
 *   GET   /accounts/{acct}/workers/scripts                     -> [{ id (name), tag }]
 *   GET   /accounts/{acct}/builds/workers/{tag}/triggers       -> Trigger[]
 *   POST  /accounts/{acct}/builds/triggers                     -> Trigger   (create)
 *   PATCH /accounts/{acct}/builds/triggers/{uuid}              -> Trigger   (PARTIAL update)
 *   PUT   /accounts/{acct}/builds/repos/connections            -> RepoConnection
 *   GET   /accounts/{acct}/builds/tokens                       -> BuildToken[]
 *   GET   /accounts/{acct}/builds/workers/{tag}/builds         -> Build[]  (page/per_page only)
 *   GET   /accounts/{acct}/builds/builds/{uuid}/logs           -> { cursor, truncated, lines, events }
 *   PUT   /accounts/{acct}/builds/builds/{uuid}/cancel
 *
 * Two measured facts that shape this file:
 *
 * 1. **The Builds API needs a USER-scoped token.** The account-scoped
 *    `CLOUDFLARE_WRANGLER_API_TOKEN` this Worker already carries is refused with
 *    HTTP 401 / code 12006 "Invalid token" on every `/builds/*` path, while a user
 *    token with "Workers Builds Configuration" succeeds. That is why the caller
 *    passes a separate token in.
 * 2. **List-builds supports no filtering or sorting** — only `page`/`per_page`.
 *    Branch/status/commit/date filtering is therefore done here, client-side, over
 *    however many upstream pages the requested window needs, and every result
 *    reports the coverage actually achieved.
 */

export interface RepoConnection {
  repo_connection_uuid: string
  repo_id: string
  repo_name: string
  provider_type: string
  provider_account_id: string
  provider_account_name: string
  grant_id: string | null
  created_on?: string
  modified_on?: string
  deleted_on?: string | null
}

export interface Trigger {
  trigger_uuid: string
  external_script_id: string
  build_token_uuid?: string
  build_token_name?: string
  trigger_name?: string
  build_command?: string | null
  deploy_command?: string | null
  root_directory?: string | null
  branch_includes?: string[]
  branch_excludes?: string[]
  path_includes?: string[]
  path_excludes?: string[]
  build_caching_enabled?: boolean
  created_on?: string
  modified_on?: string
  deleted_on?: string | null
  repo_connection?: RepoConnection
}

export interface BuildTriggerMetadata {
  build_trigger_source?: string
  branch?: string
  commit_hash?: string
  commit_message?: string
  author?: string
  build_command?: string
  deploy_command?: string
  root_directory?: string
  build_token_uuid?: string
  build_token_name?: string
  environment_variables?: Record<string, unknown> | null
  repo_name?: string
  provider_account_name?: string
  provider_type?: string
}

export interface Build {
  build_uuid: string
  status?: string
  build_outcome?: string | null
  created_on?: string
  initializing_on?: string | null
  running_on?: string | null
  stopped_on?: string | null
  modified_on?: string
  trigger?: Trigger
  build_trigger_metadata?: BuildTriggerMetadata
  pull_request?: { pull_request_url?: string; created_on?: string } | null
  deploy_hook?: unknown
}

/** Raw shape of `GET /builds/builds/{uuid}/logs` — verified live. */
export interface BuildLogsPage {
  /** Opaque tail cursor. Replaying it returns zero lines; pass it to continue. */
  cursor: string | null
  /** True when more lines are available beyond this page. */
  truncated: boolean
  /** `[epochMillis, text]` tuples. */
  lines: Array<[number, string]>
  events: Array<{ type: string; started_on?: string; ended_on?: string }>
}

export interface BuildToken {
  build_token_uuid: string
  build_token_name?: string
  owner_type?: string
  cloudflare_token_id?: string
}

/** A structured, actionable failure. Never carries the request's credential. */
export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly method: string,
    readonly errors: Array<{ code?: number; message?: string }>,
    readonly hint?: string
  ) {
    super(
      `Cloudflare API ${method} ${path} failed (HTTP ${status}): ${
        errors.map((e) => `${e.code ?? '?'} ${e.message ?? ''}`.trim()).join('; ') ||
        'no error detail'
      }${hint ? ` — ${hint}` : ''}`
    )
    this.name = 'CloudflareApiError'
  }

  toJSON() {
    return {
      error: 'cloudflare_api_error',
      status: this.status,
      method: this.method,
      path: this.path,
      errors: this.errors,
      hint: this.hint
    }
  }
}

const API_BASE = 'https://api.cloudflare.com/client/v4'

// Retries are bounded and only cover transient conditions. A 4xx other than 429 is
// a contract problem — retrying it just burns the caller's time and rate budget.
const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 250

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function permissionHint(status: number, errors: Array<{ code?: number }>): string | undefined {
  const codes = errors.map((e) => e.code)
  if (status === 401 && codes.includes(12006)) {
    return 'The Workers Builds API requires a USER-scoped API token with "Workers Builds Configuration". An account-scoped Workers token is rejected here with exactly this error even though it works for /workers/scripts. Bind CLOUDFLARE_USER_WRANGLER_API_TOKEN.'
  }
  if (status === 403) return 'Token authenticated but lacks the permission for this resource.'
  return undefined
}

export class CloudflareBuildsClient {
  #token: string
  #accountId: string
  #fetch: typeof fetch

  constructor(opts: { token: string; accountId: string; fetchImpl?: typeof fetch }) {
    this.#token = opts.token
    this.#accountId = opts.accountId
    // Bind: the Workers runtime rejects a detached `fetch` with "Illegal
    // invocation" when it is stored on an object and called as a method.
    this.#fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  get accountId(): string {
    return this.#accountId
  }

  async #request<T>(
    method: string,
    path: string,
    init?: { body?: unknown; query?: Record<string, string | number | undefined> }
  ): Promise<{ result: T; resultInfo?: ResultInfo }> {
    const url = new URL(`${API_BASE}/accounts/${this.#accountId}${path}`)
    for (const [k, v] of Object.entries(init?.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }

    let lastError: CloudflareApiError | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const resp = await this.#fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body)
      })

      const text = await resp.text()
      let parsed: CfEnvelope<T> | null = null
      try {
        parsed = text ? (JSON.parse(text) as CfEnvelope<T>) : null
      } catch {
        parsed = null
      }

      if (resp.ok && parsed?.success) {
        return { result: parsed.result as T, resultInfo: parsed.result_info }
      }

      const errors = parsed?.errors ?? [{ message: text.slice(0, 300) || resp.statusText }]
      lastError = new CloudflareApiError(
        resp.status,
        path,
        method,
        errors,
        permissionHint(resp.status, errors)
      )

      const retryable = resp.status === 429 || resp.status >= 500
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError

      // Honour Retry-After when the server sends one; otherwise exponential backoff.
      const retryAfter = Number(resp.headers.get('Retry-After'))
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : BASE_BACKOFF_MS * 2 ** (attempt - 1)
      )
    }
    throw lastError as CloudflareApiError
  }

  /**
   * Resolve a user-facing Worker NAME to Cloudflare's immutable tag.
   *
   * Every Builds endpoint is keyed by the tag (`external_script_id`); using the
   * name yields a bare "Resource not found". The tag is never the user's
   * identifier — it is resolved here and kept internal.
   */
  async resolveWorkerTag(workerName: string): Promise<string | null> {
    // /workers/scripts is unpaginated in practice but bounded here anyway.
    const { result } = await this.#request<Array<{ id: string; tag: string }>>(
      'GET',
      '/workers/scripts'
    )
    return result.find((s) => s.id === workerName)?.tag ?? null
  }

  async listTriggers(workerTag: string): Promise<Trigger[]> {
    const { result } = await this.#request<Trigger[]>(
      'GET',
      `/builds/workers/${workerTag}/triggers`
    )
    return (result ?? []).filter((t) => !t.deleted_on)
  }

  async createTrigger(body: Record<string, unknown>): Promise<Trigger> {
    const { result } = await this.#request<Trigger>('POST', '/builds/triggers', { body })
    return result
  }

  /**
   * Partial update. VERIFIED: fields absent from the body are preserved — a PATCH
   * of `{build_caching_enabled}` left build_command/deploy_command/branch_includes
   * untouched. That is what makes "omission != removal" implementable.
   */
  async updateTrigger(triggerUuid: string, body: Record<string, unknown>): Promise<Trigger> {
    const { result } = await this.#request<Trigger>('PATCH', `/builds/triggers/${triggerUuid}`, {
      body
    })
    return result
  }

  async upsertRepoConnection(body: {
    provider_type: string
    provider_account_id: string
    provider_account_name: string
    repo_id: string
    repo_name: string
  }): Promise<RepoConnection> {
    const { result } = await this.#request<RepoConnection>('PUT', '/builds/repos/connections', {
      body
    })
    return result
  }

  async listBuildTokens(): Promise<BuildToken[]> {
    const { result } = await this.#request<BuildToken[]>('GET', '/builds/tokens')
    return result ?? []
  }

  async listBuildsPage(
    workerTag: string,
    page: number,
    perPage: number
  ): Promise<{ builds: Build[]; info?: ResultInfo }> {
    const { result, resultInfo } = await this.#request<Build[]>(
      'GET',
      `/builds/workers/${workerTag}/builds`,
      { query: { page, per_page: perPage } }
    )
    return { builds: result ?? [], info: resultInfo }
  }

  async getBuildLogsPage(buildUuid: string, cursor?: string): Promise<BuildLogsPage> {
    const { result } = await this.#request<BuildLogsPage>(
      'GET',
      `/builds/builds/${buildUuid}/logs`,
      {
        query: { cursor }
      }
    )
    return {
      cursor: result?.cursor ?? null,
      truncated: Boolean(result?.truncated),
      lines: result?.lines ?? [],
      events: result?.events ?? []
    }
  }

  async cancelBuild(buildUuid: string): Promise<unknown> {
    const { result } = await this.#request<unknown>('PUT', `/builds/builds/${buildUuid}/cancel`)
    return result
  }
}

export interface ResultInfo {
  page?: number
  per_page?: number
  count?: number
  total_count?: number
  total_pages?: number
  next_page?: boolean
}

interface CfEnvelope<T> {
  success: boolean
  result: T
  errors?: Array<{ code?: number; message?: string }>
  messages?: unknown[]
  result_info?: ResultInfo
}
