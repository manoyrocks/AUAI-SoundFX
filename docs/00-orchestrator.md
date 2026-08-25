# PM/Orchestrator status — SoundFX

Maintained by: PM/Orchestrator agent. Last updated: 2026-08-25.

This document tracks the spec (root brief, Parts 0–6) against what has
actually been built and verified in this repository. Per the mandate: work
that merely matches Endel parity is rejected, and claims here are limited to
what has been run and observed — see [07-claims.md](07-claims.md) for the
house rule this document itself follows.

## Milestone status

| Milestone | Status | Evidence |
|---|---|---|
| **M1** — in-browser streaming soundscape, live control-vector morphing, camera rPPG influencing sound | **Done, verified** | See below |
| **M2** — closed loop, state estimator, conservative controller, measurable outcomes, mobile core, haptic breath pacer | **Partial** — web-side closed loop + outcomes + haptics done; mobile core not started | See below |
| **M3** — copilot, Rhythm Model, efficacy dashboard, onboarding, 3 flagship protocols, light orchestration | **Partial** — Rhythm Model, 3 flagship protocols, and efficacy dashboard done; copilot, onboarding, light orchestration not started | See below |
| **M4** — hardening, battery/latency budgets, accessibility pass, privacy audit, N-of-1 engine, beta | **Partial** — both blocking safety gaps closed; accessibility pass partial; budgets/N-of-1/beta not started | See below |

### M1 evidence

- Neural-field synthesis engine (`packages/engine`) running live in an
  `AudioWorkletNode`, verified via a real user-gesture session in-browser:
  non-zero, in-range audio output; 4–8 modal voices active; telemetry
  streaming main-thread ↔ audio-thread at 5 Hz. See
  [01-a1-audio-core.md](01-a1-audio-core.md).
- Live control-vector morphing: the on-screen vector readout and generative
  visual (`apps/web/src/visual.ts`) are driven by the *same* rate-limited
  slew law (`slewToward`, `packages/engine/src/control.ts`) as the audio
  thread — verified by direct pixel sampling of the canvas, not just code
  review.
- Camera rPPG: POS algorithm + zero-phase bandpass + Goertzel frequency
  estimation + beat-picking + RMSSD, verified against synthetic
  known-ground-truth pulse traces (`packages/biosignal/test/rppg.test.js`,
  4/4 passing, recovers 50–140 bpm within 3–4 bpm). Camera-denial path
  verified live (graceful banner, no crash). See
  [04-a3-biosignals-and-control.md](04-a3-biosignals-and-control.md).
- 32/32 automated tests passing across the workspace (`npm test`), including
  a repetition-guard test and the sleep-mode safety-invariant test (below).

### M2 evidence (web slice)

- Closed-loop controller (`packages/protocol/src/controller.ts`): fuses HR +
  HRV against a per-user online baseline, conservative/saturating response,
  hard safety clamp. 6/6 tests passing, including an adversarial test that
  feeds a 170 bpm reading into sleep mode and asserts arousal/tempo/tension
  cannot exceed the sleep anchor — this is Part 6's "sleep sessions never
  spike arousal" guardrail, enforced in code and checked by CI, not only by
  design intent.
- Session outcomes (`packages/protocol/src/outcomes.ts` +
  `apps/web/src/sessionStore.ts`): local-only (localStorage) before/after HR
  record per session, with an explicit sample-count honesty gate — sessions
  without enough confident readings show "not enough signal" rather than a
  fabricated delta. 6/6 tests passing; verified live end-to-end (start
  session → end session → localStorage entry → rendered history row).
- Haptic breath pacer (`apps/web/src/breathpacer.ts`): continuous
  control-vector-derived breath cycle (not a fixed preset), Vibration API
  where available with a documented iOS/desktop gap, visual ring fallback
  always active. 6/6 tests on the cycle/envelope math.
- **Not done**: the Rust/Kotlin-multiplatform mobile core. This is a
  multi-week, multi-person effort (native audio backends, JNI/Swift
  bindings, platform build pipelines) that cannot be responsibly claimed
  "running" without actually running it on a device. See
  [02-a4-platform.md](02-a4-platform.md) for the concrete path.
