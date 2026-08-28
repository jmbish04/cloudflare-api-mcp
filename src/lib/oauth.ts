/**
 * PKCE (RFC 7636) helpers, deliberately free of any Worker bindings so they can
 * be unit-tested in isolation. Used by the `/token` endpoint to verify the
 * `code_verifier` a public client presents against the `code_challenge` it sent
 * to `/authorize`.
 */

/** base64url-encode raw bytes with no padding (RFC 4648 §5). */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Derive the S256 challenge for a verifier: base64url(SHA-256(verifier)). */
export async function deriveS256Challenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(digest))
}

/** Constant-time string comparison to avoid leaking match position via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

/**
 * Verify a PKCE `code_verifier` against a stored `code_challenge`.
 *
 * Supports the `S256` (default) and `plain` methods. Returns false on empty
 * inputs, an unsupported method, or any mismatch — never throws.
 */
export async function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string = 'S256'
): Promise<boolean> {
  if (!codeVerifier || !codeChallenge) return false
  if (method === 'plain') return timingSafeEqual(codeVerifier, codeChallenge)
  if (method === 'S256') {
    const derived = await deriveS256Challenge(codeVerifier)
    return timingSafeEqual(derived, codeChallenge)
  }
  return false
}
