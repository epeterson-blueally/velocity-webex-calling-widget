# DISCOVERY.md — Pre-build discovery for the Velocity Webex Calling widget

Companion to `DEV-HANDOFF.md` §0. Every claim below is sourced; quotes are verbatim from the cited URL (or from the actual npm-published package contents, which is a stronger source than any blog post). Anything not nailed down is marked **UNRESOLVED**.

Method: fetched developer.webex.com doc pages directly via `curl` (the site ships as a single-page app with a large embedded JSON content blob — WebFetch's HTML→markdown conversion truncated at 10MB, so raw HTML was pulled and grepped/parsed instead); downloaded the actual `@webex/calling@3.12.0` and `@wxcc-desktop/sdk@3.0.1` npm tarballs and read their shipped TypeScript declaration files directly (`npm pack`, no install) — this is primary, version-exact evidence, stronger than docs prose; cloned the three reference sample repos into `/reference`.

---

## 1. OAuth scopes required by `@webex/calling`

Confirmed against the live scope catalog embedded in developer.webex.com's integration-creation UI (fetched from `https://developer.webex.com/calling/docs/sdks/webex-calling-sdk-authorization-device-registration`, which redirects to `/calling/docs/sdks/webex-calling-sdk-authorization-device-registration` — the page's embedded JSON contains the master scope list):

| Scope | Verbatim description |
|---|---|
| `spark:calls_write` | "Allow users to invoke call commands on themselves" |
| `spark:calls_read` | "List all active calls you are part of / List call history from Webex Calling" |
| `spark:webrtc_calling` | "Access webrtc services for Webex calling" |
| `spark:xsi` | "Access to your Webex Calling resources (e.g. calls & call settings)" |

Corroborated independently by the Webex Developers blog post "[Picking the Right Scopes with Webex Calling OAuth Integrations](https://developer.webex.com/blog/picking-the-right-scopes-with-webex-calling-oauth-integrations)": *"spark:calls_read allows you to get call data, including voicemail and call details"* and *"spark:calls_write allows you to control Webex calls like 'dial' and 'answer'"*.

**Verdict: matches DEV-HANDOFF's expected list exactly** (`spark:calls_read`, `spark:calls_write`, `spark:xsi`, plus `spark:webrtc_calling` as the WebRTC/registration scope). Request all four. `spark:webrtc_calling` is the one most likely to be missing from a token minted for another purpose (e.g. the desktop's own token) — see item 2/6.

No separate "device registration" scope beyond `spark:webrtc_calling` was found anywhere in the scope catalog or the SDK docs.

---

## 2. PKCE vs. backend token exchange — **backend is required, no pure-PKCE public-client option exists**

This is the most consequential finding. Fetched `https://developer.webex.com/create/docs/login-with-webex` (Login with Webex / OAuth flows doc) directly.

Webex does support "Authorization Code Flow with Proof Key for Code Exchange (PKCE)" as a named, recommended flow for browser apps:
> "Authorization Code Flow with PKCE is the recommended flow as it provides the best security."

But PKCE here is **additive CSRF protection on top of the standard flow, not a substitute for the client secret**. The doc's own numbered flow description for the PKCE variant states:

> "7. Your app extracts authorization code from the URI and sends it in a request to the token endpoint, along with the `code_verifier`, `client_id`, and `client_secret`."

And the parameter table for the access-token endpoint (same page) lists:

| Parameter | Required | Note |
|---|---|---|
| `client_id` | yes | "Webex integration client ID" |
| `client_secret` | yes | "Webex integration client secret" |
| `code` | yes | authorization code |
| `code_verifier` | no | *"PKCE code verifier, required if the request to the authorization endpoint included `code_challenge` and `code_challenge_method` parameters."* — i.e. required **in addition to**, not instead of, `client_secret` |

The token-endpoint authorization section is explicit:
> "Requests to the access token endpoint must be authorized either with Basic authentication, or by passing `client_id` and `client_secret` in the request body."

There is no "public client" / "native app" / "confidential vs. public client" distinction anywhere in Webex's integration model — searched the fetched doc text for "public client", "confidential client", "native app" and found none describing a client-secret-free registration type. The standard OAuth guide (`developer.webex.com/create/docs/authentication`, embedded in the same content bundle) says plainly, as a prerequisite for implementing OAuth at all:
> "A server that can receive the OAuth callback and protect the client secret and tokens."

**Verdict:** Webex Integrations require a confidential client. A pure browser SPA cannot do the code-for-token exchange itself without exposing the client secret in shipped JS. `BUILD-PLAN.md` §1 rule 5 ("No secrets in the repo or bundle... if the token flow needs one, that phase stops and raises a gate") is directly triggered by this finding.

