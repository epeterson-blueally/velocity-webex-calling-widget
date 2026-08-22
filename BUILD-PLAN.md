# Build Plan — Webex Calling widget inside the WxCC Agent Desktop

**Project:** Velocity Webex Project · **Companion doc:** `velocity-desktop-callcontrol-DEV-HANDOFF.md` (architecture, constraints, layout JSON — the handoff is the *what/why*; this plan is the *how*).
**Execution model:** one Claude Code session acts as **orchestrator**; it spawns a subagent per phase using the prompts below, holds the gates, and never lets a phase start before its predecessor's exit criteria are met.
**Hosting:** single GitHub repo; built bundle served over HTTPS by **GitHub Pages** for initial testing.
**Scope (confirmed 2026-08-22):** full handoff scope — register line, answer/decline, outbound dial + dial pad, hold/resume, **blind + consult transfer**, mute, DTMF, end — plus automatic WxCC `Non-Contact Center Call` idle-state set/restore via `@wxcc-desktop/sdk`. OAuth approach decided by Phase 0 discovery. Plan ends with an **adversarial code review** phase.

---

## 1. Design summary

One custom element, `<velocity-webex-calling>`, loaded by the WxCC desktop layout JSON (nav-page widget, per the snippet in the handoff §"Desktop layout entry").

```
┌────────────────────────── <velocity-webex-calling> ──────────────────────────┐
│  auth/        token intake ($STORE.auth.accessToken) OR self-OAuth + refresh │
│  calling/     @webex/calling: CallingClient → Line → ICall                   │
│               register · dial · answer · hold/resume · transfer · mute · DTMF│
│  desktop/     @wxcc-desktop/sdk: Desktop.config.init, agent state get/set    │
│  state/       one finite-state machine per call; single source of truth      │
│  ui/          status bar · dial pad · in-call controls · transfer panel      │
└───────────────────────────────────────────────────────────────────────────────┘
        │ personal call connected → Idle("Non-Contact Center Call")
        │ personal call ended     → restore captured prior state
```

Design rules the subagents must follow:

1. **A call FSM owns truth.** UI renders from a small state machine (`idle → ringing_in/dialing → connected → held / consult_pending → ended`); SDK events are the only inputs that move it. No UI-driven state.
2. **The desktop-state module is a subscriber** of the FSM (`connected` → set idle code, `ended` → restore). It never touches calling APIs; calling code never touches desktop APIs.
3. **Auth is an interface** (`getToken(): Promise<string>` + `onTokenRefreshed`) with two implementations — `$STORE` passthrough and self-OAuth — so Phase 0's answer swaps one line, not the code.
4. **Verify SDK API names against the cloned samples/docs before use** — method names in this plan (e.g. `doHoldResume`, `completeTransfer`, `sendDigit`, `stateChange`) are from current docs but each phase re-verifies against the pinned SDK version in the repo.
5. **No secrets in the repo or bundle.** Pages is public. OAuth client ID is public by design; a client *secret* must never ship — if the token flow needs one, that phase stops and raises a gate.

### Repo

`velocity-webex-calling-widget` (Erik creates it; visibility his call — Pages URL is public either way).

```
/src
  index.ts                 # defines the custom element, wires modules
  auth/  calling/  desktop/  state/  ui/
/reference                 # cloned Cisco samples (git-ignored or submodule-less copies)
/test                      # vitest unit tests for the FSM + module seams
/.github/workflows/deploy.yml   # build → upload artifact → deploy to Pages
webpack.config.js          # single-file output: dist/velocity-webex-calling.js
layout/Custom_Desktop_Layout_Webex_Calling.json  # layout with widget entry, generated Phase 7
```

Pinned deps: `@webex/calling` (latest stable at Phase 1 time; docs currently show the 3.x line), `@wxcc-desktop/sdk@3.0.1`. TypeScript, Webpack (Cisco publishes a widget-bundling-with-Webpack pattern), vitest.

---

## 2. Orchestration

