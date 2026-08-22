/**
 * WebexCallingBackend — the ONLY module that imports @webex/calling.
 *
 * It implements the CallingBackend seam by wiring a live ILine / ICall onto the
 * normalized backend event channel the controller consumes. All method signatures
 * here were verified against the shipped 3.12.0 type declarations (see
 * DISCOVERY.md §5 and node_modules/@webex/calling/dist/types), not the plan prose:
 *   - ILine.register(): void  (completion arrives via the 'registered' event, NOT a
 *     resolved promise) — so register() below resolves once the request is issued.
 *   - ILine.makeCall(dest?): ICall | undefined
 *   - ICall.dial/answer(localAudioStream): void   (sync; media negotiated via events)
 *   - ICall.doHoldResume(): void   (a TOGGLE — no boolean)
 *   - ICall.mute(stream, MUTE_TYPE?): void   (no unmute(); see MuteAdapter)
 *   - ICall.sendDigit(tone): void, end(): void
 *
 * The webex core instance and matching mic-stream factory are INJECTED (see
 * bootstrap.ts) so this class stays independent of how the client was constructed
 * (bundled createClient vs the CDN UMD used by the smoke-test harness), and so the
 * mic stream always originates from the same module instance as the calling client
 * (mixing instances breaks the SDK's internal type checks).
 */

import {
  CALL_EVENT_KEYS,
  CallType,
  LINE_EVENTS,
  TransferType,
  createMicrophoneStream as bundledCreateMicrophoneStream,
} from '@webex/calling';
import type {
  CallerIdDisplay,
  ICall,
  ICallingClient,
  ILine,
  LocalMicrophoneStream,
} from '@webex/calling';
import type { CallError } from '@webex/calling';
import type { CallDirection, CallErrorInfo, CallerId, Unsubscribe } from '../state/types';
import type { BackendCall, BackendEvent, CallingBackend, RegistrationStatus } from './backend';
import { MuteAdapter } from './mute-adapter';

/** Factory that yields a mic stream from the SAME SDK instance as the client. */
export type MicStreamFactory = () => Promise<LocalMicrophoneStream>;

export interface WebexCallingBackendDeps {
  /** A ready ICallingClient (its 'ready' handled by the bootstrap). */
  callingClient: ICallingClient;
  /** Mic-stream factory paired with `callingClient`. Defaults to the bundled one. */
  createMicrophoneStream?: MicStreamFactory;
  /** Pick a specific line; defaults to the first line from getLines(). */
  lineId?: string;
  /**
   * Optional sink for remote audio. On the SDK's remote_media event the incoming
   * MediaStreamTrack is attached here so the agent hears the far end. Media routing
   * is intentionally kept OUT of the FSM/CallEvent path (the FSM only tracks the
   * boolean hasRemoteMedia); the element/consumer owns the actual <audio> sink.
   */
  remoteAudioElement?: HTMLMediaElement;
}

export class WebexCallingBackend implements CallingBackend {
  private readonly client: ICallingClient;
  private readonly createMic: MicStreamFactory;
  private readonly preferredLineId?: string;
  private readonly remoteAudio?: HTMLMediaElement;

  private line: ILine | null = null;
  private status: RegistrationStatus = 'unregistered';
  private readonly calls = new Map<string, WebexBackendCall>();
  private listeners = new Set<(e: BackendEvent) => void>();
  private disposed = false;

  constructor(deps: WebexCallingBackendDeps) {
    this.client = deps.callingClient;
    this.createMic = deps.createMicrophoneStream ?? (bundledCreateMicrophoneStream as MicStreamFactory);
    this.preferredLineId = deps.lineId;
    this.remoteAudio = deps.remoteAudioElement;
  }

  init(): Promise<void> {
    // The calling client is created + made ready by the bootstrap; here we just
    // resolve the line and attach its lifecycle listeners.
    const lines = this.client.getLines();
    const line = this.preferredLineId ? lines[this.preferredLineId] : Object.values(lines)[0];
    if (!line) {
      return Promise.reject(new Error('No Webex Calling line is provisioned on this account.'));
    }
    this.line = line;
    this.attachLineListeners(line);
    return Promise.resolve();
  }

