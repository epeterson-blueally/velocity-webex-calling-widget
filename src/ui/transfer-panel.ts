/**
 * TransferPanelView — the transfer half of view (3) from the Phase 6 brief:
 * "transfer panel (blind: number entry; consult: dial-consult → complete/cancel)".
 *
 * Pure rendering of `TransferPanelState` (derived from `CallSnapshot` by whoever
 * owns this view — see toTransferPanelState below). The panel owns exactly two bits
 * of UI-only presentation state — which tab (blind/consult) is selected, and the
 * destination text field's value — neither of which is call business logic: they
 * only decide which `UiActions` method a click invokes, never whether the FSM may
 * transition. This is the file BUILD-PLAN.md Phase 6 explicitly calls out for
 * interaction tests: blind vs consult tab behaviour, and per-phase (dialing/
 * connecting/connected) rendering of the complete/cancel buttons while consulting.
 */

import type { CallerId, ConsultPhase } from '../state/types';
import type { UiActions } from './types';
import { clear, el } from './dom';

export type TransferMode = 'blind' | 'consult';

/** Everything the panel needs to render one frame. Callers derive this from a CallSnapshot. */
export interface TransferPanelState {
  /** Show the panel at all — true when a transfer can be started OR is in flight. */
  visible: boolean;
  /** Non-null exactly while a consult transfer is in flight. */
  consult: {
    phase: ConsultPhase;
    callerId: CallerId | null;
  } | null;
  /** A transfer-related error to surface (e.g. lastError.kind === 'transfer'), else null. */
  errorMessage: string | null;
}

const PHASE_LABEL: Record<ConsultPhase, string> = {
  dialing: 'Dialing the consult target…',
  connecting: 'Connecting…',
  connected: 'Connected — ready to complete the transfer.',
};

export class TransferPanelView {
  readonly element: HTMLElement;
  private readonly actions: UiActions;
  private mode: TransferMode = 'blind';
  private target = '';
  private lastState: TransferPanelState | null = null;

  constructor(actions: UiActions) {
    this.actions = actions;
    this.element = el('div', 'vw-transfer-panel');
  }

  render(state: TransferPanelState): void {
    this.lastState = state;
    clear(this.element);
    this.element.classList.toggle('vw-hidden', !state.visible);
    if (!state.visible) return;

    if (state.consult) {
      this.renderConsulting(state.consult, state.errorMessage);
    } else {
      this.renderIdle(state.errorMessage);
    }
  }

  // --- idle (not yet transferring): tab selector + destination + primary action ---

  private renderIdle(errorMessage: string | null): void {
    const tabs = el('div', 'vw-tabs');
    tabs.setAttribute('role', 'tablist');

    const blindTab = el('button', this.mode === 'blind' ? 'vw-active' : undefined, 'Blind');
    blindTab.type = 'button';
    blindTab.setAttribute('role', 'tab');
    blindTab.setAttribute('aria-selected', String(this.mode === 'blind'));
    blindTab.addEventListener('click', () => {
      this.mode = 'blind';
      this.render(this.lastState!);
    });

    const consultTab = el('button', this.mode === 'consult' ? 'vw-active' : undefined, 'Consult');
    consultTab.type = 'button';
    consultTab.setAttribute('role', 'tab');
    consultTab.setAttribute('aria-selected', String(this.mode === 'consult'));
    consultTab.addEventListener('click', () => {
      this.mode = 'consult';
      this.render(this.lastState!);
    });

    tabs.appendChild(blindTab);
    tabs.appendChild(consultTab);
    this.element.appendChild(tabs);

    const row = el('div', 'vw-row');
    const input = document.createElement('input');
    input.type = 'tel';
    input.className = 'vw-grow';
    input.placeholder = 'Transfer destination';
    input.value = this.target;
    input.setAttribute('aria-label', 'Transfer destination');
    input.addEventListener('input', () => {
      this.target = input.value;
      actionBtn.disabled = this.target.trim().length === 0;
    });

    const actionBtn = el(
      'button',
      'vw-primary',
      this.mode === 'blind' ? 'Transfer' : 'Start consult',
    );
    actionBtn.type = 'button';
    actionBtn.disabled = this.target.trim().length === 0;
    actionBtn.addEventListener('click', () => {
      const dest = this.target.trim();
      if (!dest) return;
      if (this.mode === 'blind') this.actions.blindTransfer(dest);
      else this.actions.startConsult(dest);
    });

    row.appendChild(input);
    row.appendChild(actionBtn);
    this.element.appendChild(row);

    if (errorMessage) {
      this.element.appendChild(el('div', 'vw-error-text', errorMessage));
    }
  }

  // --- consulting: phase status + complete/cancel ---

  private renderConsulting(
    consult: { phase: ConsultPhase; callerId: CallerId | null },
    errorMessage: string | null,
  ): void {
    const label = callerIdLabel(consult.callerId);
    this.element.appendChild(
      el('div', 'vw-muted', label ? `Consulting ${label}` : 'Consulting…'),
    );
    this.element.appendChild(el('div', undefined, PHASE_LABEL[consult.phase]));

    const row = el('div', 'vw-row');
    const completeBtn = el('button', 'vw-primary', 'Complete transfer');
    completeBtn.type = 'button';
    completeBtn.disabled = consult.phase !== 'connected';
    completeBtn.addEventListener('click', () => this.actions.completeConsult());

    const cancelBtn = el('button', undefined, 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => this.actions.cancelConsult());

    row.appendChild(completeBtn);
    row.appendChild(cancelBtn);
    this.element.appendChild(row);

    if (errorMessage) {
      this.element.appendChild(el('div', 'vw-error-text', errorMessage));
    }
  }
}

function callerIdLabel(callerId: CallerId | null): string | null {
  if (!callerId) return null;
  if (callerId.name && callerId.num) return `${callerId.name} (${callerId.num})`;
  return callerId.name ?? callerId.num ?? null;
}
