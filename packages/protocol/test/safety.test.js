import { test } from "node:test";
import assert from "node:assert/strict";
import { GATED_TECHNIQUES, isTechniqueEnabled, techniqueInfo, enabledTechniques } from "../dist/screening.js";
import { DistressMonitor } from "../dist/distress.js";
import { PhysiologyBaseline } from "../dist/baseline.js";

// ---------------------------------------------------------------- screening

test("gated techniques fail closed: nothing is enabled without explicit consent", () => {
  for (const t of GATED_TECHNIQUES) {
    assert.equal(isTechniqueEnabled({}, t.id), false, `${t.id} was enabled with empty consent`);
    assert.equal(isTechniqueEnabled({ [t.id]: false }, t.id), false);
    // Truthy-but-not-true values must not pass the gate either.
    assert.equal(isTechniqueEnabled({ [t.id]: 1 }, t.id), false, `${t.id} passed on a truthy non-boolean`);
    assert.equal(isTechniqueEnabled({ [t.id]: "yes" }, t.id), false);
  }
});

test("explicit consent enables exactly the one technique", () => {
  const consent = { rhythmicEntrainment: true };
  assert.equal(isTechniqueEnabled(consent, "rhythmicEntrainment"), true);
  assert.equal(isTechniqueEnabled(consent, "cardiacPacing"), false);
  assert.equal(isTechniqueEnabled(consent, "infrasonicBass"), false);
  const enabled = enabledTechniques(consent);
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].id, "rhythmicEntrainment");
});

test("every gated technique carries plain-language contraindication copy", () => {
  for (const t of GATED_TECHNIQUES) {
    assert.ok(t.contraindication.length > 30, `${t.id}: contraindication copy too thin`);
    assert.ok(t.label.length > 3, `${t.id}: missing label`);
    // The whole point is telling the user who should not use it.
    assert.match(t.contraindication, /not recommended/i, `${t.id}: copy doesn't state who should avoid it`);
  }
});

test("the epilepsy-relevant technique is present and flagged experimental", () => {
  const info = techniqueInfo("rhythmicEntrainment");
  assert.equal(info.experimental, true);
  assert.match(info.contraindication, /epilep/i);
});

test("the arrhythmia-relevant technique is present and names the webcam limitation", () => {
  const info = techniqueInfo("cardiacPacing");
  assert.match(info.contraindication, /arrhythmia/i);
  assert.match(info.contraindication, /can be wrong/i);
});

// ---------------------------------------------------------------- distress

function trustedBaseline(restingHr = 62) {
  const b = new PhysiologyBaseline();
  for (let i = 0; i < 800; i++) b.hr.update(restingHr, 0.9);
  return b;
}

function reading(bpm, timestampMs, confidence = 0.8) {
  return { timestampMs, heartRateBpm: bpm, heartRateConfidence: confidence, hrvRmssdMs: null, hrvConfidence: 0 };
}

test("distress monitor stays quiet in non-calming modes regardless of elevation", () => {
  const m = new DistressMonitor();
  const b = trustedBaseline(60);
  let t = 0;
  for (let i = 0; i < 200; i++) {
    t += 5000;
    const a = m.update("energy", reading(120, t), b);
    assert.equal(a.level, "none", "fired during an Energy session, where elevation is expected");
  }
});

test("distress monitor stays quiet when the user actually settles", () => {
  const m = new DistressMonitor();
  const b = trustedBaseline(60);
  let t = 0;
  for (let i = 0; i < 300; i++) {
    t += 5000;
    // Elevated for a while, then genuinely settling — should never fire.
    const bpm = i < 60 ? 80 : 61;
    const a = m.update("calm", reading(bpm, t), b);
    assert.equal(a.level, "none");
  }
});

test("distress monitor fires once after sustained non-response in a calming mode", () => {
  const m = new DistressMonitor();
  const b = trustedBaseline(60);
  let t = 0;
  let fires = 0;
  let firstFireAtMs = null;
  for (let i = 0; i < 400; i++) {
    t += 5000; // 5s cadence
    const a = m.update("sleep", reading(85, t), b); // persistently elevated
    if (a.level === "notLanding") {
      fires++;
      if (firstFireAtMs == null) firstFireAtMs = t;
      assert.equal(a.shouldDisengage, true);
      assert.ok(a.message.length > 80, "escalation copy is too thin");
    }
  }
  assert.equal(fires, 1, `expected exactly one notification, got ${fires}`);
  assert.ok(firstFireAtMs >= 8 * 60 * 1000, "fired before the sustained-duration threshold");
});

test("escalation copy offers support without diagnosing or alarming", () => {
  const m = new DistressMonitor();
  const b = trustedBaseline(60);
  let t = 0;
  let msg = "";
  for (let i = 0; i < 400 && !msg; i++) {
    t += 5000;
    const a = m.update("recovery", reading(88, t), b);
    if (a.level === "notLanding") msg = a.message;
  }
  assert.ok(msg, "monitor never fired");
  // Must point somewhere real.
  assert.match(msg, /findahelpline\.com/);
  // Must not pathologise the user or claim to know their state.
  assert.doesNotMatch(msg, /anxiety|panic|depress|disorder|crisis|diagnos/i);
  // Must make stopping easy and blameless.
  assert.match(msg, /stop whenever/i);
});

test("distress monitor ignores low-confidence readings and untrusted baselines", () => {
  const m = new DistressMonitor();
  const fresh = new PhysiologyBaseline(); // untrusted
  let t = 0;
  for (let i = 0; i < 400; i++) {
    t += 5000;
    assert.equal(m.update("calm", reading(120, t, 0.9), fresh).level, "none");
  }

  const m2 = new DistressMonitor();
  const b = trustedBaseline(60);
  t = 0;
  for (let i = 0; i < 400; i++) {
    t += 5000;
    assert.equal(m2.update("calm", reading(120, t, 0.05), b).level, "none");
  }
});

test("reset() clears state so a new session starts fresh", () => {
  const m = new DistressMonitor();
  const b = trustedBaseline(60);
  let t = 0;
  for (let i = 0; i < 400; i++) {
    t += 5000;
    m.update("calm", reading(85, t), b);
  }
  m.reset();
  let firesAfterReset = 0;
  for (let i = 0; i < 400; i++) {
    t += 5000;
    if (m.update("calm", reading(85, t), b).level === "notLanding") firesAfterReset++;
  }
  assert.equal(firesAfterReset, 1, "reset should allow exactly one fresh notification");
});
