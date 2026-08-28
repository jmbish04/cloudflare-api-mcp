import { describe, expect, it } from 'vitest'
import { deriveS256Challenge, verifyPkce } from '../src/lib/oauth'

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

  it('supports the plain method', async () => {
    expect(await verifyPkce('abc123', 'abc123', 'plain')).toBe(true)
    expect(await verifyPkce('abc123', 'different', 'plain')).toBe(false)
  })

  it('rejects unsupported methods', async () => {
    expect(await verifyPkce(RFC_VERIFIER, RFC_CHALLENGE, 'S512')).toBe(false)
  })

  it('rejects empty inputs', async () => {
    expect(await verifyPkce('', RFC_CHALLENGE)).toBe(false)
    expect(await verifyPkce(RFC_VERIFIER, '')).toBe(false)
  })
})
