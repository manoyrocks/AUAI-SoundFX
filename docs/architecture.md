# Architecture overview

Start here if you are new to the codebase. This describes how the system
fits together; the numbered documents go deep on individual components, and
[00-orchestrator.md](00-orchestrator.md) tracks what is actually built
versus planned.

## The one-sentence version

A continuous 10-dimensional control vector is steered by on-device
intelligence, and a synthesis engine turns that vector into audio sample by
sample, with no recorded material anywhere in the path.

## Data flow

```
  camera frames                calendar / clock
        |                             |
        v                             v
  +-------------+            +------------------+
  | rPPG sensing|            | Personal Rhythm  |
  | (biosignal) |            | Model (protocol) |
  +------+------+            +---------+--------+
         |  StateVector                | forecast windows
         v                             v
  +--------------------+      +------------------+
  | Personal baseline  |      | Protocol         |
  | + feedback control |      | scheduler        |
  +---------+----------+      +---------+--------+
            |  adjustment               |  phase waypoint
            +-------------+-------------+
                          v
                 +------------------+
                 |  ControlVector   |  10 continuous dimensions
                 |  + Constraints   |  categorical acoustic rules
                 +--------+---------+
                          | postMessage (packed Float32Array)
        ==================|========== audio thread boundary
                          v
                 +------------------+
                 | LatentTrajectory |  16-D, aperiodic
                 +--------+---------+
                          v
                 +------------------+
                 | NeuralField      |  46 synthesis parameters
                 | Decoder (MLP)    |
                 +--------+---------+
                          v
        modal · spectral bed · grains · drone · FDN reverb
                          v
                      stereo out
```

## The two contracts that hold it together

Almost everything else is replaceable behind these.

### `ControlVector` — the aesthetic space

Ten continuous dimensions: `valence`, `arousal`, `density`, `tempo`,
`tension`, `brightness`, `air`, `motion`, `depth`, `complexity`.

Everything upstream — state estimation, the feedback controller, the
protocol scheduler, the rhythm model — speaks only this language.
Everything downstream consumes only this. No component names a preset or a
sound pack, because none exist: the vector *is* the composition.

Every dimension carries a `maxRatePerSec` rate limit (`CONTROL_RANGES`).
This is a safety mechanism, not a smoothing nicety — it is what guarantees
nothing can jerk the sound, no matter what asks it to.

### `SynthesisConstraints` — the acoustic rules

Categorical rules the synthesis must obey regardless of where the vector
sits: `avoidSyllabicModulation`, `maxTokenSet`, `maskingSpectrum`,
`cadenceSpm`.

The separation matters. Control-vector dimensions are negotiable and
steerable; constraints are not. Read mode's suppression of syllabic-rate
modulation is not "less of something" on a continuum — it is a forbidden
band, and the feedback controller must not be able to negotiate it away
while steering arousal. See [09-sound-science.md](09-sound-science.md).

## Threading model

The entire signal chain runs inside `AudioWorkletProcessor.process()` on the
browser's dedicated real-time audio thread. The module graph it imports has
zero DOM calls and no dependency on `window` — verified by the fact that
`ClfsCore` is directly unit-testable in plain Node with no browser shim.

A GC pause or long task on the main thread cannot skip an audio callback,
because nothing on that thread runs on the main thread.

Cross-thread traffic is small and infrequent: control vectors go
main→worklet as a packed `Float32Array(10)`; telemetry comes back throttled
to 5 Hz. **No audio sample ever crosses `postMessage`.**

One consequence worth knowing: the worklet is bundled separately by esbuild.
`npm run dev` rebuilds it and then watches it, but an engine change with a
stale bundle will silently not take effect.

## Packages

| Package | Responsibility |
|---|---|
| `packages/engine` | Synthesis. DSP primitives, voices, harmonic walker, latent trajectory, neural field decoder, psychoacoustics, worklet host. No knowledge of users, sessions, or biology. |
| `packages/biosignal` | Sensing. Camera rPPG: skin ROI, POS algorithm, bandpass, Goertzel estimation, beat picking, RMSSD. Produces `StateVector`; knows nothing about audio. |
| `packages/protocol` | Intelligence. Personal baseline, feedback controller, session outcomes, safety screening, distress monitoring, flagship protocols, Personal Rhythm Model. Speaks `StateVector` in and `ControlVector` out. |
| `apps/web` | Presentation. PWA shell, tabbed instrumentation, generative visual, breath pacer, local persistence. |

Dependencies point one way: `apps/web` → `protocol` → `engine`, with
`biosignal` feeding `protocol`. The engine never imports the protocol layer.

## On-device by default

There is no cloud component and no network request in the biosignal or
session path — checkable by grep, not a promise. Camera frames never leave
the analysis canvas. Session outcomes and the rhythm model persist to
`localStorage` only, and the rhythm model stores regression sufficient
statistics rather than observations, so individual readings are not
recoverable from it. Full data map in [05-privacy.md](05-privacy.md).

## Extension points

- **New mode** — add an anchor to `ANCHORS`. `AnchorName` derives from it,
  so the type threads through the controller, outcomes, and UI
  automatically. Add `MODE_CONSTRAINTS` only if the mode needs categorical
  acoustic rules, and a `MODE_SCIENCE` entry if its design traces to
  specific literature.
- **New protocol** — add to `PROTOCOLS` as a list of phase waypoints. The
  scheduler interpolates with smoothstep easing, and the engine's rate
  limiter still governs actual movement, so a protocol cannot violate a
  safety bound by scheduling an aggressive ramp.
- **New sensor** — produce a `StateVector` and let `PhysiologyBaseline`
  track it. The fusion controller reads agreement between signals.
- **Trained decoder weights** — `NeuralFieldDecoder.loadWeights()` is a real
  path with magic-number and shape validation that degrades safely to the
  analytic prior on mismatch. See
  [03-synthesis-model.md](03-synthesis-model.md) for what "neural" does and
  does not currently mean.

## Reading order

1. [01-audio-engine.md](01-audio-engine.md) — synthesis, real-time isolation
2. [03-synthesis-model.md](03-synthesis-model.md) — decoder, latent, harmony
3. [04-biosignals-and-control.md](04-biosignals-and-control.md) — sensing and the closed loop
4. [09-sound-science.md](09-sound-science.md) — the science-derived modes
5. [08-rhythm-model.md](08-rhythm-model.md) — forecasting and scheduling
6. [05-privacy.md](05-privacy.md), [06-safety.md](06-safety.md), [07-claims.md](07-claims.md) — the constraints everything above operates under
7. [02-platform.md](02-platform.md) — build, tooling, platform decisions
