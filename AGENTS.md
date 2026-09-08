# AGENTS.md

## Project overview

This repository is an **Astro SSR application deployed as a Cloudflare Worker** that acts as an **authenticated OAuth proxy** in front of Cloudflare's Code Mode MCP server (`mcp.cloudflare.com/mcp`).

An MCP client (e.g. Claude) connects to *this* worker's `/mcp` endpoint. The worker runs its own OAuth 2.1 + PKCE flow — gated by a shared `WORKER_API_KEY` entered on the consent page — issues the client a short opaque token, and forwards MCP traffic upstream using a privileged Cloudflare API token that never leaves the worker. It also injects the configured `account_id` into `execute` tool calls.

It is **not** the Code Mode server itself; it proxies to it. The `search` / `execute` / `docs` tools the client sees are served by the upstream.

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
│   │   ├── mcp.ts                      # /mcp proxy: bearer gate + inject account_id + forward upstream
│   │   ├── token.ts                    # /token endpoint (thin) — parses body, delegates to lib/token-grants
│   │   ├── register.ts                 # Dynamic client registration
│   │   └── .well-known/                # OAuth 2.1 / OpenID discovery metadata
│   │       ├── oauth-authorization-server.ts
│   │       ├── oauth-protected-resource.ts
│   │       ├── oauth-protected-resource/mcp.ts
│   │       └── openid-configuration.ts
│   ├── lib/
│   │   ├── oauth.ts                    # Pure PKCE (S256) + redirect-uri allowlist helpers (no Worker bindings)
│   │   ├── token-grants.ts             # Pure /token grant logic (KV injected) — authorization_code + refresh_token
│   │   ├── docs-pairing.ts             # Pure helpers to enrich `search` results with upstream docs
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
│   └── inject-account-id.test.ts      # account_id injection into execute calls
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
5. **Proxy** — `/mcp` (`mcp.ts`) validates the presented bearer via `isAuthorizedBearer` (a token active in `OAUTH_KV`, or the `WORKER_API_KEY` itself for direct API-key mode, compared in constant time), then forwards the request to `UPSTREAM_MCP_URL` with `Authorization: Bearer <CLOUDFLARE_WRANGLER_API_TOKEN>` — falling back to `CLOUDFLARE_USER_WRANGLER_API_TOKEN` when that token is refused (see below). The client's own bearer is stripped and never reaches the upstream.

### Two Cloudflare tokens (account, then user)

Some Cloudflare API surfaces are reachable **only with a user-scoped token** — Workers Builds is the one that prompted this. Measured 2026-09-08 against `GET /accounts/{id}/builds/builds`: `CLOUDFLARE_WRANGLER_API_TOKEN` (account-scoped) is refused with `12006 "Invalid token"`, while `CLOUDFLARE_USER_WRANGLER_API_TOKEN` passes authentication.

Rather than pick one token globally, `fetchUpstreamWithFallback` (in `mcp.ts`) tries the **least-privileged token first** and retries with the user token only when the first attempt was refused. A refusal arrives in two shapes, and `lib/upstream-auth.ts` covers both:

- **Transport level** — the upstream MCP answers `401`/`403`.
- **Payload level** — an ordinary `200` whose JSON-RPC tool result carries the Cloudflare API's own error (`10000`, `9109`, `12006`, `403 Forbidden`, …). Only the body distinguishes it, so the body is scanned.

Matching is deliberately narrow — permission wording and known auth error codes only — so an ordinary tool error (a 404, a bad payload, a script that threw) does not burn a second upstream round trip. If the user token is *also* refused, the original response is returned, since the account token's error is the more honest one.

**Response buffering:** real clients negotiate `text/event-stream`, so gating inspection on JSON alone would mean the fallback never fires. `isBufferableResponse` buffers plain JSON on any method **and** an event-stream response to a **POST** (whose stream ends with the response). A **GET** event-stream is the open-ended server-to-client notification channel and is never buffered — reading it to completion would hang the request.

**Caveat:** a retry re-runs the sandboxed `execute` code from the top. That is safe for the read-shaped calls this exists for, but a script that wrote something *before* hitting the refusal would write it twice. The narrow matching keeps retries rare.

