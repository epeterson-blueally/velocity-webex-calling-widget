/**
 * OAuthTokenProvider — self-OAuth against Webex (the Phase 0 decision; PROGRESS.md
 * gate log). Runs the authorization-code flow with PKCE, keeps every token in
 * memory only, and proactively refreshes.
 *
 * WHY A BACKEND (DISCOVERY.md §2): Webex has no public-client option; the
 * code→token and refresh_token exchanges ALWAYS require the client_secret. A
 * browser bundle served from public GitHub Pages must never hold that secret, so
 * those two exchanges are delegated to a small serverless backend that holds the
 * secret in its environment. See docs/auth-backend-contract.md for the exact HTTP
 * contract; the backend host is deferred to the Phase 2 gate, so the base URL is
 * supplied via the `auth-base-url` attribute — never hardcoded.
 *
 * DESIGN CHOICE — the browser builds the Webex /authorize URL itself and only
 * calls the backend for /token and /refresh:
 *   The authorize redirect needs only public values (client_id, redirect_uri,
 *   scopes, state, PKCE challenge) — no secret — so routing it through the backend
 *   would add a hop and duplicate config (scopes, redirect_uri) into the backend
 *   for no security gain. Keeping the backend to exactly the two secret-bearing
 *   operations minimises its surface and keeps the scope list authoritative here.
 *
 * WHY A POPUP, NOT A REDIRECT (redirect handling in the widget iframe context):
 *   The widget is a custom element inside the Agent Desktop's page (and, in the
 *   iframe-widget packaging, inside an iframe). A full-page or top-level redirect
 *   would navigate the agent OUT of the Agent Desktop, tearing down their live ACD
 *   session — unacceptable. So sign-in opens a popup to Webex; Webex redirects the
 *   popup to our callback page (public/oauth-callback.html, same origin as this
 *   bundle); the callback postMessages { code, state } back to this window and
 *   closes. The PKCE code_verifier and state nonce never leave this window's memory
 *   — they are not persisted to survive a navigation, because there is no
 *   navigation. Residual risk: popup blockers (mitigated by requiring signIn() to
 *   run from the "Sign in to Webex Calling" button gesture) and browsers that
 *   restrict window.opener in cross-site embeds (documented fallback in the
 *   backend-contract doc). See docs/auth-backend-contract.md.
 */

import { BaseTokenProvider, decodeJwtExpiryMs } from './internal';
import { generatePkcePair, randomUrlSafeString } from './pkce';
import { WEBEX_CALLING_SCOPES, type TokenProvider } from './types';

const WEBEX_AUTHORIZE_URL = 'https://webexapis.com/v1/authorize';

/** Refresh once the token is 80% of the way to expiry. */
const REFRESH_RATIO = 0.8;
/** Treat a token within this window of expiry as needing refresh before use. */
const EXPIRY_SKEW_MS = 30_000;
/** Bounded retry for a failed background refresh. */
const MAX_REFRESH_ATTEMPTS = 3;
const REFRESH_RETRY_BASE_MS = 2_000;
/** Give up waiting for the popup to report back after this long. */
const POPUP_TIMEOUT_MS = 5 * 60_000;

