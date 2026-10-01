import { describe, expect, it } from 'vitest'
import {
  extractSingleCloudflareRequest,
  normaliseAccountPath,
  requiresUserToken
} from '../src/lib/cf-request-rescue'

const ACC = 'b3304b14848de15c72c24a14b0cd187d'

describe('requiresUserToken — measured, not assumed', () => {
  it('requires the user token for /builds/*', () => {
    expect(requiresUserToken('/builds/builds')).toBe(true)
    expect(requiresUserToken('/builds/triggers')).toBe(true)
  })

  // These were measured returning 200 on the account token, so the narrower
  // credential stays the default for them.
  it('does not for paths the account token reaches', () => {
    expect(requiresUserToken('/workers/scripts')).toBe(false)
    expect(requiresUserToken('/d1/database')).toBe(false)
    expect(requiresUserToken('/storage/kv/namespaces')).toBe(false)
  })
})

describe('normaliseAccountPath', () => {
  it('strips an explicit account segment', () => {
    expect(normaliseAccountPath(`/accounts/${ACC}/builds/builds`)).toBe('/builds/builds')
  })

  // The dominant real shape: the account id was interpolated. Stripping the
  // segment without reading it is what makes those rescuable.
  it('strips an interpolated account segment', () => {
    expect(normaliseAccountPath('/accounts/${acc}/builds/triggers')).toBe('/builds/triggers')
  })

  it('accepts an already-relative path', () => {
    expect(normaliseAccountPath('/builds/builds')).toBe('/builds/builds')
  })

  // An unresolved value anywhere else is a runtime value we cannot know, so the
  // rescue must be abandoned rather than guessed at.
  it('refuses interpolation outside the account segment', () => {
    expect(normaliseAccountPath('/accounts/x/builds/builds/${uuid}/logs')).toBeNull()
  })

  it('refuses a path with nothing after the account', () => {
    expect(normaliseAccountPath(`/accounts/${ACC}`)).toBeNull()
  })
})

describe('extractSingleCloudflareRequest — only the faithfully replayable shape', () => {
  it('extracts the plain single-call shape', () => {
    const r = extractSingleCloudflareRequest(
      `async () => await cloudflare.request({ method: "GET", path: "/accounts/${ACC}/builds/builds" })`
    )
    expect(r).toEqual({ method: 'GET', path: '/builds/builds' })
  })

  it('handles a braced body with return', () => {
    const r = extractSingleCloudflareRequest(
      `async () => { return await cloudflare.request({ method: "GET", path: "/builds/triggers" }) }`
    )
    expect(r).toEqual({ method: 'GET', path: '/builds/triggers' })
  })

  it('defaults the method to GET', () => {
    expect(
      extractSingleCloudflareRequest('async () => cloudflare.request({ path: "/builds/builds" })')
        ?.method
    ).toBe('GET')
  })

  it('carries literal query and body', () => {
    const r = extractSingleCloudflareRequest(
      `async () => await cloudflare.request({ method: "POST", path: "/builds/triggers", query: { page: 1, q: 'x' }, body: { deploy_command: "pnpm run deploy:ci" } })`
    )
    expect(r?.query).toEqual({ page: 1, q: 'x' })
    expect(r?.body).toEqual({ deploy_command: 'pnpm run deploy:ci' })
  })

  // THE important negative. Post-processing means the raw API response is NOT what
  // the code would have returned, so replaying it would silently hand back a
  // different shape. Failing is correct here; succeeding would be a data bug.
  it('refuses code that post-processes the response', () => {
    expect(
      extractSingleCloudflareRequest(
        `async () => { const r = await cloudflare.request({ method:"GET", path:"/builds/builds" }); return { n: r.result.length } }`
      )
    ).toBeNull()
  })

  it('refuses code making more than one call', () => {
    expect(
      extractSingleCloudflareRequest(
        `async () => { await cloudflare.request({ path:"/builds/a" }); return await cloudflare.request({ path:"/builds/b" }) }`
      )
    ).toBeNull()
  })

  it('refuses a non-literal argument', () => {
    expect(extractSingleCloudflareRequest('async () => await cloudflare.request(opts)')).toBeNull()
  })

  it('refuses an unparseable query rather than dropping it', () => {
    expect(
      extractSingleCloudflareRequest(
        'async () => await cloudflare.request({ path: "/builds/builds", query: { page: someVar } })'
      )
    ).toBeNull()
  })

  it('refuses a method it will not issue', () => {
    expect(
      extractSingleCloudflareRequest(
        'async () => await cloudflare.request({ method: "TRACE", path: "/builds/builds" })'
      )
    ).toBeNull()
  })

  it('refuses code with no cloudflare call at all', () => {
    expect(extractSingleCloudflareRequest('async () => 1 + 1')).toBeNull()
    expect(extractSingleCloudflareRequest('')).toBeNull()
  })
})
