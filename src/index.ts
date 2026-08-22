/**
 * <velocity-webex-calling> — Phase 6 element wiring (BUILD-PLAN.md Phase 6 +
 * DEV-HANDOFF.md "Custom-element contract"). This is where the widget becomes
 * real: it reads the desktop-bound + auth attributes, builds the auth/calling/
 * desktop stack, and renders the pure src/ui views off the combined status.
 *
 * ATTRIBUTES (DEV-HANDOFF.md contract + docs/auth-backend-contract.md):
 *   access-token   $STORE.auth.accessToken — StoreTokenProvider path only (see below).
 *   agent-id       $STORE.agent.agentId — context/logging + device-persistence key.
 *   org-id         $STORE.agent.orgId — desktop idle-code enumeration fallback.
 *   dark-mode      $STORE.app.darkMode — theming (pure CSS; see src/ui/styles.ts).
 *   client-id, redirect-uri, auth-base-url — self-OAuth config (Phase 0 decision).
 *
 * TOKEN PROVIDER CHOICE (Phase 0/2 decision, PROGRESS.md gate log): OAuthTokenProvider
 * is the DEFAULT — Gate 0 proved the desktop's own `access-token` does not carry
 * Webex Calling scopes. StoreTokenProvider is kept wired as the alternate path
 * (BUILD-PLAN.md design rule 3) for the standalone harness/testing, or a future
 * desktop token that does carry calling scopes: it is used only when the three
 * OAuth attributes are not all present.
 *
 * SDK BOUNDARY (mirrors src/bundle.ts's existing split): this file's STATIC imports
 * never touch `@webex/calling` — only `./auth` and `./desktop`, neither of which
 * value-imports a Cisco SDK (WxccDesktopBackend dynamically imports
 * `@wxcc-desktop/sdk` internally, guarded by a presence check; see its header). The
 * real calling backend (`WebexCallingBackend`, `createWebexCallingClient`,
 * `CallingController`) is loaded via a single deferred `import('./calling')` inside
 * `ensureCallingStack()`, executed only once the agent is authenticated. This keeps
 * `import '../src/index'` safe and fast for unit tests (no multi-MB SDK parse) while
 * the PRODUCTION bundle (built from src/bundle.ts, which already statically pulls in
 * the calling module) is unaffected — webpack's `webpackMode: "eager"` keeps this
 * import in the SAME single-file bundle; only its execution is deferred to runtime.
 *
 * DEGRADE, NEVER THROW: if the calling engine can't initialize (no token yet, the
 * live bootstrap's global `Calling` UMD not present — see src/calling/bootstrap.ts
 * header for the packaging note this task explicitly defers), `ensureCallingStack`
 * catches everything and surfaces `callingInitError` with a Retry action. The
 * element never throws out of a lifecycle callback.
 */

import { OAuthTokenProvider, StoreTokenProvider } from './auth';
import type { TokenProvider } from './auth';
import { DesktopStateManager, WxccDesktopBackend } from './desktop';
import { CallingWidgetView, WIDGET_STYLES } from './ui';
import type { UiActions, WidgetStatus } from './ui';

// Type-only: erased at compile time, so referencing it here does NOT cause a
// runtime import of './calling' (and therefore not of `@webex/calling`).
type CallingModule = typeof import('./calling');
type CallingControllerInstance = InstanceType<CallingModule['CallingController']>;

const TAG_NAME = 'velocity-webex-calling';

const OBSERVED_ATTRIBUTES = [
  'access-token',
  'agent-id',
  'org-id',
  'dark-mode',
  'client-id',
  'redirect-uri',
  'auth-base-url',
] as const;
type ObservedAttribute = (typeof OBSERVED_ATTRIBUTES)[number];

/** The one deferred entry point into the real SDK-backed calling stack. */
function loadCallingModule(): Promise<CallingModule> {
  return import(/* webpackMode: "eager" */ './calling');
}

