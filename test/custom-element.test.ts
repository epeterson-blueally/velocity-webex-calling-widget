import { afterEach, describe, expect, it } from 'vitest';
import { decodeJwtScope, maskToken } from '../src/index';

// Importing src/index registers the custom element as a side effect. Its STATIC
// import graph is SDK-free (see src/index.ts header) — this import must stay cheap
// and must never pull in @webex/calling or @wxcc-desktop/sdk.
import '../src/index';

function makeFakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.signature`;
}

const mounted: HTMLElement[] = [];
function mount(attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement('velocity-webex-calling');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

describe('<velocity-webex-calling>', () => {
  it('registers itself under its tag name', () => {
    expect(typeof customElements.get('velocity-webex-calling')).toBe('function');
  });

  it('renders a "Sign in to Webex Calling" gate by default (no OAuth attrs, no token)', () => {
    const el = mount({ 'agent-id': 'agent-123', 'org-id': 'org-456' });
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).toContain('Webex Calling');
    expect(text).toContain('Sign in to Webex Calling');
    // Not authenticated yet, so no dial pad / call controls should be reachable.
    expect(text).not.toContain('Transfer');
  });

  it('reflects the dark-mode attribute onto the host and ships a dark-mode style rule', () => {
    const el = mount({ 'dark-mode': 'true' });
    expect(el.getAttribute('dark-mode')).toBe('true');
    const styleText = el.shadowRoot?.querySelector('style')?.textContent ?? '';
    // Theming is pure CSS via :host([dark-mode="true"]) — assert the rule shipped;
    // actual visual rendering is verified in the browser harness (jsdom's CSS engine
    // does not resolve shadow-host attribute selectors for getComputedStyle).
    expect(styleText).toContain(':host([dark-mode="true"])');
  });

  it('never renders the raw access-token when the StoreTokenProvider path is used', () => {
    const fakeToken = makeFakeJwt({ scope: 'spark:calls_read spark:calls_write' });
    const el = mount({ 'access-token': fakeToken, 'agent-id': 'agent-123' });
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).not.toContain(fakeToken);
    // A token is present (no OAuth attrs → StoreTokenProvider path), so the gate
    // should have moved past "Sign in" — the widget should not ask the agent to
    // authenticate again once the desktop has supplied a token.
    expect(text).not.toContain('Sign in to Webex Calling');
  });

  it('shows the OAuth sign-in gate when client-id/redirect-uri/auth-base-url are supplied', () => {
    const el = mount({
      'client-id': 'C123',
      'redirect-uri': 'https://example.test/oauth-callback.html',
      'auth-base-url': 'https://auth.example.test',
    });
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).toContain('Sign in to Webex Calling');
  });

  it('does not throw across connect/disconnect/reconnect', () => {
    const el = mount({ 'agent-id': 'agent-1' });
    expect(() => el.remove()).not.toThrow();
    mounted.splice(mounted.indexOf(el), 1);
    expect(() => document.body.appendChild(el)).not.toThrow();
    el.remove();
  });

  it('reports opaque / undecodable for a non-JWT token, and masks it', () => {
    expect(decodeJwtScope('not-a-jwt').decodable).toBe(false);
    expect(maskToken('not-a-jwt')).not.toBe('not-a-jwt');
    expect(maskToken('')).toBe('(none)');
  });
});
