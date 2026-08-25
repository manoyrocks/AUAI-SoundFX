# Real-time audio core

Component: `packages/engine/src/dsp/*`, `packages/engine/src/voices/*`,
`packages/engine/src/clfs.ts`, `packages/engine/src/worklet/processor.ts`.

## The central property: no audio assets exist

This component contains **no recorded or pre-authored audio material at
all** — no stems, no samples, no impulse responses. The repository ships
zero bytes of audio.

That is not a size optimisation, it is what makes the palette continuous.
Any parameter can move by any amount, and every intermediate state is a
real soundscape rather than a transition between two fixed ones — there is
no smallest addressable unit of change.

Every voice renders raw waveform from a model, evaluated fresh each session:

| Voice | File | Method |
|---|---|---|
| Struck/pitched bodies | `voices/modal.ts` | Bank of damped complex-exponential modal resonators (physical modelling), excited by shaped bursts. Inharmonicity (`B` coefficient) is a continuous NFD output, so the "material" of the instrument (string-like → bell-like) is a control dimension, not a preset. |
| Ambient texture bed | `voices/bed.ts` | Direct frequency-domain synthesis: per-hop magnitude envelope (14 NFD-controlled bark-spaced bands) with **fully randomised phase**, inverse-FFT, 50%-overlap-add. |
| Shimmer/incident detail | `voices/grains.ts` | Poisson-process grain scatter, each grain's frequency/duration/FM index/pan drawn independently. |
| Sustaining harmonic field | `voices/drone.ts` | Detuned oscillator pairs per partial, irrational detune spread so no two partials ever phase-lock into an audible beat period. |
| Space | `dsp/fdn.ts` | 8-line Householder feedback delay network — algorithmic, not convolution, so room size/damping are continuous controls rather than a fixed IR swap. |

The practical consequence: the palette is bounded only by the 10-D control
vector's continuous range, not by how much material anyone had time to
create. It is also why "zero audible loops in 8 hours" holds *by
construction* rather than by making a cycle long enough to be unlikely to
notice — no layer in the chain has a period at all. See the repetition
argument in [03-synthesis-model.md](03-synthesis-model.md).

## Real-time isolation

`worklet/processor.ts` runs the entire signal chain
(`clfs.ts` → dsp/voices) inside `AudioWorkletProcessor.process()`, on the
browser's dedicated real-time audio thread. The module graph it imports
contains zero DOM calls and zero dependency on `window` — verified by the
fact that `clfs.ts` is directly unit-testable in plain Node
(`packages/engine/test/clfs.test.js`) with no browser shim. A GC pause or a
long task on the main thread (React re-render, the future copilot's LLM
call, telemetry) structurally cannot skip an audio callback, because nothing
on that thread runs on the main thread.

Cross-thread communication is one-directional-per-message, small, and
infrequent: `ControlVector` updates flow main→worklet as a packed
`Float32Array(10)` (`packControl`/`unpackControl` in `control.ts`);
telemetry flows worklet→main throttled to 5 Hz. No audio sample ever
crosses `postMessage`.

## Verified performance

From `packages/engine/test/clfs.test.js` (10/10 passing) and live telemetry
in a real `AudioWorkletNode` session:

- All 5 anchor modes (`deepWork`, `calm`, `sleep`, `energy`, `recovery`)
  render finite, `[-1,1]`-bounded audio with audible RMS after fade-in.
- A 6-mode sequence of rapid mid-session target changes produces no NaN/Inf
  — the control-rate slew limiter (`control.ts::slewToward`) and the
  per-voice smoothing (`OnePole`, drone gain ramps) hold up under adversarial
  parameter jumps, not just gentle ones.
- No two 1-second blocks across a 24-second render correlate above 0.9
  (max cross-correlation observed, seed-fixed), and no block pair is
  sample-identical — a regression guard against buffer-reuse/RNG-cycling
  bugs, the concrete failure mode behind "audible looping".
- Live telemetry (`ClfsTelemetry.blockMicros`) during a real browser session
  showed processing time far under the ~2.9 ms per-128-frame budget at
  48 kHz (128/48000 ≈ 2.67 ms; the engine's internal control block is 512
  frames ≈ 10.7 ms, processed in well under 1 ms per the telemetry observed
  in-browser).

## Latency budget

Design target: <50 ms control-to-sound. Actual path: `ClfsHost.setTarget()`
→ `postMessage` (sub-millisecond) → `ClfsCore.setTarget()` → rate-limited
slew toward the new target over the *next* control block(s). The
**engine's own safety design deliberately does not jump instantly** — see
`CONTROL_RANGES[*].maxRatePerSec` in `control.ts` — so "control-to-sound
latency" is better read as "control-to-first-audible-movement latency",
which is one control block (≈10.7 ms), comfortably inside budget. A full
move from one anchor to another takes longer by design (e.g. arousal's
`maxRatePerSec = 0.05` means a full 0→1 sweep takes 20 s) — this is the
mechanism, not a bug, and is exactly what makes the "audio glitch rate ~0"
and "sleep never spikes arousal" guarantees possible simultaneously with a
responsive-feeling control surface.

## Battery / cold-start

Not yet measured on a real device (this build only has browser-preview
telemetry available, not a battery API benchmark harness). Structural
reasoning: the modal bank is capped at 8 simultaneous voices with automatic
voice stealing and silence-based retirement (`ModalBank` in `modal.ts`), the
spectral bed runs one 1024-point FFT pair per 512 samples (~94 Hz, ~0.5% of
a core by the file's own design comment), and there is no per-sample
allocation anywhere in the hot path (`Rng`, `Fft`, `Biquad`, `Fdn` all
pre-allocate typed arrays at construction). This is consistent with the
<5%/hr mobile budget but **has not been measured against it** — flagged
explicitly rather than claimed.

Cold-start: `ClfsHost.start()` does `addModule` → construct node → `snapTo`
→ fade in. In the verified browser session this completed well under the
<2 s target (worklet bundle is 47.4 KB, loads near-instantly on localhost;
production CDN latency is untested).

## What has not been built

- No native (Rust core / Oboe / AVAudioEngine) implementation — this is a
  TypeScript/WebAudio implementation only. The DSP algorithms
  (modal synthesis, FDN, granular, spectral resynthesis) are written to be
  directly portable in structure (flat typed-array state, no
  closures-over-frames-in-the-hot-loop) but porting is unstarted work, not
  "mostly done".
- No formal glitch-rate measurement under load (CPU throttling, other tabs
  competing for the audio thread's priority).
- No benchmark suite executable file separate from the correctness tests —
  `clfs.test.js`'s timing assertions are incidental (via `performance.now()`
  in telemetry), not a dedicated perf regression harness. Recommended next
  step if this component continues: a `bench/` script that renders N
  seconds headless and reports samples/second on the current machine as a
  tracked number over time.
