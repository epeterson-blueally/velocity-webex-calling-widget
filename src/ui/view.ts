/**
 * CallingWidgetView — composes the five Phase 6 views into one render pass off a
 * single `WidgetStatus`. This is the only file that turns a `CallSnapshot` into the
 * smaller per-view prop shapes (e.g. `TransferPanelState`) — a pure derivation, not
 * a decision about whether the FSM may transition, so it stays within the "no
 * business logic in UI" rule.
 */

import type { CallSnapshot } from '../state/types';
import type { UiActions, WidgetStatus } from './types';
import { el } from './dom';
import { StatusBarView } from './status-bar';
import { DialPadView, type DialPadMode } from './dial-pad';
import { InCallControlsView } from './in-call-controls';
import { TransferPanelView, type TransferPanelState } from './transfer-panel';
import { DeviceSelectorView } from './device-selector';

const EMPTY_SNAPSHOT: CallSnapshot = {
  state: 'idle',
  call: null,
  heldCall: null,
  pendingInbound: null,
  consult: null,
  lastError: null,
  endReason: null,
};

/** States in which the dial pad / DTMF pad has anything useful to show. */
const DIALPAD_VISIBLE_STATES = new Set(['idle', 'ended', 'connected', 'held']);

export class CallingWidgetView {
  readonly element: HTMLElement;
  readonly remoteAudio: HTMLAudioElement;

  private readonly statusBar: StatusBarView;
  private readonly dialPad: DialPadView;
  private readonly inCall: InCallControlsView;
  private readonly transferPanel: TransferPanelView;
  private readonly deviceSelector: DeviceSelectorView;

  constructor(actions: UiActions) {
    this.element = el('div', 'vw-root');
    this.statusBar = new StatusBarView();
    this.inCall = new InCallControlsView(actions);
    this.dialPad = new DialPadView(actions);
    this.transferPanel = new TransferPanelView(actions);
    this.deviceSelector = new DeviceSelectorView(actions);

    this.remoteAudio = document.createElement('audio');
    this.remoteAudio.autoplay = true;
    this.remoteAudio.setAttribute('aria-hidden', 'true');
    this.remoteAudio.style.display = 'none';
    this.deviceSelector.setRemoteAudioElement(this.remoteAudio);

    this.element.appendChild(this.statusBar.element);
    this.element.appendChild(this.inCall.element);
    this.element.appendChild(this.dialPad.element);
    this.element.appendChild(this.transferPanel.element);
    this.element.appendChild(this.deviceSelector.element);
    this.element.appendChild(this.remoteAudio);
  }

  /** Start device enumeration for `agentId`. Safe to call once the element connects. */
  async startDeviceSelector(agentId: string): Promise<void> {
    await this.deviceSelector.start(agentId);
  }

  render(status: WidgetStatus, actions: UiActions): void {
    this.statusBar.render(status, actions);

    const snap = status.calling?.call ?? EMPTY_SNAPSHOT;
    const registered = status.calling?.registration === 'registered';
    const hasCalling = status.calling !== null;

    this.inCall.render({ snapshot: snap });
    this.transferPanel.render(toTransferPanelState(snap));

    const dialpadMode: DialPadMode = snap.state === 'connected' || snap.state === 'held' ? 'dtmf' : 'dial';
    const dialpadVisible = hasCalling && DIALPAD_VISIBLE_STATES.has(snap.state);
    this.dialPad.element.classList.toggle('vw-hidden', !dialpadVisible);
    this.dialPad.render({ mode: dialpadMode, callEnabled: registered && snap.state === 'idle' });

    this.deviceSelector.element.classList.toggle('vw-hidden', !hasCalling);
  }

  dispose(): void {
    this.inCall.dispose();
    this.deviceSelector.dispose();
  }

  /** Unlock the ring tone's AudioContext. Call from any widget-wide user gesture. */
  armAudio(): void {
    this.inCall.armAudio();
  }
}

/** Derive the transfer panel's props from the FSM snapshot (pure; no side effects). */
export function toTransferPanelState(snap: CallSnapshot): TransferPanelState {
  const transferErrorMessage = snap.lastError?.kind === 'transfer' ? snap.lastError.message : null;

  if (snap.state === 'consulting' && snap.consult) {
    return {
      visible: true,
      consult: { phase: snap.consult.phase, callerId: snap.consult.consult.callerId },
      errorMessage: transferErrorMessage,
    };
  }
  if ((snap.state === 'connected' || snap.state === 'held') && snap.call) {
    return { visible: true, consult: null, errorMessage: transferErrorMessage };
  }
  return { visible: false, consult: null, errorMessage: null };
}
