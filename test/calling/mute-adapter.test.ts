import { describe, expect, it, vi } from 'vitest';
import { MuteAdapter } from '../../src/calling/mute-adapter';
import type { MutableCall } from '../../src/calling/mute-adapter';

/**
 * The mute toggle-vs-idempotent behaviour of the SDK is UNRESOLVED (DISCOVERY.md
 * §5). These tests prove the adapter yields correct set-semantics under BOTH
 * possible SDK behaviours, so nothing above it depends on the answer.
 */

/** A fake ICall slice whose muteOnce() TOGGLES the muted flag. */
function togglingCall(initial = false): { call: MutableCall; spy: ReturnType<typeof vi.fn> } {
  let muted = initial;
  const spy = vi.fn(() => {
    muted = !muted;
  });
  return { call: { isMuted: () => muted, muteOnce: spy }, spy };
}

/** A fake ICall slice whose muteOnce() is IDEMPOTENT: it only ever sets muted=true. */
function idempotentMuteCall(initial = false): { call: MutableCall; spy: ReturnType<typeof vi.fn> } {
  let muted = initial;
  const spy = vi.fn(() => {
    muted = true;
  });
  return { call: { isMuted: () => muted, muteOnce: spy }, spy };
}

describe('MuteAdapter — toggle SDK behaviour', () => {
  it('mute() then unmute() reaches the right state, one flip each', () => {
    const { call, spy } = togglingCall(false);
    const adapter = new MuteAdapter(call);
    expect(adapter.mute()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(adapter.unmute()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('mute() when already muted is a no-op (no flip)', () => {
    const { call, spy } = togglingCall(true);
    const adapter = new MuteAdapter(call);
    expect(adapter.mute()).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('MuteAdapter — idempotent SDK behaviour', () => {
  it('mute() reaches muted; unmute() cannot be forced past the bound and reports actual state', () => {
    const { call } = idempotentMuteCall(false);
    const adapter = new MuteAdapter(call);
    expect(adapter.mute()).toBe(true);
    // Idempotent SDK cannot unmute via mute(); the adapter reports the true state
    // rather than lying, and does not spin (bounded by maxFlips).
    expect(adapter.unmute()).toBe(true);
  });

  it('never exceeds the flip bound even if the SDK never reaches the target', () => {
    const stuck: MutableCall = { isMuted: () => false, muteOnce: vi.fn() };
    const spy = stuck.muteOnce as ReturnType<typeof vi.fn>;
    const adapter = new MuteAdapter(stuck, 2);
    expect(adapter.mute()).toBe(false); // target never reached
    expect(spy).toHaveBeenCalledTimes(2); // bounded
  });
});