**Smallest viable alternative (design, flagged for the build-plan gate):**
A minimal serverless token-exchange endpoint — one function, no framework, no database required for a demo:
- `GET /authorize` — redirects browser to Webex's `/authorize` endpoint with `client_id`, `redirect_uri`, requested scopes, and (still worth doing for defense-in-depth) a PKCE `code_challenge`.
- `POST /token` — receives `{code, code_verifier}` from the browser after redirect; holds `client_id`/`client_secret` as function secrets (e.g. Cloudflare Worker secret binding, AWS Lambda env var via Secrets Manager, Azure Function app setting); does the server-to-server POST to `https://webexapis.com/v1/access_token`; returns only the `access_token` (short-lived) to the browser, and either (a) keeps the `refresh_token` server-side keyed to a session cookie, or (b) for a single-demo-agent POC, returns the refresh token too and accepts the reduced blast radius.
- `POST /refresh` — same function, `grant_type=refresh_token`, same secret-holding pattern, called by the widget on a timer/on-401 before the access token expires.
- This satisfies BUILD-PLAN.md's "no secrets in the bundle" rule: the secret lives only in the serverless function's environment, never in code shipped to the browser.
- Whether the widget uses this self-OAuth path at all depends on item 6 below (whether `$STORE.auth.accessToken` already carries calling scopes) — **UNRESOLVED, human-testable only**, see the token-probe page (item 6) and the Control Hub checklist (item 7).

---

## 3. Pinned versions

Queried the live npm registry directly (`registry.npmjs.org`), not search-engine cache:

| Package | Version | Published |
|---|---|---|
| `@webex/calling` | **3.12.0** | 2026-03-26 |
| `@wxcc-desktop/sdk` | **3.0.1** | 2026-07-15 |
| `@wxcc-desktop/sdk-types` (transitive, referenced but not bundled — see item 4) | 1.0.33 | 2026-04-15 |
| `webex` (the monolith package; ships a UMD `calling.min.js` used by the CDN sample) | **3.12.0** | matches `@webex/calling` — released in lockstep |

Note: a general web search surfaced a stale cached figure of "3.8.0" for `@webex/calling`; the registry's own `dist-tags.latest` (3.12.0) is authoritative and is what's pinned here. `package.json` should pin exactly `@webex/calling@3.12.0` and `@wxcc-desktop/sdk@3.0.1`.

`BUILD-PLAN.md`'s existing pin of `@wxcc-desktop/sdk@3.0.1` is confirmed correct as of 2026-08-22.

---

## 4. Agent Desktop SDK — setting agent state with an idle code, and enumerating idle codes

Read directly from the shipped `@wxcc-desktop/sdk@3.0.1` package's type declarations (`dist/types/jsapi/agent-state-info-jsapi.d.ts` inside the npm tarball — exact version match, strongest possible source):

**Module/class:** `Desktop.agentStateInfo` (an instance of `AgentStateInfoJsapi`).

**Method to call (matches the pattern used in the official `desktop-js-sdk-sample`):**
```ts
stateChange(stateData: {
    state: "Available" | "Idle";
    auxCodeIdArray: string;
}): Promise<Service.Aqm.Agent.StateChangeSuccess | undefined>;
```
Despite the field name `auxCodeIdArray`, the type is a single `string`, not an array — it takes **the idle code's ID, not its name**. Confirmed by the actual sample usage in the cloned repo (`reference/webex-contact-center-api-samples/widget-samples/desktop-js-sdk-sample/src/sa-ds-sdk.js`, lines 463–481):
```js
case 'Idle':
  await Desktop.agentStateInfo.stateChange({
    state,
    auxCodeIdArray: this.state.defaultAuxCode,   // an id, discovered at runtime (see below)
  });
```

Two other, lower-level methods also exist on the same class (found in the same `.d.ts`, not used by any sample we found):
- `stateChangeByChannelType({channelType: string[], state: string, auxCodeIdArray: string[]})` — per-channel variant, array of ids.
- `stateChangeV2(stateData: Service.Aqm.Agent.StateChangeV2)` — a v2 variant; the `Service.Aqm.Agent.StateChangeV2` shape itself lives in an upstream type package (`@uuip/unified-ui-platform-sdk` dependency) that we could not resolve fully — **UNRESOLVED (low priority: `stateChange` above is documented, sample-proven, and sufficient)**.
- `changeAgentState(orgId: string, data: {state: "AVAILABLE"|"IDLE", auxCodeId: string, lastStateChangeReason?: string, agentId: string})` — also takes a singular `auxCodeId` (ID, not name).

