/**
 * Worker and resource provisioning, plus tool dispatch, for the `CloudflareOps`
 * RPC entrypoint (`src/rpc/cloudflare-ops.ts`).
 *
 * Everything here takes its Cloudflare client (and so its `fetch`) as a
 * parameter, so it is unit-testable against a fake API with no bindings — the
 * same rule `src/lib/*` follows everywhere else in this repo.
 *
 * Two properties are load-bearing, and both are about idempotency:
 *
 * 1. **Create is look-up-first.** `createResource` and `createWorker` list what
 *    exists before creating, and reuse a same-named resource with
 *    `created: false`. A caller (colby-maestro provisioning a project) can retry
 *    a half-finished run without minting a second D1 database or a second Worker
 *    identity — Dynamic Workers is a consumed allocation (715 / 1,000 measured
 *    2026-09-19), not a rented one.
 * 2. **A listing is never concluded from a partial read.** The idempotency check
 *    is only as good as the listing behind it: "not in the first page" is not
 *    "absent". Every list endpoint is paged to its end, and one that does not
 *    reach its end inside `MAX_PAGES` THROWS rather than returning a short list.
 *    Measured 2026-09-29 against the live account: D1 holds 387 databases and KV
 *    397 namespaces, and the Queues endpoint silently caps `per_page` at 500
 *    while echoing the capped value — so the stop condition trusts
 *    `total_pages` / `total_count` / the echoed `per_page`, never the requested
 *    page size.
 */

import { CloudflareApiError, type CloudflareBuildsClient, type ResultInfo } from './cf-builds'
import { GitHubUnavailable } from './github'
import { LOCAL_TOOLS } from './mcp-local'
import { ToolError, type ToolContext } from './tools/context'

export type ResourceType = 'd1' | 'kv' | 'r2' | 'vectorize' | 'queue'
export type VectorizeMetric = 'cosine' | 'euclidean' | 'dot-product'
export type VectorizeOptions = { dimensions?: number; metric?: VectorizeMetric }
export type ResourceRef = { name: string; id: string }
export type Resource = ResourceRef & { type: ResourceType; created: boolean }
export type WorkerRef = { name: string; exists: boolean; tag: string | null }

/** Page size asked for. Servers may cap it (Queues does, to 500) — see header. */
export const PER_PAGE = 1000
/** ponytail: 50 pages x 500 minimum = 25k resources before we refuse; raise if an account ever gets there. */
export const MAX_PAGES = 50

type Paging = 'page' | 'cursor' | 'none'

interface ResourceSpec {
  path: string
  paging: Paging
  /** Pull the item array out of `result` (R2 nests it under `buckets`). */
  items: (result: unknown) => Array<Record<string, unknown>>
  ref: (item: Record<string, unknown>) => ResourceRef
  createBody: (name: string, options: VectorizeOptions) => Record<string, unknown>
  /** The wrangler.jsonc reference for a freshly created resource. */
  createdId: (result: Record<string, unknown>, name: string) => string
}

const asList = (r: unknown) => (Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [])
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * Endpoint shapes, each verified against the live API on 2026-09-29:
 * D1 items carry `uuid`, KV items `id` + `title`, R2 is cursor-paged under
 * `result.buckets`, Vectorize v2 is unpaged, Queues items carry `queue_name`.
 * For R2, Vectorize and Queues the NAME is what wrangler.jsonc references, so
 * `id` is the name.
 */
export const RESOURCE_SPECS: Record<ResourceType, ResourceSpec> = {
  d1: {
    path: '/d1/database',
    paging: 'page',
    items: asList,
    ref: (i) => ({ name: str(i.name), id: str(i.uuid) }),
    createBody: (name) => ({ name }),
    createdId: (r) => str(r.uuid)
  },
  kv: {
    path: '/storage/kv/namespaces',
    paging: 'page',
    items: asList,
    ref: (i) => ({ name: str(i.title), id: str(i.id) }),
    createBody: (name) => ({ title: name }),
    createdId: (r) => str(r.id)
  },
  r2: {
    path: '/r2/buckets',
    paging: 'cursor',
    items: (r) => asList((r as { buckets?: unknown } | null)?.buckets),
    ref: (i) => ({ name: str(i.name), id: str(i.name) }),
    createBody: (name) => ({ name }),
    createdId: (_r, name) => name
  },
  vectorize: {
    path: '/vectorize/v2/indexes',
    paging: 'none',
    items: asList,
    ref: (i) => ({ name: str(i.name), id: str(i.name) }),
    createBody: (name, o) => ({
      name,
      config: { dimensions: o.dimensions ?? 768, metric: o.metric ?? 'cosine' }
    }),
    createdId: (_r, name) => name
  },
  queue: {
    path: '/queues',
    paging: 'page',
    items: asList,
    ref: (i) => ({ name: str(i.queue_name), id: str(i.queue_name) }),
    createBody: (name) => ({ queue_name: name }),
    createdId: (_r, name) => name
  }
}

