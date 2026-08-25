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
| 2 | Auth module | Opus · medium | yes (self-OAuth) | DONE (built + defect fixed + verified) — AWAITING ERIK GATE |
| 3 | Calling core | Opus · high | yes | CODE DONE + verified; LIVE GATE pending (blocked on Gate 2) |
| 4 | Transfers (blind + consult) | Opus · high | no | DONE + verified (265 tests) |
| 5 | WxCC desktop-state integration | Opus · medium | yes | DONE + verified (288 tests) — idle-code gate open |
| 6 | UI & dial pad | Sonnet · medium | no | DONE + verified (314 tests) |
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

## Phase 2 review note (orchestrator)

- Orchestrator diff review caught a real defect: the OAuth callback posted with
  `targetOrigin = Pages origin`, but under the web-component packaging (primary; the layout JSON
  uses `comp`+`script`) the widget runs in the Agent Desktop document → opener is DESKTOP-origin →
  the browser silently drops the message → sign-in never completes. Fix in progress: carry the
  opener origin inside the OAuth `state`; callback targets that origin; widget still validates
  ev.origin===Pages + nonce. **FIXED + verified** (28/28 tests, tsc clean, build ok): state =
  base64url(JSON{n:nonce,o:openerOrigin}); callback validates `o` and targets it, falls back to '*'
  only on decode failure (message carries only a one-time code guarded by PKCE+nonce, no secret).
- RESIDUAL live-only risk (Phase 3 gate): even with the targetOrigin fix, COOP/cross-origin-embed
  policy in the real Agent Desktop could sever `window.opener` for a popup opened from a
  cross-origin-embedded widget. Must validate the popup→opener postMessage bridge in the live
  desktop; if severed, fallback = iframe packaging (agentx-wc-iframe, Pages-origin) or a
  BroadcastChannel/localStorage-relay design. Also flagged for Phase 8 LENS B.

## Phase 3 summary + carried decisions (orchestrator)

- Built src/state (SDK-free CallFsm) + src/calling (CallingController, CallingBackend adapter seam,
  WebexCallingBackend = only @webex/calling importer, bootstrap = live SDK-init seam, MuteAdapter).
  FSM states: idle · dialing · ringing_in · connecting · connected ⇄ held · ended. Guards: terminal,
  identity (unknown callId ignored), phase (out-of-order CONNECT/ESTABLISHED/HELD/RESUMED = no-ops).
  Answer-second-inbound modeled (pendingInbound + heldCall promotion). Re-register on token change +
  bounded exponential backoff on socket drop. Verified by orchestrator: `tsc` clean, `npm run lint`
  clean (no-floating-promises + no-misused-promises, type-checked, confirmed active), **225/225 tests**
  (incl. the out-of-order matrix), `npm run build` ok. Bundle grew 3.97 KiB → **2.58 MiB** (SDK bundled).
- **CARRIED DECISION — MUST RESOLVE BY PHASE 7 (packaging):** bootstrap inits the live client from the
  CDN UMD global `Calling` (the `webex` monolith wrapper), because @webex/calling's `createClient` needs
  a full `webex` core only the monolith assembles. But webex-backend.ts ALSO bundles @webex/calling
  (for its enums) → the 2.58 MiB bundle STILL needs a CDN `<script>` at runtime. The production widget
  is loaded as a SINGLE script via the layout JSON, so `globalThis.Calling` won't exist unless we bundle
  the `webex` monolith (preferred — self-contained, no CDN/CSP risk) or have the widget inject the CDN
  script. Harness works today (it loads the CDN script), so the Phase 3 harness gate is unaffected; the
  REAL-desktop load needs this resolved. Decision: bundle the monolith in Phase 6/7.
- **Phase 3 LIVE GATE is blocked on Gate 2**: the harness smoke test (register/dial/answer) needs a
  token carrying calling scopes, which only exists after the Webex Integration + Cloudflare backend
  (Gate 2) are live and a real sign-in completes. So Gate 2 → then Phase 3 live smoke test.