- **Not done**: the learned safe-RL controller. What ships instead is a
  hand-specified, bounded, saturating proportional controller — explicitly
  documented in its own file header as the M1/M2 placeholder for the
  eventual learned policy, sharing the same `computeAdjustment` signature so
  the swap is contained. Building a real RL policy needs the synthetic-
  physiology simulation environment (A3 deliverable, not yet built) to
  validate safety *before* any human hears it — sequencing that correctly
  matters more than shipping something premature.

### M3 evidence (partial)

- **Three flagship protocols** (`packages/protocol/src/protocols.ts`):
  Deep Work (90 min, 4 phases), Wind-Down → Sleep (45 min, 3 phases),
  Recovery (20 min, 3 phases). Each phase is a control-vector waypoint with
  a duration and user-facing intent copy; `protocolPositionAt` interpolates
  between waypoints with smoothstep easing so phase boundaries have zero
  first derivative — nothing lurches at a transition. 6/6 tests, including
  one asserting no control dimension jumps >5% of its range between
  adjacent 0.05-minute samples anywhere in any protocol.
  **Verified live in-browser**: a Wind-Down session driven across its full
  45-minute timeline showed a clean monotonic descent — arousal 0.24→0.05,
  tempo 52→40 BPM, brightness 0.32→0.16 — with correct phase transitions.
  Because a protocol only supplies a *target*, the engine's own rate limiter
  still governs actual movement, so a protocol structurally cannot violate a
  safety bound by scheduling an aggressive ramp.
- **Efficacy dashboard** ("Does this work for me?"): per-mode aggregates
  from local session history, with sample counts shown alongside every
  number and a standing caveat that these are before/after readings, **not**
  evidence of causation. Renders "not enough signal" rather than a computed
  mean whenever the reliability gate isn't met.
- **Personal Rhythm Model** (`packages/protocol/src/rhythm/*`) — full
  writeup in [08-rhythm-model.md](08-rhythm-model.md). Harmonic regression
  on local clock time, fitted by online ridge over sufficient statistics
  (so no observation is ever stored), with **prequential model selection**
  across five nested candidates: each predicts an observation before
  learning from it, so selection is on genuine held-out accuracy per user.
  24/24 tests. **Verified live**: seeded with a pure 24-hour cosine, it
  selects `circadian` (MSE 0.013) over the flat null model (0.102) and over
  richer candidates that don't earn their parameters (0.0137–0.0138) —
  including correctly rejecting the clock-anchored ultradian term.
  Three-way readiness gating (observations, distinct hours, distinct days)
  means it refuses to forecast rather than extrapolate; verified live that
  a fresh install shows coverage progress and no curve.
  Drives protocol scheduling end-to-end: forecast → suggestion with start
  time and rationale → one tap → protocol selected, mode adopted, session
  running.
- **Four new sound categories** (`docs/09-sound-science.md`) — Read, Open,
  Screen, Move. Each was required to demand a genuine new engine capability,
  not just new anchor values: syllabic-modulation suppression and a
  token-set cap (Read), a masking-spectrum override with an
  Articulation-Index implementation (Screen), and cadence-locked
  near-periodic onsets (Move). Open is the exception and is marked as such —
  parameterisation only, `moderate` evidence, because its source effect is
  defined by absolute SPL that no app can control.
  Introduced `SynthesisConstraints`, separating categorical acoustic rules
  from the negotiable control vector — a split that should have existed from
  the start. 23 tests, measuring real acoustic properties (modulation depth,
  spectrum efficiency, cadence peak) rather than parameter round-trips.
- **Not started**: agentic copilot, onboarding flow, light orchestration
  (Hue/Matter — no hardware available to verify against).

### M4 evidence (partial)

- **Both previously-blocking safety gaps are now closed** — see
  [06-safety.md](06-safety.md). Contraindication screening
  (`screening.ts`, default-deny, fails closed, gate built *before* the
  features it guards) and distress escalation (`distress.ts`, deliberately
  detects "the loop isn't working" rather than attempting to infer a
  mental-health state from a webcam). 11/11 tests.
- **Accessibility**: `prefers-reduced-motion`, `aria-live` on status
  regions, `aria-pressed` synced on all toggles, `aria-hidden` on
  decorative canvas/video, labelled controls. Still missing: the
  haptic-only no-audio mode named in Part 3, and a full screen-reader
  walkthrough.