  register(): Promise<void> {
    if (!this.line) return Promise.reject(new Error('Backend not initialized.'));
    this.setStatus('registering');
    try {
      this.line.register();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.resolve();
  }

  deregister(): Promise<void> {
    if (!this.line) return Promise.resolve();
    try {
      this.line.deregister();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.resolve();
  }

  getRegistrationStatus(): RegistrationStatus {
    return this.status;
  }

  makeCall(address: string): Promise<BackendCall> {
    if (!this.line) return Promise.reject(new Error('Backend not initialized.'));
    const type = address.includes('@') ? CallType.URI : CallType.TEL;
    const sdkCall = this.line.makeCall({ type, address });
    if (!sdkCall) {
      return Promise.reject(new Error('SDK returned no call object for makeCall().'));
    }
    const wrapped = this.wrapCall(sdkCall);
    return Promise.resolve(wrapped);
  }

  getCall(callId: string): BackendCall | undefined {
    return this.calls.get(callId);
  }

  onEvent(cb: (event: BackendEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const call of this.calls.values()) call.teardown();
    this.calls.clear();
    this.listeners.clear();
    this.line = null;
  }

  // --- internals -------------------------------------------------------------

  private emit(event: BackendEvent): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  private setStatus(status: RegistrationStatus, detail?: string): void {
    this.status = status;
    this.emit({ kind: 'registration', status, detail });
  }

  private routeRemoteAudio(track: MediaStreamTrack): void {
    if (!this.remoteAudio) return;
    try {
      this.remoteAudio.srcObject = new MediaStream([track]);
    } catch {
      // Best-effort: media routing failure must not break call control.
    }
  }

  private attachLineListeners(line: ILine): void {
    line.on(LINE_EVENTS.REGISTERED, () => this.setStatus('registered'));
    line.on(LINE_EVENTS.UNREGISTERED, () => this.setStatus('unregistered'));
    line.on(LINE_EVENTS.RECONNECTING, () => this.setStatus('reconnecting'));
    line.on(LINE_EVENTS.RECONNECTED, () => this.setStatus('registered'));
    line.on(LINE_EVENTS.ERROR, (err) => this.setStatus('failed', err?.message));
    line.on(LINE_EVENTS.INCOMING_CALL, (sdkCall: ICall) => {
      const wrapped = this.wrapCall(sdkCall);
      this.emit({
        kind: 'call',
        event: { type: 'INCOMING', callId: wrapped.id, callerId: wrapped.getCallerId() ?? undefined },
      });
    });
  }

  private wrapCall(sdkCall: ICall): WebexBackendCall {
    const existing = this.calls.get(sdkCall.getCallId());
    if (existing) return existing;
    const wrapped = new WebexBackendCall(
      sdkCall,
      this.createMic,
      (e) => this.emit(e),
      (id) => this.calls.delete(id),
      (track) => this.routeRemoteAudio(track),
    );
    this.calls.set(wrapped.id, wrapped);
    return wrapped;
  }
}

/** Wraps one live ICall, mapping its events + errors to the backend channel. */
class WebexBackendCall implements BackendCall {
  readonly id: string;
  readonly direction: CallDirection;

  private readonly sdk: ICall;
  private readonly createMic: MicStreamFactory;
  private readonly emit: (e: BackendEvent) => void;
  private readonly onGone: (id: string) => void;
  private readonly onRemoteTrack: (track: MediaStreamTrack) => void;
  private readonly mute0: MuteAdapter;
  private micStream: LocalMicrophoneStream | null = null;
  private callerId: CallerId | null;

  constructor(
    sdk: ICall,
    createMic: MicStreamFactory,
    emit: (e: BackendEvent) => void,
    onGone: (id: string) => void,
    onRemoteTrack: (track: MediaStreamTrack) => void,
  ) {
    this.sdk = sdk;
    this.createMic = createMic;
    this.emit = emit;
    this.onGone = onGone;
    this.onRemoteTrack = onRemoteTrack;
    this.id = sdk.getCallId();
    this.direction = sdk.getDirection() as CallDirection;
    this.callerId = toCallerId(sdk);
    this.mute0 = new MuteAdapter({
      isMuted: () => this.sdk.isMuted(),
      muteOnce: () => {
        // muteType defaults to USER; ICall.mute() takes the same stream used to
        // dial/answer (not a boolean). See DISCOVERY.md §5.
        if (this.micStream) this.sdk.mute(this.micStream);
      },
    });
    this.attach();
  }

  async dial(): Promise<void> {
    this.micStream = await this.captureMic();
    this.sdk.dial(this.micStream);
  }

  async answer(): Promise<void> {
    this.micStream = await this.captureMic();
    this.sdk.answer(this.micStream);
  }

  hold(): Promise<void> {
    if (!this.sdk.isHeld()) this.sdk.doHoldResume();
    return Promise.resolve();
  }

  resume(): Promise<void> {
    if (this.sdk.isHeld()) this.sdk.doHoldResume();
    return Promise.resolve();
  }

  mute(): Promise<boolean> {
    return Promise.resolve(this.mute0.mute());
  }

  unmute(): Promise<boolean> {
    return Promise.resolve(this.mute0.unmute());
  }

  isMuted(): boolean {
    return this.sdk.isMuted();
  }

  isHeld(): boolean {
    return this.sdk.isHeld();
  }

  sendDigit(tone: string): Promise<void> {
    this.sdk.sendDigit(tone);
    return Promise.resolve();
  }

  blindTransfer(target: string): Promise<void> {
    // BLIND: transferTarget mandatory, transferCallId undefined (DISCOVERY.md §5).
    try {
      this.sdk.completeTransfer(TransferType.BLIND, undefined, target);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.resolve();
  }

  consultTransfer(consultCallId: string): Promise<void> {
    // CONSULT: transferCallId (the consult leg to merge back) mandatory; no target.
    try {
      this.sdk.completeTransfer(TransferType.CONSULT, consultCallId);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.resolve();
  }

  end(): Promise<void> {
    this.sdk.end();
    return Promise.resolve();
  }

  getCallerId(): CallerId | null {
    return this.callerId;
  }

  teardown(): void {
    this.stopMic();
  }

  // --- internals -------------------------------------------------------------

  private async captureMic(): Promise<LocalMicrophoneStream> {
    try {
      return await this.createMic();
    } catch (err) {
      const info: CallErrorInfo = {
        kind: 'media',
        message: `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
      this.emit({ kind: 'call', event: { type: 'CALL_ERROR', callId: this.id, error: info } });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private attach(): void {
    const c = this.sdk;
    c.on(CALL_EVENT_KEYS.PROGRESS, () => this.emit({ kind: 'call', event: { type: 'PROGRESS', callId: this.id } }));
    c.on(CALL_EVENT_KEYS.ALERTING, () => this.emit({ kind: 'call', event: { type: 'ALERTING', callId: this.id } }));
    c.on(CALL_EVENT_KEYS.CONNECT, () => this.emit({ kind: 'call', event: { type: 'CONNECT', callId: this.id } }));
    c.on(CALL_EVENT_KEYS.ESTABLISHED, () => this.emit({ kind: 'call', event: { type: 'ESTABLISHED', callId: this.id } }));
    c.on(CALL_EVENT_KEYS.REMOTE_MEDIA, (track: MediaStreamTrack) => {
      this.onRemoteTrack(track);
      this.emit({ kind: 'call', event: { type: 'REMOTE_MEDIA', callId: this.id } });
    });
    c.on(CALL_EVENT_KEYS.HELD, () => this.emit({ kind: 'call', event: { type: 'HELD', callId: this.id } }));
    c.on(CALL_EVENT_KEYS.RESUMED, () => this.emit({ kind: 'call', event: { type: 'RESUMED', callId: this.id } }));
    c.on(CALL_EVENT_KEYS.CALLER_ID, (display: CallerIdDisplay) => {
      this.callerId = displayToCallerId(display);
      this.emit({ kind: 'call', event: { type: 'CALLER_ID', callId: this.id, callerId: this.callerId } });
    });
    c.on(CALL_EVENT_KEYS.DISCONNECT, () => {
      this.stopMic();
      const reason = safeReason(this.sdk);
      this.emit({ kind: 'call', event: { type: 'DISCONNECT', callId: this.id, reason } });
      this.onGone(this.id);
    });
    c.on(CALL_EVENT_KEYS.CALL_ERROR, (err: CallError) => {
      this.emit({ kind: 'call', event: { type: 'CALL_ERROR', callId: this.id, error: mapCallError(err, 'call') } });
    });
    c.on(CALL_EVENT_KEYS.HOLD_ERROR, (err: CallError) => {
      this.emit({ kind: 'call', event: { type: 'HOLD_ERROR', callId: this.id, error: mapCallError(err, 'hold') } });
    });
    c.on(CALL_EVENT_KEYS.RESUME_ERROR, (err: CallError) => {
      this.emit({ kind: 'call', event: { type: 'RESUME_ERROR', callId: this.id, error: mapCallError(err, 'resume') } });
    });
    c.on(CALL_EVENT_KEYS.TRANSFER_ERROR, (err: CallError) => {
      this.emit({ kind: 'call', event: { type: 'TRANSFER_ERROR', callId: this.id, error: mapCallError(err, 'transfer') } });
    });
  }

  private stopMic(): void {
    if (this.micStream) {
      try {
        this.micStream.stop();
      } catch {
        // best-effort
      }
      this.micStream = null;
    }
  }
}

function toCallerId(call: ICall): CallerId | null {
  try {
    const info = call.getCallerInfo();
    if (!info) return null;
    return { name: info.name ?? undefined, num: info.num ?? undefined };
  } catch {
    return null;
  }
}

function displayToCallerId(display: CallerIdDisplay): CallerId {
  const info = display?.callerId;
  return { name: info?.name ?? undefined, num: info?.num ?? undefined };
}

function safeReason(call: ICall): string | undefined {
  try {
    return call.getDisconnectReason()?.cause;
  } catch {
    return undefined;
  }
}

function mapCallError(err: CallError, kind: CallErrorInfo['kind']): CallErrorInfo {
  let message = 'Call error';
  try {
    const obj = err?.getCallError?.();
    if (obj?.message) message = obj.message;
    else if (err?.message) message = err.message;
  } catch {
    if (err?.message) message = err.message;
  }
  // USER_BUSY (115) → classify as busy for a clearer UI message.
  const derivedKind = message.toLowerCase().includes('busy') ? 'busy' : kind;
  return { kind: derivedKind, message };
}
