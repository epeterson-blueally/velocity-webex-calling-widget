/**
 * WxccDesktopBackend — the ONLY module that loads `@wxcc-desktop/sdk`.
 *
 * It implements the DesktopBackend seam against the live `Desktop.*` API. Every
 * method signature here was verified against the shipped 3.0.1 type declarations
 * (node_modules/@wxcc-desktop/sdk/dist/types) and the official
 * `desktop-js-sdk-sample`, not plan prose:
 *   - Desktop.config.init({widgetName, widgetProvider}): Promise<void>   (config REQUIRED)
 *   - Desktop.agentStateInfo.stateChange({state:'Available'|'Idle', auxCodeIdArray:string})
 *       — `auxCodeIdArray` is a single STRING = the idle code's ID (Available uses '0').
 *   - Desktop.agentStateInfo.latestData.idleCodes: {id,name,isDefault}[]   (post-init)
 *   - Desktop.agentStateInfo.latestData.status / .idleCode.{id,name}       (current state)
 *   - Desktop.agentStateInfo.fetchOrganizationIdleCodes(orgId): fallback enumeration
 *   - Desktop.agentContact.addEventListener('eAgentOfferContact' | 'eAgentOfferContactRona')
 *
 * PRESENCE DETECTION (Agent Desktop vs standalone harness) — and WHY THE SDK IS
 * LAZY-LOADED: `@wxcc-desktop/sdk`'s module body runs an IIFE at import time that
 * reads a BARE global `AGENTX_SERVICE`, which the desktop host injects before it
 * loads widgets. Outside the desktop (the harness, a plain tab) that global is
 * absent and a *static* import of the SDK throws `ReferenceError: AGENTX_SERVICE
 * is not defined` at bundle load — which would break the standalone harness. So we
 * NEVER static-import it: we first check for the `AGENTX_SERVICE` global (a safe
 * `in` test that never throws), and only inside the desktop do we `import()` the
 * SDK. `webpackMode: "eager"` keeps it in the single bundle while deferring the
 * SDK's module execution to this init() call. Outside the desktop the SDK code is
 * never executed and isPresent() stays false, so the manager no-ops.
 */

import type {
  AcdInteraction,
  AgentStateSnapshot,
  AgentStateTarget,
  DesktopBackend,
  IdleCode,
  LogDirection,
  Unsubscribe,
} from './backend';

/** The live `Desktop` API object's type, taken type-only from the SDK typings. */
type DesktopApi = typeof import('@wxcc-desktop/sdk')['Desktop'];

const WIDGET_NAME = 'velocity-webex-calling';
const WIDGET_PROVIDER = 'Velocity';
const LOG_PREFIX = 'velocity-webex-calling';
const DEFAULT_INIT_TIMEOUT_MS = 4_000;

/** Minimal structural view of the ACD-offer listener registrar (avoids the SDK's
 * heavily-generic Listeners typing while staying load-local to this module). */
interface OfferRegistrar {
  addEventListener(event: string, listener: (msg: unknown) => void): void;
  removeEventListener(event: string, listener: (msg: unknown) => void): void;
}

/** Minimal structural view of the desktop logger. */
interface DesktopLogger {
  info(...args: unknown[]): void;
}

export interface WxccDesktopBackendOptions {
  /** Org id used for the fetchOrganizationIdleCodes fallback (from the org-id attr). */
  orgId?: string;
  /** Presence-detection timeout for Desktop.config.init. Default 4s. */
  initTimeoutMs?: number;
  /**
   * Override the desktop-host detector (default: the `AGENTX_SERVICE` global check).
   * Injectable for tests so the real SDK load can be exercised in isolation.
   */
  detectDesktopHost?: () => boolean;
  /** Override the SDK loader (default: eager dynamic import). Injectable for tests. */
  loadSdk?: () => Promise<{ Desktop: DesktopApi }>;
}

export class WxccDesktopBackend implements DesktopBackend {
  private readonly orgId: string | undefined;
  private readonly initTimeoutMs: number;
  private readonly detectDesktopHost: () => boolean;
  private readonly loadSdk: () => Promise<{ Desktop: DesktopApi }>;
  private present = false;
  private desktop: DesktopApi | null = null;
  private logger: DesktopLogger | null = null;
  private offerHandlers = new Set<(msg: unknown) => void>();

  constructor(options: WxccDesktopBackendOptions = {}) {
    this.orgId = options.orgId;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.detectDesktopHost = options.detectDesktopHost ?? defaultDetectDesktopHost;
    this.loadSdk =
      options.loadSdk ??
      (() => import(/* webpackMode: "eager" */ '@wxcc-desktop/sdk'));
  }

  isPresent(): boolean {
    return this.present;
  }