- **Not started**: battery/latency budget measurement on real devices,
  N-of-1 blinded experiment engine, beta.

## Honest inventory: real vs. placeholder

The single biggest way this kind of spec goes wrong is a demo that *sounds*
like every pillar is done. Here is the explicit ledger.

**Genuinely real and tested:**
- Neural field synthesis (no stems, no samples, no impulse responses —
  grep the repo for audio assets, there are none)
- Just-intonation harmonic lattice walker with continuous tension control
- Camera rPPG signal chain (POS/bandpass/Goertzel/RMSSD)
- Closed-loop HR+HRV → control-vector controller with a hard safety clamp
- Session outcome logging with an honesty gate
- Haptic/visual breath pacer
- Cross-platform-ready web engine (WebAudio + AudioWorklet), fully on-device
- Three multi-phase flagship protocols with continuity-guaranteed scheduling
- Efficacy dashboard with sample-count gating and an anti-causation caveat
- Default-deny contraindication screening
- Distress escalation scoped to "the loop isn't working", not diagnosis
- Personal Rhythm Model: online harmonic regression with prequential model
  selection, three-way readiness gating, surfaced predictive uncertainty,
  and rhythm-driven protocol scheduling
- Four science-derived modes (Read / Open / Screen / Move) with a
  `SynthesisConstraints` layer separating categorical acoustic rules from
  the negotiable aesthetic control vector

**Real but explicitly a placeholder for something bigger:**
- The Neural Field Decoder (`packages/engine/src/model/nfd.ts`) is a real,
  tiny MLP with a real weight-loading path — but no weights have been
  trained. It runs its `analyticPrior()` fallback, a hand-derived closed-form
  decoder, always, in this build. The architecture (26→48→48→46, SiLU,
  16-D latent) is sized and shaped for a real distillation pipeline; that
  pipeline (a full streaming diffusion/RVQ teacher model, distillation,
  quantization) has not been run. **This means the "neural synthesis"
  claim is architecturally true — the generation method is neurally
  parameterised end-to-end and there is no stem library — but the specific
  numbers the network would learn are currently a hand-authored prior, not
  learned.** Do not claim otherwise.
- The M1/M2 controller (see above) is the bounded placeholder for the
  eventual safe-RL policy.
- The spectral/generative visual (`apps/web/src/visual.ts`) is 2D canvas,
  not the WebGPU shader layer the spec describes for M3.

**Not built, scoped out with reasons:**
- Mobile native shells (iOS/Android) — needs real device build pipelines.
- Cloud (auth, sync, federated aggregation) — no user accounts exist yet;
  building sync before there's anything worth syncing (trained models,
  cross-device preference vectors) is premature.
- Agentic copilot (M3) — its two prerequisites (protocol scheduler, Rhythm
  Model) now both exist, so this is genuinely unblocked for the first time
  and is the top remaining pillar. It was correct not to build it earlier:
  an LLM copilot with nothing real to call is a chatbot skin over a mode
  picker. It now has real tools to call — forecast windows, schedule and
  reshape protocols, explain the fitted model.
- Light orchestration (Hue/Matter) — no hardware available to test against
  in this environment; shipping unverified smart-home integration code is
  worse than not shipping it.
- N-of-1 blinded experimentation engine — this is a real statistics
  feature (needs a defensible blinding/withholding design and a minimum-N
  policy before it can honestly report an effect size). Building it before
  the session-outcomes substrate (done, this session) existed would have
  been building on nothing.
- Artist style-pack marketplace, SDK/API surface — explicitly "design for,
  don't build first" per Part 2.

## Quality-bar scorecard (Part 6)

