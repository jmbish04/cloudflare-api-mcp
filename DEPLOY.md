# Deploying

This is an **Astro SSR app on Cloudflare Workers** (`output: 'server'`, `@astrojs/cloudflare`). `astro build` emits two things that must be deployed together:

- `dist/server/entry.mjs` — the Worker (the entry point)
- `dist/client/` — the static assets (`_astro/*`, `_headers`, `_routes.json`)

## Deploy command

```bash
pnpm run deploy
```

which runs:

```bash
astro build && wrangler deploy -c ./wrangler.jsonc dist/server/entry.mjs --assets dist/client
```

The entry file and assets directory **must** be passed on the command line.

### Why `main` / `assets` are not in `wrangler.jsonc`

It's tempting to put `main: "./dist/server/entry.mjs"` and `assets: { directory: "./dist/client" }` in `wrangler.jsonc` so a bare `wrangler deploy` works. **Don't** — `astro build` reads `wrangler.jsonc` (via the Astro Cloudflare adapter / `@cloudflare/vite-plugin`) and fails the build:

```
The provided Wrangler config main field (dist/server/entry.mjs) doesn't point to an existing file
```

`main` points to the file the build is about to create, so it can't exist when the build starts. The entry/assets are therefore supplied at **deploy** time via the CLI, not in the config the **build** reads.

## Cloudflare Workers Builds (dash CI/CD)

Workers Builds runs its **Build command** and **Deploy command** from the Cloudflare dashboard — it does **not** read them from this repo. The default deploy command (`npx wrangler deploy`, no args) fails here with `Missing entry-point to Worker script or to assets directory`, which leaves production stale.

Set the commands in the dashboard (Workers & Pages → this Worker → Settings → Builds):

- **Simplest — one field:**
  - Deploy command: `pnpm run deploy`

- **Or, if Build and Deploy are separate fields:**
  - Build command: `pnpm run build`
  - Deploy command: `npx wrangler deploy dist/server/entry.mjs --assets dist/client`

Package manager: the repo ships both a `pnpm-lock.yaml` and a `package-lock.json`. Workers Builds auto-detects **pnpm** from the lockfile and installs with `pnpm install --frozen-lockfile`.

## Preview URLs

`preview_urls` is set to `false` in `wrangler.jsonc`. Workers Builds preview (non-production) deployments aren't reliably compatible with this Worker's runtime/bindings — their preview URL rendered incorrectly — so previews are disabled. Pinning `false` also stops a `wrangler deploy` from re-enabling them. Production deploys on `main` are unaffected.

To stop Workers Builds from *attempting* per-PR preview deployments at all, turn off non-production branch builds in the Worker's **Builds** settings (dashboard only — not configurable from `wrangler.jsonc`).

## Required bindings & secrets

`wrangler.jsonc` declares these; the Worker will not function without them:

- **KV namespaces:** `SESSION`, `OAUTH_KV`
- **Secrets Store secrets:** `WORKER_API_KEY`, `CLOUDFLARE_WRANGLER_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `REUI_LICENSE_KEY`
- **Var:** `UPSTREAM_MCP_URL`

`WORKER_API_KEY` is the value entered on the `/authorize` page during the OAuth flow; `CLOUDFLARE_WRANGLER_API_TOKEN` is the privileged token the `/mcp` proxy forwards upstream.

## Verifying a deploy

```bash
# Validate config + bundle without deploying (needs a prior `pnpm run build`):
pnpm exec wrangler deploy --dry-run -c ./wrangler.jsonc dist/server/entry.mjs --assets dist/client
```

After a real deploy, load `/` (should render the landing page) and confirm the MCP connector lists the `search` / `execute` tools.
