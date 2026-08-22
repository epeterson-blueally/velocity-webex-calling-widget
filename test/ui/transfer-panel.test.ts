/**
 * Interaction tests for TransferPanelView (BUILD-PLAN.md Phase 6 exit criterion:
 * "interaction tests for the transfer panel state rendering — blind vs consult;
 * consult phases dialing/connecting/connected; complete/cancel buttons appear per
 * state"). Every assertion drives real DOM events (typing, clicking) against a
 * component instantiated with a stubbed UiActions — no CallingController, no FSM,
 * no SDK — the panel only ever renders a `TransferPanelState` value.
 */
import { describe, expect, it } from 'vitest';
import { TransferPanelView, type TransferPanelState } from '../../src/ui/transfer-panel';
import type { ConsultPhase } from '../../src/state/types';
import { findButton, findInput, makeActions } from './mocks';

function idleState(errorMessage: string | null = null): TransferPanelState {
  return { visible: true, consult: null, errorMessage };
}

function consultState(phase: ConsultPhase, errorMessage: string | null = null): TransferPanelState {
  return {
    visible: true,
    consult: { phase, callerId: { name: 'Bob Consultee', num: '+15551230000' } },
    errorMessage,
  };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('TransferPanelView', () => {
  it('renders nothing (hidden) when a transfer is not possible', () => {
    const view = new TransferPanelView(makeActions());
    view.render({ visible: false, consult: null, errorMessage: null });
    expect(view.element.classList.contains('vw-hidden')).toBe(true);
    expect(view.element.querySelectorAll('button')).toHaveLength(0);
  });

  it('defaults to the Blind tab: disabled Transfer button until a destination is entered', () => {
    const actions = makeActions();
    const view = new TransferPanelView(actions);
    view.render(idleState());

    const blindTab = findButton(view.element, 'Blind');
    const consultTab = findButton(view.element, 'Consult');
    expect(blindTab.classList.contains('vw-active')).toBe(true);
    expect(consultTab.classList.contains('vw-active')).toBe(false);

    const transferBtn = findButton(view.element, 'Transfer');
    expect(transferBtn.disabled).toBe(true);

    type(findInput(view.element), '+15559990000');
    expect(findButton(view.element, 'Transfer').disabled).toBe(false);

    findButton(view.element, 'Transfer').click();
    expect(actions.blindTransfer).toHaveBeenCalledWith('+15559990000');
    expect(actions.startConsult).not.toHaveBeenCalled();
  });

  it('trims whitespace from the blind-transfer destination', () => {
    const actions = makeActions();
    const view = new TransferPanelView(actions);
    view.render(idleState());
    type(findInput(view.element), '  +15559990000  ');
    findButton(view.element, 'Transfer').click();
    expect(actions.blindTransfer).toHaveBeenCalledWith('+15559990000');
  });

  it('switching to the Consult tab swaps the primary action to "Start consult"', () => {
    const actions = makeActions();
    const view = new TransferPanelView(actions);
    view.render(idleState());

    findButton(view.element, 'Consult').click();
    expect(findButton(view.element, 'Consult').classList.contains('vw-active')).toBe(true);
    expect(findButton(view.element, 'Blind').classList.contains('vw-active')).toBe(false);

    type(findInput(view.element), 'sip:consult@example.com');
    findButton(view.element, 'Start consult').click();
    expect(actions.startConsult).toHaveBeenCalledWith('sip:consult@example.com');
    expect(actions.blindTransfer).not.toHaveBeenCalled();
  });

  it('does not call an action when the destination is empty', () => {
    const actions = makeActions();
    const view = new TransferPanelView(actions);
    view.render(idleState());
    // Button starts disabled; clicking a disabled button fires no click handler in
    // a real browser, but assert the guard too in case a caller forces it.
    const btn = findButton(view.element, 'Transfer');
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(actions.blindTransfer).not.toHaveBeenCalled();
  });

  it('shows an idle-state transfer error next to the action row', () => {
    const view = new TransferPanelView(makeActions());
    view.render(idleState('Blind transfer failed: busy'));
    expect(view.element.textContent).toContain('Blind transfer failed: busy');
  });

  describe('while consulting', () => {
    it('phase=dialing: shows the dialing status, disables Complete, enables Cancel', () => {
      const actions = makeActions();
      const view = new TransferPanelView(actions);
      view.render(consultState('dialing'));

      expect(view.element.textContent).toContain('Consulting Bob Consultee (+15551230000)');
      expect(view.element.textContent).toContain('Dialing the consult target…');

      const complete = findButton(view.element, 'Complete transfer');
      const cancel = findButton(view.element, 'Cancel');
      expect(complete.disabled).toBe(true);
      expect(cancel.disabled).toBe(false);

      cancel.click();
      expect(actions.cancelConsult).toHaveBeenCalledTimes(1);
      expect(actions.completeConsult).not.toHaveBeenCalled();
    });

    it('phase=connecting: still shows Complete disabled', () => {
      const view = new TransferPanelView(makeActions());
      view.render(consultState('connecting'));
      expect(view.element.textContent).toContain('Connecting…');
      expect(findButton(view.element, 'Complete transfer').disabled).toBe(true);
      expect(findButton(view.element, 'Cancel').disabled).toBe(false);
    });

    it('phase=connected: enables Complete; clicking it calls completeConsult', () => {
      const actions = makeActions();
      const view = new TransferPanelView(actions);
      view.render(consultState('connected'));

      expect(view.element.textContent).toContain('Connected — ready to complete the transfer.');
      const complete = findButton(view.element, 'Complete transfer');
      expect(complete.disabled).toBe(false);

      complete.click();
      expect(actions.completeConsult).toHaveBeenCalledTimes(1);
      expect(actions.cancelConsult).not.toHaveBeenCalled();
    });

    it('hides the tab selector and destination field while consulting', () => {
      const view = new TransferPanelView(makeActions());
      view.render(consultState('dialing'));
      expect(view.element.querySelector('input')).toBeNull();
      expect(() => findButton(view.element, 'Blind')).toThrow();
    });

    it('surfaces a transfer error raised while consulting (e.g. completeTransfer failed)', () => {
      const view = new TransferPanelView(makeActions());
      view.render(consultState('connected', 'Transfer failed: target hung up'));
      expect(view.element.textContent).toContain('Transfer failed: target hung up');
    });

    it('renders without a caller-id label when none is known yet', () => {
      const view = new TransferPanelView(makeActions());
      view.render({ visible: true, consult: { phase: 'dialing', callerId: null }, errorMessage: null });
      expect(view.element.textContent).toContain('Consulting…');
    });
  });

  it('preserves the typed destination when re-rendered with the same idle state', () => {
    const view = new TransferPanelView(makeActions());
    view.render(idleState());
    type(findInput(view.element), '12345');
    view.render(idleState());
    expect(findInput(view.element).value).toBe('12345');
  });

  it('transitioning from consulting back to idle (cancel completed) shows the tabs again', () => {
    const view = new TransferPanelView(makeActions());
    view.render(consultState('connecting'));
    expect(view.element.querySelector('input')).toBeNull();
    view.render(idleState());
    expect(findInput(view.element)).not.toBeNull();
    expect(findButton(view.element, 'Blind')).toBeTruthy();
  });
});