Run in Claude Code from the repo root. The orchestrator itself should run on **Opus** (default effort): it makes gate judgments and reviews each subagent's diff, but writes little code itself.

**Orchestrator kickoff prompt** (paste into Claude Code):

```
You are the orchestrator for building the velocity-webex-calling-widget repo.
Read BUILD-PLAN.md (this file) and DEV-HANDOFF.md in full before anything else.

Rules:
- Execute phases 0–8 strictly in order. For each phase, spawn ONE subagent with
  the exact prompt from the plan's phase section, using the model and effort the
  plan specifies for that phase.
- When a subagent finishes, verify the phase's exit criteria yourself (run the
  build, run the tests, read the diff). If criteria fail, re-dispatch the same
  subagent with the failure evidence appended. Do not advance on partial success.
- HUMAN GATES: phases marked with a gate need Erik. Stop, print exactly what he
  must do or decide (and where), and wait. Never fabricate a gate answer.
- Commit at the end of each phase: one commit, message "phase-N: <summary>".
  Never commit tokens, secrets, or tenant identifiers beyond what the layout
  JSON already contains.
- Keep a PROGRESS.md at repo root: phase status, decisions made, open questions.
  Update it every phase; it is the resume point if this session dies.
- Live-call testing cannot be done by you. Where the plan says "manual test",
  produce the runbook/checklist and hand it to Erik at the gate.
```

**Per-phase model & effort:**

| Phase | Name | Model | Effort | Human gate |
|---|---|---|---|---|
| 0 | Discovery & verification | Sonnet | high | yes — Control Hub checks + OAuth decision |
| 1 | Scaffold, CI, Pages deploy | Sonnet | low | yes — create repo, enable Pages |
| 2 | Auth module | Opus | medium | maybe — create Webex Integration if self-OAuth |
| 3 | Calling core | Opus | high | yes — first live registration/call smoke test |
| 4 | Transfers (blind + consult) | Opus | high | no |
| 5 | WxCC desktop-state integration | Opus | medium | yes — confirm idle code exists in Control Hub |
| 6 | UI & dial pad | Sonnet | medium | no |
| 7 | Deploy, layout JSON, test runbook | Sonnet | low | yes — publish layout, live acceptance run |
| 8 | Adversarial code review | Opus | high | yes — sign-off on residual findings |

---

## 3. Phases

### Phase 0 — Discovery & verification *(Sonnet · high · gate)*

**Objective:** kill every §0 unknown in the handoff before code exists.

**Subagent prompt:**

```
You are doing pre-build discovery for a WxCC custom widget that embeds the
Webex Web Calling SDK (@webex/calling) plus the Agent Desktop SDK
(@wxcc-desktop/sdk). Read DEV-HANDOFF.md §0 first. Produce DISCOVERY.md
answering, with citations (URL + quoted text) for every claim:

1. Exact OAuth scope list @webex/calling requires for line registration and
   call control, from the current developer.webex.com Calling SDK
   authorization docs. Do not infer from blog posts.
2. Whether Webex Integrations support authorization-code + PKCE for a pure
   browser app (no client secret), or whether a token-exchange backend is
   required. If PKCE is unsupported, design the smallest viable alternative
   (e.g. short-lived token minted by a tiny serverless endpoint) and flag it.
3. Current stable version of @webex/calling and of @wxcc-desktop/sdk; pin both.
4. The Agent Desktop SDK call for setting agent state with a specific idle
   code (module, method, whether it takes the aux code ID or name), and how
   to enumerate idle codes at runtime.
5. Clone github.com/WebexSamples/web-calling-sdk-samples and
   github.com/CiscoDevNet/webex-contact-center-widget-starter and
   github.com/WebexSamples/webex-contact-center-api-samples into /reference.
   Extract: init sequence, line registration, each call-control method
   signature (hold/resume, transfer blind + consult, mute, DTMF), and the
   widget web-component packaging pattern. Record in DISCOVERY.md.
6. Write a 30-line static test page (test/token-probe.html) that takes a
   pasted access token, inits @webex/calling, and logs whether line
   registration succeeds — this is how we test if $STORE.auth.accessToken
   carries calling scopes.
7. List the checks only a human with Control Hub access can do, as a
   checklist: (a) tenant on next-gen media platform (RTMS), (b) demo agent
   has a Webex Calling license + Cisco Call line, (c) whether an idle code
   named "Non-Contact Center Call" already exists (note its ID if so),
   (d) the agent's ACD voice endpoint type (WebRTC Desktop vs extension).

Return DISCOVERY.md and the probe page. Mark every unresolved item UNRESOLVED
— do not guess.
```

