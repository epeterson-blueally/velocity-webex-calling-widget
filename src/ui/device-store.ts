/**
 * device-store — persists the agent's chosen mic/speaker deviceId per agent-id in
 * `localStorage`.
 *
 * ABSOLUTE RULE (BUILD-PLAN.md Phase 6 brief): localStorage is for DEVICE IDs ONLY.
 * Never write a token, code, or any auth material here — the auth module keeps all
 * token material in memory only (src/auth/oauth-token-provider.ts header). This
 * module only ever reads/writes a `{mic, speaker}` pair of opaque MediaDeviceInfo
 * `deviceId` strings, namespaced by agent id.
 *
 * Defensive: localStorage can throw (private browsing, storage quota, disabled by
 * policy) — every operation is wrapped so a storage failure degrades to "no
 * persistence" rather than breaking the widget.
 */

export type DeviceKind = 'mic' | 'speaker';

const STORAGE_PREFIX = 'velocity-webex-calling:device:';

function storageKey(agentId: string, kind: DeviceKind): string {
  // Namespaced strictly by agent id + kind; never includes token material.
  return `${STORAGE_PREFIX}${encodeURIComponent(agentId || 'unknown')}:${kind}`;
}

/** Read the persisted deviceId for `kind`, or null if none stored / storage unavailable. */
export function getStoredDevice(agentId: string, kind: DeviceKind): string | null {
  try {
    return globalThis.localStorage?.getItem(storageKey(agentId, kind)) ?? null;
  } catch {
    return null;
  }
}

/** Persist the chosen deviceId for `kind`. Best-effort; never throws. */
export function setStoredDevice(agentId: string, kind: DeviceKind, deviceId: string): void {
  try {
    globalThis.localStorage?.setItem(storageKey(agentId, kind), deviceId);
  } catch {
    // Storage unavailable/full — the selector still works for this session.
  }
}
