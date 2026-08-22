# Auth backend contract — `velocity-webex-calling`

The widget runs **self-OAuth** against Webex (Phase 0 decision; see `PROGRESS.md`
gate log). This document defines the HTTP contract between the browser widget
(`OAuthTokenProvider`, `src/auth/oauth-token-provider.ts`) and the small serverless
backend that holds the Webex **client secret**.

## Why a backend exists at all

`DISCOVERY.md` §2: **Webex has no public-client option.** Every
authorization-code → token exchange, and every refresh-token exchange, requires
the `client_secret` in the request body (or as HTTP Basic auth) to
`https://webexapis.com/v1/access_token`. A browser bundle served from **public
GitHub Pages** must never contain that secret. Therefore the two secret-bearing
exchanges are delegated to a backend that keeps the secret in its environment
(Cloudflare Worker secret binding / AWS Lambda + Secrets Manager / Azure Function
app setting). **The browser never sees the client secret and never persists tokens
to storage.**

PKCE (`code_challenge`/`code_verifier`, S256) is included for defense-in-depth.
It is **not** a secret replacement on Webex — it is layered CSRF/interception
hardening. The `code_verifier` is generated with the Web Crypto API and stays in
the widget's memory until the exchange.

## Division of responsibility (design choice)

The **browser builds the Webex `/authorize` URL itself** and calls the backend
**only** for `/token` and `/refresh`.

Rationale: the authorize redirect carries only public values (`client_id`,
`redirect_uri`, scopes, `state`, PKCE `code_challenge`) — no secret — so routing it
through the backend would add a redirect hop and duplicate the scope list and
redirect URI into the backend for no security gain. Keeping the backend to exactly
the two secret-bearing operations minimises its attack surface and keeps the scope
list authoritative in one place (`src/auth/types.ts`, `WEBEX_CALLING_SCOPES`).

> An equally valid alternative (documented in the task) is a backend
> `GET /authorize` that 302-redirects to Webex. We did **not** choose it, for the
> reasons above. If a future host makes CORS or config centralization easier that
> way, the provider's `buildAuthorizeUrl` is the only piece that would move.

## Configuration (element attributes, never hardcoded)