| Bar | Status |
|---|---|
| Sonic: more pleasant / less repetitive than Endel, blind-tested | **Not measured** — no blind listener panel has been run. The repetition half is partially substantiated structurally (irrational-ratio latent oscillators, Poisson grain arrivals, randomised-phase spectral resynthesis have no exact period by construction) and by a regression test asserting no near-duplicate 1-second blocks across a 24 s render. That is evidence against gross bugs, not a MOS/preference study. |
| Zero audible loops in 8h sleep sessions | **Structurally argued, not empirically run at 8h scale.** The synthesis has no periodic component by design (see [03-a2-generative-model.md](03-a2-generative-model.md)); an actual 8-hour blind listen has not been done. |
| Efficacy: honest per-user deltas, never overclaimed | **Mechanism built** (outcomes.ts honesty gate), **not yet validated against a real user population.** |
| Safety: entrainment/epilepsy/arrhythmia screening | **Built and tested.** Default-deny gating (`screening.ts`), fails closed on non-boolean consent, plain-language contraindication copy surfaced next to each toggle. The gate exists *before* any gated technique is implemented — the correct order. See [06-safety.md](06-safety.md). |
| Safety: distress escalation copy | **Built and tested.** Deliberately narrow: detects sustained non-response to a calming session, not a mental-health state. Fires at most once, disengages the loop rather than escalating, points to findahelpline.com, and is test-asserted to contain no pathologising language. |
| Safety: sleep never spikes arousal | **Enforced in code, tested adversarially.** See M2 evidence above. |
| Safety: not a medical device, no diagnostic claims | Copy audited in the current UI (`apps/web/src/main.ts` footer note, HR-status strings) — explicitly hedges camera HR/HRV as estimates, not measurements. No diagnostic language present. |
| Privacy: raw biometrics never leave device | **True by construction and grep-verified** — `packages/biosignal` and the session/outcome path contain no `fetch`/`XHR`/`WebSocket` calls. See [05-privacy.md](05-privacy.md). |
| IP: legal review against Endel's patent family | **Not done** — needs an actual attorney, not an engineering self-assessment. Flagged as a real M3 blocker, not skipped silently. Engineering-level differentiation is documented in [03-a2-generative-model.md](03-a2-generative-model.md): rule-based stem recombination vs. parameterised neural-field synthesis is a different mechanism, not a re-skin, but that is not a substitute for legal sign-off. |
| No streaks, no dark patterns | Held: no engagement metrics, no streaks, no notifications-for-retention exist anywhere in the codebase. Session end is a plain fade, not a guilt prompt. |

## Recommendations (priority order)

1. **Before adding any more surface area: run a real listening panel.**
   Every sonic quality-bar claim is currently structural argument, not
   listener data. This is cheap relative to everything else on this list and
   directly de-risks the sonic bar.
2. **Build the A3 synthetic-physiology simulator before touching RL.** It's
   the prerequisite the spec itself names for safe controller development,
   and it's also what would let the sleep-safety invariant be tested against
   thousands of adversarial synthetic traces instead of the handful of
   hand-picked cases in the current test suite.
3. **Get the patent legal review scheduled now, not at M3.** It gates go/no-
   go on the entire generation approach; finding a problem late is far more
   expensive than finding it now, while the architecture is still cheap to
   redirect.
4. **Validate the Rhythm Model's arousal proxy against real users.** The
   estimator is verified against synthetic ground truth — it recovers a
   known curve, rejects components the data doesn't support, and refuses to
   forecast without coverage. What is *not* established is that the HR-based
   arousal proxy tracks anything a user would recognise as their energy
   level. That is a study, not a code change, and it gates whether the
   forecast is genuinely useful or merely well-fitted.
5. **The copilot is now genuinely unblocked** — both its prerequisites
   (protocol scheduler, Rhythm Model) exist, so it finally has real tools to
   call rather than a mode picker to wrap. It is the top remaining pillar,
   but should still come after (4): a copilot confidently narrating an
   unvalidated forecast would launder an unproven signal into
   authoritative-sounding advice, which is the specific failure mode
   [07-claims.md](07-claims.md) exists to prevent.
6. **Still hold off on light orchestration** — needs hardware to verify
   against, and shipping unverified smart-home code is worse than not
   shipping it.
7. **Mobile core is a distinct, large, separately-staffed effort.** Treat it
   as its own workstream with its own timeline rather than a subtask of the
   current one.

## Repository map

```
packages/engine/     — A1 + A2: DSP core, synthesis voices, NFD, AudioWorklet host
packages/biosignal/   — A3 (sensing half): camera rPPG pipeline
packages/protocol/    — A3 (control half): baseline, controller, outcomes
apps/web/             — A4 (web) + D1/D2 surfaces: PWA, UI, breath pacer, session store
docs/                 — this directory
```

Run `npm install && npm test` from the repo root to build every package and
run all 32 automated tests. Run `npm run dev` to launch the M1/M2 web demo.
