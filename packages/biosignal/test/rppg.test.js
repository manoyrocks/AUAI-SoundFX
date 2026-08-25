import { test } from "node:test";
import assert from "node:assert/strict";
import { posSignal } from "../dist/pos.js";
import { bandpassZeroPhase, estimateHeartRate, pickBeats } from "../dist/filters.js";
import { computeRmssd } from "../dist/hrv.js";

/**
 * Algorithmic verification of the rPPG pipeline against a synthetic signal
 * with a known ground-truth heart rate.
 *
 * This is the "pre-human testing" complement to the browser demo: it cannot
 * validate the camera/skin-detection front end (that needs a real face), but
 * it validates the entire numerical pipeline downstream of the RGB trace —
 * POS projection, bandpass, FFT/Goertzel frequency estimation, beat picking,
 * and RMSSD — against ground truth, deterministically, in CI.
 */

/** Synthesise a plausible skin-reflectance RGB trace at a target heart rate. */
function synthesiseTrace(bpm, seconds, fps, opts = {}) {
  const {
    hrv = 0.02, // fraction of beat-to-beat period jitter (RMSSD-ish)
    noise = 0.15, // camera/lighting noise, relative to pulse amplitude
    dcDrift = 0.03, // slow illumination drift
  } = opts;
  const n = Math.round(seconds * fps);
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);

  // Skin dichromatic model: a DC reflectance term per channel plus a shared
  // blood-volume-pulse AC term with channel-dependent weighting (green picks
  // up the strongest plethysmographic signal, matching real skin optics).
  const dcR = 180;
  const dcG = 150;
  const dcB = 120;
  const wR = 0.35;
  const wG = 1.0;
  const wB = 0.55;

  let tSec = 0;
  let rng = 12345;
  const rand = () => {
    // xorshift32, deterministic
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    rng |= 0;
    return (rng >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(1e-9, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const instBpm = bpm * (1 + hrv * gauss());
    const instHz = instBpm / 60;
    phase += (instHz / fps) * 2 * Math.PI;

    // Slightly non-sinusoidal pulse (harmonic content), as real PPG is.
    const pulse = Math.sin(phase) + 0.25 * Math.sin(2 * phase - 0.6);
    const drift = dcDrift * Math.sin((2 * Math.PI * tSec) / 45);
    const n1 = noise * gauss();

    r[i] = dcR * (1 + drift) + wR * pulse * 1.2 + n1 * 0.6;
    g[i] = dcG * (1 + drift) + wG * pulse * 1.2 + n1;
    b[i] = dcB * (1 + drift) + wB * pulse * 1.2 + n1 * 0.8;
    tSec += 1 / fps;
  }
  return { r, g, b };
}

test("POS + bandpass + Goertzel recovers a known heart rate within 3 bpm", () => {
  const fps = 20;
  const bpm = 72;
  const { r, g, b } = synthesiseTrace(bpm, 20, fps, { hrv: 0.015, noise: 0.12 });

  const pulse = posSignal(r, g, b, Math.round(fps * 1.6));
  const filtered = bandpassZeroPhase(pulse, fps, 0.7, 3.5);
  const est = estimateHeartRate(filtered, fps, 42, 180);

  assert.ok(est.confidence > 0.3, `confidence too low: ${est.confidence}`);
  assert.ok(Math.abs(est.bpm - bpm) < 3, `bpm off by too much: got ${est.bpm}, want ~${bpm}`);
});

test("recovers heart rate across the plausible resting-to-elevated range", () => {
  const fps = 20;
  for (const bpm of [50, 65, 90, 110, 140]) {
    const { r, g, b } = synthesiseTrace(bpm, 20, fps, { hrv: 0.015, noise: 0.1 });
    const pulse = posSignal(r, g, b, Math.round(fps * 1.6));
    const filtered = bandpassZeroPhase(pulse, fps, 0.7, 3.5);
    const est = estimateHeartRate(filtered, fps, 42, 180);
    assert.ok(Math.abs(est.bpm - bpm) < 4, `at ${bpm} bpm got ${est.bpm}`);
  }
});

test("beat picker + RMSSD recovers plausible HRV from synthetic jitter", () => {
  const fps = 30;
  const bpm = 68;
  // Higher hrv fraction -> larger, more detectable RMSSD.
  const { r, g, b } = synthesiseTrace(bpm, 25, fps, { hrv: 0.035, noise: 0.08 });
  const pulse = posSignal(r, g, b, Math.round(fps * 1.6));
  const filtered = bandpassZeroPhase(pulse, fps, 0.7, 3.5);
  const { ibiMs } = pickBeats(filtered, fps, 42, 180);

  assert.ok(ibiMs.length >= 15, `too few beats picked: ${ibiMs.length}`);
  const hrv = computeRmssd(ibiMs);
  assert.notEqual(hrv.quality, "unusable");
  // Not asserting an exact RMSSD value (webcam-grade HRV is inherently noisy,
  // per hrv.ts's own documentation) — only that it's in a physiologically
  // sane band and clearly nonzero, i.e. the pipeline is actually measuring
  // beat-to-beat variability rather than returning a constant.
  assert.ok(hrv.rmssdMs > 5 && hrv.rmssdMs < 400, `implausible RMSSD: ${hrv.rmssdMs}`);
});

test("a flat (no-pulse) trace yields low confidence rather than a confident wrong answer", () => {
  const fps = 20;
  const n = fps * 15;
  const r = new Float32Array(n).fill(180);
  const g = new Float32Array(n).fill(150);
  const b = new Float32Array(n).fill(120);
  // Add only camera sensor noise, no periodic component at all.
  let rng = 999;
  for (let i = 0; i < n; i++) {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    rng |= 0;
    const noise = ((rng >>> 0) / 4294967296 - 0.5) * 0.4;
    r[i] += noise;
    g[i] += noise;
    b[i] += noise;
  }
  const pulse = posSignal(r, g, b, Math.round(fps * 1.6));
  const filtered = bandpassZeroPhase(pulse, fps, 0.7, 3.5);
  const est = estimateHeartRate(filtered, fps, 42, 180);
  // A pure-noise band should not produce a sharply confident peak. This is
  // the guard against the UI ever showing a falsely authoritative BPM when
  // there is genuinely no pulse information in frame.
  assert.ok(est.confidence < 0.35, `noise-only trace produced overconfident estimate: ${est.confidence}`);
});
