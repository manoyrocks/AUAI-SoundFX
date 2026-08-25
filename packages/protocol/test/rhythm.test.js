import { test } from "node:test";
import assert from "node:assert/strict";
import { OnlineRidge } from "../dist/rhythm/ridge.js";
import { PersonalRhythmModel } from "../dist/rhythm/model.js";
import { suggestNext, upcomingWindows } from "../dist/rhythm/suggest.js";
import { features, timeContext, basisById } from "../dist/rhythm/basis.js";

// Deterministic noise so failures are reproducible.
function makeRng(seed = 12345) {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    return (s >>> 0) / 4294967296;
  };
}
function gauss(rand) {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** A local-midnight anchor so hour-of-day maths is unambiguous. */
function localMidnight(daysAgo = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - daysAgo * 86400000;
}

/**
 * Generate observations from a known ground-truth curve.
 * `curve(hour, dayOfWeek)` returns the true arousal z.
 */
function synthesise(model, curve, opts = {}) {
  const { days = 30, perDay = 6, noise = 0.25, seed = 7, hours = [7, 10, 13, 16, 19, 22] } = opts;
  const rand = makeRng(seed);
  for (let d = days; d >= 1; d--) {
    const base = localMidnight(d);
    for (let i = 0; i < perDay; i++) {
      const hour = hours[i % hours.length];
      const ts = base + hour * 3600000;
      const dow = new Date(ts).getDay();
      model.observe({
        timestampMs: ts,
        arousalZ: curve(hour, dow) + noise * gauss(rand),
        weight: 0.9,
      });
    }
  }
}

// ------------------------------------------------------------------ ridge

test("OnlineRidge recovers known linear coefficients", () => {
  const r = new OnlineRidge(3, 1e-6);
  const truth = [1.5, -2.0, 0.75];
  const rand = makeRng(99);
  for (let i = 0; i < 500; i++) {
    const x = new Float64Array([1, rand() * 4 - 2, rand() * 4 - 2]);
    const y = truth[0] * x[0] + truth[1] * x[1] + truth[2] * x[2] + 0.05 * gauss(rand);
    r.observe(x, y);
  }
  const beta = r.coefficients();
  assert.ok(beta);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(beta[i] - truth[i]) < 0.05, `coef ${i}: got ${beta[i]}, want ${truth[i]}`);
  }
});

test("OnlineRidge is unsolvable (null) before it has enough data", () => {
  const r = new OnlineRidge(4, 0);
  assert.equal(r.coefficients(), null);
  assert.equal(r.predict(new Float64Array([1, 0, 0, 0])), null);
});

test("OnlineRidge predictive std is larger where it has no data", () => {
  const r = new OnlineRidge(2, 1e-6);
  const rand = makeRng(5);
  // Observe only x1 near 0.
  for (let i = 0; i < 300; i++) {
    const x = new Float64Array([1, 0.01 * gauss(rand)]);
    r.observe(x, 1 + 0.1 * gauss(rand));
  }
  const near = r.predictiveStd(new Float64Array([1, 0]));
  const far = r.predictiveStd(new Float64Array([1, 5]));
  assert.ok(far > near * 2, `extrapolation should be far less certain: near=${near}, far=${far}`);
});

test("OnlineRidge decay reduces effective sample count", () => {
  const r = new OnlineRidge(2);
  const x = new Float64Array([1, 1]);
  for (let i = 0; i < 100; i++) r.observe(x, 1);
  assert.ok(Math.abs(r.effectiveN - 100) < 1e-9);
  r.decay(0.5);
  assert.ok(Math.abs(r.effectiveN - 50) < 1e-9);
});

// ------------------------------------------------------- readiness gating

test("model refuses to predict before it is ready", () => {
  const m = new PersonalRhythmModel();
  assert.equal(m.isReady(), false);
  assert.equal(m.predictAt(Date.now()), null);
  assert.deepEqual(m.findWindows(Date.now(), 24, "focus"), []);
  assert.deepEqual(m.dailyCurve(Date.now()), []);
  assert.ok(m.readinessNote().length > 0);
});

test("many observations at ONE time of day still do not make it ready", () => {
  // The specific failure this guards: a user who only ever runs a 9am
  // session should not get afternoon forecasts by extrapolation.
  const m = new PersonalRhythmModel();
  synthesise(m, () => 0.5, { days: 40, perDay: 4, hours: [9] });
  const c = m.coverage();
  assert.ok(c.totalObservations >= 60, "should have plenty of raw observations");
  assert.equal(c.distinctHours, 1);
  assert.equal(m.isReady(), false, "coverage gate should reject single-hour data");
  assert.equal(m.predictAt(Date.now()), null);
});

