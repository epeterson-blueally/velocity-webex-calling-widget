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
