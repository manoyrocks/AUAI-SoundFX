import { test } from "node:test";
import assert from "node:assert/strict";
import { ClfsCore } from "../dist/clfs.js";
import { anchor, constraintsFor, DEFAULT_CONSTRAINTS } from "../dist/control.js";
import {
  articulationIndex,
  privacyRating,
  spectrumEfficiency,
  maskingBedEnvelope,
  LTASS_NORMAL_DB,
  MASKING_TARGET_DB,
  SII_BAND_WEIGHTS,
  OCTAVE_BANDS,
  SYLLABIC_BAND_HZ,
} from "../dist/psychoacoustics.js";
import { Fft } from "../dist/dsp/fft.js";
import { HarmonicWalker } from "../dist/harmony.js";
import { Rng } from "../dist/dsp/rng.js";

const SR = 48000;

/** Render `seconds` of audio from a configured core. */
function render(mode, constraints, seconds, seed = 4242) {
  const core = new ClfsCore(SR, { seed });
  core.snapTo(anchor(mode));
  core.setConstraints(constraints ?? constraintsFor(mode));
  core.setMasterTarget(1);
  const total = Math.floor(SR * seconds);
  const block = 512;
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  const out = new Float32Array(total);
  let written = 0;
  while (written < total) {
    const n = Math.min(block, total - written);
    core.process(l, r, n);
    for (let i = 0; i < n; i++) out[written + i] = (l[i] + r[i]) * 0.5;
    written += n;
  }
  return out;
}

/**
 * Modulation spectrum of a signal: the spectrum of its amplitude envelope.
 *
 * This is the measurement the Read constraint is defined against. The
 * envelope is extracted by full-wave rectification plus decimation to a low
 * envelope sample rate, then transformed. Returns { freqs, mags }.
 */
function modulationSpectrum(signal, sr = SR, envRate = 100) {
  const decim = Math.floor(sr / envRate);
  const nEnv = Math.floor(signal.length / decim);
  // Rectify and average within each decimation window (a crude but standard
  // envelope follower — adequate because we only care about <20 Hz).
  const env = new Float32Array(nEnv);
  for (let i = 0; i < nEnv; i++) {
    let acc = 0;
    for (let j = 0; j < decim; j++) acc += Math.abs(signal[i * decim + j]);
    env[i] = acc / decim;
  }
  // Remove DC — we want fluctuation, not level.
  let mean = 0;
  for (let i = 0; i < nEnv; i++) mean += env[i];
  mean /= nEnv;
  for (let i = 0; i < nEnv; i++) env[i] -= mean;

  const size = 1 << Math.floor(Math.log2(nEnv));
  const fft = new Fft(size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  // Hann window to stop spectral leakage faking energy in adjacent bands.
  for (let i = 0; i < size; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    re[i] = env[i] * w;
  }
  fft.forward(re, im);
  const bins = size / 2;
  const freqs = new Float32Array(bins);
  const mags = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    freqs[k] = (k * envRate) / size;
    mags[k] = Math.hypot(re[k], im[k]);
  }
  return { freqs, mags, meanLevel: mean, size };
}

/** Total modulation energy within a frequency band. */
function bandEnergy(spec, lo, hi) {
  let acc = 0;
  for (let k = 0; k < spec.freqs.length; k++) {
    if (spec.freqs[k] >= lo && spec.freqs[k] <= hi) acc += spec.mags[k] * spec.mags[k];
  }
  return acc;
}

/**
 * Modulation depth in a band: RMS of the band-limited envelope fluctuation
 * divided by the mean envelope level.
 *
 * The first version of this measured the *fraction* of total modulation
 * energy landing in the syllabic band, which was wrong and actively
 * misleading: a lowpass that removes more energy above 8 Hz than inside
 * 2-8 Hz raises that fraction while genuinely reducing syllabic modulation.
 * Depth relative to mean level is the quantity corresponding to what the ear
 * hears as fluctuation, and it is independent of overall loudness.
 */
function modulationDepth(signal, lo, hi) {
  const spec = modulationSpectrum(signal);
  const rms = Math.sqrt(2 * bandEnergy(spec, lo, hi)) / (spec.size * 0.5);
  return rms / Math.max(1e-9, spec.meanLevel);
}

