/**
 * src/auth — the authentication seam (BUILD-PLAN.md design rule 3).
 *
 * Two interchangeable implementations of one TokenProvider interface:
 *  - OAuthTokenProvider  — self-OAuth against Webex (the Phase 0 ship decision).
 *  - StoreTokenProvider  — desktop $STORE.auth.accessToken passthrough (kept for
 *                          the seam's second implementation; see its file header).
 *
 * Nothing here is wired into the custom element or the calling SDK yet — that is
 * Phase 3, where a single line chooses the provider.
 */

export type {
  AuthState,
  AuthStatus,
  TokenProvider,
  Unsubscribe,
} from './types';
export { WEBEX_CALLING_SCOPES } from './types';
export { StoreTokenProvider } from './store-token-provider';
export type { StoreTokenProviderOptions } from './store-token-provider';
export { OAuthTokenProvider, encodeOAuthState, decodeOAuthState } from './oauth-token-provider';
export type {
  OAuthTokenProviderOptions,
  OAuthCallbackMessage,
  DecodedOAuthState,
} from './oauth-token-provider';
export { generatePkcePair, randomUrlSafeString } from './pkce';
export type { PkcePair } from './pkce';
