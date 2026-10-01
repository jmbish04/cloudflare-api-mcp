# AGENTS.md

## Project overview

This repository is an **Astro SSR application deployed as a Cloudflare Worker** that acts as an **authenticated OAuth proxy** in front of Cloudflare's Code Mode MCP server (`mcp.cloudflare.com/mcp`).

An MCP client (e.g. Claude) connects to *this* worker's `/mcp` endpoint. The worker runs its own OAuth 2.1 + PKCE flow — gated by a shared `WORKER_API_KEY` entered on the consent page — issues the client a short opaque token, and forwards MCP traffic upstream using a privileged Cloudflare API token that never leaves the worker. It also injects the configured `account_id` into `execute` tool calls.

It is **not** the Code Mode server itself; it proxies to it. The `search` / `execute` / `docs` tools the client sees are served by the upstream.

It **also serves 17 tools of its own** for managing Cloudflare **Workers Builds** (CI/CD): inspecting and configuring build triggers, lease-based pause/resume while an agent works on a repo, listing builds, retrieving and searching build logs, correlating a GitHub PR to its builds, and a D1-backed library of reusable build-failure patterns. These are answered locally and spliced into the same MCP session — see [Local CI/CD tools](#local-cicd-tools). They are an **on-demand proxy too**: every read is live, and no build log, build metadata or documentation response is ever cached or persisted.

## MCP specification compliance

When modifying MCP or OAuth functionality, check the latest published MCP specification:

- **Specification:** https://modelcontextprotocol.io/specification/2026-07-28
- **Authorization:** https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

## Repository structure

```
cloudflare-api-mcp/
├── src/
│   ├── pages/                         # Astro routes (output: 'server')
│   │   ├── index.astro                # Landing page
│   │   ├── authorize.astro            # OAuth consent — enter WORKER_API_KEY, validate redirect_uri + PKCE, mint code
│   │   ├── mcp.ts                      # /mcp proxy: bearer gate + inject account_id + local tools + forward upstream
│   │   ├── health.ts                   # /health — real D1 + binding checks
│   │   ├── token.ts                    # /token endpoint (thin) — parses body, delegates to lib/token-grants
│   │   ├── register.ts                 # Dynamic client registration
│   │   └── .well-known/                # OAuth 2.1 / OpenID discovery metadata
│   │       ├── oauth-authorization-server.ts
│   │       ├── oauth-protected-resource.ts
│   │       ├── oauth-protected-resource/mcp.ts
│   │       └── openid-configuration.ts
│   ├── worker.ts                       # Worker entry (wrangler `main`): Astro's fetch handler + the CloudflareOps export
│   ├── rpc/
│   │   └── cloudflare-ops.ts           # `CloudflareOps` WorkerEntrypoint (service-binding RPC, see below)
│   ├── db/
│   │   ├── schema.ts                   # Drizzle schema — indexes are chosen for D1's rows-read/rows-written billing
│   │   └── client.ts                   # drizzle(env.CICD_DB) handle
│   ├── lib/
│   │   ├── oauth.ts                    # Pure PKCE (S256) + redirect-uri allowlist helpers (no Worker bindings)
│   │   ├── token-grants.ts             # Pure /token grant logic (KV injected) — authorization_code + refresh_token
│   │   ├── docs-pairing.ts             # Pure helpers to enrich `search` results with upstream docs
│   │   ├── mcp-local.ts                # Local tool registry, tools/list merge, tools/call dispatch, health
│   │   ├── cf-builds.ts                # Cloudflare Workers Scripts + Builds REST client (retries, structured errors)
│   │   ├── cf-ops.ts                   # CloudflareOps logic: fully-paged resource listing, idempotent create, Worker placeholder upload, tool dispatch
│   │   ├── builds-query.ts             # Pure: build filtering/ordering, log page draining, log search, coverage
│   │   ├── cicd-pause.ts               # Pure: pause/restore patches, drift detection, partial-config merge
│   │   ├── cicd-state.ts               # D1: pause phases, leases, audit (D1 injected)
│   │   ├── patterns.ts                 # Pattern matching engine (bounded, safe-regex) + D1 access
│   │   ├── pr-correlation.ts           # Pure: PR ↔ build correlation with named evidence and confidence
│   │   ├── build-docs.ts               # Criticality rules + live Cloudflare docs MCP lookup
│   │   ├── github.ts                   # Minimal read-only GitHub client (repo id, PR metadata)
│   │   ├── redact.ts                   # Pure: credential redaction + minimal error signatures
│   │   ├── tools/                      # The 17 local MCP tools
│   │   │   ├── context.ts              # ToolContext, schema helpers, ToolError, worker-name→tag resolution
│   │   │   ├── cicd.ts                 # get / configure / pause / resume / reconcile
│   │   │   ├── builds.ts               # builds_list / build_logs_get / pr_build_logs_get / build_logs_search
│   │   │   └── patterns.ts             # pattern CRUD + test / record_outcome / match
│   │   └── utils.ts                    # cn() etc.
│   ├── components/                     # React islands: LandingPage, AuthorizePage, LoginForm, ui/, reui/, blocks/
│   ├── layouts/Layout.astro
│   ├── styles/globals.css
│   └── env.d.ts
├── tests/                             # Vitest (@cloudflare/vitest-pool-workers)
│   ├── oauth-pkce.test.ts             # PKCE (RFC 7636 vector) + redirect allowlist — pure
│   ├── token-grants.test.ts           # /token grant paths against an in-memory KV — pure
│   ├── mcp-auth.test.ts               # /mcp bearer validation (isAuthorizedBearer)
│   ├── docs-pairing.test.ts           # search→docs pairing transforms — pure
│   ├── inject-account-id.test.ts      # account_id injection into execute calls
│   ├── builds-query.test.ts           # ordering, filters, coverage honesty, cursor draining, search — pure
│   ├── cicd-pause.test.ts             # pause/restore round trip, drift classification, partial merge — pure
│   ├── cicd-leases.test.ts            # lease + phase semantics against a LOCAL D1
│   ├── patterns.test.ts               # regex safety, deterministic matching, redacted evidence — pure
│   ├── pr-correlation.test.ts         # confidence levels, forks, force-push, merge commits — pure
│   ├── redact.test.ts                 # credential redaction + error signatures — pure
│   ├── mcp-local.test.ts              # tool registry, dispatch detection, tools/list merge — pure
│   └── cf-ops.test.ts                 # paging to the end, create idempotency + races, Worker placeholder, build-token default
├── migrations/                        # Generated by drizzle-kit (pnpm run db:generate)
├── drizzle.config.ts                  # drizzle-kit: schema src/db/schema.ts → out migrations/
├── scripts/explain-queries.mjs        # pnpm run db:explain — fails if a hot query starts scanning
├── astro.config.mjs                   # Astro + @astrojs/cloudflare + react + tailwind(v4 via @tailwindcss/vite)
├── wrangler.jsonc                     # Worker config: bindings, vars, preview_urls
├── vitest.config.ts
├── .oxfmtrc.json                      # oxfmt formatter config
├── DEPLOY.md                          # Deploy + Workers Builds settings
└── README.md
```

## Setup

```bash
pnpm install    # Node 22+; pnpm is the package manager (pnpm-lock.yaml)
```

A `package-lock.json` is also committed (GitHub Actions uses `npm ci`); keep both lockfiles in sync when changing dependencies.

## Commands

| Command                | What it does                                   |
| ---------------------- | ---------------------------------------------- |
| `pnpm run dev`         | Start Astro dev server                         |
| `pnpm run build`       | `astro build` → `dist/server` + `dist/client`  |
| `pnpm run deploy`      | Build then `wrangler deploy` (entry + assets)  |
| `pnpm run typecheck`   | `tsc --noEmit`                                 |
| `pnpm run lint`        | oxlint (`src/`)                                |
| `pnpm run format`      | oxfmt write (`src/`)                           |
| `pnpm run format:check`| oxfmt check (`src/`)                           |
| `pnpm run test`        | vitest (Workers pool)                          |
| `pnpm run check`       | format:check + lint + typecheck                |

## Code standards

### TypeScript
- Strict mode; runtime validation for external data where it matters.
- Security-critical logic lives in `src/lib/*` with **no Worker bindings** (KV injected as a parameter) so it is unit-testable in isolation.

### Formatting & linting
- **oxfmt**: single quotes, no semicolons, no trailing commas. Run `pnpm run format` before committing.
- **oxlint** for linting.

### Naming
- `PascalCase` for types/interfaces/components; `camelCase` for functions/variables; `SCREAMING_SNAKE_CASE` for constants.

## Architecture

### Astro SSR Worker
- `output: 'server'` with `@astrojs/cloudflare`. `astro build` emits the Worker at `dist/server/entry.mjs` and static assets at `dist/client`.
- Routes are the files under `src/pages/`. `export const prerender = false` on the API routes.

### OAuth proxy flow
1. **Discovery** — client reads `/.well-known/*`.
2. **Registration** — `/register` stores a client (`client:<id>` in `OAUTH_KV`) with its `redirect_uris`.
3. **Authorize** — `/authorize` (`authorize.astro`) shows the consent page. On submit it checks the entered key against `WORKER_API_KEY`, validates `redirect_uri` against the registered client (falling back to the built-in defaults) and requires an **S256 PKCE** challenge, then mints a **single-use** `auth_…` code (`code:<code>`, 600s TTL) carrying the PKCE challenge.
4. **Token** — `/token` (`token.ts` → `lib/token-grants.ts`) exchanges the code: it must exist, is deleted on use, `redirect_uri`/`client_id` must match, and a **matching PKCE verifier is mandatory** (S256 only). It issues an opaque `mcp_at_…` access token (stored `token:<token>` in `OAUTH_KV`) plus a rotating `mcp_rt_…` refresh token.
5. **Proxy** — `/mcp` (`mcp.ts`) validates the presented bearer via `isAuthorizedBearer` (a token active in `OAUTH_KV`, or the `WORKER_API_KEY` itself for direct API-key mode, compared in constant time), then forwards the request to `UPSTREAM_MCP_URL` with `Authorization: Bearer <CLOUDFLARE_WRANGLER_API_TOKEN>`.

### account_id injection
`injectAccountId` (in `mcp.ts`) splices the configured `CLOUDFLARE_ACCOUNT_ID` into `tools/call` bodies for the `execute` tool when the arg is absent, so multi-account user tokens resolve the right account. Other tools are untouched; an existing `account_id` is never overwritten. Failures fall back to no injection (best-effort, never 500s the proxy).

### Making calls succeed instead of explaining failures

`/builds/*` is reachable from this server's **local** tools (they call the Cloudflare
API directly with `CLOUDFLARE_USER_WRANGLER_API_TOKEN`) but **not** from `execute`,
which is forwarded upstream carrying the account-scoped token. Measured 2026-09-30:
eight distinct `/builds/*` endpoints all return `12006 "Invalid token"`, while
`/workers/scripts/*` and `/d1/*` return `200` on the same token. The user token
cannot be substituted upstream — `mcp.cloudflare.com` rejects it with
`403 insufficient_scope`.

