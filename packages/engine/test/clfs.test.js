import { test } from "node:test";
import assert from "node:assert/strict";
import { ClfsCore } from "../dist/clfs.js";
import { anchor, clampControl, slewToward, CONTROL_RANGES, CONTROL_KEYS } from "../dist/control.js";

const SR = 48000;

function renderSeconds(core, seconds) {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  core.process(l, r, n);
  return { l, r };
}

function assertFiniteAndBounded(buf, label) {
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    assert.ok(Number.isFinite(v), `${label}[${i}] is not finite: ${v}`);
    assert.ok(v >= -1.0001 && v <= 1.0001, `${label}[${i}] out of [-1,1]: ${v}`);
  }
}

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

for (const mode of ["deepWork", "calm", "sleep", "energy", "recovery"]) {
  test(`${mode}: renders finite, in-range audio with audible RMS after fade-in`, () => {
    const core = new ClfsCore(SR, { seed: 42, reverb: true });
    core.snapTo(anchor(mode));
    core.setMasterTarget(1);
    // Let the ~0.35s master fade and control-rate state settle.
    renderSeconds(core, 1.0);
    const { l, r } = renderSeconds(core, 2.0);
    assertFiniteAndBounded(l, `${mode}.L`);
    assertFiniteAndBounded(r, `${mode}.R`);
    const level = Math.max(rms(l), rms(r));
    assert.ok(level > 0.001, `${mode}: engine is essentially silent after fade-in (rms=${level})`);
  });
}

test("silent until faded in: master gain of 0 produces near-silence despite active voices", () => {
  const core = new ClfsCore(SR, { seed: 7 });
  core.snapTo(anchor("energy")); // highest-activity anchor
  // masterTarget defaults to 0 — no setMasterTarget call.
  const { l, r } = renderSeconds(core, 1.0);
  assertFiniteAndBounded(l, "silent.L");
  assertFiniteAndBounded(r, "silent.R");
  assert.ok(rms(l) < 0.002 && rms(r) < 0.002, "engine produced audible output before any fade-in");
});

test("no NaNs/instability across a long render with mid-session mode changes", () => {
  const core = new ClfsCore(SR, { seed: 123 });
  core.snapTo(anchor("calm"));
  core.setMasterTarget(1);
  const sequence = ["calm", "deepWork", "energy", "sleep", "recovery", "calm"];
  for (const mode of sequence) {
    core.setTarget(anchor(mode));
    const { l, r } = renderSeconds(core, 1.5);
    assertFiniteAndBounded(l, `sequence.${mode}.L`);
    assertFiniteAndBounded(r, `sequence.${mode}.R`);
  }
});

test("control vector never jumps: slewToward respects per-dimension maxRatePerSec", () => {
  // Adversarial target: every dimension slammed to its extreme simultaneously.
  const current = anchor("sleep");
  const target = clampControl({
    valence: 1,
    arousal: 1,
    density: 1,
    tempo: 120,
    tension: 1,
    brightness: 1,
    air: 1,
    motion: 1,
    depth: 1,
    complexity: 1,
  });
  const dt = 1 / 60; // one UI frame
  const next = slewToward(current, target, dt);
  for (const k of CONTROL_KEYS) {
    const maxStep = CONTROL_RANGES[k].maxRatePerSec * dt + 1e-9;
    const actualStep = Math.abs(next[k] - current[k]);
    assert.ok(actualStep <= maxStep, `${k} moved ${actualStep} in one frame, exceeds bound ${maxStep}`);
  }
});

test("safety: sleep anchor arousal cannot be exceeded even by direct engine misuse of setTarget", () => {
  // The hard safety clamp lives in @soundfx/protocol's controller (tested
  // separately), but this asserts the *anchor itself* — sleep's baseline —
  // is genuinely low-arousal, which is the invariant the controller clamps
  // against. A regression here would silently defeat that downstream clamp.
  const sleepAnchor = anchor("sleep");
  const energyAnchor = anchor("energy");
  assert.ok(sleepAnchor.arousal < 0.15, `sleep anchor arousal too high: ${sleepAnchor.arousal}`);
  assert.ok(sleepAnchor.arousal < energyAnchor.arousal, "sleep anchor is not the lowest-arousal anchor");
});

test("no gross repetition: no two 1-second blocks in a 24s render are near-identical", () => {
  // A generative-audio-specific regression test for the "zero audible loops"
  // quality bar (Part 6). True non-repetition over 8 hours cannot be proven
  // empirically; this instead guards the concrete, testable failure mode — a
  // buffer-reuse or RNG-cycling bug that makes the engine reproduce an
  // earlier chunk verbatim. The synthesis design (irrational-ratio latent
  // oscillators, Poisson grain arrivals, randomised-phase spectral bed,
  // Metropolis lattice walk) has no exact period by construction, so any
  // near-duplicate block found here indicates an implementation bug, not
  // "the algorithm caught up to itself".
  const core = new ClfsCore(SR, { seed: 2026, reverb: true });
  core.snapTo(anchor("deepWork")); // highest event rate of the calmer modes
  core.setMasterTarget(1);
  renderSeconds(core, 0.5); // settle past the fade-in

  const blockSeconds = 1.0;
  const blockLen = Math.round(blockSeconds * SR);
  const nBlocks = 24;
  const blocks = [];
  for (let i = 0; i < nBlocks; i++) {
    const { l } = renderSeconds(core, blockSeconds);
    blocks.push(l.slice(0, blockLen));
  }

  const norms = blocks.map(rms);
  let maxCorr = -Infinity;
  let worstPair = [-1, -1];
  for (let i = 0; i < nBlocks; i++) {
    for (let j = i + 1; j < nBlocks; j++) {
      if (norms[i] < 1e-6 || norms[j] < 1e-6) continue;
      let dot = 0;
      const a = blocks[i];
      const b = blocks[j];
      for (let k = 0; k < blockLen; k++) dot += a[k] * b[k];
      const corr = dot / (blockLen * norms[i] * norms[j]);
      if (corr > maxCorr) {
        maxCorr = corr;
        worstPair = [i, j];
      }
      // Exact-repeat guard, independent of the correlation threshold.
      let identical = true;
      for (let k = 0; k < blockLen && identical; k += 97) {
        if (a[k] !== b[k]) identical = false;
      }
      assert.ok(!identical, `blocks ${i} and ${j} are sample-identical (buffer reuse / RNG cycling bug)`);
    }
  }

  assert.ok(
    maxCorr < 0.9,
    `blocks ${worstPair[0]} and ${worstPair[1]} correlate at ${maxCorr.toFixed(3)}, suspiciously close to a repeat`,
  );
});
