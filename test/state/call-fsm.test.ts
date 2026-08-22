import { describe, expect, it, vi } from 'vitest';
import { CallFsm } from '../../src/state/call-fsm';
import type { CallErrorInfo, CallEvent, CallState } from '../../src/state/types';

/**
 * Exhaustive FSM tests (BUILD-PLAN.md Phase 3 exit criterion: "every event in every
 * state, including out-of-order disconnects"). Organized as:
 *   1. Happy-path outbound + inbound lifecycles.
 *   2. A data-driven matrix: every CallEvent applied in every state, asserting the
 *      resulting state (and no-op behaviour).
 *   3. Out-of-order / duplicate / stale-callId cases called out explicitly.
 *   4. The second-inbound (answer-and-hold / decline) paths.
 *   5. Subscription + immutability semantics.
 */

const C1 = 'call-1';
const C2 = 'call-2';
const ERR: CallErrorInfo = { kind: 'call', message: 'boom' };

function err(kind: CallErrorInfo['kind'] = 'call'): CallErrorInfo {
  return { kind, message: `${kind} failed` };
}

/** Drive a fresh FSM to a target state with call C1 as the active call. */
function at(state: CallState): CallFsm {
  const fsm = new CallFsm(() => 1000);
  switch (state) {
    case 'idle':
      break;
    case 'dialing':
      fsm.send({ type: 'DIAL_STARTED', callId: C1 });
      break;
    case 'ringing_in':
      fsm.send({ type: 'INCOMING', callId: C1 });
      break;
    case 'connecting':
      fsm.send({ type: 'DIAL_STARTED', callId: C1 });
      fsm.send({ type: 'CONNECT', callId: C1 });
      break;
    case 'connected':
      fsm.send({ type: 'DIAL_STARTED', callId: C1 });
      fsm.send({ type: 'ESTABLISHED', callId: C1 });
      break;
    case 'held':
      fsm.send({ type: 'DIAL_STARTED', callId: C1 });
      fsm.send({ type: 'ESTABLISHED', callId: C1 });
      fsm.send({ type: 'HELD', callId: C1 });
      break;
    case 'ended':
      fsm.send({ type: 'DIAL_STARTED', callId: C1 });
      fsm.send({ type: 'DISCONNECT', callId: C1 });
      break;
  }
  return fsm;
}

describe('CallFsm — happy paths', () => {
  it('outbound: idle → dialing → (progress) → connecting → connected → held → connected → ended', () => {
    const fsm = new CallFsm(() => 5000);
    expect(fsm.getSnapshot().state).toBe('idle');
    expect(fsm.send({ type: 'DIAL_STARTED', callId: C1, address: '+15551234' }).state).toBe('dialing');
    expect(fsm.getSnapshot().call?.direction).toBe('outbound');
    expect(fsm.send({ type: 'PROGRESS', callId: C1 }).state).toBe('dialing');
    expect(fsm.send({ type: 'CONNECT', callId: C1 }).state).toBe('connecting');
    const est = fsm.send({ type: 'ESTABLISHED', callId: C1 });
    expect(est.state).toBe('connected');
    expect(est.call?.connectedAt).toBe(5000);
    expect(fsm.send({ type: 'HELD', callId: C1 }).state).toBe('held');
    expect(fsm.send({ type: 'RESUMED', callId: C1 }).state).toBe('connected');
    const ended = fsm.send({ type: 'DISCONNECT', callId: C1, reason: 'Normal Disconnect.' });
    expect(ended.state).toBe('ended');
    expect(ended.endReason).toBe('Normal Disconnect.');
  });

  it('inbound: idle → ringing_in → connecting (answered) → connected → ended', () => {
    const fsm = new CallFsm(() => 7000);
    expect(fsm.send({ type: 'INCOMING', callId: C1, callerId: { num: '+1999' } }).state).toBe('ringing_in');
    expect(fsm.getSnapshot().call?.direction).toBe('inbound');
    expect(fsm.getSnapshot().call?.callerId?.num).toBe('+1999');
    expect(fsm.send({ type: 'ANSWER_STARTED', callId: C1 }).state).toBe('connecting');
    expect(fsm.send({ type: 'ESTABLISHED', callId: C1 }).state).toBe('connected');
    expect(fsm.send({ type: 'DISCONNECT', callId: C1 }).state).toBe('ended');
  });

  it('inbound decline: ringing_in → ended on disconnect', () => {
    const fsm = at('ringing_in');
    expect(fsm.send({ type: 'DISCONNECT', callId: C1 }).state).toBe('ended');
  });

  it('tracks mute, remote media, and caller-id updates without changing state', () => {
    const fsm = at('connected');
    expect(fsm.send({ type: 'MUTE_CHANGED', callId: C1, muted: true }).call?.muted).toBe(true);
    expect(fsm.getSnapshot().state).toBe('connected');
    expect(fsm.send({ type: 'REMOTE_MEDIA', callId: C1 }).call?.hasRemoteMedia).toBe(true);
    expect(fsm.send({ type: 'CALLER_ID', callId: C1, callerId: { name: 'Ada' } }).call?.callerId?.name).toBe('Ada');
    expect(fsm.getSnapshot().state).toBe('connected');
  });
});

