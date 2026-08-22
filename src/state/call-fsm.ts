/**
 * CallFsm — the call finite-state machine (BUILD-PLAN.md §1 design rule 1).
 *
 * Pure, synchronous, SDK-free. `send(event)` applies one event and returns the new
 * immutable snapshot; subscribers are notified only when the snapshot actually
 * changes. The machine is defensive by construction:
 *
 *  - Terminal guard: in `idle` and `ended`, ONLY a call-introducing event
 *    (DIAL_STARTED / INCOMING) does anything; every other event is ignored. This
 *    is what makes "established after end", "held after disconnect", and duplicate
 *    disconnects no-ops instead of illegal transitions.
 *  - Identity guard: an event whose callId matches no tracked call (active,
 *    held, or pending) is ignored — stale events for a call that already ended, or
 *    events that arrive for the wrong leg, cannot corrupt state.
 *  - Phase guard: connection events (CONNECT/ESTABLISHED) only advance from
 *    pre-connected states; HELD only from connected; RESUMED only from held —
 *    so out-of-order duplicates are idempotent no-ops.
 *
 * The design supports one foreground call plus (for the "answer a second inbound"
 * case) one backgrounded held call and one unanswered pending inbound. The
 * `consulting` state is a dedicated sub-machine (reduceConsulting) that owns BOTH
 * legs of a consult transfer at once via the `consult` slot — see its doc comment
 * for the complete/cancel/failure behavior, including the three failure cases.
 */

import type {
  CallEvent,
  CallInfo,
  CallSnapshot,
  CallState,
  ConsultInfo,
  ConsultPhase,
  CallerId,
  SnapshotListener,
  Unsubscribe,
} from './types';

const INITIAL: CallSnapshot = {
  state: 'idle',
  call: null,
  heldCall: null,
  pendingInbound: null,
  consult: null,
  lastError: null,
  endReason: null,
};

/** Map a consult leg's sub-phase to the top-level state it becomes when promoted. */
const PHASE_TO_STATE: Record<ConsultPhase, CallState> = {
  dialing: 'dialing',
  connecting: 'connecting',
  connected: 'connected',
};

/** States in which no active call exists and only a new call can begin. */
const TERMINAL_OR_EMPTY: ReadonlySet<CallState> = new Set<CallState>(['idle', 'ended']);

/** Pre-connected states from which CONNECT/ESTABLISHED may advance the call. */
const PRE_CONNECTED: ReadonlySet<CallState> = new Set<CallState>([
  'dialing',
  'ringing_in',
  'connecting',
]);

function newCall(callId: string, direction: CallInfo['direction'], callerId?: CallerId): CallInfo {
  return {
    callId,
    direction,
    callerId: callerId ?? null,
    muted: false,
    connectedAt: null,
    hasRemoteMedia: false,
  };
}

export class CallFsm {
  private snapshot: CallSnapshot = INITIAL;
  private listeners = new Set<SnapshotListener>();
  private readonly now: () => number;

  /** `now` is injectable so tests can assert connectedAt deterministically. */
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  getSnapshot(): CallSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Apply one event. Returns the resulting snapshot (unchanged reference if a no-op). */
  send(event: CallEvent): CallSnapshot {
    const next = this.reduce(this.snapshot, event);
    if (next !== this.snapshot) {
      this.snapshot = next;
      for (const cb of [...this.listeners]) {
        try {
          cb(next);
        } catch {
          // A listener throwing must not corrupt the machine or stop the others.
        }
      }
    }
    return this.snapshot;
  }

  /** Reset to idle (e.g. line deregistered). Clears all call state. */
  reset(): void {
    if (this.snapshot === INITIAL) return;
    this.snapshot = INITIAL;
    for (const cb of [...this.listeners]) {
      try {
        cb(INITIAL);
      } catch {
        // ignore
      }
    }
  }

  // --- reducer ---------------------------------------------------------------

