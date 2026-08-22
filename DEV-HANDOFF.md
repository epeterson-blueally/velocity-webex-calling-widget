# Dev Handoff — Webex Calling control inside the WxCC Agent Desktop

**For:** a Claude Code session that will build this.
**Status:** brief only — no code written yet. Read §0 first, resolve the unknowns, then build.

---

## What we're building

A **custom Webex Contact Center Agent Desktop widget** that gives the agent control of their **personal Webex Calling line** (the "Cisco Call" line, same one they use in MS Teams) without leaving the Agent Desktop, and that drives the agent's WxCC state to a `Non-Contact Center Call` idle code while a personal call is up.

Two Cisco SDKs, one widget:
- **`@webex/calling`** (Webex Web Calling SDK) — WebRTC softphone for the personal line: register the line, make/receive audio calls, hold/resume, transfer, mute, end, DTMF.
- **`@wxcc-desktop/sdk`** (WxCC Agent Desktop SDK) — read the desktop store (token, agent id), and set/restore the agent's idle state on personal-call start/end.

The widget is loaded as a web component from the desktop layout JSON.

## Why (context that constrains the build)

- The embedded Webex App in the desktop (`desktopChatApp.webexConfigured: true`, already enabled for this org) has **no call control** — Cisco requires the external app for calls. So we cannot use it; we build our own softphone with the Web Calling SDK.
- The agent currently shows **"In a Meeting"** on a personal call. That's the WxCC↔MS Teams **presence connector** mapping Teams "On a Call" → an idle code named "In a Meeting" — not the phone. Our widget will set the WxCC state **directly** via `@wxcc-desktop/sdk`, which is more precise and avoids the connector's ~12 s (up to ~40 min first sign-in) lag. Leave the Teams connector alone for the outward WxCC→Teams direction ("In a call" in Teams already works).

## §0 — Resolve these BEFORE writing code

1. **OAuth scopes for `@webex/calling`** — confirm the exact scope list against the current SDK quickstart (developer.webex.com/docs/sdks/webex-calling-sdk). Expected to include `spark:calls_read`, `spark:calls_write`, `spark:xsi` and a WebRTC/registration scope — **do not assume; verify.**
2. **Token source** — determine whether the desktop's `$STORE.auth.accessToken` (passed into the widget) carries calling scopes.
   - If yes: consume it directly.
   - If no (likely): the widget runs its **own** OAuth (authorization-code flow) for the Webex Calling user and manages its own token + refresh.
3. **Media platform** — confirm tenant is on the next-generation media platform (RTMS).
4. **Hosting** — decide where the bundled widget JS is served from (HTTPS required).
5. **ACD voice endpoint for the agent** — WebRTC "Desktop" endpoint vs. Webex Calling extension — and confirm it co-exists with this widget in the same browser (two WebRTC audio contexts → watch device selection/echo).

## Build steps

1. **Scaffold.** `npm install @webex/calling @wxcc-desktop/sdk`. Bundler: Webpack (Cisco has a "widget bundling with Webpack" guide). Output a single JS asset that defines one custom element, `<velocity-webex-calling>`.
2. **Clone the reference samples** and lift patterns:
   - Calling: `github.com/WebexSamples/web-calling-sdk-samples`
   - WxCC widget + Agent Desktop SDK: `github.com/WebexSamples/webex-contact-center-api-samples` (see `widget-samples/iframe-widget-sample` and the Agent Desktop SDK usage).
3. **Softphone (`@webex/calling`).** Init calling client with the token → register the line (device registration) → build handlers: outbound dial + DTMF; inbound call notify + answer/decline; hold/resume; transfer (blind + consult); mute; end. Handle re-register on token refresh / socket drop.
4. **Desktop integration (`@wxcc-desktop/sdk`).** `Desktop.config.init()`. Capture current agent state; on personal-call **connected** → set Idle with idle code `Non-Contact Center Call`; on **ended** → restore prior state. Subscribe to desktop events so a personal call and an incoming ACD interaction don't both grab the agent silently.
5. **Idle code.** Ensure `Non-Contact Center Call` exists: Control Hub → Contact Center → Desktop Experience → Auxiliary Codes → add Idle code. (The widget references it by name/id — confirm which the SDK expects.)
6. **Bundle + host** over HTTPS.
7. **Register in the desktop layout** (see below), publish, assign to the demo agent's team.
8. **Test** against the acceptance criteria.