/** Masks a token, showing only the first/last 4 characters. Never returns the raw value. */
export function maskToken(token: string): string {
  if (!token) return '(none)';
  if (token.length <= 8) return '*'.repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} chars)`;
}

export interface DecodedScope {
  scope: string | null;
  decodable: boolean;
}

/**
 * Best-effort JWT payload decode, looking for a scope/scopes/scp claim. Retained
 * from the Phase 1 scaffold as a small debugging utility (Webex tokens are not
 * guaranteed to be readable JWTs, so a decode failure is expected, not an error).
 */
export function decodeJwtScope(token: string): DecodedScope {
  if (!token) return { scope: null, decodable: false };
  try {
    const parts = token.split('.');
    if (parts.length < 2) return { scope: null, decodable: false };
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    base64 = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = JSON.parse(decodeURIComponent(escape(atob(base64))));
    const raw = json.scope ?? json.scopes ?? json.scp ?? null;
    if (raw == null) return { scope: null, decodable: true };
    const scope = Array.isArray(raw) ? raw.join(' ') : String(raw);
    return { scope, decodable: true };
  } catch {
    return { scope: null, decodable: false };
  }
}

export class VelocityWebexCallingElement extends HTMLElement {
  static get observedAttributes(): readonly ObservedAttribute[] {
    return OBSERVED_ATTRIBUTES;
  }

  private view: CallingWidgetView | null = null;
  private actions: UiActions | null = null;
  private tokenProvider: TokenProvider | null = null;
  private controller: CallingControllerInstance | null = null;
  private desktopManager: DesktopStateManager | null = null;
  private callingInitError: string | null = null;
  private callingInitInFlight = false;
  private started = false;
  private readonly unsubs: Array<() => void> = [];

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const shadow = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = WIDGET_STYLES;
      shadow.appendChild(style);

      this.actions = this.buildActions();
      const view = new CallingWidgetView(this.actions);
      this.view = view;
      shadow.appendChild(view.element);

      // Any interaction anywhere in the widget unlocks the ring tone's AudioContext
      // (browsers require a prior user gesture before audio may play).
      this.addEventListener('pointerdown', this.handleGesture);
      this.addEventListener('keydown', this.handleGesture);
    }

    if (this.started) {
      this.render();
      return;
    }
    this.started = true;

    this.tokenProvider = this.createTokenProvider();
    this.unsubs.push(
      this.tokenProvider.onStatusChange(() => {
        this.render();
        void this.ensureCallingStack();
      }),
    );

    this.render();
    void this.ensureCallingStack();

    const agentId = this.getAttribute('agent-id') ?? '';
    void this.view?.startDeviceSelector(agentId);
  }

  disconnectedCallback(): void {
    for (const unsub of this.unsubs.splice(0)) {
      try {
        unsub();
      } catch {
        // A subscriber's unsubscribe throwing must not block the rest of teardown.
      }
    }
    this.desktopManager?.dispose();
    this.desktopManager = null;
    this.controller?.dispose();
    this.controller = null;
    this.tokenProvider?.dispose();
    this.tokenProvider = null;
    this.started = false;
  }

  attributeChangedCallback(): void {
    // dark-mode theming is pure CSS (:host([dark-mode="true"]), src/ui/styles.ts) —
    // no JS reaction needed. access-token changes are watched by StoreTokenProvider's
    // own MutationObserver on `this` when that path is active. The OAuth attributes
    // and agent-id/org-id are read once at connect time; changing them afterward is
    // not supported (they are static desktop-layout bindings in practice).
  }

  private readonly handleGesture = (): void => {
    this.view?.armAudio();
  };

  private createTokenProvider(): TokenProvider {
    const clientId = this.getAttribute('client-id') ?? '';
    const redirectUri = this.getAttribute('redirect-uri') ?? '';
    const authBaseUrl = this.getAttribute('auth-base-url') ?? '';
    if (clientId && redirectUri && authBaseUrl) {
      return new OAuthTokenProvider({ clientId, redirectUri, authBaseUrl });
    }
    return new StoreTokenProvider(this);
  }

  /**
   * Build the real calling + desktop stack once the agent is authenticated. Safe to
   * call repeatedly (no-ops once a controller exists or a call is already running);
   * never throws — every failure becomes `callingInitError` for the UI to show with
   * a Retry action.
   */
  private async ensureCallingStack(): Promise<void> {
    const tokenProvider = this.tokenProvider;
    if (!tokenProvider || this.controller || this.callingInitInFlight) return;
    const authStatus = tokenProvider.getStatus().status;
    if (authStatus !== 'authenticated' && authStatus !== 'refreshing') return;

    this.callingInitInFlight = true;
    this.callingInitError = null;
    this.render();

    try {
      const token = await tokenProvider.getToken();
      const callingMod = await loadCallingModule();
      const { callingClient, createMicrophoneStream } = await callingMod.createWebexCallingClient(token);
      const backend = new callingMod.WebexCallingBackend({
        callingClient,
        createMicrophoneStream,
        remoteAudioElement: this.view?.remoteAudio,
      });
      const controller = new callingMod.CallingController({ backend, tokenProvider });
      this.controller = controller;
      this.unsubs.push(controller.onChange(() => this.render()));
      await controller.start();

      const desktopBackend = new WxccDesktopBackend({ orgId: this.getAttribute('org-id') ?? undefined });
      const desktopManager = new DesktopStateManager({ backend: desktopBackend, callStatus: controller });
      this.desktopManager = desktopManager;
      this.unsubs.push(desktopManager.onChange(() => this.render()));
      await desktopManager.start();
    } catch (err) {
      this.callingInitError = `Calling engine unavailable: ${errMsg(err)}`;
      this.controller = null;
    } finally {
      this.callingInitInFlight = false;
      this.render();
    }
  }

  private buildActions(): UiActions {
    return {
      signIn: () => {
        this.view?.armAudio();
        const tp = this.tokenProvider;
        if (!tp) return;
        // signIn() opens its popup synchronously before its first await; calling it
        // directly from this click handler keeps that inside the user gesture.
        void tp
          .signIn()
          .catch(() => undefined)
          .finally(() => this.render());
      },
      retryCallingInit: () => {
        void this.ensureCallingStack();
      },
      dial: (address) => void this.controller?.dial(address),
      answer: () => void this.controller?.answer(),
      decline: () => void this.controller?.decline(),
      hold: () => void this.controller?.hold(),
      resume: () => void this.controller?.resume(),
      mute: () => void this.controller?.mute(),
      unmute: () => void this.controller?.unmute(),
      end: () => void this.controller?.end(),
      sendDigit: (tone) => void this.controller?.sendDigit(tone),
      answerSecond: () => void this.controller?.answerSecond(),
      declineSecond: () => void this.controller?.declineSecond(),
      blindTransfer: (target) => void this.controller?.blindTransfer(target),
      startConsult: (target) => void this.controller?.startConsult(target),
      completeConsult: () => void this.controller?.completeConsult(),
      cancelConsult: () => void this.controller?.cancelConsult(),
      setMicDevice: () => {
        // Persisted by DeviceSelectorView (localStorage, deviceId only). Threading a
        // chosen input device into the SDK's mic capture would need a richer
        // MicStreamFactory than src/calling currently exposes (its
        // createMicrophoneStream seam takes no constraints) — a src/calling change,
        // out of scope for this UI phase. The choice is stored and ready for that
        // seam to consume later.
      },
      setSpeakerDevice: () => {
        // Applied directly by DeviceSelectorView via HTMLMediaElement.setSinkId on
        // the shared remote-audio sink; nothing further to do here.
      },
    };
  }

  private render(): void {
    if (!this.view || !this.tokenProvider || !this.actions) return;
    const status: WidgetStatus = {
      auth: this.tokenProvider.getStatus(),
      calling: this.controller?.getStatus() ?? null,
      desktop: this.desktopManager?.getStatus() ?? null,
      callingInitError: this.callingInitError,
    };
    this.view.render(status, this.actions);
  }
}

/** Extract a safe message from an unknown thrown value (never leaks token material). */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

if (!customElements.get(TAG_NAME)) {
  customElements.define(TAG_NAME, VelocityWebexCallingElement);
}
