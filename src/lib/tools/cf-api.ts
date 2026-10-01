/**
 * A first-class door to the Cloudflare API, so `execute` is not the only one.
 *
 * ## Why this tool exists
 *
 * Agents reach for `execute` to make Cloudflare API calls, and `execute` is
 * forwarded to the upstream Code Mode server with the **account-scoped** token.
 * Every `/builds/*` path refuses that token with `12006 "Invalid token"`
 * (measured 2026-09-30 across eight endpoints), and the token that works cannot
 * be substituted upstream — `mcp.cloudflare.com` rejects it with `403
 * insufficient_scope`. Agents repeatedly read that as "I am blocked" and escalated
 * to a human.
 *
 * `cloudflare_api_request` removes the guesswork: it runs **here**, with the
 * credential this server already holds for its own tools, so the whole API
 * surface — `/builds/*` included — is reachable through one predictable call. No
 * sandbox, no JavaScript, no token selection for the caller to get wrong.
 *
 * Prefer it over `execute` for any single Cloudflare API request. `execute` is
 * still the right tool when you genuinely need to run logic across several calls.
 */

import { CloudflareApiError } from '../cf-builds'
import { requiresUserToken } from '../cf-request-rescue'
import { optString, requireString, S, ToolError, type ToolDefinition } from './context'

/** Methods this tool will issue. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/**
 * Normalise a caller-supplied path to the `/accounts/{id}`-relative form.
 *
 * Callers write the path either way round — the full `/accounts/<id>/builds/...`
 * they would have used in `execute`, or just `/builds/...`. Both are accepted and
 * an explicit account segment is stripped, so a caller cannot accidentally target
 * another account and cannot be tripped up by the difference.
 */
export function normalisePath(raw: string): string {
  let p = raw.trim()
  if (!p.startsWith('/')) p = `/${p}`
  p = p.replace(/^\/client\/v4/, '')
  p = p.replace(/^\/accounts\/[^/]+/, '')
  if (p === '' || p === '/') {
    throw new ToolError('invalid_argument', 'path must name a resource under the account.')
  }
  return p
}

export const cfApiTools: ToolDefinition[] = [
  {
    name: 'cloudflare_api_request',
    title: 'Cloudflare API request',
    description:
      'Make one Cloudflare API v4 request against this account, server-side, with a ' +
      'token that reaches the whole surface INCLUDING /builds/* (Workers Builds). ' +
      'Prefer this over `execute` for any single Cloudflare API call: `execute` runs ' +
      'in the upstream sandbox with an account-scoped token that /builds/* refuses ' +
      'with 12006 "Invalid token", and that refusal cannot be fixed by retrying or ' +
      'by supplying a different token. `path` may be written either as the full ' +
      '/accounts/{account_id}/… or just the part after it — the account is filled in ' +
      'here either way. Returns the API envelope ({success, result, errors, ' +
      'result_info}) unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        path: S.str(
          'API path, with or without the /accounts/{account_id} prefix. ' +
            'Examples: "/builds/builds/{uuid}/logs", ' +
            '"/accounts/abc123/workers/scripts", "/d1/database".'
        ),
        method: S.str('HTTP method. Defaults to GET.', { enum: [...METHODS] }),
        query: {
          type: 'object',
          description: 'Query-string parameters. Values must be strings or numbers.',
          additionalProperties: { type: ['string', 'number'] }
        },
        body: {
          type: 'object',
          description: 'JSON request body, for POST/PUT/PATCH.',
          additionalProperties: true
        }
      },
      required: ['path'],
      additionalProperties: false
    },
    handler: async (args, ctx) => {
      const path = normalisePath(requireString(args, 'path'))
      const method = (optString(args, 'method') ?? 'GET').toUpperCase()
      if (!(METHODS as readonly string[]).includes(method)) {
        throw new ToolError(
          'invalid_argument',
          `method must be one of ${METHODS.join(', ')}; got ${method}.`
        )
      }

      const rawQuery = args.query
      let query: Record<string, string | number> | undefined
      if (rawQuery !== undefined) {
        if (!rawQuery || typeof rawQuery !== 'object' || Array.isArray(rawQuery)) {
          throw new ToolError('invalid_argument', 'query must be an object.')
        }
        query = {}
        for (const [k, v] of Object.entries(rawQuery as Record<string, unknown>)) {
          if (typeof v !== 'string' && typeof v !== 'number') {
            throw new ToolError(
              'invalid_argument',
              `query.${k} must be a string or number; got ${typeof v}.`
            )
          }
          query[k] = v
        }
      }

      const body = args.body
      if (body !== undefined && (!body || typeof body !== 'object')) {
        throw new ToolError('invalid_argument', 'body must be an object when present.')
      }
      if (body !== undefined && method === 'GET') {
        throw new ToolError('invalid_argument', 'a GET request cannot carry a body.')
      }

      try {
        const { result, resultInfo } = await ctx.cf.request<unknown>(method, path, { query, body })
        return {
          success: true,
          result,
          ...(resultInfo ? { result_info: resultInfo } : {}),
          errors: [],
          messages: [],
          request: { method, path, account_id: ctx.accountId },
          // Stated so a caller comparing this with a failed `execute` attempt can
          // see why this one worked, without having to be told at failure time.
          token_scope: requiresUserToken(path) ? 'user-scoped (required by this path)' : 'account'
        }
      } catch (err) {
        // A Cloudflare error is data about the request, not a server fault — hand
        // the envelope back so the caller can act on the real status and codes.
        if (err instanceof CloudflareApiError) {
          return {
            success: false,
            result: null,
            status: err.status,
            errors: err.errors ?? [],
            messages: [],
            request: { method, path, account_id: ctx.accountId }
          }
        }
        throw err
      }
    }
  }
]
