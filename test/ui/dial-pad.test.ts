import { describe, expect, it } from 'vitest';
import { DialPadView } from '../../src/ui/dial-pad';
import { findButton, findInput, makeActions } from './mocks';

describe('DialPadView', () => {
  it('dial mode: pressing grid digits appends to the address field, Call dials the trimmed value', () => {
    const actions = makeActions();
    const view = new DialPadView(actions);
    view.render({ mode: 'dial', callEnabled: true });

    findButton(view.element, '5').click();
    findButton(view.element, '5').click();
    findButton(view.element, '5').click();
    expect(findInput(view.element).value).toBe('555');

    findButton(view.element, 'Call').click();
    expect(actions.dial).toHaveBeenCalledWith('555');
    // The field clears after dialing.
    expect(findInput(view.element).value).toBe('');
  });

  it('dial mode: Enter in the field dials; Call is disabled while empty or not callEnabled', () => {
    const actions = makeActions();
    const view = new DialPadView(actions);
    view.render({ mode: 'dial', callEnabled: false });
    expect(findButton(view.element, 'Call').disabled).toBe(true);

    view.render({ mode: 'dial', callEnabled: true });
    const input = findInput(view.element);
    input.value = '4155551234';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(actions.dial).toHaveBeenCalledWith('4155551234');
  });

  it('dtmf mode: hides the field/Call button; grid digits send immediately without accumulating', () => {
    const actions = makeActions();
    const view = new DialPadView(actions);
    view.render({ mode: 'dtmf', callEnabled: false });

    expect(findInput(view.element).classList.contains('vw-hidden')).toBe(true);
    expect(findButton(view.element, 'Call').classList.contains('vw-hidden')).toBe(true);

    findButton(view.element, '#').click();
    expect(actions.sendDigit).toHaveBeenCalledWith('#');
    expect(actions.dial).not.toHaveBeenCalled();
    // No accumulation in the (hidden) field for DTMF.
    expect(findInput(view.element).value).toBe('');
  });
});
