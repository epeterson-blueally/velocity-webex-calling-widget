import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OAuthTokenProvider,
  encodeOAuthState,
  decodeOAuthState,
} from '../../src/auth/oauth-token-provider';
import type { AuthState } from '../../src/auth/types';

const REDIRECT = 'https://cb.test/oauth-callback.html';
const REDIRECT_ORIGIN = 'https://cb.test';
const AUTH_BASE = 'https://api.test';
// The primary web-component packaging: the widget window runs under the DESKTOP
// origin, which is deliberately different from the Pages/redirect origin above.
const OPENER_ORIGIN = 'https://desktop.example';

interface FakePopup {
  location: { href: string };
  closed: boolean;
  close: () => void;
}

/** Minimal window double: records message listeners and hands back the opened popup. */
function makeEnv(openerOrigin = OPENER_ORIGIN) {
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  let popup: FakePopup | null = null;
  let blockPopup = false;
  const win = {
    location: { origin: openerOrigin },
    open: vi.fn(() => {
      if (blockPopup) return null;
      popup = {
        location: { href: '' },
        closed: false,
        close() {
          this.closed = true;
        },
      };
      return popup;
    }),
    addEventListener: vi.fn((type: string, cb: (ev: unknown) => void) => {
      (listeners[type] ||= []).push(cb);
    }),
    removeEventListener: vi.fn((type: string, cb: (ev: unknown) => void) => {
      listeners[type] = (listeners[type] || []).filter((f) => f !== cb);
    }),
  };
  return {
    win: win as unknown as Window,
    openMock: win.open,
    emit: (type: string, ev: unknown) => (listeners[type] || []).slice().forEach((cb) => cb(ev)),
    getPopup: () => popup,
    blockPopups: () => {
      blockPopup = true;
    },
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Let PKCE (Web Crypto) settle and the message listener register. */
const flush = () => new Promise((r) => setTimeout(r, 5));

function makeProvider(env: ReturnType<typeof makeEnv>, fetchMock: typeof fetch, overrides = {}) {
  return new OAuthTokenProvider({
    clientId: 'cid',
    redirectUri: REDIRECT,
    authBaseUrl: AUTH_BASE,
    windowRef: env.win,
    fetchImpl: fetchMock,
    ...overrides,
  });
}

/** Drive a full successful sign-in, returning the provider (token seeded). */
async function signInSuccessfully(
  env: ReturnType<typeof makeEnv>,
  fetchMock: typeof fetch,
): Promise<OAuthTokenProvider> {
  const p = makeProvider(env, fetchMock);
  const signInP = p.signIn();
  await flush();
  const state = new URL(env.getPopup()!.location.href).searchParams.get('state');
  env.emit('message', {
    origin: REDIRECT_ORIGIN,
    data: { type: 'velocity-webex-oauth', code: 'AUTH_CODE', state },
  });
  await signInP;
  return p;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OAuthTokenProvider', () => {
  it('starts signed-out and rejects getToken before sign-in', async () => {
    const env = makeEnv();
    const p = makeProvider(env, vi.fn() as unknown as typeof fetch);
    expect(p.getStatus().status).toBe('signed-out');
    await expect(p.getToken()).rejects.toThrow(/Sign-in required/);
    p.dispose();
  });

  it('opens the popup synchronously and builds a correct Webex authorize URL', async () => {
    const env = makeEnv();
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const p = makeProvider(env, fetchMock);

    void p.signIn().catch(() => undefined); // never messaged back; torn down by dispose
    // Popup opens before the first await — synchronously within signIn.
    expect(env.openMock).toHaveBeenCalledTimes(1);
    await flush();

    const url = new URL(env.getPopup()!.location.href);
    expect(`${url.origin}${url.pathname}`).toBe('https://webexapis.com/v1/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('spark:calls_read');
    expect(scope).toContain('spark:calls_write');
    expect(scope).toContain('spark:xsi');
    expect(scope).toContain('spark:webrtc_calling');
    expect(p.getStatus().status).toBe('signing-in');

    p.dispose();
  });

  it('completes sign-in on a valid callback message: exchanges the code and emits the token', async () => {
    const env = makeEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ access_token: 'AT', expires_in: 3600, refresh_token: 'RT' }),
      ) as unknown as typeof fetch;

    const p = makeProvider(env, fetchMock);
    const tokens: string[] = [];
    const statuses: AuthState[] = [];
    p.onTokenChange((t) => tokens.push(t));
    p.onStatusChange((s) => statuses.push(s));

    const signInP = p.signIn();
    await flush();
    const state = new URL(env.getPopup()!.location.href).searchParams.get('state');

    env.emit('message', {
      origin: REDIRECT_ORIGIN,
      data: { type: 'velocity-webex-oauth', code: 'AUTH_CODE', state },
    });
    await signInP;

    expect(p.getStatus().status).toBe('authenticated');
    expect(tokens).toEqual(['AT']);
    expect(statuses.map((s) => s.status)).toContain('signing-in');

    const [tokenUrl, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tokenUrl).toBe(`${AUTH_BASE}/token`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.code).toBe('AUTH_CODE');
    expect(typeof body.code_verifier).toBe('string');
    expect(body.redirect_uri).toBe(REDIRECT);

    await expect(p.getToken()).resolves.toBe('AT');
    p.dispose();
  });

  it('web-component packaging: state encodes nonce + opener origin, and a matching-nonce callback is accepted', async () => {
    // Opener origin (desktop) differs from the redirect/Pages origin — the real
    // web-component case that the old whole-string state comparison broke.
    const env = makeEnv(OPENER_ORIGIN);
    expect(REDIRECT_ORIGIN).not.toBe(OPENER_ORIGIN);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ access_token: 'AT', expires_in: 3600, refresh_token: 'RT' }),
      ) as unknown as typeof fetch;
    const p = makeProvider(env, fetchMock);

    const signInP = p.signIn();
    await flush();

    // (b) the authorize URL's state encodes BOTH the nonce and the opener origin.
    const state = new URL(env.getPopup()!.location.href).searchParams.get('state') ?? '';
    const decoded = decodeOAuthState(state);
    expect(decoded).not.toBeNull();
    expect(decoded!.openerOrigin).toBe(OPENER_ORIGIN);
    expect(decoded!.nonce).toBeTruthy();

    // (a)+(c) a callback carrying the SAME state (matching nonce) is accepted.
    env.emit('message', {
      origin: REDIRECT_ORIGIN,
      data: { type: 'velocity-webex-oauth', code: 'AUTH_CODE', state },
    });
    await expect(signInP).resolves.toBeUndefined();
    expect(p.getStatus().status).toBe('authenticated');
    p.dispose();
  });

  it('rejects a callback whose decoded state carries the wrong nonce', async () => {
    const env = makeEnv(OPENER_ORIGIN);
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const p = makeProvider(env, fetchMock);

    const signInP = p.signIn();
    await flush();

    // Same opener origin, but a nonce we never issued → must be rejected.
    const forged = encodeOAuthState('nonce-we-never-issued', OPENER_ORIGIN);
    env.emit('message', {
      origin: REDIRECT_ORIGIN,
      data: { type: 'velocity-webex-oauth', code: 'AUTH_CODE', state: forged },
    });

    await expect(signInP).rejects.toThrow(/state mismatch/i);
    expect(p.getStatus().status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
    p.dispose();
  });

  it('ignores callback messages from the wrong origin', async () => {
    const env = makeEnv();
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const p = makeProvider(env, fetchMock);

    void p.signIn().catch(() => undefined);
    await flush();
    const state = new URL(env.getPopup()!.location.href).searchParams.get('state');

    env.emit('message', {
      origin: 'https://evil.test',
      data: { type: 'velocity-webex-oauth', code: 'STOLEN', state },
    });

    // Still waiting — the bad-origin message was ignored, no fetch happened.
    expect(p.getStatus().status).toBe('signing-in');
    expect(fetchMock).not.toHaveBeenCalled();
    p.dispose();
  });

  it('rejects on an OAuth state mismatch (CSRF guard)', async () => {
    const env = makeEnv();
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const p = makeProvider(env, fetchMock);

    const signInP = p.signIn();
    await flush();

    env.emit('message', {
      origin: REDIRECT_ORIGIN,
      data: { type: 'velocity-webex-oauth', code: 'AUTH_CODE', state: 'not-the-real-state' },
    });

    await expect(signInP).rejects.toThrow(/state mismatch/i);
    expect(p.getStatus().status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
    p.dispose();
  });

  it('rejects when the callback reports an OAuth error', async () => {
    const env = makeEnv();
    const p = makeProvider(env, vi.fn() as unknown as typeof fetch);

    const signInP = p.signIn();
    await flush();
    const state = new URL(env.getPopup()!.location.href).searchParams.get('state');

    env.emit('message', {
      origin: REDIRECT_ORIGIN,
      data: {
        type: 'velocity-webex-oauth',
        error: 'access_denied',
        error_description: 'user said no',
        state,
      },
    });

    await expect(signInP).rejects.toThrow(/user said no/);
    expect(p.getStatus().status).toBe('error');
    p.dispose();
  });

  it('rejects and reports error when the popup is blocked', async () => {
    const env = makeEnv();
    env.blockPopups();
    const p = makeProvider(env, vi.fn() as unknown as typeof fetch);
    await expect(p.signIn()).rejects.toThrow(/Popup blocked/);
    expect(p.getStatus().status).toBe('error');
    p.dispose();
  });

  it('refuses to sign in when required config is missing, naming the attributes', async () => {
    const env = makeEnv();
    const p = new OAuthTokenProvider({
      clientId: '',
      redirectUri: '',
      authBaseUrl: '',
      windowRef: env.win,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(p.signIn()).rejects.toThrow(/client-id.*redirect-uri.*auth-base-url/);
    expect(env.openMock).not.toHaveBeenCalled();
    p.dispose();
  });

  it('does NOT throw at construction when no fetch is available (GAP 2 guard)', async () => {
    // Simulate a host with no global fetch and no injected fetchImpl. The old code
    // did globalThis.fetch.bind() unconditionally -> TypeError in connectedCallback.
    const env = makeEnv();
    const hadFetch = 'fetch' in globalThis;
    const saved = (globalThis as { fetch?: typeof fetch }).fetch;
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    try {
      let p: OAuthTokenProvider | null = null;
      expect(() => {
        p = new OAuthTokenProvider({
          clientId: 'cid',
          redirectUri: REDIRECT,
          authBaseUrl: AUTH_BASE,
          windowRef: env.win,
          // no fetchImpl on purpose
        });
      }).not.toThrow();
      // Behaviour without a token is still clean (no fetch needed for this path).
      await expect(p!.getToken()).rejects.toThrow(/Sign-in required/);
      p!.dispose();
    } finally {
      if (hadFetch) (globalThis as { fetch?: typeof fetch }).fetch = saved;
    }
  });

  it('getToken refreshes when the current token is within the expiry skew window', async () => {
    const env = makeEnv();
    const fetchMock = vi
      .fn()
      // /token — expires_in tiny so the token is immediately within skew
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1', expires_in: 5, refresh_token: 'RT1' }))
      // /refresh
      .mockResolvedValueOnce(
        jsonRes({ access_token: 'AT2', expires_in: 3600, refresh_token: 'RT2' }),
      ) as unknown as typeof fetch;

    const p = await signInSuccessfully(env, fetchMock);
    // AT1 is within the 30s skew, so getToken must refresh to AT2.
    await expect(p.getToken()).resolves.toBe('AT2');
    const refreshCall = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(refreshCall[0]).toBe(`${AUTH_BASE}/refresh`);
    p.dispose();
  });

  it('treats a 401 on refresh as terminal: drops tokens and returns to signed-out', async () => {
    const env = makeEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1', expires_in: 5, refresh_token: 'RT1' }))
      .mockResolvedValueOnce(jsonRes({}, 401)) as unknown as typeof fetch;

    const p = await signInSuccessfully(env, fetchMock);
    await expect(p.refresh()).rejects.toThrow();
    expect(p.getStatus().status).toBe('signed-out');
    // No refresh token left → getToken now requires a fresh sign-in.
    await expect(p.getToken()).rejects.toThrow(/Sign-in required/);
    p.dispose();
  });

  it('retries a transient refresh failure with bounded backoff, then succeeds', async () => {
    const env = makeEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ access_token: 'AT1', expires_in: 3600, refresh_token: 'RT1' }),
      ) as unknown as typeof fetch;

    const p = await signInSuccessfully(env, fetchMock);

    (fetchMock as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(jsonRes({}, 500))
      .mockResolvedValueOnce(jsonRes({}, 503))
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT2', expires_in: 3600 }));

    vi.useFakeTimers();
    const refreshP = p.refresh();
    await vi.advanceTimersByTimeAsync(2000); // backoff after attempt 1
    await vi.advanceTimersByTimeAsync(4000); // backoff after attempt 2
    await expect(refreshP).resolves.toBe('AT2');
    // 1 (/token from sign-in) + 3 refresh attempts
    expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
    p.dispose();
  });

  it('proactively refreshes at ~80% of the token lifetime', async () => {
    const env = makeEnv();
    const fetchMock = vi
      .fn()
      // /token — 1s lifetime → proactive refresh fires ~800ms later
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1', expires_in: 1, refresh_token: 'RT1' }))
      .mockResolvedValueOnce(
        jsonRes({ access_token: 'AT2', expires_in: 3600, refresh_token: 'RT2' }),
      ) as unknown as typeof fetch;

    const p = await signInSuccessfully(env, fetchMock);
    const tokens: string[] = [];
    p.onTokenChange((t) => tokens.push(t));

    await new Promise((r) => setTimeout(r, 950));

    expect(tokens).toContain('AT2');
    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => c[0] === `${AUTH_BASE}/refresh`)).toBe(true);
    p.dispose();
  });

  it('dispose cancels timers and drops tokens', async () => {
    const env = makeEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ access_token: 'AT', expires_in: 3600, refresh_token: 'RT' }),
      ) as unknown as typeof fetch;

    const p = await signInSuccessfully(env, fetchMock);
    p.dispose();
    await expect(p.getToken()).rejects.toThrow(/disposed/);
  });
});