- UNRESOLVED for the Phase 3 live gate: (1) mute toggle-vs-idempotent (adapter handles both; confirm
  live); (2) token-refresh mid-call — controller re-registers on token change, but the webex core is
  built once by bootstrap with the initial token; mid-call refresh reinit path is unproven live;
  (3) two-WebRTC-engine echo / audio device selection (human-verified in harness, Phase 6 adds picker).

## Phase 4 summary (orchestrator)

- Transfers added. Explicit `'consulting'` FSM state with a dedicated `consult:{primary,consult,phase}`
  slot owning BOTH legs (NOT overloading heldCall/pendingInbound — those model the independent
  answer-second-inbound call). Controller: blindTransfer/startConsult/completeConsult/cancelConsult.
  Failure handling verified: (a) consult-leg dial error → held primary; (b) target declines/disconnect
  → held primary; (c) PRIMARY hangs up mid-consult → consult leg PROMOTED to foreground (agent keeps
  talking to the target), lastError names the dead leg. Verified: tsc clean, lint clean, **265/265
  tests** (+40), build ok. SDK stays behind CallingBackend; FSM SDK-free. Harness has transfer controls.

## Phase 5 summary (orchestrator)

- src/desktop as a decoupled FSM SUBSCRIBER (design rule 2 — verified: no @webex/calling in src/desktop,
  no @wxcc-desktop/sdk in src/calling). DesktopStateManager: on connected→capture state + set Idle(NCC
  id resolved by name); on ended→restore ONLY if state still exactly matches what we set (else log,
  don't clobber). ACD interaction offered mid-personal-call → banner, no auto-answer (module has no
  answer capability by construction = RONA-safe). @wxcc-desktop/sdk@3.0.1 pinned.
- IMPORTANT detail: @wxcc-desktop/sdk throws at IMPORT time outside the desktop (reads global
  AGENTX_SERVICE). So it's NEVER statically imported — guarded by `'AGENTX_SERVICE' in globalThis`, then
  eager dynamic `import()`. Orchestrator verified via jsdom: built bundle loads with NO throw standalone,
  element registers, present=false. Real correction to DISCOVERY: `Desktop.config.init` REQUIRES a
  config arg ({widgetName,widgetProvider}), not the bare init() DISCOVERY assumed.
- Verified: tsc clean, lint clean, **288/288 tests**, build ok. Bundle now 2.9 MiB.

## Phase 6 summary + tracked gaps (orchestrator)

- src/ui (13 files) — pure views rendering from WidgetStatus, calling only UiActions (verified: no
  @webex/calling / @wxcc-desktop/sdk imports in src/ui; no external font/CDN). src/index.ts rewritten:
  element wires TokenProvider (OAuth default when client-id+redirect-uri+auth-base-url present; Store
  fallback) → CallingController → DesktopStateManager → CallingWidgetView. Deferred eager import() of
  ./calling keeps src/index static graph SDK-free. Ring tone = WebAudio (gesture-armed), device ids in
  localStorage only (token-safe, test-verified). Verified: tsc/lint clean, **314/314 tests**, single-file
  bundle 2.92 MiB. Render check (jsdom+fetch stub): sign-in gate renders, dark-mode applies.
- **TRACKED GAP 1 (functional, fix before Phase 7):** mic DEVICE selection is enumerated/persisted/
  reported but NOT threaded into SDK capture — MicStreamFactory is `{audio:boolean}` only. Speaker
  (setSinkId) works. Fix with the pre-Phase-7 calling change (widen MicStreamFactory to pass
  {audio:{deviceId}}). Matters for the two-WebRTC-engine echo/device acceptance criterion.
- **TRACKED GAP 2 — FIXED (pre-Phase-7):** OAuthTokenProvider no longer binds globalThis.fetch at
  construction (guards for its absence; requireFetch()/doRefresh reject cleanly at point of use); the
  element's connectedCallback wraps provider construction in try/catch → visible error state, never
  throws. Unit test added (315 tests).
