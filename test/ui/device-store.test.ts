import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStoredDevice, setStoredDevice } from '../../src/ui/device-store';

/**
 * This project's jsdom test environment does not expose a working
 * `localStorage` (see vitest.config.mts / the jsdom version pinned) — a real
 * gap device-store.ts already tolerates via optional chaining (storage
 * unavailable → silent no-op / null reads, never a throw). To exercise the
 * actual persistence logic (not just that fallback), stub in a minimal
 * Map-backed Storage for these tests only.
 */
function makeFakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeFakeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('device-store', () => {
  it('persists a device id per agent + kind and reads it back', () => {
    setStoredDevice('agent-1', 'mic', 'device-abc');
    setStoredDevice('agent-1', 'speaker', 'device-xyz');
    expect(getStoredDevice('agent-1', 'mic')).toBe('device-abc');
    expect(getStoredDevice('agent-1', 'speaker')).toBe('device-xyz');
  });

  it("namespaces by agent id — one agent never sees another agent's choice", () => {
    setStoredDevice('agent-1', 'mic', 'device-abc');
    expect(getStoredDevice('agent-2', 'mic')).toBeNull();
  });

  it('returns null when nothing has been stored', () => {
    expect(getStoredDevice('agent-3', 'mic')).toBeNull();
  });

  it('never stores anything under a key that looks like a token/secret', () => {
    setStoredDevice('agent-1', 'mic', 'device-abc');
    const store = globalThis.localStorage;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      expect(key).not.toMatch(/token|secret|auth/i);
    }
  });

  it('degrades to a silent null/no-op when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => setStoredDevice('agent-1', 'mic', 'device-abc')).not.toThrow();
    expect(getStoredDevice('agent-1', 'mic')).toBeNull();
  });
});
