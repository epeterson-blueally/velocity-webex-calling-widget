/**
 * src/bundle.ts — the webpack entry for the single UMD bundle
 * (dist/velocity-webex-calling.js, global `VelocityWebexCalling`).
 *
 * It (1) imports src/index for its side effect of registering the
 * <velocity-webex-calling> custom element, and (2) re-exports the Phase 3 calling
 * core + auth + FSM so the harness (test/harness.html) and Phase 6 can construct a
 * CallingController from the global. These calling exports are what pull
 * @webex/calling into the bundle.
 *
 * WHY A SEPARATE ENTRY FROM src/index.ts: importing @webex/calling executes heavy
 * SDK init that cannot run under the jsdom unit-test environment. Keeping src/index
 * SDK-free lets the FSM, controller, and element tests import project code without
 * ever loading the SDK; only this entry (built by webpack, never imported by a
 * unit test) brings the SDK in. See PROGRESS.md.
 */

// Side effect: defines and registers the custom element.
import './index';

// Element helpers (also handy for the harness).
export {
  VelocityWebexCallingElement,
  maskToken,
  decodeJwtScope,
} from './index';

// Phase 3 programmatic API.
export {
  CallingController,
  WebexCallingBackend,
  MuteAdapter,
  createWebexCallingClient,
} from './calling';
export type {
  CallingControllerOptions,
  CallingStatus,
  CallingBackend,
  BackendCall,
  BackendEvent,
  RegistrationStatus,
  WebexCallingBackendDeps,
  BootstrapResult,
  MicStreamFactory,
} from './calling';

// FSM (single source of truth for call state).
export { CallFsm } from './state';
export type { CallSnapshot, CallState, CallEvent, CallInfo, CallerId } from './state';

// Auth seam (the controller subscribes to a TokenProvider).
export { StoreTokenProvider, OAuthTokenProvider } from './auth';
export type { TokenProvider, AuthState } from './auth';

// WxCC desktop-state integration (Phase 5). DesktopStateManager subscribes to the
// CallingController's status stream; WxccDesktopBackend is the only importer of
// @wxcc-desktop/sdk — importing it here is what pulls that SDK into the bundle.
export {
  DesktopStateManager,
  WxccDesktopBackend,
  IDLE_CODE_NAME,
  CONTROL_HUB_IDLE_CODE_PATH,
} from './desktop';
export type {
  DesktopBackend,
  DesktopStatus,
  DesktopStateManagerOptions,
  CallStatusSource,
  IdleCode,
  AgentStateSnapshot,
  AgentStateTarget,
  AcdInteraction,
  WxccDesktopBackendOptions,
} from './desktop';