function syllabicDepth(signal) {
  return modulationDepth(signal, SYLLABIC_BAND_HZ.low, SYLLABIC_BAND_HZ.high);
}

// ================================================ articulation index

test("articulation index is high with no masker and low with a strong one", () => {
  const noMasker = LTASS_NORMAL_DB.map(() => 0);
  const strong = LTASS_NORMAL_DB.map((d) => d + 12);
  const aiOpen = articulationIndex(LTASS_NORMAL_DB, noMasker);
  const aiMasked = articulationIndex(LTASS_NORMAL_DB, strong);
  assert.ok(aiOpen > 0.9, `unmasked speech should be highly intelligible, got ${aiOpen}`);
  assert.ok(aiMasked < 0.05, `speech under a +12 dB masker should be unintelligible, got ${aiMasked}`);
});

test("articulation index decreases monotonically as the masker rises", () => {
  let prev = Infinity;
  for (let offset = -20; offset <= 20; offset += 5) {
    const masker = LTASS_NORMAL_DB.map((d) => d + offset);
    const ai = articulationIndex(LTASS_NORMAL_DB, masker);
    assert.ok(ai <= prev + 1e-9, `AI rose when masker increased (offset ${offset})`);
    prev = ai;
  }
});

test("articulation index stays within [0,1] for extreme inputs", () => {
  for (const offset of [-200, -50, 0, 50, 200]) {
    const masker = LTASS_NORMAL_DB.map((d) => d + offset);
    const ai = articulationIndex(LTASS_NORMAL_DB, masker);
    assert.ok(ai >= 0 && ai <= 1, `AI out of range: ${ai} at offset ${offset}`);
  }
});

test("privacy ratings follow the open-plan acoustics convention", () => {
  assert.equal(privacyRating(0.05), "confidential");
  assert.equal(privacyRating(0.15), "confidential");
  assert.equal(privacyRating(0.25), "normal");
  assert.equal(privacyRating(0.4), "marginal");
  assert.equal(privacyRating(0.6), "poor");
});

test("SII band weights are the ANSI S3.5 set and sum to 1", () => {
  const sum = SII_BAND_WEIGHTS.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `weights sum to ${sum}, expected 1`);
  assert.equal(SII_BAND_WEIGHTS.length, OCTAVE_BANDS.length);
  // The 1-4 kHz region must dominate — that is why masking targets it.
  const mid = SII_BAND_WEIGHTS[2] + SII_BAND_WEIGHTS[3] + SII_BAND_WEIGHTS[4];
  assert.ok(mid > 0.7, `1-4 kHz should carry most speech information, got ${mid}`);
});

// ============================================== masking spectrum shape

test("the masking target spends energy more efficiently than white or pink noise", () => {
  const white = OCTAVE_BANDS.map(() => 0);
  // Pink: -3 dB per octave.
  const pink = OCTAVE_BANDS.map((_, i) => -3 * i);
  const target = spectrumEfficiency(MASKING_TARGET_DB);
  const w = spectrumEfficiency(white);
  const p = spectrumEfficiency(pink);
  assert.ok(target > w, `masking curve (${target.toFixed(3)}) should beat white (${w.toFixed(3)})`);
  assert.ok(target > p, `masking curve (${target.toFixed(3)}) should beat pink (${p.toFixed(3)})`);
});

test("spectrum efficiency is level-independent", () => {
  // This is the property that makes it an honest claim: shifting the whole
  // spectrum up or down must not change the score.
  const base = spectrumEfficiency(MASKING_TARGET_DB);
  for (const offset of [-30, -10, 10, 30]) {
    const shifted = MASKING_TARGET_DB.map((d) => d + offset);
    assert.ok(
      Math.abs(spectrumEfficiency(shifted) - base) < 1e-9,
      `efficiency changed with level offset ${offset}`,
    );
  }
});