/**
 * The full matrix. For each (state, event) pair the expected resulting STATE is
 * asserted. `callId` is C1 (the active call) unless the event introduces a new one.
 */
describe('CallFsm — every event in every state (state transition matrix)', () => {
  const ALL_STATES: CallState[] = [
    'idle',
    'dialing',
    'ringing_in',
    'connecting',
    'connected',
    'held',
    'ended',
  ];

  // event factory keyed by a label, plus the expected resulting state per source
  // state. `consulting` is intentionally omitted (it is a self-contained sub-machine
  // with its own dedicated describe-block below), so the map is partial over the base
  // states the matrix drives via at().
  type Case = { event: CallEvent; expect: Partial<Record<CallState, CallState>> };

  const table: Record<string, Case> = {
    DIAL_STARTED: {
      event: { type: 'DIAL_STARTED', callId: C1 },
      // Only from a terminal/empty state does a new dial begin.
      expect: { idle: 'dialing', ended: 'dialing', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    INCOMING_SAME: {
      event: { type: 'INCOMING', callId: C1 },
      // In idle/ended a new inbound rings; elsewhere a same-id incoming is ignored.
      expect: { idle: 'ringing_in', ended: 'ringing_in', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    PROGRESS: {
      event: { type: 'PROGRESS', callId: C1 },
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    ALERTING: {
      event: { type: 'ALERTING', callId: C1 },
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    ANSWER_STARTED: {
      event: { type: 'ANSWER_STARTED', callId: C1 },
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'connecting', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    CONNECT: {
      event: { type: 'CONNECT', callId: C1 },
      expect: { idle: 'idle', ended: 'ended', dialing: 'connecting', ringing_in: 'connecting', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    ESTABLISHED: {
      event: { type: 'ESTABLISHED', callId: C1 },
      expect: { idle: 'idle', ended: 'ended', dialing: 'connected', ringing_in: 'connected', connecting: 'connected', connected: 'connected', held: 'held' },
    },
    REMOTE_MEDIA: {
      event: { type: 'REMOTE_MEDIA', callId: C1 },
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    HELD: {
      event: { type: 'HELD', callId: C1 },
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'held', held: 'held' },
    },
    RESUMED: {
      event: { type: 'RESUMED', callId: C1 },
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'connected' },
    },
    CALLER_ID: {
      event: { type: 'CALLER_ID', callId: C1, callerId: { name: 'X' } },
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    MUTE_CHANGED: {
      event: { type: 'MUTE_CHANGED', callId: C1, muted: true },
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    HOLD_ERROR: {
      event: { type: 'HOLD_ERROR', callId: C1, error: ERR },
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    RESUME_ERROR: {
      event: { type: 'RESUME_ERROR', callId: C1, error: ERR },
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
    DISCONNECT: {
      event: { type: 'DISCONNECT', callId: C1 },
      expect: { idle: 'idle', ended: 'ended', dialing: 'ended', ringing_in: 'ended', connecting: 'ended', connected: 'ended', held: 'ended' },
    },
    CALL_ERROR: {
      event: { type: 'CALL_ERROR', callId: C1, error: ERR },
      expect: { idle: 'idle', ended: 'ended', dialing: 'ended', ringing_in: 'ended', connecting: 'ended', connected: 'ended', held: 'ended' },
    },
    ANSWER_SECOND_STARTED: {
      event: { type: 'ANSWER_SECOND_STARTED', callId: C1 },
      // No pending inbound in any of these base states → always a no-op.
      expect: { idle: 'idle', ended: 'ended', dialing: 'dialing', ringing_in: 'ringing_in', connecting: 'connecting', connected: 'connected', held: 'held' },
    },
  };

  for (const [label, testCase] of Object.entries(table)) {
    for (const state of ALL_STATES) {
      it(`${label} in ${state} → ${testCase.expect[state]}`, () => {
        const fsm = at(state);
        const result = fsm.send(testCase.event);
        expect(result.state).toBe(testCase.expect[state]);
      });
    }
  }

  // Unknown-callId events are ignored in every non-empty state.
  const UNKNOWN_EVENTS: CallEvent[] = [
    { type: 'ESTABLISHED', callId: C2 },
    { type: 'DISCONNECT', callId: C2 },
    { type: 'HELD', callId: C2 },
    { type: 'CALL_ERROR', callId: C2, error: ERR },
  ];
  for (const state of ['dialing', 'ringing_in', 'connecting', 'connected', 'held'] as CallState[]) {
    for (const ev of UNKNOWN_EVENTS) {
      it(`ignores ${ev.type} for unknown callId in ${state}`, () => {
        const fsm = at(state);
        const before = fsm.getSnapshot();
        const after = fsm.send(ev);
        expect(after).toBe(before); // same reference → no change emitted
        expect(after.state).toBe(state);
      });
    }
  }
});

describe('CallFsm — out-of-order, duplicate, and stale events', () => {
  it('disconnect BEFORE established (call cancelled while dialing) → ended, and a late established is ignored', () => {
    const fsm = at('dialing');
    expect(fsm.send({ type: 'DISCONNECT', callId: C1 }).state).toBe('ended');
    const late = fsm.send({ type: 'ESTABLISHED', callId: C1 });
    expect(late.state).toBe('ended'); // established after end → no-op
  });

  it('established arriving AFTER end is a no-op (terminal guard)', () => {
    const fsm = at('connected');
    fsm.send({ type: 'DISCONNECT', callId: C1 });
    expect(fsm.getSnapshot().state).toBe('ended');
    expect(fsm.send({ type: 'ESTABLISHED', callId: C1 }).state).toBe('ended');
  });

  it('HELD arriving AFTER disconnect is a no-op', () => {
    const fsm = at('connected');
    fsm.send({ type: 'DISCONNECT', callId: C1 });
    const before = fsm.getSnapshot();
    expect(fsm.send({ type: 'HELD', callId: C1 })).toBe(before);
  });

  it('double DISCONNECT: the second is a no-op', () => {
    const fsm = at('connected');
    const ended = fsm.send({ type: 'DISCONNECT', callId: C1, reason: 'first' });
    const again = fsm.send({ type: 'DISCONNECT', callId: C1, reason: 'second' });
    expect(again).toBe(ended);
    expect(again.endReason).toBe('first'); // not overwritten
  });

  it('double ESTABLISHED: connectedAt is set once and not reset', () => {
    let t = 100;
    const fsm = new CallFsm(() => t);
    fsm.send({ type: 'DIAL_STARTED', callId: C1 });
    fsm.send({ type: 'ESTABLISHED', callId: C1 });
    expect(fsm.getSnapshot().call?.connectedAt).toBe(100);
    t = 999;
    const again = fsm.send({ type: 'ESTABLISHED', callId: C1 });
    expect(again.call?.connectedAt).toBe(100); // unchanged; also a no-op reference
    expect(again).toBe(fsm.getSnapshot());
  });

  it('CONNECT after connected is idempotent (stays connected)', () => {
    const fsm = at('connected');
    const before = fsm.getSnapshot();
    expect(fsm.send({ type: 'CONNECT', callId: C1 })).toBe(before);
  });

  it('RESUMED without a prior HELD (in connected) is a no-op', () => {
    const fsm = at('connected');
    const before = fsm.getSnapshot();
    expect(fsm.send({ type: 'RESUMED', callId: C1 })).toBe(before);
  });

  it('HELD while still dialing (not yet connected) is a no-op', () => {
    const fsm = at('dialing');
    const before = fsm.getSnapshot();
    expect(fsm.send({ type: 'HELD', callId: C1 })).toBe(before);
  });

  it('hold_error leaves the call connected and records lastError', () => {
    const fsm = at('connected');
    const after = fsm.send({ type: 'HOLD_ERROR', callId: C1, error: err('hold') });
    expect(after.state).toBe('connected');
    expect(after.lastError?.kind).toBe('hold');
  });

  it('resume_error leaves the call held and records lastError', () => {
    const fsm = at('held');
    const after = fsm.send({ type: 'RESUME_ERROR', callId: C1, error: err('resume') });
    expect(after.state).toBe('held');
    expect(after.lastError?.kind).toBe('resume');
  });

  it('a new call can start from ended (DIAL_STARTED) and clears prior error/reason', () => {
    const fsm = at('connected');
    fsm.send({ type: 'CALL_ERROR', callId: C1, error: ERR });
    expect(fsm.getSnapshot().state).toBe('ended');
    const fresh = fsm.send({ type: 'DIAL_STARTED', callId: C2 });
    expect(fresh.state).toBe('dialing');
    expect(fresh.call?.callId).toBe(C2);
    expect(fresh.lastError).toBeNull();
    expect(fresh.endReason).toBeNull();
  });

  it('a new inbound can ring from ended (INCOMING)', () => {
    const fsm = at('ended');
    expect(fsm.send({ type: 'INCOMING', callId: C2 }).state).toBe('ringing_in');
  });
});

describe('CallFsm — second inbound (answer-and-hold / decline)', () => {
  it('a second inbound while connected is offered as pendingInbound (state unchanged)', () => {
    const fsm = at('connected');
    const after = fsm.send({ type: 'INCOMING', callId: C2, callerId: { num: '+1888' } });
    expect(after.state).toBe('connected');
    expect(after.pendingInbound?.callId).toBe(C2);
    expect(after.pendingInbound?.callerId?.num).toBe('+1888');
  });

  it('a second inbound while held is offered as pendingInbound', () => {
    const fsm = at('held');
    expect(fsm.send({ type: 'INCOMING', callId: C2 }).pendingInbound?.callId).toBe(C2);
  });

  it('declining the second inbound (its disconnect) clears the offer, primary unaffected', () => {
    const fsm = at('connected');
    fsm.send({ type: 'INCOMING', callId: C2 });
    const after = fsm.send({ type: 'DISCONNECT', callId: C2 });
    expect(after.pendingInbound).toBeNull();
    expect(after.state).toBe('connected');
    expect(after.call?.callId).toBe(C1);
  });

  it('caller-id update targets the pending inbound', () => {
    const fsm = at('connected');
    fsm.send({ type: 'INCOMING', callId: C2 });
    const after = fsm.send({ type: 'CALLER_ID', callId: C2, callerId: { name: 'Grace' } });
    expect(after.pendingInbound?.callerId?.name).toBe('Grace');
    expect(after.call?.callerId?.name).toBeUndefined();
  });

  it('answer-and-hold: primary → heldCall, pending → active connecting; then established → connected', () => {
    const fsm = at('connected');
    fsm.send({ type: 'INCOMING', callId: C2 });
    const answered = fsm.send({ type: 'ANSWER_SECOND_STARTED', callId: C2 });
    expect(answered.state).toBe('connecting');
    expect(answered.call?.callId).toBe(C2);
    expect(answered.heldCall?.callId).toBe(C1);
    expect(answered.pendingInbound).toBeNull();
    const est = fsm.send({ type: 'ESTABLISHED', callId: C2 });
    expect(est.state).toBe('connected');
    expect(est.heldCall?.callId).toBe(C1);
  });

  it('when the active call ends with a held call in the background, the held call is promoted to held', () => {
    const fsm = at('connected');
    fsm.send({ type: 'INCOMING', callId: C2 });
    fsm.send({ type: 'ANSWER_SECOND_STARTED', callId: C2 });
    fsm.send({ type: 'ESTABLISHED', callId: C2 });
    const afterEnd = fsm.send({ type: 'DISCONNECT', callId: C2 });
    expect(afterEnd.state).toBe('held');
    expect(afterEnd.call?.callId).toBe(C1);
    expect(afterEnd.heldCall).toBeNull();
  });

  it('a backgrounded held call dropping (its disconnect) clears heldCall, active unaffected', () => {
    const fsm = at('connected');
    fsm.send({ type: 'INCOMING', callId: C2 });
    fsm.send({ type: 'ANSWER_SECOND_STARTED', callId: C2 });
    fsm.send({ type: 'ESTABLISHED', callId: C2 });
    const after = fsm.send({ type: 'DISCONNECT', callId: C1 }); // the backgrounded/held one
    expect(after.heldCall).toBeNull();
    expect(after.state).toBe('connected');
    expect(after.call?.callId).toBe(C2);
  });

  it('a third simultaneous inbound is ignored while one is already pending', () => {
    const fsm = at('connected');
    fsm.send({ type: 'INCOMING', callId: C2 });
    const before = fsm.getSnapshot();
    const after = fsm.send({ type: 'INCOMING', callId: 'call-3' });
    expect(after).toBe(before);
    expect(after.pendingInbound?.callId).toBe(C2);
  });

  it('does not offer a second inbound while merely dialing/ringing (not yet stable)', () => {
    const dialing = at('dialing');
    expect(dialing.send({ type: 'INCOMING', callId: C2 }).pendingInbound).toBeNull();
    const ringing = at('ringing_in');
    expect(ringing.send({ type: 'INCOMING', callId: C2 }).pendingInbound).toBeNull();
  });
});

describe('CallFsm — consult transfer sub-state', () => {
  const T = 'consult-leg';

  /** Drive an FSM to `consulting`: C1 connected → consult leg T dialing. */
  function consulting(now = () => 4000): CallFsm {
    const fsm = new CallFsm(now);
    fsm.send({ type: 'DIAL_STARTED', callId: C1 });
    fsm.send({ type: 'ESTABLISHED', callId: C1 });
    fsm.send({ type: 'CONSULT_STARTED', callId: C1, consultCallId: T, consultCallerId: { num: '+1444' } });
    return fsm;
  }

  it('CONSULT_STARTED from connected enters consulting, owning BOTH legs', () => {
    const fsm = consulting();
    const s = fsm.getSnapshot();
    expect(s.state).toBe('consulting');
    expect(s.call).toBeNull();
    expect(s.heldCall).toBeNull();
    expect(s.consult?.primary.callId).toBe(C1);
    expect(s.consult?.consult.callId).toBe(T);
    expect(s.consult?.consult.callerId?.num).toBe('+1444');
    expect(s.consult?.phase).toBe('dialing');
  });

  it('CONSULT_STARTED is also accepted from held (hold-event race safe)', () => {
    const fsm = at('held');
    const s = fsm.send({ type: 'CONSULT_STARTED', callId: C1, consultCallId: T });
    expect(s.state).toBe('consulting');
    expect(s.consult?.primary.callId).toBe(C1);
  });

  it('CONSULT_STARTED is ignored when not on a connected/held primary, or wrong callId', () => {
    const dialing = at('dialing');
    expect(dialing.send({ type: 'CONSULT_STARTED', callId: C1, consultCallId: T }).state).toBe('dialing');
    const conn = at('connected');
    // wrong primary id → ignored
    const before = conn.getSnapshot();
    expect(conn.send({ type: 'CONSULT_STARTED', callId: 'other', consultCallId: T })).toBe(before);
  });

  it('consult leg progresses dialing → connecting → connected (records connectedAt)', () => {
    const fsm = consulting(() => 8888);
    expect(fsm.send({ type: 'PROGRESS', callId: T }).consult?.phase).toBe('dialing');
    expect(fsm.send({ type: 'CONNECT', callId: T }).consult?.phase).toBe('connecting');
    const est = fsm.send({ type: 'ESTABLISHED', callId: T });
    expect(est.consult?.phase).toBe('connected');
    expect(est.consult?.consult.connectedAt).toBe(8888);
  });

  it('consult leg REMOTE_MEDIA, CALLER_ID and MUTE_CHANGED update only the leg', () => {
    const fsm = consulting();
    expect(fsm.send({ type: 'REMOTE_MEDIA', callId: T }).consult?.consult.hasRemoteMedia).toBe(true);
    expect(fsm.send({ type: 'CALLER_ID', callId: T, callerId: { name: 'Consultee' } }).consult?.consult.callerId?.name).toBe('Consultee');
    expect(fsm.send({ type: 'MUTE_CHANGED', callId: T, muted: true }).consult?.consult.muted).toBe(true);
    // The primary was not touched.
    expect(fsm.getSnapshot().consult?.primary.muted).toBe(false);
  });

  it('CALLER_ID for the primary updates only the primary', () => {
    const fsm = consulting();
    const s = fsm.send({ type: 'CALLER_ID', callId: C1, callerId: { name: 'Original' } });
    expect(s.consult?.primary.callerId?.name).toBe('Original');
    expect(s.consult?.consult.callerId?.name).toBeUndefined();
  });

  it('an unknown callId is ignored while consulting', () => {
    const fsm = consulting();
    const before = fsm.getSnapshot();
    expect(fsm.send({ type: 'ESTABLISHED', callId: 'nobody' })).toBe(before);
  });

  it("primary's HELD/RESUMED confirmations while consulting are no-ops", () => {
    const fsm = consulting();
    const before = fsm.getSnapshot();
    expect(fsm.send({ type: 'HELD', callId: C1 })).toBe(before);
    expect(fsm.send({ type: 'RESUMED', callId: C1 })).toBe(before);
  });

  // --- COMPLETE (join) ---
  it('CONSULT_COMPLETED joins the calls → ended, preserving the primary + reason', () => {
    const fsm = consulting();
    fsm.send({ type: 'ESTABLISHED', callId: T });
    const s = fsm.send({ type: 'CONSULT_COMPLETED', callId: C1 });
    expect(s.state).toBe('ended');
    expect(s.call?.callId).toBe(C1);
    expect(s.endReason).toBe('Transferred.');
    expect(s.consult).toBeNull();
  });

  it('after CONSULT_COMPLETED, late DISCONNECTs for either leg are terminal no-ops', () => {
    const fsm = consulting();
    fsm.send({ type: 'ESTABLISHED', callId: T });
    const ended = fsm.send({ type: 'CONSULT_COMPLETED', callId: C1 });
    expect(fsm.send({ type: 'DISCONNECT', callId: T })).toBe(ended);
    expect(fsm.send({ type: 'DISCONNECT', callId: C1 })).toBe(ended);
  });

  // --- CANCEL (resume primary) ---
  it('CONSULT_CANCELLED returns the primary to the foreground as held', () => {
    const fsm = consulting();
    fsm.send({ type: 'ESTABLISHED', callId: T });
    const s = fsm.send({ type: 'CONSULT_CANCELLED', callId: C1 });
    expect(s.state).toBe('held');
    expect(s.call?.callId).toBe(C1);
    expect(s.consult).toBeNull();
    // The controller then resumes: RESUMED lands on the now-foreground primary.
    expect(fsm.send({ type: 'RESUMED', callId: C1 }).state).toBe('connected');
  });

  // --- FAILURE (a): consult leg errors on dial ---
  it('(a) CALL_ERROR on the consult leg falls back to the held primary, surfacing the error', () => {
    const fsm = consulting();
    const s = fsm.send({ type: 'CALL_ERROR', callId: T, error: err('setup') });
    expect(s.state).toBe('held');
    expect(s.call?.callId).toBe(C1);
    expect(s.consult).toBeNull();
    expect(s.lastError?.kind).toBe('setup');
  });

  // --- FAILURE (b): consult target declines / never answers ---
  it('(b) DISCONNECT on the consult leg (target declined) falls back to the held primary', () => {
    const fsm = consulting();
    fsm.send({ type: 'CONNECT', callId: T }); // ringing, target then declines
    const s = fsm.send({ type: 'DISCONNECT', callId: T });
    expect(s.state).toBe('held');
    expect(s.call?.callId).toBe(C1);
    expect(s.consult).toBeNull();
  });

  it('(b) a declined consult while the leg was still dialing also falls back to held', () => {
    const fsm = consulting();
    const s = fsm.send({ type: 'DISCONNECT', callId: T });
    expect(s.state).toBe('held');
    expect(s.call?.callId).toBe(C1);
  });

  // --- FAILURE (c): primary's far end hangs up mid-consult ---
  it('(c) DISCONNECT on the PRIMARY promotes the connected consult leg to the foreground', () => {
    const fsm = consulting();
    fsm.send({ type: 'ESTABLISHED', callId: T }); // consult leg connected
    const s = fsm.send({ type: 'DISCONNECT', callId: C1 }); // original caller hangs up
    expect(s.state).toBe('connected');
    expect(s.call?.callId).toBe(T);
    expect(s.consult).toBeNull();
    expect(s.lastError?.kind).toBe('transfer');
    expect(s.lastError?.message).toMatch(/original caller hung up/i);
  });

  it('(c) primary hangup while the consult leg is still dialing promotes it in dialing', () => {
    const fsm = consulting();
    const s = fsm.send({ type: 'DISCONNECT', callId: C1 });
    expect(s.state).toBe('dialing');
    expect(s.call?.callId).toBe(T);
  });

  it('(c) primary hangup while the consult leg is connecting promotes it in connecting', () => {
    const fsm = consulting();
    fsm.send({ type: 'CONNECT', callId: T });
    const s = fsm.send({ type: 'DISCONNECT', callId: C1 });
    expect(s.state).toBe('connecting');
    expect(s.call?.callId).toBe(T);
  });

  it('(c) CALL_ERROR on the primary also promotes the consult leg, surfacing that error', () => {
    const fsm = consulting();
    fsm.send({ type: 'ESTABLISHED', callId: T });
    const s = fsm.send({ type: 'CALL_ERROR', callId: C1, error: err('call') });
    expect(s.state).toBe('connected');
    expect(s.call?.callId).toBe(T);
    expect(s.lastError?.kind).toBe('call');
  });

  // --- TRANSFER_ERROR keeps the consult alive ---
  it('TRANSFER_ERROR while consulting stays in consulting and surfaces the error', () => {
    const fsm = consulting();
    fsm.send({ type: 'ESTABLISHED', callId: T });
    const s = fsm.send({ type: 'TRANSFER_ERROR', callId: C1, error: err('transfer') });
    expect(s.state).toBe('consulting');
    expect(s.consult?.consult.callId).toBe(T);
    expect(s.lastError?.kind).toBe('transfer');
  });

  it('after a promoted consult leg, the promoted call ends normally → ended', () => {
    const fsm = consulting();
    fsm.send({ type: 'ESTABLISHED', callId: T });
    fsm.send({ type: 'DISCONNECT', callId: C1 }); // (c): promote T
    expect(fsm.send({ type: 'DISCONNECT', callId: T }).state).toBe('ended');
  });
});

describe('CallFsm — blind transfer', () => {
  it('TRANSFER_ERROR in connected keeps the call up and records lastError', () => {
    const fsm = at('connected');
    const s = fsm.send({ type: 'TRANSFER_ERROR', callId: C1, error: err('transfer') });
    expect(s.state).toBe('connected');
    expect(s.lastError?.kind).toBe('transfer');
  });

  it('TRANSFER_ERROR in held keeps the call held and records lastError', () => {
    const fsm = at('held');
    const s = fsm.send({ type: 'TRANSFER_ERROR', callId: C1, error: err('transfer') });
    expect(s.state).toBe('held');
    expect(s.lastError?.kind).toBe('transfer');
  });

  it('a successful blind transfer ends the call via the SDK DISCONNECT', () => {
    const fsm = at('connected');
    const s = fsm.send({ type: 'DISCONNECT', callId: C1, reason: 'Call transferred.' });
    expect(s.state).toBe('ended');
    expect(s.endReason).toBe('Call transferred.');
  });
});

describe('CallFsm — subscription + immutability', () => {
  it('notifies subscribers only when the snapshot actually changes', () => {
    const fsm = at('connected');
    const cb = vi.fn();
    fsm.subscribe(cb);
    fsm.send({ type: 'CONNECT', callId: C1 }); // no-op in connected
    expect(cb).not.toHaveBeenCalled();
    fsm.send({ type: 'HELD', callId: C1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const fsm = at('connected');
    const cb = vi.fn();
    const unsub = fsm.subscribe(cb);
    unsub();
    fsm.send({ type: 'HELD', callId: C1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('a throwing subscriber does not corrupt state or stop others', () => {
    const fsm = at('connected');
    const good = vi.fn();
    fsm.subscribe(() => {
      throw new Error('bad listener');
    });
    fsm.subscribe(good);
    const after = fsm.send({ type: 'HELD', callId: C1 });
    expect(after.state).toBe('held');
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('reset() returns to idle and notifies', () => {
    const fsm = at('connected');
    const cb = vi.fn();
    fsm.subscribe(cb);
    fsm.reset();
    expect(fsm.getSnapshot().state).toBe('idle');
    expect(fsm.getSnapshot().call).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('emits a new snapshot object on change (does not mutate the previous one)', () => {
    const fsm = at('connected');
    const before = fsm.getSnapshot();
    const beforeCall = before.call;
    fsm.send({ type: 'MUTE_CHANGED', callId: C1, muted: true });
    expect(before.call).toBe(beforeCall);
    expect(before.call?.muted).toBe(false); // previous snapshot untouched
    expect(fsm.getSnapshot().call?.muted).toBe(true);
  });
});
