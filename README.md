# SoundFX

A closed-loop, neurally-parameterised, on-device audio wellness engine.

Every sample of audio is synthesised from a mathematical model driven by a
continuous 10-dimensional control vector. There are no stems, no samples, no
loops, and no impulse responses anywhere in this repository — the palette is
bounded by the control vector's continuous range rather than by an asset
library.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5173, pick a mode, and press **Begin session**
(audio requires a user gesture — browser autoplay policy). Optionally enable
**Camera sensing** to close the biofeedback loop with camera-based heart
rate.

```bash
npm test
```

Builds every workspace package and runs the full suite (96 tests).

## What it does

**Nine modes**, each a different point in the control space:

| Mode | For |
|---|---|
| Deep Work | Sustained concentration |
| Read | Verbal serial tasks — reading, writing, editing, mental arithmetic |
| Open | Divergent thinking; deliberately busier than Deep Work |
| Calm | Settling without going to sleep |
| Screen | Making nearby conversation harder to follow in shared spaces |
| Move | Walking, running — the only mode with a perceivable pulse, locked to your cadence |
| Energy | Raising activation |
| Recovery | Parasympathetic downshift after strain |
| Sleep | Wind-down and sleep onset |

Read, Open, Screen and Move each derive from specific published findings and
demanded a distinct engine capability — see
[09-sound-science.md](docs/09-sound-science.md). Each carries its own
evidence grading and limitations in the interface, not just in these docs.

**Closed-loop biofeedback.** Optional camera-based heart rate and HRV, fused
against a personal baseline learned online, steering the soundscape live.
All processing on-device.

**Rhythm forecasting.** An on-device model of your daily rhythm, learned
from your own readings, which forecasts favourable windows and proposes a
protocol and a start time to fit one. It refuses to forecast until it has
seen enough spread across hours and days, rather than extrapolating.

**Multi-phase protocols.** Deep Work, Wind-Down → Sleep, and Recovery, each
a sequence of control-vector waypoints the scheduler interpolates between.

**An efficacy dashboard that declines to overclaim** — sample counts beside
every number, and a standing caveat that before/after readings are not
evidence of causation.

## Packages

| Package | Role |
|---|---|
| `packages/engine` | Synthesis core: DSP primitives, modal/spectral/granular/drone voices, just-intonation harmonic walker, latent trajectory, neural field decoder, speech-masking psychoacoustics, AudioWorklet host |
| `packages/biosignal` | Camera rPPG: skin-ROI detection, POS algorithm, bandpass/Goertzel HR estimation, beat picking, RMSSD |
| `packages/protocol` | Personal baseline tracking, closed-loop controller with hard safety clamps, session outcomes, flagship protocols, contraindication screening, distress escalation, and the Personal Rhythm Model |
| `apps/web` | The PWA: session UI, generative visual, breath pacer, rhythm forecast panel, local session history |

## Documentation

Start with **[docs/architecture.md](docs/architecture.md)** for how the
system fits together, then **[docs/00-orchestrator.md](docs/00-orchestrator.md)**
for the build ledger — an explicit account of what is genuinely built and
tested versus what is a documented placeholder.

- [architecture.md](docs/architecture.md) — system overview, data flow, threading model, extension points
- [01-audio-engine.md](docs/01-audio-engine.md) — real-time audio core, synthesis methods, latency/isolation
- [02-platform.md](docs/02-platform.md) — monorepo/platform decisions, mobile recommendation
- [03-synthesis-model.md](docs/03-synthesis-model.md) — the generative architecture, and precisely what "neural" means in this build
- [04-biosignals-and-control.md](docs/04-biosignals-and-control.md) — sensing pipeline, fusion, controller
- [05-privacy.md](docs/05-privacy.md) — plain-language data map
- [06-safety.md](docs/06-safety.md) — safety guardrails, including unmet requirements
- [07-claims.md](docs/07-claims.md) — copy audit and claims substantiation
- [08-rhythm-model.md](docs/08-rhythm-model.md) — the Personal Rhythm Model: method, honesty gates, and what it can't yet claim
- [09-sound-science.md](docs/09-sound-science.md) — the four science-derived modes: findings, what was built, and one instructive bug

## Honest status

M1 complete; M2/M3/M4 partial. Real and tested: the synthesis engine, camera
rPPG pipeline, closed-loop HR+HRV controller with hard safety clamps, the
Personal Rhythm Model with rhythm-driven protocol scheduling, nine modes —
four of them derived from specific behavioural sound science with measured
acoustic verification — three multi-phase flagship protocols, session
outcomes, efficacy dashboard, contraindication screening, distress
escalation, and the breath pacer — 96 automated tests.

Not built: the trained generative model (the decoder architecture is real
and runs a hand-derived analytic prior — see
[docs/03-synthesis-model.md](docs/03-synthesis-model.md) for exactly
what "neural" does and doesn't mean here), mobile apps, cloud sync, the
copilot, light orchestration, and the N-of-1 blinded experiment engine.

Both previously-blocking safety requirements are now met. The
outstanding pre-rollout items are an independent IP review of the synthesis
method, a real listening panel, and validating the Rhythm Model's arousal
proxy against real users — see
[docs/00-orchestrator.md](docs/00-orchestrator.md).

## Requirements

Node 20+ (developed against Node 24). A Chromium-based browser or Firefox
for the full experience; camera rPPG additionally needs a working webcam and
granted camera permission.
