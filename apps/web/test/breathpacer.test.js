import { test } from "node:test";
import assert from "node:assert/strict";
import { breathCycleFor, breathEnvelope } from "../lib/breathpacer.js";
import { anchor } from "../../../packages/engine/dist/control.js";

test("breath cycle phases sum exactly to the total duration", () => {
  for (const mode of ["deepWork", "calm", "sleep", "energy", "recovery"]) {
    const cycle = breathCycleFor(anchor(mode));
    const sum = cycle.phases.reduce((s, p) => s + p.durationSec, 0);
    assert.ok(Math.abs(sum - cycle.totalSec) < 1e-9, `${mode}: phases summed to ${sum}, expected ${cycle.totalSec}`);
    assert.ok(cycle.totalSec > 2 && cycle.totalSec < 8, `${mode}: implausible cycle length ${cycle.totalSec}`);
  }
});

test("sleep mode breathes slower than energy mode", () => {
  const sleepCycle = breathCycleFor(anchor("sleep"));
  const energyCycle = breathCycleFor(anchor("energy"));
  assert.ok(sleepCycle.totalSec > energyCycle.totalSec, "sleep should have the longer breath cycle");
});

test("higher depth lengthens the exhale relative to the inhale", () => {
  const shallow = breathCycleFor({ ...anchor("calm"), depth: 0 });
  const deep = breathCycleFor({ ...anchor("calm"), depth: 1 });
  const exhaleOf = (c) => c.phases.find((p) => p.name === "exhale").durationSec;
  assert.ok(exhaleOf(deep) > exhaleOf(shallow), "higher depth should lengthen the exhale");
});

test("breathEnvelope stays within [0,1] and cycles back to the start", () => {
  const cycle = breathCycleFor(anchor("calm"));
  for (let t = 0; t < cycle.totalSec * 3; t += 0.05) {
    const { level } = breathEnvelope(cycle, t);
    assert.ok(level >= -1e-9 && level <= 1 + 1e-9, `level out of range at t=${t}: ${level}`);
  }
  const a = breathEnvelope(cycle, 1.234);
  const b = breathEnvelope(cycle, 1.234 + cycle.totalSec);
  assert.ok(Math.abs(a.level - b.level) < 1e-6, "envelope should be exactly periodic at the cycle length");
  assert.equal(a.phase, b.phase);
});

test("envelope peaks near 1 at the end of inhale and near 0 at the end of exhale", () => {
  const cycle = breathCycleFor(anchor("calm"));
  const inhale = cycle.phases.find((p) => p.name === "inhale");
  const exhale = cycle.phases.find((p) => p.name === "exhale");
  const inhaleEnd = (inhale.startFrac * cycle.totalSec) + inhale.durationSec - 0.01;
  const exhaleEnd = (exhale.startFrac * cycle.totalSec) + exhale.durationSec - 0.01;
  assert.ok(breathEnvelope(cycle, inhaleEnd).level > 0.95, "inhale should end near full level");
  assert.ok(breathEnvelope(cycle, exhaleEnd).level < 0.05, "exhale should end near empty level");
});

test("negative and very large t values still resolve to a valid phase (modulo wraparound)", () => {
  const cycle = breathCycleFor(anchor("deepWork"));
  const neg = breathEnvelope(cycle, -3.7);
  const big = breathEnvelope(cycle, 987654.3);
  for (const e of [neg, big]) {
    assert.ok(["inhale", "holdIn", "exhale", "holdOut"].includes(e.phase));
    assert.ok(e.level >= -1e-9 && e.level <= 1 + 1e-9);
  }
});
