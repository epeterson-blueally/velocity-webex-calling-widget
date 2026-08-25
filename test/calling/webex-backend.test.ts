import { describe, it, expect, vi } from 'vitest';
import { WebexCallingBackend } from '../../src/calling/webex-backend';

/**
 * Regression tests for the two defects the live smoke test surfaced:
 *  1. dispose() must deregister the Mobius device (else registrations leak ->
 *     "User device limit exceeded" + 429 throttling).
 *  2. makeCall must reject non-phone-number addresses (email/SIP) up front with a
 *     clear message, since @webex/calling 3.12.0's makeCall silently rejects them.
 *
 * The SDK line/call/client are faked with `as unknown as` casts — we only exercise
 * the thin seam, not the real SDK.
 */

function fakeSdkCall(id: string) {
  return {
    getCallId: () => id,
    getDirection: () => 'OUTBOUND',
    isMuted: () => false,
    getCallerId: () => undefined,
    on: vi.fn(),
  };
}

function makeBackend(makeCallImpl: (dest: unknown) => unknown) {
  const deregister = vi.fn();
  const makeCall = vi.fn(makeCallImpl);
  const line = {
    on: vi.fn(),
    register: vi.fn(),
    deregister,
    makeCall,
  };
  const callingClient = { getLines: () => ({ line1: line }) };
  const backend = new WebexCallingBackend({
    callingClient: callingClient as unknown as ConstructorParameters<
      typeof WebexCallingBackend
    >[0]['callingClient'],
  });
  return { backend, line, deregister, makeCall };
}

describe('WebexCallingBackend — live-gate regressions', () => {
  it('dispose() deregisters the line (no orphaned Mobius registration)', async () => {
    const { backend, deregister } = makeBackend(() => fakeSdkCall('c1'));
    await backend.init();
    backend.dispose();
    expect(deregister).toHaveBeenCalledTimes(1);
  });

  it('rejects an email/SIP address with a clear message and never calls the SDK', async () => {
    const { backend, makeCall } = makeBackend(() => fakeSdkCall('c1'));
    await backend.init();
    await expect(backend.makeCall('demo.collab.user4@blueally.com')).rejects.toThrow(
      /phone number or extension/i,
    );
    expect(makeCall).not.toHaveBeenCalled();
  });

  it('rejects an empty address', async () => {
    const { backend, makeCall } = makeBackend(() => fakeSdkCall('c1'));
    await backend.init();
    await expect(backend.makeCall('   ')).rejects.toThrow(/phone number or extension/i);
    expect(makeCall).not.toHaveBeenCalled();
  });

  it('dials a numeric address/extension as TEL', async () => {
    const { backend, makeCall } = makeBackend(() => fakeSdkCall('c1'));
    await backend.init();
    const call = await backend.makeCall('1004');
    expect(call.id).toBe('c1');
    expect(makeCall).toHaveBeenCalledTimes(1);
    const arg = makeCall.mock.calls[0][0] as { type: unknown; address: string };
    expect(arg.address).toBe('1004');
  });
});
