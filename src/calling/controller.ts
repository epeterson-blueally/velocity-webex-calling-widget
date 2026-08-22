/**
 * CallingController — the programmatic API the Phase 6 UI will render from and drive.
 *
 * It owns the three moving parts and the wiring between them:
 *   - the CallFsm (single source of truth for call state),
 *   - a CallingBackend (the SDK seam; a mock in tests, WebexCallingBackend live),
 *   - the auth TokenProvider (getToken + onTokenChange).
 *
 * Responsibilities (BUILD-PLAN.md Phase 3):
 *   - Init + register the line; expose registration status.
 *   - Re-register on token change and on socket drop, with bounded exponential
 *     backoff, surfacing 'reconnecting' + attempt count to the UI.
 *   - Translate backend/SDK events into FSM events; translate UI actions into
 *     backend calls, feeding the matching intent event into the FSM.
 *   - Wrap EVERY backend call with error mapping into FSM error states — no
 *     unhandled promise rejections anywhere.
 *
 * It holds NO token material (that stays inside the TokenProvider) and never logs
 * or renders a token.
 */

import type { AuthState, TokenProvider, Unsubscribe } from '../auth/types';
import { CallFsm } from '../state/call-fsm';
import type { CallSnapshot } from '../state/types';
import type {
  BackendCall,
  BackendEvent,
  CallingBackend,
  RegistrationStatus,
} from './backend';

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
  /** Max reconnect attempts before giving up with 'failed'. */
  maxAttempts: number;
}

const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 2_000, maxMs: 30_000, maxAttempts: 6 };

/** The full status object the UI subscribes to. */
export interface CallingStatus {
  registration: RegistrationStatus;
  registrationDetail: string | null;
  /** Current reconnect attempt (0 when not reconnecting). */
  reconnectAttempt: number;
  auth: AuthState;
  call: CallSnapshot;
  /** Last non-fatal action failure (mute/DTMF), surfaced without ending the call. */
  lastActionError: string | null;
}

