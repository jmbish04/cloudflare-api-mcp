/**
 * OAuth/PKCE helpers, deliberately free of any Worker bindings so they can be
 * unit-tested in isolation. Used by `/authorize` and `/token` to bind an
 * authorization code to a single client via PKCE (RFC 7636) and a registered
 * redirect URI.
 */

/**
 * Redirect URIs accepted when a client has no explicit registration on file.
 * Mirrors the defaults minted by `/register`; kept here as the single source of
 * truth so `/authorize` and `/register` agree.
 */
export const DEFAULT_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/oauth_callback',
  'https://desktop.claude.ai/oauth/callback'
]

/** The only PKCE challenge method this server supports and advertises. */
export const SUPPORTED_PKCE_METHOD = 'S256'

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
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

/**
 * Verify a PKCE `code_verifier` against a stored `code_challenge`.
 *
 * S256 only — the server advertises `code_challenge_methods_supported: ['S256']`
 * and refuses to honor a `plain` downgrade on this privileged endpoint. Returns
 * false on empty inputs, an unsupported method, or any mismatch — never throws.
 */
export async function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string = SUPPORTED_PKCE_METHOD
): Promise<boolean> {
  if (!codeVerifier || !codeChallenge) return false
  if (method !== SUPPORTED_PKCE_METHOD) return false
  const derived = await deriveS256Challenge(codeVerifier)
  return timingSafeEqual(derived, codeChallenge)
}

/**
 * Whether a requested redirect URI is permitted for a client.
 *
 * Binds the authorization code to a registered destination so a code can never
 * be delivered to an attacker-chosen URL. Uses the client's registered URIs
 * when present, otherwise the built-in defaults. Exact string match (RFC 6749
 * §3.1.2 — no substring or prefix matching).
 */
export function isAllowedRedirectUri(
  redirectUri: string,
  registeredUris: string[] | undefined
): boolean {
  if (!redirectUri) return false
  const allow = registeredUris && registeredUris.length > 0 ? registeredUris : DEFAULT_REDIRECT_URIS
  return allow.includes(redirectUri)
}