- **PRE-PHASE-7 orchestrator task list:** (a) bundle the `webex` monolith so bootstrap no longer needs
  a CDN `Calling` global (self-contained single script) — STILL DEFERRED to Phase 7 (only needed for the
  real in-desktop load; the live-test page uses CDN); (b) copy public/oauth-callback.html into the Pages
  deploy — DONE (copy-webpack-plugin emits it + live-test.html into dist/); (c) GAP 1 mic deviceId —
  STILL DEFERRED (SDK mic-constraint shape is live-verifiable; not needed for the smoke test; the failed
  subagent's partial mic edit was reverted); (d) GAP 2 fetch guard — DONE.
- 2026-08-22 **Enablement DONE (bridging Phase 6→7):** copy-webpack-plugin@14.0.0 wires the build to emit
  `dist/oauth-callback.html` + `dist/live-test.html`. `public/live-test.html` = Pages-hosted page that
  runs the REAL widget (calling SDK from CDN, bundle via ./relative) with Client ID + Worker URL inputs →
  the Phase 3+4 live smoke test with no desktop needed. Fetch-guard hardened. tsc/lint clean, 315 tests,
  build emits all three files. NOTE: the failed pre-live subagent (session limit) left partial edits;
  kept its complete fetch-guard, reverted its broken mic edit, finished the rest here.
- **⚠️ DEPLOY STATE:** origin/Pages is still serving the Phase-1 placeholder — commits phase-2..6 +
  enablement are LOCAL ONLY (Erik chose manual git). Erik must `git push origin main` to deploy the real
  widget + callback + live-test page before the live smoke test.

## Open questions / pending gate answers

- [ ] **Phase 0 gate (Erik) — OPEN, blocks Phase 1 start.** Two parts:
      1. Token probe (`test/token-probe.html`) with a live desktop `$STORE.auth.accessToken` →
         does `line.register()` succeed? Decides `$STORE` passthrough vs self-OAuth. If self-OAuth,
         a serverless token backend is mandatory (see PKCE finding) — that's a scope/cost decision.
      2. Control Hub checklist (DISCOVERY §7 a–d): RTMS media platform, agent Calling license + line,
         `Non-Contact Center Call` idle code existence + ID, ACD endpoint type (WebRTC vs extension).
- [ ] Empirical (deferred to Phase 3 live test): `ICall.mute()` twice — toggle or idempotent?
      No `unmute()` in typings; confirm against a live call.
- [x] **Gate 2 part 1 (Webex Integration) — DONE 2026-08-22:** Integration created ("Request OAuth
      to invoke Webex APIs on behalf of another user"). Client ID received, stored in the git-ignored
      `PILOT-CONFIG.local.md` (NOT committed; goes into the Phase 7 layout JSON). Client secret held by
      Erik → Cloudflare Worker only.
- [ ] **Gate 2 part 2 (Cloudflare Worker) — OPEN:** Erik to deploy the Worker and provide the URL
      (→ `auth-base-url`). Still needed for the live smoke test.
- [ ] **Phase 2 gate (Erik) — OPEN, blocks Phase 3 (calling core needs a working token):**
      1. Create a Webex Integration at developer.webex.com/my-apps with scopes
         `spark:calls_read spark:calls_write spark:xsi spark:webrtc_calling`, redirect URI =
         `https://epeterson-blueally.github.io/velocity-webex-calling-widget/oauth-callback.html`.
         Provide the **client ID** (→ `client-id` attribute). The **client_secret** stays secret,
         goes ONLY into the serverless backend env — never in the repo/bundle.
      2. Choose the serverless backend host (Cloudflare Workers / AWS Lambda / Azure Functions) and
         we deploy the /token + /refresh contract (docs/auth-backend-contract.md) there.
      NOTE: callback page (public/oauth-callback.html) deploy-wiring is deferred to Phase 7 (Pages
      workflow currently ships dist/ only); the redirect URI above assumes it lands at Pages root.

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
  - 2026-08-22 **Backend host decided:** pilot = **Cloudflare Workers** (cheap, personal/non-corporate,
    one-command deploy). Production later = Azure Functions (contract is host-agnostic, so Azure is a
    re-impl of the same /token + /refresh, no widget change). Orchestrator to write the Worker.
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
