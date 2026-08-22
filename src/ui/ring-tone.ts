/**
 * RingTone — an inbound-ring alert generated entirely with the WebAudio API. No
 * audio file, no CDN asset (BUILD-PLAN.md Phase 6: "generate the tone in-bundle").
 *
 * USER-GESTURE SAFETY: browsers keep a fresh `AudioContext` in the `suspended`
 * state until the page has seen a user gesture (click/keydown/touch), and reject
 * (never throw synchronously) a `resume()` called outside one. This class:
 *   - creates the `AudioContext` lazily, on the FIRST call to `armOnUserGesture()`
 *     (wired by the element to a capture-phase click/keydown listener on the
 *     widget's own shadow host — any interaction with the widget unlocks it, not
 *     just the future ring itself),
 *   - always resumes defensively with `.catch(() => {})` before scheduling tones,
 *     so a ring offered before any gesture is a silent no-op rather than a thrown
 *     `NotAllowedError` or an unhandled rejection,
 *   - never plays anything from `start()` unless the context is actually running.
 */

type AudioContextCtor = typeof AudioContext;

export class RingTone {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ringing = false;
  private armed = false;
  private readonly ctorRef: AudioContextCtor | null;

  constructor(ctorRef?: AudioContextCtor) {
    this.ctorRef =
      ctorRef ??
      ((globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor })
        .AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ??
        null);
  }

  /**
   * Call from a user-gesture event handler (click/keydown) as early as possible.
   * Idempotent; safe to call many times. Never throws.
   */
  armOnUserGesture(): void {
    if (this.armed || !this.ctorRef) return;
    this.armed = true;
    try {
      this.ctx = new this.ctorRef();
    } catch {
      this.ctx = null;
      return;
    }
    // Best-effort resume; the browser may already have it running from the gesture.
    void this.ctx.resume().catch(() => undefined);
  }

  /** Start the repeating ring pattern. No-op (silently) if audio was never armed. */
  start(): void {
    if (this.ringing) return;
    this.ringing = true;
    if (!this.ctx) return;
    void this.ctx.resume().catch(() => undefined);
    this.timer = setInterval(() => this.playBurst(), 3000);
    this.playBurst();
  }

  /** Stop the ring pattern. Idempotent; safe even if never started. */
  stop(): void {
    this.ringing = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Release the audio context. Idempotent. */
  dispose(): void {
    this.stop();
    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
        // best-effort
      }
      this.ctx = null;
    }
    this.armed = false;
  }

  /** One classic two-beep phone-ring burst, synthesized with two oscillators. */
  private playBurst(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    try {
      this.tone(ctx, 0, 0.4);
      this.tone(ctx, 0.5, 0.4);
    } catch {
      // Audio graph errors must never break call handling.
    }
  }

  private tone(ctx: AudioContext, atOffsetSec: number, durationSec: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 440;
    const start = ctx.currentTime + atOffsetSec;
    const end = start + durationSec;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}
