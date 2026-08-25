# Biosignals and control

Component: `packages/biosignal/src/*` (sensing), `packages/protocol/src/*`
(fusion, control, outcomes).

## Sensor fusion: what's built

**Heart rate (camera rPPG).** Full pipeline, all on-device:

1. `roi.ts` — YCbCr skin-tone segmentation on a downsampled 96×72 frame to
   locate a face-shaped blob, then an upper-central sub-box as a
   forehead/cheek proxy. **Explicitly weaker than a face landmarker** — it
   can drift onto a hand or another skin-toned object, and the file's own
   docstring says so. Chosen for zero model-download cost at M1; flagged as
   the concrete next hardening step (swap for a WebGPU face landmarker).
2. `pos.ts` — the POS algorithm (Wang et al., IEEE TBME 2017): projects the
   temporally-normalised RGB trace onto the plane orthogonal to the skin-tone
   vector under the dichromatic reflection model. Chosen over naive
   green-channel averaging (the common hobbyist approach) because it
   materially rejects specular/exposure-hunting artefacts on a webcam.
3. `filters.ts` — zero-phase (forward-backward) bandpass at 0.7–3.5 Hz
   (42–210 bpm), Goertzel-based frequency estimation with parabolic sub-bin
   refinement, and an adaptive-threshold beat picker with a physiological
   refractory period.
4. `hrv.ts` — RMSSD from picked beats, with a median-based outlier
   rejection pass and an explicit `"low" | "medium" | "unusable"` quality
   flag the UI is required to respect.

**Verification, not just implementation:** `packages/biosignal/test/
rppg.test.js` synthesises RGB traces from a dichromatic skin-reflectance
model at known ground-truth BPM (with realistic noise, illumination drift,
and beat-to-beat jitter) and asserts the full pipeline recovers 50–140 bpm
within 3–4 bpm, that RMSSD lands in a physiologically plausible band, and
that a pure-noise trace does *not* produce an overconfident false reading.
4/4 passing. This is the honest ceiling of pre-human testing available
without a labelled real-PPG dataset (e.g. PURE, UBFC-rPPG) — a genuine
accuracy number against real video needs one of those, which this session
did not have access to.

Independent of the face-detection caveat, the pipeline's value comes from
fusing two signals rather than relying on one — see the fusion argument
below.

## Personal baseline: the "personalised" half of the fusion

`baseline.ts::ScalarBaseline` is a confidence-weighted, exponentially-decayed
mean/variance tracker (Welford-style), with two instances
(`PhysiologyBaseline`) for HR (≈3 min half-life) and HRV (≈4 min half-life).
It compares every reading against **this user's own recent distribution**,
tracked online, per session, rather than against a fixed population
threshold. Resting heart rate varies widely between individuals, so a
generic "elevated" cutoff reads a naturally higher resting HR as permanent
stress while missing a real spike in someone who runs low. Tracking the
personal distribution also detects genuine change faster, because the
estimate is not fighting a population-average offset.

## The M1/M2 controller: explicitly not the safe-RL policy yet

`controller.ts::computeAdjustment` is a **hand-specified, bounded,
saturating proportional controller** — not a learned policy. It is built
this way on purpose and documented as such in the file's own header. Four
properties carry the weight:

1. **Multi-signal fusion with an agreement rule**: HR-up + HRV-down is
   scored as the coherent sympathetic-activation signature (weight 1.0);
   HR-up alone is damped (weight 0.55); HR-up with HRV *also* up is treated
   as more likely a detector artefact than a real event (weight 0.35). This
   is asserted by a test (`agreement weighting: HR-up + HRV-down... pulls
   harder than HR-up alone`), not just claimed. Requiring agreement is what
   makes the loop robust to a camera estimate that is confidently wrong in
   a single channel.
2. **Personalised**, via the baseline above, not a fixed threshold.
3. **Multi-dimensional response** — tempo, arousal, density, and tension
   move together along one physiologically-motivated direction, not a
   single BPM dial.
4. **Hard safety clamp, independent of and in addition to the engine's own
   rate limiter**: `enforceModeSafety()` clamps sleep-mode arousal/tempo/
   tension to never exceed the anchor, regardless of what the raw fused
   signal says. Tested adversarially — feeding a 170 bpm reading with
   disagreeing HRV into sleep mode and asserting the clamp holds
   (`packages/protocol/test/controller.test.js`, 6/6 passing). This is
   the literal safety requirement, enforced as a second, independent
   layer on top of the engine's own `slewToward` rate limiter — a
   regression in either layer alone still leaves the other standing.

**What "safe-RL" would add that this doesn't have**: a learned per-user
dose-response model (the current controller's response magnitude is a fixed
constant, `maxArousalPull`/`maxTempoPullBpm`, tuned once by hand — not
learned per user), and a real exploration policy with a value function
rather than a static proportional gain. The interface
(`ControllerOptions`/`ControllerResult`, keyed by `AnchorName`) is
deliberately the seam where that swap happens later without touching
callers.

## Personal Rhythm Foundation Model: not built

No circadian/ultradian model, no 24–48h prediction, no calendar/sleep-debt
integration. `baseline.ts`'s slow exponential tracker is explicitly framed
in its own docstring as "this estimator's degenerate single-parameter
special case" — a legitimate, honest relationship to state, not a rename of
the same thing.

## N-of-1 experimentation engine: not built, but has a real substrate now

The blinded micro-A/B experimentation engine needs: a
randomised withholding design, a minimum-N policy, and a real effect-size
computation with honesty about confidence. None of that exists. What *does*
exist as of this session, and is the actual prerequisite for it:
`packages/protocol/src/outcomes.ts` — a before/after session record with an
explicit `MIN_SAMPLES_FOR_RELIABLE_DELTA` honesty gate
(`computeDelta`/`summariseMode`, 6/6 tests passing, including one that
proves an unreliable session is excluded from an aggregate mean rather than
silently degrading it). Building the blinded-experiment layer on top of this
is now a scoping/statistics design problem, not also a "build the data
pipeline from scratch" problem.

## Simulation environment for pre-human testing: partially satisfied

The deliverable list calls for "a simulation environment with synthetic physiologies for
pre-human testing." What exists: the rPPG synthetic-trace generator in
`rppg.test.js` (dichromatic model + noise + drift + jitter) and the
controller's adversarial hand-picked test cases. What's missing: a
parameterised *population* of synthetic physiologies (varying resting HR,
HRV, reactivity) run automatically against the controller to search for
safety-invariant violations, rather than the handful of cases a human
thought to write. This is the concrete recommended next step before any RL
work — see [00-orchestrator.md](00-orchestrator.md).
