/**
 * Stop agents concluding they are blocked when the right tool is right here.
 *
 * ## The mistake this exists to prevent
 *
 * The `execute` tool is forwarded to the upstream Code Mode server
 * (`mcp.cloudflare.com`) carrying the **account-scoped** token. Every Cloudflare
 * `/builds/*` path refuses that token with `12006 "Invalid token"`. Measured
 * 2026-09-30 across eight distinct endpoints (`/builds/triggers`,
 * `/builds/workers/{tag}/triggers`, `/builds/workers/{tag}`,
 * `/builds/workers/{tag}/builds`, `/builds/builds`, `/builds/builds/latest`,
 * `/builds/repos/connections`, `/builds/tokens`), while `/workers/scripts/*` and
 * `/d1/*` return `200` on the same token.
 *
 * The user token that *would* work cannot be substituted on that path: the
 * upstream rejects it outright with `403 insufficient_scope` ("Token lacks
 * required user:read or account:read scope"). So there is no credential fix
 * available to `execute`.
 *
 * But this server already serves `workers_*` tools **locally**, and those call
 * the Cloudflare API directly with the user token — so they reach `/builds/*`
 * perfectly well. The capability is present; only `execute`'s route to it is not.
 *
 * Multiple independent agents have hit the `12006`, generalised from it, and
 * reported to the operator that they were blocked and needed a token exported or
 * the dashboard — while the tool that does the job sat in the same `tools/list`
 * they had already read. The error is the moment they form that belief, so the
 * error is where the correction has to arrive.
 *
 * ## What this does
 *
 * Given an `execute` call whose code referenced a `/builds/*` path and whose
 * result carries a Cloudflare auth refusal, it appends a short, factual note
 * naming the local tool that covers that path. It never suppresses or alters the
 * original error text, and it never fires on anything else.
 */

/** A local tool recommendation for one family of `/builds/*` paths. */
interface BuildsRoute {
  /** Matches the path that appeared in the `execute` code. */
  test: RegExp
  /** Local tool(s) that reach it, most specific first. */
  tools: string[]
  /** What the caller was evidently trying to do. */
  intent: string
}

/**
 * Path families, most specific first — the first match wins, so
 * `/builds/builds/{uuid}/logs` must be tested before `/builds/builds`.
 */