| Attribute | Example | Meaning |
|---|---|---|
| `client-id` | `C1a2b3…` | Webex integration client ID (public). |
| `redirect-uri` | `https://epeterson-blueally.github.io/velocity-webex-calling-widget/oauth-callback.html` | The deployed callback page (this repo's `public/oauth-callback.html`). Must be registered as a Redirect URI on the Webex integration. |
| `auth-base-url` | `https://velocity-webex-auth.example.workers.dev` | Base URL of the serverless backend. **Host is deferred to the Phase 2 gate.** |

The scope list requested (`DISCOVERY.md` §1):
`spark:calls_read spark:calls_write spark:xsi spark:webrtc_calling`.

## Endpoints the backend MUST implement

Both accept and return `application/json`. The backend must send permissive **CORS**
headers for the widget's origin (the GitHub Pages origin), including
`Access-Control-Allow-Origin`, and handle the `OPTIONS` preflight.

### `POST {auth-base-url}/token`

Exchanges the authorization code for tokens. The backend adds `client_id`,
`client_secret`, and `grant_type=authorization_code` server-side and POSTs to
`https://webexapis.com/v1/access_token`.

Request body:

```json
{
  "code": "<authorization code from the redirect>",
  "code_verifier": "<PKCE verifier, base64url>",
  "redirect_uri": "<must equal the redirect-uri attribute>"
}
```

Success `200`:

```json
{
  "access_token": "<webex access token>",
  "expires_in": 3600,
  "refresh_token": "<optional; see refresh-token handling>"
}
```

Failure: any non-2xx. The widget surfaces a generic "token exchange failed" status
and does **not** log the response body (it may contain token material).

### `POST {auth-base-url}/refresh`

Mints a new access token from the refresh token. The backend adds `client_id`,
`client_secret`, and `grant_type=refresh_token`.

Request body — supports both refresh-token-handling variants below:

```json
{ "refresh_token": "<optional; omitted when the backend uses a session cookie>" }
```

Success `200`: same shape as `/token`.

Failure semantics the widget relies on:

- **`400` or `401`** → the refresh token is invalid/expired. The widget treats this
  as **terminal**, drops its tokens, and returns to `signed-out` (user must sign in
  again). No retry.
- **Other non-2xx / network error** → transient. The widget retries with bounded
  exponential backoff (up to 3 attempts) before giving up.

## Refresh-token handling — pick one at the Phase 2 gate

1. **Server-held (preferred).** The backend keeps the `refresh_token` server-side,
   keyed to an `HttpOnly; Secure; SameSite` session cookie, and returns only the
   short-lived `access_token`. `/refresh` reads the cookie; the body's
   `refresh_token` is ignored. Smallest browser blast radius — a compromised bundle
   cannot exfiltrate a long-lived refresh token. **Requires** the widget's `fetch`
   calls to send credentials; that is a one-line change (`credentials: 'include'`)
   deferred until the host is chosen, because it also requires
   `Access-Control-Allow-Credentials: true` and an explicit (non-`*`) allowed
   origin on the backend.
2. **Returned to the browser (POC-only).** For a single-demo-agent POC the backend
   may return the `refresh_token` in the JSON; the widget holds it in memory
   (never storage) and sends it on `/refresh`. Accept the larger blast radius
   knowingly. This is what the current `OAuthTokenProvider` implements by default
   (it sends `refresh_token` in the `/refresh` body when it has one).

## Redirect handling inside the Agent Desktop (and its residual risk)

The widget is a custom element inside the Agent Desktop page — in the
iframe-widget packaging, inside a cross-origin `<iframe>`. A **full-page or
top-level redirect is not usable**: it would navigate the agent out of the Agent
Desktop and tear down their live ACD/WebRTC session.

So sign-in uses a **popup**:

1. The "Sign in to Webex Calling" button calls `signIn()` (a user gesture, so the
   popup is not blocked).
2. `signIn()` opens `https://webexapis.com/v1/authorize?…` in a popup.
3. Webex authenticates the user and redirects the popup to `redirect-uri`
   (`public/oauth-callback.html`).
4. The callback page `postMessage`s `{ type: 'velocity-webex-oauth', code, state }`
   to `window.opener` (the widget), **targeting the widget's exact origin**, then
   closes.
5. The widget verifies `event.origin === <Pages origin>` **and** the decoded
   `state` nonce, then calls `POST /token`.

### `state` carries the opener origin — and why

`state` is not a bare nonce; it is
`base64url(JSON.stringify({ n: <csrf nonce>, o: <widget window origin> }))`.

The reason is a cross-origin subtlety in the **primary web-component packaging**:
the layout JSON loads the widget via `comp` + `script src=<Pages URL>`, so the
widget script executes **inside the Agent Desktop's document** — the widget
window's origin is therefore the **desktop origin**, not the Pages origin the
callback page is served from. `window.postMessage` **silently drops** a message
whose `targetOrigin` does not match the opener's real origin, so the callback page
cannot simply target `window.location.origin` (that would be the Pages origin and
the drop would make sign-in hang forever). Instead:

- `signIn()` reads its own window origin (`window.location.origin`) and encodes it,
  with the CSRF nonce, into `state`.
- Webex echoes `state` back to the callback verbatim.
- The callback decodes `state`, validates `o` is a well-formed absolute origin
  (`new URL(o).origin === o`), and `postMessage`s to **that** origin. It passes the
  full original `state` back unchanged so the widget can still check the nonce. If
  decoding/validation fails it falls back to `'*'` (documented inline in the page);
  the message carries only an authorization code — not a token or secret — that the
  widget still redeems via the secret-holding backend under PKCE + the nonce check,
  so `'*'` is an acceptable last resort.
- The widget's message handler still checks `event.origin === <Pages origin>` and
  compares the decoded `state.n` to the nonce it generated.

Neither the nonce nor the opener origin is secret; the nonce provides integrity
(CSRF protection), not confidentiality. This makes the redirect correct under
**both** the web-component packaging (opener = desktop origin) and the iframe
packaging (opener = Pages origin).

**Residual risks (carried, not solved, in this phase):**

- **Popup blockers.** Mitigated by requiring `signIn()` to run from the button
  gesture. If a managed-browser policy blocks popups entirely, sign-in cannot
  complete; the widget reports `error: "Popup blocked…"`.
- **`window.opener` in cross-site embeds.** Some browsers sever or partition
  `window.opener` for popups opened from a cross-origin iframe (COOP, storage
  partitioning). If the callback cannot reach the opener, the popup path fails; the
  callback page shows a "return to the Agent Desktop" message. **This must be
  validated in the real Agent Desktop during the Phase 3 live gate.** A fallback of
  last resort (not implemented) is a top-level redirect that first stashes the
  return context — but that requires surviving a navigation and re-entering the
  desktop layout, which is exactly what we are avoiding; it would need product-level
  design if the popup path proves unavailable.
- **Third-party cookie partitioning** would break the server-held refresh-token
  variant's session cookie if the backend origin differs from the widget origin.
  Choose the backend origin and cookie strategy together at the Phase 2 gate.

## What the backend must NEVER do

- Return the `client_secret` in any response.
- Log the `access_token`, `refresh_token`, `code`, or `code_verifier`.
- Accept a `redirect_uri` that is not on the Webex integration's registered list
  (it should validate the value it forwards to Webex).

## Deploy note (deferred to Phase 7)

`public/oauth-callback.html` must be published at the `redirect-uri` alongside the
bundle. The current Pages workflow deploys `dist/` only; Phase 7 must also copy
`public/oauth-callback.html` into the published output (e.g. a webpack
`CopyPlugin`, or emit it into `dist/`). This is **UNRESOLVED** for the Phase 2 gate
— flagged, not wired, because the deploy pipeline is Phase 7's responsibility.
