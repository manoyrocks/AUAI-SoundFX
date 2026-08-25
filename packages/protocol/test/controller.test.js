import { test } from "node:test";
import assert from "node:assert/strict";
import { anchor } from "../../engine/dist/control.js";
import { computeAdjustment, DEFAULT_CONTROLLER_OPTIONS } from "../dist/controller.js";
import { PhysiologyBaseline } from "../dist/baseline.js";

/**
 * Safety-invariant tests for the closed-loop controller.
 *
 * Part 6 of the product spec states as a hard guardrail: "sleep sessions
 * never spike arousal." This is not a UX aspiration — it's implemented as a
 * clamp in controller.ts's enforceModeSafety, and these tests exist to make
 * a regression there fail CI, not just a code review.
 */

function trustedBaseline(restingHr = 62, restingHrv = 55) {
  const b = new PhysiologyBaseline();
  // Feed enough confident samples to cross the `trusted` threshold (nEff>=20)
  // for both signals, matching how the app behaves after ~20s of good signal.
  for (let i = 0; i < 40; i++) {
    b.hr.update(restingHr + (i % 2 === 0 ? 0.3 : -0.3), 0.9);
    b.hrv.update(restingHrv + (i % 2 === 0 ? 1 : -1), 0.9);
  }
  return b;
}

test("sleep mode: even an extreme adversarial elevated-HR reading cannot raise arousal above the anchor", () => {
  const baseline = trustedBaseline(60, 55);
  const sleepAnchor = anchor("sleep");

  // Physiologically implausible spike, deliberately adversarial: HR far above
  // baseline AND HRV inconsistent (i.e. not just "the controller happened to
  // calm down" — worst case for anything that could push arousal *up*).
  const state = {
    timestampMs: Date.now(),
    heartRateBpm: 170,
    heartRateConfidence: 0.95,
    hrvRmssdMs: 90, // elevated HRV alongside elevated HR: disagreement case
    hrvConfidence: 0.9,
  };

  const result = computeAdjustment("sleep", state, baseline);
  assert.ok(
    result.target.arousal <= sleepAnchor.arousal + 1e-9,
    `sleep arousal clamp failed: target=${result.target.arousal}, anchor=${sleepAnchor.arousal}`,
  );
  assert.ok(result.target.tempo <= sleepAnchor.tempo + 1e-9, "sleep tempo clamp failed");
  assert.ok(result.target.tension <= sleepAnchor.tension + 1e-9, "sleep tension clamp failed");
});

test("sleep mode: a calming reading is allowed to move arousal further down, not up", () => {
  const baseline = trustedBaseline(60, 55);
  const sleepAnchor = anchor("sleep");
  const state = {
    timestampMs: Date.now(),
    heartRateBpm: 58, // below baseline: relaxed
    heartRateConfidence: 0.9,
    hrvRmssdMs: 70,
    hrvConfidence: 0.9,
  };
  const result = computeAdjustment("sleep", state, baseline);
  assert.ok(result.target.arousal <= sleepAnchor.arousal + 1e-9, "sleep clamp should still hold when calm");
});

test("non-sleep modes: the arousal pull is bounded by maxArousalPull regardless of signal extremity", () => {
  const baseline = trustedBaseline(60, 55);
  const state = {
    timestampMs: Date.now(),
    heartRateBpm: 220, // far beyond any physiological ceiling
    heartRateConfidence: 1,
    hrvRmssdMs: 5,
    hrvConfidence: 1,
  };
  for (const mode of ["deepWork", "calm", "energy", "recovery"]) {
    const result = computeAdjustment(mode, state, baseline);
    assert.ok(
      Math.abs(result.arousalPull) <= DEFAULT_CONTROLLER_OPTIONS.maxArousalPull + 1e-9,
      `${mode}: arousal pull ${result.arousalPull} exceeded the conservative exploration bound`,
    );
    assert.ok(
      Math.abs(result.tempoPull) <= DEFAULT_CONTROLLER_OPTIONS.maxTempoPullBpm + 1e-9,
      `${mode}: tempo pull ${result.tempoPull} exceeded the conservative exploration bound`,
    );
  }
});

test("does not act until the baseline is trusted and the reading is confident (avoids cold-start overreaction)", () => {
  const freshBaseline = new PhysiologyBaseline(); // untrusted: nEff starts low
  const state = {
    timestampMs: Date.now(),
    heartRateBpm: 140,
    heartRateConfidence: 0.9,
    hrvRmssdMs: 20,
    hrvConfidence: 0.9,
  };
  const result = computeAdjustment("deepWork", state, freshBaseline);
  assert.equal(result.arousalPull, 0, "controller acted before establishing a trusted baseline");
  assert.deepEqual(result.target, anchor("deepWork"));
});

test("low-confidence readings do not move the target", () => {
  const baseline = trustedBaseline(60, 55);
  const state = {
    timestampMs: Date.now(),
    heartRateBpm: 150,
    heartRateConfidence: 0.05, // below minConfidence
    hrvRmssdMs: 10,
    hrvConfidence: 0.05,
  };
  const result = computeAdjustment("calm", state, baseline);
  assert.equal(result.arousalPull, 0, "controller acted on a low-confidence reading");
});

test("agreement weighting: HR-up + HRV-down (sympathetic signature) pulls harder than HR-up alone", () => {
  const baseline = trustedBaseline(60, 55);
  const agreeState = {
    timestampMs: Date.now(),
    heartRateBpm: 90,
    heartRateConfidence: 0.9,
    hrvRmssdMs: 25, // well below baseline 55: agrees with stress
    hrvConfidence: 0.9,
  };
  const noHrvState = {
    timestampMs: Date.now(),
    heartRateBpm: 90,
    heartRateConfidence: 0.9,
    hrvRmssdMs: null,
    hrvConfidence: 0,
  };
  const agree = computeAdjustment("deepWork", agreeState, baseline);
  const noHrv = computeAdjustment("deepWork", noHrvState, baseline);
  assert.ok(
    Math.abs(agree.arousalPull) >= Math.abs(noHrv.arousalPull),
    "HR+HRV agreement should pull at least as hard as HR alone",
  );
});
