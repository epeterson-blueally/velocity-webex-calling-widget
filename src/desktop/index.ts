/**
 * src/desktop — the WxCC Agent Desktop state integration.
 *
 *   DesktopBackend        the SDK-free adapter seam (backend.ts).
 *   WxccDesktopBackend    the real @wxcc-desktop/sdk implementation (wxcc-backend.ts).
 *   DesktopStateManager   the calling-FSM SUBSCRIBER that sets/restores WxCC state.
 *
 * DESIGN RULE 2 (BUILD-PLAN.md §1): this module SUBSCRIBES to the calling FSM's
 * public snapshot stream and reacts. It NEVER calls a calling API and imports
 * NOTHING from @webex/calling; only WxccDesktopBackend imports @wxcc-desktop/sdk.
 */

export { DesktopStateManager, IDLE_CODE_NAME, CONTROL_HUB_IDLE_CODE_PATH } from './manager';
export type {
  DesktopStatus,
  DesktopStateManagerOptions,
  CallStatusSource,
} from './manager';

export type {
  DesktopBackend,
  IdleCode,
  AgentStateSnapshot,
  AgentStateTarget,
  AcdInteraction,
  LogDirection,
} from './backend';

export { WxccDesktopBackend } from './wxcc-backend';
export type { WxccDesktopBackendOptions } from './wxcc-backend';