**Enumerating idle codes at runtime — two ways, both confirmed:**
1. **Read the already-fetched list:** `Desktop.agentStateInfo.latestData.idleCodes` — an array populated after `Desktop.config.init()` / SDK init. Confirmed by direct usage in the sample (`sa-ds-sdk.js` lines 344–358):
   ```js
   const auxCount = Desktop.agentStateInfo.latestData.idleCodes.length;
   // ... Desktop.agentStateInfo.latestData.idleCodes[i].id
   // ... Desktop.agentStateInfo.latestData.idleCodes[i].isDefault === true
   ```
   So each entry has at least `.id` and `.isDefault`; the type declaration types this array as `Service.Aqm.Configs.Entity[]`, and a sibling field `idleCode?: {id: string; name: string}` on the same `latestData` object confirms `name` is also present on idle-code records generally.
2. **Explicit fetch methods** (same class): `fetchAgentIdleCodes(orgId: string, agentId: string): Promise<Service.Cms.AgentIdleCodes | undefined>` and `fetchOrganizationIdleCodes(orgId: string): Promise<Service.Aqm.Configs.Entity[] | undefined>`.

**Build implication:** to set idle code `Non-Contact Center Call` by name, the widget must first read `Desktop.agentStateInfo.latestData.idleCodes` (or call `fetchOrganizationIdleCodes`), find the entry whose `.name === 'Non-Contact Center Call'`, and pass its `.id` to `stateChange({state: 'Idle', auxCodeIdArray: <that id>})`. **Do not hardcode an ID** — confirm the actual ID in the tenant via the Control Hub checklist (item 7c) and/or resolve it at runtime every time.

**Initialization pattern**, confirmed from the same sample and mirrored in every other sample in `webex-contact-center-api-samples/widget-samples/*`:
```js
import { Desktop } from '@wxcc-desktop/sdk';
// inside connectedCallback() / init():
Desktop.config.init();   // some samples: await Desktop.config.init();
```

---

## 5. Reference repos — cloned and mined

All three cloned successfully into `/reference` (shallow clones, `--depth 1`, no network failures):

| Repo | Path | Status |
|---|---|---|
| `github.com/WebexSamples/web-calling-sdk-samples` | `reference/web-calling-sdk-samples` | cloned OK |
| `github.com/CiscoDevNet/webex-contact-center-widget-starter` | `reference/webex-contact-center-widget-starter` | cloned OK |
| `github.com/WebexSamples/webex-contact-center-api-samples` | `reference/webex-contact-center-api-samples` | cloned OK |

**No sample in any of the three repos combines `@webex/calling` with `@wxcc-desktop/sdk` in one widget.** The Agent Desktop SDK samples (`desktop-js-sdk-sample`, `desktop-js-sdk-callcontrol-sample`) use the Desktop SDK's own `dialer` module to place *ACD* outdial calls through Webex Contact Center entry points — not `@webex/calling`'s personal-line softphone. This widget's core job — running both SDKs side by side in one custom element — has no precedent in Cisco's own samples; the two halves below are each independently well-documented but the combination is new.

### Init sequence + line registration (`@webex/calling`)
Two equivalent entry points found, both from `reference/web-calling-sdk-samples`:

- **CDN** (`cdn/app.js`, loaded via `cdn/index.html` line 45: `<script src="https://unpkg.com/webex@2.59.8-next.10/umd/calling.min.js"></script>`) uses the high-level `Calling.init()` wrapper:
  ```js
  calling = await Calling.init({ webexConfig, callingConfig });
  calling.on('ready', () => {
    calling.register().then(() => {
      callingClient = calling.callingClient;
    });
  });
  // then:
  line = Object.values(callingClient.getLines())[0];
  line.on('registered', (lineInfo) => { /* ... */ });
  line.register();
  ```
