import { vi } from 'vitest';
import type { UiActions } from '../../src/ui/types';

/** A fully-stubbed UiActions double. Every method is a spy (vi.fn()). */
export function makeActions(): UiActions {
  return {
    signIn: vi.fn(),
    retryCallingInit: vi.fn(),
    dial: vi.fn(),
    answer: vi.fn(),
    decline: vi.fn(),
    hold: vi.fn(),
    resume: vi.fn(),
    mute: vi.fn(),
    unmute: vi.fn(),
    end: vi.fn(),
    sendDigit: vi.fn(),
    answerSecond: vi.fn(),
    declineSecond: vi.fn(),
    blindTransfer: vi.fn(),
    startConsult: vi.fn(),
    completeConsult: vi.fn(),
    cancelConsult: vi.fn(),
    setMicDevice: vi.fn(),
    setSpeakerDevice: vi.fn(),
  };
}

/** Find a button in `root` by its exact visible text. */
export function findButton(root: ParentNode, text: string): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`No button with text "${text}" found`);
  return btn as HTMLButtonElement;
}

export function findInput(root: ParentNode): HTMLInputElement {
  const input = root.querySelector('input');
  if (!input) throw new Error('No input found');
  return input;
}