/** The message the callback page (public/oauth-callback.html) posts back. */
export interface OAuthCallbackMessage {
  type: 'velocity-webex-oauth';
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

/** Backend /token and /refresh response shape (docs/auth-backend-contract.md). */
interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export interface OAuthTokenProviderOptions {
  /** Webex integration client ID (public). From the `client-id` attribute. */
  clientId: string;
  /** OAuth redirect URI = the deployed callback page. From the `redirect-uri` attribute. */
  redirectUri: string;
  /** Base URL of the serverless token backend. From the `auth-base-url` attribute. */
  authBaseUrl: string;
  /** Override scopes (defaults to the Webex Calling scope set). */
  scopes?: readonly string[];
  /** Injectable for tests. Defaults to the global window. */
  windowRef?: Window;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class OAuthTokenProvider extends BaseTokenProvider implements TokenProvider {
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly redirectOrigin: string;
  private readonly authBaseUrl: string;
  private readonly scopes: readonly string[];
  private readonly win: Window;
  /**
   * The fetch used for the /token and /refresh exchanges. May be `undefined` when
   * neither an injected `fetchImpl` nor a global `fetch` exists (e.g. a non-browser
   * host, or jsdom without a fetch polyfill). Construction must NOT throw in that
   * case — instead getToken/refresh/signIn reject with a clear error when they
   * actually need the network. See `requireFetch()`.
   */
  private readonly fetchImpl: typeof fetch | undefined;

  // In-memory token material. NEVER persisted.
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt: number | null = null;

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightRefresh: Promise<string> | null = null;

  // Interactive sign-in state.
  private messageHandler: ((ev: MessageEvent) => void) | null = null;
  private popupTimer: ReturnType<typeof setTimeout> | null = null;
  private signInReject: ((err: Error) => void) | null = null;

  constructor(options: OAuthTokenProviderOptions) {
    super();
    this.clientId = options.clientId;
    this.redirectUri = options.redirectUri;
    this.authBaseUrl = options.authBaseUrl.replace(/\/+$/, '');
    this.scopes = options.scopes ?? WEBEX_CALLING_SCOPES;
    this.win = options.windowRef ?? (globalThis as unknown as { window: Window }).window;
    // GUARD: do NOT call globalThis.fetch.bind() unconditionally — that throws a
    // TypeError at construction if fetch is absent. Target browsers (Chromium)
    // always have fetch, so this only matters for non-browser/jsdom hosts, but the
    // element's connectedCallback must never throw. Defer the "no fetch" failure to
    // the point of use (requireFetch), where it becomes a clean rejection.
    this.fetchImpl =
      options.fetchImpl ??
      (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);

    let origin = '';
    try {
      origin = new URL(this.redirectUri).origin;
    } catch {
      origin = '';
    }
    this.redirectOrigin = origin;
    this.setStatus('signed-out', 'Sign in to Webex Calling.');
  }

  getToken(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Provider disposed.'));
    if (this.accessToken && !this.isExpiringSoon()) {
      return Promise.resolve(this.accessToken);
    }
    if (this.refreshToken) {
      return this.refresh();
    }
    return Promise.reject(new Error('Sign-in required.'));
  }

  refresh(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Provider disposed.'));
    if (this.inFlightRefresh) return this.inFlightRefresh;
    if (!this.refreshToken) {
      return Promise.reject(new Error('No refresh token; sign-in required.'));
    }
    this.setStatus('refreshing');
    this.inFlightRefresh = this.doRefresh()
      .finally(() => {
        this.inFlightRefresh = null;
      });
    return this.inFlightRefresh;
  }

  /**
   * Open the Webex authorize popup and resolve once the token exchange completes.
   * MUST be called from a user gesture (button click) so the popup is not blocked.
   */
  async signIn(): Promise<void> {
    if (this.disposed) throw new Error('Provider disposed.');
    const missing = this.missingConfig();
    if (missing) {
      this.setStatus('error', `Cannot sign in: missing ${missing}.`);
      throw new Error(`Cannot sign in: missing ${missing}.`);
    }

    // Tear down any prior in-flight attempt.
    this.cleanupSignIn();

    // Open the popup SYNCHRONOUSLY, before any await, so it stays inside the
    // button's user-gesture window (Safari/strict browsers block a window.open
    // that happens after an await). We navigate it once the PKCE challenge — the
    // one async step — is ready.
    const popup = this.win.open('', 'velocity-webex-oauth', 'width=600,height=760');
    if (!popup) {
      this.setStatus('error', 'Popup blocked. Allow popups for this site, then sign in again.');
      throw new Error('Popup blocked.');
    }
    this.setStatus('signing-in');

    // The `state` parameter carries BOTH a CSRF nonce AND this widget window's own
    // origin (the "opener origin"). WHY the opener origin: in the primary
    // web-component packaging the widget script runs inside the Agent Desktop's
    // document, so this window's origin is the DESKTOP origin, not the Pages origin
    // the callback page is served from. The callback page must postMessage back to
    // the exact opener origin or the browser silently drops the message; it learns
    // that origin from `state`, which Webex returns to the callback verbatim.
    // Neither value is secret (the nonce's job is integrity, not confidentiality).
    const nonce = randomUrlSafeString(24);
    const openerOrigin = this.win.location.origin;
    const state = encodeOAuthState(nonce, openerOrigin);
    const pkce = await generatePkcePair();
    if (this.disposed) {
      try {
        popup.close();
      } catch {
        // ignore
      }
      throw new Error('Provider disposed during sign-in.');
    }
    // popup is still on about:blank (same-origin) here, so setting location is allowed.
    popup.location.href = this.buildAuthorizeUrl(state, pkce.codeChallenge);

    return new Promise<void>((resolve, reject) => {
      this.signInReject = reject;

      const finish = (err?: Error): void => {
        this.cleanupSignIn();
        try {
          if (!popup.closed) popup.close();
        } catch {
          // ignore
        }
        if (err) reject(err);
        else resolve();
      };

      this.messageHandler = (ev: MessageEvent): void => {
        // Only accept messages from our own callback origin (the Pages origin).
        if (this.redirectOrigin && ev.origin !== this.redirectOrigin) return;
        const data = ev.data as OAuthCallbackMessage | undefined;
        if (!data || data.type !== 'velocity-webex-oauth') return;
        // CSRF: decode the returned state and compare its nonce to the one we sent.
        const decoded = data.state ? decodeOAuthState(data.state) : null;
        if (!decoded || decoded.nonce !== nonce) {
          this.setStatus('error', 'Sign-in failed: state mismatch.');
          finish(new Error('OAuth state mismatch.'));
          return;
        }
        if (data.error || !data.code) {
          const detail = data.error_description || data.error || 'no authorization code returned';
          this.setStatus('error', `Sign-in failed: ${detail}`);
          finish(new Error(`OAuth error: ${detail}`));
          return;
        }
        // Exchange the code via the backend (holds the secret).
        this.exchangeCode(data.code, pkce.codeVerifier)
          .then(() => finish())
          .catch((err: Error) => {
            this.setStatus('error', 'Sign-in failed during token exchange.');
            finish(err);
          });
      };
      this.win.addEventListener('message', this.messageHandler);

      this.popupTimer = setTimeout(() => {
        this.setStatus('error', 'Sign-in timed out.');
        finish(new Error('OAuth sign-in timed out.'));
      }, POPUP_TIMEOUT_MS);
    });
  }

  getExpiry(): number | null {
    return this.expiresAt;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRefreshTimer();
    this.cleanupSignIn();
    this.clearListeners();
    // Drop token material.
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = null;
  }

  // --- internals -----------------------------------------------------------

  private missingConfig(): string | null {
    const missing: string[] = [];
    if (!this.clientId) missing.push('client-id');
    if (!this.redirectUri || !this.redirectOrigin) missing.push('redirect-uri');
    if (!this.authBaseUrl) missing.push('auth-base-url');
    return missing.length ? missing.join(', ') : null;
  }

  private buildAuthorizeUrl(state: string, codeChallenge: string): string {
    const url = new URL(WEBEX_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', this.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /**
   * Return the fetch to use, or throw a clear error if none is available. Called at
   * the point of network use so that a missing fetch surfaces as a rejected
   * getToken/refresh/signIn rather than a construction-time throw.
   */
  private requireFetch(): typeof fetch {
    if (!this.fetchImpl) {
      throw new Error(
        'No fetch implementation is available; cannot reach the token backend. ' +
          'Run in a browser (or provide fetchImpl) to sign in.',
      );
    }
    return this.fetchImpl;
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<void> {
    const fetchImpl = this.requireFetch();
    const res = await fetchImpl(`${this.authBaseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: this.redirectUri }),
    });
    if (!res.ok) {
      throw new Error(`Token exchange failed (HTTP ${res.status}).`);
    }
    const data = (await res.json()) as TokenResponse;
    this.adoptToken(data);
  }

  private async doRefresh(): Promise<string> {
    // No fetch → no retry can help. Fail fast with a clear message and drop tokens.
    if (!this.fetchImpl) {
      this.refreshToken = null;
      this.accessToken = null;
      this.expiresAt = null;
      this.setStatus('error', 'No network client available; cannot refresh the token.');
      throw new Error('No fetch implementation is available; cannot refresh the token.');
    }
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.authBaseUrl}/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The backend may key the refresh_token to a session cookie instead of
          // trusting the body; sending it supports the stateless-POC variant too.
          body: JSON.stringify(this.refreshToken ? { refresh_token: this.refreshToken } : {}),
        });
        if (res.status === 400 || res.status === 401) {
          // The refresh token is invalid/expired — no retry will help.
          throw new AuthTerminalError(`Refresh rejected (HTTP ${res.status}).`);
        }
        if (!res.ok) {
          throw new Error(`Refresh failed (HTTP ${res.status}).`);
        }
        const data = (await res.json()) as TokenResponse;
        this.adoptToken(data);
        return data.access_token;
      } catch (err) {
        lastErr = err as Error;
        if (err instanceof AuthTerminalError) break;
        if (attempt < MAX_REFRESH_ATTEMPTS) {
          await delay(REFRESH_RETRY_BASE_MS * 2 ** (attempt - 1));
        }
      }
    }
    // All attempts exhausted or terminal: require a fresh sign-in.
    this.refreshToken = null;
    if (!this.accessToken || this.isExpiringSoon()) {
      this.accessToken = null;
      this.expiresAt = null;
      this.setStatus('signed-out', 'Session expired. Sign in to Webex Calling again.');
    } else {
      this.setStatus('error', 'Token refresh failed; current token still valid for now.');
    }
    throw lastErr ?? new Error('Refresh failed.');
  }

  private adoptToken(data: TokenResponse): void {
    this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    // Prefer the JWT exp if the token is a readable JWT; else derive from expires_in.
    const jwtExp = decodeJwtExpiryMs(data.access_token);
    this.expiresAt =
      jwtExp ?? (Number.isFinite(data.expires_in) ? Date.now() + data.expires_in * 1000 : null);
    this.setStatus('authenticated');
    this.scheduleProactiveRefresh();
    this.emitToken(data.access_token);
  }

  private isExpiringSoon(): boolean {
    if (this.expiresAt === null) return false;
    return Date.now() >= this.expiresAt - EXPIRY_SKEW_MS;
  }

  private scheduleProactiveRefresh(): void {
    this.cancelRefreshTimer();
    if (this.expiresAt === null || !this.refreshToken) return;
    const lifetime = this.expiresAt - Date.now();
    if (lifetime <= 0) return;
    const fireIn = Math.max(0, Math.floor(lifetime * REFRESH_RATIO));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      // Background refresh; swallow rejection (status already reflects the outcome).
      void this.refresh().catch(() => undefined);
    }, fireIn);
  }

  private cancelRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private cleanupSignIn(): void {
    if (this.messageHandler) {
      this.win.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.popupTimer !== null) {
      clearTimeout(this.popupTimer);
      this.popupTimer = null;
    }
    // If a sign-in promise is still open when we tear down, reject it so callers
    // don't hang. (No-op once resolved/rejected.)
    if (this.signInReject && this.disposed) {
      this.signInReject(new Error('Provider disposed during sign-in.'));
    }
    this.signInReject = null;
  }
}

/** Decoded shape of the OAuth `state` parameter. */
export interface DecodedOAuthState {
  /** CSRF nonce generated by the widget. */
  nonce: string;
  /** The widget window's own origin — the origin the callback page must target. */
  openerOrigin: string;
}

/**
 * Encode the CSRF nonce and the opener origin into the OAuth `state` value as a
 * base64url'd JSON blob. `state` is not secret; it is echoed back verbatim by
 * Webex to the callback page. Kept intentionally simple so public/oauth-callback.html
 * can decode it with plain browser JS (no bundler).
 */
export function encodeOAuthState(nonce: string, openerOrigin: string): string {
  const json = JSON.stringify({ n: nonce, o: openerOrigin });
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Inverse of {@link encodeOAuthState}. Returns null if the value is not our state blob. */
export function decodeOAuthState(state: string): DecodedOAuthState | null {
  try {
    let b64 = state.replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(decodeURIComponent(escape(atob(b64)))) as { n?: unknown; o?: unknown };
    if (typeof json.n !== 'string' || typeof json.o !== 'string') return null;
    return { nonce: json.n, openerOrigin: json.o };
  } catch {
    return null;
  }
}

/** Marks a refresh failure that no retry can fix (invalid/expired refresh token). */
class AuthTerminalError extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