## Custom-element contract

Define `<velocity-webex-calling>` accepting these attributes (bound from the layout `$STORE`):

| Attribute | Source | Use |
|---|---|---|
| `access-token` | `$STORE.auth.accessToken` | token, IF it carries calling scopes; else ignore and self-OAuth |
| `agent-id` | `$STORE.agent.agentId` | context/logging |
| `org-id` | `$STORE.agent.orgId` | context |
| `dark-mode` | `$STORE.app.darkMode` | theming |

Internally the widget uses `@wxcc-desktop/sdk` (not attributes) to read/set agent state.

## Desktop layout entry (add to the `navigation` array of the `agent` persona; optionally `supervisorAgent`)

The current layout lives in the project folder as `Custom_Desktop_Layout_Webex_App.json`. Model follows the existing `digital-outbound` header entry (`comp` + `script` + `$STORE` attributes).

```json
{
  "nav": {
    "label": "Webex Calling",
    "icon": "handset",
    "iconType": "momentum",
    "navigateTo": "webex-calling",
    "align": "top"
  },
  "page": {
    "id": "webex-calling-page",
    "useFlexLayout": true,
    "widgets": {
      "comp1": {
        "comp": "velocity-webex-calling",
        "script": "https://YOUR-HTTPS-HOST/velocity-webex-calling.js",
        "attributes": {
          "access-token": "$STORE.auth.accessToken",
          "agent-id": "$STORE.agent.agentId",
          "org-id": "$STORE.agent.orgId",
          "dark-mode": "$STORE.app.darkMode"
        },
        "wrapper": { "title": "Webex Calling", "id": "webex-calling-w1" },
        "width": 12,
        "height": 19
      }
    }
  }
}
```

Lighter alternative if web-component packaging is a pain: host a standalone page and embed via an `agentx-wc-iframe` widget instead.

## Acceptance criteria

- [ ] Line registers; outbound call connects with two-way audio; DTMF works.
- [ ] Inbound personal call appears in the widget; answer/decline from the desktop.
- [ ] Hold/resume, transfer (blind + consult), mute, end all work.
- [ ] On personal-call connect, WxCC shows `Non-Contact Center Call`; on end, prior state restored; **no ACD contact routes during the personal call** (RONA avoided).
- [ ] Teams still shows "In a call" during the personal call (outward path unaffected).
- [ ] Token refresh does not drop an active registration/call.
- [ ] Personal call + incoming ACD interaction behave sanely (no silent double-answer).
- [ ] Runs on Chromium (Chrome/Edge), not VDI (WebRTC unsupported on VDI).

## Watch out for

- **Shared line**: the personal line is registered on this widget **and** the background Webex App **and** Cisco Call in Teams. Multiple registrations are supported, but a call can ring/answer in the wrong surface — make the widget the primary answer point for the demo and rehearse.
- **Two WebRTC engines** in one browser (widget + WxCC WebRTC ACD endpoint) → explicit audio-device selection, test for echo.
- **Support boundary**: this widget is our code; Cisco supports the framework, not the widget. Fine for demo/POC; revisit for production.

## Reference links

- Web Calling SDK: developer.webex.com/docs/sdks/webex-calling-sdk · samples: github.com/WebexSamples/web-calling-sdk-samples
- Agent Desktop SDK + custom widgets: developer.webex.com/blog (custom widgets; Agent Desktop SDK; widget bundling with Webpack) · samples: github.com/WebexSamples/webex-contact-center-api-samples
- Create custom desktop layout: help.webex.com/article/ng08gqeb
- WxCC↔MS Teams state sync (context for the state behavior): help.webex.com/article/n1sztxbb
- Use Webex App in WxCC Desktop (embedded-app no-call-control note): help.webex.com/article/n444dol