export interface CallingControllerOptions {
  backend: CallingBackend;
  tokenProvider: TokenProvider;
  backoff?: Partial<BackoffConfig>;
  now?: () => number;
  /** Injectable timers so backoff is deterministic under test. */
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class CallingController {
  private readonly backend: CallingBackend;
  private readonly tokens: TokenProvider;
  private readonly fsm: CallFsm;
  private readonly backoff: BackoffConfig;
  private readonly setTimeoutImpl: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (handle: ReturnType<typeof setTimeout>) => void;

  private registration: RegistrationStatus = 'unregistered';
  private registrationDetail: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private auth: AuthState;
  private lastActionError: string | null = null;

  private started = false;
  private disposed = false;

  private unsubBackend: Unsubscribe | null = null;
  private unsubToken: Unsubscribe | null = null;
  private unsubAuthStatus: Unsubscribe | null = null;
  private unsubFsm: Unsubscribe | null = null;

  private statusListeners = new Set<(s: CallingStatus) => void>();

  constructor(options: CallingControllerOptions) {
    this.backend = options.backend;
    this.tokens = options.tokenProvider;
    this.fsm = new CallFsm(options.now);
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.setTimeoutImpl =
      options.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? ((h) => clearTimeout(h));
    this.auth = this.tokens.getStatus();
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * Wire subscriptions, init the backend, and attempt the first registration.
   * Safe to await; registration failures surface as status, they do not throw.
   */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;

    this.unsubBackend = this.backend.onEvent((e) => this.onBackendEvent(e));
    this.unsubToken = this.tokens.onTokenChange(() => this.onTokenChange());
    this.unsubAuthStatus = this.tokens.onStatusChange((s) => {
      this.auth = s;
      this.emit();
    });
    this.unsubFsm = this.fsm.subscribe(() => this.emit());

    try {
      await this.backend.init();
    } catch (err) {
      this.setRegistration('failed', `Calling client init failed: ${errMsg(err)}`);
      return;
    }
    await this.registerNow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelReconnect();
    this.unsubBackend?.();
    this.unsubToken?.();
    this.unsubAuthStatus?.();
    this.unsubFsm?.();
    this.unsubBackend = this.unsubToken = this.unsubAuthStatus = this.unsubFsm = null;
    this.statusListeners.clear();
    this.backend.dispose();
  }

  // --- observable status -----------------------------------------------------

  getStatus(): CallingStatus {
    return {
      registration: this.registration,
      registrationDetail: this.registrationDetail,
      reconnectAttempt: this.reconnectAttempt,
      auth: this.auth,
      call: this.fsm.getSnapshot(),
      lastActionError: this.lastActionError,
    };
  }

  onChange(cb: (status: CallingStatus) => void): Unsubscribe {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  /** Test/telemetry accessor for the raw FSM snapshot. */
  getCallSnapshot(): CallSnapshot {
    return this.fsm.getSnapshot();
  }

  // --- registration + backoff ------------------------------------------------

  /** Force a (re)registration now, cancelling any pending backoff timer. */
  async registerNow(): Promise<void> {
    if (this.disposed) return;
    this.cancelReconnect();
    this.setRegistration('registering');
    try {
      // Obtain a fresh token before asking the SDK to register. Any failure here
      // (token unavailable or register rejected) enters bounded backoff below.
      await this.tokens.getToken();
      await this.backend.register();
      // Terminal registration status ('registered'/'failed') arrives via the
      // backend event channel; register() resolving only means the request was sent.
    } catch (err) {
      this.scheduleReconnect(`Registration failed: ${errMsg(err)}`);
    }
  }

  private scheduleReconnect(detail: string): void {
    if (this.disposed) return;
    if (this.reconnectAttempt >= this.backoff.maxAttempts) {
      this.reconnectAttempt = 0;
      this.setRegistration('failed', `${detail} (gave up after ${this.backoff.maxAttempts} attempts)`);
      return;
    }
    const attempt = this.reconnectAttempt;
    const delay = Math.min(this.backoff.baseMs * 2 ** attempt, this.backoff.maxMs);
    this.reconnectAttempt = attempt + 1;
    this.setRegistration('reconnecting', `${detail} — retrying in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt}).`);
    this.cancelReconnect();
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      // Background retry: guard so a rejection can never float.
      void this.attemptReconnect();
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.disposed) return;
    this.setRegistration('reconnecting');
    try {
      await this.tokens.getToken();
      await this.backend.register();
    } catch (err) {
      this.scheduleReconnect(`Reconnect failed: ${errMsg(err)}`);
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private onTokenChange(): void {
    // A fresh token arrived (refresh or new sign-in). Re-register so the line uses
    // it; reset backoff since this is a deliberate, non-error re-registration.
    if (this.disposed || !this.started) return;
    this.reconnectAttempt = 0;
    void this.registerNow();
  }

  private onBackendEvent(e: BackendEvent): void {
    if (this.disposed) return;
    if (e.kind === 'registration') {
      this.handleRegistrationEvent(e.status, e.detail);
      return;
    }
    // A wired SDK call event → feed straight into the FSM.
    this.fsm.send(e.event);
  }

  private handleRegistrationEvent(status: RegistrationStatus, detail?: string): void {
    switch (status) {
      case 'registered':
        this.reconnectAttempt = 0;
        this.cancelReconnect();
        this.setRegistration('registered', detail ?? null);
        break;
      case 'reconnecting':
        // The SDK saw a socket drop and is recovering; reflect it but let our own
        // backoff own the retry cadence if it escalates to unregistered/failed.
        this.setRegistration('reconnecting', detail ?? 'Connection lost; reconnecting…');
        break;
      case 'unregistered':
        // Unexpected drop while we expected to be up → enter bounded backoff.
        if (this.registration === 'registered' || this.registration === 'reconnecting') {
          this.scheduleReconnect(detail ?? 'Line unregistered');
        } else {
          this.setRegistration('unregistered', detail ?? null);
        }
        break;
      case 'failed':
        this.scheduleReconnect(detail ?? 'Registration error');
        break;
      case 'registering':
        this.setRegistration('registering', detail ?? null);
        break;
    }
  }

  private setRegistration(status: RegistrationStatus, detail: string | null = null): void {
    if (this.registration === status && this.registrationDetail === detail) return;
    this.registration = status;
    this.registrationDetail = detail;
    this.emit();
  }

  // --- call actions (each wraps the backend + maps errors into the FSM) ------

  /** Place an outbound call. */
  async dial(address: string): Promise<void> {
    if (this.disposed) return;
    this.clearActionError();
    let call: BackendCall;
    try {
      call = await this.backend.makeCall(address);
    } catch (err) {
      this.setActionError(`Could not start the call: ${errMsg(err)}`);
      return;
    }
    // Reflect the started outbound call in the FSM before dialing so PROGRESS/
    // CONNECT events (which race with dial() resolving) always have a call to land on.
    this.fsm.send({ type: 'DIAL_STARTED', callId: call.id, address });
    try {
      await call.dial();
    } catch (err) {
      this.fsm.send({
        type: 'CALL_ERROR',
        callId: call.id,
        error: { kind: 'setup', message: `Dial failed: ${errMsg(err)}` },
      });
    }
  }

  /** Answer the currently-ringing inbound call. */
  async answer(): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (snap.state !== 'ringing_in' || !snap.call) return;
    const call = this.backend.getCall(snap.call.callId);
    if (!call) return;
    this.fsm.send({ type: 'ANSWER_STARTED', callId: call.id });
    try {
      await call.answer();
    } catch (err) {
      this.fsm.send({
        type: 'CALL_ERROR',
        callId: call.id,
        error: { kind: 'setup', message: `Answer failed: ${errMsg(err)}` },
      });
    }
  }

  /** Decline the currently-ringing inbound call. */
  async decline(): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (snap.state !== 'ringing_in' || !snap.call) return;
    await this.endCall(snap.call.callId);
  }

  /** Put the active call on hold. */
  async hold(): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (snap.state !== 'connected' || !snap.call) return;
    const call = this.backend.getCall(snap.call.callId);
    if (!call) return;
    try {
      await call.hold();
      // The FSM moves to 'held' on the SDK 'held' event, not optimistically.
    } catch (err) {
      this.fsm.send({
        type: 'HOLD_ERROR',
        callId: call.id,
        error: { kind: 'hold', message: `Hold failed: ${errMsg(err)}` },
      });
    }
  }