test("readiness requires spread across days, not just hours", () => {
  const m = new PersonalRhythmModel();
  // One single day, many hours.
  const base = localMidnight(1);
  for (let h = 0; h < 24; h++) {
    for (let k = 0; k < 5; k++) {
      m.observe({ timestampMs: base + h * 3600000 + k * 60000, arousalZ: 0.2, weight: 0.9 });
    }
  }
  assert.ok(m.coverage().distinctHours >= 20);
  assert.ok(m.coverage().distinctDays <= 2);
  assert.equal(m.isReady(), false, "single-day data should not be forecastable");
});

// ------------------------------------------------------- curve recovery

test("model recovers a known circadian curve", () => {
  const m = new PersonalRhythmModel();
  // Peak alertness ~15:00, trough ~03:00.
  const truth = (hour) => 0.9 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  synthesise(m, truth, { days: 40, noise: 0.2 });

  assert.equal(m.isReady(), true);
  for (const hour of [7, 10, 13, 16, 19, 22]) {
    const ts = localMidnight(0) + hour * 3600000;
    const p = m.predictAt(ts);
    assert.ok(p, `no prediction at ${hour}h`);
    assert.ok(
      Math.abs(p.arousalZ - truth(hour)) < 0.25,
      `at ${hour}h predicted ${p.arousalZ.toFixed(2)}, truth ${truth(hour).toFixed(2)}`,
    );
  }
});

test("predicted slope is negative while the true curve is declining", () => {
  const m = new PersonalRhythmModel();
  const truth = (hour) => 0.9 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  synthesise(m, truth, { days: 40, noise: 0.15 });
  // 19:00 and 22:00 are past the 15:00 peak, so the curve is falling.
  for (const hour of [19, 22]) {
    const p = m.predictAt(localMidnight(0) + hour * 3600000);
    assert.ok(p.slopePerHour < 0, `slope at ${hour}h should be negative, got ${p.slopePerHour}`);
  }
});

// -------------------------------------------------- prequential selection

test("selection prefers the flat model when the user has no real rhythm", () => {
  const m = new PersonalRhythmModel();
  synthesise(m, () => 0.3, { days: 50, noise: 0.4, seed: 21 });
  assert.equal(m.selectedBasis().id, "flat", `chose ${m.selectedBasis().id} on rhythm-free data`);
});

test("selection prefers a rhythmic model when a real daily rhythm exists", () => {
  const m = new PersonalRhythmModel();
  const truth = (hour) => 1.1 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  synthesise(m, truth, { days: 50, noise: 0.2, seed: 33 });
  assert.notEqual(m.selectedBasis().id, "flat", "failed to detect a clear daily rhythm");
});

test("selection rejects the clock-anchored ultradian term on data that has none", () => {
  // This is the point of having a rejectable component: the ultradian
  // candidate carries two extra parameters that a clean circadian signal
  // does not justify, so honest held-out scoring should not select it.
  const m = new PersonalRhythmModel();
  const truth = (hour) => 1.0 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  synthesise(m, truth, { days: 50, noise: 0.2, seed: 44 });
  assert.notEqual(
    m.selectedBasis().id,
    "circadian2-weekly-ultradian",
    "selected an ultradian term against data containing no ultradian signal",
  );
});

test("modelScores exposes every candidate for the transparency surface", () => {
  const m = new PersonalRhythmModel();
  synthesise(m, (h) => Math.cos((2 * Math.PI * (h - 15)) / 24), { days: 40 });
  const scores = m.modelScores();
  assert.equal(scores.length, 5);
  for (const s of scores) {
    assert.ok(typeof s.id === "string" && s.label.length > 0);
  }
  assert.ok(scores.some((s) => s.meanSquaredError != null), "no candidate was ever scored");
});

// ------------------------------------------------------------- windows

test("focus windows land near the predicted daily peak", () => {
  const m = new PersonalRhythmModel();
  // Centre the band: peak at 15:00 with amplitude inside the focus band.
  const truth = (hour) => 0.5 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  synthesise(m, truth, { days: 45, noise: 0.15, seed: 55 });

  const start = localMidnight(0);
  const windows = m.findWindows(start, 24, "focus");
  assert.ok(windows.length > 0, "expected at least one focus window across a day");
  for (const w of windows) {
    assert.ok(w.endMs > w.startMs);
    assert.ok(w.confidence >= 0.35);
    assert.ok(w.meanArousalZ >= -0.35 && w.meanArousalZ <= 0.85, `window outside focus band: ${w.meanArousalZ}`);
  }
});

test("windDown windows only appear where the curve is actually declining", () => {
  const m = new PersonalRhythmModel();
  const truth = (hour) => 0.7 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  synthesise(m, truth, { days: 45, noise: 0.15, seed: 66 });

  const start = localMidnight(0);
  for (const w of m.findWindows(start, 24, "windDown")) {
    // Sample the middle of each reported window and confirm it is settling.
    const mid = (w.startMs + w.endMs) / 2;
    const p = m.predictAt(mid);
    assert.ok(p.slopePerHour < 0, `windDown window at slope ${p.slopePerHour} is not declining`);
  }
});

