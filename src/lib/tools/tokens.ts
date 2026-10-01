/**
 * Cloudflare API token administration as MCP tools.
 *
 * See `lib/cf-tokens.ts` for the account-vs-user distinction and why it is
 * genuinely confusing. The rule these tools enforce: **creating or listing tokens
 * of a kind presents the credential of that same kind.** The caller picks a
 * `kind`; the credential follows from it and is never the caller's problem.
 *
 * Safety properties, all deliberate:
 *
 * - A created token's value is returned **once** (Cloudflare shows it once and
 *   never again) and is never written to D1, logged, or persisted anywhere here.
 * - Verification of this server's own credentials needs no secret from the caller.
 * - No tool deletes a token unless explicitly asked, and deletion requires the id.
 */

import { sql } from 'drizzle-orm'
import { auditTokens, type AuditableToken } from '../token-audit'
import { tokenAuditDeletions, tokenAuditRuns } from '../../db/schema'
import {
  CloudflareTokenClient,
  TokenApiError,
  rollTokenValue,
  tokenPaths,
  userQuotaHeadroom,
  verifyToken,
  type ApiToken,
  type PermissionGroup,
  type TokenKind
} from '../cf-tokens'
import {
  optNumber,
  optString,
  requireString,
  S,
  ToolError,
  type ToolContext,
  type ToolDefinition
} from './context'

/**
 * The credential that can administer tokens of this kind.
 *
 * MEASURED 2026-09-30, because the intuitive mapping is wrong: the *wrangler user*
 * token is refused on `/user/tokens` with `9109 Unauthorized`. It reaches
 * `/builds/*` but cannot administer tokens at all. Only
 * `CLOUDFLARE_USER_TOKEN_ADMIN` can. Account-owned tokens, by contrast, are
 * administered by the ordinary account credential.
 */
function credentialFor(ctx: ToolContext, kind: TokenKind): string {
  const token = kind === 'account' ? ctx.cfTokens.account : ctx.cfTokens.userAdmin
  if (!token) {
    const binding =
      kind === 'account' ? 'CLOUDFLARE_WRANGLER_API_TOKEN' : 'CLOUDFLARE_USER_TOKEN_ADMIN'
    throw new ToolError(
      'not_configured',
      `Administering ${kind} tokens needs the ${binding} binding, which is not ` +
        `resolvable here. Note the wrangler USER token cannot do this — it is ` +
        `refused on /user/tokens with 9109 even though it reaches /builds/*.`
    )
  }
  return token
}

function readKind(args: Record<string, unknown>): TokenKind {
  const raw = (optString(args, 'kind') ?? 'account').toLowerCase()
  if (raw !== 'account' && raw !== 'user') {
    throw new ToolError('invalid_argument', 'kind must be "account" or "user".')
  }
  return raw
}

/** Strip the secret from anything about to be returned. */
function withoutValue(token: ApiToken): Omit<ApiToken, 'value'> {
  const { value: _value, ...rest } = token
  return rest
}

const KIND_ARG = S.str(
  'Which token surface: "account" for durable account-owned tokens (cfat_ prefix, ' +
    'Cloudflare\'s recommended default for CI/CD), or "user" for tokens acting as a ' +
    'user. Some services — Workers Builds among them — only accept user tokens. ' +
    'Defaults to "account".',
  { enum: ['account', 'user'] }
)

