import { describe, expect, it } from 'vitest';
import { decodeJwtScope, maskToken } from '../src/index';

// Importing src/index registers the custom element as a side effect.
import '../src/index';

function makeFakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.signature`;
}

describe('<velocity-webex-calling>', () => {
  it('registers itself under its tag name', () => {
    expect(typeof customElements.get('velocity-webex-calling')).toBe('function');
  });

  it('renders a masked token, decoded scope claim, and the other attributes; never leaks the raw token', () => {
    const fakeToken = makeFakeJwt({ scope: 'spark:calls_read spark:calls_write' });

    const el = document.createElement('velocity-webex-calling');
    el.setAttribute('access-token', fakeToken);
    el.setAttribute('agent-id', 'agent-123');
    el.setAttribute('org-id', 'org-456');
    el.setAttribute('dark-mode', 'true');
    document.body.appendChild(el);

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();

    const text = shadow!.textContent ?? '';
    expect(text).toContain('agent-123');
    expect(text).toContain('org-456');
    expect(text).toContain('spark:calls_read');
    expect(text).toContain('true');
    // The raw token must never appear anywhere in the rendered output.
    expect(text).not.toContain(fakeToken);

    el.remove();
  });

  it('reports opaque / undecodable for a non-JWT token, and masks it', () => {
    expect(decodeJwtScope('not-a-jwt').decodable).toBe(false);
    expect(maskToken('not-a-jwt')).not.toBe('not-a-jwt');
    expect(maskToken('')).toBe('(none)');
  });
});