  private reduce(s: CallSnapshot, e: CallEvent): CallSnapshot {
    // 0. Consulting is a self-contained sub-machine owning BOTH legs (call/heldCall/
    //    pendingInbound are null here), so it must intercept before the normal
    //    single-active-call routing below.
    if (s.state === 'consulting') return this.reduceConsulting(s, e);

    // A consult starts from a stable primary call. 'held' is accepted as well as
    // 'connected' so the controller's hold()→CONSULT_STARTED sequence is race-free:
    // the primary's HELD event may land before or after CONSULT_STARTED.
    if (e.type === 'CONSULT_STARTED') {
      if ((s.state !== 'connected' && s.state !== 'held') || s.call?.callId !== e.callId) return s;
      return {
        state: 'consulting',
        call: null,
        heldCall: null,
        pendingInbound: null,
        consult: {
          primary: s.call,
          consult: newCall(e.consultCallId, 'outbound', e.consultCallerId),
          phase: 'dialing',
        },
        lastError: null,
        endReason: null,
      };
    }

    // 1. Call-introducing events are handled first: they are the only way out of
    //    idle/ended, and (for INCOMING) the way a second call is offered.
    if (e.type === 'DIAL_STARTED') {
      if (!TERMINAL_OR_EMPTY.has(s.state)) return s; // already on a call → ignore
      return {
        state: 'dialing',
        call: newCall(e.callId, 'outbound'),
        heldCall: null,
        pendingInbound: null,
        consult: null,
        lastError: null,
        endReason: null,
      };
    }

    if (e.type === 'INCOMING') {
      if (TERMINAL_OR_EMPTY.has(s.state)) {
        return {
          state: 'ringing_in',
          call: newCall(e.callId, 'inbound', e.callerId),
          heldCall: null,
          pendingInbound: null,
          consult: null,
          lastError: null,
          endReason: null,
        };
      }
      // A second inbound while a call exists: offer it ONLY when the current call
      // is stable (connected/held) and no other inbound is already pending. In any
      // less-settled state, or if a slot is taken, ignore it (backend auto-rejects).
      if ((s.state === 'connected' || s.state === 'held') && !s.pendingInbound) {
        if (s.call?.callId === e.callId || s.heldCall?.callId === e.callId) return s;
        return { ...s, pendingInbound: newCall(e.callId, 'inbound', e.callerId) };
      }
      return s;
    }

    // 2. Terminal/empty guard: nothing below can act without an active call.
    if (TERMINAL_OR_EMPTY.has(s.state)) return s;

    // 3. Route the event to whichever tracked call it names. Unknown callId → ignore.
    const target = this.classifyTarget(s, e.callId);
    if (target === 'unknown') return s;

    if (target === 'pending') return this.reducePending(s, e);
    if (target === 'held') return this.reduceHeld(s, e);
    return this.reduceActive(s, e); // target === 'active'
  }

  private classifyTarget(
    s: CallSnapshot,
    callId: string,
  ): 'active' | 'held' | 'pending' | 'unknown' {
    if (s.call?.callId === callId) return 'active';
    if (s.heldCall?.callId === callId) return 'held';
    if (s.pendingInbound?.callId === callId) return 'pending';
    return 'unknown';
  }

  /** Events targeting the foreground/active call. */
  private reduceActive(s: CallSnapshot, e: CallEvent): CallSnapshot {
    const call = s.call;
    if (!call) return s;

    switch (e.type) {
      case 'PROGRESS':
      case 'ALERTING':
        // Ring-back / alerting: no snapshot change (the `dialing` state already
        // conveys "outbound, not yet connected"); a late duplicate is likewise a no-op.
        return s;

      case 'ANSWER_STARTED':
        // Inbound accepted; move to connecting unless already progressing past it.
        return s.state === 'ringing_in' ? { ...s, state: 'connecting' } : s;

      case 'CONNECT':
        return PRE_CONNECTED.has(s.state) ? { ...s, state: 'connecting' } : s;

      case 'ESTABLISHED':
        if (!PRE_CONNECTED.has(s.state)) return s; // duplicate/out-of-order → ignore
        return {
          ...s,
          state: 'connected',
          call: { ...call, connectedAt: call.connectedAt ?? this.now() },
        };

      case 'REMOTE_MEDIA':
        if (call.hasRemoteMedia) return s;
        return { ...s, call: { ...call, hasRemoteMedia: true } };

      case 'HELD':
        return s.state === 'connected' ? { ...s, state: 'held' } : s;

      case 'RESUMED':
        return s.state === 'held' ? { ...s, state: 'connected' } : s;

      case 'MUTE_CHANGED':
        if (call.muted === e.muted) return s;
        return { ...s, call: { ...call, muted: e.muted } };

      case 'CALLER_ID':
        return { ...s, call: { ...call, callerId: e.callerId } };

      case 'HOLD_ERROR':
        // Hold failed: the call stays connected; surface the error, don't move.
        return { ...s, lastError: e.error };

      case 'RESUME_ERROR':
        // Resume failed: the call stays held; surface the error, don't move.
        return { ...s, lastError: e.error };

      case 'TRANSFER_ERROR':
        // A blind transfer failed: the call stays up (connected/held); surface it.
        return { ...s, lastError: e.error };

      case 'CALL_ERROR':
        return this.endActive(s, e.error.message, e.error);

      case 'DISCONNECT':
        return this.endActive(s, e.reason ?? null, null);

      // ANSWER_SECOND_STARTED / INCOMING handled earlier; DIAL_STARTED can't reach here.
      default:
        return s;
    }
  }