const BUILDS_ROUTES: BuildsRoute[] = [
  {
    test: /\/builds\/builds\/[^/\s"']+\/logs/,
    tools: ['workers_build_logs_get', 'workers_build_logs_search'],
    intent: 'read a build log'
  },
  {
    test: /\/builds\/builds\/[^/\s"']+\/cancel/,
    tools: [],
    intent: 'cancel a build'
  },
  {
    test: /\/builds\/(?:builds\/latest|builds\b|workers\/[^/\s"']+\/builds)/,
    tools: ['workers_builds_list'],
    intent: 'list builds'
  },
  {
    test: /\/builds\/(?:triggers|workers\/[^/\s"']+\/triggers|workers\/[^/\s"']+(?:["'\s]|$)|repos\/connections)/,
    tools: ['workers_cicd_get', 'workers_cicd_configure'],
    intent: 'read or change the build configuration'
  },
  {
    test: /\/builds\/(?:tokens|account\/limits)/,
    tools: [],
    intent: 'read build tokens or account build limits'
  }
]

/** Any `/builds/` path at all — the catch-all once the specific ones miss. */
const ANY_BUILDS_PATH = /\/builds\//

/**
 * Did this `execute` code touch a Cloudflare `/builds/*` path?
 *
 * Deliberately a substring match over the raw code rather than a parse: the path
 * may be built by concatenation, a template literal, or a variable, and a false
 * negative here costs an agent the whole misdiagnosis this module exists to stop.
 * A false positive only appends a note to a response that already failed on auth.
 *
 * @param code the `code` argument the caller passed to `execute`
 * @returns the matching route, or null when no `/builds/` path is present
 */
export function matchBuildsRoute(code: string): BuildsRoute | null {
  if (!code || !ANY_BUILDS_PATH.test(code)) return null
  return (
    BUILDS_ROUTES.find((r) => r.test.test(code)) ?? {
      test: ANY_BUILDS_PATH,
      tools: ['workers_cicd_get', 'workers_builds_list'],
      intent: 'reach a Workers Builds endpoint'
    }
  )
}

/**
 * The note appended to a refused `/builds/*` result.
 *
 * Written for a reader who has just decided they are blocked: it states what is
 * true, names the tool, and closes the two escape hatches they otherwise reach
 * for (exporting a token, asking the operator to use the dashboard).
 */
export function buildsGuidanceText(route: BuildsRoute): string {
  const lines = [
    '',
    '--- cloudflare-api-mcp: this is not a credential problem, and you are not blocked ---',
    '',
    'Every Cloudflare /builds/* path refuses the token `execute` carries, because',
    '`execute` is forwarded upstream with an ACCOUNT-scoped token. Substituting the',
    'user token is not possible here: the upstream rejects it with 403',
    'insufficient_scope. So no amount of retrying, re-scoping or exporting a token',
    'will make this call work.',
    '',
    `You were trying to ${route.intent}. This server already serves tools that do it,`,
    'LOCALLY, calling the Cloudflare API with a user token that does reach /builds/*:'
  ]

  if (route.tools.length > 0) {
    for (const t of route.tools) lines.push(`  - ${t}`)
    lines.push('', 'Call one of those instead. They are in the tools/list you already have.')
  } else {
    lines.push(
      '  (no local tool wraps this exact endpoint yet)',
      '',
      'Related tools that do work: workers_cicd_get, workers_builds_list,',
      'workers_build_logs_get. If none covers what you need, say so plainly —',
      'this endpoint genuinely has no route from here.'
    )
  }

  lines.push(
    '',
    'Do NOT report this as blocked, ask for CLOUDFLARE_USER_WRANGLER_API_TOKEN to be',
    'exported, or ask anyone to use the Cloudflare dashboard. Several agents have',
    'done exactly that from this error while the tool above sat unused.',
    '--- end note ---'
  )
  return lines.join('\n')
}

/**
 * Append the guidance to a tool result's text content.
 *
 * The original error is left byte-for-byte intact and the note is added after it,
 * so nothing a caller already parses out of the result changes shape.
 *
 * @param parsed a parsed JSON-RPC response (single message or batch)
 * @param guidance text to append
 * @returns the response with guidance appended to each text block, or the input
 *   unchanged when it has no text content to append to
 */
export function appendGuidanceToResult(parsed: unknown, guidance: string): unknown {
  const patch = (msg: unknown): unknown => {
    if (!msg || typeof msg !== 'object') return msg
    const m = msg as { result?: { content?: Array<{ type?: string; text?: string }> } }
    const content = m.result?.content
    if (!Array.isArray(content)) return msg
    let touched = false
    const next = content.map((block) => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return block
      touched = true
      return { ...block, text: block.text + guidance }
    })
    if (!touched) return msg
    return { ...m, result: { ...m.result, content: next } }
  }
  return Array.isArray(parsed) ? parsed.map(patch) : patch(parsed)
}

/**
 * The hint appended to the upstream `execute` tool's own description.
 *
 * Catches the mistake one step earlier, when the model is choosing a tool rather
 * than recovering from an error. Kept to two sentences because a description is
 * read in bulk alongside every other tool.
 */
export const EXECUTE_DESCRIPTION_HINT =
  '\n\nIMPORTANT — Workers Builds: Cloudflare /builds/* paths are NOT reachable from ' +
  'this tool (it carries an account-scoped token; those paths require a user token ' +
  'the upstream will not accept). For build configuration, build lists and build ' +
  "logs use this server's own workers_cicd_*, workers_builds_list and " +
  'workers_build_logs_* tools, which do reach them. Do not report /builds/* as blocked.'

/** Append the hint to the `execute` tool descriptor in a `tools/list` result. */
export function annotateExecuteDescription(parsed: unknown): unknown {
  const annotate = (msg: unknown): unknown => {
    if (!msg || typeof msg !== 'object') return msg
    const m = msg as { result?: { tools?: Array<{ name?: string; description?: string }> } }
    const tools = m.result?.tools
    if (!Array.isArray(tools)) return msg
    let touched = false
    const next = tools.map((t) => {
      if (t?.name !== 'execute' || typeof t.description !== 'string') return t
      // Idempotent: never stack the hint if the response is annotated twice.
      if (t.description.includes('Workers Builds: Cloudflare /builds/*')) return t
      touched = true
      return { ...t, description: t.description + EXECUTE_DESCRIPTION_HINT }
    })
    if (!touched) return msg
    return { ...m, result: { ...m.result, tools: next } }
  }
  return Array.isArray(parsed) ? parsed.map(annotate) : annotate(parsed)
}
