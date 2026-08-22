/**
 * PKCE (RFC 7636) helpers for the OAuth authorization-code flow.
 *
 * IMPORTANT (see DISCOVERY.md §2): on Webex, PKCE is *additive* CSRF/interception
 * hardening layered on top of the standard flow — it is NOT a client-secret
 * replacement. Webex has no public-client option; the code→token exchange always
 * requires the client_secret, which is why that exchange happens on the serverless
 * backend and never in this browser bundle. We still send a PKCE code_challenge for
 * defense-in-depth so a stolen authorization code cannot be redeemed without the
 * verifier that never left this widget's memory.
 *
 * All randomness comes from the Web Crypto API (crypto.getRandomValues /
 * crypto.subtle.digest), never Math.random.
 */

/** The subset of the Web Crypto API this module needs. */
interface CryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: Pick<SubtleCrypto, 'digest'>;
}

function getCrypto(): CryptoLike {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c || typeof c.getRandomValues !== 'function' || !c.subtle) {
    throw new Error('Web Crypto API unavailable — PKCE cannot be generated in this environment.');
  }
  return c;
}

/** base64url-encode raw bytes, no padding (RFC 7636 §A). */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A random URL-safe string suitable for a PKCE verifier or an OAuth `state` nonce. */
export function randomUrlSafeString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  getCrypto().getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export interface PkcePair {
  /** Kept in the widget's memory only; sent to the backend /token endpoint at exchange time. */
  codeVerifier: string;
  /** Sent in the browser→Webex /authorize redirect. */
  codeChallenge: string;
  /** Always 'S256' — the plain method is never used. */
  codeChallengeMethod: 'S256';
}

/**
 * Generate a PKCE verifier/challenge pair using S256.
 * The verifier length (43–128 chars) satisfies RFC 7636 §4.1 (32 bytes → 43 chars base64url).
 */
export async function generatePkcePair(): Promise<PkcePair> {
  const codeVerifier = randomUrlSafeString(32);
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await getCrypto().subtle.digest('SHA-256', data);
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}
