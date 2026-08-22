/**
 * bootstrap.ts — constructs a ready ICallingClient from an access token.
 *
 * THIS IS THE LIVE SEAM. It is the one piece that genuinely needs a browser, a real
 * token, and Cisco's servers, and so is verified at the Phase 3 live gate rather
 * than in unit tests (the controller + FSM are tested against a mock backend).
 *
 * WHY THE HIGH-LEVEL WRAPPER: the pinned @webex/calling@3.12.0 exports the
 * lower-level `createClient(webex, config)`, which requires an already-constructed
 * `webex` *core* instance (mercury + device + encryption + services plugins). Only
 * the `webex` monolith assembles that; @webex/calling alone cannot. The monolith's
 * `Calling.init({webexConfig, callingConfig})` wrapper builds the core from just an
 * access token, fires `ready`, and exposes `.callingClient` (an ICallingClient) —
 * exactly the shape WebexCallingBackend consumes, and exactly what
 * test/token-probe.html + test/harness.html load from the CDN UMD.
 *
 * So this bootstrap uses the global `Calling` wrapper (from the CDN UMD script the
 * hosting page loads) and returns BOTH the calling client AND a matching
 * mic-stream factory from the SAME instance (mixing a bundled createMicrophoneStream
 * with a CDN-created client breaks the SDK's internal media type checks).
 *
 * UNRESOLVED for the live gate: whether production bundles the `webex` monolith to
 * self-host this (no CDN dependency) or keeps the CDN script tag. Either way the
 * WebexCallingBackend above is unchanged — only this factory swaps.
 */

import type { ICallingClient } from '@webex/calling';
import type { MicStreamFactory } from './webex-backend';

/** The subset of the CDN UMD `Calling` wrapper this bootstrap uses. */
interface CallingWrapper {
  on(event: 'ready', cb: () => void): void;
  register(): Promise<void>;
  callingClient: ICallingClient | undefined;
}
interface CallingGlobal {
  init(args: { webexConfig: unknown; callingConfig: unknown }): Promise<CallingWrapper>;
  createMicrophoneStream(constraints: { audio: boolean }): Promise<unknown>;
}

export interface BootstrapResult {
  callingClient: ICallingClient;
  createMicrophoneStream: MicStreamFactory;
}

export interface BootstrapOptions {
  /** How long to wait for `ready` + the calling client to materialize. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to globalThis.Calling (the CDN UMD global). */
  callingGlobal?: CallingGlobal;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Initialize the Webex Calling client for `accessToken` and return it alongside a
 * matching mic-stream factory. Rejects (never leaks the token in the message) on
 * timeout or init failure.
 */
export async function createWebexCallingClient(
  accessToken: string,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const CallingRef =
    options.callingGlobal ?? (globalThis as unknown as { Calling?: CallingGlobal }).Calling;
  if (!CallingRef) {
    throw new Error(
      'Webex Calling SDK not found on the page. Load the @webex/calling UMD script before initializing.',
    );
  }

  const webexConfig = {
    config: { logger: { level: 'info' } },
    credentials: { access_token: accessToken },
  };
  const callingConfig = {
    clientConfig: {
      calling: true,
      contact: false,
      callHistory: false,
      callSettings: false,
      voicemail: false,
    },
    callingClientConfig: { logger: { level: 'info' } },
    logger: { level: 'info' },
  };

  const calling = await CallingRef.init({ webexConfig, callingConfig });

  const client = await waitForClient(calling, timeoutMs);

  const createMic: MicStreamFactory = () =>
    CallingRef.createMicrophoneStream({ audio: true }) as ReturnType<MicStreamFactory>;

  return { callingClient: client, createMicrophoneStream: createMic };
}

function waitForClient(calling: CallingWrapper, timeoutMs: number): Promise<ICallingClient> {
  return new Promise<ICallingClient>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Timed out waiting for the Webex calling client to become ready.'));
    }, timeoutMs);

    calling.on('ready', () => {
      // The wrapper's register() prepares device + mercury; the calling client is
      // created asynchronously right after. Poll briefly until it appears.
      calling
        .register()
        .then(() => pollForClient(calling, timeoutMs))
        .then((client) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(client);
        })
        .catch((err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  });
}

async function pollForClient(calling: CallingWrapper, timeoutMs: number): Promise<ICallingClient> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (calling.callingClient) return calling.callingClient;
    await delay(300);
  }
  throw new Error('Calling client did not materialize (often a calling-scope/entitlement issue).');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
