/**
 * InCallControlsView — view (3) (minus the transfer panel, which lives in
 * transfer-panel.ts) and view (4) from the Phase 6 brief: answer/decline, hold/
 * resume, mute, end, caller-ID + call timer, and the inbound-ring surface with a
 * user-gesture-safe ring tone.
 *
 * Renders purely from a `CallSnapshot` (BUILD-PLAN.md §1 rule 1 — the FSM owns
 * truth). The only local state this view owns is the `RingTone` player and a timer
 * interval to refresh the elapsed-time display — both presentation concerns, never
 * call logic.
 */

import type { CallInfo, CallSnapshot, CallState } from '../state/types';
import type { UiActions } from './types';
import { clear, el, iconSpan } from './dom';
import { icon } from './icons';
import { RingTone } from './ring-tone';

const ACTIVE_CALL_STATES: ReadonlySet<CallState> = new Set<CallState>([
  'dialing',
  'ringing_in',
  'connecting',
  'connected',
  'held',
]);

export interface InCallControlsState {
  snapshot: CallSnapshot;
}

export class InCallControlsView {
  readonly element: HTMLElement;
  private readonly actions: UiActions;
  private readonly ringTone = new RingTone();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private wasRinging = false;

  constructor(actions: UiActions) {
    this.actions = actions;
    this.element = el('div', 'vw-in-call');
    // Any interaction anywhere in the widget unlocks the AudioContext for the ring
    // tone (browsers require a user gesture before audio may play).
    this.element.addEventListener('pointerdown', () => this.ringTone.armOnUserGesture());
    this.element.addEventListener('keydown', () => this.ringTone.armOnUserGesture());
  }

  render(state: InCallControlsState): void {
    const snap = state.snapshot;
    clear(this.element);
    this.element.classList.toggle('vw-hidden', !ACTIVE_CALL_STATES.has(snap.state) && !snap.pendingInbound);

    if (snap.state === 'ringing_in' && snap.call) {
      this.renderRingSurface(snap.call);
    } else {
      this.stopRinging();
      if (snap.call && ACTIVE_CALL_STATES.has(snap.state)) {
        this.renderActiveCall(snap.state, snap.call);
      }
    }

    if (snap.pendingInbound) {
      this.element.appendChild(this.renderPendingInbound(snap.pendingInbound));
    }

    this.ensureTicking();
  }

  dispose(): void {
    this.stopRinging();
    this.ringTone.dispose();
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Unlock the ring tone's AudioContext from any user gesture, anywhere in the widget. */
  armAudio(): void {
    this.ringTone.armOnUserGesture();
  }

  // --- sub-renders -------------------------------------------------------------

  private renderRingSurface(call: CallInfo): void {
    const surface = el('div', 'vw-ring-surface');
    surface.appendChild(el('div', 'vw-caller-name', callerName(call)));
    if (call.callerId?.num) surface.appendChild(el('div', 'vw-caller-num', call.callerId.num));
    surface.appendChild(el('div', 'vw-muted', 'Incoming personal call'));

    const row = el('div', 'vw-row');
    const answerBtn = this.button('vw-primary vw-icon', 'phone', 'Answer');
    answerBtn.addEventListener('click', () => this.actions.answer());
    const declineBtn = this.button('vw-danger vw-icon', 'phoneDecline', 'Decline');
    declineBtn.addEventListener('click', () => this.actions.decline());
    row.appendChild(answerBtn);
    row.appendChild(declineBtn);
    surface.appendChild(row);

    this.element.appendChild(surface);
    this.startRinging();
  }

  private renderActiveCall(state: CallState, call: CallInfo): void {
    const card = el('div', 'vw-call-card');
    card.appendChild(el('div', 'vw-caller-name', callerName(call)));
    if (call.callerId?.num) card.appendChild(el('div', 'vw-caller-num', call.callerId.num));
    card.appendChild(el('div', 'vw-muted', phaseLabel(state)));
    if (call.connectedAt !== null) {
      card.setAttribute('data-connected-at', String(call.connectedAt));
      card.appendChild(el('div', 'vw-timer', formatElapsed(Date.now() - call.connectedAt)));
    }
    this.element.appendChild(card);

    const row = el('div', 'vw-row vw-wrap');

    if (state === 'connected' || state === 'held') {
      if (state === 'connected') {
        const holdBtn = this.button('vw-icon', 'hold', 'Hold');
        holdBtn.addEventListener('click', () => this.actions.hold());
        row.appendChild(holdBtn);
      } else {
        const resumeBtn = this.button('vw-icon', 'resume', 'Resume');
        resumeBtn.addEventListener('click', () => this.actions.resume());
        row.appendChild(resumeBtn);
      }

      const muteBtn = this.button('vw-icon', call.muted ? 'micOff' : 'mic', call.muted ? 'Unmute' : 'Mute');
      muteBtn.addEventListener('click', () => (call.muted ? this.actions.unmute() : this.actions.mute()));
      row.appendChild(muteBtn);
    }

    const endBtn = this.button('vw-danger vw-icon', 'end', 'End');
    endBtn.addEventListener('click', () => this.actions.end());
    row.appendChild(endBtn);

    this.element.appendChild(row);
  }

  private renderPendingInbound(pending: CallInfo): HTMLElement {
    const banner = el('div', 'vw-banner vw-warn');
    banner.appendChild(
      el('div', undefined, `Second call waiting: ${callerName(pending)}`),
    );
    const row = el('div', 'vw-row');
    const answerBtn = el('button', 'vw-primary', 'Answer (hold current)');
    answerBtn.type = 'button';
    answerBtn.addEventListener('click', () => this.actions.answerSecond());
    const declineBtn = el('button', undefined, 'Decline');
    declineBtn.type = 'button';
    declineBtn.addEventListener('click', () => this.actions.declineSecond());
    row.appendChild(answerBtn);
    row.appendChild(declineBtn);
    banner.appendChild(row);
    return banner;
  }

  private button(className: string, iconName: Parameters<typeof icon>[0], label: string): HTMLButtonElement {
    const btn = el('button', className);
    btn.type = 'button';
    btn.appendChild(iconSpan(icon(iconName)));
    btn.appendChild(document.createTextNode(label));
    return btn;
  }

  private startRinging(): void {
    if (this.wasRinging) return;
    this.wasRinging = true;
    this.ringTone.start();
  }

  private stopRinging(): void {
    if (!this.wasRinging) return;
    this.wasRinging = false;
    this.ringTone.stop();
  }

  private ensureTicking(): void {
    // Refresh the elapsed-call timer once a second. Cheap: re-render is idempotent
    // DOM rebuild of this small subtree only, driven by the caller re-invoking
    // render() with the same snapshot on each tick.
    if (this.tickTimer !== null) return;
    this.tickTimer = setInterval(() => {
      const timerEl = this.element.querySelector<HTMLElement>('.vw-timer');
      if (!timerEl) return;
      const card = this.element.querySelector('.vw-call-card');
      const connectedAtAttr = card?.getAttribute('data-connected-at');
      if (connectedAtAttr) {
        timerEl.textContent = formatElapsed(Date.now() - Number(connectedAtAttr));
      }
    }, 1000);
  }
}

function callerName(call: CallInfo): string {
  const id = call.callerId;
  if (id?.name) return id.name;
  if (id?.num) return id.num;
  return call.direction === 'inbound' ? 'Unknown caller' : 'Calling…';
}

function phaseLabel(state: CallState): string {
  switch (state) {
    case 'dialing':
      return 'Calling…';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'held':
      return 'On hold';
    default:
      return '';
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