At least three independent agents read that `12006` as "I am blocked" and escalated
to the operator. **The handling is not a better error message — it is to perform the
call.** In order:

1. **Replay it here** (`lib/cf-request-rescue.ts`). On a credential refusal, the
   `cloudflare.request({...})` is recovered from the `execute` code and re-issued
   server-side with the token that reaches that path. The caller's call simply
   succeeds with real data. Only the **single-literal-call shape** is replayed —
   where the raw API response is exactly what the code would have returned, so
   substituting it changes nothing observable. Code that post-processes the
   response, makes several calls, or builds arguments from runtime values is NOT
   replayed, because returning the raw response there would silently hand back a
   different shape than the code asked for.
2. **Offer the direct door** (`tools/cf-api.ts`). `cloudflare_api_request` makes any
   single Cloudflare API call server-side with correct token selection, so `execute`
   is not the only route and there is nothing for a caller to get wrong.
3. **One line, only if neither applied** (`lib/builds-guidance.ts`). Names the tool
   that serves the same data. It never tells the caller to report anything, retry,
   ask for a credential, or involve a human — a scripted "ask your operator for a
   token" is the failure this area exists to remove, and there is a test asserting
   that wording never reappears.

`execute`'s own description is also annotated in the merged `tools/list` so the
mistake is avoided at tool-selection time (idempotent — repeat annotation never
stacks the hint).

