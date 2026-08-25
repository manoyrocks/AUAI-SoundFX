import { test } from "node:test";
import assert from "node:assert/strict";
import { PhysiologyBaseline, ScalarBaseline } from "../dist/baseline.js";

function train(b, value, n = 200, confidence = 0.9) {
  for (let i = 0; i < n; i++) b.update(value, confidence);
}

test("snapshot round-trips mean, variance and trust", () => {
  const a = new ScalarBaseline(68, 100, 180);
  train(a, 82);
  assert.equal(a.trusted, true);

  const b = new ScalarBaseline(68, 100, 180);
  b.restore(a.snapshot());

  assert.ok(Math.abs(b.value - a.value) < 1e-9, `mean mismatch: ${b.value} vs ${a.value}`);
  assert.ok(Math.abs(b.std - a.std) < 1e-9, "std mismatch");
  assert.equal(b.trusted, a.trusted);
  // The restored baseline must score an identical reading identically.
  assert.ok(Math.abs(b.zScore(90, 3) - a.zScore(90, 3)) < 1e-9);
});

test("restoring without the effective weight would fake confidence — weight is carried", () => {
  // Guards the specific mistake of persisting only mean/variance: the
  // restored baseline would look settled while resting on no evidence.
  const trained = new ScalarBaseline(68, 100, 180);
  train(trained, 75);
  const snap = trained.snapshot();
  assert.ok(snap.weight > 20, `expected an accumulated weight, got ${snap.weight}`);

  const fresh = new ScalarBaseline(68, 100, 180);
  assert.equal(fresh.trusted, false);
  fresh.restore({ ...snap, weight: 0 });
  assert.equal(fresh.trusted, false, "zero weight must not produce a trusted baseline");
});

test("restore rejects non-finite values rather than corrupting state", () => {
  const b = new ScalarBaseline(68, 100, 180);
  train(b, 70);
  const before = b.value;
  for (const bad of [
    { mean: NaN, variance: 10, weight: 50 },
    { mean: 70, variance: Infinity, weight: 50 },
    { mean: 70, variance: 10, weight: NaN },
  ]) {
    b.restore(bad);
    assert.equal(b.value, before, "a malformed snapshot changed the baseline");
    assert.ok(Number.isFinite(b.std));
  }
});

test("restore clamps a degenerate variance", () => {
  const b = new ScalarBaseline(68, 100, 180);
  b.restore({ mean: 70, variance: -5, weight: 50 });
  assert.ok(b.std > 0 && Number.isFinite(b.std), `std must stay positive, got ${b.std}`);
});

test("restore clamps an absurd weight rather than trusting it", () => {
  const b = new ScalarBaseline(68, 100, 180);
  b.restore({ mean: 70, variance: 10, weight: 1e9 });
  // Bounded to the same ceiling the update path maintains.
  const snap = b.snapshot();
  assert.ok(snap.weight <= 500, `weight not clamped: ${snap.weight}`);
});

test("reset returns a trained baseline to its untrained prior", () => {
  // This is what makes "delete my data" real: clearing storage alone would
  // leave the learned baseline live for the rest of the session.
  const b = new ScalarBaseline(68, 100, 180);
  train(b, 95);
  assert.equal(b.trusted, true);
  assert.ok(Math.abs(b.value - 68) > 5, "precondition: baseline should have moved");

  b.reset();
  assert.equal(b.trusted, false, "reset baseline must not be trusted");
  assert.equal(b.value, 68, "reset must restore the constructor prior");
});

test("PhysiologyBaseline.reset clears both signals", () => {
  const p = new PhysiologyBaseline();
  for (let i = 0; i < 200; i++) {
    p.update({
      timestampMs: Date.now(),
      heartRateBpm: 90,
      heartRateConfidence: 0.9,
      hrvRmssdMs: 20,
      hrvConfidence: 0.9,
    });
  }
  assert.equal(p.hr.trusted, true);
  assert.equal(p.hrv.trusted, true);

  p.reset();
  assert.equal(p.hr.trusted, false);
  assert.equal(p.hrv.trusted, false);
});

test("a reset baseline behaves identically to a brand-new one", () => {
  const fresh = new PhysiologyBaseline();
  const used = new PhysiologyBaseline();
  for (let i = 0; i < 300; i++) {
    used.update({
      timestampMs: Date.now(),
      heartRateBpm: 110,
      heartRateConfidence: 1,
      hrvRmssdMs: 12,
      hrvConfidence: 1,
    });
  }
  used.reset();
  assert.equal(used.hr.value, fresh.hr.value);
  assert.equal(used.hrv.value, fresh.hrv.value);
  assert.equal(used.hr.std, fresh.hr.std);
  assert.equal(used.hr.trusted, fresh.hr.trusted);
});
