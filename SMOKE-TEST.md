# Live Smoke Test Runbook — Velocity Webex Calling

A hosted, no-desktop smoke test of the real widget: sign in with self-OAuth, register
the personal Webex Calling line, and exercise call control. Runs the actual
`<velocity-webex-calling>` element on GitHub Pages with the calling SDK loaded from CDN.

> **Config values (Client ID, Worker URL, demo account) are in `PILOT-CONFIG.local.md`**
> (git-ignored, next to this file). They're kept out of git on purpose; paste them from there.

---

## Preconditions
- **Chrome or Edge only** — not Firefox (no speaker enumeration / WebRTC differences), not VDI.
- Use a **fresh Incognito/Private window** — avoids cached-SSO account mismatch.
- Allow **popups** and **microphone** for the Pages origin when prompted.
- **One clean session.** Don't click **Apply** repeatedly or open multiple widget tabs — each is a
  device registration. (The widget now deregisters on teardown, but a clean single session is best.)
- Ideally sign the shared line **out of the background Webex App / Teams** so you don't hit the
  per-user device limit.
- Sign in as the **licensed demo agent** (see `PILOT-CONFIG.local.md`), consistently, at the popup.

## Config to paste
- **URL:** `https://epeterson-blueally.github.io/velocity-webex-calling-widget/live-test.html`
- **Client ID:** _(from `PILOT-CONFIG.local.md`)_
- **Worker URL (auth-base-url):** _(from `PILOT-CONFIG.local.md`)_
- **Redirect URI:** auto-fills on the page — leave it.

## Steps
1. Open the URL → paste **Client ID** + **Worker URL** → **Apply**.
2. Click **Sign in to Webex Calling** → sign in as the demo agent → approve scopes → popup closes.
3. Status bar shows **Line registered**.
4. Enter the **target's extension** (digits only) in the dial field → **Call**.

## Dialing rule (important)
The line dials **phone numbers / extensions only — digits** (`0-9 * # + ( ) . -`). It **cannot**
dial emails or SIP addresses (the `@webex/calling` SDK rejects them). Get the target's number from
**Control Hub → Users → _user_ → Calling → extension / directory number**. Same-location users:
dial the **extension** — most reliable non-PSTN test.

## Test checklist
| # | Test | Pass? |
|---|---|---|
| a | Line registers after sign-in | ☐ |
| b | Outbound to an extension → **two-way audio** | ☐ |
| c | DTMF: press digits mid-call (tones audible / IVR responds) | ☐ |
| d | Inbound: call the agent's line from another device → ring + **answer/decline** → audio | ☐ |
| e | Hold / resume | ☐ |
| f | Mute / unmute | ☐ |
| g | Blind transfer to a third extension completes | ☐ |
| h | Consult transfer: dial consult → talk → **complete** (join); then **cancel** (resume) | ☐ |

## If something fails — capture the log
1. **DevTools (F12) → Console** → enable **Preserve log** (so nothing clears on navigation).
2. Reproduce the failure.
3. Right-click the console → **Save as…** (or copy all), and send the file/text to the orchestrator.

## Known issues / gotchas seen so far
- **"Invalid phone number detected" / no call:** you dialed a non-numeric address (email/SIP). Use a
  number/extension.
- **"Sign-in failed: invalid scope":** the Webex Integration is missing a scope — all four must be on
  it (`spark:calls_read`, `spark:calls_write`, `spark:xsi`, `spark:webrtc_calling`).
- **SSO "use the same email":** a different account is cached — use a fresh Incognito window.
- **Stuck "Reconnecting" / device-limit / 429:** was caused by leaked registrations (fixed — the
  widget now deregisters on teardown). If it recurs, close extra tabs and wait ~20–30 min for stale
  registrations to expire.
- **Firefox "no speaker devices found":** expected — Firefox hides audio-output devices. Use Chrome/Edge.

## Not covered here (Chromium test page only — validated later in the real Agent Desktop)
- Idle-code state set/restore (`Non-Contact Center Call`) and ACD-interleave behavior.
- Two-WebRTC-engine **echo** (no ACD engine on this page).
- OAuth popup surviving the desktop **iframe** (here the widget is top-level).