**Exit criteria:** DISCOVERY.md complete, every claim cited or marked UNRESOLVED; probe page loads; reference repos cloned.
**GATE (Erik):** run the Control Hub checklist; open the probe page in the Agent Desktop context (or paste a desktop-harvested token) and report the result → this decides `$STORE` token vs self-OAuth; if self-OAuth, decide PKCE vs backend based on item 2.

### Phase 1 — Scaffold, CI, Pages *(Sonnet · low · gate)*

**Subagent prompt:**

```
Scaffold the velocity-webex-calling-widget repo per BUILD-PLAN.md §1:
TypeScript + Webpack single-bundle build producing
dist/velocity-webex-calling.js that registers a custom element
<velocity-webex-calling> rendering a placeholder card that displays its
access-token (masked), agent-id, org-id, dark-mode attributes. Mirror the
bundling pattern found in /reference (widget starter). Add vitest with one
smoke test. Add .github/workflows/deploy.yml: on push to main, build and
deploy dist/ to GitHub Pages. Add PROGRESS.md and a README with the Pages
URL placeholder. npm run build must pass locally.
```

**Exit criteria:** clean build; element registers in a bare HTML page; workflow YAML valid.
**GATE (Erik):** create the GitHub repo, push, enable Pages (GitHub Actions source), confirm the bundle URL loads over HTTPS.

### Phase 2 — Auth module *(Opus · medium · gate if self-OAuth)*

**Subagent prompt:**

```
Implement src/auth per BUILD-PLAN.md design rule 3 and the Phase 0 decision
recorded in DISCOVERY.md/PROGRESS.md.
- TokenProvider interface: getToken(), onTokenChange(cb), plus explicit
  expiry/refresh semantics.
- StoreTokenProvider: consumes the access-token attribute; watches for
  attribute changes (the desktop refreshes tokens); emits onTokenChange.
- If Phase 0 chose self-OAuth: OAuthTokenProvider implementing
  authorization-code(+PKCE if supported) against Webex, with refresh, token
  kept in memory only (never localStorage), redirect handling that works
  inside the desktop's widget iframe/page context, and a visible "Sign in to
  Webex Calling" button state. Client ID + redirect URI come from element
  attributes, not hardcoded.
- Unit-test both providers with mocked timers/fetch.
No calling SDK code in this phase.
```

**Exit criteria:** tests green; token never persisted; refresh path unit-tested.
**GATE (Erik, only if self-OAuth):** create the Webex Integration on developer.webex.com with the Phase 0 scope list and the Pages redirect URI; provide the client ID.

### Phase 3 — Calling core *(Opus · high · gate)*

**Subagent prompt:**

```
Implement src/calling and src/state against the pinned @webex/calling
version, verifying every method signature against /reference and the SDK's
typings — the plan's method names are hints, the typings are truth.
- Init Calling with the TokenProvider's token; handle the ready event;
  register the line; expose registration status. Re-register on token change
  and on socket drop (bounded exponential backoff; surface status to UI).
- Call FSM (src/state): idle → dialing|ringing_in → connected ⇄ held →
  ended, with events as the only transitions. One active personal call
  supported; a second inbound while connected is offered as answer-and-hold
  or decline.
- Implement: outbound dial (mic stream capture), inbound answer/decline,
  hold/resume, mute/unmute, DTMF sendDigit, end. Wire SDK events (progress,
  connect, established, disconnect, caller-ID updates) into the FSM.
- Every SDK call wrapped with error mapping into FSM error states — no
  unhandled promise rejections.
- Unit-test the FSM exhaustively with a mocked SDK (every event in every
  state, including out-of-order disconnects).
Provide test/harness.html: loads the bundle outside WxCC with a pasted
token so a human can smoke-test register/dial/answer.
```

