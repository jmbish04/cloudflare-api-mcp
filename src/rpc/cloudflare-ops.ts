/**
 * `CloudflareOps` — this Worker's CI/CD tools and Cloudflare provisioning, over a
 * service binding.
 *
 * colby-maestro binds it as `CFOPS` (`entrypoint: "CloudflareOps"`) and its typed
 * client is `backend/cloudflare/ops.ts` in that repo. The method shapes below ARE
 * that contract: change both or neither.
 *
 * **The service binding is the trust boundary.** Only a Worker on this account
 * that declares the binding can reach a named entrypoint — it has no public URL
 * and no route, and the default `fetch` export (OAuth, `/mcp`) is untouched. So,
 * like core-guardian's `GuardianRpc`, no bearer crosses it, and the MCP bearer
 * gate in `mcp.ts` does not apply here by design.
 *
 * **Tokens.**
 * - `callTool` runs through `buildToolContext`, i.e. the USER-scoped
 *   `CLOUDFLARE_USER_WRANGLER_API_TOKEN` — the Builds API refuses the account
 *   token with 401 / 12006 (AGENTS.md, measured fact 1).
 * - Worker scripts and resources (D1, KV, R2, Vectorize, Queues) use the
 *   account-scoped `CLOUDFLARE_WRANGLER_API_TOKEN`, the deploy token. Measured
 *   2026-09-29: it answers 200 on every one of those list endpoints, and it
 *   uploaded and deleted a probe script. It falls back to the user token (which
 *   also answered 200 on all of them) only so a partially-bound deployment still
 *   works rather than failing to start.
 *
 * **Errors.** RPC carries an Error's message and nothing else, so every failure
 * is re-thrown through `toRpcError`, which folds the structured detail into the
 * message. No message ever contains a credential.
 */

import { WorkerEntrypoint } from 'cloudflare:workers'
import { CloudflareBuildsClient } from '../lib/cf-builds'
import {
  createResource,
  createWorker,
  findWorker,
  listResources,
  requireResourceType,
  runToolForRpc,
  toRpcError,
  type Resource,
  type ResourceRef,
  type VectorizeOptions,
  type WorkerRef
} from '../lib/cf-ops'
import { buildToolContext } from '../lib/mcp-local'

/** Recorded in the CI/CD audit trail as the caller. Metadata, never an identity. */
const RPC_ACTOR = 'rpc:colby-maestro'

export class CloudflareOps extends WorkerEntrypoint<Env> {
  /** Any locally-served tool by name: workers_cicd_*, workers_build*, build_patterns_*. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return guard(async () =>
      runToolForRpc(name, args ?? {}, await buildToolContext(this.env, RPC_ACTOR))
    )
  }

  async findWorker(name: string): Promise<WorkerRef> {
    return guard(async () => findWorker(await this.#client(), name))
  }

  /** Idempotent: an existing Worker is returned untouched with `created: false`. */
  async createWorker(name: string): Promise<WorkerRef & { exists: true; created: boolean }> {
    return guard(
      async () =>
        (await createWorker(await this.#client(), name)) as WorkerRef & {
          exists: true
          created: boolean
        }
    )
  }

  async listResources(type: string): Promise<ResourceRef[]> {
    return guard(async () => listResources(await this.#client(), requireResourceType(type)))
  }

  /** Idempotent: an existing resource of that name is returned with `created: false`. */
  async createResource(
    type: string,
    name: string,
    options: VectorizeOptions = {}
  ): Promise<Resource> {
    return guard(async () =>
      createResource(await this.#client(), requireResourceType(type), name, options ?? {})
    )
  }

  async #client(): Promise<CloudflareBuildsClient> {
    const env = this.env
    const accountId = await env.CLOUDFLARE_ACCOUNT_ID.get().catch(() => undefined)
    const token =
      (await env.CLOUDFLARE_WRANGLER_API_TOKEN.get().catch(() => undefined)) ??
      (await env.CLOUDFLARE_USER_WRANGLER_API_TOKEN.get().catch(() => undefined))
    if (!accountId || !token) {
      throw new Error(
        'cloudflare-api-mcp cannot resolve CLOUDFLARE_ACCOUNT_ID and a Cloudflare API token from its Secret Store bindings, so it cannot manage Workers or resources.'
      )
    }
    return new CloudflareBuildsClient({ token, accountId })
  }
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw toRpcError(e)
  }
}
