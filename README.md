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

## What's here

| Package | Role |
|---|---|
| `packages/engine` | Synthesis core: DSP primitives, modal/spectral/granular/drone voices, just-intonation harmonic walker, latent trajectory, neural field decoder, speech-masking psychoacoustics, AudioWorklet host |
| `packages/biosignal` | Camera rPPG: skin-ROI detection, POS algorithm, bandpass/Goertzel HR estimation, beat picking, RMSSD |
| `packages/protocol` | Personal baseline tracking, closed-loop controller with hard safety clamps, session outcomes, flagship protocols, contraindication screening, distress escalation, and the Personal Rhythm Model |
| `apps/web` | The PWA: session UI, generative visual, breath pacer, rhythm forecast panel, local session history |

## Documentation

Start with **[docs/00-orchestrator.md](docs/00-orchestrator.md)** — it
contains the milestone status and, importantly, an explicit ledger of what
is genuinely built and tested versus what is a documented placeholder.

- [01-a1-audio-core.md](docs/01-a1-audio-core.md) — real-time audio core, synthesis methods, latency/isolation
- [02-a4-platform.md](docs/02-a4-platform.md) — monorepo/platform decisions, mobile recommendation
- [03-a2-generative-model.md](docs/03-a2-generative-model.md) — the generative architecture, and precisely what "neural" means in this build
- [04-a3-biosignals-and-control.md](docs/04-a3-biosignals-and-control.md) — sensing pipeline, fusion, controller
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
[docs/03-a2-generative-model.md](docs/03-a2-generative-model.md) for exactly
what "neural" does and doesn't mean here), mobile apps, cloud sync, the
copilot, light orchestration, and the N-of-1 blinded experiment engine.

Both previously-blocking Part 6 safety requirements are now met. The
outstanding pre-rollout items are a patent legal review, a real listening
panel, and validating the Rhythm Model's arousal proxy against real users —
see [docs/00-orchestrator.md](docs/00-orchestrator.md).

## Requirements

Node 20+ (developed against Node 24). A Chromium-based browser or Firefox
for the full experience; camera rPPG additionally needs a working webcam and
granted camera permission.
