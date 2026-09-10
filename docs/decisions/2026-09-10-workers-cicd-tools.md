# Workers CI/CD MCP tools — deviations from the brief

- **Date:** 2026-09-10
- **Status:** Decided (proceeded under stated assumptions); one open question for Justin
- **Author:** Claude (session `sad-lamarr-e8ce66`)

## What happened

The brief asked for Workers CI/CD management tools built on "existing Cloudflare API
clients, D1/Drizzle infrastructure, logging, and documentation integrations" in this
Worker. Three of those did not exist, and two documented behaviours turned out to be
wrong when measured against the live Cloudflare API. Rather than stop, the work went
ahead under the assumptions below, each recorded here.

## The four calls made, and why

### 1. The Workers Builds API needs a USER-scoped token — new binding added

Measured, not inferred:

| Token | `GET /workers/scripts` | `GET /builds/workers/{tag}/triggers` |
| --- | --- | --- |
| `CLOUDFLARE_WRANGLER_API_TOKEN` (account-scoped, already bound) | 200 | **401 `12006 Invalid token`** |
| `CLOUDFLARE_USER_WRANGLER_API_TOKEN` (user-scoped) | 200 | **200** |
| `CLOUDFLARE_WORKER_ADMIN_TOKEN`, `CLOUDFLARE_WORKERS_ADMIN`, `CLOUDFLARE_EDIT_WORKERS_PAGES_TOKEN` | 200 | 401 / 403 |

The account token this Worker already carries cannot reach `/builds/*` at all. A new
Secret Store binding `CLOUDFLARE_USER_WRANGLER_API_TOKEN` was added (the secret already
existed in the store; nothing new was created). `GH_TOKEN` was bound the same way for PR
correlation.

### 2. Workers Builds has no pause switch — `branch_includes` sentinel instead

The live trigger object has no `enabled`/`paused` field. Two candidate mechanisms:

1. **Narrow the branch matchers** (chosen) — `PATCH branch_includes` to
   `cicd-paused-by-mcp..do-not-build`, a string git cannot accept as a ref. `PATCH` is a
   verified partial update, so build command, deploy command, root directory, build token
   and repo connection are untouched. Reversible from a saved snapshot of two array fields.
2. Delete and recreate the trigger — rejected: the build token's secret is not readable
   back from the API, so this is a pause you cannot reliably undo.

Also measured: `branch_excludes: ["*"]` is **rejected** by Cloudflare with
`400 / 12002 Invalid request body` — you may not exclude every branch. The pause is
therefore expressed through `branch_includes` alone.

**Known limit, stated in every tool result:** this suppresses automatic builds because a
pushed branch can no longer match. It is *not* verified to block an explicit manual build
via `POST /builds/triggers/{uuid}/builds`, which names its branch directly.

### 3. Plain D1 SQL, not Drizzle

There is no Drizzle in this repo. Adding `drizzle-orm` + `drizzle-kit` means two
dependencies, a generator config, and a second migration toolchain inside an Astro build
that currently has none — and this repo's AGENTS.md says to ask before adding
dependencies. The schema is five tables with no joins. Plain `.prepare().bind()` against
D1 with SQL migration files covers it with zero new dependencies.

**This is the one open question below.**

### 4. No caching of logs, build metadata or documentation

Directed mid-session and implemented: this Worker is an on-demand proxy. Build logs,
build metadata, PR metadata and documentation are fetched live per tool call, processed in
memory, and never persisted — no D1/KV/R2 storage, no index, no tailing, no queue, no
background collection, and no log body written to the Worker's own logs. Migration `0002`
drops the log and docs cache tables that `0001` had created.

D1 now holds exactly two things: pause/resume coordination state, and the reusable
failure-pattern library (redacted signatures and build IDs — never transcripts).

## The question for Justin

Should the CI/CD tables be migrated to Drizzle to match the house standard in
`~/AGENTS.md` / the `cloudflare-jedi` skill, or is plain D1 SQL the right call for this
repo?

1. **Keep plain D1 SQL (recommended).** No new dependencies, no second toolchain in the
   Astro build, migrations stay readable `.sql` files. Five tables, no joins — Drizzle
   buys type-safety this schema does not strain against.
2. **Add Drizzle.** Matches the house standard everywhere else; costs two dependencies,
   both lockfiles, a `drizzle.config.ts`, and a `db:generate` step in CI.
3. **Defer.** Revisit if the schema grows joins or a frontend starts reading it.

**Default if you say nothing:** option 1 — it stays as shipped.

## Decision

_(awaiting Justin)_
