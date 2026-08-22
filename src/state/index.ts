/**
 * src/state — the SDK-free call finite-state machine.
 *
 * The FSM is the single source of truth for personal-call state (BUILD-PLAN.md §1
 * rule 1). It imports nothing from @webex/calling; the calling core translates SDK
 * signals into CallEvents and feeds them in.
 */

export { CallFsm } from './call-fsm';
export type {
  CallState,
  CallDirection,
  CallEvent,
  CallEventType,
  CallInfo,
  CallSnapshot,
  CallErrorInfo,
  ConsultInfo,
  ConsultPhase,
  CallerId,
  SnapshotListener,
  Unsubscribe,
} from './types';
