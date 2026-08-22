/**
 * StoreTokenProvider — consumes the desktop-supplied `access-token` attribute
 * ($STORE.auth.accessToken; DEV-HANDOFF.md "Custom-element contract").
 *
 * NOTE (Phase 0 decision, PROGRESS.md gate log): the desktop's own token was
 * proven NOT to support Webex Calling line registration, so this provider is NOT
 * the one the widget ships with — OAuthTokenProvider is. It is implemented anyway
 * because design rule 3 requires two interchangeable implementations of the same
 * seam, and it becomes useful the day a desktop token gains calling scopes.
 *
 * The desktop refreshes its token by rewriting the attribute; this provider watches
 * the host element for that change (MutationObserver) and re-emits. It never fetches
 * or refreshes anything itself — the desktop owns the token lifecycle.
 */

import { BaseTokenProvider, decodeJwtExpiryMs } from './internal';
import type { TokenProvider } from './types';

export interface StoreTokenProviderOptions {
  /** Attribute to read the token from. Defaults to 'access-token'. */
  attributeName?: string;
}

export class StoreTokenProvider extends BaseTokenProvider implements TokenProvider {
  private readonly host: Element;
  private readonly attributeName: string;
  private token: string | null = null;
  private expiresAt: number | null = null;
  private observer: MutationObserver | null = null;

  constructor(host: Element, options: StoreTokenProviderOptions = {}) {
    super();
    this.host = host;
    this.attributeName = options.attributeName ?? 'access-token';
    this.ingest(host.getAttribute(this.attributeName));
    // ingest() only emits on a change; establish the initial signed-out status
    // explicitly when the desktop supplied no token at construction time.
    if (!this.token) this.setStatus('signed-out', 'Desktop supplied no access token.');
    this.watch();
  }

  getToken(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Provider disposed.'));
    if (!this.token) {
      return Promise.reject(new Error('No access token supplied by the desktop.'));
    }
    // The desktop is responsible for keeping the attribute fresh; if it looks
    // expired we surface that as status but still return what we have, because
    // this provider cannot refresh on its own.
    if (this.expiresAt !== null && Date.now() >= this.expiresAt) {
      this.setStatus('error', 'Desktop-supplied token is expired; awaiting a refreshed attribute.');
    }
    return Promise.resolve(this.token);
  }

  /**
   * There is nothing to actively refresh — the desktop pushes a new token by
   * rewriting the attribute. Resolves with the current token if present so a 401
   * retry path does not hard-fail, but it cannot mint a new one.
   */
  refresh(): Promise<string> {
    return this.getToken();
  }

  /** No interactive step; resolves if a token is present, else rejects. */
  signIn(): Promise<void> {
    return this.token ? Promise.resolve() : Promise.reject(new Error('No desktop token available.'));
  }

  getExpiry(): number | null {
    return this.expiresAt;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.clearListeners();
    this.token = null;
    this.expiresAt = null;
  }

  private watch(): void {
    if (typeof MutationObserver === 'undefined') return;
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.attributeName === this.attributeName) {
          this.ingest(this.host.getAttribute(this.attributeName));
          return;
        }
      }
    });
    this.observer.observe(this.host, {
      attributes: true,
      attributeFilter: [this.attributeName],
    });
  }

  /** Adopt a (possibly null) attribute value, emitting only on a real change. */
  private ingest(value: string | null): void {
    const next = value && value.length > 0 ? value : null;
    if (next === this.token) return;
    this.token = next;
    this.expiresAt = next ? decodeJwtExpiryMs(next) : null;
    if (next) {
      this.setStatus('authenticated');
      this.emitToken(next);
    } else {
      this.setStatus('signed-out', 'Desktop supplied no access token.');
    }
  }
}
