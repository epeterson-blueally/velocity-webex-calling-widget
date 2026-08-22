import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreTokenProvider } from '../../src/auth/store-token-provider';
import type { AuthState } from '../../src/auth/types';

/** base64url-encode a JSON payload into a fake (unsigned) JWT. */
function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (o: Record<string, unknown>) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

/** Let the MutationObserver callback (a microtask in jsdom) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

let hosts: HTMLElement[] = [];
function makeHost(token?: string): HTMLElement {
  const el = document.createElement('div');
  if (token !== undefined) el.setAttribute('access-token', token);
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}

afterEach(() => {
  for (const h of hosts) h.remove();
  hosts = [];
});

describe('StoreTokenProvider', () => {
  it('adopts the initial attribute value and reports authenticated', async () => {
    const host = makeHost('token-abc');
    const provider = new StoreTokenProvider(host);
    expect(provider.getStatus().status).toBe('authenticated');
    await expect(provider.getToken()).resolves.toBe('token-abc');
    provider.dispose();
  });

  it('rejects getToken and reports signed-out when no token is present', async () => {
    const host = makeHost();
    const provider = new StoreTokenProvider(host);
    expect(provider.getStatus().status).toBe('signed-out');
    await expect(provider.getToken()).rejects.toThrow(/No access token/);
    provider.dispose();
  });

  it('emits onTokenChange and re-authenticates when the desktop rewrites the attribute', async () => {
    const host = makeHost('first');
    const provider = new StoreTokenProvider(host);

    const tokens: string[] = [];
    provider.onTokenChange((t) => tokens.push(t));

    host.setAttribute('access-token', 'second');
    await flush();

    expect(tokens).toEqual(['second']);
    await expect(provider.getToken()).resolves.toBe('second');
    provider.dispose();
  });

  it('does not re-emit when the attribute is rewritten to the same value', async () => {
    const host = makeHost('same');
    const provider = new StoreTokenProvider(host);
    const cb = vi.fn();
    provider.onTokenChange(cb);

    host.setAttribute('access-token', 'same');
    await flush();

    expect(cb).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('derives expiry from a JWT exp claim', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const host = makeHost(fakeJwt({ exp }));
    const provider = new StoreTokenProvider(host);
    expect(provider.getExpiry()).toBe(exp * 1000);
    provider.dispose();
  });

  it('flags an expired desktop token via status but still returns it', async () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    const host = makeHost(fakeJwt({ exp }));
    const provider = new StoreTokenProvider(host);

    const statuses: AuthState[] = [];
    provider.onStatusChange((s) => statuses.push(s));

    await expect(provider.getToken()).resolves.toContain('.');
    expect(statuses[statuses.length - 1]?.status).toBe('error');
    provider.dispose();
  });

  it('stops observing after dispose', async () => {
    const host = makeHost('t1');
    const provider = new StoreTokenProvider(host);
    const cb = vi.fn();
    provider.onTokenChange(cb);

    provider.dispose();
    host.setAttribute('access-token', 't2');
    await flush();

    expect(cb).not.toHaveBeenCalled();
    await expect(provider.getToken()).rejects.toThrow(/disposed/);
  });
});
