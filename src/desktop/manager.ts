/**
 * DesktopStateManager — the WxCC desktop-state SUBSCRIBER (BUILD-PLAN.md §1 rule 2,
 * Phase 5).
 *
 * It observes the calling FSM's public snapshot stream and reacts by driving the
 * agent's WxCC state through the DesktopBackend adapter. It NEVER calls any calling
 * API and imports nothing from @webex/calling; the only calling coupling is a
 * type-only import of the FSM's CallSnapshot and a structural CallStatusSource seam.
 *
 * Behaviour:
 *   - On the personal call reaching `connected` (RTMS media up): capture the agent's
 *     current WxCC state, then set Idle('Non-Contact Center Call') so no ACD contact
 *     routes to the agent while they are on a personal call (RONA avoidance).
 *   - On the personal call ending: restore the captured state ONLY if the agent is
 *     still in the exact state we set (Idle with OUR aux code). If the agent or an
 *     ACD event changed it underneath us, leave it alone and log.
 *   - If an ACD interaction is offered while a personal call is active: never touch
 *     it (this module cannot and must not auto-answer) — surface a banner and log.
 *   - If 'Non-Contact Center Call' does not exist in the tenant: surface a
 *     config-error banner naming the Control Hub path; do not fabricate an ID.
 */

import type { CallSnapshot, CallState } from '../state/types';
import type {
  AgentStateSnapshot,
  AgentStateTarget,
  DesktopBackend,
  IdleCode,
  Unsubscribe,
} from './backend';

/** The exact name of the idle code the widget sets while on a personal call. */
export const IDLE_CODE_NAME = 'Non-Contact Center Call';

/** The Control Hub path an admin must follow to create the idle code, if absent. */
export const CONTROL_HUB_IDLE_CODE_PATH =
  'Control Hub → Contact Center → Desktop Experience → Auxiliary Codes';

/** The SDK's default aux code id used to represent the 'Available' state. */
const AVAILABLE_AUX_CODE = '0';

/**
 * The subset of the CallingController's public API this manager consumes. Declared
 * structurally so the manager depends on no calling class — decoupling per rule 2.
 * CallingController satisfies it (its status object carries `.call`).
 */
export interface CallStatusSource {
  getStatus(): { call: CallSnapshot };
  onChange(cb: (status: { call: CallSnapshot }) => void): Unsubscribe;
}

/** The observable status the UI renders the desktop-integration banners from. */
export interface DesktopStatus {
  /** True only inside the Agent Desktop; false (and fully no-op) in the harness. */
  present: boolean;
  /** Resolved id of 'Non-Contact Center Call', or null if unresolved/absent. */
  idleCodeId: string | null;
  /** Config-error banner (idle code missing) naming the Control Hub path, else null. */
  configError: string | null;
  /** True while we have forced Idle for an active personal call. */
  idleForcedForCall: boolean;
  /** Banner shown when an ACD interaction is offered during a personal call, else null. */
  acdInterleaveBanner: string | null;
  /** The captured prior state we intend to restore (diagnostics), or null. */
  capturedState: AgentStateSnapshot | null;
}

export interface DesktopStateManagerOptions {
  backend: DesktopBackend;
  /** The calling FSM status source (CallingController) to subscribe to. */
  callStatus: CallStatusSource;
}

/** Call states in which a personal call is "active" and the agent must be Idle. */
const ACTIVE_STATES: ReadonlySet<CallState> = new Set<CallState>([
  'connected',
  'held',
  'consulting',
]);

export class DesktopStateManager {
  private readonly backend: DesktopBackend;
  private readonly callStatus: CallStatusSource;

  private present = false;
  private idleCodeId: string | null = null;
  private configError: string | null = null;
  private acdInterleaveBanner: string | null = null;

  /** The state captured just before we forced Idle, awaiting restore. */
  private capturedState: AgentStateSnapshot | null = null;
  /** The exact state we last SET, used for the "changed underneath us" guard. */
  private forcedTarget: AgentStateTarget | null = null;
  /** True once we observe an active personal call and have driven Idle for it. */
  private engaged = false;

  private started = false;
  private disposed = false;

  private unsubCall: Unsubscribe | null = null;
  private unsubAcd: Unsubscribe | null = null;
  private statusListeners = new Set<(s: DesktopStatus) => void>();

