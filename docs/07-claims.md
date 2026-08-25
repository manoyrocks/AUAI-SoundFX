# Claims substantiation and copy audit

Two standing rules: never claim what the data doesn't show, and make no
pseudo-scientific claims — every mechanism is either cited to literature or
flagged as experimental.

This document audits every user-facing claim in the shipped UI against what
the code and tests actually substantiate.

## The house rule

A claim is publishable if it is (a) mechanically true of this build,
(b) verifiable by someone reading the code or running the tests, and
(c) stated without implying more precision or more causation than the
underlying measurement supports. Anything else is either cut or explicitly
hedged.

## Audit of current user-facing copy

| String (source) | Verdict | Basis |
|---|---|---|
| "Runs entirely on this device. No audio, video frame, or biometric reading is ever uploaded — check the network tab." (`main.ts` footer) | **OK** | Mechanically true; no network call exists in the biosignal/outcome path. The "check the network tab" invitation is deliberate — the claim is falsifiable by the user in ten seconds. See [05-privacy.md](05-privacy.md). |
| "Sound is synthesised sample-by-sample from a neural field decoder; nothing here is a recording." (`main.ts` footer) | **OK, with a caveat carried in docs** | True: there are no audio assets in the repo, and every sample comes from the modal/spectral/granular/drone synthesis chain parameterised by `NeuralFieldDecoder`. The caveat — that the decoder currently runs a hand-derived analytic prior rather than trained weights — is documented in [03-synthesis-model.md](03-synthesis-model.md). The UI string does not claim the model is *trained*, and the live telemetry panel shows `decoder: analytic-prior` verbatim, so the actual state is visible in the product itself, not buried. |
| "Camera-derived heart rate and HRV are estimates from a consumer webcam, not a medical measurement." (`main.ts` footer) | **OK — required hedge** | Directly satisfies the "not a medical device" rule at the point of measurement, not just in a buried disclaimer. |
| "Heart rate is elevated and beat-to-beat variability is down from your baseline — easing tempo and arousal to help you settle." (`controller.ts`) | **OK** | Every element is literally true of what just happened: the reading *is* above the tracked personal baseline, HRV *is* below it, and the controller *did* reduce tempo/arousal. "To help you settle" states intent, not a measured outcome — acceptable because it describes what the system is attempting, and the session-history panel separately reports whether anything actually changed. |
| "Tracking close to your resting baseline — holding steady." (`controller.ts`) | **OK** | Descriptive of the controller's actual state. |
| "Calibrating — hold still for a few seconds." / "No face detected — centre yourself in frame with even lighting." (`main.ts`) | **OK** | Operational instructions; both correspond to real states (`warmedUp === false`, `roi === null`). |
| "not enough signal" delta pill (`main.ts` session history) | **OK — this is the honesty gate working** | Shown whenever a session had fewer than `MIN_SAMPLES_FOR_RELIABLE_DELTA` confident readings, instead of computing a delta from thin data. Tested (`outcomes.test.js`). |
| "↓ 11 bpm" delta pill, neutral styling (`main.ts` + `style.css`) | **OK — deliberately not colour-coded** | An earlier draft coloured downward deltas green and upward red. That was cut: a lower end-of-session heart rate is not intrinsically good (Energy mode has no such expectation), so colour-coding would have encoded a verdict the data doesn't support. The glyph reports direction; the product declines to grade it. |
| "Vibration synced on this device." / "No vibration API on this device — visual pacing only." (`main.ts`) | **OK** | Feature-detected at runtime (`typeof navigator.vibrate === "function"`), not assumed. Honest about the real iOS Safari / desktop gap rather than silently doing nothing. |
| "Session history — this device only" (panel heading) | **OK** | True; `localStorage` only. |
| "These are your own before/after readings, not evidence that SoundFX caused the change. Sitting still for ten minutes lowers most people's heart rate on its own. Telling those apart needs a blinded comparison, which isn't built yet." (dashboard caveat) | **OK — this is the load-bearing string in the whole product** | It is the difference between an honest dashboard and an efficacy claim. It names the specific confound (regression to the mean / simply resting), names the specific thing that would resolve it (a blinded comparison), and admits that thing isn't built. Standing text, not a dismissible tooltip. |
| "Nothing to show yet. After a few sessions with camera sensing on, your own numbers appear here — no one else's." (empty dashboard) | **OK** | Sets the expectation that this surface shows personal data only — no population benchmarks, no comparison to other users. |
| "N sessions · M with usable signal · X min avg" (dashboard sub-line) | **OK** | Sample size shown next to every aggregate, always, including the count that *failed* the reliability gate. A mean with a hidden N is how honest numbers become misleading ones. |
| "Optional techniques — off by default" (panel heading) + per-technique contraindication copy | **OK** | Accurate (`isTechniqueEnabled` is default-deny and tested to fail closed). Each contraindication states who should avoid the technique and why, in plain language, adjacent to the control — not in a terms page. |
| "Not recommended if you are managing an arrhythmia... This uses a webcam estimate of your pulse, which can be wrong." (`screening.ts`) | **OK — deliberately self-undermining** | Volunteering the sensor's fallibility inside the safety warning is the point: a user deciding about a heart-rate-paced feature needs to know the heart-rate estimate is unreliable. |
| "This session doesn't seem to be helping settle things, and that's okay — it doesn't work for everyone every time." (`distress.ts`) | **OK** | Frames the failure as the product's, not the user's. Makes a claim only about *this session's* observed non-response, which is exactly what was measured — no inference about the person's state. |
| Protocol phase intent copy, e.g. "Hold the working state. Deliberately the least eventful stretch — nothing here should recruit attention." (`protocols.ts`) | **OK** | Describes design intent for that phase, which is true of what the control vector does there (complexity 0.12, motion 0.2). Does not claim a measured effect on the user. |
| Mode science copy — design / mechanism / limitations blocks (`soundScience.ts`) | **OK — with a structural safeguard** | Every entry carries a mandatory `limitations` field and a visible evidence badge, rendered at equal weight to the claims and never behind a disclosure. A product that shows citations prominently while hiding caveats is using the citations as decoration. Evidence levels differ across the four modes and are shown, not flattened. |
| "For reading, writing, editing — anything that holds words in order." (Read) | **OK** | States the task type the acoustics were designed around. Makes no claim about performance. The limitations field says explicitly that the constraint is verified in our test suite and *not* with users. |
| Open mode's tagline "deliberately less comfortable" | **OK — unusually honest** | Accurately describes the design target, which is the opposite of every other mode. Prevents the mode reading as a bug. |
| Open mode existing at all, given the 70 dB dependency | **Flagged, not hidden** | The source effect is defined by absolute SPL, which no app can observe or control. The UI says so in the limitations field, and the mode is badged `moderate` rather than `established`. It must never be described as reproducing the study. |
| Screen mode: masking efficiency figure | **OK — deliberately the level-independent quantity** | `spectrumEfficiency()` compares spectrum *shape* against the SII weights and is provably level-independent (tested at ±30 dB). Articulation Index is implemented but **not surfaced as a headline number**, because a real AI figure needs playback SPL and intruding-speech level, neither of which a web app can know. The UI says exactly that. |
| Move mode: "locks to your cadence" | **OK** | Literally what it does — onset rate is set from steps per minute and the renewal process is forced near-periodic. Verified live in-browser: 150 spm → 2.34 events/s, 90 spm → 1.41 events/s. |
| Move mode evidence badge "mechanism established, application untested" | **OK — the honest grade** | Auditory-motor entrainment is well established; that *this engine's synthesised pulse* produces it as reliably as music has not been tested. The badge says both halves rather than borrowing the strength of the first for the second. |
| "Still learning your rhythm — needs N more readings, sessions at M more times of day…" (`rhythmPanel.ts`) | **OK — the gate made visible** | States exactly what is missing rather than showing a placeholder curve. The accompanying line ("It won't forecast from a handful of readings at one time of day — that would be extrapolation dressed up as a prediction") explains *why* the product is withholding, which is the difference between a limitation and an excuse. |
| "Your steadiest stretch of the day usually starts in about 2 hours, going by your own readings." (`rhythm/suggest.ts`) | **OK** | "Usually" and "going by your own readings" both do real work: the claim is about a fitted pattern in this person's history, not a prediction of how they will feel. Says nothing about causation or about what the session will achieve. |
| "Nothing worth suggesting in the next few hours. That's a normal answer — this only speaks up when it has something specific." (`rhythmPanel.ts`) | **OK — silence made legible** | Prevents the empty state reading as breakage, and states the product rule (`suggestNext` genuinely returns null rather than manufacturing a prompt). |
| "Chosen by scoring five candidate models on readings they hadn't seen yet, so a richer curve only wins if it actually predicts you better." + the per-model error table (`rhythmPanel.ts`) | **OK — mechanism on screen** | Accurate description of prequential selection, with the actual per-candidate errors shown including the losers. A user can see that the flat null model was considered and by how much it lost. |
| "The shaded band is ±1 standard deviation. It widens at times of day you rarely use the app, because there the curve is extrapolating." (`rhythmPanel.ts`) | **OK** | Correct description of the ridge predictive variance, and names the reason the band varies rather than leaving it as decoration. |

