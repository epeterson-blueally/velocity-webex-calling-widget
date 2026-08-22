/**
 * Velocity Webex Calling — OAuth token-exchange backend (Cloudflare Worker).
 *
 * Implements the two secret-bearing endpoints from docs/auth-backend-contract.md:
 *   POST /token    — authorization_code → tokens
 *   POST /refresh  — refresh_token → new access token
 *
 * WHY THIS EXISTS (DISCOVERY.md §2): Webex has no public-client option; the
 * code→token and refresh exchanges ALWAYS require the client_secret. The public
 * GitHub Pages bundle must never hold that secret, so these two exchanges run here
 * with the secret read from the Worker environment (set via `wrangler secret put`).
 *
 * The browser builds the Webex /authorize URL itself; this backend is used ONLY for
 * /token and /refresh — the minimal secret-bearing surface.
 *
 * Config (see wrangler.toml + README.md):
 *   Secrets (wrangler secret put):  WEBEX_CLIENT_ID, WEBEX_CLIENT_SECRET
 *   Vars (wrangler.toml):           ALLOWED_ORIGIN, REDIRECT_URI
 *
 * NEVER logs code / code_verifier / access_token / refresh_token / client_secret.
 */

const WEBEX_TOKEN_URL = 'https://webexapis.com/v1/access_token';

export default {
  /**
   * @param {Request} request
   * @param {{WEBEX_CLIENT_ID:string, WEBEX_CLIENT_SECRET:string, ALLOWED_ORIGIN:string, REDIRECT_URI:string}} env
   */
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';

    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, origin);
    }

    // Fail fast if the Worker is misconfigured — but never echo secret values.
    if (!env.WEBEX_CLIENT_ID || !env.WEBEX_CLIENT_SECRET) {
      return json({ error: 'server_misconfigured' }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400, origin);
    }

    if (path.endsWith('/token')) {
      return handleToken(body, env, origin);
    }
    if (path.endsWith('/refresh')) {
      return handleRefresh(body, env, origin);
    }
    return json({ error: 'not_found' }, 404, origin);
  },
};

/**
 * POST /token — {code, code_verifier, redirect_uri} → tokens.
 */
async function handleToken(body, env, origin) {
  const { code, code_verifier, redirect_uri } = body || {};
  if (!code || !code_verifier) {
    return json({ error: 'missing_code_or_verifier' }, 400, origin);
  }
  // Only ever forward the redirect_uri this backend is configured for
  // (contract: "validate the value it forwards to Webex").
  if (env.REDIRECT_URI && redirect_uri && redirect_uri !== env.REDIRECT_URI) {
    return json({ error: 'redirect_uri_mismatch' }, 400, origin);
  }
  const redirectUri = env.REDIRECT_URI || redirect_uri;
  if (!redirectUri) {
    return json({ error: 'missing_redirect_uri' }, 400, origin);
  }

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.WEBEX_CLIENT_ID,
    client_secret: env.WEBEX_CLIENT_SECRET,
    code,
    code_verifier,
    redirect_uri: redirectUri,
  });
  return exchange(form, origin);
}

/**
 * POST /refresh — {refresh_token} → new access token.
 * (POC variant: the browser holds the refresh token in memory and sends it here.
 * Upgrade path in README: hold it server-side keyed to an HttpOnly cookie.)
 */
async function handleRefresh(body, env, origin) {
  const refreshToken = body && body.refresh_token;
  if (!refreshToken) {
    // Contract: 400 is terminal → widget returns to signed-out. Correct here:
    // with no server-held token and none supplied, no refresh is possible.
    return json({ error: 'missing_refresh_token' }, 400, origin);
  }
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.WEBEX_CLIENT_ID,
    client_secret: env.WEBEX_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  return exchange(form, origin);
}

/**
 * Server-to-server POST to Webex, mapping the response back to the widget contract.
 * Preserves Webex's 400/401 (terminal) vs other (transient) status distinction.
 */
async function exchange(form, origin) {
  let res;
  try {
    res = await fetch(WEBEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch {
    // Network error reaching Webex → transient (contract: widget retries).
    return json({ error: 'upstream_unreachable' }, 502, origin);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    // Preserve Webex's status so the widget's terminal(400/401)-vs-transient
    // logic works. Do NOT forward Webex's body verbatim (may carry token/secret
    // material); return only a coarse error code.
    const status = res.status === 400 || res.status === 401 ? res.status : 502;
    return json({ error: 'webex_token_error' }, status, origin);
  }

  // Return ONLY the fields the widget needs. Nothing is logged.
  return json(
    {
      access_token: data.access_token,
      expires_in: data.expires_in,
      // POC variant: pass the refresh token to the browser (held in memory only).
      // Remove this line for the server-held-cookie variant (see README).
      refresh_token: data.refresh_token,
    },
    200,
    origin,
  );
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
