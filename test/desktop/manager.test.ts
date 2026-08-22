import { describe, expect, it } from 'vitest';
import {
  CONTROL_HUB_IDLE_CODE_PATH,
  DesktopStateManager,
  IDLE_CODE_NAME,
} from '../../src/desktop/manager';
import { FakeCallStatus, MockDesktopBackend, flush } from './mocks';

const NCC_ID = 'aux-ncc';

function makeManager(
  backend = new MockDesktopBackend(),
  callStatus = new FakeCallStatus(),
): { manager: DesktopStateManager; backend: MockDesktopBackend; callStatus: FakeCallStatus } {
  const manager = new DesktopStateManager({ backend, callStatus });
  return { manager, backend, callStatus };
}

describe('DesktopStateManager — presence / harness detection', () => {
  it('no-ops gracefully when the desktop SDK is absent (standalone harness)', async () => {
    const { manager, backend, callStatus } = makeManager();
    backend.present = false;

    await manager.start();
    // A call happening in the harness must not touch any desktop API.
    callStatus.push('connected');
    await flush();
    callStatus.push('ended');
    await flush();

    expect(manager.getStatus().present).toBe(false);
    expect(backend.setAgentState).not.toHaveBeenCalled();
    expect(manager.getStatus().idleCodeId).toBeNull();
  });

  it('reports not-present and does not throw when init rejects', async () => {
    const { manager, backend } = makeManager();
    backend.init.mockRejectedValueOnce(new Error('no desktop host'));
    backend.present = true; // even if present would be true, a failed init means harness

    await expect(manager.start()).resolves.toBeUndefined();
    expect(manager.getStatus().present).toBe(false);
  });
});

describe('DesktopStateManager — idle-code resolution (name → id, no hardcoding)', () => {
  it('resolves "Non-Contact Center Call" to its runtime id', async () => {
    const { manager } = makeManager();
    await manager.start();
    expect(manager.getStatus().idleCodeId).toBe(NCC_ID);
    expect(manager.getStatus().configError).toBeNull();
  });

  it('surfaces a config-error banner naming the Control Hub path when the code is absent', async () => {
    const backend = new MockDesktopBackend();
    backend.idleCodes = [{ id: 'x', name: 'Lunch' }]; // no Non-Contact Center Call
    const { manager } = makeManager(backend);

    await manager.start();
    const status = manager.getStatus();
    expect(status.idleCodeId).toBeNull();
    expect(status.configError).toContain(IDLE_CODE_NAME);
    expect(status.configError).toContain(CONTROL_HUB_IDLE_CODE_PATH);
  });
});

describe('DesktopStateManager — set Idle on connected (RONA avoidance)', () => {
  it('captures current state and sets Idle with the resolved aux code on connect', async () => {
    const backend = new MockDesktopBackend();
    backend.currentState = { state: 'Available', auxCodeId: null };
    const { manager, callStatus } = makeManager(backend);
    await manager.start();

    callStatus.push('connected');
    await flush();

    // RONA avoidance: the agent is now Idle('Non-Contact Center Call') so no ACD
    // contact will route to them while on the personal call.
    expect(backend.setAgentState).toHaveBeenCalledTimes(1);
    expect(backend.setAgentState).toHaveBeenCalledWith({ state: 'Idle', auxCodeId: NCC_ID });
    expect(manager.getStatus().idleForcedForCall).toBe(true);
    expect(manager.getStatus().capturedState).toEqual({ state: 'Available', auxCodeId: null });
  });

  it('sets Idle only once across connected → held → connected', async () => {
    const { manager, backend, callStatus } = makeManager();
    await manager.start();

    callStatus.push('connected');
    await flush();
    callStatus.push('held');
    await flush();
    callStatus.push('connected');
    await flush();

    expect(backend.setAgentState).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().idleForcedForCall).toBe(true);
  });

  it('does not set Idle (and keeps the config banner) when the idle code is unresolved', async () => {
    const backend = new MockDesktopBackend();
    backend.idleCodes = [{ id: 'x', name: 'Lunch' }];
    const { manager, callStatus } = makeManager(backend);
    await manager.start();

    callStatus.push('connected');
    await flush();

    expect(backend.setAgentState).not.toHaveBeenCalled();
    expect(backend.logText()).toContain('unresolved');
  });
});

describe('DesktopStateManager — restore on ended', () => {
  it('restores the captured Available state when still in the state we set', async () => {
    const backend = new MockDesktopBackend();
    backend.currentState = { state: 'Available', auxCodeId: null };
    const { manager, callStatus } = makeManager(backend);
    await manager.start();

    callStatus.push('connected');
    await flush();
    // After the set, the mock reports Idle/NCC (i.e. our state is intact).
    expect(backend.getCurrentAgentState()).toEqual({ state: 'Idle', auxCodeId: NCC_ID });

    callStatus.push('ended');
    await flush();

    // Restored to Available with the default aux code.
    expect(backend.setAgentState).toHaveBeenLastCalledWith({ state: 'Available', auxCodeId: '0' });
    expect(manager.getStatus().idleForcedForCall).toBe(false);
    expect(manager.getStatus().capturedState).toBeNull();
  });

  it('restores a captured Idle(other-code) state to Idle with that code', async () => {
    const backend = new MockDesktopBackend();
    backend.currentState = { state: 'Idle', auxCodeId: 'aux-training' };
    const { manager, callStatus } = makeManager(backend);
    await manager.start();

    callStatus.push('connected');
    await flush();
    callStatus.push('ended');
    await flush();

    expect(backend.setAgentState).toHaveBeenLastCalledWith({
      state: 'Idle',
      auxCodeId: 'aux-training',
    });
  });

  it('restore fires on idle after ended too (call cleared)', async () => {
    const { manager, backend, callStatus } = makeManager();
    await manager.start();
    callStatus.push('connected');
    await flush();
    callStatus.push('idle');
    await flush();
    expect(backend.setAgentState).toHaveBeenCalledTimes(2); // set + restore
  });
});