test("masking bed envelope peaks in the speech band, not at the extremes", () => {
  const bands = maskingBedEnvelope(14);
  assert.equal(bands.length, 14);
  for (const v of bands) assert.ok(v >= 0 && v <= 1 && Number.isFinite(v));
  let peakIdx = 0;
  for (let i = 1; i < bands.length; i++) if (bands[i] > bands[peakIdx]) peakIdx = i;
  assert.ok(peakIdx > 2 && peakIdx < 11, `masking energy peaked at band ${peakIdx}, expected mid-spectrum`);
  // Top band must be well down — a bright masker is the one people turn off.
  assert.ok(bands[13] < 0.4, `top band too hot (${bands[13]}) — masker would be hissy`);
});

// ========================================= syllabic modulation constraint

test("Read mode measurably suppresses modulation in the speech syllabic band", () => {
  // The measurement that defines the constraint. Same anchor both times, so
  // the only difference is whether the acoustic rules are enforced.
  const constrained = syllabicDepth(render("read", constraintsFor("read"), 24));
  const unconstrained = syllabicDepth(render("read", DEFAULT_CONSTRAINTS, 24));

  assert.ok(
    constrained < unconstrained * 0.85,
    `expected >15% cut in syllabic modulation: ${constrained.toFixed(4)} vs ${unconstrained.toFixed(4)}`,
  );
  assert.ok(constrained < 0.17, `syllabic modulation depth still too high: ${constrained.toFixed(4)}`);
});

test("suppression is band-specific, not just an overall smoothing", () => {
  // A constraint that made the output uniformly inert would pass the test
  // above while destroying the mode. Confirm fluctuation survives *outside*
  // the protected band.
  const sig = render("read", constraintsFor("read"), 24);
  const syllabic = syllabicDepth(sig);
  const slow = modulationDepth(sig, 0.3, 2);
  assert.ok(slow > syllabic, `slow drift (${slow.toFixed(4)}) should exceed syllabic (${syllabic.toFixed(4)})`);
  assert.ok(slow > 0.05, "output became inert rather than selectively smoothed");
});

test("Deep Work, which has no such constraint, is not accidentally suppressed", () => {
  // Guards against the constraint leaking into modes that never asked for
  // it — which would quietly flatten the whole product.
  const deepWork = syllabicDepth(render("deepWork", DEFAULT_CONSTRAINTS, 24));
  const read = syllabicDepth(render("read", constraintsFor("read"), 24));
  assert.ok(deepWork > read, `Deep Work (${deepWork.toFixed(4)}) should modulate more than Read (${read.toFixed(4)})`);
});

test("Screen mode is temporally featureless", () => {
  // A masker must not have events; anything eventful recruits the attention
  // it is supposed to be protecting.
  const depth = syllabicDepth(render("screen", constraintsFor("screen"), 24));
  assert.ok(depth < 0.07, `masker fluctuates too much: depth ${depth.toFixed(4)}`);
});

test("constrained modes still produce audible, non-silent, finite output", () => {
  // A constraint that silences the engine would trivially pass the
  // modulation tests, so assert there is actually sound.
  for (const mode of ["read", "screen", "open", "move"]) {
    const buf = render(mode, constraintsFor(mode), 6);
    let peak = 0;
    let energy = 0;
    for (const v of buf) {
      assert.ok(Number.isFinite(v), `${mode} produced a non-finite sample`);
      peak = Math.max(peak, Math.abs(v));
      energy += v * v;
    }
    const rms = Math.sqrt(energy / buf.length);
    assert.ok(peak > 0.01, `${mode} is effectively silent (peak ${peak})`);
    assert.ok(peak <= 1.0001, `${mode} clipped (peak ${peak})`);
    assert.ok(rms > 0.001, `${mode} RMS too low (${rms})`);
  }
});

// ============================================================ cadence

