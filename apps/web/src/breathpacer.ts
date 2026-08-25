import type { ControlVector } from "@soundfx/engine";

/**
 * Haptic breath pacer — the web slice of the "haptic breathing pacers
 * phase-locked to the soundscape" pillar (Part 2, item 5).
 *
 * Honesty about platform support: the Vibration API
 * (navigator.vibrate) works on Android Chrome/Firefox but is not
 * implemented in Safari on iOS or iPadOS at all (WebKit has shipped no
 * Vibration API as of this build), and desktop browsers generally have no
 * vibration hardware to drive. So this is built with a real capability
 * check and a visual fallback that always runs regardless of haptic
 * support — the breathing *rhythm* is the actual deliverable; vibration is
 * one possible output channel for it, not the only one. A future native
 * mobile app gets real haptic engines (Core Haptics / Android Vibrator
 * amplitude control) with far more expressive envelopes than the
 * Vibration API's crude on/off pattern array — that upgrade is tracked as
 * M2/mobile-core scope, not implemented here.
 *
 * Breath timing model: 4-phase box-breath-style envelope (inhale, hold,
 * exhale, hold), with phase durations derived continuously from the
 * control vector rather than picked from a fixed preset list — arousal and
 * tempo shorten the cycle, depth lengthens the exhale relative to the
 * inhale (a longer exhale is the specific mechanism relaxation-breathing
 * protocols use to bias toward parasympathetic tone). This mirrors how
 * every other modality in SoundFX is driven — one continuous vector, not a
 * menu of presets — rather than bolting on a separately-designed breathing
 * feature.
 */

export interface BreathPhase {
  name: "inhale" | "holdIn" | "exhale" | "holdOut";
  /** Fraction of the full cycle, 0..1, at which this phase starts. */
  startFrac: number;
  durationSec: number;
}

export interface BreathCycle {
  totalSec: number;
  phases: BreathPhase[];
}

/** Derive a breath cycle from the live control vector. */
export function breathCycleFor(c: ControlVector): BreathCycle {
  // Base cycle 4.5s (calm) down to 3.2s (energised) as arousal/tempo rise.
  const base = 5.4 - 2.2 * Math.min(1, c.arousal * 0.7 + (c.tempo - 40) / 160);
  const inhale = base * 0.28;
  // Depth (perceived spaciousness) lengthens the exhale relative to inhale —
  // the longer-exhale mechanism relaxation breathing protocols use.
  const exhale = base * (0.32 + 0.14 * c.depth);
  const holdIn = base * 0.08;
  const holdOut = Math.max(0, base - inhale - exhale - holdIn);
  const totalSec = inhale + holdIn + exhale + holdOut;

  const phases: BreathPhase[] = [];
  let t = 0;
  for (const [name, dur] of [
    ["inhale", inhale],
    ["holdIn", holdIn],
    ["exhale", exhale],
    ["holdOut", holdOut],
  ] as const) {
    phases.push({ name, startFrac: t / totalSec, durationSec: dur });
    t += dur;
  }
  return { totalSec, phases };
}

/** Where in [0,1] the breath envelope sits at time `tSec` within one cycle. */
export function breathEnvelope(cycle: BreathCycle, tSec: number): { phase: BreathPhase["name"]; level: number } {
  const t = ((tSec % cycle.totalSec) + cycle.totalSec) % cycle.totalSec;
  for (let i = 0; i < cycle.phases.length; i++) {
    const p = cycle.phases[i];
    const start = p.startFrac * cycle.totalSec;
    const end = start + p.durationSec;
    if (t >= start && t < end) {
      const local = p.durationSec > 0 ? (t - start) / p.durationSec : 0;
      let level: number;
      if (p.name === "inhale") level = 0.5 - 0.5 * Math.cos(Math.PI * local); // 0 -> 1
      else if (p.name === "exhale") level = 0.5 + 0.5 * Math.cos(Math.PI * local); // 1 -> 0
      else if (p.name === "holdIn") level = 1;
      else level = 0;
      return { phase: p.name, level };
    }
  }
  return { phase: "holdOut", level: 0 };
}

export class BreathPacer {
  private cycle: BreathCycle;
  private vibrateSupported: boolean;
  private running = false;
  private vibrationLoopHandle: ReturnType<typeof setTimeout> | null = null;
  private startedAtMs = 0;
  private listeners = new Set<(e: { phase: BreathPhase["name"]; level: number }) => void>();

  constructor(initial: ControlVector) {
    this.cycle = breathCycleFor(initial);
    this.vibrateSupported = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
  }

  get hapticsAvailable(): boolean {
    return this.vibrateSupported;
  }

  setControl(c: ControlVector): void {
    this.cycle = breathCycleFor(c);
  }

  onTick(fn: (e: { phase: BreathPhase["name"]; level: number }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAtMs = performance.now();
    if (this.vibrateSupported) this.scheduleNextVibrationPulse();
  }

  stop(): void {
    this.running = false;
    if (this.vibrationLoopHandle != null) {
      clearTimeout(this.vibrationLoopHandle);
      this.vibrationLoopHandle = null;
    }
    navigator.vibrate?.(0); // cancel any in-flight pattern
  }

  /**
   * Call once per animation frame (or a lower-rate interval) to drive visual
   * indicators — this is the always-available channel, independent of
   * vibration support.
   */
  tick(): void {
    if (!this.running) return;
    const tSec = (performance.now() - this.startedAtMs) / 1000;
    const e = breathEnvelope(this.cycle, tSec);
    for (const fn of this.listeners) fn(e);
  }

  /**
   * Vibration only marks phase *transitions* (a short pulse at the start of
   * inhale, a longer softer one at the start of exhale) rather than trying
   * to render the continuous envelope — the Vibration API's pattern array is
   * just alternating on/off millisecond durations with no amplitude control,
   * so a transition cue is the honest ceiling of what it can express. The
   * visual ring (tick()) carries the continuous envelope instead.
   */
  private scheduleNextVibrationPulse(): void {
    if (!this.running) return;
    const tSec = (performance.now() - this.startedAtMs) / 1000;
    const cycleT = tSec % this.cycle.totalSec;
    const inhaleStart = this.cycle.phases.find((p) => p.name === "inhale")!;
    const exhaleStart = this.cycle.phases.find((p) => p.name === "exhale")!;
    const inhaleAtSec = inhaleStart.startFrac * this.cycle.totalSec;
    const exhaleAtSec = exhaleStart.startFrac * this.cycle.totalSec;

    const upcoming = [
      { atSec: inhaleAtSec, ms: 60 },
      { atSec: exhaleAtSec, ms: 140 },
    ]
      .map((x) => ({ ...x, wait: ((x.atSec - cycleT + this.cycle.totalSec) % this.cycle.totalSec) * 1000 }))
      .sort((a, b) => a.wait - b.wait);

    const next = upcoming[0];
    this.vibrationLoopHandle = setTimeout(() => {
      navigator.vibrate?.(next.ms);
      this.scheduleNextVibrationPulse();
    }, Math.max(16, next.wait));
  }
}
