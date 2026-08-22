/**
 * MuteAdapter — confines the ONE unresolved SDK behaviour to a single testable unit.
 *
 * UNRESOLVED (DISCOVERY.md §5, PROGRESS.md open questions): @webex/calling's
 * ICall exposes `mute(stream, muteType?)` and `isMuted()` but NO `unmute()`. Whether
 * calling `mute()` a second time is a *toggle* (mute → unmute) or *idempotent*
 * (stays muted) cannot be determined from the 3.12.0 typings and must be confirmed
 * against a live call at the Phase 3 gate.
 *
 * This adapter makes the rest of the code independent of that answer. It exposes
 * clean set-semantics — `setMuted(true/false)` — implemented as: read `isMuted()`;
 * if it already equals the target, do nothing; otherwise call the SDK `mute()` once
 * (which flips the state under EITHER interpretation, since we only ever call it
 * when a flip is required). It then re-reads `isMuted()` and, if the SDK turned out
 * to be idempotent-in-the-wrong-direction, retries once more, bounded. The single
 * `muteOnce` seam is injected so the live behaviour can be swapped/confirmed at the
 * gate WITHOUT changing the FSM, controller, or backend.
 */

/** The minimal slice of ICall this adapter needs. Keeps it SDK-agnostic for tests. */
export interface MutableCall {
  isMuted(): boolean;
  /** Invoke the SDK's single mute() call exactly once. */
  muteOnce(): void;
}

export class MuteAdapter {
  private readonly call: MutableCall;
  /** Bounded so a genuinely-stuck SDK cannot spin. */
  private readonly maxFlips: number;

  constructor(call: MutableCall, maxFlips = 2) {
    this.call = call;
    this.maxFlips = maxFlips;
  }

  /**
   * Drive the call's mute state to `target`. Returns the resulting muted state.
   * Correct whether the SDK's mute() is a toggle or idempotent, because we only
   * ever invoke it when current !== target and re-check afterwards.
   */
  setMuted(target: boolean): boolean {
    let flips = 0;
    while (this.call.isMuted() !== target && flips < this.maxFlips) {
      this.call.muteOnce();
      flips += 1;
    }
    return this.call.isMuted();
  }

  mute(): boolean {
    return this.setMuted(true);
  }

  unmute(): boolean {
    return this.setMuted(false);
  }
}