  /**
   * The active call is ending. If a backgrounded held call exists, promote it to
   * the foreground in `held` state (agent resumes it manually); otherwise go to
   * `ended`, preserving the just-ended call's info for the UI's post-call summary.
   */
  private endActive(
    s: CallSnapshot,
    reason: string | null,
    error: CallSnapshot['lastError'],
  ): CallSnapshot {
    if (s.heldCall) {
      return {
        state: 'held',
        call: s.heldCall,
        heldCall: null,
        pendingInbound: s.pendingInbound,
        consult: null,
        lastError: error,
        endReason: reason,
      };
    }
    return {
      state: 'ended',
      call: s.call,
      heldCall: null,
      pendingInbound: s.pendingInbound,
      consult: null,
      lastError: error,
      endReason: reason,
    };
  }

  /** Events targeting the backgrounded held call (during answer-and-hold). */
  private reduceHeld(s: CallSnapshot, e: CallEvent): CallSnapshot {
    const held = s.heldCall;
    if (!held) return s;
    switch (e.type) {
      case 'DISCONNECT':
      case 'CALL_ERROR':
        // The backgrounded call dropped; just clear it, foreground call unaffected.
        return { ...s, heldCall: null };
      case 'CALLER_ID':
        return { ...s, heldCall: { ...held, callerId: e.callerId } };
      default:
        // HELD/RESUMED/etc for a backgrounded call are not surfaced.
        return s;
    }
  }

  /** Events targeting the unanswered second inbound call. */
  private reducePending(s: CallSnapshot, e: CallEvent): CallSnapshot {
    const pending = s.pendingInbound;
    if (!pending) return s;
    switch (e.type) {
      case 'DISCONNECT':
        // Caller gave up, or we declined it: clear the offer.
        return { ...s, pendingInbound: null };
      case 'CALL_ERROR':
        return { ...s, pendingInbound: null, lastError: e.error };
      case 'CALLER_ID':
        return { ...s, pendingInbound: { ...pending, callerId: e.callerId } };
      case 'ANSWER_SECOND_STARTED': {
        // Answer-and-hold: current foreground call → background (held); the pending
        // inbound becomes the foreground call, now connecting toward established.
        if (!s.call) return s;
        return {
          state: 'connecting',
          call: { ...pending },
          heldCall: { ...s.call },
          pendingInbound: null,
          consult: null,
          lastError: null,
          endReason: null,
        };
      }
      default:
        return s;
    }
  }

  // --- consult transfer sub-machine ------------------------------------------

  /**
   * The `consulting` sub-state (BUILD-PLAN.md Phase 4). Owns BOTH legs via
   * `s.consult`: the primary (held throughout) and the consult leg (the live one,
   * moving dialing → connecting → connected). Resolves three ways:
   *
   *  - COMPLETE  (CONSULT_COMPLETED)  → join the calls → `ended` (endReason
   *    "Transferred."), preserving the primary for the post-call summary.
   *  - CANCEL    (CONSULT_CANCELLED)  → primary back to the foreground as `held`
   *    (the controller then resumes it); the consult leg is ended by the controller.
   *  - The consult leg DYING on its own — the three failure cases:
   *      (a) it errors on dial            → CALL_ERROR on the consult leg
   *      (b) the target declines / drops  → DISCONNECT on the consult leg
   *    both fall back to a held primary (controller resumes on cancel only; here the
   *    primary is left held for the agent), surfacing the error for case (a).
   *  - (c) the PRIMARY's far end hangs up mid-consult → DISCONNECT on the primary:
   *    the consult leg is promoted to the foreground in its current phase so the
   *    agent keeps talking to the transfer target, and lastError names which leg
   *    died. The transfer can no longer complete (nothing left to join).
   */
  private reduceConsulting(s: CallSnapshot, e: CallEvent): CallSnapshot {
    const c = s.consult;
    if (!c) return s; // invariant: consult is non-null whenever state === 'consulting'

    // Whole-transfer control events, independent of which leg they name.
    if (e.type === 'CONSULT_COMPLETED') {
      return {
        state: 'ended',
        call: c.primary, // the transferred party, for the post-call summary
        heldCall: null,
        pendingInbound: null,
        consult: null,
        lastError: null,
        endReason: 'Transferred.',
      };
    }
    if (e.type === 'CONSULT_CANCELLED') {
      // Return the primary to the foreground, still held; the controller resumes it.
      return this.fallbackToHeldPrimary(c, s.lastError);
    }
    if (e.type === 'TRANSFER_ERROR') {
      // completeTransfer failed: stay in the consult so the agent can retry/cancel.
      return { ...s, lastError: e.error };
    }

    // Everything else is routed to whichever of the two legs it names.
    if (e.callId === c.consult.callId) return this.reduceConsultLeg(s, c, e);
    if (e.callId === c.primary.callId) return this.reduceConsultPrimary(s, c, e);
    return s; // unknown callId → ignore
  }

