/**
 * src/ui — the presentation layer (BUILD-PLAN.md Phase 6).
 *
 * DESIGN RULE (BUILD-PLAN.md §1 + Phase 6 brief): "No business logic in UI code."
 * Every view in this directory is a pure function of a status snapshot: it renders
 * DOM from `WidgetStatus` and calls exactly the `UiActions` callback for whatever
 * the agent clicked/typed. No view holds a reference to `CallingController`,
 * `TokenProvider`, or `DesktopStateManager` — only src/index.ts (the custom element)
 * does, and it is also the only place that implements `UiActions`.
 *
 * Nothing under src/ui imports `@webex/calling` or `@wxcc-desktop/sdk`, directly or
 * transitively — only SDK-free type imports from src/state, src/auth, src/calling,
 * and src/desktop (all `import type`, erased at compile time).
 */

import type { AuthState } from '../auth/types';
import type { CallingStatus } from '../calling/controller';
import type { DesktopStatus } from '../desktop/manager';

/**
 * The single status object every view renders from. Assembled by src/index.ts from
 * the TokenProvider, CallingController, and DesktopStateManager it owns.
 */
export interface WidgetStatus {
  auth: AuthState;
  /** Null until the calling stack has been constructed (e.g. before first sign-in). */
  calling: CallingStatus | null;
  /** Null until the desktop-state manager has been constructed. */
  desktop: DesktopStatus | null;
  /**
   * Set when constructing/starting the live calling stack failed (e.g. the
   * `@webex/calling` engine isn't available in this packaging yet). Never thrown —
   * always surfaced here instead so the UI degrades to a clear message.
   */
  callingInitError: string | null;
}

/**
 * Every mutating action a view can request. Implemented by src/index.ts as thin
 * wrappers around TokenProvider/CallingController methods — the UI never calls an
 * SDK or FSM method itself.
 */
export interface UiActions {
  /** MUST be invoked synchronously from the click handler (popup-blocker safety). */
  signIn(): void;
  /** Retry constructing the calling stack after a prior `callingInitError`. */
  retryCallingInit(): void;

  dial(address: string): void;
  answer(): void;
  decline(): void;
  hold(): void;
  resume(): void;
  mute(): void;
  unmute(): void;
  end(): void;
  sendDigit(tone: string): void;
  answerSecond(): void;
  declineSecond(): void;

  blindTransfer(target: string): void;
  startConsult(target: string): void;
  completeConsult(): void;
  cancelConsult(): void;

  setMicDevice(deviceId: string): void;
  setSpeakerDevice(deviceId: string): void;
}

/** A DTMF keypad digit. */
export const DIALPAD_KEYS = [
  '1', '2', '3',
  '4', '5', '6',
  '7', '8', '9',
  '*', '0', '#',
] as const;
export type DialpadKey = (typeof DIALPAD_KEYS)[number];