## Claims deliberately NOT made

These are the ones a product in this category would normally make, and this
build does not, because nothing here substantiates them:

- **No efficacy percentages.** No "7x focus", no "3.6x less stress", no
  "X% of users report...". No study has been run. The efficacy surface shows
  the user their own numbers with sample-size caveats, and nothing else.
- **No claim that the soundscape caused anything.** The session history
  reports a before/after HR delta. It does not say "SoundFX lowered your
  heart rate" — a single-arm before/after observation cannot separate the
  intervention from regression to the mean, time-of-day effects, or simply
  sitting still for ten minutes. Establishing causation is exactly what the
  (unbuilt) N-of-1 blinded-withholding engine is for; until it exists, the
  product describes and does not attribute.
- **No frequency mysticism.** No "440 Hz", "432 Hz", "Solfeggio", "sacred
  geometry", or "natural order" framing anywhere in the code or copy. The
  harmonic engine's reference pitch deliberately *drifts* (±35 cents over
  ~7 minutes) rather than sitting on a fixed "meaningful" frequency. Where
  the build does make an acoustic claim — that just-intonation intervals
  beat less than equal-tempered ones at long sustain — it is a beat-
  frequency fact about small-integer ratios, cited in
  [03-synthesis-model.md](03-synthesis-model.md), not a metaphysical
  one.