test("no windows are invented when the model is not ready", () => {
  const m = new PersonalRhythmModel();
  for (const goal of ["focus", "windDown", "recovery"]) {
    assert.deepEqual(m.findWindows(Date.now(), 48, goal), []);
    assert.equal(m.nextWindow(Date.now(), 48, goal), null);
  }
});

// ---------------------------------------------------------- suggestions

test("suggestNext returns null before the model is ready", () => {
  const m = new PersonalRhythmModel();
  assert.equal(suggestNext(m, Date.now()), null);
  assert.deepEqual(upcomingWindows(m, Date.now()), []);
});

test("suggestNext proposes a real protocol with a start time and a reason", () => {
  const m = new PersonalRhythmModel();
  const truth = (hour) => 0.5 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  synthesise(m, truth, { days: 45, noise: 0.15, seed: 77 });

  // Search from a few different times of day to find one that yields a
  // suggestion within the lead-time limit.
  let found = null;
  for (const hour of [6, 9, 12, 15, 18, 21]) {
    const s = suggestNext(m, localMidnight(0) + hour * 3600000);
    if (s) {
      found = s;
      break;
    }
  }
  assert.ok(found, "expected at least one suggestion across the day");
  assert.ok(["deep-work", "wind-down", "recovery"].includes(found.protocol.id));
  assert.ok(found.reason.length > 20, "suggestion must explain itself");
  assert.ok(found.minutesUntilStart <= 240, "suggestion exceeded the max lead time");
  assert.ok(found.startAtMs >= 0);
});

test("suggestNext never proposes something more than 4 hours out", () => {
  const m = new PersonalRhythmModel();
  const truth = (hour) => 0.5 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  synthesise(m, truth, { days: 45, noise: 0.15, seed: 88 });
  for (let hour = 0; hour < 24; hour++) {
    const s = suggestNext(m, localMidnight(0) + hour * 3600000);
    if (s) assert.ok(s.minutesUntilStart <= 240, `lead time ${s.minutesUntilStart} min at ${hour}h`);
  }
});

// -------------------------------------------------------- serialisation

test("snapshot/restore round-trips predictions exactly", () => {
  const m = new PersonalRhythmModel();
  const truth = (hour) => 0.8 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  synthesise(m, truth, { days: 40, noise: 0.2, seed: 101 });

  const restored = PersonalRhythmModel.restore(JSON.parse(JSON.stringify(m.snapshot())));
  assert.equal(restored.isReady(), m.isReady());
  assert.equal(restored.selectedBasis().id, m.selectedBasis().id);

  for (const hour of [8, 14, 20]) {
    const ts = localMidnight(0) + hour * 3600000;
    const a = m.predictAt(ts);
    const b = restored.predictAt(ts);
    assert.ok(Math.abs(a.arousalZ - b.arousalZ) < 1e-9, `mismatch at ${hour}h`);
    assert.ok(Math.abs(a.std - b.std) < 1e-9);
  }
});

test("restore survives corrupt, empty, and null snapshots without throwing", () => {
  for (const bad of [null, undefined, {}, { version: 99 }, { version: 1, models: null }]) {
    const m = PersonalRhythmModel.restore(bad);
    assert.equal(m.isReady(), false);
    assert.equal(m.predictAt(Date.now()), null);
  }
});

test("a snapshot contains no raw observations — only sufficient statistics", () => {
  // The privacy claim in docs/05-privacy.md depends on this being true.
  const m = new PersonalRhythmModel();
  const marker = 0.987654321;
  const base = localMidnight(3);
  for (let d = 0; d < 10; d++) {
    for (const h of [8, 12, 16, 20]) {
      m.observe({ timestampMs: base + d * 86400000 + h * 3600000, arousalZ: marker, weight: 1 });
    }
  }
  const json = JSON.stringify(m.snapshot());
  assert.ok(!json.includes("987654321"), "raw observation value leaked into the snapshot");
  // Timestamps of individual observations must not be retained either; only
  // the coarse day keys and the last-observation marker are.
  const snap = m.snapshot();
  assert.equal(snap.dayKeys.length, 10, "expected one key per day, not per observation");
});

// -------------------------------------------------------------- basis

test("feature vectors have the declared dimension and are finite", () => {
  const ctx = timeContext(Date.now());
  for (const id of ["flat", "circadian", "circadian2", "circadian2-weekly", "circadian2-weekly-ultradian"]) {
    const b = basisById(id);
    assert.ok(b, `missing basis ${id}`);
    const x = features(b, ctx);
    assert.equal(x.length, b.dim);
    for (const v of x) assert.ok(Number.isFinite(v));
  }
});

test("circadian features are periodic over 24 hours", () => {
  const b = basisById("circadian2");
  const t0 = localMidnight(0) + 9 * 3600000;
  const a = features(b, timeContext(t0));
  const c = features(b, timeContext(t0 + 86400000));
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - c[i]) < 1e-9, `feature ${i} not 24h-periodic`);
  }
});
