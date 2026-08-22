# PROGRESS — velocity-webex-calling-widget

Orchestrator-maintained checkpoint. This is the resume point if the session dies.
Restart protocol: new Claude Code session in this repo → kickoff prompt + "Resume from PROGRESS.md".

**Project:** Webex Calling widget inside the WxCC Agent Desktop.
**Governing docs (in repo):** `BUILD-PLAN.md` (how), `DEV-HANDOFF.md` (what/why).
**Repo root:** `velocity-webex-calling-widget/` (inside the "Velocity Webex Project" folder).

## Phase status

| Phase | Name | Model/Effort | Gate | Status |
|---|---|---|---|---|
| 0 | Discovery & verification | Sonnet · high | yes | DONE — probe run; AUTH DECISION PENDING (see gate log) |
| 1 | Scaffold, CI, Pages | Sonnet · low | yes | DONE — Pages LIVE, gate cleared |
| 2 | Auth module | Opus · medium | yes (self-OAuth) | IN PROGRESS (subagent) |
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

- 2026-08-22 **Gate 0 — token probe result (Erik ran it):**
  - `Calling.init()` ok; webex `ready` fired; `wrapper.register()` RESOLVED → the desktop
    `$STORE.auth.accessToken` is a valid Webex token (device + mercury registration succeed).
  - BUT `calling.callingClient` never materialized (15s timeout) → calling-client init failed.
  - **Conclusion: `$STORE` passthrough does NOT support Webex Calling line registration.**
    → **Auth architecture = self-OAuth** (widget runs its own Webex OAuth for the calling user).
  - Caveat the probe can't distinguish: timeout = missing calling *scopes* (self-OAuth fixes) OR
    agent missing a Webex Calling *license/line* (Control Hub §7b — must confirm; self-OAuth won't
    help if unlicensed). Agent uses the Cisco Call line in Teams per handoff, so licensed is likely.
  - Consequence (from Phase 0 PKCE finding): self-OAuth REQUIRES a small serverless token-exchange
    backend holding the client_secret — pure browser OAuth is impossible on Webex. Backend host TBD.
  - Erik decisions (2026-08-22): (1) self-OAuth CONFIRMED; (2) backend host = **decide at Phase 2**
    (Phase 2 to design host-agnostic /authorize,/token,/refresh interface, host chosen before impl);
    (3) proceed to Phase 1 now. Control Hub §7 a–d still OPEN, continue in parallel; §7a (RTMS) and
    §7b (Calling license/line) needed before the Phase 3 live smoke test.
- 2026-08-22 **Gate 0 RESOLVED** for the purpose of advancing: auth = self-OAuth; Phase 1 authorized.
- 2026-08-22 **Gate 1 CLEARED:** repo pushed to github.com/epeterson-blueally/velocity-webex-calling-widget
  (public), Pages enabled (Actions source). First run failed at deploy (Pages not yet enabled —
  expected race); re-ran → success. Live bundle: HTTP 200, application/javascript, 4066 bytes at
  `https://epeterson-blueally.github.io/velocity-webex-calling-widget/velocity-webex-calling.js`.
  CI note: GH runners warn actions/*@v4 target Node 20 (deprecated, forced to Node 24) — cosmetic, not failing.
- 2026-08-22 (Phase 1): Scaffold built. Stack: TypeScript 5.9.3 + Webpack 5 (UMD single file) + vitest 4.
  `dist/velocity-webex-calling.js` = 3.97 KiB. Plain `HTMLElement` + Shadow DOM (no Lit) — smaller,
  runtime-dependency-free. Webpack `resolve.fallback` + `ProvidePlugin(process)` pre-wired with the full
  DISCOVERY §5 Node-polyfill list so Phase 3 can import @webex/calling with zero build rework.
  `@webex/calling`/`@wxcc-desktop/sdk` NOT installed yet (Phase 3/5). `.npmrc save-exact=true`; lockfile present.
  Placeholder card echoes access-token (masked, first/last 4), decoded JWT **scope claim** (Gate-0 addition —
  gives an exact in-desktop scope reading), agent-id, org-id, dark-mode. `textContent` only (no innerHTML).
  `.github/workflows/deploy.yml`: push→main builds+tests+deploys dist/ to Pages.
  **Orchestrator verification:** `npm run build` ✓, `npm test` 3/3 ✓, YAML valid, no secrets, and an
  independent headless-jsdom load of the BUILT bundle confirmed element registration + masked token
  (no raw-token leak) + scope decode. Note: files outside the project folder render as static snapshots
  in the Browser pane (scripts don't run) — use jsdom/vitest for automated checks, not the pane.
