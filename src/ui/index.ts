/**
 * src/ui — pure rendering layer (BUILD-PLAN.md Phase 6). See types.ts for the
 * design rule ("no business logic in UI code") every view here follows.
 *
 * SDK BOUNDARY: nothing in this directory imports `@webex/calling` or
 * `@wxcc-desktop/sdk` — only `import type` references to the SDK-free seams
 * (CallSnapshot, AuthState, CallingStatus, DesktopStatus). Verified by grep as part
 * of the Phase 6 exit criteria.
 */

export type { UiActions, WidgetStatus, DialpadKey } from './types';
export { DIALPAD_KEYS } from './types';

export { WIDGET_STYLES } from './styles';
export { icon } from './icons';

export { RingTone } from './ring-tone';
export { getStoredDevice, setStoredDevice } from './device-store';
export type { DeviceKind } from './device-store';

export { StatusBarView } from './status-bar';
export { DialPadView } from './dial-pad';
export type { DialPadMode, DialPadState } from './dial-pad';
export { InCallControlsView } from './in-call-controls';
export type { InCallControlsState } from './in-call-controls';
export { TransferPanelView } from './transfer-panel';
export type { TransferMode, TransferPanelState } from './transfer-panel';
export { DeviceSelectorView } from './device-selector';

export { CallingWidgetView, toTransferPanelState } from './view';
