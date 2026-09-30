# Upstream-proxy user-token fallback: keep, drop, or re-scope the token?

- **Date:** 2026-09-30
- **Status:** Decided 2026-09-30 — Option 1, PR #10 closed unmerged
- **Branch / PR:** [PR #10](https://github.com/jmbish04/cloudflare-api-mcp/pull/10), closed unmerged. The
  code it describes lives on `claude/cloudflare-user-token-auth-2747b6`; **this record is on
  `main` so it survives that branch being deleted.**

## What happened

PR #10 was built to fix "Workers build logs are unreachable because the Builds API
needs a user token". It added a `CLOUDFLARE_USER_WRANGLER_API_TOKEN` Secret Store
binding and made `/mcp` retry with that token whenever the account-scoped token was
refused.

While it was in flight, two other PRs landed on `main`:

- **#11** — serves 17 Workers CI/CD tools *locally* from this proxy (`src/lib/cf-builds.ts`,
  `src/lib/mcp-local.ts`), calling the Cloudflare API directly with the user token.
- **#12** — a `CloudflareOps` RPC entrypoint that resolves the same token.

Both independently measured the same fact PR #10 did, and #11's `cf-builds.ts` header
documents it: the account token is refused on `/builds/*` with `401` / code `12006`
"Invalid token", while a user token succeeds.

So `main` already carries the binding, and **the original need is already met**.
Measured on the deployed Worker, 2026-09-30: `workers_build_logs_get` returns a
126-line build transcript, and `workers_builds_list` returns real build metadata.

## The new measurement that changes PR #10's value

PR #10's remaining unique contribution is a fallback on the **upstream proxy** path —
the `search` / `execute` calls forwarded to `mcp.cloudflare.com`. `main` still forwards
those with the account token only.

That fallback cannot currently do anything, because **the upstream MCP server refuses
the user token outright**. Measured against `https://mcp.cloudflare.com/mcp`,
2026-09-30, identical request body, no protocol header:

| Token | Upstream response |
|---|---|
| `CLOUDFLARE_WRANGLER_API_TOKEN` (account) | `200` — accepted; the sandboxed builds call then fails `12006 Invalid token` |
| `CLOUDFLARE_USER_WRANGLER_API_TOKEN` (user) | `403 insufficient_scope` — "Token lacks required user:read or account:read scope" |

The retry therefore fires, receives a `403`, correctly classifies it as a refusal, and
returns the original account-token error. The code behaves exactly as designed; the
premise that a fallback would unblock builds *through `execute`* is what is false.

**Correction to an earlier report.** On 2026-09-08 this same call through the proxy
returned `12013 "Invalid query parameter"` — the user-token signature — and build logs
for this Worker returned 121 lines that way. That measurement was real. It is no longer
reproducible: the upstream now rejects the token on scope. The token itself still has
Builds access (main's local tools use it successfully right now), so the change is in the
upstream's auth, not in the credential.

## Why it matters

PR #10 in its rebased form is **430 added lines that currently buy nothing**: a duplicate
binding removed, docs merged, and a tested-but-dormant retry path. It is harmless — it
degrades to the original error and adds one extra upstream round trip only on a refusal —
but it also carries a caveat: a retry re-runs the sandboxed `execute` code from the top,
so a script that wrote something before hitting the refusal would write it twice.

## The question

Should the upstream-proxy user-token fallback be kept, dropped, or made live by
re-scoping the token?

## Options

1. **Close PR #10. (Recommended.)** `main` already solves build logs, and better — dedicated
   tools, a direct API call, no retry and therefore no double-execute hazard. The fallback
   is machinery for a problem that is now solved elsewhere, and it cannot function against
   the current upstream anyway. Cost: the `upstream-auth.ts` detection helper and its 18
   tests are discarded (recoverable from the branch).
2. **Merge PR #10 as rebased, dormant.** Keeps a tested fallback that starts working the
   moment the user token gains `user:read` or `account:read`. Cost: 430 lines and a retry
   path maintained for zero present benefit, plus the double-execute caveat.
3. **Add `account:read` to `CLOUDFLARE_USER_WRANGLER_API_TOKEN`, then merge.** Makes the
   fallback live, so `execute` can reach Builds endpoints the 17 local tools do not wrap.
   Cost: broadens a credential's scope, which is a security decision, and needs a change in
   the Cloudflare dashboard.

## Default if no answer

**Option 1** — close PR #10 without merging, and leave this record plus the branch in place
so the detection helper can be recovered if the upstream's behaviour changes back. Nothing
is lost from `main`, which already has the working implementation.

## Decision

**Option 1 — close PR #10 unmerged.** Justin concurred with the recommendation on
2026-09-30.

Rationale as recorded above: `main` already solves the original need (Workers build logs)
through #11's dedicated local tools, which call the Cloudflare API directly with the user
token — no retry, and therefore none of the double-execute hazard the proxy fallback
carries. The fallback's remaining unique surface is dormant because
`mcp.cloudflare.com` refuses the user token with `403 insufficient_scope`.

**What was done to close it out:**

- PR #10 closed without merging; `main` is unchanged by it.
- The branch `claude/cloudflare-user-token-auth-2747b6` holds `src/lib/upstream-auth.ts`
  and its 18 tests, recoverable if the upstream's scope behaviour changes back or the token
  gains `user:read` / `account:read`. **Deleting that branch is safe for this record** —
  the record is on `main`. Deleting it does discard the helper and tests, which would then
  have to be rewritten from the measurements documented here.
- Production was returned to clean `main`. During investigation the branch had been
  deployed to production (a superset of `main`); it was replaced with a build from
  `origin/main` and re-verified.

**If this is revisited,** the trigger to watch for is the upstream accepting a
Builds-scoped user token again — re-run the two-token comparison in the table above
before assuming the fallback would help.
