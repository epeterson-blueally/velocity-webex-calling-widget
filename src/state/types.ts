/**
 * src/state — the call finite-state machine's public types.
 *
 * DESIGN RULE 1 (BUILD-PLAN.md §1): "A call FSM owns truth." The FSM is the single
 * source of truth for call state; the UI renders from its snapshots and NEVER sets
 * state directly. Only events move the machine.
 *
 * This module imports NOTHING from the calling SDK (@webex/calling). It is pure,
 * synchronous, deterministic reducer logic so it can be unit-tested exhaustively
 * against a mocked backend. The SDK lives behind the CallingBackend seam
 * (src/calling/backend.ts); the controller translates SDK/backend signals into the
 * CallEvent union below and feeds them here.
 */

/**
 * The call lifecycle states.
 *
 * Plan (§1) names idle → dialing|ringing_in → connected ⇄ held → ended. We add one
 * refinement, `connecting`, for the window after a call is answered / receives the
 * SDK `connect` signal but before `established` — this makes out-of-order handling
 * (e.g. a disconnect that arrives before establishment) explicit rather than
 * ambiguous, and gives the UI an honest "connecting…" state to render.
 */
export type CallState =
  | 'idle'
  | 'dialing' // outbound placed, not yet connected (progress/alerting live here)
  | 'ringing_in' // inbound offered, not yet answered
  | 'connecting' // answered / connect received, awaiting established
  | 'connected' // established, media flowing
  | 'held' // an established call put on hold
  | 'ended'; // terminal

export type CallDirection = 'inbound' | 'outbound';

/** Caller-ID snapshot surfaced to the UI. Never contains token material. */
export interface CallerId {
  name?: string;
  num?: string;
}

/**
 * A mapped call-level error. `kind` classifies for the UI/telemetry; `message` is a
 * human string safe to render (never contains token material). Derived from the
 * SDK's CallError (ERROR_TYPE / CALL_ERROR_CODE) by the backend adapter.
 */
export interface CallErrorInfo {
  kind:
    | 'setup' // dial/answer failed to start
    | 'media' // mic capture / media negotiation failed
    | 'hold' // doHoldResume (→held) failed
    | 'resume' // doHoldResume (→resumed) failed
    | 'call' // generic in-call error from the SDK
    | 'busy' // remote busy / rejected
    | 'transfer'; // reserved for Phase 4
  message: string;
  /** Optional numeric SDK code (CALL_ERROR_CODE) for diagnostics. */
  code?: number;
}

/** Per-call snapshot the UI renders. */
export interface CallInfo {
  callId: string;
  direction: CallDirection;
  callerId: CallerId | null;
  muted: boolean;
  /** epoch-ms the call reached `connected` (for the in-call timer), else null. */
  connectedAt: number | null;
  /** true once the remote-media track has arrived (audio should be flowing). */
  hasRemoteMedia: boolean;
}

/**
 * The immutable snapshot emitted after every event. The UI and desktop-state
 * subscriber render entirely from this.
 */
export interface CallSnapshot {
  state: CallState;
  /** The active/foreground call, or null when idle/ended. */
  call: CallInfo | null;
  /**
   * A call put on hold in the background because the agent answered a second
   * inbound call (answer-and-hold). Null in the common single-call case.
   */
  heldCall: CallInfo | null;
  /**
   * A second inbound call offered while a call is already connected/held. The UI
   * offers "answer (and hold current)" or "decline". Null when none pending.
   */
  pendingInbound: CallInfo | null;
  /** The most recent non-fatal error (hold/resume failures leave the call up). */
  lastError: CallErrorInfo | null;
  /** Why the last call ended, when known (e.g. "Normal Disconnect.", "User Busy."). */
  endReason: string | null;
}

/**
 * The event union — the ONLY way to move the machine.
 *
 * Two origins, one channel:
 *  - Controller-originated *intent* events fire only after the corresponding
 *    backend call actually started (e.g. DIAL_STARTED fires after backend.makeCall
 *    + dial() resolved) — they encode a locally-known fact, not UI speculation.
 *  - Backend/SDK-originated events are the wired @webex/calling call events.
 *
 * Every event carries a `callId` so stale / out-of-order events for a call that is
 * no longer active are safely ignored (see call-fsm.ts).
 */
export type CallEvent =
  // --- controller intent events ---
  | { type: 'DIAL_STARTED'; callId: string; address?: string }
  | { type: 'ANSWER_STARTED'; callId: string }
  | { type: 'ANSWER_SECOND_STARTED'; callId: string }
  | { type: 'MUTE_CHANGED'; callId: string; muted: boolean }
  // --- backend / SDK call events ---
  | { type: 'INCOMING'; callId: string; callerId?: CallerId }
  | { type: 'PROGRESS'; callId: string }
  | { type: 'ALERTING'; callId: string }
  | { type: 'CONNECT'; callId: string }
  | { type: 'ESTABLISHED'; callId: string }
  | { type: 'REMOTE_MEDIA'; callId: string }
  | { type: 'HELD'; callId: string }
  | { type: 'RESUMED'; callId: string }
  | { type: 'CALLER_ID'; callId: string; callerId: CallerId }
  | { type: 'DISCONNECT'; callId: string; reason?: string }
  | { type: 'CALL_ERROR'; callId: string; error: CallErrorInfo }
  | { type: 'HOLD_ERROR'; callId: string; error: CallErrorInfo }
  | { type: 'RESUME_ERROR'; callId: string; error: CallErrorInfo };

export type CallEventType = CallEvent['type'];

export type SnapshotListener = (snapshot: CallSnapshot) => void;
export type Unsubscribe = () => void;
