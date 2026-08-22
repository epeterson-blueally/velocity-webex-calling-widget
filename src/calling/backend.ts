/**
 * CallingBackend — the thin adapter seam between the calling core and the Webex
 * Calling SDK (BUILD-PLAN.md §1: "Verify SDK API names… behind a small adapter").
 *
 * WHY THIS EXISTS: the FSM (src/state) and the CallingController are unit-tested
 * against a *mock* implementation of this interface, never the real SDK. Only
 * WebexCallingBackend (webex-backend.ts) imports @webex/calling. Nothing in
 * src/state imports this file either — the controller is the only consumer.
 *
 * The types here are deliberately SDK-free (plain strings / the FSM's own CallEvent
 * union) so a test double is trivial to write and the seam does not leak SDK shapes
 * upward.
 */

import type { CallDirection, CallErrorInfo, CallEvent, CallerId, Unsubscribe } from '../state/types';

/** Line registration lifecycle, surfaced to the controller and thence the UI. */
export type RegistrationStatus =
  | 'unregistered'
  | 'registering'
  | 'registered'
  | 'reconnecting' // socket dropped / re-registering with backoff
  | 'failed';

/**
 * The SDK-derived subset of CallEvent the backend is allowed to emit. The
 * controller adds the *intent* events (DIAL_STARTED, ANSWER_STARTED,
 * ANSWER_SECOND_STARTED, MUTE_CHANGED) itself — the backend never fabricates those.
 */
export type BackendCallEvent = Exclude<
  CallEvent,
  { type: 'DIAL_STARTED' | 'ANSWER_STARTED' | 'ANSWER_SECOND_STARTED' | 'MUTE_CHANGED' }
>;

/** Everything the backend emits on its single normalized event channel. */
export type BackendEvent =
  | { kind: 'registration'; status: RegistrationStatus; detail?: string }
  /** A wired SDK call event to forward into the FSM. */
  | { kind: 'call'; event: BackendCallEvent };

/**
 * A handle to one call. Every method that touches the SDK is async and rejects on
 * failure so the controller can map the rejection into an FSM error event — there
 * are no fire-and-forget SDK calls (the no-floating-promises rule).
 */
export interface BackendCall {
  readonly id: string;
  readonly direction: CallDirection;

  /** Outbound only: capture the mic stream and place the call. */
  dial(): Promise<void>;
  /** Inbound only: capture the mic stream and answer. */
  answer(): Promise<void>;
  /** Put the call on hold (drives the SDK toggle toward held). */
  hold(): Promise<void>;
  /** Resume a held call (drives the SDK toggle toward resumed). */
  resume(): Promise<void>;
  /**
   * Set mute on/off. Returns the resulting muted state. The toggle-vs-idempotent
   * behaviour of the underlying SDK mute() is confined to the MuteAdapter, so
   * these two methods have clean set-semantics regardless.
   */
  mute(): Promise<boolean>;
  unmute(): Promise<boolean>;
  isMuted(): boolean;
  isHeld(): boolean;
  /** Send one DTMF digit. */
  sendDigit(tone: string): Promise<void>;
  /** Hang up / decline. */
  end(): Promise<void>;
  /** Best-effort caller-ID snapshot. */
  getCallerId(): CallerId | null;
}

export interface CallingBackend {
  /** One-time SDK/client init (creates the calling client). */
  init(): Promise<void>;
  /** Register the line. Emits registration events on the channel. */
  register(): Promise<void>;
  /** Deregister the line. */
  deregister(): Promise<void>;
  /** Current registration status snapshot. */
  getRegistrationStatus(): RegistrationStatus;
  /** Create an outbound call handle for `address` (does not dial yet). */
  makeCall(address: string): Promise<BackendCall>;
  /** Look up a live call handle by id (e.g. the inbound call to answer/decline). */
  getCall(callId: string): BackendCall | undefined;
  /** Subscribe to the normalized backend event channel. */
  onEvent(cb: (event: BackendEvent) => void): Unsubscribe;
  /** Tear down listeners, timers, streams, and the client. Idempotent. */
  dispose(): void;
}

/** Re-exported for adapters/tests that map SDK errors. */
export type { CallErrorInfo };
