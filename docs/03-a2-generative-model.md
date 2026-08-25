# A2 — ML Engineer, Generative Audio

Component: `packages/engine/src/model/nfd.ts`, `packages/engine/src/latent.ts`,
`packages/engine/src/harmony.ts`.

## Read this first: what "neural" means in this build

The spec's engineering non-negotiable is to engineer around Endel's patent
family (notably the stem-recombination pipeline) with "fundamentally
different generation methods (neural synthesis rather than rule-based
layering of pre-designed stems)". This build satisfies that at the
**architecture** level and is explicit about what it does not yet satisfy at
the **trained-weights** level:

- **Architecturally neural and stem-free, verified:** every synthesis
  parameter (16 partial gains, 8 inharmonicity coefficients, 14 spectral-bed
  band gains, excitation tone/noise mix, ring time, grain rate/spread, sub
  level, shimmer, transient) is the output of a feed-forward network
  (`NeuralFieldDecoder`, 26→48→48→46, SiLU hidden layers) evaluated at
  control rate from a continuous 16-D latent trajectory and the 10-D control
  vector. There is no lookup table, no stem index, no gate — grep
  `packages/engine/src` for any audio asset reference and there is none.
- **Not yet trained:** `NeuralFieldDecoder.loadWeights()` is a real,
  tested weight-loading path (magic-number + shape validation, degrades
  safely to the fallback on any mismatch — see `nfd.ts`), but no `.nfd`
  weight file has been produced. Every session in this build runs
  `analyticPrior()`, a hand-derived closed-form function occupying the exact
  same input/output contract. **Say "neural-architecture decoder running an
  untrained analytic prior", not "trained neural model".** The distinction
  is load-bearing for the patent-differentiation argument (the *mechanism*
  is genuinely different — a continuous function approximator conditioned on
  a control vector, not a recombination table — independent of whether its
  weights are hand-derived or learned) but must not be blurred into "we
  shipped a trained model."

## Why an MLP decoder + latent trajectory, not a direct diffusion/RVQ model

The spec's aspiration (Part 2, pillar 1) is a distilled latent-diffusion or
RVQ streaming model. That class of model is real, but it does not fit inside
an `AudioWorkletProcessor`: the worklet thread has a ~2.7 ms hard deadline
per 128-frame quantum and no GPU access, while a diffusion/RVQ decoder step
is milliseconds-to-tens-of-milliseconds on its own even quantized. The
architecture here is the standard resolution to that mismatch: split into

1. A **large model** (not built in this session — see "Not built" below)
   that would run on the main thread over WebGPU at a low control rate
   (~10 Hz) and emit *latent trajectories and style embeddings*, informed by
   a genuinely large training corpus and genuinely expressive architecture.
2. A **small, real-time-safe decoder** (`NeuralFieldDecoder`, built and
   tested this session) that turns a latent point + control vector into
   synthesis parameters, cheap enough (~5.7k MACs/eval) to run every control
   block inside the worklet with room to spare.

This split — not the specific 46-parameter synthesis contract — is the
part of the architecture that should outlive any specific model choice.

## Latent trajectory: why it can't repeat

`latent.ts::LatentTrajectory` combines two processes:

1. An Ornstein-Uhlenbeck mean-reverting diffusion pulled toward
   `mu(control)` — gives controllable wandering *within* the region the
   control vector specifies.
2. A bank of 5 slow oscillators at golden-ratio-power periods
   (`1/(41.7 * phi^i)` for i=0..4) — because phi is irrational, no finite sum
   of these periods ever exactly repeats. This is the actual, checkable
   mechanism behind "zero audible loops": not "we made it long enough that
   repeats are statistically unlikely" but "the driving trajectory has no
   period at all."

Combined with the spectral bed's fully-randomised-phase resynthesis every
hop (`voices/bed.ts`) and the grain field's Poisson (memoryless) arrival
process (`voices/grains.ts`), there is no layer in the signal chain with a
fixed cycle length. `packages/engine/test/clfs.test.js`'s repetition test is
the empirical spot-check of this argument at a scale a test suite can
actually run (24 s); it is not itself a proof for 8-hour sessions.

## Harmonic engine: engineering around, not just distinguishing from

Endel's stated approach (Part 1): pentatonic scales, 12-TET, A440, chosen to
minimize structural complexity. `harmony.ts::HarmonicWalker` instead performs
a Metropolis random walk over a **just-intonation lattice** (points
`3^b * 5^c * 7^d`, reduced to an octave), where the *admissible lattice
radius* (Tenney harmonic distance budget) is a continuous function of
`ControlVector.tension`. Two consequences:

- Sustained tones actually lock (small-integer ratios), which is the
  acoustic reason a just-intonation drone can sound smoother than an
  equal-tempered one at long sustain — not an aesthetic preference, a beat-
  frequency fact.
- "Simplicity" is a dial (tension), not a scale choice — tension 0 admits
  only octaves/fifths, tension 1 opens 7-limit territory. A fixed-scale
  engine cannot make harmonic complexity continuously controllable this way
  because the scale itself is the discretization.

Root frequency drifts slowly and continuously (±35 cents over ~7 minutes,
`driftRoot()`) rather than sitting at a fixed reference pitch — deliberately
avoiding any "440 Hz natural order" framing; see
[07-claims.md](07-claims.md).

## Style packs / personal styles: the actual mechanism

Per Part 2 pillar 1 ("learn my taste from these 5 tracks"): the architecture
supports this as a **latent offset**. `LatentTrajectory.setStyle(embedding,
weight)` blends a 16-D embedding into `mu(control)` computation. An artist
pack and a personal style are the same mechanism — a 16-D vector and a
blend weight — not a separate asset pipeline per style. **Not built:** the
embedding-extraction pipeline itself (analyzing 5 user-supplied tracks into
a 16-D point respecting rights) — the consumption side is real and tested-
by-construction (the blend math in `latent.ts`), the production side is not
started.

## Recommended eval harness (not built this session)

Part 4 asks for model cards and an eval harness (audio quality MOS, control
fidelity, repetition metrics). What exists today:

- Repetition: the cross-correlation regression test above — a floor, not
  the real metric.
- Control fidelity: **not measured**. The honest next step is a harness
  that renders at a grid of control-vector points, extracts spectral
  centroid/rolloff/onset-rate, and checks monotonicity against the
  control dimension that should drive each (e.g. brightness ↔ centroid) —
  `ClfsCore` is already Node-runnable headless, so this harness is a
  straightforward addition to `packages/engine/test/` or a new `eval/`
  directory, not a new architecture.
- MOS (audio quality/pleasantness vs. Endel): **not measured** — needs
  actual human listeners, which no amount of engineering substitutes for.
  This is the top recommendation in
  [00-orchestrator.md](00-orchestrator.md).

## Explicit non-goals of this session

- No model was trained. No training data was collected. No GPU/WebGPU
  inference path was implemented (WebGPU is referenced in the architecture
  target, not built).
- No quantization pipeline exists (nothing to quantize yet).
- No style-embedding extraction pipeline.