  async init(): Promise<void> {
    // Do NOT load the SDK unless the desktop host global is present — importing it
    // outside the desktop throws (see the file header).
    if (!this.detectDesktopHost()) {
      this.present = false;
      return;
    }
    try {
      const mod = await this.loadSdk();
      const desktop = mod.Desktop;
      await withTimeout(
        desktop.config.init({ widgetName: WIDGET_NAME, widgetProvider: WIDGET_PROVIDER }),
        this.initTimeoutMs,
      );
      this.desktop = desktop;
      this.present = true;
      try {
        this.logger = desktop.logger.createLogger(LOG_PREFIX) as unknown as DesktopLogger;
      } catch {
        this.logger = null;
      }
    } catch {
      // Timed out or threw → treat as not inside the desktop. Normal no-op case.
      this.present = false;
      this.desktop = null;
    }
  }

  async getIdleCodes(): Promise<IdleCode[]> {
    const desktop = this.desktop;
    if (!this.present || !desktop) return [];
    const cached = coerceIdleCodes(desktop.agentStateInfo.latestData.idleCodes);
    if (cached.length > 0) return cached;
    // Fallback: explicit fetch (needs the org id).
    if (this.orgId) {
      const fetched = await desktop.agentStateInfo.fetchOrganizationIdleCodes(this.orgId);
      return coerceIdleCodes(fetched);
    }
    return [];
  }

  getCurrentAgentState(): AgentStateSnapshot {
    const desktop = this.desktop;
    if (!desktop) return { state: 'unknown', auxCodeId: null };
    const latest = desktop.agentStateInfo.latestData;
    const state = typeof latest.status === 'string' && latest.status ? latest.status : 'unknown';
    const auxCodeId = latest.idleCode?.id ?? null;
    return { state, auxCodeId };
  }

  async setAgentState(target: AgentStateTarget): Promise<void> {
    const desktop = this.desktop;
    if (!desktop) throw new Error('desktop SDK not available');
    await desktop.agentStateInfo.stateChange({
      state: target.state,
      auxCodeIdArray: target.auxCodeId,
    });
  }

  onAcdInteractionOffered(cb: (interaction: AcdInteraction) => void): Unsubscribe {
    const desktop = this.desktop;
    if (!desktop) return () => {};
    const offer = (msg: unknown): void =>
      cb({ interactionId: extractInteractionId(msg), isRona: false });
    const rona = (msg: unknown): void =>
      cb({ interactionId: extractInteractionId(msg), isRona: true });
    const registrar = desktop.agentContact as unknown as OfferRegistrar;
    registrar.addEventListener('eAgentOfferContact', offer);
    registrar.addEventListener('eAgentOfferContactRona', rona);
    this.offerHandlers.add(offer);
    this.offerHandlers.add(rona);
    return () => {
      registrar.removeEventListener('eAgentOfferContact', offer);
      registrar.removeEventListener('eAgentOfferContactRona', rona);
      this.offerHandlers.delete(offer);
      this.offerHandlers.delete(rona);
    };
  }

  log(direction: LogDirection, message: string): void {
    const line = `[desktop-state ${direction}] ${message}`;
    if (this.logger) {
      this.logger.info(line);
    } else {
      // Fall back to console so the demo trace is still visible outside the desktop.
      // No token material ever reaches here (the manager only logs states/ids).
      console.info(line);
    }
  }

  dispose(): void {
    const desktop = this.desktop;
    if (!this.present || !desktop) return;
    const registrar = desktop.agentContact as unknown as OfferRegistrar;
    for (const h of this.offerHandlers) {
      // We do not know which event each handler was bound to here, so remove from
      // both channels; removeEventListener for an unbound handler is a safe no-op.
      registrar.removeEventListener('eAgentOfferContact', h);
      registrar.removeEventListener('eAgentOfferContactRona', h);
    }
    this.offerHandlers.clear();
  }
}

/**
 * Default host detector: the desktop injects a global `AGENTX_SERVICE` before it
 * loads widgets (the SDK's own module body reads it). Testing `in` on the global
 * object never throws, unlike a bare identifier read.
 */
function defaultDetectDesktopHost(): boolean {
  try {
    return typeof globalThis !== 'undefined' && 'AGENTX_SERVICE' in globalThis;
  } catch {
    return false;
  }
}

/** Race a promise against a timeout; rejects if the timeout wins. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('desktop init timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Coerce the SDK's generically-typed idle-code array into our SDK-free IdleCode[]. */
function coerceIdleCodes(raw: unknown): IdleCode[] {
  if (!Array.isArray(raw)) return [];
  const out: IdleCode[] = [];
  for (const entry of raw as unknown[]) {
    if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      if (typeof rec.id === 'string' && typeof rec.name === 'string') {
        out.push({
          id: rec.id,
          name: rec.name,
          isDefault: typeof rec.isDefault === 'boolean' ? rec.isDefault : undefined,
        });
      }
    }
  }
  return out;
}

/** Best-effort interaction-id extraction from an ACD offer payload of unknown shape. */
function extractInteractionId(msg: unknown): string {
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>;
    if (typeof m.interactionId === 'string') return m.interactionId;
    const data = m.data;
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (typeof d.interactionId === 'string') return d.interactionId;
    }
  }
  return 'unknown';
}
