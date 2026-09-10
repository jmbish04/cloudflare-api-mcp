# Cloudflare API MCP — Authenticated Proxy

A self-hosted Cloudflare Worker (Astro SSR) that puts your **own OAuth front door** in front of Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode-mcp/) MCP server (`mcp.cloudflare.com/mcp`).

Instead of handing an MCP client your raw Cloudflare API token, you connect the client to **your** worker. The worker authenticates the client (OAuth 2.1 with PKCE, gated by a shared `WORKER_API_KEY`), then forwards MCP traffic upstream using a privileged Cloudflare token that **never leaves the worker**. You keep the token-efficiency of Code Mode (~2,500 endpoints as the `search` / `execute` / `docs` tools) while controlling access and pinning a single account.

```
MCP client (Claude)                 your worker                     upstream
        │                                │                             │
        │  OAuth (authorize/token) ─────►│  gate on WORKER_API_KEY     │
        │  Bearer mcp_at_… ─── /mcp ────►│  swap in CF token ────────► mcp.cloudflare.com/mcp
        │◄──────────── tools / results ──┤◄────────────────────────────┤
```

## What it does

- **Fronts the Cloudflare API MCP server** with your own URL and auth.
- **Keeps the privileged token server-side** — the client only ever holds a short opaque `mcp_at_…` token this worker issues.
- **Injects `account_id`** into `execute` tool calls automatically, so a multi-account user token resolves the right account without the model supplying it.
- **Pairs `search` with docs** — when the agent searches for endpoints, the proxy also queries Cloudflare's separate documentation MCP (`docs.mcp.cloudflare.com`, no privileged token) and appends that context to the result, so the agent gets both the methods/payloads *and* how the product works. Fails safe: if docs can't be fetched, the plain search result is returned unchanged.
- **Serves a landing page + OAuth consent screen** (Astro + React/shadcn/ReUI).
- **Adds 17 Workers CI/CD tools of its own** — see [Workers CI/CD tools](#workers-cicd-tools) below.

## Workers CI/CD tools

Alongside the upstream's `search` / `execute` / `docs`, this worker serves 17 tools for
managing **Cloudflare Workers Builds** — the dashboard CI/CD that builds and deploys a
Worker from a git repository. They exist so a coding agent can look at *why a build failed*
and *stop CI fighting it mid-refactor*, without leaving the MCP session.

Everything is addressed by **Worker name**. Cloudflare's Builds API is keyed by an
immutable internal tag; that is resolved for you on every call and never surfaced as
something you have to know.

| | |
| --- | --- |
| **Inspect & configure** | `workers_cicd_get`, `workers_cicd_configure` |
| **Pause while you work** | `workers_cicd_pause`, `workers_cicd_resume`, `workers_cicd_reconcile` |
| **Builds & logs** | `workers_builds_list`, `workers_build_logs_get`, `workers_build_logs_search`, `workers_pr_build_logs_get` |
| **Failure-pattern library** | `build_patterns_create` / `_get` / `_list` / `_update` / `_delete` / `_test` / `_record_outcome` / `_match` |

**Pausing is lease-based.** Workers Builds has no pause switch, so pausing narrows the
trigger's branch matchers to something no branch can match, having first saved the original.
Several agents can pause the same Worker at once: each holds its own lease, and the
configuration is restored only when the **last** one is released — releasing your lease never
resumes someone else's work. If someone edited the build configuration while it was paused,
the restore stops and shows you the difference rather than silently reverting it.

**Diagnosis is honest about what it knows.** A failed build comes back with its logs, the
rules that made it critical, any matching stored failure pattern (with its confirmed cause,
fix and verification steps), and — for a critical or unrecognised failure — a live Cloudflare
documentation lookup with source URLs and a retrieval timestamp. Observed evidence, known
patterns, documentation guidance and proposed next steps stay in separate fields. A pattern
matching text is reported as *evidence of a possible diagnosis*, never as proof, and no
suggested fix is ever executed.

**PR correlation states its confidence.** Cloudflare does not record a PR number on a build,
so `workers_pr_build_logs_get` correlates from commit SHAs and Cloudflare's own PR
association and tells you which signal fired. A matching branch name alone is reported as
*low* confidence — never as a match.

**Nothing is cached.** These tools are an on-demand proxy: build logs, build metadata, PR
metadata and documentation are fetched live per call and processed in memory. No log is
stored, indexed, tailed or written to the worker's own logs. The worker's D1 database holds
only pause/resume coordination state and the failure-pattern library (redacted signatures and
build IDs — never transcripts). No API token or build-secret value is ever returned.

**When you fix an unknown failure, leave a pattern behind.** That is the point of the
library: the next agent gets your diagnosis instead of re-deriving it. Verifying a pattern
requires evidence — a build UUID and what you observed — so an unconfirmed guess stays marked
`proposed`.

## Connect a client

Point the MCP client at your deployed worker's `/mcp` endpoint:

```json
{
  "mcpServers": {
    "cloudflare-api": {
      "type": "http",
      "url": "https://<your-worker-subdomain>.workers.dev/mcp"
    }
  }
}
```

On first connect the client runs the OAuth flow and opens the worker's **/authorize** page, where you paste your **`WORKER_API_KEY`** (stored in Cloudflare Secrets Store) to approve access. The client then receives a 1‑year token and can list/call the `search`, `execute`, and `docs` tools. (If the connector shows *"no tools available"*, disconnect and reconnect so it re-runs the current PKCE flow.)

## Auth model

| Route | Purpose |
| ----- | ------- |
| `/.well-known/*` | OAuth 2.1 / OpenID discovery metadata |
| `/register` | Dynamic client registration |
| `/authorize` | Consent page — enter `WORKER_API_KEY`; validates `redirect_uri` against the registered client and requires **S256 PKCE**; mints a single-use code |
| `/token` | Exchanges a single-use code (**PKCE verifier required**) for an opaque access token; supports `refresh_token` rotation |
| `/mcp` | Validates the bearer (an issued token in `OAUTH_KV`, or `WORKER_API_KEY` for direct API-key mode), then proxies upstream with the privileged token |

## Deploy

This is an Astro SSR Worker. Deploy with:

```bash
pnpm install
pnpm run deploy    # astro build && wrangler deploy … dist/server/entry.mjs --assets dist/client
```

For Cloudflare Workers Builds (dash CI/CD), set the **Deploy command** to `pnpm run deploy`. See **[DEPLOY.md](./DEPLOY.md)** for the full rationale (entry + assets must be passed on the CLI, not in `wrangler.jsonc`) and the exact dashboard settings.

## Configuration

`wrangler.jsonc` declares the bindings the worker needs:

- **KV:** `SESSION` (Astro sessions), `OAUTH_KV` (issued tokens, auth codes, client registrations)
- **D1:** `CICD_DB` — pause/resume state and the failure-pattern library. Schema is Drizzle (`src/db/schema.ts`): `pnpm run db:generate` to write a migration, `pnpm run db:migrate` to apply it.
- **Secrets Store:** `WORKER_API_KEY` (the access gate), `CLOUDFLARE_WRANGLER_API_TOKEN` (privileged token forwarded upstream), `CLOUDFLARE_USER_WRANGLER_API_TOKEN` (the CI/CD tools — see the note below), `GH_TOKEN` (read-only, for PR correlation), `CLOUDFLARE_ACCOUNT_ID` (injected into `execute`), `REUI_LICENSE_KEY`
- **Var:** `UPSTREAM_MCP_URL` (defaults to `https://mcp.cloudflare.com/mcp`)
- `preview_urls` is `false` — see DEPLOY.md.

`GET /health` reports real checks: the D1 tables, each secret binding resolving, and the
tool count.

> **The Workers Builds API needs a *user*-scoped token.** Measured against the live API: an
> account-scoped Workers token succeeds on `/workers/scripts` and is refused on every
> `/accounts/{id}/builds/*` path with `401 / 12006 Invalid token`. That is why
> `CLOUDFLARE_USER_WRANGLER_API_TOKEN` is a separate binding from the one forwarded upstream.
> It needs **Workers Builds Configuration** (and Workers Scripts : Read to resolve names).

The upstream token can be either a **user token** or an **account token**; for account tokens include **Account Resources : Read** so the account ID auto-detects. API tokens with **Client IP Address Filtering** enabled are not supported.

## Development

```bash
pnpm run dev          # astro dev
pnpm run check        # format:check + lint + typecheck
pnpm run test         # vitest (Workers pool)
pnpm run db:generate  # drizzle-kit → migrations/
pnpm run db:migrate   # apply migrations to the remote D1
pnpm run db:explain   # EXPLAIN QUERY PLAN every hot query; fails if one starts scanning
```

D1 bills by rows **scanned** and rows **written**, so `db:explain` is a real gate,
not a nicety: it runs against the actual database and exits non-zero if a hot query
loses its index. Run it before merging a schema or query change.

See **[AGENTS.md](./AGENTS.md)** for architecture, conventions, and contribution guidance.

## About Code Mode (upstream)

The tools this proxy exposes come from Cloudflare's Code Mode server: the agent writes JavaScript to `search` the OpenAPI spec and `execute` `cloudflare.request()` calls, fitting ~2,500 endpoints into ~1k tokens. Learn more:

- [Code Mode blog post](https://blog.cloudflare.com/code-mode-mcp/)
- [Cloudflare's own MCP servers](https://github.com/cloudflare/mcp-server-cloudflare)
- [Build a remote MCP server](https://developers.cloudflare.com/agents/guides/remote-mcp-server/)
