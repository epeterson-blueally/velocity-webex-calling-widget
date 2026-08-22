# PROGRESS — velocity-webex-calling-widget

Orchestrator-maintained checkpoint. This is the resume point if the session dies.
Restart protocol: new Claude Code session in this repo → kickoff prompt + "Resume from PROGRESS.md".

**Project:** Webex Calling widget inside the WxCC Agent Desktop.
**Governing docs (in repo):** `BUILD-PLAN.md` (how), `DEV-HANDOFF.md` (what/why).
**Repo root:** `velocity-webex-calling-widget/` (inside the "Velocity Webex Project" folder).

## Phase status

| Phase | Name | Model/Effort | Gate | Status |
|---|---|---|---|---|
| 0 | Discovery & verification | Sonnet · high | yes | DONE (subagent) — AWAITING ERIK GATE |
| 1 | Scaffold, CI, Pages | Sonnet · low | yes | not started |
| 2 | Auth module | Opus · medium | maybe | not started |
| 3 | Calling core | Opus · high | yes | not started |
| 4 | Transfers (blind + consult) | Opus · high | no | not started |
| 5 | WxCC desktop-state integration | Opus · medium | yes | not started |
| 6 | UI & dial pad | Sonnet · medium | no | not started |
| 7 | Deploy, layout JSON, test runbook | Sonnet · low | yes | not started |
| 8 | Adversarial code review | Opus · high | yes | not started |

## Decisions made

- 2026-08-22: Repo created locally at `velocity-webex-calling-widget/`; governing docs and base
  layout JSON (`Custom_Desktop_Layout_Webex_App.json`) copied in so phase subagents can resolve
  references. GitHub repo creation + Pages enablement is Erik's gate at Phase 1.
- 2026-08-22 (Phase 0): Full findings in `DISCOVERY.md`. Key decisions locked:
  - **Pinned versions:** `@webex/calling@3.12.0`, `@wxcc-desktop/sdk@3.0.1` (from live npm registry).
  - **OAuth scopes:** `spark:calls_read`, `spark:calls_write`, `spark:xsi`, `spark:webrtc_calling`.
  - **PKCE finding (consequential):** Webex has NO public-client option — the token exchange
    ALWAYS requires `client_secret`. PKCE is CSRF hardening, not a secret replacement. So IF we go
    self-OAuth, a tiny serverless token-exchange backend (holds the secret) is REQUIRED — a pure
    browser PKCE flow is impossible. This is the BUILD-PLAN §1 rule-5 "secrets" gate.
  - **Desktop set-state API:** `Desktop.agentStateInfo.stateChange({state:'Idle', auxCodeIdArray:<id>})`
    — takes the idle-code **ID (a string, despite the "Array" name), not the name**. Enumerate via
    `Desktop.agentStateInfo.latestData.idleCodes` (post-init) or `fetchOrganizationIdleCodes(orgId)`.
    Resolve the ID at runtime by matching `.name === 'Non-Contact Center Call'`; never hardcode.
  - **Call control (`ICall`, from shipped 3.12.0 typings):** `dial/answer(localAudioStream)`,
    `doHoldResume()` (a TOGGLE, no boolean), `mute(stream, MUTE_TYPE?)` (no `unmute()` — read `isMuted()`),
    `sendDigit(tone)` one digit at a time, `completeTransfer(TransferType.BLIND|CONSULT, transferCallId?, transferTarget?)`,
    `end()`. Webpack must add Node polyfills (http/https/crypto/stream/os/url + `process/browser`).
  - **No Cisco sample combines `@webex/calling` + `@wxcc-desktop/sdk`** — this integration is novel.
  - `reference/` (249M of clones) is git-ignored per plan; patterns extracted into DISCOVERY.md.

## Open questions / pending gate answers

- [ ] **Phase 0 gate (Erik) — OPEN, blocks Phase 1 start.** Two parts:
      1. Token probe (`test/token-probe.html`) with a live desktop `$STORE.auth.accessToken` →
         does `line.register()` succeed? Decides `$STORE` passthrough vs self-OAuth. If self-OAuth,
         a serverless token backend is mandatory (see PKCE finding) — that's a scope/cost decision.
      2. Control Hub checklist (DISCOVERY §7 a–d): RTMS media platform, agent Calling license + line,
         `Non-Contact Center Call` idle code existence + ID, ACD endpoint type (WebRTC vs extension).
- [ ] Empirical (deferred to Phase 3 live test): `ICall.mute()` twice — toggle or idempotent?
      No `unmute()` in typings; confirm against a live call.

## Gate log

_(none resolved yet)_