test("reported event rate matches the true rate, not a decaying spike", () => {
  // Regression test. The estimator previously used a fixed per-block alpha
  // giving a ~0.1 s time constant, so with events every 0.4 s any single
  // reading was mostly a decayed spike — typically several times too low.
  const core = new ClfsCore(SR, { seed: 21 });
  core.snapTo(anchor("move"));
  const spm = 150;
  core.setConstraints({ ...DEFAULT_CONSTRAINTS, cadenceSpm: spm });
  core.setMasterTarget(1);

  const block = 512;
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  // Let the estimator settle past its 4 s window, then sample repeatedly.
  for (let i = 0; i < (SR * 12) / block; i++) core.process(l, r, block);

  const samples = [];
  for (let i = 0; i < (SR * 12) / block; i++) {
    core.process(l, r, block);
    if (i % 20 === 0) samples.push(core.telemetry().eventsPerSec);
  }
  const expected = spm / 60; // 2.5 events/s
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(
    Math.abs(mean - expected) / expected < 0.25,
    `mean reported rate ${mean.toFixed(2)} should be near ${expected.toFixed(2)}`,
  );
  // Individual readings must also be usable, not wild.
  const low = samples.filter((s) => s < expected * 0.4).length / samples.length;
  assert.ok(low < 0.2, `${(low * 100).toFixed(0)}% of readings were far too low — estimator still spiky`);
});

test("Move mode locks onset intervals to the requested cadence", () => {
  const core = new ClfsCore(SR, { seed: 99 });
  core.snapTo(anchor("move"));
  const spm = 160; // typical running cadence
  core.setConstraints({ ...DEFAULT_CONSTRAINTS, cadenceSpm: spm });
  core.setMasterTarget(1);

  const seconds = 30;
  const block = 512;
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  let elapsed = 0;
  let events = 0;
  let prev = core.telemetry().eventsPerSec;
  // Count events via the engine's own counter across the run.
  const total = SR * seconds;
  let written = 0;
  const rates = [];
  while (written < total) {
    core.process(l, r, block);
    written += block;
    elapsed += block / SR;
    if (written % (SR * 2) < block) rates.push(core.telemetry().eventsPerSec);
  }
  // Mean event rate should approach cadence/60 (steps per second).
  const expected = spm / 60;
  const observed = rates.filter((x) => x > 0);
  assert.ok(observed.length > 0, "no event-rate telemetry captured");
  const mean = observed.reduce((a, b) => a + b, 0) / observed.length;
  assert.ok(
    Math.abs(mean - expected) / expected < 0.35,
    `cadence lock off: expected ~${expected.toFixed(2)} ev/s, observed ${mean.toFixed(2)}`,
  );
});

test("cadence lock makes onsets near-periodic, not merely the right average", () => {
  // Entrainment needs a trackable beat. A Poisson process with the correct
  // mean rate would pass a rate test but entrain nothing, so this checks
  // the regularity of the intervals themselves.
  const core = new ClfsCore(SR, { seed: 7 });
  core.snapTo(anchor("move"));
  core.setConstraints({ ...DEFAULT_CONSTRAINTS, cadenceSpm: 120 });
  core.setMasterTarget(1);
  const buf = [];
  const block = 512;
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  for (let i = 0; i < (SR * 20) / block; i++) {
    core.process(l, r, block);
    for (let j = 0; j < block; j++) buf.push(Math.abs(l[j] + r[j]) * 0.5);
  }
  const sig = Float32Array.from(buf);
  const spec = modulationSpectrum(sig);
  // A 120 spm cadence is 2 Hz. There should be a clear modulation peak there.
  let peakK = 0;
  for (let k = 1; k < spec.freqs.length; k++) {
    if (spec.freqs[k] > 0.5 && spec.freqs[k] < 8 && spec.mags[k] > spec.mags[peakK]) peakK = k;
  }
  const peakHz = spec.freqs[peakK];
  assert.ok(
    Math.abs(peakHz - 2) < 0.6,
    `expected a modulation peak near 2 Hz for 120 spm, found ${peakHz.toFixed(2)} Hz`,
  );
});

// ========================================================= token set

/**
 * Tension 0.9 throughout these tests, deliberately. At low tension the
 * Tenney-distance budget already admits only one or two lattice points, so
 * the cap has nothing to do and a test there would pass while proving
 * nothing. The cap earns its keep as a guarantee that holds *even when
 * tension is high* — including if the biofeedback controller raises tension
 * mid-session.
 */
const WIDE_TENSION = 0.9;

