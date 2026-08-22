import { vi } from 'vitest';
import type { AuthState, TokenProvider, Unsubscribe } from '../../src/auth/types';
import type {
  BackendCall,
  BackendCallEvent,
  BackendEvent,
  CallingBackend,
  RegistrationStatus,
} from '../../src/calling/backend';
import type { CallDirection, CallerId } from '../../src/state/types';

/** A scriptable BackendCall test double. Every SDK-ish method is a spy. */
export class MockCall implements BackendCall {
  readonly id: string;
  readonly direction: CallDirection;
  private muted = false;
  private held = false;
  private callerId: CallerId | null;

  dial = vi.fn(async () => {});
  answer = vi.fn(async () => {});
  hold = vi.fn(async () => {
    this.held = true;
  });
  resume = vi.fn(async () => {
    this.held = false;
  });
  muteFn = vi.fn(async () => {
    this.muted = true;
    return this.muted;
  });
  unmuteFn = vi.fn(async () => {
    this.muted = false;
    return this.muted;
  });
  sendDigit = vi.fn(async (_tone: string) => {});
  end = vi.fn(async () => {});

  constructor(id: string, direction: CallDirection, callerId: CallerId | null = null) {
    this.id = id;
    this.direction = direction;
    this.callerId = callerId;
  }

  mute(): Promise<boolean> {
    return this.muteFn();
  }
  unmute(): Promise<boolean> {
    return this.unmuteFn();
  }
  isMuted(): boolean {
    return this.muted;
  }
  isHeld(): boolean {
    return this.held;
  }
  getCallerId(): CallerId | null {
    return this.callerId;
  }
}

/** A scriptable CallingBackend. Tests drive events via `emit`. */
export class MockBackend implements CallingBackend {
  init = vi.fn(async () => {});
  register = vi.fn(async () => {});
  deregister = vi.fn(async () => {});
  dispose = vi.fn(() => {});

  private status: RegistrationStatus = 'unregistered';
  private listeners = new Set<(e: BackendEvent) => void>();
  readonly calls = new Map<string, MockCall>();
  /** Optional override so a test can make makeCall reject or return a preset call. */
  makeCallImpl: ((address: string) => Promise<BackendCall>) | null = null;
  private seq = 0;

  getRegistrationStatus(): RegistrationStatus {
    return this.status;
  }

  makeCall(address: string): Promise<BackendCall> {
    if (this.makeCallImpl) return this.makeCallImpl(address);
    const id = `out-${++this.seq}`;
    const call = new MockCall(id, 'outbound');
    this.calls.set(id, call);
    return Promise.resolve(call);
  }

  getCall(callId: string): BackendCall | undefined {
    return this.calls.get(callId);
  }

  onEvent(cb: (e: BackendEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // --- test helpers ---
  emit(e: BackendEvent): void {
    if (e.kind === 'registration') this.status = e.status;
    for (const cb of [...this.listeners]) cb(e);
  }

  emitCall(event: BackendCallEvent): void {
    this.emit({ kind: 'call', event });
  }

  emitRegistration(status: RegistrationStatus, detail?: string): void {
    this.emit({ kind: 'registration', status, detail });
  }

  /** Simulate an inbound call arriving. Registers a MockCall the controller can answer. */
  emitIncoming(id: string, callerId?: CallerId): MockCall {
    const call = new MockCall(id, 'inbound', callerId ?? null);
    this.calls.set(id, call);
    this.emitCall({ type: 'INCOMING', callId: id, callerId });
    return call;
  }
}

/** A minimal TokenProvider double. */
export class FakeTokenProvider implements TokenProvider {
  private token: string;
  private status: AuthState = { status: 'authenticated' };
  private tokenCbs = new Set<(t: string) => void>();
  private statusCbs = new Set<(s: AuthState) => void>();
  getTokenImpl: (() => Promise<string>) | null = null;

  constructor(token = 'tok-1') {
    this.token = token;
  }

  getToken(): Promise<string> {
    if (this.getTokenImpl) return this.getTokenImpl();
    return Promise.resolve(this.token);
  }
  refresh(): Promise<string> {
    return this.getToken();
  }
  signIn(): Promise<void> {
    return Promise.resolve();
  }
  getExpiry(): number | null {
    return null;
  }
  onTokenChange(cb: (t: string) => void): Unsubscribe {
    this.tokenCbs.add(cb);
    return () => this.tokenCbs.delete(cb);
  }
  onStatusChange(cb: (s: AuthState) => void): Unsubscribe {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }
  getStatus(): AuthState {
    return this.status;
  }
  dispose(): void {}

  // --- test helpers ---
  pushToken(t: string): void {
    this.token = t;
    for (const cb of [...this.tokenCbs]) cb(t);
  }
  pushStatus(s: AuthState): void {
    this.status = s;
    for (const cb of [...this.statusCbs]) cb(s);
  }
}

/** A manual timer harness for deterministic backoff tests. */
export class ManualClock {
  private handles: Array<{ id: number; cb: () => void }> = [];
  private nextId = 1;

  setTimeout = (cb: () => void, _ms: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.handles.push({ id, cb });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    const id = handle as unknown as number;
    this.handles = this.handles.filter((h) => h.id !== id);
  };

  get pending(): number {
    return this.handles.length;
  }

  /** Fire the oldest pending timer (FIFO). */
  fireNext(): void {
    const h = this.handles.shift();
    if (h) h.cb();
  }
}

/** Flush pending microtasks so awaited chains settle. */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
