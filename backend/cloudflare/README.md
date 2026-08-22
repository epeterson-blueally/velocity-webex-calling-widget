# OAuth token-exchange backend (Cloudflare Worker)

The secret-bearing half of the widget's self-OAuth flow. Implements `POST /token`
and `POST /refresh` per [`../../docs/auth-backend-contract.md`](../../docs/auth-backend-contract.md).
The Webex **client secret lives only here** (as a Worker secret), never in the repo
or the browser bundle.

**Pilot host choice:** Cloudflare Workers — cheap, free tier, personal (non-corporate)
account, one-command deploy. Production target is Azure Functions later; because the
contract is host-agnostic, that is a re-implementation of these same two endpoints
with **no widget change** (only the `auth-base-url` attribute moves).

## Prerequisites

- A (free) Cloudflare account — personal, not tied to corporate resources.
- Node + `npm`. `wrangler` is invoked via `npx`, no global install needed.
- The Webex Integration's **Client ID** and **Client Secret** (from the Phase 2 gate:
  developer.webex.com → My Apps → your Integration).

## Deploy

From this directory (`backend/cloudflare/`):

```bash
# 1. Authenticate wrangler to your Cloudflare account (opens a browser).
npx wrangler login

# 2. Store the Webex credentials as encrypted Worker secrets (prompts for each value).
#    These are NOT written to any file.
npx wrangler secret put WEBEX_CLIENT_ID
npx wrangler secret put WEBEX_CLIENT_SECRET

# 3. (Optional) confirm/adjust the public vars in wrangler.toml:
#    ALLOWED_ORIGIN  = the GitHub Pages origin the widget is served from
#    REDIRECT_URI    = the registered Webex redirect URI (the oauth-callback.html URL)

# 4. Deploy.
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://velocity-webex-auth.<your-subdomain>.workers.dev`.
**That URL is the `auth-base-url` attribute** for the widget (Phase 7 layout JSON).

## Verify

```bash
# Preflight should return 204 with the CORS headers.
curl -i -X OPTIONS "https://velocity-webex-auth.<your-subdomain>.workers.dev/token"

# A bogus code should come back 400 (not 500) with a JSON error — proves the
# Worker is wired to Webex and reachable. (Do NOT paste a real code here.)
curl -i -X POST "https://velocity-webex-auth.<your-subdomain>.workers.dev/token" \
  -H 'Content-Type: application/json' \
  -d '{"code":"bogus","code_verifier":"bogus"}'
```

## Local dev (optional)

```bash
# Put secrets in a local .dev.vars file (git-ignored — NEVER commit it):
#   WEBEX_CLIENT_ID=...
#   WEBEX_CLIENT_SECRET=...
npx wrangler dev
```

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/token` | `{code, code_verifier, redirect_uri}` | `{access_token, expires_in, refresh_token?}` |
| `POST` | `/refresh` | `{refresh_token}` | `{access_token, expires_in, refresh_token?}` |
| `OPTIONS` | any | — | `204` + CORS |

Status contract the widget relies on: `/refresh` returning **400/401** is terminal
(widget signs the user out, no retry); other non-2xx is transient (widget retries
with backoff). The Worker maps Webex's status through accordingly.

## Refresh-token handling

This Worker implements the **POC variant**: it returns the `refresh_token` to the
browser, which holds it in memory only (never storage) and sends it back on
`/refresh`. Fine for a single-agent pilot.

**Upgrade (server-held, preferred for production):** stop returning `refresh_token`;
instead persist it server-side (Cloudflare KV / Durable Object) keyed to an
`HttpOnly; Secure; SameSite` session cookie, read the cookie in `/refresh`, and set
`Access-Control-Allow-Credentials: true` with an explicit (non-`*`) `ALLOWED_ORIGIN`.
The widget flips one line (`credentials: 'include'`). See the contract doc §"Refresh-token handling".

## Security invariants

- Never logs `code`, `code_verifier`, `access_token`, `refresh_token`, or the secret.
- Never returns the client secret.
- Forwards only the configured `REDIRECT_URI` to Webex (rejects a mismatched one).
- CORS scoped to `ALLOWED_ORIGIN` (set it to the Pages origin, not `*`, before real use).
