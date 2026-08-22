# velocity-webex-calling-widget

A custom Webex Contact Center Agent Desktop widget, `<velocity-webex-calling>`,
that gives an agent control of their personal Webex Calling line without
leaving the Agent Desktop. See `DEV-HANDOFF.md` for the full design brief and
`BUILD-PLAN.md` for the phased build plan this repo is following.

**Status:** Phase 1 (scaffold) — placeholder element only, no calling logic yet.
See `PROGRESS.md` for phase-by-phase status.

## Bundle

Built with Webpack into a single UMD script:

```
dist/velocity-webex-calling.js
```

Once GitHub Pages is enabled for this repo (Settings → Pages → Source:
GitHub Actions), pushes to `main` build and publish this file via
`.github/workflows/deploy.yml`. The published bundle URL will be:

```
https://<github-org-or-user>.github.io/velocity-webex-calling-widget/velocity-webex-calling.js
```

_(placeholder — fill in once Pages is enabled and the first deploy completes)_

## Usage

```html
<script src="https://YOUR-HTTPS-HOST/velocity-webex-calling.js"></script>
<velocity-webex-calling
  access-token="..."
  agent-id="..."
  org-id="..."
  dark-mode="false"
></velocity-webex-calling>
```

In the WxCC desktop layout JSON these attributes are bound from `$STORE`
(see `DEV-HANDOFF.md` § "Desktop layout entry").

## Development

```bash
npm install
npm run build   # production build -> dist/velocity-webex-calling.js
npm run dev     # webpack --watch, development mode
npm test        # vitest
```

Node.js 26+ and npm 11+ are assumed (see `DISCOVERY.md`).

## Pinned dependencies

Per `DISCOVERY.md` §3, when added in later phases:

- `@webex/calling@3.12.0`
- `@wxcc-desktop/sdk@3.0.1`

Webpack is pre-configured with the Node builtin polyfills `@webex/calling`
requires (`http`/`https`/`crypto`/`stream`/`os`/`url`/`assert`/`querystring`
plus a `process` shim) so it can be added in Phase 3 without further
webpack rework — see `webpack.config.js`.
