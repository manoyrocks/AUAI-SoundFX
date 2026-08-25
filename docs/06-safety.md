# Safety design and guardrails

This document records which safety requirements are enforced
in code (and tested), which are policy-only, and which are **not met** —
the last category matters most and is stated first.

## Contraindication screening — built, default-deny

`packages/protocol/src/screening.ts`.

The approach is deliberately inverted from a health questionnaire. Asking
"do you have epilepsy?" would collect sensitive health data this product has
promised not to collect, and would imply a clinical competence it does not
have. Instead:

- Techniques with known contraindications are enumerated
  (`GATED_TECHNIQUES`) and are **off unless explicitly acknowledged**.
- `isTechniqueEnabled()` is default-deny and strictly boolean — tested
  against truthy-but-not-`true` values (`1`, `"yes"`) so a sloppy caller
  fails closed (silent) rather than open (unsafe).
- Each technique carries plain-language contraindication copy stating who
  should avoid it and why, surfaced in the UI next to its toggle — not
  buried in a terms page. Tested for presence and substance.
- The stored artefact is a *feature acknowledgement* ("this user read the
  note and enabled it"), never a health record.

Currently gated: rhythmic entrainment (binaural/pulsing — the epilepsy
case), heart-rate-paced tempo (the arrhythmia case, whose copy also names
the webcam's fallibility), and felt sub-bass.

Note that none of these techniques are *implemented* in the engine yet —
the gate is deliberately in place **before** the features it guards, which
is the correct order. 11/11 tests in
`packages/protocol/test/safety.test.js`.

## Review: the four science-derived modes (Read, Open, Screen, Move)

Added after the original safety pass, so reviewed separately. Full detail in
[09-sound-science.md](09-sound-science.md).

**Move is deliberately NOT gated** under `rhythmicEntrainment`. That gate
exists for binaural beats and isochronic tones intended to drive EEG
frequencies. Move's pulse sits at step cadence (1-3.3 Hz) and drives motor
entrainment - functionally the same as walking to music with a beat, which
is not a screened activity. Gating it would be safety theatre, and safety
theatre is not free: it dilutes the meaning of the gates that do matter.

**One real interaction was found and fixed.** The generative visual's
brightness pulse tracks engine RMS, and telemetry posts at 5 Hz, so a
2.5-3.3 Hz cadence could alias into visible flicker around 1-2.5 Hz. That is
below the WCAG 2.3.1 flash threshold (three flashes per second, high
contrast, large area) and below the 3-60 Hz range associated with
photosensitivity, and it is a soft gradient rather than a flash - but an
accident of the telemetry rate is not a guarantee. The visual pulse is now
explicitly rate-limited to under ~0.5 Hz, which also covers any future mode
with a fast pulse.

**Unchanged and verified still correct:**
- The sleep arousal clamp applies only to `sleep`; none of the new modes
  affects it.
- `CALMING_MODES` for distress monitoring remains `calm`/`sleep`/`recovery`.
  None of the four new modes promises arousal reduction, so none should be
  monitored for "the intervention isn't landing" - Move is *supposed* to
  raise arousal.
- All four remain subject to the control-vector rate limiter, so no mode can
  jerk the sound regardless of its anchor.

## Distress escalation — built, deliberately narrow

`packages/protocol/src/distress.ts`.

This module explicitly **does not** attempt to detect emotional distress,
panic, or a mental-health crisis from biosignals. That would be technically
unsound (a webcam HR estimate cannot separate anxiety from caffeine,
exercise, a warm room, or a detector artefact) and ethically wrong.

What it detects instead is narrow and defensible: **the product's own loop
is not working.** Specifically — a calming mode (`calm`/`sleep`/`recovery`),
arousal sustained ≥1.2σ above the user's own baseline for ≥8 uninterrupted
minutes, on ≥30 confident samples. That is a statement about the
intervention's efficacy this session, not a diagnosis of the person.

The response is correspondingly modest and is tested for exactly that:
- Fires **at most once per session** — repeating would turn a gentle offer
  into nagging, the dark-pattern shape the product rules out.
- Tells the controller to **stop pushing** (`shouldDisengage`) rather than
  escalate its intervention.
- Copy points to `findahelpline.com` (free, confidential, country-aware),
  makes stopping blameless ("feel free to stop whenever you like"), and is
  asserted by test to contain **no** pathologising language — the test
  fails if the words anxiety/panic/depress/disorder/crisis/diagnos appear.
- Rendered inline and dismissible, never a modal. A message that blocks the
  screen when someone is already having a hard time is the opposite of
  helpful.
- Any genuine settling resets the timer, so only sustained, uninterrupted
  non-response counts.

## Enforced in code and tested

**Sleep sessions never spike arousal.** Two independent layers:

1. `packages/protocol/src/controller.ts::enforceModeSafety()` clamps
   sleep-mode `arousal`, `tempo`, and `tension` to never exceed the sleep
   anchor, regardless of what the fused biosignal says.
2. `packages/engine/src/control.ts::slewToward()` rate-limits every control
   dimension independently (`CONTROL_RANGES[*].maxRatePerSec`), so even a
   caller that bypassed layer 1 entirely and demanded maximum arousal could
   only move at ≤0.05/s.

Tested adversarially in `packages/protocol/test/controller.test.js`: a
170 bpm reading with *disagreeing* HRV (the worst case for anything that
might push arousal up) fed into sleep mode, asserting all three clamps hold.
Layer 2 is separately tested in `packages/engine/test/clfs.test.js` by
slamming every dimension to its extreme simultaneously and asserting no
single frame exceeds its rate bound.

**Conservative controller exploration bounds.** `maxArousalPull` (0.16) and
`maxTempoPullBpm` (9) are hard clamps applied after a `tanh`-saturated
response, so no single noisy reading — including a physiologically
impossible 220 bpm — can produce a large jump. Tested across all non-sleep
modes.

**Cold-start caution.** The controller refuses to act at all until the
personal baseline is `trusted` (enough confident samples accumulated) *and*
the current reading clears `minConfidence`. A fresh session with a wild
reading produces zero adjustment, not an overreaction. Tested.

**Low-confidence readings are inert.** A 150 bpm reading at 0.05 confidence
moves nothing. Tested.

**Audio output is bounded.** Every mode's output is asserted finite and
within `[-1, 1]` across long renders including rapid mode changes; the
master chain ends in a soft clipper (`dsp/biquad.ts::softClip`) with unity
slope at zero. No configuration produces NaN, Inf, or out-of-range samples
in the test suite.

**Silence before fade-in.** The engine produces near-silence until
explicitly faded in, so a session can never start with a sudden burst —
tested with the highest-activity anchor (`energy`).

## Policy-level, not code-enforced

**Not a medical device; no diagnostic or treatment claims.** Held in the
current copy (audited in [07-claims.md](07-claims.md)) but there is no
lint rule or automated check preventing someone adding a claim later. A
claims-substantiation checklist exists in that document; enforcement is
human review.

**No dark patterns / engagement optimisation.** Structurally held: the
codebase contains no streaks, no engagement counters, no notification
scheduling, and no analytics of any kind. Session end is a plain 3-second
fade with no re-engagement prompt. This is currently true by absence rather
than by an explicit guard.

## Recommended next safety work (priority order)

1. A parameterised synthetic-physiology population (see
   [04-biosignals-and-control.md](04-biosignals-and-control.md)) run
   against the controller to search for safety-invariant violations
   automatically, rather than relying on hand-picked adversarial cases.
   This is the prerequisite for any learned/RL controller.
2. Review the distress-monitor thresholds (8 min / 1.2σ / 30 samples) with
   someone qualified. They are currently reasoned-from-first-principles
   defaults, not clinically validated — the *mechanism* is sound and the
   *copy* is careful, but the specific numbers are engineering judgement.
3. When any gated technique is actually implemented, verify the gate is
   consulted on the audio path itself (not only in the UI), and add a test
   asserting the engine produces no entrainment modulation without consent.
