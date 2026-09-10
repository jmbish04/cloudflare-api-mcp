import { describe, expect, it } from 'vitest'
import { errorSignature, isSecretName, REDACTED, redactObject, redactText } from '../src/lib/redact'

describe('redactText', () => {
  it('strips GitHub tokens', () => {
    const out = redactText('using ghp_abcdefghijklmnopqrstuvwxyz0123456789 to auth')
    expect(out).not.toContain('ghp_abcdefghijklmnop')
    expect(out).toContain(REDACTED)
  })

  it('strips bearer headers and JWTs', () => {
    expect(redactText('Authorization: Bearer abcdef1234567890ABCDEF')).toContain(REDACTED)
    expect(redactText('token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4')).toContain(
      REDACTED
    )
  })

  it('keeps a named secret key but destroys its value', () => {
    const out = redactText('CLOUDFLARE_API_TOKEN=supersecretvalue123')
    expect(out).toContain('CLOUDFLARE_API_TOKEN')
    expect(out).not.toContain('supersecretvalue123')
  })

  it('leaves ordinary log text alone', () => {
    const line = 'Cloning repository... Success: Finished initializing build environment'
    expect(redactText(line)).toBe(line)
  })
})

describe('redactObject', () => {
  it('drops values of secret-looking keys entirely', () => {
    const out = redactObject({
      build_command: 'pnpm build',
      BUILD_TOKEN: 'abc',
      nested: { API_KEY: 'x' }
    })
    expect(out.build_command).toBe('pnpm build')
    expect(out.BUILD_TOKEN).toBe(REDACTED)
    expect(out.nested.API_KEY).toBe(REDACTED)
  })
})

describe('isSecretName', () => {
  it('classifies names, not values', () => {
    expect(isSecretName('GITHUB_TOKEN')).toBe(true)
    expect(isSecretName('MY_SECRET')).toBe(true)
    expect(isSecretName('NODE_VERSION')).toBe(false)
  })
})

describe('errorSignature', () => {
  it('prefers error lines, strips paths and urls, and stays bounded', () => {
    const log = [
      '2026-09-01T00:00:00.000Z Installing dependencies',
      '2026-09-01T00:00:01.000Z error TS2345: Argument of type X at /Users/me/proj/src/a.ts',
      '2026-09-01T00:00:02.000Z see https://example.com/help'
    ].join('\n')
    const sig = errorSignature(log)
    expect(sig).toContain('TS2345')
    expect(sig).toContain('<path>')
    expect(sig).toContain('<url>')
    expect(sig.length).toBeLessThanOrEqual(400)
  })

  it('returns something even when no line looks like an error', () => {
    expect(errorSignature('all good\nfinished')).not.toBe('')
  })
})

describe('errorSignature timestamp handling', () => {
  it('strips leading ISO timestamps so the query is error text, not clock noise', () => {
    const log =
      '2025-09-15T14:24:03.529Z Syntax error "`"\n2025-09-15T14:24:03.690Z Failed: build command'
    const sig = errorSignature(log)
    expect(sig).not.toMatch(/2025-09-15T14:24/)
    expect(sig).toContain('Syntax error')
  })
})
