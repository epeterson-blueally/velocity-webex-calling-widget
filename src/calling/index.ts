/**
 * src/calling — the Webex Calling core.
 *
 *   CallingBackend      the SDK-free adapter seam (backend.ts).
 *   WebexCallingBackend the real @webex/calling implementation (webex-backend.ts).
 *   CallingController    owns the FSM + backend + TokenProvider; the Phase 6 UI's API.
 *   MuteAdapter          confines the mute toggle-vs-idempotent unknown.
 *   createWebexCallingClient  the live bootstrap seam (bootstrap.ts).
 *
 * The FSM (src/state) imports none of this; the controller is the only consumer of
 * the backend, and only WebexCallingBackend/bootstrap import @webex/calling.
 */

export { CallingController } from './controller';
export type {
  CallingControllerOptions,
  CallingStatus,
  BackoffConfig,
} from './controller';

export type {
  CallingBackend,
  BackendCall,
  BackendEvent,
  BackendCallEvent,
  RegistrationStatus,
} from './backend';

export { MuteAdapter } from './mute-adapter';
export type { MutableCall } from './mute-adapter';

export { WebexCallingBackend } from './webex-backend';
export type { WebexCallingBackendDeps, MicStreamFactory } from './webex-backend';

export { createWebexCallingClient } from './bootstrap';
export type { BootstrapResult, BootstrapOptions } from './bootstrap';
