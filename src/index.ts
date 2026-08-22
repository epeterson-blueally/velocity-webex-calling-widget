/**
 * <velocity-webex-calling>
 *
 * Phase 1 scaffold. No calling logic yet — this renders a placeholder card
 * that echoes back the attributes the WxCC desktop layout binds onto the
 * widget ($STORE.auth.accessToken, $STORE.agent.agentId, $STORE.agent.orgId,
 * $STORE.app.darkMode — see DEV-HANDOFF.md "Custom-element contract").
 *
 * Also decodes the access-token attribute as a best-effort JWT and displays
 * its `scope` claim. This is the Phase 0 gate follow-up (self-OAuth was
 * chosen because the desktop's own token failed calling-client init — see
 * PROGRESS.md gate log): once this loads inside the real Agent Desktop, the
 * scope claim tells us exactly what $STORE.auth.accessToken carries, without
 * writing any throwaway code. The decode approach mirrors test/token-probe.html.
 *
 * Security note: the raw token is never logged and never rendered — only a
 * masked form (first/last 4 chars) ever reaches the DOM or the console.
 */

const TAG_NAME = 'velocity-webex-calling';

const OBSERVED_ATTRIBUTES = ['access-token', 'agent-id', 'org-id', 'dark-mode'] as const;
type ObservedAttribute = (typeof OBSERVED_ATTRIBUTES)[number];

/** Masks a token, showing only the first/last 4 characters. Never returns the raw value. */
export function maskToken(token: string): string {
  if (!token) return '(none)';
  if (token.length <= 8) return '*'.repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} chars)`;
}

export interface DecodedScope {
  /** Space-joined scope string if a scope-like claim was found, else null. */
  scope: string | null;
  /** True if the middle JWT segment parsed as JSON at all (even with no scope claim). */
  decodable: boolean;
}

/**
 * Best-effort JWT payload decode, looking for a scope/scopes/scp claim.
 * Webex tokens are not guaranteed to be readable JWTs (they may be opaque),
 * so failure to decode is expected and handled, not an error.
 */
export function decodeJwtScope(token: string): DecodedScope {
  if (!token) return { scope: null, decodable: false };
  try {
    const parts = token.split('.');
    if (parts.length < 2) return { scope: null, decodable: false };
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    base64 = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = JSON.parse(decodeURIComponent(escape(atob(base64))));
    const raw = json.scope ?? json.scopes ?? json.scp ?? null;
    if (raw == null) return { scope: null, decodable: true };
    const scope = Array.isArray(raw) ? raw.join(' ') : String(raw);
    return { scope, decodable: true };
  } catch {
    return { scope: null, decodable: false };
  }
}

const SHELL_HTML = `
  <style>
    :host {
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --bg: #ffffff;
      --fg: #1a1a1a;
      --muted: #6b6b6b;
      --border: #e0e0e0;
      --accent: #00838f;
    }
    :host([dark-mode="true"]) {
      --bg: #1e1e1e;
      --fg: #f0f0f0;
      --muted: #a0a0a0;
      --border: #3a3a3a;
      --accent: #4dd0e1;
    }
    .card {
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
      max-width: 480px;
      box-sizing: border-box;
    }
    h2 {
      margin: 0 0 4px;
      font-size: 1.05rem;
      color: var(--accent);
    }
    .subtitle {
      margin: 0 0 14px;
      font-size: 0.8rem;
      color: var(--muted);
    }
    dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 6px 12px;
      margin: 0;
    }
    dt {
      font-size: 0.78rem;
      color: var(--muted);
      font-weight: 600;
      white-space: nowrap;
    }
    dd {
      margin: 0;
      font-size: 0.85rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      word-break: break-word;
    }
  </style>
  <div class="card">
    <h2>Velocity Webex Calling</h2>
    <p class="subtitle">Phase 1 scaffold — placeholder only, no calling logic yet.</p>
    <dl>
      <dt>Access token</dt><dd id="f-token">(none)</dd>
      <dt>Token scope claim</dt><dd id="f-scope">(none)</dd>
      <dt>Agent ID</dt><dd id="f-agent">(none)</dd>
      <dt>Org ID</dt><dd id="f-org">(none)</dd>
      <dt>Dark mode</dt><dd id="f-dark">false</dd>
    </dl>
  </div>
`;

export class VelocityWebexCallingElement extends HTMLElement {
  static get observedAttributes(): readonly ObservedAttribute[] {
    return OBSERVED_ATTRIBUTES;
  }

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const shadow = this.attachShadow({ mode: 'open' });
      shadow.innerHTML = SHELL_HTML;
    }
    this.render();
  }

  attributeChangedCallback(): void {
    if (this.shadowRoot) this.render();
  }

  private render(): void {
    const shadow = this.shadowRoot;
    if (!shadow) return;

    const token = this.getAttribute('access-token') ?? '';
    const agentId = this.getAttribute('agent-id') ?? '';
    const orgId = this.getAttribute('org-id') ?? '';
    const darkMode = this.getAttribute('dark-mode') === 'true';

    const { scope, decodable } = decodeJwtScope(token);
    const scopeDisplay = !token ? '(none)' : decodable ? scope ?? '(decoded — no scope claim present)' : 'opaque / undecodable';

    this.setText(shadow, '#f-token', maskToken(token));
    this.setText(shadow, '#f-scope', scopeDisplay);
    this.setText(shadow, '#f-agent', agentId || '(none)');
    this.setText(shadow, '#f-org', orgId || '(none)');
    this.setText(shadow, '#f-dark', String(darkMode));
  }

  // Assigns via textContent (never innerHTML) so attribute values sourced
  // from the desktop layout's $STORE bindings can never inject markup.
  private setText(shadow: ShadowRoot, selector: string, value: string): void {
    const el = shadow.querySelector(selector);
    if (el) el.textContent = value;
  }
}

if (!customElements.get(TAG_NAME)) {
  customElements.define(TAG_NAME, VelocityWebexCallingElement);
}