  /** Events for the live consult leg (the one being dialed / talked to). */
  private reduceConsultLeg(s: CallSnapshot, c: ConsultInfo, e: CallEvent): CallSnapshot {
    switch (e.type) {
      case 'PROGRESS':
      case 'ALERTING':
        return s; // ring-back; `phase: 'dialing'` already conveys this

      case 'CONNECT':
        return c.phase === 'dialing'
          ? { ...s, consult: { ...c, phase: 'connecting' } }
          : s;

      case 'ESTABLISHED':
        if (c.phase === 'connected') return s;
        return {
          ...s,
          consult: {
            ...c,
            phase: 'connected',
            consult: { ...c.consult, connectedAt: c.consult.connectedAt ?? this.now() },
          },
        };

      case 'REMOTE_MEDIA':
        if (c.consult.hasRemoteMedia) return s;
        return { ...s, consult: { ...c, consult: { ...c.consult, hasRemoteMedia: true } } };

      case 'CALLER_ID':
        return { ...s, consult: { ...c, consult: { ...c.consult, callerId: e.callerId } } };

      case 'MUTE_CHANGED':
        if (c.consult.muted === e.muted) return s;
        return { ...s, consult: { ...c, consult: { ...c.consult, muted: e.muted } } };

      case 'DISCONNECT':
        // Failure (b) / normal cancel-race: consult target gone → back to primary.
        return this.fallbackToHeldPrimary(c, s.lastError);

      case 'CALL_ERROR':
        // Failure (a): consult leg errored (e.g. dial failed) → back to primary.
        return this.fallbackToHeldPrimary(c, e.error);

      // HELD/RESUMED for the consult leg are not modelled here.
      default:
        return s;
    }
  }

  /** Events for the held primary while consulting. */
  private reduceConsultPrimary(s: CallSnapshot, c: ConsultInfo, e: CallEvent): CallSnapshot {
    switch (e.type) {
      case 'DISCONNECT':
        // Failure (c): the ORIGINAL caller hung up mid-consult. Promote the consult
        // leg to the foreground so the agent keeps talking to the transfer target.
        return this.promoteConsultLeg(c, {
          kind: 'transfer',
          message: 'The original caller hung up during the consult.',
        });

      case 'CALL_ERROR':
        // The primary errored out mid-consult; same promotion, surface its error.
        return this.promoteConsultLeg(c, e.error);

      case 'CALLER_ID':
        return { ...s, consult: { ...c, primary: { ...c.primary, callerId: e.callerId } } };

      // The primary is expected to be held; HELD/RESUMED confirmations are no-ops.
      default:
        return s;
    }
  }

  /** Move the primary back to the foreground as a held call; drop the consult leg. */
  private fallbackToHeldPrimary(c: ConsultInfo, lastError: CallSnapshot['lastError']): CallSnapshot {
    return {
      state: 'held',
      call: c.primary,
      heldCall: null,
      pendingInbound: null,
      consult: null,
      lastError,
      endReason: null,
    };
  }

  /** Promote the consult leg to the foreground in its current phase; drop the primary. */
  private promoteConsultLeg(c: ConsultInfo, lastError: CallSnapshot['lastError']): CallSnapshot {
    return {
      state: PHASE_TO_STATE[c.phase],
      call: c.consult,
      heldCall: null,
      pendingInbound: null,
      consult: null,
      lastError,
      endReason: null,
    };
  }
}