export function requireResourceType(type: unknown): ResourceType {
  if (typeof type === 'string' && type in RESOURCE_SPECS) return type as ResourceType
  throw new Error(
    `Unknown resource type ${JSON.stringify(type)}. Expected one of: ${Object.keys(RESOURCE_SPECS).join(', ')}.`
  )
}

function requireName(name: unknown, what: string): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`${what} name is required and must be a non-empty string.`)
  }
  return name.trim()
}

/** Has a page-numbered listing reached its end? Trusts what the server echoed. */
function lastPage(info: ResultInfo | undefined, page: number, got: number, total: number): boolean {
  if (got === 0) return true
  if (typeof info?.total_pages === 'number') return page >= info.total_pages
  if (typeof info?.total_count === 'number') return total >= info.total_count
  return got < (info?.per_page ?? PER_PAGE)
}

/** Every item of one resource type, or a throw. Never a silently short list. */
export async function listResources(
  cf: CloudflareBuildsClient,
  type: ResourceType
): Promise<ResourceRef[]> {
  const spec = RESOURCE_SPECS[type]
  const out: ResourceRef[] = []

  if (spec.paging === 'none') {
    const { result } = await cf.request<unknown>('GET', spec.path)
    return spec.items(result).map(spec.ref)
  }

  let cursor: string | undefined
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query =
      spec.paging === 'page' ? { page, per_page: PER_PAGE } : { per_page: PER_PAGE, cursor }
    const { result, resultInfo } = await cf.request<unknown>('GET', spec.path, { query })
    const items = spec.items(result)
    out.push(...items.map(spec.ref))
    if (spec.paging === 'cursor') {
      cursor = resultInfo?.cursor || undefined
      if (!cursor || items.length === 0) return out
    } else if (lastPage(resultInfo, page, items.length, out.length)) {
      return out
    }
  }
  throw new Error(
    `Listing ${type} did not reach its last page within ${MAX_PAGES} pages (${out.length} read). Refusing to answer from a partial list: an idempotency check against it could create a duplicate.`
  )
}

/** Idempotent: an existing resource of that name is returned with `created: false`. */
export async function createResource(
  cf: CloudflareBuildsClient,
  type: ResourceType,
  rawName: string,
  options: VectorizeOptions = {}
): Promise<Resource> {
  const spec = RESOURCE_SPECS[type]
  const name = requireName(rawName, type)
  if (type === 'vectorize') validateVectorize(options)

  const existing = (await listResources(cf, type)).find((r) => r.name === name)
  if (existing) return { type, ...existing, created: false }

  try {
    const { result } = await cf.request<Record<string, unknown>>('POST', spec.path, {
      body: spec.createBody(name, options)
    })
    return { type, name, id: spec.createdId(result ?? {}, name), created: true }
  } catch (e) {
    // A concurrent caller may have created it between our list and our POST.
    // Re-read once: if it is there now, that is the same outcome as reuse.
    if (e instanceof CloudflareApiError) {
      const raced = (await listResources(cf, type)).find((r) => r.name === name)
      if (raced) return { type, ...raced, created: false }
    }
    throw e
  }
}