**Exit criteria:** FSM tests green including out-of-order events; harness builds; no floating promises (lint rule on).
**GATE (Erik):** live smoke test via harness — register the demo agent's line, one outbound + one inbound call with two-way audio, hold/resume, mute, DTMF. Record device-selection/echo observations (two-WebRTC-engine risk).

### Phase 4 — Transfers *(Opus · high)*

**Subagent prompt:**

```
Extend src/calling and the FSM for transfers, verified against the pinned
SDK typings and /reference samples:
- Blind transfer from connected or held.
- Consult transfer: hold primary → create consult call → talk → complete
  (join calls) or cancel (end consult, resume primary). Model consult as an
  explicit FSM sub-state owning BOTH call objects; define behavior when the
  consult leg fails, is declined, or the far end of the primary hangs up
  mid-consult.
- Unit tests for every consult path including the three failure cases above.
Update test/harness.html with transfer controls.
```

**Exit criteria:** all transfer-path tests green; harness exposes both transfer types.

### Phase 5 — WxCC desktop-state integration *(Opus · medium · gate)*

**Subagent prompt:**

```
Implement src/desktop using @wxcc-desktop/sdk@<pinned>, per DISCOVERY.md
item 4:
- Desktop.config.init on element mount (inside the Agent Desktop only —
  detect and no-op gracefully in the standalone harness).
- On mount, enumerate idle codes; resolve "Non-Contact Center Call" to its
  ID; if absent, show a config-error banner naming the Control Hub path.
- Subscribe to the calling FSM: on connected → capture current agent state,
  set Idle with that aux code; on ended → restore the captured state ONLY if
  the agent's state is still the one we set (if the agent or an ACD event
  changed it meanwhile, leave it alone and log).
- Subscribe to desktop interaction events: if an ACD interaction is offered
  while a personal call is connected, do NOT auto-answer either; surface a
  banner. Log both directions for the demo.
- Unit-test the set/restore logic with a mocked Desktop module, including
  the "state changed underneath us" case and the RONA-avoidance expectation.
```

**Exit criteria:** tests green incl. the interleaving cases; standalone harness unaffected.
**GATE (Erik):** confirm/create the `Non-Contact Center Call` idle code (Control Hub → Contact Center → Desktop Experience → Auxiliary Codes) and record its ID in PROGRESS.md.

### Phase 6 — UI & dial pad *(Sonnet · medium)*

**Subagent prompt:**

```
Build src/ui rendering purely from the FSM + registration + desktop-state
status. Views: (1) status bar (line registered / agent state we set),
(2) dial pad — 0-9 * # grid, number field, call button; reuse it in-call
for DTMF, (3) in-call controls — answer/decline, hold/resume, mute, end,
transfer panel (blind: number entry; consult: dial-consult → complete/
cancel), caller-ID + call timer, (4) inbound-ring surface with ring tone
(user-gesture-safe audio), (5) audio device selector (mic/speaker) persisted
per agent — this desktop also runs the ACD WebRTC engine, so explicit device
choice matters. Honor the dark-mode attribute; visual style consistent with
the Agent Desktop (Momentum-adjacent, no external font/CDN dependencies —
everything in the single bundle). Keyboard: digits type into the pad, Enter
dials. No business logic in UI code; interaction tests for the transfer
panel state rendering.
```

**Exit criteria:** all controls drive FSM actions only; dark-mode verified in harness; bundle still single-file.

### Phase 7 — Deploy, layout, test runbook *(Sonnet · low · gate)*

**Subagent prompt:**

