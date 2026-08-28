import { describe, expect, it } from 'vitest'
import { deriveS256Challenge, isAllowedRedirectUri, verifyPkce } from '../src/lib/oauth'

// RFC 7636 Appendix B official test vector.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

describe('deriveS256Challenge', () => {
  it('matches the RFC 7636 test vector', async () => {
    expect(await deriveS256Challenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE)
  })

  it('produces url-safe, unpadded output', async () => {
    const challenge = await deriveS256Challenge('some-other-verifier-value-1234567890')
    expect(challenge).not.toMatch(/[+/=]/)
  })
})

describe('verifyPkce', () => {
  it('accepts a correct S256 verifier', async () => {
    expect(await verifyPkce(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true)
    expect(await verifyPkce(RFC_VERIFIER, RFC_CHALLENGE, 'S256')).toBe(true)
  })

  it('rejects an incorrect S256 verifier', async () => {
    expect(await verifyPkce('wrong-verifier', RFC_CHALLENGE, 'S256')).toBe(false)
  })

  it('refuses the plain method (no downgrade on a privileged endpoint)', async () => {
    // Even when verifier === challenge, plain must not be honored.
    expect(await verifyPkce('abc123', 'abc123', 'plain')).toBe(false)
  })

  it('rejects unsupported methods', async () => {
    expect(await verifyPkce(RFC_VERIFIER, RFC_CHALLENGE, 'S512')).toBe(false)
  })

  it('rejects empty inputs', async () => {
    expect(await verifyPkce('', RFC_CHALLENGE)).toBe(false)
    expect(await verifyPkce(RFC_VERIFIER, '')).toBe(false)
  })
})

describe('isAllowedRedirectUri', () => {
  it('accepts a URI registered for the client', () => {
    expect(isAllowedRedirectUri('https://app.example/cb', ['https://app.example/cb'])).toBe(true)
  })

  it('rejects a URI not registered for the client', () => {
    expect(isAllowedRedirectUri('https://evil.example/cb', ['https://app.example/cb'])).toBe(false)
  })

  it('falls back to the built-in defaults when the client has no registration', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/oauth_callback', undefined)).toBe(true)
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/oauth_callback', [])).toBe(true)
    expect(isAllowedRedirectUri('https://evil.example/cb', undefined)).toBe(false)
  })

  it('requires an exact match (no prefix/substring)', () => {
    expect(isAllowedRedirectUri('https://app.example/cb/../evil', ['https://app.example/cb'])).toBe(
      false
    )
    expect(isAllowedRedirectUri('', ['https://app.example/cb'])).toBe(false)
  })
})
