/**
 * DialPadView — view (2) from the Phase 6 brief: "dial pad — 0-9 * # grid, number
 * field, call button; reuse it in-call for DTMF."
 *
 * Two modes, one grid:
 *  - 'dial' (idle, registered): the 3x4 grid appends digits to the address field;
 *    the Call button (or Enter in the field) calls `actions.dial(address)`.
 *  - 'dtmf' (connected/held): the field and Call button are hidden; each grid
 *    button instead sends that single digit immediately via `actions.sendDigit`.
 *
 * Keyboard (Phase 6 brief: "digits type into the pad, Enter dials"): typing a
 * digit/`*`/`#` key anywhere in this component's subtree appends it to the address
 * field in 'dial' mode (so a digit button need not be individually focused first);
 * Enter triggers the same action as the Call button.
 */

import { DIALPAD_KEYS, type DialpadKey, type UiActions } from './types';
import { el } from './dom';

export type DialPadMode = 'dial' | 'dtmf';

export interface DialPadState {
  mode: DialPadMode;
  /** 'dial' mode: whether the Call button/Enter may actually place a call. */
  callEnabled: boolean;
}

export class DialPadView {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly callBtn: HTMLButtonElement;
  private readonly grid: HTMLElement;
  private readonly actions: UiActions;
  private mode: DialPadMode = 'dial';
  private callEnabled = false;

  constructor(actions: UiActions) {
    this.actions = actions;
    this.element = el('div', 'vw-dialpad');

    this.input = document.createElement('input');
    this.input.type = 'tel';
    this.input.className = 'vw-grow';
    this.input.placeholder = 'Enter number or address';
    this.input.setAttribute('aria-label', 'Number to dial');

    this.callBtn = el('button', 'vw-primary vw-icon', 'Call');
    this.callBtn.type = 'button';

    const fieldRow = el('div', 'vw-row');
    fieldRow.appendChild(this.input);
    fieldRow.appendChild(this.callBtn);

    this.grid = el('div', 'vw-dialpad-grid');
    for (const key of DIALPAD_KEYS) {
      const btn = el('button', 'vw-dialpad-key', key);
      btn.type = 'button';
      btn.dataset.key = key;
      this.grid.appendChild(btn);
    }

    this.element.appendChild(fieldRow);
    this.element.appendChild(this.grid);

    this.wireEvents();
  }

  render(state: DialPadState): void {
    this.mode = state.mode;
    this.callEnabled = state.callEnabled;

    const isDial = this.mode === 'dial';
    this.input.classList.toggle('vw-hidden', !isDial);
    this.callBtn.classList.toggle('vw-hidden', !isDial);
    this.callBtn.disabled = !this.callEnabled || this.input.value.trim().length === 0;
  }

  /** Reset the address field (called after a dial attempt starts). */
  clearInput(): void {
    this.input.value = '';
    this.callBtn.disabled = true;
  }

  private wireEvents(): void {
    this.input.addEventListener('input', () => {
      this.callBtn.disabled = !this.callEnabled || this.input.value.trim().length === 0;
    });
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.tryDial();
      }
    });
    this.callBtn.addEventListener('click', () => this.tryDial());

    for (const btn of Array.from(this.grid.querySelectorAll<HTMLButtonElement>('button'))) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key as DialpadKey;
        this.pressKey(key);
      });
    }

    // Whole-component keyboard capture: typed digits append to the field in 'dial'
    // mode even when a grid button (not the input) has focus.
    this.element.addEventListener('keydown', (ev) => {
      if (this.mode !== 'dial') return;
      if (ev.target === this.input) return; // input already handles its own typing
      if (ev.key === 'Enter') {
        this.tryDial();
        return;
      }
      const key = normalizeDigitKey(ev.key);
      if (key) {
        ev.preventDefault();
        this.pressKey(key);
      }
    });
  }

  private pressKey(key: DialpadKey): void {
    if (this.mode === 'dtmf') {
      this.actions.sendDigit(key);
      return;
    }
    this.input.value += key;
    this.input.focus();
    this.callBtn.disabled = !this.callEnabled || this.input.value.trim().length === 0;
  }

  private tryDial(): void {
    if (this.mode !== 'dial' || !this.callEnabled) return;
    const address = this.input.value.trim();
    if (!address) return;
    this.actions.dial(address);
    this.clearInput();
  }
}

function normalizeDigitKey(key: string): DialpadKey | null {
  return (DIALPAD_KEYS as readonly string[]).includes(key) ? (key as DialpadKey) : null;
}