### Account vs user tokens, and the 50-token wall

Cloudflare's own guidance and Workers Builds' requirement point in opposite
directions, and neither is wrong. From
`/fundamentals/api/get-started/account-owned-tokens/`:

- **Account-owned** (`cfat_`) are durable service principals with their own
  permissions — the recommended default for CI/CD, surviving the person who made them.
- **User tokens** act on behalf of a user and inherit a subset of that user's
  permissions; documented as better for ad hoc scripting.

The trap is one sentence of those docs: **"Some services may not support account API
tokens yet."** Workers Builds is in that gap, which is the documented explanation for
our measured `12006` on every `/builds/*` path. So "prefer account tokens" and
"builds needs a user token" are both true.

**Which credential administers which — measured 2026-09-30, because the intuitive
mapping is wrong:**

| Operation | Works | Fails |
|---|---|---|
| administer **user** tokens (`/user/tokens`) | `CLOUDFLARE_USER_TOKEN_ADMIN` | both wrangler tokens → `9109` |
| administer **account** tokens | `CLOUDFLARE_WRANGLER_API_TOKEN` | the wrangler user token → `9109` |
| call `/builds/*` | `CLOUDFLARE_USER_WRANGLER_API_TOKEN` | the account token → `12006` |

The wrangler **user** token reaches `/builds/*` but **cannot administer tokens at
all**. Assuming "user things need the user token" does not hold. Only one new binding
was added for this (`CLOUDFLARE_USER_TOKEN_ADMIN`): the account surface was already
covered, and the Secret Store was at 98 of its hard cap of 100, so the measurement
saved a slot.

**User API tokens are capped at 50 per account** (documented in
`/fundamentals/api/rate-limits/` as "User API token quota | 50"). Measured the same
day: **48 in use** — two from the wall. Hitting it is how a Workers Builds setup
fails confusingly: the dashboard cannot pull tokens, and creating another is refused.

**So reuse is the policy, not an optimisation.** `workers_build_token_ensure` looks
for ONE shared build token and reports what can be reused; it is read-only unless
explicitly given `allow_create` or `allow_roll`. `cloudflare_token_create` checks the
quota **before** attempting a user-token create and refuses with the recovery path
rather than letting Cloudflare answer opaquely. The recovery is
`cloudflare_token_roll_value` (`PUT .../{id}/value`): the token keeps its id,
policies and every association, only the secret changes, and **no quota slot is
consumed** — which is why rolling beats creating whenever the cap is near.

A token value is returned exactly once, at creation or at roll, because that is the
only moment Cloudflare discloses it. Nothing here stores it.

### Token quota audit — and why a token was deleted

**If a Cloudflare API token disappeared and you want to know why, the answer is at
`/docs/token-audit`** (add `?format=json` for the raw record). It serves the policy
plus every run and every deletion out of D1, keyed by the token's **name** — because
once a token is deleted its name is the only handle anyone has. That page exists
specifically so a deletion is never a mystery later.

