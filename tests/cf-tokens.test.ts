import { describe, expect, it } from 'vitest'
import {
  USER_TOKEN_QUOTA,
  kindFromTokenValue,
  tokenPaths,
  userQuotaHeadroom
} from '../src/lib/cf-tokens'

const ACC = 'b3304b14848de15c72c24a14b0cd187d'

describe('tokenPaths — the two surfaces must never be mixed', () => {
  it('scopes account token paths to the account', () => {
    const p = tokenPaths('account', ACC)
    expect(p.root).toBe(`/accounts/${ACC}/tokens`)
    expect(p.verify).toBe(`/accounts/${ACC}/tokens/verify`)
    expect(p.permissionGroups).toBe(`/accounts/${ACC}/tokens/permission_groups`)
    expect(p.byId('t1')).toBe(`/accounts/${ACC}/tokens/t1`)
    expect(p.value('t1')).toBe(`/accounts/${ACC}/tokens/t1/value`)
  })

  // User token endpoints are NOT account-scoped. Prefixing them with /accounts/{id}
  // is the mistake the generic builds client would have made.
  it('does not account-scope user token paths', () => {
    const p = tokenPaths('user', ACC)
    expect(p.root).toBe('/user/tokens')
    expect(p.verify).toBe('/user/tokens/verify')
    expect(p.value('t1')).toBe('/user/tokens/t1/value')
    expect(JSON.stringify(p)).not.toContain(ACC)
  })
})

describe('userQuotaHeadroom — the 50-token wall', () => {
  it('uses the documented quota', () => {
    expect(USER_TOKEN_QUOTA).toBe(50)
  })

  // The measured state on 2026-09-30: 48 in use, two from the wall.
  it('reports headroom below the cap', () => {
    expect(userQuotaHeadroom(48)).toEqual({
      quota: 50,
      in_use: 48,
      headroom: 2,
      can_create: true
    })
  })

  it('refuses creation exactly at the cap', () => {
    const at = userQuotaHeadroom(50)
    expect(at.headroom).toBe(0)
    expect(at.can_create).toBe(false)
  })

  // Cloudflare can report more than the quota; headroom must not go negative and
  // must still forbid creating.
  it('clamps above the cap rather than reporting negative headroom', () => {
    const over = userQuotaHeadroom(53)
    expect(over.headroom).toBe(0)
    expect(over.can_create).toBe(false)
  })

  it('allows creation on an empty account', () => {
    expect(userQuotaHeadroom(0).can_create).toBe(true)
  })
})

describe('kindFromTokenValue', () => {
  it('recognises the documented account-owned prefix', () => {
    expect(kindFromTokenValue('cfat_abc123')).toBe('account')
  })

  // A user token has no distinguishing prefix, so absence of cfat_ is NOT proof of
  // a user token — returning 'user' here would be a guess presented as a fact.
  it('returns null rather than guessing user', () => {
    expect(kindFromTokenValue('abcdef123456')).toBeNull()
    expect(kindFromTokenValue('')).toBeNull()
  })
})
