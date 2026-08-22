/**
 * DesktopBackend — the thin adapter seam over `@wxcc-desktop/sdk`
 * (BUILD-PLAN.md §1 rule 4 / Phase 5: "Keep the Desktop SDK behind a thin adapter
 * like CallingBackend").
 *
 * WHY THIS EXISTS: the set/restore logic (DesktopStateManager) is unit-tested
 * against a *mock* implementation of this interface, never the real SDK. Only
 * WxccDesktopBackend (wxcc-backend.ts) imports `@wxcc-desktop/sdk`. Nothing in this
 * file imports the SDK, and NOTHING in src/desktop imports `@webex/calling` — the
 * module is a pure SUBSCRIBER of the calling FSM's public snapshot stream
 * (DESIGN RULE 2).
 *
 * The types here are deliberately SDK-free (plain strings / small records) so a test
 * double is trivial and the seam does not leak the SDK's heavily-generic `Service.*`
 * shapes upward.
 */

/** One idle (auxiliary) code, resolved from the desktop at runtime by NAME → ID. */
export interface IdleCode {
  id: string;
  name: string;
  isDefault?: boolean;
}

/**
 * A snapshot of the agent's current WxCC state, read straight from the desktop.
 * `state` is the raw status string the desktop reports (e.g. 'Available', 'Idle',
 * 'RONA', 'Connected'); `auxCodeId` is the idle code currently in effect (the
 * default '0' when Available, or null when unknown). Never contains token material.
 */
export interface AgentStateSnapshot {
  state: string;
  auxCodeId: string | null;
}

/**
 * The two states this widget ever SETS. `@wxcc-desktop/sdk`'s `stateChange` accepts
 * only 'Available' | 'Idle', so the adapter's setter is constrained to match.
 */
export interface AgentStateTarget {
  state: 'Available' | 'Idle';
  /** For 'Available' this is the SDK default ('0'); for 'Idle' the aux code id. */
  auxCodeId: string;
}

/** An ACD interaction offered to the agent by Webex Contact Center. */
export interface AcdInteraction {
  interactionId: string;
  /** True when the offer arrived via the RONA (redirect-on-no-answer) channel. */
  isRona: boolean;
}

export type Unsubscribe = () => void;

/** Direction tag for the demo interaction log (both directions are logged). */
export type LogDirection =
  | 'call→desktop' // a personal-call transition drove a desktop state change
  | 'desktop→call'; // a desktop/ACD event was surfaced to the personal-call side

/**
 * The adapter contract. The real implementation wraps `Desktop.*`; the mock in tests
 * scripts every method. Every SDK-touching call is async and rejects on failure so
 * the manager can map it into a banner rather than throw.
 */
export interface DesktopBackend {
  /**
   * True only when running inside the WxCC Agent Desktop (the SDK is reachable and
   * initialized). False in the standalone harness / outside the desktop — the
   * manager then no-ops gracefully. Valid only after `init()` has been awaited.
   */
  isPresent(): boolean;

  /**
   * Initialize the desktop SDK (`Desktop.config.init`). Resolves whether or not the
   * desktop is present; presence is reported by `isPresent()` afterwards. Never
   * throws for the "not in the desktop" case — that is a normal no-op, not an error.
   */
  init(): Promise<void>;

  /** Enumerate idle codes (resolved to {id,name}); empty when absent/unavailable. */
  getIdleCodes(): Promise<IdleCode[]>;

  /** Read the agent's current WxCC state (for capture-before-override / the guard). */
  getCurrentAgentState(): AgentStateSnapshot;

  /** Set the agent's WxCC state. Rejects on SDK failure. */
  setAgentState(target: AgentStateTarget): Promise<void>;

  /** Subscribe to ACD interaction offers (both normal and RONA channels). */
  onAcdInteractionOffered(cb: (interaction: AcdInteraction) => void): Unsubscribe;

  /** Structured demo log of a cross-boundary event. Never logs token material. */
  log(direction: LogDirection, message: string): void;

  /** Release listeners. Idempotent. */
  dispose(): void;
}
