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
- **Pairs `search` with docs** — when the agent searches for endpoints, the proxy also queries the upstream documentation tool and appends that context to the result, so the agent gets both the methods/payloads *and* how the product works. Fails safe: if docs can't be fetched, the plain search result is returned unchanged.
- **Serves a landing page + OAuth consent screen** (Astro + React/shadcn/ReUI).

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
- **Secrets Store:** `WORKER_API_KEY` (the access gate), `CLOUDFLARE_WRANGLER_API_TOKEN` (privileged token forwarded upstream), `CLOUDFLARE_ACCOUNT_ID` (injected into `execute`), `REUI_LICENSE_KEY`
- **Var:** `UPSTREAM_MCP_URL` (defaults to `https://mcp.cloudflare.com/mcp`)
- `preview_urls` is `false` — see DEPLOY.md.

The upstream token can be either a **user token** or an **account token**; for account tokens include **Account Resources : Read** so the account ID auto-detects. API tokens with **Client IP Address Filtering** enabled are not supported.

## Development

```bash
pnpm run dev          # astro dev
pnpm run check        # format:check + lint + typecheck
pnpm run test         # vitest (Workers pool)
```

See **[AGENTS.md](./AGENTS.md)** for architecture, conventions, and contribution guidance.

## About Code Mode (upstream)

The tools this proxy exposes come from Cloudflare's Code Mode server: the agent writes JavaScript to `search` the OpenAPI spec and `execute` `cloudflare.request()` calls, fitting ~2,500 endpoints into ~1k tokens. Learn more:

- [Code Mode blog post](https://blog.cloudflare.com/code-mode-mcp/)
- [Cloudflare's own MCP servers](https://github.com/cloudflare/mcp-server-cloudflare)
- [Build a remote MCP server](https://developers.cloudflare.com/agents/guides/remote-mcp-server/)
