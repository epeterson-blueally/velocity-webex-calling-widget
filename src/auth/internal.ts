/**
 * Shared internals for the TokenProvider implementations: listener bookkeeping,
 * status emission, and a best-effort JWT `exp` decoder. Not part of the public
 * auth surface.
 */

import type { AuthState, Unsubscribe } from './types';

/**
 * Base class handling the two observables (token-change, status-change) and the
 * current-status snapshot, so both providers share identical subscription semantics.
 */
export abstract class BaseTokenProvider {
  private tokenListeners = new Set<(token: string) => void>();
  private statusListeners = new Set<(state: AuthState) => void>();
  private status: AuthState = { status: 'uninitialized' };
  protected disposed = false;

  onTokenChange(cb: (token: string) => void): Unsubscribe {
    this.tokenListeners.add(cb);
    return () => {
      this.tokenListeners.delete(cb);
    };
  }

  onStatusChange(cb: (state: AuthState) => void): Unsubscribe {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  getStatus(): AuthState {
    return this.status;
  }

  /** Emit a new access token to all token listeners. */
  protected emitToken(token: string): void {
    for (const cb of [...this.tokenListeners]) {
      try {
        cb(token);
      } catch {
        // A listener throwing must not stop the others or the provider.
      }
    }
  }

  /** Update and broadcast the auth status. No-op if the value is unchanged. */
  protected setStatus(status: AuthState['status'], detail?: string): void {
    if (this.status.status === status && this.status.detail === detail) return;
    this.status = detail === undefined ? { status } : { status, detail };
    for (const cb of [...this.statusListeners]) {
      try {
        cb(this.status);
      } catch {
        // ignore listener errors
      }
    }
  }

  protected clearListeners(): void {
    this.tokenListeners.clear();
    this.statusListeners.clear();
  }
}

/**
 * Best-effort decode of a JWT `exp` claim (seconds since epoch) → epoch-ms.
 * Webex access tokens are not guaranteed to be readable JWTs (they can be opaque),
 * so an undecodable token yields null and the caller falls back to an
 * expires_in-derived expiry (OAuth) or treats expiry as unknown (Store).
 */
export function decodeJwtExpiryMs(token: string): number | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    base64 += '='.repeat((4 - (base64.length % 4)) % 4);
    const json = JSON.parse(decodeURIComponent(escape(atob(base64)))) as { exp?: unknown };
    if (typeof json.exp !== 'number' || !Number.isFinite(json.exp)) return null;
    return json.exp * 1000;
  } catch {
    return null;
  }
}
