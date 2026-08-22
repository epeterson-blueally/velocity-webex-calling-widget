import { vi } from 'vitest';
import type {
  AcdInteraction,
  AgentStateSnapshot,
  AgentStateTarget,
  DesktopBackend,
  IdleCode,
  LogDirection,
  Unsubscribe,
} from '../../src/desktop/backend';
import type { CallStatusSource } from '../../src/desktop/manager';
import type { CallSnapshot, CallState } from '../../src/state/types';

/** A scriptable DesktopBackend test double. */
export class MockDesktopBackend implements DesktopBackend {
  present = true;
  idleCodes: IdleCode[] = [
    { id: 'aux-ncc', name: 'Non-Contact Center Call' },
    { id: 'aux-lunch', name: 'Lunch', isDefault: true },
  ];
  /** The state getCurrentAgentState() reports; tests mutate this to simulate changes. */
  currentState: AgentStateSnapshot = { state: 'Available', auxCodeId: null };

  /** Optional overrides so a test can make a call reject. */
  getIdleCodesImpl: (() => Promise<IdleCode[]>) | null = null;
  setAgentStateImpl: ((t: AgentStateTarget) => Promise<void>) | null = null;

  init = vi.fn(async () => {});
  setAgentState = vi.fn(async (target: AgentStateTarget) => {
    if (this.setAgentStateImpl) return this.setAgentStateImpl(target);
    // Default: applying the state also updates what getCurrentAgentState reports,
    // so a subsequent read reflects the change (unless a test overrides currentState).
    this.currentState = { state: target.state, auxCodeId: target.auxCodeId };
  });
  log = vi.fn((_direction: LogDirection, _message: string) => {});
  dispose = vi.fn(() => {});

  private offerCbs = new Set<(i: AcdInteraction) => void>();

  isPresent(): boolean {
    return this.present;
  }
  getIdleCodes(): Promise<IdleCode[]> {
    if (this.getIdleCodesImpl) return this.getIdleCodesImpl();
    return Promise.resolve(this.idleCodes);
  }
  getCurrentAgentState(): AgentStateSnapshot {
    return this.currentState;
  }
  onAcdInteractionOffered(cb: (i: AcdInteraction) => void): Unsubscribe {
    this.offerCbs.add(cb);
    return () => this.offerCbs.delete(cb);
  }

  // --- test helpers ---
  /** Fire an ACD interaction offer at the manager. */
  offerAcd(isRona = false, interactionId = 'acd-1'): void {
    for (const cb of [...this.offerCbs]) cb({ interactionId, isRona });
  }
  /** The set of log messages, joined, for easy assertions. */
  logText(): string {
    return this.log.mock.calls.map((c) => `${c[0]} ${c[1]}`).join('\n');
  }
}

/** A fake CallStatusSource the test drives by pushing call snapshots. */
export class FakeCallStatus implements CallStatusSource {
  private snapshot: CallSnapshot = emptySnapshot('idle');
  private listeners = new Set<(s: { call: CallSnapshot }) => void>();

  getStatus(): { call: CallSnapshot } {
    return { call: this.snapshot };
  }
  onChange(cb: (status: { call: CallSnapshot }) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // --- test helpers ---
  /** Push a new call state and notify subscribers. */
  push(state: CallState): void {
    this.snapshot = state === 'idle' || state === 'ended' ? emptySnapshot(state) : activeSnapshot(state);
    for (const cb of [...this.listeners]) cb({ call: this.snapshot });
  }
}

function emptySnapshot(state: CallState): CallSnapshot {
  return {
    state,
    call: null,
    heldCall: null,
    pendingInbound: null,
    consult: null,
    lastError: null,
    endReason: null,
  };
}

function activeSnapshot(state: CallState): CallSnapshot {
  return {
    state,
    call: {
      callId: 'call-1',
      direction: 'outbound',
      callerId: { num: '+15551234567' },
      muted: false,
      connectedAt: state === 'connected' ? 1_000 : null,
      hasRemoteMedia: true,
    },
    heldCall: null,
    pendingInbound: null,
    consult: null,
    lastError: null,
    endReason: null,
  };
}

/** Flush pending microtasks so awaited chains settle. */
export async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