`lib/token-audit.ts` is pure bookkeeping — rules over timestamps and references, no
model involved, which is why it is safe to run unattended. `cloudflare_token_audit`
is **dry-run by default** and deletes nothing without `apply=true`.

**It deletes only what is provably dead:**

- expired (`expires_on` in the past), or
- a non-active status, or
- a **recognisably generated** build token (`<worker> build token`,
  `Workers Builds - <date>`) that is unreferenced **and** idle past the retention
  window (default 180 days).

**It never deletes, and each protection exists because of a real token in the
measured set:**

| Protection | Why |
|---|---|
| `keep_marker` | One token is named `KEEP - wrangler d1 access`. A human marker outranks every heuristic. |
| `in_use_by_this_server` | Deleting the credential the audit authenticates with would be self-destruction. |
| `referenced` | Wrapped by a Workers Builds build token, so in use whatever its timestamps say. |
| `untracked_usage` | A tunnel/DNS/certificate token authenticates a persistent connection, so a stale `last_used_on` is **not** evidence of disuse. |

Anything else that is merely idle goes to **review**, never to deletion — including a
generated token that has *never* been used, since that is ambiguous (it may belong to
a build that has not run yet).

**Measured first run (2026-10-01, dry run): 48 of 50 in use, 41 protected, 6 keep, 1
review, 0 reclaimable.** The strict definition currently reclaims nothing, because
every accumulated build-related user token is still wrapped by an existing build
token. The refinement that would unlock reclaim is checking whether that build token
is still referenced by a **live trigger** rather than merely existing — an orphaned
build token protects a dead user token today. That is a known, deliberate
conservatism, not an oversight.

D1 writes are bounded: one run row plus one row per deletion, and tokens that were
kept are never recorded (that would be ~48 rows per run for no benefit, and a D1
write costs 1000x a read).

### Response framing — the bug that made every local tool look broken

`lib/mcp-response.ts`. Locally-served results used to be emitted with a hardcoded
`Content-Type: application/json`, ignoring the client's `Accept`. Proxied tools came
back in whatever framing the client negotiated, so the asymmetry was precise and
baffling:

```
client sends  Accept: text/event-stream
execute            -> text/event-stream   works
workers_* (local)  -> application/json    client cannot read it
```

Two agents reported "your build tools return results missing a required field" and
worked around it. **A `curl` that accepts both types cannot see this**, which is why
it survived earlier testing. So: never hardcode the framing of a response we
generate — `encodeMcpResponse` negotiates it, and `validateToolResponse` checks the
envelope before it leaves, repairing anything invalid rather than sending it.

### Automatic failure reporting

`lib/failure-report.ts`. A failure an operator has to discover and report by hand is
a failure many agents hit first. Every failure of this server's own is recorded in
D1 (`tool_failures`) and the **first** occurrence of each distinct signature files a
`fixit` task in colby-maestro against the `cloudflare-api-mcp reliability` plan.

Three rules it follows:

- **Never affects the response.** Scheduled on `waitUntil`, so the reply is already
  on its way; every path is swallowed. Telemetry must never make a working call
  slower or broken.
- **Deduped, because a D1 write costs 1000x a read.** One row per signature with an
  occurrence counter, not one row per occurrence.
- **One task per signature, ever.** `fixit_filed_at` gates filing, so a defect that
  fires a thousand times files one task. There is a test that plants the missing gate
  and confirms the suite goes red.

Nothing recorded holds a credential or a response body — `detail` is a short
redacted signature.

### Build log and CI/CD tool surface

Several dedicated paths to a build log, so none of them needs two round trips:
`workers_build_logs_get` (by UUID), `workers_build_logs_latest` (newest for a
Worker, optionally filtered by branch/status/outcome — reports which build it chose
and from how many candidates), `workers_build_logs_by_commit` (full or abbreviated
sha; lists every match and diagnoses the newest), `workers_pr_build_logs_get` (repo
+ PR number), `workers_build_logs_search`.