### account_id injection
`injectAccountId` (in `mcp.ts`) splices the configured `CLOUDFLARE_ACCOUNT_ID` into `tools/call` bodies for the `execute` tool when the arg is absent, so multi-account user tokens resolve the right account. Other tools are untouched; an existing `account_id` is never overwritten. Failures fall back to no injection (best-effort, never 500s the proxy).

### Docs pairing (search → docs)
When a client calls the `search` tool, the proxy also queries **Cloudflare's separate documentation MCP server** (`DOCS_MCP_URL` = `https://docs.mcp.cloudflare.com/mcp`) and appends the documentation to the search result, so the agent gets endpoint methods/payloads *and* product context from one call. Pure transforms live in `lib/docs-pairing.ts` (`detectSearchCall`, `deriveDocsQuery`, `pickDocsToolName`, `extractToolText`, `mergeDocsIntoSearch`); `mcp.ts` does the I/O:

- **Two servers:** `search` is forwarded to the API upstream (`UPSTREAM_MCP_URL`) as usual; the docs call goes to the public docs MCP (`DOCS_MCP_URL`) and **carries no privileged token** (a different, unauthenticated service).
- The docs tool is `DOCS_TOOL_NAME` = `search_cloudflare_documentation`, called with a `query` argument.
- The docs query is derived from the search `code`'s string literals (product/tag/path terms, stopwords removed), or taken from an explicit `docs_query` argument.
- Search and docs fetch in parallel. **It fails safe:** on no derivable query, a non-JSON (streamed) search response, or a failed/empty docs call, the untouched search response is returned — pairing can never degrade `search`. Toggle with `DOCS_PAIRING_ENABLED` in `mcp.ts`.

### Bindings (`wrangler.jsonc`)
- **KV:** `SESSION` (Astro sessions), `OAUTH_KV` (tokens, codes, refresh, client registrations).
- **Secrets Store:** `WORKER_API_KEY`, `CLOUDFLARE_WRANGLER_API_TOKEN`, `CLOUDFLARE_USER_WRANGLER_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `REUI_LICENSE_KEY`.
- **Var:** `UPSTREAM_MCP_URL`.
- `preview_urls: false` (Workers Builds previews are incompatible with this Worker's runtime; see DEPLOY.md).

## Deployment

See **[DEPLOY.md](./DEPLOY.md)**. Key points:

- Deploy with `pnpm run deploy`. The Worker **entry and assets are passed on the CLI** (`… dist/server/entry.mjs --assets dist/client`); they must **not** be added to `wrangler.jsonc` as `main`/`assets`, because `astro build` reads that config and rejects a `main` that points to the not-yet-built output.
- **Cloudflare Workers Builds** deploy command is set to **`pnpm run deploy`**. Its default `npx wrangler deploy` fails with "Missing entry-point" and leaves production stale.

## Security considerations

- The privileged `CLOUDFLARE_WRANGLER_API_TOKEN` — and the `CLOUDFLARE_USER_WRANGLER_API_TOKEN` fallback — are only ever attached server-side, after the bearer passes `isAuthorizedBearer`. The client's `Authorization` header is deleted from the forwarded request.
- The user token is a **fallback, not a default**: the account-scoped token is always tried first, so the broader credential is used only for calls the narrower one cannot make.
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
- `upstream-auth` covers the account→user token fallback trigger: the measured `12006` refusal, SSE-framed bodies, and the codes/phrases that must *not* trigger a retry (`12013`, 404s, script errors).
- **Note:** the Workers pool needs `CLOUDFLARE_API_TOKEN` to start (the KV bindings are `remote: true`), so the suite does not run in a credential-less environment. The pure-logic suites can be exercised offline under a plain node vitest config.

## Contributing

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`, and `test`. Run `pnpm run check` before pushing.

**Always:** run `pnpm run check`; add tests for new auth/grant logic; keep security-critical logic in `src/lib/*` (KV injected) so it stays unit-testable; use Zod (or equivalent) for external data.

**Ask first:** changing authentication/token handling; changing deployment configuration or bindings; adding dependencies (update **both** lockfiles).

**Never:** hardcode secrets; let the client bearer reach the upstream without passing `isAuthorizedBearer`; weaken PKCE or `redirect_uri` validation; add `main`/`assets` to `wrangler.jsonc` (breaks `astro build`).

## Keeping AGENTS.md updated

Update this file when adding modules or routes, changing the auth/proxy flow, modifying build/test tooling or bindings, or changing deployment. Keep README.md and DEPLOY.md consistent with it.