- **NPM** (`npm/src/index.js`) is byte-for-byte the same pattern, imported as `import Calling from "webex/calling"` (the monolith `webex` package's calling submodule) rather than `@webex/calling` directly — worth noting as a second valid import path; `npm/package.json` pins `webex@2.59.8-next.10` (an old prerelease; do not use — use the current pinned `3.12.0`, confirmed above to have an equivalent `umd/calling.min.js` on unpkg, `HTTP 200` verified live).
- The current developer.webex.com quickstart (`webex-calling-sdk-web-quickstart`) additionally documents the lower-level, standalone-package path (`@webex/calling`'s own `createClient`), verified against the actual shipped `3.12.0` type declarations (`CallingClient.d.ts`):
  ```ts
  export declare const createClient: (webex: WebexSDK, config?: CallingClientConfig) => Promise<ICallingClient>;
  ```
  and `Line`/`ILine` (`line/index.d.ts`, `line/types.d.ts`): `register(): Promise<void>`, `deregister(): Promise<void>`.
- Both paths need a `webexConfig.credentials.access_token` and, per the CDN/NPM samples' `webpack.config.js`, Node builtin polyfills (`http`, `https`, `crypto`, `stream`, `os`, `url`, `assert`, `querystring` via `stream-http`, `https-browserify`, `crypto-browserify`, etc., plus `webpack.ProvidePlugin({process: 'process/browser'})`) — the SDK was written assuming some Node APIs exist; our widget's webpack config must replicate this polyfill list.

### Call-control method signatures (`ICall`, verified against the actual `3.12.0` `.d.ts`)
From `dist/types/CallingClient/calling/types.d.ts` and `call.d.ts` in the downloaded npm tarball (strongest possible source — exact shipped types for the exact pinned version):
```ts
interface ICall {
  end(): void;
  isMuted(): boolean;
  isConnected(): boolean;
  isHeld(): boolean;
  doHoldResume(): void;                              // toggles hold/resume based on current state
  mute(localAudioStream: LocalMicrophoneStream, muteType?: MUTE_TYPE): void;  // MUTE_TYPE.USER="user_mute" | MUTE_TYPE.SYSTEM="system_mute"
  dial(localAudioStream: LocalMicrophoneStream): void;
  sendDigit(tone: string): void;                     // one DTMF digit per call, e.g. call.sendDigit('1')
  answer(localAudioStream: LocalMicrophoneStream): void;
  completeTransfer(transferType: TransferType, transferCallId?: CallId, transferTarget?: string): void;  // TransferType.BLIND | TransferType.CONSULT
  updateMedia(newAudioStream: LocalMicrophoneStream): void;
}
```
Corroborated in prose by the current docs (`webex-calling-sdk-web-supplementary-services`), which also gives the exact blind/consult transfer usage:
```js
// Blind transfer — transferTarget mandatory, transferCallId must be undefined
call.completeTransfer(TransferType.BLIND, undefined, destination);

// Consult transfer — transferCallId mandatory (the call-to-be-merged-back), transferTarget not required
callAB.doHoldResume();                 // UserB puts UserA on hold
const callBC = line.makeCall();        // UserB calls UserC
callAB.completeTransfer(TransferType.CONSULT, callBC.getCallId());
```
`doHoldResume()` is a **toggle** — no explicit hold(true)/hold(false) boolean parameter exists in this SDK (unlike the iOS/Android calling SDKs, which do take a boolean — do not copy that pattern into the web widget). Track hold state via the `held`/`resumed` call events or `call.isHeld()`, not by assuming call order.

`mute()` takes the *same* `LocalMicrophoneStream` object used to dial/answer, not a boolean — **exact toggle-vs-explicit-unmute behavior of calling `mute()` twice is UNRESOLVED from the type declarations alone** (no `unmute()` method exists in `ICall`; `isMuted()` exists to read current state). Verify empirically in Phase 1 build/test by calling `mute()` twice and checking `isMuted()` — flagging rather than guessing.

Outbound/inbound flow (from the current quickstart, `webex-calling-sdk-web-incoming-outgoing-calls`):
```js
// outbound
const call = line.makeCall({ type: 'uri', address: destination });
await call.dial(localAudioStream);
// inbound
line.on('line:incoming_call', (call) => { /* ... */ });
call.answer({ localAudioStream });
```
Call events: `progress`, `connect`, `established`, `remote_media`, `disconnect`, `held`, `resumed`, `call_error`, `hold_error`, `resume_error`, `transfer_error`.

### Widget web-component packaging pattern
From `reference/webex-contact-center-widget-starter/lit-element/`:
- Custom element defined with LitElement + `@customElement("my-custom-widget")` decorator (`src/index.ts`), importing `{ Desktop } from "@wxcc-desktop/sdk"` directly inside the component.
- `webpack.config.ts` (dist build target) bundles a single `dist/index.js` with `libraryTarget: "umd"` and a single `entry: {index: "./src/index.ts"}` — this is the "one script tag, one custom element" pattern DEV-HANDOFF §"Scaffold" wants; no code-splitting for the dist target (only the interactive `dev`/sandbox target differs).
- From `reference/webex-contact-center-api-samples/widget-samples/desktop-js-sdk-sample/src/sa-ds-sdk.js`: the plain-`HTMLElement` (no Lit) pattern also works and is what most of the older samples use — `customElements.define('...')`, Shadow DOM via `attachShadow({mode:'open'})`, template cloned from a `<template>` element, lifecycle via `connectedCallback()`/`disconnectedCallback()`. Either approach (LitElement or plain custom element) satisfies the "single custom element, single JS asset" contract in DEV-HANDOFF.
- Lighter iframe alternative confirmed real and in active use: `reference/webex-contact-center-api-samples/widget-samples/iframe-widget-sample` ships a full desktop-layout JSON with an iFrame nav-tab widget pointing `src` at an externally hosted page — same shape as DEV-HANDOFF's "host a standalone page and embed via `agentx-wc-iframe`" fallback.

---

## 6. `test/token-probe.html`

Written at `test/token-probe.html` (repo root `test/` dir). Loads `@webex/calling` 3.12.0's UMD bundle from unpkg (`https://unpkg.com/webex@3.12.0/umd/calling.min.js` — confirmed live, `HTTP 200`, via the exact CDN pattern in `reference/web-calling-sdk-samples/cdn/index.html`), takes a pasted access token, calls `Calling.init()` → `calling.register()` → `line.register()`, and logs pass/fail plus the raw error (scope-related registration failures surface here — e.g. an HTTP 403 with a scope-missing message, or the `registered` event never firing). This directly answers whether `$STORE.auth.accessToken` (pasted from the running desktop session for a manual test) carries calling scopes — the DEV-HANDOFF §0 item 2 question — without writing any app code first.

Usage: open the file directly in Chrome/Edge (no server needed — it's a static file with a CDN script tag), paste a token, click "Register".

---

## 7. Control Hub / human-only checklist

None of these are answerable from public docs or the sample repos — they require a login to this tenant's Control Hub. Recorded here as an explicit checklist; **all four items are UNRESOLVED pending human verification**:

- [ ] **(a) Media platform.** Confirm the org is on the next-generation media platform (RTMS) — Control Hub → Organization Settings (or Services → Meeting) → look for "media platform" / RTMS indicator. The Web Calling SDK's WebRTC registration depends on this; no public API/doc surfaces a tenant's media-platform version from outside Control Hub.
- [ ] **(b) Demo agent licensing.** Confirm the demo agent has both a Webex Calling license and a "Cisco Call" line assigned — Control Hub → Users → [agent] → Calling tab. Without the Calling license, `line.register()` will fail regardless of scopes.
- [ ] **(c) Idle code existence.** Check whether an idle code named exactly `Non-Contact Center Call` already exists — Control Hub → Contact Center → Desktop Experience → Auxiliary Codes (idle codes). **If it exists, record its ID here** (fill in after checking): `_____________`. If it doesn't exist, it must be created before Build step 5 in DEV-HANDOFF. Per item 4 above, the widget needs the ID, not just the name, and should resolve it at runtime rather than relying on a value pasted here going stale.
- [ ] **(d) ACD voice endpoint type.** Confirm the agent's ACD voice/media channel is provisioned as a WebRTC "Desktop" endpoint vs. a Webex Calling extension — Control Hub → Contact Center → Agents (or Desktop Profile) → [agent] → channel/endpoint settings. This determines whether the demo browser will be running **two independent WebRTC engines simultaneously** (this widget's personal-line softphone + the WxCC ACD WebRTC endpoint) — directly relevant to DEV-HANDOFF's "Watch out for: Two WebRTC engines" warning. If the endpoint is an extension (deskphone/hardware), that risk doesn't apply, but then ACD audio isn't in the browser at all, which changes the demo story.

---

## Summary of UNRESOLVED items

1. Whether `$STORE.auth.accessToken` carries calling scopes (`spark:calls_read`, `spark:calls_write`, `spark:xsi`, `spark:webrtc_calling`) — testable with `test/token-probe.html`, but requires a human to paste a live token; not resolvable from docs.
2. Exact shape of `Service.Aqm.Agent.StateChangeV2` (the `stateChangeV2` alternative method) — type lives in an unresolved upstream package; low priority since `stateChange()` is sample-proven and sufficient.
3. Exact toggle-vs-idempotent behavior of `ICall.mute()` called twice (no `unmute()` exists in the type declarations) — must be verified empirically against a live call in Phase 1, not resolvable from static types/docs alone.
4. All four Control Hub checklist items (§7a–d): media platform version, demo agent Calling license + line, whether `Non-Contact Center Call` idle code already exists (and its ID), and the agent's ACD endpoint type.
5. Full field shape of `Service.Aqm.Configs.Entity` (the idle-code array element type) beyond the confirmed `id`/`isDefault`/(inferred `name`) — cosmetic; sufficient fields are already confirmed for the build.
