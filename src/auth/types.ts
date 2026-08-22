/**
 * The auth seam (BUILD-PLAN.md design rule 3).
 *
 * Calling core (Phase 3) and UI (Phase 6) depend ONLY on this interface, so the
 * Phase 0 decision (self-OAuth vs. desktop-token passthrough) swaps one line — a
 * `new OAuthTokenProvider(...)` for a `new StoreTokenProvider(...)` — not any
 * consumer code.
 *
 * Token material (access + refresh) lives in memory only. No implementation may
 * write it to localStorage, sessionStorage, cookies, or any log/DOM/error string.
 */

/** Webex Calling OAuth scopes (DISCOVERY.md §1). Requested by OAuthTokenProvider. */
export const WEBEX_CALLING_SCOPES = [
  'spark:calls_read',
  'spark:calls_write',
  'spark:xsi',
  'spark:webrtc_calling',
] as const;

/** Lifecycle of authentication, surfaced to the UI and the calling core. */
export type AuthStatus =
  /** No token yet and no attempt made. */
  | 'uninitialized'
  /** Interactive sign-in is required (OAuth: show the "Sign in to Webex Calling" button). */
  | 'signed-out'
  /** An interactive sign-in (popup/redirect) is in flight. */
  | 'signing-in'
  /** A valid access token is held. */
  | 'authenticated'
  /** A refresh is in flight; a (possibly still-valid) token may still be held. */
  | 'refreshing'
  /** A non-recoverable auth failure; `detail` explains it (never contains token material). */
  | 'error';

export interface AuthState {
  status: AuthStatus;
  /** Human-readable context for the UI. MUST NOT contain token material. */
  detail?: string;
}

export type Unsubscribe = () => void;

/**
 * The single contract both providers implement.
 */
export interface TokenProvider {
  /**
   * Resolve a currently-valid access token, refreshing first if it is expired or
   * within the refresh skew window. Rejects if interactive sign-in is required or
   * if no token is available.
   */
  getToken(): Promise<string>;

  /**
   * Force a token refresh — e.g. the calling SDK returned 401. Resolves with the new
   * token. Rejects (and moves status toward `signed-out`/`error`) if not refreshable.
   */
  refresh(): Promise<string>;

  /**
   * Begin interactive sign-in. OAuthTokenProvider opens the Webex authorize popup;
   * StoreTokenProvider (which has no interactive step) resolves immediately if a token
   * is present, else rejects. Must be called from a user gesture in the OAuth case so
   * the popup is not blocked.
   */
  signIn(): Promise<void>;

  /** Epoch-ms expiry of the current access token, or null if none / unknown. */
  getExpiry(): number | null;

  /** Subscribe to new-access-token events. Fires whenever a fresh token becomes available. */
  onTokenChange(cb: (token: string) => void): Unsubscribe;

  /** Subscribe to auth-status changes (the observable the UI/calling core render from). */
  onStatusChange(cb: (state: AuthState) => void): Unsubscribe;

  /** Current auth-status snapshot. */
  getStatus(): AuthState;

  /** Release timers, observers, and listeners. Idempotent. */
  dispose(): void;
}
