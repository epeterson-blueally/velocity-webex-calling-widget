import { describe, expect, it, vi } from 'vitest';
import { WxccDesktopBackend } from '../../src/desktop/wxcc-backend';

/**
 * These tests exercise the harness-vs-desktop detection and lazy-load seam WITHOUT
 * touching the real @wxcc-desktop/sdk (its module body throws outside the desktop,
 * which is exactly the failure mode this seam exists to avoid). The SDK loader is
 * injected so we never import the real thing here.
 */
describe('WxccDesktopBackend — presence detection / lazy load', () => {
  it('does NOT load the SDK and reports not-present when the desktop host is absent', async () => {
    const loadSdk = vi.fn();
    const be = new WxccDesktopBackend({
      detectDesktopHost: () => false, // simulate the standalone harness
      loadSdk: loadSdk as never,
    });

    await be.init();

    expect(be.isPresent()).toBe(false);
    expect(loadSdk).not.toHaveBeenCalled(); // never import the SDK outside the desktop
    // All reads/methods must be safe no-ops with no SDK loaded.
    expect(be.getCurrentAgentState()).toEqual({ state: 'unknown', auxCodeId: null });
    await expect(be.getIdleCodes()).resolves.toEqual([]);
    expect(be.onAcdInteractionOffered(() => {})).toBeTypeOf('function');
    expect(() => be.dispose()).not.toThrow();
    await expect(be.setAgentState({ state: 'Idle', auxCodeId: 'x' })).rejects.toThrow();
  });

  it('loads the SDK and becomes present when the desktop host is detected', async () => {
    const fakeDesktop = {
      config: { init: vi.fn(async () => {}) },
      logger: { createLogger: () => ({ info: vi.fn() }) },
      agentStateInfo: {
        latestData: {
          idleCodes: [{ id: 'aux-ncc', name: 'Non-Contact Center Call' }],
          status: 'Available',
        },
      },
    };
    const be = new WxccDesktopBackend({
      detectDesktopHost: () => true,
      loadSdk: async () => ({ Desktop: fakeDesktop as never }),
    });

    await be.init();

    expect(be.isPresent()).toBe(true);
    expect(fakeDesktop.config.init).toHaveBeenCalledWith({
      widgetName: 'velocity-webex-calling',
      widgetProvider: 'Velocity',
    });
    await expect(be.getIdleCodes()).resolves.toEqual([
      { id: 'aux-ncc', name: 'Non-Contact Center Call', isDefault: undefined },
    ]);
  });

  it('reports not-present (no throw) when SDK init rejects', async () => {
    const fakeDesktop = {
      config: { init: vi.fn(async () => { throw new Error('handshake failed'); }) },
      logger: { createLogger: () => ({ info: vi.fn() }) },
      agentStateInfo: { latestData: {} },
    };
    const be = new WxccDesktopBackend({
      detectDesktopHost: () => true,
      loadSdk: async () => ({ Desktop: fakeDesktop as never }),
    });

    await expect(be.init()).resolves.toBeUndefined();
    expect(be.isPresent()).toBe(false);
  });
});