  constructor(options: DesktopStateManagerOptions) {
    this.backend = options.backend;
    this.callStatus = options.callStatus;
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * Init the desktop SDK, resolve the idle code, and wire subscriptions. Safe to
   * await; never throws. Outside the Agent Desktop it detects the absent SDK and
   * no-ops (present=false) so the standalone harness is unaffected.
   */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;

    try {
      await this.backend.init();
    } catch {
      // A failed/absent init means we are not in the desktop — no-op gracefully.
      this.present = false;
      this.emit();
      return;
    }
    this.present = this.backend.isPresent();
    if (!this.present) {
      this.emit();
      return; // harness / outside the desktop: subscribe to nothing, touch nothing.
    }

    await this.resolveIdleCode();

    // Subscribe to the ACD offer channel and the calling FSM snapshot stream.
    this.unsubAcd = this.backend.onAcdInteractionOffered((i) =>
      this.onAcdInteractionOffered(i.isRona),
    );
    this.unsubCall = this.callStatus.onChange((s) => this.onCallSnapshot(s.call));
    // Reconcile against the current snapshot in case a call is already up.
    this.onCallSnapshot(this.callStatus.getStatus().call);
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubCall?.();
    this.unsubAcd?.();
    this.unsubCall = this.unsubAcd = null;
    this.statusListeners.clear();
    this.backend.dispose();
  }

  // --- observable status -----------------------------------------------------

  getStatus(): DesktopStatus {
    return {
      present: this.present,
      idleCodeId: this.idleCodeId,
      configError: this.configError,
      idleForcedForCall: this.engaged,
      acdInterleaveBanner: this.acdInterleaveBanner,
      capturedState: this.capturedState,
    };
  }