describe('DesktopStateManager — "state changed underneath us" guard', () => {
  it('does NOT restore when the agent changed their state during the call', async () => {
    const backend = new MockDesktopBackend();
    backend.currentState = { state: 'Available', auxCodeId: null };
    const { manager, callStatus } = makeManager(backend);
    await manager.start();

    callStatus.push('connected');
    await flush();
    expect(backend.setAgentState).toHaveBeenCalledTimes(1); // the set-Idle

    // The agent manually flips to a DIFFERENT idle code mid-call.
    backend.currentState = { state: 'Idle', auxCodeId: 'aux-agent-chose' };

    callStatus.push('ended');
    await flush();

    // No restore call — we must not clobber the agent's choice.
    expect(backend.setAgentState).toHaveBeenCalledTimes(1);
    expect(backend.logText()).toContain('changed underneath us');
  });

  it('does NOT restore when an ACD event moved the agent to a non-Idle state', async () => {
    const backend = new MockDesktopBackend();
    backend.currentState = { state: 'Available', auxCodeId: null };
    const { manager, callStatus } = makeManager(backend);
    await manager.start();

    callStatus.push('connected');
    await flush();

    // Simulate the platform moving the agent (e.g. Available/Connected) underneath us.
    backend.currentState = { state: 'Available', auxCodeId: null };

    callStatus.push('ended');
    await flush();

    expect(backend.setAgentState).toHaveBeenCalledTimes(1); // set only, no restore
    expect(backend.logText()).toContain('NOT restoring');
  });

  it('does not restore when the set-Idle itself failed (nothing to restore)', async () => {
    const backend = new MockDesktopBackend();
    backend.setAgentStateImpl = async () => {
      throw new Error('stateChange rejected');
    };
    const { manager, callStatus } = makeManager(backend);
    await manager.start();

    callStatus.push('connected');
    await flush();
    callStatus.push('ended');
    await flush();

    // Only the failed set attempt; no restore attempt.
    expect(backend.setAgentState).toHaveBeenCalledTimes(1);
    expect(backend.logText()).toContain('Failed to set agent Idle');
  });
});

describe('DesktopStateManager — ACD interaction interleaving (no silent auto-answer)', () => {
  it('surfaces a banner and does not auto-answer when an ACD contact is offered mid-call', async () => {
    const { manager, backend, callStatus } = makeManager();
    await manager.start();

    callStatus.push('connected');
    await flush();

    backend.offerAcd(false, 'acd-42');

    const status = manager.getStatus();
    expect(status.acdInterleaveBanner).toBeTruthy();
    expect(status.acdInterleaveBanner).toContain('NOT auto-answered');
    // The module has no answer capability; assert we logged the desktop→call direction.
    expect(backend.logText()).toContain('desktop→call');
    expect(backend.logText()).toContain('did NOT auto-answer');
  });

  it('also handles a RONA-channel offer mid-call as a non-auto-answer banner', async () => {
    const { manager, backend, callStatus } = makeManager();
    await manager.start();
    callStatus.push('connected');
    await flush();

    backend.offerAcd(true, 'acd-rona');
    expect(manager.getStatus().acdInterleaveBanner).toBeTruthy();
    expect(backend.logText()).toContain('rona=true');
  });

  it('does not raise the interleave banner when no personal call is active', async () => {
    const { manager, backend } = makeManager();
    await manager.start();

    backend.offerAcd(false);
    expect(manager.getStatus().acdInterleaveBanner).toBeNull();
    expect(backend.logText()).toContain('no personal call active');
  });

  it('clears the interleave banner when the personal call ends', async () => {
    const { manager, backend, callStatus } = makeManager();
    await manager.start();
    callStatus.push('connected');
    await flush();
    backend.offerAcd(false);
    expect(manager.getStatus().acdInterleaveBanner).toBeTruthy();

    callStatus.push('ended');
    await flush();
    expect(manager.getStatus().acdInterleaveBanner).toBeNull();
  });
});

describe('DesktopStateManager — logs both directions for the demo', () => {
  it('logs call→desktop on set and restore', async () => {
    const { manager, backend, callStatus } = makeManager();
    await manager.start();
    callStatus.push('connected');
    await flush();
    callStatus.push('ended');
    await flush();

    const text = backend.logText();
    expect(text).toContain('call→desktop');
    expect(text).toContain('set agent Idle');
    expect(text).toContain('restored agent state');
  });
});

describe('DesktopStateManager — lifecycle / subscriptions', () => {
  it('notifies status subscribers and stops after dispose', async () => {
    const { manager, backend, callStatus } = makeManager();
    const seen: number[] = [];
    manager.onChange((s) => seen.push(s.idleForcedForCall ? 1 : 0));
    await manager.start();

    callStatus.push('connected');
    await flush();
    expect(seen.some((v) => v === 1)).toBe(true);

    manager.dispose();
    expect(backend.dispose).toHaveBeenCalled();
    const countAfter = seen.length;
    callStatus.push('ended');
    await flush();
    // No further notifications after dispose (unsubscribed).
    expect(seen.length).toBe(countAfter);
  });

  it('reconciles against an already-active call present at start()', async () => {
    const backend = new MockDesktopBackend();
    const callStatus = new FakeCallStatus();
    callStatus.push('connected'); // call already up before the manager starts
    const { manager } = makeManager(backend, callStatus);

    await manager.start();
    await flush();

    expect(backend.setAgentState).toHaveBeenCalledWith({ state: 'Idle', auxCodeId: NCC_ID });
  });
});
