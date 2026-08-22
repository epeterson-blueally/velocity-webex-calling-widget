/**
 * StatusBarView — view (1) from the Phase 6 brief: "status bar (line registered /
 * agent state we set)". Also carries the sign-in gate, since both are pure renders
 * of `auth` + `calling.registration` + `desktop` and neither has anywhere else to
 * live. Renders from `WidgetStatus` only; every click calls exactly one `UiActions`
 * method.
 */

import type { RegistrationStatus } from '../calling/backend';
import type { UiActions, WidgetStatus } from './types';
import { clear, el } from './dom';

const REGISTRATION_LABEL: Record<RegistrationStatus, string> = {
  unregistered: 'Not registered',
  registering: 'Registering…',
  registered: 'Line registered',
  reconnecting: 'Reconnecting…',
  failed: 'Registration failed',
};

const REGISTRATION_DOT: Record<RegistrationStatus, 'ok' | 'warn' | 'bad' | 'muted'> = {
  unregistered: 'muted',
  registering: 'warn',
  registered: 'ok',
  reconnecting: 'warn',
  failed: 'bad',
};

export class StatusBarView {
  readonly element: HTMLElement;

  constructor() {
    this.element = el('div', 'vw-status-bar');
  }

  render(status: WidgetStatus, actions: UiActions): void {
    clear(this.element);

    this.element.appendChild(el('h2', 'vw-title', 'Webex Calling'));

    if (!status.calling) {
      this.element.appendChild(this.renderAuthGate(status, actions));
      return;
    }

    // Registered line.
    const regLine = el('div', 'vw-status-line');
    const dot = el('span', `vw-dot vw-${REGISTRATION_DOT[status.calling.registration]}`);
    regLine.appendChild(dot);
    regLine.appendChild(
      el('span', undefined, REGISTRATION_LABEL[status.calling.registration]),
    );
    this.element.appendChild(regLine);
    if (status.calling.registrationDetail) {
      this.element.appendChild(el('div', 'vw-muted', status.calling.registrationDetail));
    }

    // Auth degraded while otherwise up (e.g. a background refresh failed).
    if (status.auth.status === 'refreshing') {
      this.element.appendChild(el('div', 'vw-muted', 'Refreshing sign-in…'));
    } else if (status.auth.status === 'error' && status.auth.detail) {
      this.element.appendChild(this.banner('warn', status.auth.detail));
    }

    // Desktop-state banners (Phase 5): idle-forced indicator, config error, ACD interleave.
    if (status.desktop) {
      if (status.desktop.idleForcedForCall) {
        this.element.appendChild(
          this.banner('warn', 'Agent state set to "Non-Contact Center Call" for this personal call.'),
        );
      }
      if (status.desktop.configError) {
        this.element.appendChild(this.banner('bad', status.desktop.configError));
      }
      if (status.desktop.acdInterleaveBanner) {
        this.element.appendChild(this.banner('warn', status.desktop.acdInterleaveBanner));
      }
    }

    if (status.calling.lastActionError) {
      this.element.appendChild(this.banner('bad', status.calling.lastActionError));
    }
  }

  private renderAuthGate(status: WidgetStatus, actions: UiActions): HTMLElement {
    const gate = el('div', 'vw-auth-gate');
    const auth = status.auth;

    if (auth.status === 'signing-in') {
      gate.appendChild(el('div', 'vw-muted', 'Signing in to Webex Calling…'));
      return gate;
    }

    if (status.callingInitError) {
      gate.appendChild(this.banner('bad', status.callingInitError));
      const retry = el('button', 'vw-primary', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', () => actions.retryCallingInit());
      gate.appendChild(retry);
      return gate;
    }

    if (auth.status === 'authenticated' || auth.status === 'refreshing') {
      gate.appendChild(el('div', 'vw-muted', 'Connecting to Webex Calling…'));
      return gate;
    }

    // signed-out / uninitialized / error → offer sign-in.
    if (auth.status === 'error' && auth.detail) {
      gate.appendChild(this.banner('bad', auth.detail));
    } else {
      gate.appendChild(
        el('div', 'vw-muted', 'Sign in with your Webex account to use your personal calling line.'),
      );
    }
    const signIn = el('button', 'vw-primary', 'Sign in to Webex Calling');
    signIn.type = 'button';
    // MUST be called synchronously from this click handler — popups opened after an
    // await are blocked by Safari/strict browsers (see OAuthTokenProvider.signIn).
    signIn.addEventListener('click', () => actions.signIn());
    gate.appendChild(signIn);
    return gate;
  }

  private banner(kind: 'warn' | 'bad', text: string): HTMLElement {
    return el('div', `vw-banner vw-${kind}`, text);
  }
}
