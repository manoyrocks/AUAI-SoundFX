import { test } from "node:test";
import assert from "node:assert/strict";
import { OutcomeRecorder, computeDelta, summariseMode } from "../dist/outcomes.js";
import { PhysiologyBaseline } from "../dist/baseline.js";

// ScalarBaseline has a deliberately slow ~180/240-sample half-life (see
// baseline.ts — it's meant to track minutes, not snap in a handful of
// updates), so converging it close to a target for test setup needs a large
// iteration count, not the ~20-30 samples that merely cross its `trusted`
// threshold.
function warmBaseline(hr, hrv) {
  const b = new PhysiologyBaseline();
  for (let i = 0; i < 800; i++) {
    b.hr.update(hr, 0.9);
    b.hrv.update(hrv, 0.9);
  }
  return b;
}

function driftBaseline(baseline, hr, hrv, steps = 800) {
  for (let i = 0; i < steps; i++) {
    baseline.hr.update(hr, 0.9);
    baseline.hrv.update(hrv, 0.9);
  }
}

test("OutcomeRecorder captures start/end baselines and duration", () => {
  const rec = new OutcomeRecorder();
  const baseline = warmBaseline(78, 30);
  rec.begin("deepWork", true, baseline, 1_000_000);
  for (let i = 0; i < 12; i++) rec.recordSample();

  // Simulate the session calming the user: baseline drifts down.
  driftBaseline(baseline, 66, 48);

  const outcome = rec.end(baseline, 1_000_000 + 20 * 60 * 1000);
  assert.ok(outcome);
  assert.equal(outcome.mode, "deepWork");
  assert.equal(outcome.durationMs, 20 * 60 * 1000);
  assert.equal(outcome.cameraUsed, true);
  assert.equal(outcome.sampleCount, 12);
  assert.ok(outcome.startHrBpm != null && Math.abs(outcome.startHrBpm - 78) < 1);
  assert.ok(outcome.endHrBpm != null && outcome.endHrBpm < outcome.startHrBpm);
});

test("end() without begin() returns null rather than a garbage record", () => {
  const rec = new OutcomeRecorder();
  const baseline = warmBaseline(70, 40);
  assert.equal(rec.end(baseline, Date.now()), null);
});

test("computeDelta withholds a number when sample count is too low (honesty gate)", () => {
  const rec = new OutcomeRecorder();
  const baseline = warmBaseline(80, 25);
  rec.begin("calm", true, baseline, 0);
  rec.recordSample();
  rec.recordSample(); // only 2 samples — below MIN_SAMPLES_FOR_RELIABLE_DELTA
  const outcome = rec.end(baseline, 5 * 60 * 1000);
  const delta = computeDelta(outcome);
  assert.equal(delta.reliable, false);
});

test("computeDelta reports a delta once enough samples were observed", () => {
  const rec = new OutcomeRecorder();
  const baseline = warmBaseline(90, 20);
  rec.begin("recovery", true, baseline, 0);
  for (let i = 0; i < 20; i++) rec.recordSample();
  for (let i = 0; i < 30; i++) baseline.hr.update(70, 0.9);
  const outcome = rec.end(baseline, 10 * 60 * 1000);
  const delta = computeDelta(outcome);
  assert.equal(delta.reliable, true);
  assert.ok(delta.hrDeltaBpm != null && delta.hrDeltaBpm < 0);
});

test("summariseMode never fabricates a mean from zero reliable sessions", () => {
  const summary = summariseMode("sleep", []);
  assert.equal(summary.n, 0);
  assert.equal(summary.meanHrDeltaBpm, null);
});

test("summariseMode aggregates only reliable sessions into the mean delta", () => {
  const sessions = [
    {
      id: "a",
      mode: "calm",
      startedAtMs: 0,
      endedAtMs: 600000,
      durationMs: 600000,
      cameraUsed: true,
      startHrBpm: 80,
      endHrBpm: 70,
      startHrvMs: 30,
      endHrvMs: 40,
      sampleCount: 20, // reliable
    },
    {
      id: "b",
      mode: "calm",
      startedAtMs: 0,
      endedAtMs: 600000,
      durationMs: 600000,
      cameraUsed: true,
      startHrBpm: 90,
      endHrBpm: 60, // implausible 30bpm swing — included only to prove it's excluded below
      startHrvMs: 20,
      endHrvMs: 20,
      sampleCount: 2, // NOT reliable
    },
  ];
  const summary = summariseMode("calm", sessions);
  assert.equal(summary.n, 2);
  assert.equal(summary.nReliable, 1);
  assert.ok(summary.meanHrDeltaBpm != null && Math.abs(summary.meanHrDeltaBpm - -10) < 1e-9);
});