```
Finalize delivery:
1. Production build; confirm the Pages workflow publishes it; record the
   final bundle URL in README and PROGRESS.md.
2. Generate layout/Custom_Desktop_Layout_Webex_Calling.json: take the
   project's existing Custom_Desktop_Layout_Webex_App.json as the base and
   add the widget nav entry from DEV-HANDOFF.md's snippet with the real
   Pages script URL, for the agent persona (and supervisorAgent). Validate
   the JSON against the base file's structure. Do not remove the existing
   Webex App configuration.
3. Write TESTING.md: a live acceptance runbook mapping 1:1 to the
   DEV-HANDOFF.md acceptance criteria checklist, each item with setup,
   steps, expected result, and a pass/fail box — including the shared-line
   rehearsal (widget vs background Webex App vs Teams Cisco Call answering),
   token-refresh-during-call, personal-call + inbound-ACD interleaving, and
   Teams outward presence still showing "In a call".
```

**Exit criteria:** layout JSON diff shows only additions; TESTING.md covers every acceptance criterion.
**GATE (Erik):** upload/publish the layout to the demo team, run TESTING.md end-to-end, file failures back to the orchestrator (which re-dispatches the owning phase's subagent with the evidence).

### Phase 8 — Adversarial code review *(Opus · high · gate)*

Run **after** the live acceptance pass, so reviewers see final code. The orchestrator spawns **three parallel reviewer subagents** (all Opus · high), each with one lens and a mandate to *refute*, then verifies and fixes.

**Reviewer prompt (template — orchestrator fills in the lens):**

```
You are an adversarial reviewer of the velocity-webex-calling-widget repo.
Your job is to REFUTE the claim that this code safely meets the acceptance
criteria in DEV-HANDOFF.md. Lens: <LENS>. Read the full source (not the
tests first — form your own model, then check the tests). Report findings
as: file:line, failure scenario (concrete inputs/state → wrong behavior),
severity. Do not report style nits. If you cannot break it under your lens,
say so explicitly and state what you tried.

LENS A — Correctness & races: FSM soundness under out-of-order SDK events;
consult-transfer edge cases; token refresh mid-call; re-registration during
an active call; personal call + ACD interaction interleavings; restore-state
logic clobbering an agent-chosen state.
LENS B — Security & token handling: token exposure (logs, DOM, storage,
error messages, source maps); OAuth redirect handling inside the desktop;
anything a public Pages bundle leaks; supply-chain (lockfile pinning);
postMessage/attribute injection from the layout.
LENS C — Failure modes & operability: behavior when registration fails, mic
permission denied, idle code missing, SDK version drift, desktop SDK absent,
network flap mid-call; does the UI always tell the agent the truth; can the
widget wedge the agent's WxCC state.
```

**Then:** orchestrator deduplicates findings, spawns one **verifier subagent per finding** (Opus · medium) prompted to independently confirm or refute it against the code; confirmed findings are fixed by a fixer subagent (Opus · medium) with regression tests; reviewers re-run on the diff until no new confirmed findings.

**Exit criteria:** zero confirmed unfixed findings, or each residual explicitly risk-accepted.
**GATE (Erik):** review the findings/fixes summary, re-run any TESTING.md items the fixes touched, sign off. Tag `v0.1.0`.

---

## 4. Risks carried from the handoff (owned, not solved, by this plan)

Shared-line contention (widget + Webex App + Teams Cisco Call — rehearse per TESTING.md); two WebRTC engines in one browser (explicit device selection, Phase 6; echo check at Phase 3 gate); Cisco supports the framework, not our widget (demo/POC posture; production hardening is a follow-on); GitHub Pages is public (acceptable only because the bundle carries no secrets — enforced at Phases 2 and 8); no VDI (WebRTC unsupported).

## 5. Resume protocol

If the orchestrator session is lost: start a new Claude Code session in the repo, prompt it with the kickoff prompt plus "Resume from PROGRESS.md". Phase commits + PROGRESS.md are the checkpoint state.