function validateVectorize(o: VectorizeOptions): void {
  if (o.dimensions !== undefined && !(Number.isInteger(o.dimensions) && o.dimensions > 0)) {
    throw new Error(`Vectorize dimensions must be a positive integer, got ${o.dimensions}.`)
  }
  if (o.metric !== undefined && !['cosine', 'euclidean', 'dot-product'].includes(o.metric)) {
    throw new Error(
      `Vectorize metric must be cosine, euclidean or dot-product, got ${JSON.stringify(o.metric)}.`
    )
  }
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

/**
 * What an empty Worker answers until Workers Builds deploys the real one over it.
 * 503 + Retry-After, so a monitor reads "not ready", never "healthy".
 */
export const PLACEHOLDER_MODULE = `export default {
  fetch() {
    return new Response('provisioning: this Worker has not been deployed yet', {
      status: 503,
      headers: { 'retry-after': '60', 'content-type': 'text/plain' }
    })
  }
}
`
/** ponytail: pinned to this repo's own compatibility_date; the first real deploy replaces it. */
export const PLACEHOLDER_COMPATIBILITY_DATE = '2026-01-12'

// Cloudflare's rule: lowercase alphanumerics and dashes, 63 chars, no edge dash.
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export async function findWorker(cf: CloudflareBuildsClient, rawName: string): Promise<WorkerRef> {
  const name = requireName(rawName, 'Worker')
  const tag = await cf.resolveWorkerTag(name)
  return { name, exists: tag !== null, tag }
}

/**
 * Idempotent. An existing Worker is returned untouched with `created: false`.
 *
 * Creation is a script upload (`PUT /workers/scripts/{name}`, multipart ES
 * module), NOT the newer `POST /workers/workers`. Measured 2026-09-29: a Worker
 * made through the Workers API with no deployment does not appear in
 * `GET /workers/scripts` (221 Workers vs 220 scripts; the odd one out was the
 * undeployed one), and `/workers/scripts` is how every CI/CD tool here resolves
 * a name to a tag — so such a Worker could not be connected to Workers Builds by
 * `workers_cicd_configure`. A script upload appears there immediately, its
 * response carries the tag, and `GET /builds/workers/{tag}/triggers` answers
 * 200 [] for it. Verified once with `cfops-rpc-probe`, then deleted.
 */
export async function createWorker(
  cf: CloudflareBuildsClient,
  rawName: string
): Promise<WorkerRef & { created: boolean }> {
  const found = await findWorker(cf, rawName)
  if (found.exists) return { ...found, exists: true, created: false }
  if (!WORKER_NAME.test(found.name)) {
    throw new Error(
      `"${found.name}" is not a valid Worker name: lowercase letters, digits and dashes, at most 63 characters, not starting or ending with a dash.`
    )
  }

  const form = new FormData()
  form.append(
    'metadata',
    new Blob(
      [
        JSON.stringify({
          main_module: 'index.js',
          compatibility_date: PLACEHOLDER_COMPATIBILITY_DATE
        })
      ],
      { type: 'application/json' }
    )
  )
  form.append(
    'index.js',
    new Blob([PLACEHOLDER_MODULE], { type: 'application/javascript+module' }),
    'index.js'
  )
  const { result } = await cf.request<{ id?: string; tag?: string }>(
    'PUT',
    `/workers/scripts/${encodeURIComponent(found.name)}`,
    { body: form }
  )
  const tag = result?.tag ?? (await cf.resolveWorkerTag(found.name))
  if (!tag) {
    throw new Error(
      `Uploaded a placeholder for Worker "${found.name}" but Cloudflare returned no tag and /workers/scripts does not list it yet. Call findWorker again before retrying createWorker.`
    )
  }
  return { name: found.name, exists: true, tag, created: true }
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

/**
 * The Worker whose build token a `workers_cicd_configure` CREATE borrows when the
 * caller supplies none. The account has ~48 build tokens, most minted per-Worker
 * by the dashboard, so "the account's token" does not exist; the token already
 * deploying colby-maestro (and, measured 2026-09-29, core-guardian, core-sg-data,
 * core-vetting, mailflare and others) is a known-working choice, and the result
 * names it so the choice is visible, never silent.
 */
export const BUILD_TOKEN_SOURCE_WORKER = 'colby-maestro'

export type DefaultedBuildToken = {
  build_token_uuid: string
  build_token_name: string | null
  source: string
}

export async function defaultBuildToken(ctx: ToolContext): Promise<DefaultedBuildToken | null> {
  const tag = await ctx.cf.resolveWorkerTag(BUILD_TOKEN_SOURCE_WORKER)
  if (!tag) return null
  const trigger = (await ctx.cf.listTriggers(tag)).find((t) => t.build_token_uuid)
  if (!trigger?.build_token_uuid) return null
  return {
    build_token_uuid: trigger.build_token_uuid,
    build_token_name: trigger.build_token_name ?? null,
    source: `build token of Worker "${BUILD_TOKEN_SOURCE_WORKER}"'s trigger ${trigger.trigger_uuid}`
  }
}

/**
 * A thrown value RPC can carry. RPC propagates an Error's message, not its
 * subclass or fields, so the structured detail is folded into the message.
 * Nothing folded in carries a credential: ToolError details, CloudflareApiError
 * and GitHubUnavailable all serialise only status, path, codes and messages.
 */
export function toRpcError(e: unknown): Error {
  if (e instanceof ToolError) {
    const details = e.details ? ` ${JSON.stringify(e.details).slice(0, 2000)}` : ''
    return new Error(`${e.code}: ${e.message}${details}`)
  }
  if (e instanceof CloudflareApiError || e instanceof GitHubUnavailable) return new Error(e.message)
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * Run a locally-served MCP tool by name and return its raw payload (not the MCP
 * text envelope — an RPC caller wants the object).
 *
 * `workers_cicd_configure` gets one extra: a CREATE with no `build_token_uuid`
 * is retried once with `defaultBuildToken`, and the result says so under
 * `build_token_defaulted`. It is keyed on the tool's own refusal (the create
 * path's `missing_prerequisite` carrying `available_build_tokens`) so an UPDATE
 * is never given a token it did not ask for — an update keeps its current token.
 */
export async function runToolForRpc(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const tool = LOCAL_TOOLS.find((t) => t.name === name)
  if (!tool) {
    throw new Error(
      `Unknown tool "${name}". Tools served by cloudflare-api-mcp: ${LOCAL_TOOLS.map((t) => t.name).join(', ')}.`
    )
  }
  try {
    return await tool.handler(args, ctx)
  } catch (e) {
    const tokenRefusal =
      name === 'workers_cicd_configure' &&
      !args.build_token_uuid &&
      e instanceof ToolError &&
      e.code === 'missing_prerequisite' &&
      Array.isArray(e.details?.available_build_tokens)
    if (!tokenRefusal) throw toRpcError(e)

    const token = await defaultBuildToken(ctx).catch(() => null)
    if (!token) throw toRpcError(e)
    try {
      const result = await tool.handler({ ...args, build_token_uuid: token.build_token_uuid }, ctx)
      return { ...(result as Record<string, unknown>), build_token_defaulted: token }
    } catch (retry) {
      throw toRpcError(retry)
    }
  }
}