- **No claim of clinical-grade HRV.** `hrv.ts` returns an explicit
  `"low" | "medium" | "unusable"` quality flag, and the UI is required to
  respect it.
- **No "AI-powered" framing as a substitute for a mechanism.** The
  telemetry panel exposes the actual decoder in use, the live control
  vector, the lattice ratio, and the Tenney height. The mechanism is on
  screen.

## Cited mechanisms

Claims that rest on published work, with the citation recorded at the point
of implementation:

- **POS rPPG algorithm** — Wang, den Brinker, Stuijk & de Haan,
  "Algorithmic Principles of Remote PPG", *IEEE Trans. Biomedical
  Engineering*, 2017. (`packages/biosignal/src/pos.ts`)
- **YCbCr skin segmentation thresholds** — Chai & Ngan, 1999.
  (`packages/biosignal/src/roi.ts`) — and flagged in that file's own
  docstring as weaker than a modern landmarker.
- **RMSSD as the short-window HRV metric of choice** — standard time-domain
  HRV practice; chosen over SDNN specifically because SDNN needs minutes to
  stabilise. (`packages/biosignal/src/hrv.ts`)
- **20%-of-local-median artefact rejection** for short-window HRV — standard
  preprocessing. (`packages/biosignal/src/hrv.ts`)
- **Stiff-string/bar inharmonicity relation** `f_n = f0 · n · √(1 + Bn²)` —
  standard musical acoustics. (`packages/engine/src/voices/modal.ts`)
- **Tenney harmonic distance** as the lattice complexity measure —
  standard just-intonation theory. (`packages/engine/src/harmony.ts`)
- **Longer exhale biasing toward parasympathetic tone** — the stated
  rationale for the breath pacer's depth→exhale-length mapping
  (`apps/web/src/breathpacer.ts`). **Flagged as experimental in this
  build**: the mechanism is well-attested in respiratory-physiology
  literature, but this build has not validated that *its specific*
  implementation produces the effect in users.

## Flagged as experimental / unvalidated

- The mapping from `ControlVector` dimensions to subjective states
  (the `ANCHORS` presets in `control.ts`) is hand-authored and **has not
  been validated against user-reported state**. The file's own docstring
  says these are "starting points for the controller's search, not
  destinations."
- The agreement-weighting heuristic (HR-up + HRV-down ⇒ higher confidence)
  is physiologically motivated but the specific weights (1.0/0.7/0.55/0.35)
  are hand-tuned, not fitted.
- **The Rhythm Model's arousal proxy.** The estimator is verified against
  synthetic ground truth, but that the HR-based proxy corresponds to
  anything a user would call "energy" or "focus" is **unvalidated**. The UI
  copy is written to survive this: it says "your steadiest stretch, going by
  your own readings" — a claim about a fitted pattern in their heart-rate
  history — and never "you will feel focused". The distinction is the whole
  reason the copy is worded that way. See
  [08-rhythm-model.md](08-rhythm-model.md).
- **The four science-derived modes are verified acoustically, not
  behaviourally.** What the test suite proves is that the engine's output
  has the acoustic properties the literature describes — syllabic modulation
  depth cut 33%, masking spectrum beating white and pink noise, onsets
  peaking at the cadence frequency. It does **not** prove any of this helps
  a user read, create, concentrate or run better. The literature is about
  background sound affecting cognition; the bridge from "our acoustics match
  the description" to "this works for you" has not been walked. Every mode's
  `limitations` field says so on screen. See
  [09-sound-science.md](09-sound-science.md).
- The LTASS speech spectrum used by the AI calculation is a representative
  textbook curve, not a measurement of any particular talker.
- The Rhythm Model's goal bands (`GOAL_BANDS` in `rhythm/model.ts`), like
  the engine's `ANCHORS`, are hand-authored starting points defining which
  part of the user's *own* range suits each protocol — not population norms.
- The confidence bar shown alongside a rhythm prediction is a heuristic
  squashing of the predictive standard deviation into 0..1, explicitly
  **not** a calibrated probability. The honest quantity is `std`, which is
  what the ±1σ band actually draws.
- Everything in the "not built" column of
  [00-orchestrator.md](00-orchestrator.md).
