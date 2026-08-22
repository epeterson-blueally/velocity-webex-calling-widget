import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallingController } from '../../src/calling/controller';
import type { CallingControllerOptions } from '../../src/calling/controller';
import { FakeTokenProvider, ManualClock, MockBackend, MockCall, flush } from './mocks';

function makeController(overrides: Partial<CallingControllerOptions> = {}): {
  controller: CallingController;
  backend: MockBackend;
  tokens: FakeTokenProvider;
  clock: ManualClock;
} {
  const backend = (overrides.backend as MockBackend) ?? new MockBackend();
  const tokens = (overrides.tokenProvider as FakeTokenProvider) ?? new FakeTokenProvider();
  const clock = new ManualClock();
  const controller = new CallingController({
    backend,
    tokenProvider: tokens,
    backoff: { baseMs: 1000, maxMs: 8000, maxAttempts: 3 },
    now: () => 1000,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    ...overrides,
  });
  return { controller, backend, tokens, clock };
}

let live: CallingController[] = [];
function track(c: CallingController): CallingController {
  live.push(c);
  return c;
}
afterEach(() => {
  for (const c of live) c.dispose();
  live = [];
});

describe('CallingController — registration lifecycle', () => {
  it('start() inits + registers, and reflects the registered event', async () => {
    const { controller, backend } = makeController();
    track(controller);
    await controller.start();
    expect(backend.init).toHaveBeenCalledTimes(1);
    expect(backend.register).toHaveBeenCalledTimes(1);
    expect(controller.getStatus().registration).toBe('registering');
    backend.emitRegistration('registered');
    expect(controller.getStatus().registration).toBe('registered');
  });

  it('init failure surfaces as failed and does not register', async () => {
    const backend = new MockBackend();
    backend.init.mockRejectedValueOnce(new Error('client boom'));
    const { controller } = makeController({ backend });
    track(controller);
    await controller.start();
    expect(controller.getStatus().registration).toBe('failed');
    expect(backend.register).not.toHaveBeenCalled();
  });

  it('registration failure enters bounded exponential backoff and gives up as failed', async () => {
    const backend = new MockBackend();
    backend.register.mockRejectedValue(new Error('net'));
    const { controller, clock } = makeController({ backend });
    track(controller);
    await controller.start();
    await flush();
    // attempt 1 scheduled
    expect(controller.getStatus().registration).toBe('reconnecting');
    expect(controller.getStatus().reconnectAttempt).toBe(1);
    expect(clock.pending).toBe(1);

    clock.fireNext();
    await flush();
    expect(controller.getStatus().reconnectAttempt).toBe(2);

    clock.fireNext();
    await flush();
    expect(controller.getStatus().reconnectAttempt).toBe(3);

    clock.fireNext();
    await flush();
    // maxAttempts (3) reached → failed, attempts reset.
    expect(controller.getStatus().registration).toBe('failed');
    expect(controller.getStatus().reconnectAttempt).toBe(0);
    expect(backend.register).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('a socket drop (unregistered while registered) triggers reconnect with backoff', async () => {
    const { controller, backend, clock } = makeController();
    track(controller);
    await controller.start();
    backend.emitRegistration('registered');
    expect(controller.getStatus().registration).toBe('registered');

    backend.register.mockRejectedValue(new Error('still down'));
    backend.emitRegistration('unregistered', 'socket dropped');
    expect(controller.getStatus().registration).toBe('reconnecting');
    expect(clock.pending).toBe(1);
  });

  it('a fresh token re-registers and resets backoff', async () => {
    const { controller, backend, tokens } = makeController();
    track(controller);
    await controller.start();
    backend.emitRegistration('registered');
    expect(backend.register).toHaveBeenCalledTimes(1);

    tokens.pushToken('tok-2');
    await flush();
    expect(backend.register).toHaveBeenCalledTimes(2);
    expect(controller.getStatus().reconnectAttempt).toBe(0);
  });

  it('mirrors auth status changes into the exposed status', async () => {
    const { controller, tokens } = makeController();
    track(controller);
    await controller.start();
    tokens.pushStatus({ status: 'refreshing' });
    expect(controller.getStatus().auth.status).toBe('refreshing');
  });
});

describe('CallingController — outbound dial', () => {
  it('dial creates a call, moves the FSM to dialing, and calls dial()', async () => {
    const { controller, backend } = makeController();
    track(controller);
    await controller.start();
    await controller.dial('+15551234');
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('dialing');
    const call = [...backend.calls.values()][0];
    expect(call.dial).toHaveBeenCalledTimes(1);
    // SDK events then drive the rest.
    backend.emitCall({ type: 'ESTABLISHED', callId: call.id });
    expect(controller.getCallSnapshot().state).toBe('connected');
  });

  it('makeCall rejection surfaces as an action error without moving the FSM', async () => {
    const backend = new MockBackend();
    backend.makeCallImpl = () => Promise.reject(new Error('no line'));
    const { controller } = makeController({ backend });
    track(controller);
    await controller.start();
    await controller.dial('+1');
    expect(controller.getCallSnapshot().state).toBe('idle');
    expect(controller.getStatus().lastActionError).toMatch(/no line/);
  });

  it('dial() rejection maps to a CALL_ERROR ending the call', async () => {
    const { controller, backend } = makeController();
    track(controller);
    await controller.start();
    // Make the produced call's dial reject.
    backend.makeCallImpl = () => {
      const call = new MockCall('out-x', 'outbound');
      call.dial.mockRejectedValueOnce(new Error('media fail'));
      backend.calls.set('out-x', call);
      return Promise.resolve(call);
    };
    await controller.dial('+1');
    await flush();
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('ended');
    expect(snap.lastError?.kind).toBe('setup');
  });
});

describe('CallingController — inbound answer / decline', () => {
  it('answer() answers the ringing call and connects on established', async () => {
    const { controller, backend } = makeController();
    track(controller);
    await controller.start();
    const call = backend.emitIncoming('in-1', { num: '+1777' });
    expect(controller.getCallSnapshot().state).toBe('ringing_in');
    await controller.answer();
    expect(call.answer).toHaveBeenCalledTimes(1);
    expect(controller.getCallSnapshot().state).toBe('connecting');
    backend.emitCall({ type: 'ESTABLISHED', callId: 'in-1' });
    expect(controller.getCallSnapshot().state).toBe('connected');
  });

  it('decline() ends the ringing call', async () => {
    const { controller, backend } = makeController();
    track(controller);
    await controller.start();
    const call = backend.emitIncoming('in-2');
    await controller.decline();
    expect(call.end).toHaveBeenCalledTimes(1);
    backend.emitCall({ type: 'DISCONNECT', callId: 'in-2' });
    expect(controller.getCallSnapshot().state).toBe('ended');
  });

  it('answer failure maps to a CALL_ERROR', async () => {
    const { controller, backend } = makeController();
    track(controller);
    await controller.start();
    const call = backend.emitIncoming('in-3');
    call.answer.mockRejectedValueOnce(new Error('answer boom'));
    await controller.answer();
    await flush();
    expect(controller.getCallSnapshot().state).toBe('ended');
    expect(controller.getCallSnapshot().lastError?.message).toMatch(/answer boom/i);
  });
});

describe('CallingController — in-call controls', () => {
  async function connected(): Promise<{ controller: CallingController; backend: MockBackend; callId: string }> {
    const { controller, backend } = makeController();
    track(controller);
    await controller.start();
    await controller.dial('+1');
    const call = [...backend.calls.values()][0];
    backend.emitCall({ type: 'ESTABLISHED', callId: call.id });
    return { controller, backend, callId: call.id };
  }

  it('hold() → held on the SDK held event; resume() → connected on resumed', async () => {
    const { controller, backend, callId } = await connected();
    await controller.hold();
    expect(backend.getCall(callId)?.hold).toBeDefined();
    backend.emitCall({ type: 'HELD', callId });
    expect(controller.getCallSnapshot().state).toBe('held');
    await controller.resume();
    backend.emitCall({ type: 'RESUMED', callId });
    expect(controller.getCallSnapshot().state).toBe('connected');
  });

  it('hold() rejection maps to HOLD_ERROR and stays connected', async () => {
    const { controller, backend, callId } = await connected();
    (backend.getCall(callId) as import('./mocks').MockCall).hold.mockRejectedValueOnce(new Error('hold fail'));
    await controller.hold();
    await flush();
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.lastError?.kind).toBe('hold');
  });

  it('mute()/unmute() reflect MUTE_CHANGED into the FSM', async () => {
    const { controller, callId } = await connected();
    void callId;
    await controller.mute();
    expect(controller.getCallSnapshot().call?.muted).toBe(true);
    await controller.unmute();
    expect(controller.getCallSnapshot().call?.muted).toBe(false);
  });

  it('mute() failure is non-fatal (action error, call stays up)', async () => {
    const { controller, backend, callId } = await connected();
    (backend.getCall(callId) as import('./mocks').MockCall).muteFn.mockRejectedValueOnce(new Error('mute fail'));
    await controller.mute();
    expect(controller.getCallSnapshot().state).toBe('connected');
    expect(controller.getStatus().lastActionError).toMatch(/mute fail/i);
  });

  it('sendDigit() forwards to the call', async () => {
    const { controller, backend, callId } = await connected();
    await controller.sendDigit('5');
    expect((backend.getCall(callId) as import('./mocks').MockCall).sendDigit).toHaveBeenCalledWith('5');
  });

  it('end() hangs up; force-disconnects the FSM if end() rejects', async () => {
    const { controller, backend, callId } = await connected();
    (backend.getCall(callId) as import('./mocks').MockCall).end.mockRejectedValueOnce(new Error('end fail'));
    await controller.end();
    await flush();
    expect(controller.getCallSnapshot().state).toBe('ended');
    expect(controller.getStatus().lastActionError).toMatch(/end/i);
  });

  it('actions are no-ops when there is no matching call/state', async () => {
    const { controller } = makeController();
    track(controller);
    await controller.start();
    await controller.hold();
    await controller.mute();
    await controller.sendDigit('1');
    await controller.end();
    expect(controller.getCallSnapshot().state).toBe('idle');
  });
});

describe('CallingController — second inbound', () => {
  async function connectedWithPending() {
    const { controller, backend } = makeController();
    track(controller);
    await controller.start();
    await controller.dial('+1');
    const primary = [...backend.calls.values()][0];
    backend.emitCall({ type: 'ESTABLISHED', callId: primary.id });
    const second = backend.emitIncoming('in-2nd', { num: '+1222' });
    return { controller, backend, primary, second };
  }

  it('a second inbound during a call is offered as pending', async () => {
    const { controller } = await connectedWithPending();
    expect(controller.getCallSnapshot().pendingInbound?.callId).toBe('in-2nd');
  });

  it('answerSecond() holds the primary and answers the second', async () => {
    const { controller, primary, second } = await connectedWithPending();
    await controller.answerSecond();
    await flush();
    expect(primary.hold).toHaveBeenCalledTimes(1);
    expect(second.answer).toHaveBeenCalledTimes(1);
    const snap = controller.getCallSnapshot();
    expect(snap.call?.callId).toBe('in-2nd');
    expect(snap.heldCall?.callId).toBe(primary.id);
  });

  it('declineSecond() ends the pending inbound', async () => {
    const { controller, backend, second } = await connectedWithPending();
    await controller.declineSecond();
    expect(second.end).toHaveBeenCalledTimes(1);
    backend.emitCall({ type: 'DISCONNECT', callId: 'in-2nd' });
    expect(controller.getCallSnapshot().pendingInbound).toBeNull();
    expect(controller.getCallSnapshot().state).toBe('connected');
  });
});

describe('CallingController — blind transfer', () => {
  async function connected() {
    const { controller, backend } = makeController();
    track(controller);
    await controller.start();
    await controller.dial('+1');
    const call = [...backend.calls.values()][0];
    backend.emitCall({ type: 'ESTABLISHED', callId: call.id });
    return { controller, backend, call };
  }

  it('blindTransfer from connected calls the SDK; the SDK disconnect ends the call', async () => {
    const { controller, backend, call } = await connected();
    await controller.blindTransfer('+15559999');
    expect(call.blindTransfer).toHaveBeenCalledWith('+15559999');
    expect(controller.getCallSnapshot().state).toBe('connected'); // ends on the event
    backend.emitCall({ type: 'DISCONNECT', callId: call.id, reason: 'Call transferred.' });
    expect(controller.getCallSnapshot().state).toBe('ended');
  });

  it('blindTransfer works from held', async () => {
    const { controller, backend, call } = await connected();
    await controller.hold();
    backend.emitCall({ type: 'HELD', callId: call.id });
    expect(controller.getCallSnapshot().state).toBe('held');
    await controller.blindTransfer('+15559999');
    expect(call.blindTransfer).toHaveBeenCalledWith('+15559999');
  });

  it('an empty destination is rejected with an action error, no SDK call', async () => {
    const { controller, call } = await connected();
    await controller.blindTransfer('   ');
    expect(call.blindTransfer).not.toHaveBeenCalled();
    expect(controller.getStatus().lastActionError).toMatch(/destination/i);
  });

  it('a blindTransfer rejection surfaces TRANSFER_ERROR and keeps the call up', async () => {
    const { controller, call } = await connected();
    call.blindTransfer.mockRejectedValueOnce(new Error('sip 404'));
    await controller.blindTransfer('+1');
    await flush();
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.lastError?.kind).toBe('transfer');
    expect(snap.lastError?.message).toMatch(/sip 404/i);
  });

  it('blindTransfer is a no-op when there is no active call', async () => {
    const { controller } = makeController();
    track(controller);
    await controller.start();
    await controller.blindTransfer('+1');
    expect(controller.getCallSnapshot().state).toBe('idle');
  });
});