Configuration is fully managed: `workers_cicd_configure` sets repository, branch and
path matchers, build/deploy/preview commands, root directory, caching and build
token; `workers_build_tokens_list` and `workers_build_token_create` supply a token to
associate (the wrapped API token's value is never logged, stored, or returned);
`workers_cicd_validate` returns one pass/fail plus the reasoning for **every** check,
pass and fail alike, with a remedy naming the tool that fixes it.

**The validator's checks are semantic, not presence-only.** A deploy command that
skips the build while no build command is set is a FAIL, because nothing would
produce the output the deploy uploads — even though every field looks populated.
That is the shape that would have broken `core-ai-tools`, and a presence-only
validator passes it.

### Docs pairing (search → docs)
When a client calls the `search` tool, the proxy also queries **Cloudflare's separate documentation MCP server** (`DOCS_MCP_URL` = `https://docs.mcp.cloudflare.com/mcp`) and appends the documentation to the search result, so the agent gets endpoint methods/payloads *and* product context from one call. Pure transforms live in `lib/docs-pairing.ts` (`detectSearchCall`, `deriveDocsQuery`, `pickDocsToolName`, `extractToolText`, `mergeDocsIntoSearch`); `mcp.ts` does the I/O:

- **Two servers:** `search` is forwarded to the API upstream (`UPSTREAM_MCP_URL`) as usual; the docs call goes to the public docs MCP (`DOCS_MCP_URL`) and **carries no privileged token** (a different, unauthenticated service).
- The docs tool is `DOCS_TOOL_NAME` = `search_cloudflare_documentation`, called with a `query` argument.
- The docs query is derived from the search `code`'s string literals (product/tag/path terms, stopwords removed), or taken from an explicit `docs_query` argument.
- Search and docs fetch in parallel. **It fails safe:** on no derivable query, a non-JSON (streamed) search response, or a failed/empty docs call, the untouched search response is returned — pairing can never degrade `search`. Toggle with `DOCS_PAIRING_ENABLED` in `mcp.ts`.


## `CloudflareOps` RPC entrypoint

A named `WorkerEntrypoint` (`src/rpc/cloudflare-ops.ts`, logic in `src/lib/cf-ops.ts`) that
other Workers on this account reach over a **service binding**. colby-maestro binds it as
`CFOPS` with `entrypoint: "CloudflareOps"`; its typed client is `backend/cloudflare/ops.ts`
there, and the method shapes are a shared contract — change both or neither.

| Method | Does |
| --- | --- |
| `callTool(name, args)` | Runs any of the local tools below and returns the raw payload. Uses `buildToolContext` (user token), actor `rpc:colby-maestro` |
| `findWorker(name)` | `{ name, exists, tag }` from `/workers/scripts` |
| `createWorker(name)` | Idempotent. Uploads a placeholder ES module (503 `provisioning`) via `PUT /workers/scripts/{name}` |
| `listResources(type)` | `d1` \| `kv` \| `r2` \| `vectorize` \| `queue` → `[{ name, id }]`, paged to the end |
| `createResource(type, name, options?)` | Idempotent: reuses a same-named resource with `created: false` |

- **The binding is the trust boundary.** A named entrypoint has no route; only a Worker on
  this account that declares the binding reaches it. No bearer crosses it, like core-guardian's
  `GuardianRpc`. The default `fetch` export (OAuth, `/mcp`) is unchanged.
- **Why a script upload, not `POST /workers/workers`.** Measured 2026-09-29: a Worker created
  through the Workers API without a deployment is absent from `/workers/scripts`, which is how
  every CI/CD tool resolves a name to a tag, so it could not be connected to Workers Builds.
- **Never answer from a partial listing.** Idempotency depends on it. Queues silently caps
  `per_page` at 500; D1 sends `total_count` but no `total_pages`; R2 pages by cursor. A listing
  that does not end within `MAX_PAGES` throws.
- **Build token default.** A `workers_cicd_configure` CREATE with no `build_token_uuid` is
  retried once with the token on colby-maestro's own trigger, reported as
  `build_token_defaulted`. An UPDATE is never given a token.
- **Errors** cross RPC as `Error(message)`; a `ToolError` becomes `"<code>: <message> <details>"`.
- **The entry.** `@astrojs/cloudflare` 14 has no `workerEntryPoint` option; it takes the entry
  from wrangler `main`, so `main` is `./src/worker.ts` (a SOURCE file — see Deployment). The
  build still emits `dist/server/entry.mjs` with `CloudflareOps` among its exports. The test pool
  overrides `main` with `src/rpc/cloudflare-ops.ts`, because `src/worker.ts` imports Astro
  virtual modules only the Astro build can resolve.

## Local CI/CD tools

17 tools are served by **this** Worker rather than forwarded upstream. `mcp.ts` reads the
request body once and then: dispatches a `tools/call` whose name is local (never touching
the upstream or its token), or forwards `tools/list` and merges the local descriptors into
the response. The upstream answers `tools/list` as **SSE**, so the merge handles both plain
JSON and `data:` frames — a client that only ever sees the streamed form would otherwise
never learn the local tools exist.

**Storage rule (load-bearing).** These tools are an on-demand proxy. CI/CD settings, build
lists, build logs, PR metadata and documentation are fetched live per call and processed in
memory. Nothing is tailed, subscribed to, queued, polled or cached; no retrieved log body is
written to storage or to this Worker's own logs. **D1 holds exactly two things:** pause/resume
coordination state, and the reusable failure-pattern library.

| Tool | What it does |
| --- | --- |
| `workers_cicd_get` | Live trigger configuration, repository, production branch, build-token *reference*, build-variable names, local pause state, and any Cloudflare↔local discrepancy |
| `workers_cicd_configure` | Create or update a trigger. Partial: an omitted field keeps its value, an explicit `null` removes it. `dry_run` previews. Refuses to run while paused unless `update_saved_config_while_paused` |
| `workers_cicd_pause` | Acquire a pause lease and suppress automatic builds |
| `workers_cicd_resume` | Release a lease; restore + verify only when it was the last one |
| `workers_cicd_reconcile` | Finish an interrupted pause/resume |
| `workers_builds_list` | Builds newest-first, 30-day default, with honest coverage |
| `workers_build_logs_get` | Full-cursor log retrieval + pattern matches + criticality + live docs |
| `workers_pr_build_logs_get` | Correlate a GitHub PR to its builds, with evidence and confidence |
| `workers_build_logs_search` | Live text/regex search across builds with coverage reporting |
| `build_patterns_*` | `create` / `get` / `list` / `update` / `delete` / `test` / `record_outcome` / `match` |


### D1 access and billing

The schema lives in `src/db/schema.ts` (Drizzle) and every query goes through it —
no raw SQL except the `/health` check, which asks SQLite what tables exist and so
has no Drizzle model. Generate migrations with `pnpm run db:generate`; never
hand-write one.

**D1 bills by rows read (scanned) and rows written — not rows returned — and a
written row costs 1000x a read row.** That is not a micro-optimisation here: a
query that loses its index keeps working, keeps passing tests, and just costs
more forever. Three rules hold this together:

1. **Every hot query reaches its table through an index**, verified against the
   real database by `pnpm run db:explain`, which exits non-zero on a regression.
   It distinguishes `SEARCH … USING INDEX` (fine), `SCAN … USING INDEX` (fine for
   an unfiltered listing, which must touch what it lists) and `SCAN … USING
   INDEX` **plus** `USE TEMP B-TREE FOR ORDER BY` — that last one is a real
   regression, because SQLite reads and sorts every row before applying `LIMIT`,
   so the `LIMIT` saves nothing. It has already caught one: an index on
   `(severity, confidence)` could not satisfy `ORDER BY severity, confidence
   DESC` until the index direction matched.
2. **`scope_key` exists purely for billing.** Selecting applicable patterns used
   to be a six-way `OR` across `scope_type`, which SQLite cannot satisfy from one
   index, so the hot read scanned the whole table. One indexed selector makes it
   an `IN (…)` lookup. It is derived, never supplied — `scopeKeyFor()` — and
   `build_patterns_update` recomputes it whenever the scope fields change, or the
   row would silently stop being found.
3. **The hot write path costs exactly one row.** A pattern match writes only
   `occurrence_count` and `last_matched_at`, and **neither is indexed** — an
   indexed column would add a second written row to every match. There is no
   per-match row in `build_pattern_events`: an earlier version wrote one, which
   tripled the cost of the busiest path to record what those two columns already
   say. A test asserts the generated migration never indexes either column.

Indexes on `build_patterns` are `WHERE deleted_at IS NULL`, so a soft-deleted
pattern leaves both indexes: it stops being read by the hot query and stops
costing index writes. `idx_leases_active` is partial the same way, so released
leases never accumulate in it.

`build_patterns_list`'s free-text search is the one deliberate scan — a
leading-wildcard `LIKE` cannot use a B-tree index. It is capped, says so in
`scan_note`, and runs one query (`COUNT(*) OVER ()`) rather than repeating the
scan for a separate `COUNT`.

### Measured Cloudflare API facts (verify before changing any of this)

Every one of these was measured against the live API on 2026-09-10, and several contradict
what the docs imply. Re-measure before you "fix" them.

1. **The Builds API requires a USER-scoped token.** The account-scoped
   `CLOUDFLARE_WRANGLER_API_TOKEN` this Worker already carries returns 200 on
   `/workers/scripts` and **401 `12006 Invalid token`** on every `/accounts/{id}/builds/*`
   path. `CLOUDFLARE_USER_WRANGLER_API_TOKEN` returns 200. That is why there is a second
   Cloudflare token binding.
2. **Every Builds endpoint is keyed by the Worker *tag*** (`external_script_id`), an
   immutable UUID. The Worker *name* is the only identifier a caller supplies or sees; the
   tag is resolved internally on each call and recorded with persisted state so a
   delete-and-recreate is detectable.
3. **`PATCH /builds/triggers/{uuid}` is a true partial update** — fields absent from the
   body keep their stored values.
4. **A trigger has no enable/disable field.** Pause narrows `branch_includes` to
   `cicd-paused-by-mcp..do-not-build` (not a legal git ref).
   **`branch_excludes: ["*"]` is rejected** with `400 / 12002 Invalid request body` — you
   may not exclude every branch — so the pause uses `branch_includes` alone.
5. **List-builds supports only `page` and `per_page`.** No branch/status/commit filter, no
   date range, no sort. All of that is done client-side in `builds-query.ts` over as many
   pages as the window needs, and every result reports the coverage it actually achieved.
6. **The logs endpoint returns `{cursor, truncated, lines: [[epochMs, text]], events}`.**
   `limit` is ignored. `cursor` is a **tail** cursor — replaying it returns zero lines — so
   paging continues only while `truncated` is set *and* the page produced lines. A naive
   `while (truncated)` loop spins forever on a finished build.
7. **A build carries `pull_request.pull_request_url`** when Cloudflare associated one, but
   never a PR number. Correlation is inference; see below.
8. **Cloudflare can run an IMPLICIT PREVIEW TRIGGER that the API does not expose.** On
   this very Worker, a PR build ran under trigger `59918e36-…` while
   `GET /builds/workers/{tag}/triggers` returned **only** the production trigger, that
   uuid **404s** when fetched directly, and the build was **absent** from
   `GET /builds/workers/{tag}/builds` (which reported a total excluding it). Its only
   handle was the GitHub check run's `details_url`. Three consequences, all reflected in
   the tools: `workers_cicd_pause` **cannot** pause it (it says so, and reports any such
   trigger it can infer as `preview_triggers_not_pausable`); a null `preview_trigger_uuid`
   from `workers_cicd_get` is **not** evidence that preview builds are off; and
   `workers_pr_build_logs_get` finding nothing does **not** prove no build ran — check the
   PR's own check run. `include_preview=true` is silently ignored by the list endpoint.

### Pause: leases, snapshots and partial failure

- **Leases.** Several agents can pause one Worker. Each holds its own lease; the saved
  configuration is restored only when the **last** lease is released. Releasing your lease
  never resumes someone else's work. `idempotency_key` makes a retried pause a no-op.
  `owner` is metadata for the audit trail — **never** an authorization check.
- **Snapshot once.** The pre-pause trigger list is captured on the *first* transition into
  pause and never overwritten while paused (`saved_config IS NULL` guard in the UPDATE), or
  a second pause would save the paused configuration and "resume" would restore a pause.
- **Partial failure.** D1 and the Cloudflare API cannot share a transaction, so the intent
  (`phase` = `pausing`/`resuming`) is written to D1 **before** Cloudflare is called. A crash
  or an API rejection leaves a row that says what was in flight; `workers_cicd_reconcile`
  reports it and, with `apply=true`, finishes it.
- **Concurrency.** Every phase change is `UPDATE ... WHERE revision = ?`. Two agents racing
  produce one winner and one `false`; the loser re-reads instead of clobbering.
- **Drift.** Before restoring, the live triggers are compared with the expected paused
  state. Changes to the *pause* fields and changes to *unrelated* fields are reported
  separately: an unrelated edit made while paused blocks the restore (it would silently
  revert someone's work) until `overwrite_drift` is passed, and even then only the branch
  matchers are written.
- **Expiry is reporting only.** An expired lease is surfaced as expired. Time passing never
  resumes a Worker — an agent still mid-refactor must not have CI switched on underneath it.
- **Recovery data is kept until the restore verifies.** `saved_config` is cleared only after
  the remote is re-read and matches; the audit row keeps the full restored configuration.

### PR correlation is evidence, not proof

Cloudflare stores no PR number. `pr-correlation.ts` grades each signal:
`exact` (Cloudflare's own `pull_request_url`) → `high` (PR head sha, or the merge commit) →
`medium` (an earlier commit on the PR branch — force-push/rebase) → **`low` (branch name
alone, never treated as proof)**. Fork PRs, merged PRs and multiple builds per PR are all
handled and reported, each with the evidence that fired.

### Patterns are diagnoses, never verdicts

- A match says the signature is present. Every match carries an explicit caveat that this is
  **not** proof of the root cause, and no suggested fix is ever executed.
- **Regex safety:** expressions are length-capped, structurally screened for nested
  quantifiers (`(a+)+`), matched per line against truncated lines, with caps on lines
  scanned and patterns evaluated. V8 has no regex timeout, so the bounds are the defence —
  the screen alone is not relied on. A stored expression that fails validation is *skipped*,
  never run.
- **Verification needs evidence.** A pattern cannot be created or promoted to `verified`
  without supporting build IDs; `mark_verified` additionally requires a build UUID and an
  evidence string.
- Content is redacted on the way in and on the way out. Patterns hold signatures and build
  IDs — never transcripts.

### Criticality is rule-based

`assessCriticality` fires on the build's own outcome (`fail`/`terminated`, stopped without
deploying) and on a small list of *specific* severe signatures (startup CPU 10021, missing
entry point, OOM, ENOSPC, auth failure, dependency resolution, `error TS####`, binding
errors) — plus a matched pattern of severity `high`/`critical`. Every firing rule is named
in the result. "The log contains the word error" is deliberately **not** a rule: build logs
say "error" constantly while succeeding.

### Documentation lookup

For a critical failure, `build-docs.ts` derives a **minimal redacted error signature**
(leading timestamps stripped, paths → `<path>`, URLs → `<url>`, credentials removed, capped
at 400 chars) and queries the public Cloudflare documentation MCP — the same server
`docs-pairing.ts` already uses, so no new runtime integration was needed. It returns the
guidance with source URLs and a retrieval timestamp, keeps observed evidence / known
patterns / documentation / proposed next steps in **separate** fields, and is never
persisted. A docs failure returns a structured `error` on that field and never fails the
surrounding log retrieval. No AI inference is involved anywhere in this path.

### Bindings (`wrangler.jsonc`)
- **KV:** `SESSION` (Astro sessions), `OAUTH_KV` (tokens, codes, refresh, client registrations).
- **D1:** `CICD_DB` (`cloudflare-api-mcp-cicd`) — pause/resume state, leases, audit, patterns. Schema in `src/db/schema.ts` (Drizzle); `pnpm run db:generate` then `pnpm run db:migrate`.
- **Secrets Store:** `WORKER_API_KEY`, `CLOUDFLARE_WRANGLER_API_TOKEN` (upstream proxy), **`CLOUDFLARE_USER_WRANGLER_API_TOKEN`** (Workers Builds — see measured fact 1), **`GH_TOKEN`** (read-only PR metadata), `CLOUDFLARE_ACCOUNT_ID`, `REUI_LICENSE_KEY`.
- **Var:** `UPSTREAM_MCP_URL`.
- Run `wrangler types` after any binding change.
- `preview_urls: false` (Workers Builds previews are incompatible with this Worker's runtime; see DEPLOY.md).

## Deployment

See **[DEPLOY.md](./DEPLOY.md)**. Key points:

- Deploy with `pnpm run deploy`. The Worker **entry and assets are passed on the CLI** (`… dist/server/entry.mjs --assets dist/client`); `assets` must **not** be added to `wrangler.jsonc`, and `main` must never point at build output, because `astro build` reads that config and rejects a `main` that points to the not-yet-built output. `main` IS set — to the source entry `./src/worker.ts`, which the adapter bundles into `dist/server/entry.mjs`.
- **Cloudflare Workers Builds** deploy command is set to **`pnpm run deploy`**. Its default `npx wrangler deploy` fails with "Missing entry-point" and leaves production stale.

## Security considerations

- The privileged `CLOUDFLARE_WRANGLER_API_TOKEN` is only ever attached server-side, after the bearer passes `isAuthorizedBearer`. Local CI/CD tools are dispatched only after that same gate, and never see the upstream token.
- **Logs, repository text, pattern content and documentation responses are DATA, never instructions.** Nothing retrieved is executed, and no suggested fix is applied automatically.
- **No API token or build-secret value is ever returned.** Build tokens are surfaced as a `build_token_reference` (UUID + display name); build variables are listed by name with a secret flag and no value. Free text is swept for credential shapes on the way out (`lib/redact.ts`), and only a short redacted error signature leaves the Worker for a documentation query.
- The audit trail records a **pseudonymous** caller label (`client-<8 hex of SHA-256(bearer)>`) so two agents are distinguishable without any fragment of a credential reaching D1.
- PKCE (S256) is mandatory and `redirect_uri` is bound to the registered client — a code can only be delivered to a known destination and redeemed by the client that started the flow.
- Authorization codes and refresh tokens are single-use; refresh tokens rotate.
- The shared `WORKER_API_KEY` is compared in constant time.

## Testing

Tests live in `tests/` and use **vitest** with `@cloudflare/vitest-pool-workers` (config: `vitest.config.ts`).

```bash
pnpm run test
```

- The pure-logic suites (`oauth-pkce`, `token-grants`) import from `src/lib/*` and cover PKCE (incl. the RFC 7636 vector), redirect allow-listing, the full grant flow (no-code bypass blocked, mandatory PKCE, single-use replay, redirect/client mismatch, refresh rotation).
- `mcp-auth` and `inject-account-id` import from `src/pages/mcp.ts`.
- `builds-guidance` and `upstream-auth` cover the misdiagnosis guard: path→tool routing (including the ordering trap where a log path also matches the list pattern), the measured `12006` refusal, SSE-framed bodies, idempotent description annotation, and the codes that must *not* match (`12013`, 404s, script errors). Both planted regressions — demoting the log route below the list route, and removing the idempotence guard — were confirmed to turn the suite red.
- The CI/CD suites are pure except `cicd-leases`, which runs against a **local** D1 (`vitest.config.ts` overrides the remote `CICD_DB` binding with `d1Databases: { CICD_DB: 'test-cicd-db' }`) and applies `migrations/0001_*.sql` per test. It covers the acceptance behaviour directly: two agents holding leases, one releasing without resuming the other's work, the last release permitting a restore, idempotent re-pause, snapshot-not-overwritten-while-paused, and a stale-revision transition being rejected.
- **Note:** the Workers pool needs `CLOUDFLARE_API_TOKEN` to start (the KV bindings are `remote: true`), so the suite does not run in a credential-less environment. The pure-logic suites can be exercised offline under a plain node vitest config.

## Contributing

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`, and `test`. Run `pnpm run check` before pushing.

**Always:** run `pnpm run check`; add tests for new auth/grant logic; keep security-critical logic in `src/lib/*` (KV injected) so it stays unit-testable; use Zod (or equivalent) for external data.

**Ask first:** changing authentication/token handling; changing deployment configuration or bindings; adding dependencies (update **both** lockfiles).

**Before merging a schema or query change:** run `pnpm run db:explain`. It talks to the real database, so a plan regression is caught where it happens rather than on a bill.

**Never:** hardcode secrets; let the client bearer reach the upstream without passing `isAuthorizedBearer`; weaken PKCE or `redirect_uri` validation; point wrangler `main` at build output or add `assets` to `wrangler.jsonc` (breaks `astro build`; `main` stays the source entry `./src/worker.ts`); **cache or persist build logs, build metadata or documentation responses, or add background collection for them** — the CI/CD tools are an on-demand proxy and D1 is only for pause state and patterns; **return a token or build-secret value** from any tool.

## Keeping AGENTS.md updated

Update this file when adding modules or routes, changing the auth/proxy flow, modifying build/test tooling or bindings, or changing deployment. Keep README.md and DEPLOY.md consistent with it.