  onChange(cb: (status: DesktopStatus) => void): Unsubscribe {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  // --- idle-code resolution --------------------------------------------------

  private async resolveIdleCode(): Promise<void> {
    let codes: IdleCode[] = [];
    try {
      codes = await this.backend.getIdleCodes();
    } catch {
      codes = [];
    }
    const match = codes.find((c) => c.name === IDLE_CODE_NAME);
    if (match) {
      this.idleCodeId = match.id;
      this.configError = null;
    } else {
      this.idleCodeId = null;
      this.configError =
        `Idle code "${IDLE_CODE_NAME}" is not configured for this tenant. ` +
        `Create it under ${CONTROL_HUB_IDLE_CODE_PATH}. ` +
        `Personal calls will NOT auto-set the agent to Idle until it exists.`;
    }
  }

  // --- FSM subscription: set on connected, restore on ended ------------------

  private onCallSnapshot(call: CallSnapshot): void {
    if (this.disposed || !this.present) return;
    const active = ACTIVE_STATES.has(call.state) && call.call !== null;

    if (active && !this.engaged) {
      void this.engage();
    } else if (!active && this.engaged) {
      void this.disengage();
    }
  }

  /** Personal call reached `connected`: capture current state, force Idle. */
  private async engage(): Promise<void> {
    // Mark engaged synchronously so a rapid connected→ended cannot double-fire.
    this.engaged = true;

    if (this.idleCodeId === null) {
      // No idle code resolved — we cannot force Idle. Surface the config banner
      // (already set) and log; RONA avoidance is unavailable until it exists.
      this.backend.log(
        'call→desktop',
        `Personal call connected but idle code "${IDLE_CODE_NAME}" is unresolved; ` +
          `cannot set Idle. See ${CONTROL_HUB_IDLE_CODE_PATH}.`,
      );
      this.emit();
      return;
    }

    // Capture BEFORE overriding, so we can restore exactly.
    this.capturedState = this.backend.getCurrentAgentState();
    const target: AgentStateTarget = { state: 'Idle', auxCodeId: this.idleCodeId };
    try {
      await this.backend.setAgentState(target);
      this.forcedTarget = target;
      this.backend.log(
        'call→desktop',
        `Personal call connected → set agent Idle ("${IDLE_CODE_NAME}", ` +
          `captured prior state "${this.capturedState.state}").`,
      );
    } catch (err) {
      // Could not set Idle — leave whatever the agent had, do not fake success.
      this.forcedTarget = null;
      this.backend.log(
        'call→desktop',
        `Failed to set agent Idle for personal call: ${errMsg(err)}.`,
      );
    }
    this.emit();
  }

  /**
   * Personal call ended: restore the captured state, but ONLY if the agent is still
   * in the exact state we set. If the agent chose a different state or an ACD event
   * moved them, leave it and log (the "changed underneath us" guard).
   */
  private async disengage(): Promise<void> {
    this.engaged = false;
    this.acdInterleaveBanner = null; // the interleave banner is scoped to the call

    const captured = this.capturedState;
    const forced = this.forcedTarget;
    this.capturedState = null;
    this.forcedTarget = null;

    if (!forced || !captured) {
      // We never successfully forced Idle (no code, or the set failed) — nothing to
      // restore.
      this.emit();
      return;
    }

    const current = this.backend.getCurrentAgentState();
    if (!this.matchesForced(current, forced)) {
      // The agent or an ACD event changed our state while the call was up. Do NOT
      // clobber their choice — leave it and log.
      this.backend.log(
        'call→desktop',
        `Personal call ended, but agent state changed underneath us ` +
          `(now "${current.state}"/aux "${current.auxCodeId ?? '—'}", expected Idle/aux ` +
          `"${forced.auxCodeId}"). Leaving it; NOT restoring "${captured.state}".`,
      );
      this.emit();
      return;
    }

    // Still exactly the state we set → restore the captured prior state.
    const restore = this.toRestoreTarget(captured);
    try {
      await this.backend.setAgentState(restore);
      this.backend.log(
        'call→desktop',
        `Personal call ended → restored agent state to "${restore.state}"` +
          (restore.state === 'Idle' ? ` (aux "${restore.auxCodeId}").` : '.'),
      );
    } catch (err) {
      this.backend.log(
        'call→desktop',
        `Personal call ended; failed to restore state "${restore.state}": ${errMsg(err)}.`,
      );
    }
    this.emit();
  }

  /** True when `current` is the exact state we set (Idle with our aux code). */
  private matchesForced(current: AgentStateSnapshot, forced: AgentStateTarget): boolean {
    return (
      current.state.toLowerCase() === forced.state.toLowerCase() &&
      current.auxCodeId === forced.auxCodeId
    );
  }

  /**
   * Map a captured snapshot to a settable target. The desktop reports many raw
   * statuses; we only ever set Available or Idle, so anything that is not a clean
   * "Idle" is restored as Available (the safe default the agent was in to receive
   * ACD contacts before the personal call).
   */
  private toRestoreTarget(captured: AgentStateSnapshot): AgentStateTarget {
    if (captured.state.toLowerCase() === 'idle') {
      return { state: 'Idle', auxCodeId: captured.auxCodeId ?? AVAILABLE_AUX_CODE };
    }
    return { state: 'Available', auxCodeId: AVAILABLE_AUX_CODE };
  }

  // --- ACD interleave: surface a banner, never auto-answer -------------------

  private onAcdInteractionOffered(isRona: boolean): void {
    if (this.disposed || !this.present) return;
    // Log every offer regardless (both directions logged for the demo).
    if (!this.engaged) {
      // No personal call up: nothing to protect. Let the normal desktop flow handle
      // it; just log for the demo trace.
      this.backend.log(
        'desktop→call',
        `ACD interaction offered (rona=${String(isRona)}); no personal call active — ignored by widget.`,
      );
      return;
    }
    // A personal call IS up. We must NOT auto-answer either side; the agent decides.
    this.acdInterleaveBanner =
      'An ACD contact was offered while you are on a personal call. ' +
      'It was NOT auto-answered — handle it manually or let it redirect (RONA). ' +
      'The agent remains Idle for the duration of the personal call.';
    this.backend.log(
      'desktop→call',
      `ACD interaction offered DURING a personal call (rona=${String(isRona)}); ` +
        `surfaced banner, did NOT auto-answer.`,
    );
    this.emit();
  }

  // --- status emission -------------------------------------------------------

  private emit(): void {
    const status = this.getStatus();
    for (const cb of [...this.statusListeners]) {
      try {
        cb(status);
      } catch {
        // A subscriber throwing must not stop the others or the manager.
      }
    }
  }
}

/** Extract a safe message from an unknown thrown value (never leaks token material). */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}