describe('CallingController — consult transfer', () => {
  /** Get a controller with a connected primary; returns helpers to drive the consult. */
  async function withPrimary() {
    const { controller, backend } = makeController();
    track(controller);
    await controller.start();
    await controller.dial('+15550000'); // primary
    const primary = [...backend.calls.values()][0] as MockCall;
    backend.emitCall({ type: 'ESTABLISHED', callId: primary.id });
    return { controller, backend, primary };
  }

  /** Start a consult and return the created consult-leg MockCall. */
  async function startConsult(controller: CallingController, backend: MockBackend, primary: MockCall) {
    await controller.startConsult('+15551111');
    await flush();
    const consult = [...backend.calls.values()].find((c) => c !== primary) as MockCall;
    return consult;
  }

  it('startConsult holds the primary, creates + dials the consult leg, enters consulting', async () => {
    const { controller, backend, primary } = await withPrimary();
    const consult = await startConsult(controller, backend, primary);
    expect(primary.hold).toHaveBeenCalledTimes(1);
    expect(consult.dial).toHaveBeenCalledTimes(1);
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('consulting');
    expect(snap.consult?.primary.callId).toBe(primary.id);
    expect(snap.consult?.consult.callId).toBe(consult.id);
  });

  it('an empty consult destination is rejected with an action error', async () => {
    const { controller } = await withPrimary();
    await controller.startConsult('');
    expect(controller.getCallSnapshot().state).toBe('connected');
    expect(controller.getStatus().lastActionError).toMatch(/destination/i);
  });

  it('completeConsult (JOIN) joins the legs on the primary and ends → ended', async () => {
    const { controller, backend, primary } = await withPrimary();
    const consult = await startConsult(controller, backend, primary);
    backend.emitCall({ type: 'ESTABLISHED', callId: consult.id }); // talk
    await controller.completeConsult();
    await flush();
    expect(primary.consultTransfer).toHaveBeenCalledWith(consult.id);
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('ended');
    expect(snap.endReason).toBe('Transferred.');
  });

  it('cancelConsult (RESUME PRIMARY) ends the consult leg and resumes the primary', async () => {
    const { controller, backend, primary } = await withPrimary();
    const consult = await startConsult(controller, backend, primary);
    backend.emitCall({ type: 'ESTABLISHED', callId: consult.id });
    await controller.cancelConsult();
    await flush();
    expect(consult.end).toHaveBeenCalledTimes(1);
    expect(primary.resume).toHaveBeenCalledTimes(1);
    // CONSULT_CANCELLED → held(primary); primary.resume() → RESUMED → connected.
    backend.emitCall({ type: 'RESUMED', callId: primary.id });
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.call?.callId).toBe(primary.id);
  });

  // --- FAILURE (a): consult leg fails/errors on dial ---
  it('(a) a consult leg that errors on dial falls back to the held primary + surfaces error', async () => {
    const { controller, backend, primary } = await withPrimary();
    // Next makeCall returns a call whose dial rejects.
    backend.makeCallImpl = () => {
      const bad = new MockCall('consult-bad', 'outbound');
      bad.dial.mockRejectedValueOnce(new Error('media negotiation failed'));
      backend.calls.set('consult-bad', bad);
      return Promise.resolve(bad);
    };
    await controller.startConsult('+15551111');
    await flush();
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('held'); // fell back to the held primary
    expect(snap.call?.callId).toBe(primary.id);
    expect(snap.consult).toBeNull();
    expect(snap.lastError?.kind).toBe('setup');
  });

  it('(a-variant) makeCall failing to create the consult leg leaves the primary connected', async () => {
    const { controller, backend, primary } = await withPrimary();
    backend.makeCallImpl = () => Promise.reject(new Error('no second line'));
    await controller.startConsult('+15551111');
    await flush();
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('connected'); // never entered consulting
    expect(snap.call?.callId).toBe(primary.id);
    expect(primary.hold).not.toHaveBeenCalled(); // primary untouched
    expect(controller.getStatus().lastActionError).toMatch(/consult call/i);
  });

  it('(a-variant) a hold failure discards the consult leg and stays connected', async () => {
    const { controller, backend, primary } = await withPrimary();
    primary.hold.mockRejectedValueOnce(new Error('hold refused'));
    const consult = await startConsult(controller, backend, primary);
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.lastError?.kind).toBe('hold');
    expect(consult.end).toHaveBeenCalledTimes(1); // the created leg was discarded
    expect(consult.dial).not.toHaveBeenCalled();
  });

  // --- FAILURE (b): consult target declines / never answers ---
  it('(b) the consult target declining (leg DISCONNECT) returns to the held primary', async () => {
    const { controller, backend, primary } = await withPrimary();
    const consult = await startConsult(controller, backend, primary);
    backend.emitCall({ type: 'CONNECT', callId: consult.id }); // ringing
    backend.emitCall({ type: 'DISCONNECT', callId: consult.id, reason: 'User Busy.' });
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('held');
    expect(snap.call?.callId).toBe(primary.id);
    expect(snap.consult).toBeNull();
  });

  // --- FAILURE (c): primary's far end hangs up mid-consult ---
  it('(c) the PRIMARY far end hanging up mid-consult promotes the consult leg to foreground', async () => {
    const { controller, backend, primary } = await withPrimary();
    const consult = await startConsult(controller, backend, primary);
    backend.emitCall({ type: 'ESTABLISHED', callId: consult.id }); // talking to consultee
    backend.emitCall({ type: 'DISCONNECT', callId: primary.id, reason: 'Remote Hangup.' });
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.call?.callId).toBe(consult.id); // agent keeps talking to the target
    expect(snap.consult).toBeNull();
    expect(snap.lastError?.kind).toBe('transfer');
    expect(snap.lastError?.message).toMatch(/original caller hung up/i);
    // The now-foreground consult call can then be ended normally.
    await controller.end();
    expect(consult.end).toHaveBeenCalledTimes(1);
  });

  it('DISCONNECT on the consult leg vs the primary leg are handled distinctly', async () => {
    // leg disconnect → back to primary (held); primary disconnect → promote leg.
    {
      const { controller, backend, primary } = await withPrimary();
      const consult = await startConsult(controller, backend, primary);
      backend.emitCall({ type: 'ESTABLISHED', callId: consult.id });
      backend.emitCall({ type: 'DISCONNECT', callId: consult.id });
      expect(controller.getCallSnapshot().call?.callId).toBe(primary.id);
    }
    {
      const { controller, backend, primary } = await withPrimary();
      const consult = await startConsult(controller, backend, primary);
      backend.emitCall({ type: 'ESTABLISHED', callId: consult.id });
      backend.emitCall({ type: 'DISCONNECT', callId: primary.id });
      expect(controller.getCallSnapshot().call?.callId).toBe(consult.id);
    }
  });

  it('a completeConsult rejection stays in consulting and surfaces the error', async () => {
    const { controller, backend, primary } = await withPrimary();
    const consult = await startConsult(controller, backend, primary);
    backend.emitCall({ type: 'ESTABLISHED', callId: consult.id });
    primary.consultTransfer.mockRejectedValueOnce(new Error('transfer rejected'));
    await controller.completeConsult();
    await flush();
    const snap = controller.getCallSnapshot();
    expect(snap.state).toBe('consulting');
    expect(snap.lastError?.kind).toBe('transfer');
    expect(snap.lastError?.message).toMatch(/transfer rejected/i);
  });

  it('completeConsult / cancelConsult are no-ops when not consulting', async () => {
    const { controller, primary } = await withPrimary();
    await controller.completeConsult();
    await controller.cancelConsult();
    expect(primary.consultTransfer).not.toHaveBeenCalled();
    expect(controller.getCallSnapshot().state).toBe('connected');
  });
});

describe('CallingController — status subscription + dispose', () => {
  it('onChange fires on registration and call changes', async () => {
    const { controller, backend } = makeController();
    track(controller);
    const cb = vi.fn();
    controller.onChange(cb);
    await controller.start();
    backend.emitRegistration('registered');
    expect(cb).toHaveBeenCalled();
  });

  it('dispose() tears down subscriptions and disposes the backend', async () => {
    const { controller, backend, tokens } = makeController();
    await controller.start();
    controller.dispose();
    expect(backend.dispose).toHaveBeenCalledTimes(1);
    // A post-dispose token push does not re-register.
    const before = backend.register.mock.calls.length;
    tokens.pushToken('tok-late');
    await flush();
    expect(backend.register.mock.calls.length).toBe(before);
  });
});