test("token-set cap bounds the number of distinct pitches", () => {
  const walker = new HarmonicWalker(new Rng(5));
  walker.setTokenSetLimit(5);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const p = walker.step(WIDE_TENSION, 0.5);
    seen.add(`${p.b},${p.c},${p.d}`);
  }
  assert.ok(seen.size <= 5, `token set grew to ${seen.size}, limit was 5`);
  assert.ok(seen.size > 1, "token set collapsed to a single pitch");
});

test("without a cap the walker keeps finding new pitches", () => {
  // Confirms the cap is doing real work rather than matching default behaviour.
  const walker = new HarmonicWalker(new Rng(5));
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const p = walker.step(WIDE_TENSION, 0.5);
    seen.add(`${p.b},${p.c},${p.d}`);
  }
  assert.ok(seen.size > 8, `expected wide pitch variety, only saw ${seen.size}`);
});

test("token-set cap increases immediate pitch repetition", () => {
  // The changing-state finding is about *adjacent* tokens, so the cap has to
  // raise the rate at which an event repeats the previous pitch. Bounding
  // the set alone would not deliver that.
  const repeatRate = (limit) => {
    const walker = new HarmonicWalker(new Rng(11));
    if (limit) walker.setTokenSetLimit(limit);
    let prev = null;
    let repeats = 0;
    const n = 3000;
    for (let i = 0; i < n; i++) {
      const p = walker.step(WIDE_TENSION, 0.5);
      const key = `${p.b},${p.c},${p.d}`;
      if (key === prev) repeats++;
      prev = key;
    }
    return repeats / n;
  };
  const capped = repeatRate(5);
  const free = repeatRate(0);
  assert.ok(capped > free * 1.5, `capped repeat ${capped.toFixed(3)} should clearly exceed free ${free.toFixed(3)}`);
});

test("low tension already bounds the token set without any cap", () => {
  // Documents why the cap is a guarantee rather than the primary mechanism:
  // Read's own tension of 0.08 collapses the reachable lattice by itself.
  const walker = new HarmonicWalker(new Rng(3));
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const p = walker.step(0.08, 0.04);
    seen.add(`${p.b},${p.c},${p.d}`);
  }
  assert.ok(seen.size <= 3, `expected a near-static walk at low tension, saw ${seen.size} pitches`);
});

// ======================================================== constraints

test("constraintsFor returns the documented rules per mode", () => {
  assert.equal(constraintsFor("read").avoidSyllabicModulation, true);
  assert.ok(constraintsFor("read").maxTokenSet > 0);
  assert.equal(constraintsFor("screen").maskingSpectrum, true);
  // Modes with no acoustic rules must be genuinely unconstrained.
  for (const mode of ["deepWork", "calm", "sleep", "energy", "recovery", "open", "move"]) {
    assert.equal(constraintsFor(mode).maskingSpectrum, false, `${mode} should not force a masking spectrum`);
  }
  for (const mode of ["deepWork", "calm", "sleep", "energy", "recovery", "open"]) {
    assert.equal(constraintsFor(mode).cadenceSpm, 0, `${mode} should not be cadence-locked`);
  }
});

test("setConstraints is idempotent and reversible", () => {
  const core = new ClfsCore(SR, { seed: 3 });
  core.setConstraints(constraintsFor("read"));
  assert.equal(core.getConstraints().avoidSyllabicModulation, true);
  core.setConstraints(DEFAULT_CONSTRAINTS);
  assert.equal(core.getConstraints().avoidSyllabicModulation, false);
  assert.equal(core.getConstraints().maxTokenSet, 0);
  // A partial update must reset unspecified fields to the default rather
  // than silently retaining a previous mode's rules.
  core.setConstraints({ maskingSpectrum: true });
  assert.equal(core.getConstraints().avoidSyllabicModulation, false);
  assert.equal(core.getConstraints().maskingSpectrum, true);
});

test("masking efficiency is reported only in masking mode", () => {
  const core = new ClfsCore(SR, { seed: 3 });
  assert.equal(core.maskingEfficiency(), 0);
  core.setConstraints(constraintsFor("screen"));
  assert.ok(core.maskingEfficiency() > 0.5, "masking curve should score well against the SII weights");
});
