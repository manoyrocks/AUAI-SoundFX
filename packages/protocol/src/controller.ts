import { anchor, clampControl, type AnchorName, type ControlVector } from "@soundfx/engine";
import { PhysiologyBaseline } from "./baseline.js";
import type { StateVector } from "./state.js";

/**
 * M1 conservative feedback controller.
 *
 * This is the *bounded, hand-specified* control law that ships at M1. It is
 * intentionally not the learned safe-RL policy described in the architecture
 * doc (docs/04-biosignals-and-control.md) — that requires weeks of per-user
 * dose-response data this build cannot have on day one. What it is: a
 * fusion-aware, saturating, hard-clamped proportional controller built around
 * three properties:
 *
 *  1. Multi-signal: it reads HR *and* HRV and only responds strongly when they
 *     agree. Elevated HR with suppressed HRV is the physiologically coherent
 *     signature of sympathetic activation; either alone is a weaker, noisier
 *     signal that a camera estimate can easily fake.
 *  2. Personalised: it compares against this user's own online-learned
 *     baseline (see baseline.ts), not a fixed population threshold.
 *  3. Multi-dimensional response: it moves tempo, arousal, density and
 *     tension together along a physiologically motivated direction, rather
 *     than turning a single tempo dial.
 *
 * It will be swapped for the learned controller behind the same
 * `computeAdjustment` signature at M2 — nothing downstream needs to change.
 */

export interface ControllerOptions {
  /** Conservative exploration bound on the arousal pull, 0..1. Hard cap. */
  maxArousalPull: number;
  /** Conservative exploration bound on the tempo pull, BPM. Hard cap. */
  maxTempoPullBpm: number;
  /** Minimum combined confidence before the controller acts at all. */
  minConfidence: number;
}

export const DEFAULT_CONTROLLER_OPTIONS: ControllerOptions = {
  maxArousalPull: 0.16,
  maxTempoPullBpm: 9,
  minConfidence: 0.2,
};

export interface ControllerResult {
  target: ControlVector;
  /** Signed pull applied to arousal, post-clamp, for telemetry/explainability. */
  arousalPull: number;
  /** Signed pull applied to tempo, post-clamp, for telemetry/explainability. */
  tempoPull: number;
  /** Human-readable reason string for the copilot / "why this sound" surface. */
  explanation: string;
}

/**
 * Safety invariant (Part 6): sleep sessions never spike arousal. Enforced
 * here as a hard clamp on the controller's output, independent of and in
 * addition to the engine's own rate limiter (control.ts slewToward) — defence
 * in depth, not a single point of failure.
 */
function enforceModeSafety(mode: AnchorName, base: ControlVector, adjusted: ControlVector): ControlVector {
  if (mode === "sleep") {
    return {
      ...adjusted,
      arousal: Math.min(adjusted.arousal, base.arousal),
      tempo: Math.min(adjusted.tempo, base.tempo),
      tension: Math.min(adjusted.tension, base.tension),
    };
  }
  return adjusted;
}

export function computeAdjustment(
  mode: AnchorName,
  state: StateVector,
  baseline: PhysiologyBaseline,
  opts: ControllerOptions = DEFAULT_CONTROLLER_OPTIONS,
): ControllerResult {
  const base = anchor(mode);

  const hrConfident = state.heartRateBpm != null && state.heartRateConfidence >= opts.minConfidence && baseline.hr.trusted;
  const hrvConfident = state.hrvRmssdMs != null && state.hrvConfidence >= opts.minConfidence && baseline.hrv.trusted;

  if (!hrConfident) {
    return { target: base, arousalPull: 0, tempoPull: 0, explanation: "Warming up — establishing your resting baseline." };
  }

  const zHr = baseline.hr.zScore(state.heartRateBpm as number, 3);
  // Positive zHrv = MORE variable than baseline = more relaxed; negative = less.
  const zHrv = hrvConfident ? baseline.hrv.zScore(state.hrvRmssdMs as number, 5) : 0;

  // Agreement weight: 1.0 when HR-up and HRV-down agree, damped toward 0.35
  // when the two signals disagree, since disagreement more often indicates a
  // detector artefact than a real physiological event.
  const agree = zHr > 0 && zHrv < 0;
  const disagree = zHr > 0 && zHrv > 0.5;
  const agreementWeight = hrvConfident ? (agree ? 1.0 : disagree ? 0.35 : 0.7) : 0.55;

  // Saturating response: tanh keeps a single noisy outlier reading from
  // producing a large jump — the conservative-exploration-bound analogue of
  // the M2 safe-RL policy's action clipping.
  const stressSignal = Math.tanh(Math.max(0, zHr) / 2.2) * agreementWeight;

  const arousalPullRaw = -stressSignal * opts.maxArousalPull;
  const tempoPullRaw = -stressSignal * opts.maxTempoPullBpm;

  const arousalPull = Math.max(-opts.maxArousalPull, Math.min(opts.maxArousalPull, arousalPullRaw));
  const tempoPull = Math.max(-opts.maxTempoPullBpm, Math.min(opts.maxTempoPullBpm, tempoPullRaw));

  const adjusted: ControlVector = clampControl({
    ...base,
    arousal: base.arousal + arousalPull,
    tempo: base.tempo + tempoPull,
    density: base.density - stressSignal * 0.08,
    tension: base.tension - stressSignal * 0.06,
  });

  const safe = enforceModeSafety(mode, base, adjusted);

  let explanation: string;
  if (stressSignal > 0.15) {
    explanation = hrvConfident && agree
      ? `Heart rate is elevated and beat-to-beat variability is down from your baseline — easing tempo and arousal to help you settle.`
      : `Heart rate is elevated above your baseline — gently easing tempo.`;
  } else {
    explanation = `Tracking close to your resting baseline — holding steady.`;
  }

  return { target: safe, arousalPull, tempoPull, explanation };
}
