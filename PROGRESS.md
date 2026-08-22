# PROGRESS — velocity-webex-calling-widget

Orchestrator-maintained checkpoint. This is the resume point if the session dies.
Restart protocol: new Claude Code session in this repo → kickoff prompt + "Resume from PROGRESS.md".

**Project:** Webex Calling widget inside the WxCC Agent Desktop.
**Governing docs (in repo):** `BUILD-PLAN.md` (how), `DEV-HANDOFF.md` (what/why).
**Repo root:** `velocity-webex-calling-widget/` (inside the "Velocity Webex Project" folder).

## Phase status

| Phase | Name | Model/Effort | Gate | Status |
|---|---|---|---|---|
| 0 | Discovery & verification | Sonnet · high | yes | IN PROGRESS |
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

## Open questions / pending gate answers

- [ ] **Phase 0 gate (Erik):** Control Hub checklist + token probe result → decides `$STORE` token
      vs self-OAuth (and, if self-OAuth, PKCE vs backend). Blocks Phase 2 design.

## Gate log

_(none resolved yet)_
