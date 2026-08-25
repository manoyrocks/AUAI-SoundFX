import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOLS, protocolById, protocolTotalMinutes, protocolPositionAt } from "../dist/protocols.js";
import { CONTROL_KEYS, CONTROL_RANGES } from "../../engine/dist/control.js";

test("all three flagship protocols exist with sane durations", () => {
  const ids = PROTOCOLS.map((p) => p.id);
  assert.deepEqual(ids, ["deep-work", "wind-down", "recovery"]);
  for (const p of PROTOCOLS) {
    const total = protocolTotalMinutes(p);
    assert.ok(total > 0 && total <= 180, `${p.id}: implausible total ${total} min`);
    assert.ok(p.phases.length >= 3, `${p.id}: expected at least 3 phases`);
    for (const ph of p.phases) {
      assert.ok(ph.minutes > 0, `${p.id}/${ph.name}: non-positive duration`);
      assert.ok(ph.intent.length > 10, `${p.id}/${ph.name}: missing intent copy`);
    }
  }
});

test("every phase target is within the engine's declared control ranges", () => {
  for (const p of PROTOCOLS) {
    for (const ph of p.phases) {
      for (const k of CONTROL_KEYS) {
        const r = CONTROL_RANGES[k];
        const v = ph.target[k];
        assert.ok(
          typeof v === "number" && v >= r.min && v <= r.max,
          `${p.id}/${ph.name}: ${k}=${v} outside [${r.min}, ${r.max}]`,
        );
      }
    }
  }
});

test("protocolPositionAt walks phases in order and completes", () => {
  const p = protocolById("recovery");
  assert.ok(p);
  const total = protocolTotalMinutes(p);

  const atStart = protocolPositionAt(p, 0);
  assert.equal(atStart.phaseIndex, 0);
  assert.equal(atStart.complete, false);

  const seenPhases = new Set();
  for (let m = 0; m <= total; m += 0.5) {
    const pos = protocolPositionAt(p, m);
    seenPhases.add(pos.phaseIndex);
    assert.ok(pos.phaseProgress >= 0 && pos.phaseProgress <= 1);
    assert.ok(pos.totalProgress >= 0 && pos.totalProgress <= 1);
  }
  assert.equal(seenPhases.size, p.phases.length, "not every phase was reached");

  const past = protocolPositionAt(p, total + 10);
  assert.equal(past.complete, true);
  assert.equal(past.totalProgress, 1);
});

test("protocol targets move continuously — no discontinuity at phase boundaries", () => {
  // The whole point of smoothstep-between-waypoints: stepping between
  // phases would defeat the engine's continuity guarantee.
  for (const p of PROTOCOLS) {
    const total = protocolTotalMinutes(p);
    const step = 0.05;
    let prev = protocolPositionAt(p, 0).target;
    for (let m = step; m <= total; m += step) {
      const cur = protocolPositionAt(p, m).target;
      for (const k of CONTROL_KEYS) {
        const span = CONTROL_RANGES[k].max - CONTROL_RANGES[k].min;
        const jump = Math.abs(cur[k] - prev[k]) / span;
        assert.ok(jump < 0.05, `${p.id}: ${k} jumped ${jump.toFixed(3)} of its range at ${m.toFixed(2)} min`);
      }
      prev = cur;
    }
  }
});

test("wind-down protocol descends monotonically in arousal across its waypoints", () => {
  const p = protocolById("wind-down");
  const arousals = p.phases.map((ph) => ph.target.arousal);
  for (let i = 1; i < arousals.length; i++) {
    assert.ok(arousals[i] <= arousals[i - 1], `wind-down arousal rose at phase ${i}: ${arousals}`);
  }
});

test("protocolById returns undefined for an unknown id rather than throwing", () => {
  assert.equal(protocolById("does-not-exist"), undefined);
});
