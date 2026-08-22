/**
 * Shared styling for the widget — Momentum-adjacent (Cisco's Agent Desktop design
 * language), self-contained (no external font/CDN dependencies; system font stack
 * only, per BUILD-PLAN.md Phase 6). One `<style>` block, injected once into the
 * element's shadow root; theming is driven entirely by the `dark-mode` host
 * attribute so it stays in sync with the Agent Desktop shell.
 */

export const WIDGET_STYLES = `
  :host {
    display: block;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.4;
    --vw-bg: #ffffff;
    --vw-surface: #f7f9fa;
    --vw-fg: #1a1a1a;
    --vw-muted: #6b6b6b;
    --vw-border: #dfe4e8;
    --vw-accent: #00838f;
    --vw-accent-fg: #ffffff;
    --vw-danger: #c62828;
    --vw-danger-fg: #ffffff;
    --vw-success: #2e7d32;
    --vw-warning: #a15c00;
    --vw-warning-bg: #fff4e0;
    --vw-danger-bg: #fdecea;
    --vw-focus: #0a6cbc;
    color: var(--vw-fg);
    box-sizing: border-box;
  }
  :host([dark-mode="true"]) {
    --vw-bg: #1e2224;
    --vw-surface: #262b2e;
    --vw-fg: #eef1f2;
    --vw-muted: #a7afb3;
    --vw-border: #3a4145;
    --vw-accent: #4dd0e1;
    --vw-accent-fg: #0b2226;
    --vw-danger: #ef5350;
    --vw-danger-fg: #2a0a08;
    --vw-success: #66bb6a;
    --vw-warning: #ffb74d;
    --vw-warning-bg: #3a2c12;
    --vw-danger-bg: #3a1414;
    --vw-focus: #4dd0e1;
  }
  * { box-sizing: border-box; }
  .vw-root {
    background: var(--vw-bg);
    color: var(--vw-fg);
    border: 1px solid var(--vw-border);
    border-radius: 10px;
    padding: 14px;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  button {
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    border: 1px solid var(--vw-border);
    background: var(--vw-surface);
    color: var(--vw-fg);
    border-radius: 8px;
    padding: 8px 10px;
  }
  button:hover:not(:disabled) { border-color: var(--vw-accent); }
  button:focus-visible { outline: 2px solid var(--vw-focus); outline-offset: 1px; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.vw-primary { background: var(--vw-accent); color: var(--vw-accent-fg); border-color: var(--vw-accent); }
  button.vw-danger { background: var(--vw-danger); color: var(--vw-danger-fg); border-color: var(--vw-danger); }
  button.vw-icon { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  button.vw-icon svg { width: 16px; height: 16px; flex: none; }
  input[type="text"], input[type="tel"], select {
    font-family: inherit;
    font-size: inherit;
    color: var(--vw-fg);
    background: var(--vw-surface);
    border: 1px solid var(--vw-border);
    border-radius: 8px;
    padding: 7px 9px;
    width: 100%;
  }
  input:focus-visible, select:focus-visible { outline: 2px solid var(--vw-focus); outline-offset: 1px; }

  .vw-row { display: flex; gap: 8px; align-items: center; }
  .vw-row.vw-wrap { flex-wrap: wrap; }
  .vw-grow { flex: 1 1 auto; min-width: 0; }
  .vw-muted { color: var(--vw-muted); font-size: 12px; }
  .vw-hidden { display: none !important; }

  h2.vw-title { margin: 0; font-size: 1rem; color: var(--vw-accent); font-weight: 600; }

  /* --- status bar --- */
  .vw-status-bar { display: flex; flex-direction: column; gap: 6px; }
  .vw-status-line { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
  .vw-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--vw-muted); }
  .vw-dot.vw-ok { background: var(--vw-success); }
  .vw-dot.vw-warn { background: var(--vw-warning); }
  .vw-dot.vw-bad { background: var(--vw-danger); }
  .vw-banner { border-radius: 8px; padding: 7px 10px; font-size: 12.5px; }
  .vw-banner.vw-warn { background: var(--vw-warning-bg); color: var(--vw-warning); }
  .vw-banner.vw-bad { background: var(--vw-danger-bg); color: var(--vw-danger); }

  /* --- auth gate --- */
  .vw-auth-gate { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }

  /* --- dial pad --- */
  .vw-dialpad-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .vw-dialpad-grid button { padding: 10px 0; font-size: 1.05rem; font-weight: 500; }

  /* --- caller id / timer --- */
  .vw-call-card { border: 1px solid var(--vw-border); border-radius: 8px; padding: 10px; background: var(--vw-surface); display: flex; flex-direction: column; gap: 4px; }
  .vw-caller-name { font-weight: 600; }
  .vw-caller-num { color: var(--vw-muted); font-size: 12.5px; }
  .vw-timer { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--vw-muted); font-size: 12.5px; }

  /* --- ring surface --- */
  .vw-ring-surface {
    border: 1px solid var(--vw-accent);
    border-radius: 10px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--vw-surface);
    animation: vw-pulse 1.4s ease-in-out infinite;
  }
  @keyframes vw-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(0, 131, 143, 0.35); }
    50% { box-shadow: 0 0 0 6px rgba(0, 131, 143, 0.08); }
  }

  /* --- transfer panel --- */
  .vw-transfer-panel { border: 1px solid var(--vw-border); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .vw-tabs { display: flex; gap: 4px; }
  .vw-tabs button { flex: 1 1 0; border-radius: 6px; padding: 6px 8px; font-size: 12.5px; }
  .vw-tabs button.vw-active { background: var(--vw-accent); color: var(--vw-accent-fg); border-color: var(--vw-accent); }
  .vw-error-text { color: var(--vw-danger); font-size: 12px; }

  /* --- device selector --- */
  .vw-device-row { display: flex; flex-direction: column; gap: 4px; }
  .vw-device-row label { font-size: 12px; color: var(--vw-muted); }
`;