export const tokenTools: ToolDefinition[] = [
  {
    name: 'cloudflare_token_verify',
    title: 'Verify Cloudflare API tokens',
    description:
      'Check whether a Cloudflare API token is live and what it reports about ' +
      "itself. With no arguments it verifies THIS server's own account and user " +
      'credentials — the fastest way to tell a genuine permission problem from a ' +
      'dead or expired token, and it needs no secret from you. Optionally verify a ' +
      'supplied token value instead (never logged, stored, or echoed back). ' +
      "Verification presents the token to its own kind's verify endpoint, so a " +
      'token of the wrong kind for the endpoint reports as invalid rather than ' +
      'erroring.',
    inputSchema: S.obj(
      "Verify a token, or this server's own credentials.",
      {
        token_value: S.str(
          "A token value to verify instead of this server's own. Never logged or stored."
        ),
        kind: KIND_ARG
      },
      []
    ),
    async handler(args, ctx: ToolContext) {
      const supplied = optString(args, 'token_value')

      if (supplied) {
        const kind = readKind(args)
        const outcome = await verifyToken(supplied, kind, ctx.accountId)
        return {
          checked: `supplied ${kind} token`,
          valid: outcome.ok,
          ...(outcome.ok
            ? { token: withoutValue(outcome.result) }
            : { status: outcome.status, errors: outcome.errors }),
          note: 'The supplied value was not logged, stored, or returned.'
        }
      }

      // Default: verify both of this server's own credentials. Each against its own
      // kind's endpoint, because presenting one to the other reports invalid.
      const results: Record<string, unknown> = {}
      for (const kind of ['account', 'user'] as TokenKind[]) {
        const cred = kind === 'account' ? ctx.cfTokens.account : ctx.cfTokens.user
        if (!cred) {
          results[kind] = { configured: false, valid: null, reason: 'binding not resolvable' }
          continue
        }
        const outcome = await verifyToken(cred, kind, ctx.accountId)
        results[kind] = outcome.ok
          ? { configured: true, valid: true, token: withoutValue(outcome.result) }
          : { configured: true, valid: false, status: outcome.status, errors: outcome.errors }
      }
      return {
        checked: "this server's own credentials",
        tokens: results,
        note:
          'A valid token that still gets 12006 on /builds/* is not broken — Workers ' +
          'Builds does not accept account-owned tokens. Use the user credential there.'
      }
    }
  },
  {
    name: 'cloudflare_token_list',
    title: 'List Cloudflare API tokens',
    description:
      'List existing account-owned or user API tokens, so an existing token can be ' +
      'reused rather than minting another. Token values are never returned — ' +
      'Cloudflare only discloses a value at creation. Returns id, name, status and ' +
      'expiry.',
    inputSchema: S.obj(
      'List API tokens.',
      { kind: KIND_ARG, per_page: S.num('Tokens per page. Default 50.') },
      []
    ),
    async handler(args, ctx: ToolContext) {
      const kind = readKind(args)
      const client = new CloudflareTokenClient({ token: credentialFor(ctx, kind) })
      const env = await client.request<ApiToken[]>('GET', tokenPaths(kind, ctx.accountId).root, {
        query: { per_page: optNumber(args, 'per_page') ?? 50 }
      })
      const tokens = env.result ?? []
      const total = Number(
        (env.result_info as { total_count?: number })?.total_count ?? tokens.length
      )
      return {
        kind,
        tokens: tokens.map(withoutValue),
        count: tokens.length,
        // The user surface has a hard quota of 50 and hitting it is how a Workers
        // Builds setup fails confusingly, so the headroom is reported every time
        // rather than left for the caller to work out after a refusal.
        ...(kind === 'user' ? { quota: userQuotaHeadroom(total) } : { total_count: total }),
        note:
          kind === 'user'
            ? 'User tokens are capped at 50 per account. Prefer reusing or rolling an ' +
              'existing token over creating another.'
            : 'Values are never returned. Reuse an existing token where one fits.'
      }
    }
  },
  {
    name: 'cloudflare_token_permission_groups',
    title: 'List token permission groups',
    description:
      'List the permission groups available for building a token policy, optionally ' +
      'filtered by name. Needed because a token policy references permission groups ' +
      'by id, and the available set differs between the account and user surfaces. ' +
      'Call this before cloudflare_token_create rather than guessing an id.',
    inputSchema: S.obj(
      'Discover permission groups for a token policy.',
      {
        kind: KIND_ARG,
        name_contains: S.str('Case-insensitive substring filter on the group name.')
      },
      []
    ),
    async handler(args, ctx: ToolContext) {
      const kind = readKind(args)
      const filter = optString(args, 'name_contains')?.toLowerCase()
      const client = new CloudflareTokenClient({ token: credentialFor(ctx, kind) })
      const env = await client.request<PermissionGroup[]>(
        'GET',
        tokenPaths(kind, ctx.accountId).permissionGroups,
        { query: { per_page: 1000 } }
      )
      const all = env.result ?? []
      const groups = filter ? all.filter((g) => (g.name ?? '').toLowerCase().includes(filter)) : all
      return {
        kind,
        permission_groups: groups.map((g) => ({ id: g.id, name: g.name, scopes: g.scopes })),
        returned: groups.length,
        total_available: all.length,
        note:
          "Pass the ids in cloudflare_token_create's policies. For Workers Builds, " +
          'the relevant group is on the USER surface — account-owned tokens are not ' +
          'accepted by that service.'
      }
    }
  },
  {
    name: 'cloudflare_token_create',
    title: 'Create a Cloudflare API token',
    description:
      'Create an account-owned or user API token. The credential used is chosen from ' +
      "`kind` — an account token is created with this server's account credential " +
      'and a user token with its user credential, because each surface only accepts ' +
      'its own kind. Supply either `policies` (full Cloudflare policy objects) or ' +
      '`permission_group_ids` with `resources` for the common single-policy case. ' +
      'THE VALUE IS RETURNED ONCE: Cloudflare discloses it only at creation and this ' +
      'server does not store it — capture it from the response or it is unrecoverable. ' +
      'Check cloudflare_token_list first; reusing a token avoids handling a secret.',
    inputSchema: S.obj(
      'Create an API token.',
      {
        name: S.str('Token name, e.g. "workers-builds-ci".'),
        kind: KIND_ARG,
        permission_group_ids: S.strArray(
          'Permission group ids from cloudflare_token_permission_groups. Used with ' +
            '`resources` to build one policy.'
        ),
        resources: {
          type: 'object',
          description:
            'Resource map for the generated policy, e.g. ' +
            '{"com.cloudflare.api.account.<account_id>": "*"}. Defaults to this account.',
          additionalProperties: { type: 'string' }
        },
        policies: {
          type: 'array',
          description:
            'Full policy objects, if you need more than one policy or a deny effect. ' +
            'Takes precedence over permission_group_ids.',
          items: { type: 'object', additionalProperties: true }
        },
        expires_on: S.str('ISO-8601 expiry. Omit for a non-expiring token.'),
        verify_after_create: S.bool(
          'Verify the new token immediately and report the result. Default true.'
        )
      },
      ['name']
    ),
    async handler(args, ctx: ToolContext) {
      const kind = readKind(args)
      const name = requireString(args, 'name')
      const credential = credentialFor(ctx, kind)

      // Policies: either given wholesale, or assembled from group ids + resources.
      let policies = Array.isArray(args.policies) ? (args.policies as unknown[]) : undefined
      if (!policies) {
        const groupIds = Array.isArray(args.permission_group_ids)
          ? (args.permission_group_ids as unknown[]).filter(
              (g): g is string => typeof g === 'string'
            )
          : []
        if (groupIds.length === 0) {
          throw new ToolError(
            'invalid_argument',
            'Provide either `policies` or at least one `permission_group_ids` entry. ' +
              'Discover ids with cloudflare_token_permission_groups.'
          )
        }
        const resources =
          args.resources && typeof args.resources === 'object' && !Array.isArray(args.resources)
            ? (args.resources as Record<string, string>)
            : { [`com.cloudflare.api.account.${ctx.accountId}`]: '*' }
        policies = [
          {
            effect: 'allow',
            permission_groups: groupIds.map((id) => ({ id })),
            resources
          }
        ]
      }

      const body: Record<string, unknown> = { name, policies }
      const expires = optString(args, 'expires_on')
      if (expires) body.expires_on = expires

      const client = new CloudflareTokenClient({ token: credential })

      // Check the quota BEFORE attempting a create on the user surface. Cloudflare's
      // own refusal is opaque, and the useful answer is "roll one instead", which
      // needs the candidate list anyway.
      if (kind === 'user') {
        const existing = await client.request<ApiToken[]>(
          'GET',
          tokenPaths(kind, ctx.accountId).root,
          {
            query: { per_page: 100 }
          }
        )
        const total = Number(
          (existing.result_info as { total_count?: number })?.total_count ??
            (existing.result ?? []).length
        )
        const quota = userQuotaHeadroom(total)
        if (!quota.can_create) {
          throw new ToolError(
            'quota_exhausted',
            `The user API token quota is full (${total}/${quota.quota}), so Cloudflare ` +
              `will refuse a new one. Do NOT retry. Either delete a token you no longer ` +
              `need (cloudflare_token_delete), or — better for a build credential — ` +
              `reuse an existing one by rolling its value with ` +
              `cloudflare_token_roll_value, which keeps the count flat and preserves ` +
              `every association. workers_build_token_ensure does this for you.`
          )
        }
      }

      let created: ApiToken
      try {
        const env = await client.request<ApiToken>('POST', tokenPaths(kind, ctx.accountId).root, {
          body
        })
        created = env.result
      } catch (err) {
        if (err instanceof TokenApiError) {
          // Name the likely cause rather than passing the raw error up: presenting
          // the wrong KIND of credential is the single most common failure here.
          const hint =
            err.status === 403 || err.status === 401
              ? ` The ${kind} credential may lack token-provisioning permission. ` +
                `An account token needs "API Tokens Write" on the account; a user ` +
                `token needs "User API Tokens Write".`
              : ''
          throw new ToolError(
            'cloudflare_error',
            `Could not create the ${kind} token (HTTP ${err.status}).${hint} ` +
              `Cloudflare said: ${err.errors.map((e) => e.message).join('; ') || '(no detail)'}`
          )
        }
        throw err
      }

      const shouldVerify = args.verify_after_create !== false
      let verification: unknown
      if (shouldVerify && created.value) {
        const outcome = await verifyToken(created.value, kind, ctx.accountId)
        verification = outcome.ok
          ? { valid: true, status: outcome.result.status }
          : { valid: false, status: outcome.status, errors: outcome.errors }
      }

      return {
        kind,
        token: withoutValue(created),
        // The one place a secret is returned, because it is the only chance to get it.
        value: created.value ?? null,
        ...(verification ? { verification } : {}),
        value_handling:
          'Cloudflare discloses a token value only at creation. This server did not ' +
          'store it. Put it in the tokens CLI now if it is needed again — it cannot ' +
          'be read back, only replaced via the token value endpoint.'
      }
    }
  },
  {
    name: 'cloudflare_token_roll_value',
    title: 'Roll a token value in place',
    description:
      "Replace an existing API token's secret without creating a new token. The id, " +
      'name, policies and every association are preserved; only the value changes. ' +
      'This is the recovery path when the user token quota (50) is full: rolling ' +
      'keeps the count flat and still yields a working credential, where creating ' +
      'would simply be refused. THE NEW VALUE IS RETURNED ONCE and is not stored ' +
      'here. Anything still presenting the OLD value stops working immediately, so ' +
      'pick the token deliberately — confirm it with cloudflare_token_list first.',
    inputSchema: S.obj(
      "Roll an existing token's value.",
      {
        token_id: S.str('The token id (not its value).'),
        kind: KIND_ARG,
        verify_after_roll: S.bool('Verify the new value immediately. Default true.')
      },
      ['token_id']
    ),
    async handler(args, ctx: ToolContext) {
      const kind = readKind(args)
      const tokenId = requireString(args, 'token_id')
      const value = await rollTokenValue(credentialFor(ctx, kind), kind, ctx.accountId, tokenId)

      let verification: unknown
      if (args.verify_after_roll !== false) {
        const outcome = await verifyToken(value, kind, ctx.accountId)
        verification = outcome.ok
          ? { valid: true, status: outcome.result.status }
          : { valid: false, status: outcome.status, errors: outcome.errors }
      }
      return {
        kind,
        token_id: tokenId,
        value,
        ...(verification ? { verification } : {}),
        value_handling:
          'Returned once and not stored here. The previous value is now dead — update ' +
          'anything that held it (the tokens CLI, the Secret Store, a build token).',
        quota_note: 'Rolling does not consume a quota slot, which is why it beats creating.'
      }
    }
  },
  {
    name: 'workers_build_token_ensure',
    title: 'Ensure one shared Workers Builds token',
    description:
      'Get a working Workers Builds token, REUSING the shared one rather than minting ' +
      'another. This is the tool to call when a build needs a token: Workers Builds ' +
      'requires a user-scoped token, user tokens are capped at 50 per account, and ' +
      'creating one per build is how that cap gets hit — after which the dashboard ' +
      'simply refuses to configure builds. Reports what it found and what it would ' +
      'do; takes no destructive action unless explicitly allowed. Read-only by ' +
      'default.',
    inputSchema: S.obj(
      'Find or prepare the shared build token.',
      {
        build_token_name: S.str(
          'Name of the shared build token to look for. Default "workers-builds-shared".'
        ),
        allow_create: S.bool('Create the shared token if absent AND quota allows. Default false.'),
        allow_roll: S.bool(
          'If the shared token exists but is unusable, roll its value in place. ' +
            'Default false. Rolling kills the old value immediately.'
        )
      },
      []
    ),
    async handler(args, ctx: ToolContext) {
      const wantedName = optString(args, 'build_token_name') ?? 'workers-builds-shared'
      const admin = credentialFor(ctx, 'user')
      const client = new CloudflareTokenClient({ token: admin })

      // 1. What exists on the user surface, and how much room is left.
      const listed = await client.request<ApiToken[]>(
        'GET',
        tokenPaths('user', ctx.accountId).root,
        {
          query: { per_page: 100 }
        }
      )
      const userTokens = listed.result ?? []
      const total = Number(
        (listed.result_info as { total_count?: number })?.total_count ?? userTokens.length
      )
      const quota = userQuotaHeadroom(total)

      // 2. The existing Workers Builds tokens, which is what a trigger actually
      //    references. A build token WRAPS a user API token.
      const buildTokens = await ctx.cf.listBuildTokens()
      const sharedBuildToken =
        buildTokens.find((t) => (t.build_token_name ?? '') === wantedName) ?? null

      // 3. The matching user API token, by name convention.
      const sharedUserToken = userTokens.find((t) => (t.name ?? '') === wantedName) ?? null

      const actions: string[] = []
      let rolledValue: string | null = null

      if (sharedBuildToken) {
        actions.push(
          `Reusing existing build token "${sharedBuildToken.build_token_name}" ` +
            `(${sharedBuildToken.build_token_uuid}). Associate it with a trigger via ` +
            `workers_cicd_configure build_token_uuid.`
        )
      }

      if (sharedUserToken) {
        // Report the shared token's own state. Verifying it directly is impossible —
        // `verify` authenticates WITH the token, and its value is not readable — so
        // the status the list endpoint reports is the available signal.
        actions.push(
          `A user API token named "${wantedName}" exists (${sharedUserToken.id}, status ` +
            `${sharedUserToken.status ?? 'unknown'}, last used ` +
            `${sharedUserToken.last_used_on ?? 'never'}).`
        )
        const unusable = (sharedUserToken.status ?? '').toLowerCase() !== 'active'
        if (unusable && args.allow_roll === true) {
          rolledValue = await rollTokenValue(admin, 'user', ctx.accountId, sharedUserToken.id)
          actions.push(
            `Rolled its value in place — no quota slot consumed. The previous value is dead.`
          )
        } else if (unusable) {
          actions.push(
            `It is not active. Roll its value with allow_roll=true (preferred: keeps the ` +
              `count flat), rather than creating another.`
          )
        }
      } else if (!sharedBuildToken) {
        if (!quota.can_create) {
          actions.push(
            `No shared token found AND the user quota is full (${total}/${quota.quota}). ` +
              `Creating is impossible. Pick an existing user token to reuse and roll its ` +
              `value with cloudflare_token_roll_value, or delete one you no longer need.`
          )
        } else if (args.allow_create === true) {
          actions.push(
            `No shared token found. Quota allows creation (${quota.headroom} slot(s) ` +
              `free) — create it with cloudflare_token_create (kind "user", name ` +
              `"${wantedName}"), then wrap it with workers_build_token_create.`
          )
        } else {
          actions.push(
            `No shared token named "${wantedName}". Quota has ${quota.headroom} slot(s) ` +
              `free. Re-run with allow_create=true, or reuse one of the existing ` +
              `${buildTokens.length} build token(s).`
          )
        }
      }

      return {
        shared_token_name: wantedName,
        // The answer the caller needs first: is there something usable to reuse?
        reusable_build_token: sharedBuildToken
          ? {
              build_token_uuid: sharedBuildToken.build_token_uuid,
              build_token_name: sharedBuildToken.build_token_name
            }
          : null,
        user_token_quota: quota,
        existing_build_tokens: buildTokens.length,
        candidates_for_reuse: buildTokens
          .slice(0, 10)
          .map((t) => ({ build_token_uuid: t.build_token_uuid, name: t.build_token_name })),
        actions,
        ...(rolledValue ? { rolled_value: rolledValue } : {}),
        policy:
          'One shared build token is the intent. Do not create a token per build — ' +
          'that is what exhausts the 50-token user quota and makes the dashboard ' +
          'refuse to configure builds.'
      }
    }
  },
  {
    name: 'cloudflare_token_audit',
    title: 'Audit the user token quota',
    description:
      "Audit the account's user API tokens against the 50-token quota and report a " +
      'verdict and reason for every one. Dry-run by default: it deletes nothing ' +
      'unless apply=true, and even then only tokens that are PROVABLY dead — expired, ' +
      'non-active, or a recognisably generated build token that is unreferenced by ' +
      'any build trigger and unused past the retention window. Tokens with a KEEP ' +
      'marker in the name, tokens this server itself uses, tokens referenced by a ' +
      'build trigger, and long-lived credentials whose last_used_on does not track ' +
      'real use (tunnels, DNS, certificates) are protected and never deleted. Every ' +
      'run and every deletion is recorded in D1 with the full reasoning, so a ' +
      'deletion can always be explained later.',
    inputSchema: S.obj(
      'Audit, and optionally reclaim, user token quota.',
      {
        apply: S.bool('Actually delete the provably-dead tokens. Default false (report only).'),
        retention_days: S.num(
          'Idle days after which a generated build token becomes deletable. Default 180.'
        )
      },
      []
    ),
    async handler(args, ctx: ToolContext) {
      const retentionDays = Math.max(30, optNumber(args, 'retention_days') ?? 180)
      const apply = args.apply === true
      const startedAt = new Date()
      const admin = credentialFor(ctx, 'user')
      const client = new CloudflareTokenClient({ token: admin })

      const listed = await client.request<AuditableToken[]>(
        'GET',
        tokenPaths('user', ctx.accountId).root,
        { query: { per_page: 100 } }
      )
      const tokens = listed.result ?? []

      // Protect this server's own credentials. Resolved by asking each token which
      // id it is, rather than matching on name — a rename must not expose them.
      const protectedIds: string[] = []
      for (const cred of [ctx.cfTokens.user, ctx.cfTokens.userAdmin]) {
        if (!cred) continue
        const who = await verifyToken(cred, 'user', ctx.accountId)
        if (who.ok && who.result.id) protectedIds.push(who.result.id)
      }

      // A user token wrapped by a build token is in use whatever its timestamps say.
      const buildTokens = await ctx.cf.listBuildTokens().catch(() => [])
      const referencedIds = buildTokens
        .map((t) => (t as { cloudflare_token_id?: string }).cloudflare_token_id)
        .filter((id): id is string => typeof id === 'string')

      const summary = auditTokens(tokens, {
        retentionDays,
        protectedIds,
        referencedIds,
        now: startedAt
      })

      // Record the run first, so even a failure mid-deletion leaves a trace.
      let runId: number | null = null
      try {
        const inserted = await ctx.db
          .insert(tokenAuditRuns)
          .values({
            startedAt: startedAt.toISOString(),
            mode: apply ? 'applied' : 'dry_run',
            actor: ctx.actor,
            tokensSeen: summary.total,
            quota: summary.quota,
            headroomBefore: summary.headroom,
            verdictCounts: JSON.stringify(summary.counts),
            deletedCount: 0,
            retentionDays
          })
          .returning({ id: tokenAuditRuns.id })
        runId = inserted[0]?.id ?? null
      } catch {
        // Auditing is still worth doing without its bookkeeping.
      }

      const nominated = summary.verdicts.filter((v) => v.verdict === 'delete')
      const deleted: Array<{ id: string; name: string; ok: boolean }> = []

      // A deletion nobody can explain is worse than a full quota, so being unable to
      // record is a reason NOT to delete. Without the run row the per-deletion rows
      // cannot be written either (they key off it), which would destroy tokens with
      // no trace at /docs/token-audit — the exact outcome this feature prevents.
      if (apply && runId === null) {
        throw new ToolError(
          'audit_not_recordable',
          'Refusing to delete: the audit run could not be written to D1, so the ' +
            'deletions could not be recorded either and the tokens would disappear ' +
            'with no explanation. Check the CICD_DB binding and that migration ' +
            '0003_token_audit.sql has been applied, then re-run. The dry-run report ' +
            'above is unaffected.'
        )
      }

      if (apply) {
        // Narrowed by the guard above, and typed so the invariant is enforced by the
        // compiler rather than by reading the code.
        const recordedRunId: number = runId as number
        for (const v of nominated) {
          let ok = true
          try {
            await client.request<unknown>('DELETE', tokenPaths('user', ctx.accountId).byId(v.id))
          } catch {
            ok = false
          }
          deleted.push({ id: v.id, name: v.name, ok })
          // runId is non-null here: the guard above refuses to delete without it.
          {
            try {
              await ctx.db.insert(tokenAuditDeletions).values({
                runId: recordedRunId,
                deletedAt: new Date().toISOString(),
                tokenId: v.id,
                tokenName: v.name,
                idleDays: v.idle_days,
                reason: v.reason,
                failed: !ok
              })
            } catch {
              // The token is gone either way; losing one audit row is survivable.
            }
          }
        }
        {
          try {
            await ctx.db
              .update(tokenAuditRuns)
              .set({ deletedCount: deleted.filter((d) => d.ok).length })
              .where(sql`${tokenAuditRuns.id} = ${recordedRunId}`)
          } catch {
            /* best effort */
          }
        }
      }

      return {
        mode: apply ? 'applied' : 'dry_run',
        run_id: runId,
        quota: { quota: summary.quota, in_use: summary.total, headroom: summary.headroom },
        verdict_counts: summary.counts,
        reclaimable: summary.reclaimable,
        nominated_for_deletion: nominated.map((v) => ({
          id: v.id,
          name: v.name,
          idle_days: v.idle_days,
          reason: v.reason
        })),
        ...(apply ? { deleted } : {}),
        needs_human_review: summary.verdicts
          .filter((v) => v.verdict === 'review')
          .map((v) => ({ name: v.name, idle_days: v.idle_days, reason: v.reason })),
        protected: summary.verdicts
          .filter((v) => v.verdict === 'protected')
          .map((v) => ({ name: v.name, protection: v.protection })),
        audit_trail:
          'Runs are in D1 token_audit_runs; deletions in token_audit_deletions with the ' +
          'token NAME and the full reason, so a deletion can be explained later.',
        ...(apply
          ? {}
          : {
              note: 'Nothing was deleted. Re-run with apply=true to reclaim the nominated tokens.'
            })
      }
    }
  },
  {
    name: 'cloudflare_token_delete',
    title: 'Delete a Cloudflare API token',
    description:
      'Delete an account-owned or user API token by id. Irreversible: anything ' +
      'presenting that token stops working immediately. Use cloudflare_token_list to ' +
      'confirm the id and name first.',
    inputSchema: S.obj(
      'Delete an API token.',
      { token_id: S.str('The token id (not its value).'), kind: KIND_ARG },
      ['token_id']
    ),
    async handler(args, ctx: ToolContext) {
      const kind = readKind(args)
      const tokenId = requireString(args, 'token_id')
      const client = new CloudflareTokenClient({ token: credentialFor(ctx, kind) })
      await client.request<unknown>('DELETE', tokenPaths(kind, ctx.accountId).byId(tokenId))
      return {
        kind,
        deleted: tokenId,
        note: 'Irreversible. Anything presenting that token now fails authentication.'
      }
    }
  }
]