  /** Resume a held call. */
  async resume(): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (snap.state !== 'held' || !snap.call) return;
    const call = this.backend.getCall(snap.call.callId);
    if (!call) return;
    try {
      await call.resume();
    } catch (err) {
      this.fsm.send({
        type: 'RESUME_ERROR',
        callId: call.id,
        error: { kind: 'resume', message: `Resume failed: ${errMsg(err)}` },
      });
    }
  }

  async mute(): Promise<void> {
    await this.setMuted(true);
  }

  async unmute(): Promise<void> {
    await this.setMuted(false);
  }

  private async setMuted(target: boolean): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (!snap.call || (snap.state !== 'connected' && snap.state !== 'held')) return;
    const call = this.backend.getCall(snap.call.callId);
    if (!call) return;
    this.clearActionError();
    try {
      const muted = target ? await call.mute() : await call.unmute();
      this.fsm.send({ type: 'MUTE_CHANGED', callId: call.id, muted });
    } catch (err) {
      // Mute failure is non-fatal — keep the call up, surface as an action error.
      this.setActionError(`${target ? 'Mute' : 'Unmute'} failed: ${errMsg(err)}`);
    }
  }

  /** Send one DTMF digit on the active call. */
  async sendDigit(tone: string): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (!snap.call || (snap.state !== 'connected' && snap.state !== 'held')) return;
    const call = this.backend.getCall(snap.call.callId);
    if (!call) return;
    this.clearActionError();
    try {
      await call.sendDigit(tone);
    } catch (err) {
      this.setActionError(`Could not send digit '${tone}': ${errMsg(err)}`);
    }
  }

  /** Hang up the active call. */
  async end(): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (!snap.call) return;
    await this.endCall(snap.call.callId);
  }

  /** Answer a second inbound call while a call is up: hold the current, answer the new. */
  async answerSecond(): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (!snap.pendingInbound || !snap.call) return;
    const primary = this.backend.getCall(snap.call.callId);
    const second = this.backend.getCall(snap.pendingInbound.callId);
    if (!second) return;
    const secondId = snap.pendingInbound.callId;
    // Move the FSM into the answer-and-hold shape first so subsequent events land.
    this.fsm.send({ type: 'ANSWER_SECOND_STARTED', callId: secondId });
    try {
      if (primary && snap.state === 'connected') await primary.hold();
    } catch (err) {
      this.setActionError(`Could not hold the current call: ${errMsg(err)}`);
    }
    try {
      await second.answer();
    } catch (err) {
      this.fsm.send({
        type: 'CALL_ERROR',
        callId: secondId,
        error: { kind: 'setup', message: `Answer failed: ${errMsg(err)}` },
      });
    }
  }

  /** Decline a pending second inbound call. */
  async declineSecond(): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (!snap.pendingInbound) return;
    await this.endCall(snap.pendingInbound.callId);
  }

  private async endCall(callId: string): Promise<void> {
    const call = this.backend.getCall(callId);
    if (!call) {
      // Nothing to hang up in the backend, but ensure the FSM does not wedge.
      this.fsm.send({ type: 'DISCONNECT', callId });
      return;
    }
    try {
      await call.end();
      // The FSM ends on the SDK 'disconnect' event under normal flow.
    } catch (err) {
      // Force the FSM to clear so the agent is never stuck on a call they ended.
      this.setActionError(`End reported an error: ${errMsg(err)}`);
      this.fsm.send({ type: 'DISCONNECT', callId, reason: 'ended locally' });
    }
  }

  // --- transfers -------------------------------------------------------------

  /**
   * Blind transfer the active (connected OR held) call to `target`. The SDK ends
   * the call on success; the FSM lands on the resulting DISCONNECT. A failure is
   * surfaced via TRANSFER_ERROR and leaves the call up.
   */
  async blindTransfer(target: string): Promise<void> {
    const dest = target.trim();
    if (!dest) {
      this.setActionError('Enter a transfer destination first.');
      return;
    }
    const snap = this.fsm.getSnapshot();
    if ((snap.state !== 'connected' && snap.state !== 'held') || !snap.call) return;
    const call = this.backend.getCall(snap.call.callId);
    if (!call) return;
    this.clearActionError();
    try {
      await call.blindTransfer(dest);
    } catch (err) {
      this.fsm.send({
        type: 'TRANSFER_ERROR',
        callId: call.id,
        error: { kind: 'transfer', message: `Blind transfer failed: ${errMsg(err)}` },
      });
    }
  }

  /**
   * Start a consult transfer: create the consult leg, hold the primary, then dial
   * the leg. Ordering matters — the consult call object is created first so a
   * makeCall failure leaves the primary untouched; the primary is then held before
   * the leg takes media (per DISCOVERY.md §5). On dial failure (failure case a) the
   * FSM falls back to the held primary.
   */
  async startConsult(target: string): Promise<void> {
    const dest = target.trim();
    if (!dest) {
      this.setActionError('Enter a consult destination first.');
      return;
    }
    const snap = this.fsm.getSnapshot();
    if (snap.state !== 'connected' || !snap.call) return;
    const primaryId = snap.call.callId;
    const primary = this.backend.getCall(primaryId);
    if (!primary) return;
    this.clearActionError();

    // 1. Create the consult leg object (no media yet). Primary untouched if this fails.
    let consult: BackendCall;
    try {
      consult = await this.backend.makeCall(dest);
    } catch (err) {
      this.setActionError(`Could not start the consult call: ${errMsg(err)}`);
      return;
    }

    // 2. Hold the primary before the consult leg takes media. Discard the leg if
    //    the hold fails, and leave the primary connected.
    try {
      await primary.hold();
    } catch (err) {
      this.fsm.send({
        type: 'HOLD_ERROR',
        callId: primaryId,
        error: { kind: 'hold', message: `Could not hold the call to consult: ${errMsg(err)}` },
      });
      try {
        await consult.end();
      } catch {
        // best-effort discard of the never-dialed consult object
      }
      return;
    }

    // 3. Enter the consult sub-state, THEN dial (so leg events have somewhere to land).
    this.fsm.send({
      type: 'CONSULT_STARTED',
      callId: primaryId,
      consultCallId: consult.id,
      consultCallerId: consult.getCallerId() ?? undefined,
    });
    try {
      await consult.dial();
    } catch (err) {
      // Failure case (a): the consult leg errored on dial → fall back to held primary.
      this.fsm.send({
        type: 'CALL_ERROR',
        callId: consult.id,
        error: { kind: 'setup', message: `Consult dial failed: ${errMsg(err)}` },
      });
    }
  }

  /** Complete the in-flight consult transfer, joining the primary and consult legs. */
  async completeConsult(): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (snap.state !== 'consulting' || !snap.consult) return;
    const primaryId = snap.consult.primary.callId;
    const consultId = snap.consult.consult.callId;
    const primary = this.backend.getCall(primaryId);
    if (!primary) return;
    this.clearActionError();
    try {
      await primary.consultTransfer(consultId);
      // Both legs end on success; move straight to ended rather than racing the two
      // DISCONNECTs. A stray late DISCONNECT for either leg is then a terminal no-op.
      this.fsm.send({ type: 'CONSULT_COMPLETED', callId: primaryId });
    } catch (err) {
      // Stay in the consult so the agent can retry or cancel.
      this.fsm.send({
        type: 'TRANSFER_ERROR',
        callId: primaryId,
        error: { kind: 'transfer', message: `Transfer failed: ${errMsg(err)}` },
      });
    }
  }

  /**
   * Cancel the in-flight consult: end the consult leg and resume the primary. The
   * FSM is moved out of `consulting` to `held(primary)` first (deterministically),
   * so the subsequent resume lands on the now-foreground primary.
   */
  async cancelConsult(): Promise<void> {
    const snap = this.fsm.getSnapshot();
    if (snap.state !== 'consulting' || !snap.consult) return;
    const primaryId = snap.consult.primary.callId;
    const consultId = snap.consult.consult.callId;
    const primary = this.backend.getCall(primaryId);
    const consult = this.backend.getCall(consultId);
    this.clearActionError();

    // Deterministic transition first: consulting → held(primary), consult slot cleared.
    this.fsm.send({ type: 'CONSULT_CANCELLED', callId: primaryId });

    // End the consult leg. Its DISCONNECT now names an untracked id → FSM no-op.
    if (consult) {
      try {
        await consult.end();
      } catch (err) {
        this.setActionError(`Ending the consult call reported an error: ${errMsg(err)}`);
      }
    }

    // Resume the primary (the FSM is now in 'held' with the primary in the foreground).
    if (primary) {
      try {
        await primary.resume();
      } catch (err) {
        this.fsm.send({
          type: 'RESUME_ERROR',
          callId: primaryId,
          error: { kind: 'resume', message: `Resume failed: ${errMsg(err)}` },
        });
      }
    }
  }

  // --- status emission -------------------------------------------------------

  private setActionError(message: string): void {
    this.lastActionError = message;
    this.emit();
  }

  private clearActionError(): void {
    if (this.lastActionError !== null) {
      this.lastActionError = null;
      this.emit();
    }
  }

  private emit(): void {
    const status = this.getStatus();
    for (const cb of [...this.statusListeners]) {
      try {
        cb(status);
      } catch {
        // A subscriber throwing must not stop the others or the controller.
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
