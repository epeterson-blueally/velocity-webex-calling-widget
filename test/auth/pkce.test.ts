import { describe, expect, it } from 'vitest';
import { generatePkcePair, randomUrlSafeString } from '../../src/auth/pkce';

const BASE64URL = /^[A-Za-z0-9\-_]+$/;

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('pkce', () => {
  it('generates base64url values with no padding', () => {
    const s = randomUrlSafeString(32);
    expect(s).toMatch(BASE64URL);
    expect(s).not.toContain('=');
  });

  it('produces unique random strings', () => {
    const set = new Set(Array.from({ length: 50 }, () => randomUrlSafeString(16)));
    expect(set.size).toBe(50);
  });

  it('generates an S256 pair whose challenge is SHA-256(verifier)', async () => {
    const pair = await generatePkcePair();
    expect(pair.codeChallengeMethod).toBe('S256');
    expect(pair.codeVerifier).toMatch(BASE64URL);
    expect(pair.codeChallenge).toMatch(BASE64URL);
    // Verifier from 32 random bytes is 43 chars base64url (RFC 7636 §4.1: 43–128).
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.codeVerifier.length).toBeLessThanOrEqual(128);
    // Independently recompute the challenge and confirm it matches.
    expect(pair.codeChallenge).toBe(await sha256Base64Url(pair.codeVerifier));
  });
});
