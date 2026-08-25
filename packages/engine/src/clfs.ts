import { Biquad, DcBlock, OnePole, softClip } from "./dsp/biquad.js";
import { Fdn } from "./dsp/fdn.js";
import { Rng } from "./dsp/rng.js";
import { HarmonicWalker } from "./harmony.js";
import { LatentTrajectory } from "./latent.js";
import { NFD_LAYOUT, NeuralFieldDecoder } from "./model/nfd.js";
import {
  ControlVector,
  DEFAULT_CONSTRAINTS,
  SynthesisConstraints,
  anchor,
  clampControl,
  normaliseControl,
  slewToward,
} from "./control.js";
import {
  SUB_SYLLABIC_MAX_RATE_HZ,
  maskingBedEnvelope,
  spectrumEfficiency,
  MASKING_TARGET_DB,
} from "./psychoacoustics.js";
import { Drone } from "./voices/drone.js";
import { GrainField } from "./voices/grains.js";
import { ModalBank } from "./voices/modal.js";
import { BED_BANDS, SpectralBed } from "./voices/bed.js";

/**
 * Continuous Latent Field Synthesis (CLFS)
 * =======================================
 *
 * The whole generation stack, in one place, deliberately runnable outside an
 * AudioWorklet so the eval harness can render hours offline and measure
 * repetition, spectral drift and control fidelity without a browser.
 *
 * Signal flow, per control block (512 samples, ~94 Hz):
 *
 *   ControlVector --slew--> normalised control
 *                              |
 *                              v
 *              LatentTrajectory (OU + aperiodic oscillators) --> z (16-D)
 *                              |
 *                              v
 *                 NeuralFieldDecoder: [z, ctrl] -> 46 synthesis params
 *                              |
 *          +-------------------+--------------------+-----------+
 *          v                   v                    v           v
 *      ModalBank           SpectralBed          GrainField    Drone
 *   (struck bodies)     (iFFT texture)         (shimmer)   (held field)
 *          |                   |                    |           |
 *          +---------------- sum -------------------+-----------+
 *                              |
 *                    FDN reverb (depth) -> tone -> soft clip
 *
 * Nothing in this chain reads a sample, a stem, a loop or an impulse response.
 * The parameter set is continuous end-to-end, which is what lets the controller
 * move the sound by arbitrarily small amounts — the thing a select-and-gate
 * architecture cannot do.
 */

export interface ClfsOptions {
  seed?: number;
  /** Simultaneous struck bodies. Lower on constrained devices. */
  maxVoices?: number;
  /** Spectral bed FFT size. 1024 at 48 kHz; 512 for low-power mode. */
  fftSize?: number;
  /** Disable the reverb tail on very constrained devices. */
  reverb?: boolean;
}

export interface ClfsTelemetry {
  rms: number;
  peak: number;
  activeVoices: number;
  activeGrains: number;
  eventsPerSec: number;
  latentNorm: number;
  rootHz: number;
  currentRatio: number;
  tenneyHeight: number;
  decoder: string;
  blockMicros: number;
}

const CONTROL_BLOCK = 512;

/**
 * Averaging window for the displayed event rate. Long enough that a sparse
 * process (Sleep fires roughly every 15 s) still reads as a stable number
 * rather than flickering between 0 and a spike.
 */
const EVENT_RATE_TAU_SEC = 4;

export class ClfsCore {
  readonly sampleRate: number;
  private readonly rng: Rng;
  private readonly latent: LatentTrajectory;
  private readonly nfd = new NeuralFieldDecoder();
  private readonly walker: HarmonicWalker;
  private readonly modal: ModalBank;
  private readonly bed: SpectralBed;
  private readonly grains: GrainField;
  private readonly drone: Drone;
  private readonly fdn: Fdn | null;

  private readonly ctrlNorm = new Float32Array(10);
  private current: ControlVector;
  private target: ControlVector;

  private blockPos = CONTROL_BLOCK; // force an update on the first process call
  private nextEventSamples = 0;

  // Per-block cached synthesis parameters.
  private readonly partials = new Float32Array(16);
  private readonly stretch = new Float32Array(8);
  private bedLevel = 0;
  private grainRate = 0;
  private grainCentre = 900;
  private grainSpread = 0.5;
  private grainBright = 0.5;
  private droneLevel = 0;
  private strikeT60 = 3;
  private strikeAmp = 0.4;
  private stereoWidth = 0.6;
  private reverbSend = 0.3;

  private readonly toneL = new Biquad();
  private readonly toneR = new Biquad();
  private readonly hpL = new Biquad();
  private readonly hpR = new Biquad();
  private readonly dcL = new DcBlock();
  private readonly dcR = new DcBlock();
  private readonly masterGain: OnePole;
  private readonly revOut: [number, number] = [0, 0];

  private constraints: SynthesisConstraints = { ...DEFAULT_CONSTRAINTS };
  private readonly maskEnvelope = new Float32Array(BED_BANDS);

  private eventCount = 0;
  private elapsed = 0;
  private lastEventRate = 0;
  private rmsAcc = 0;
  private rmsN = 0;
  private peak = 0;
  private lastBlockMicros = 0;
  private droneUpdateCountdown = 0;
  private readonly droneFreqs = new Float32Array(8);
  private readonly droneGains = new Float32Array(8);

  constructor(sampleRate: number, opts: ClfsOptions = {}) {
    this.sampleRate = sampleRate;
    const seed = opts.seed ?? (Math.random() * 0xffffffff) >>> 0;
    this.rng = new Rng(seed);
    this.latent = new LatentTrajectory(this.rng);
    this.walker = new HarmonicWalker(this.rng);
    this.modal = new ModalBank(sampleRate, opts.maxVoices ?? 8);
    this.bed = new SpectralBed(sampleRate, opts.fftSize ?? 1024);
    this.grains = new GrainField(sampleRate);
    this.drone = new Drone(sampleRate, this.rng);
    this.fdn = opts.reverb === false ? null : new Fdn(sampleRate);

    this.current = clampControl(anchor("calm"));
    this.target = { ...this.current };
    this.masterGain = new OnePole(sampleRate, 0.35, 0);
    this.hpL.setHighpass(sampleRate, 26, 0.7);
    this.hpR.setHighpass(sampleRate, 26, 0.7);
    this.toneL.setLowpass(sampleRate, 12000, 0.6);
    this.toneR.setLowpass(sampleRate, 12000, 0.6);
  }

  /** Set the controller's destination. The engine slews toward it. */
  setTarget(v: ControlVector): void {
    this.target = clampControl(v);
  }

  /** Jump immediately — only legal at session start, never mid-session. */
  snapTo(v: ControlVector): void {
    this.current = clampControl(v);
    this.target = { ...this.current };
  }

  getCurrent(): ControlVector {
    return { ...this.current };
  }

  setStyle(embedding: Float32Array | null, weight = 1): void {
    this.latent.setStyle(embedding, weight);
  }

  /**
   * Install hard synthesis rules. Unlike the ControlVector these are not
   * slewed — a constraint is categorical, and a half-applied acoustic rule
   * is not a meaningful state. The audible parameters they govern still
   * move smoothly, because those go through the usual per-block smoothing.
   */
  setConstraints(c: Partial<SynthesisConstraints>): void {
    this.constraints = { ...DEFAULT_CONSTRAINTS, ...c };
    this.walker.setTokenSetLimit(this.constraints.maxTokenSet);
    // Confine the bed's own amplitude fluctuation below the syllabic band.
    this.bed.setModulationLimit(this.constraints.avoidSyllabicModulation ? 1.0 : 0);
    if (this.constraints.maskingSpectrum) maskingBedEnvelope(BED_BANDS, this.maskEnvelope);
  }

  getConstraints(): SynthesisConstraints {
    return { ...this.constraints };
  }

  /**
   * Level-independent measure of how well the current bed spectrum spends
   * its energy on masking speech, 0..1. Only meaningful in masking mode.
   */
  maskingEfficiency(): number {
    if (!this.constraints.maskingSpectrum) return 0;
    return spectrumEfficiency(MASKING_TARGET_DB);
  }

  loadNfdWeights(buf: ArrayBuffer): boolean {
    return this.nfd.loadWeights(buf);
  }

  /** 0..1 fade for graceful starts and endings. */
  setMasterTarget(g: number): void {
    this.masterTarget = Math.min(1, Math.max(0, g));
  }
  private masterTarget = 0;

  get faded(): boolean {
    return Math.abs(this.masterGain.value - this.masterTarget) < 1e-3;
  }

  telemetry(): ClfsTelemetry {
    const field = this.walker.field();
    const last = field[field.length - 1];
    const rms = this.rmsN > 0 ? Math.sqrt(this.rmsAcc / this.rmsN) : 0;
    const peak = this.peak;
    this.rmsAcc = 0;
    this.rmsN = 0;
    this.peak = 0;
    let ln = 0;
    for (let i = 0; i < this.latent.z.length; i++) ln += this.latent.z[i] * this.latent.z[i];
    return {
      rms,
      peak,
      activeVoices: this.modal.activeVoices,
      activeGrains: this.grains.activeGrains,
      eventsPerSec: this.lastEventRate,
      latentNorm: Math.sqrt(ln),
      rootHz: this.walker.root,
      currentRatio: last ? last.ratio : 1,
      tenneyHeight: last ? last.hd : 0,
      decoder: this.nfd.version,
      blockMicros: this.lastBlockMicros,
    };
  }

  /**
   * Render n samples into outL/outR (overwritten, not added).
   * n need not be a multiple of the control block.
   */
  process(outL: Float32Array, outR: Float32Array, n: number): void {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);

    let done = 0;
    while (done < n) {
      if (this.blockPos >= CONTROL_BLOCK) {
        this.controlUpdate(CONTROL_BLOCK / this.sampleRate);
        this.blockPos = 0;
      }
      const chunk = Math.min(n - done, CONTROL_BLOCK - this.blockPos);
      this.renderChunk(outL, outR, done, chunk);
      this.blockPos += chunk;
      done += chunk;
    }

    // Reverb + master chain, sample-accurate.
    const send = this.reverbSend;
    const g = this.masterGain;
    for (let i = 0; i < n; i++) {
      let l = outL[i];
      let r = outR[i];
      if (this.fdn) {
        this.fdn.process((l + r) * 0.5 * send, this.revOut);
        l += this.revOut[0];
        r += this.revOut[1];
      }
      l = this.dcL.process(this.hpL.process(l));
      r = this.dcR.process(this.hpR.process(r));
      l = this.toneL.process(l);
      r = this.toneR.process(r);
      const m = g.process(this.masterTarget);
      l = softClip(l * m * 0.85);
      r = softClip(r * m * 0.85);
      outL[i] = l;
      outR[i] = r;
      const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      if (a > this.peak) this.peak = a;
      this.rmsAcc += l * l + r * r;
      this.rmsN += 2;
    }

    this.elapsed += n / this.sampleRate;
    if (typeof performance !== "undefined") this.lastBlockMicros = (performance.now() - t0) * 1000;
  }

  // ---------------------------------------------------------------- control

  private controlUpdate(dt: number): void {
    this.current = slewToward(this.current, this.target, dt);
    const c = this.current;
    normaliseControl(c, this.ctrlNorm);

    const z = this.latent.step(this.ctrlNorm, c.motion, dt);
    const o = this.nfd.evaluate(z, this.ctrlNorm);

    const [pg0] = NFD_LAYOUT.partialGain;
    for (let i = 0; i < 16; i++) this.partials[i] = o[pg0 + i];
    const [ps0] = NFD_LAYOUT.partialStretch;
    for (let i = 0; i < 8; i++) this.stretch[i] = o[ps0 + i];

    if (this.constraints.maskingSpectrum) {
      // Screen mode: the bed's spectrum is an acoustic requirement, not an
      // aesthetic choice, so it overrides the decoder entirely rather than
      // blending with it. Blending would drift the curve away from the shape
      // that actually does the masking.
      this.bed.setEnvelope(this.maskEnvelope, 0);
    } else {
      this.bed.setEnvelope(o, NFD_LAYOUT.bandGain[0]);
    }

    // Perceptual mapping from decoder outputs + control to layer levels.
    this.bedLevel = 0.34 * c.air * (0.35 + 0.85 * o[NFD_LAYOUT.shimmer]);
    this.grainRate = (0.15 + 7.5 * o[NFD_LAYOUT.grainRate] * c.density) * (0.3 + 0.9 * c.arousal);

    this.grainCentre = 240 * Math.pow(2, 1 + 3.2 * c.brightness);
    this.grainSpread = 0.25 + 0.9 * o[NFD_LAYOUT.grainSpread];
    this.grainBright = 0.2 + 1.4 * c.brightness * o[NFD_LAYOUT.shimmer];
    this.droneLevel = 0.3 * (0.35 + 0.75 * o[NFD_LAYOUT.subLevel]) * (1 - 0.45 * c.arousal);
    this.strikeT60 = 0.55 + 7.5 * o[NFD_LAYOUT.ringTime] * (0.4 + 0.9 * c.depth);
    this.strikeAmp = 0.1 + 0.42 * o[NFD_LAYOUT.transient] * (0.35 + 0.8 * c.arousal);
    this.stereoWidth = 0.25 + 0.7 * c.motion;
    this.reverbSend = 0.08 + 0.55 * c.depth;

    // Constraints are applied last, after every derived parameter, so they
    // genuinely bound the result rather than being silently overwritten by a
    // later assignment.
    this.applyConstraints();

    if (this.fdn) {
      this.fdn.setDecay(0.9 + 8.5 * c.depth);
      this.fdn.setDamping(1400 + 7000 * c.brightness);
    }
    this.toneL.setLowpass(this.sampleRate, 2600 + 12000 * c.brightness, 0.6);
    this.toneR.setLowpass(this.sampleRate, 2600 + 12000 * c.brightness, 0.6);

    this.walker.driftRoot(dt);

    // Refresh the sustaining field every ~6 s.
    this.droneUpdateCountdown -= dt;
    if (this.droneUpdateCountdown <= 0) {
      this.droneUpdateCountdown = 4.5 + this.rng.next() * 4;
      this.refreshDroneField();
    }

    // Event-rate estimate.
    //
    // The previous version used a fixed alpha of 0.1 per control block, which
    // is a ~0.1 s time constant. Events arrive every 0.4 s at a typical rate,
    // so the estimator was a train of decaying spikes rather than a rate: its
    // long-run average was right but any individual reading was mostly wrong
    // and usually far too low. Move mode made this obvious, since there the
    // event rate IS the feature.
    //
    // A time-constant-based coefficient fixes it, and being derived from dt
    // means the estimate no longer silently depends on block size.
    const instantaneous = this.eventCount / Math.max(dt, 1e-6);
    const alpha = 1 - Math.exp(-dt / EVENT_RATE_TAU_SEC);
    this.lastEventRate += alpha * (instantaneous - this.lastEventRate);
    this.eventCount = 0;
  }

  /**
   * Enforce the categorical acoustic rules over every derived parameter.
   * Runs at the end of each control block; see `setConstraints`.
   */
  private applyConstraints(): void {
    const k = this.constraints;

    if (k.avoidSyllabicModulation) {
      // Grain arrivals are discrete amplitude events, so their rate lands
      // directly in the modulation spectrum. Push them *below* the syllabic
      // band rather than above: above 8 Hz would also clear the band, but
      // fuses into a continuous buzz, which is not what a reading mode wants.
      this.grainRate = Math.min(this.grainRate, 0.3);

      // Softer strikes: a sharp transient is a modulation impulse with
      // energy across the whole band, including the part being protected.
      this.strikeAmp = Math.min(this.strikeAmp, 0.12);

      // Deliberately do NOT extend ring time here, which was the obvious
      // move and the wrong one. Longer tails mean more simultaneously
      // sounding strikes, and each strike's partials are micro-detuned by
      // up to ~4 cents, so overlapping copies beat at roughly f * 0.0023 —
      // about 4.6 Hz at 2 kHz, dead centre of the syllabic band. Measured:
      // extending T60 to 6 s *raised* syllabic modulation depth from 0.20 to
      // 0.26. Capping the tail instead limits how many copies can overlap.
      this.strikeT60 = Math.min(this.strikeT60, 3.2);

      // Same mechanism in the sustaining layer: the drone's 1.5-7.5 cent
      // detune is warmth in every other mode and a syllabic-rate beat here.
      this.drone.setDetuneScale(0.22);
      this.droneLevel = Math.min(this.droneLevel, 0.12);

      // Let the (modulation-limited) bed carry the mode. It is the only
      // layer with no intrinsic amplitude fluctuation once smoothed.
      this.bedLevel = Math.max(this.bedLevel, 0.3);
    } else {
      this.drone.setDetuneScale(1);
    }

    if (k.maskingSpectrum) {
      // A masker should be spectrally dense and temporally featureless.
      // Anything eventful recruits the attention it is meant to protect.
      this.grainRate = Math.min(this.grainRate, 0.25);
      this.strikeAmp = Math.min(this.strikeAmp, 0.05);
      this.droneLevel = Math.min(this.droneLevel, 0.08);
      // The bed carries the mode, and reverb would smear the shaped spectrum.
      this.bedLevel = Math.max(this.bedLevel, 0.42);
      this.reverbSend = Math.min(this.reverbSend, 0.1);
    }
  }

  private refreshDroneField(): void {
    const field = this.walker.field();
    const c = this.current;
    this.droneFreqs.fill(0);
    this.droneGains.fill(0);
    // Root and its octave always present; then the most recent lattice points.
    this.droneFreqs[0] = this.walker.root * 0.5;
    this.droneGains[0] = 0.55 * (0.4 + 0.9 * (1 - c.brightness));
    this.droneFreqs[1] = this.walker.root;
    this.droneGains[1] = 0.45;
    let slot = 2;
    for (let i = field.length - 1; i >= 0 && slot < 8; i--) {
      const p = field[i];
      if (p.ratio === 1) continue;
      const register = p.ratio > 1.5 ? 0 : 1;
      this.droneFreqs[slot] = this.walker.frequency(p, register);
      // Recency weighting: the newest additions are loudest.
      this.droneGains[slot] = 0.34 * Math.pow(0.72, field.length - 1 - i) * (0.3 + 0.9 * c.complexity);
      slot++;
    }
    this.drone.setField(this.droneFreqs, this.droneGains);
  }

  // ------------------------------------------------------------- rendering

  private renderChunk(outL: Float32Array, outR: Float32Array, offset: number, n: number): void {
    const c = this.current;

    // Struck-body events: gamma renewal process. Shape k rises with
    // complexity, so onsets go continuously from Poisson (no perceivable
    // pulse) to near-periodic without ever switching mode.
    this.nextEventSamples -= n;
    while (this.nextEventSamples <= 0) {
      this.fireEvent();

      let rate = (c.tempo / 60) * (0.22 + 1.9 * c.density);
      let k = 1 + c.complexity * c.complexity * 12;

      if (this.constraints.cadenceSpm > 0) {
        // Move mode: one onset per step, and force the renewal process to
        // near-deterministic so the beat is actually trackable. Auditory-motor
        // entrainment needs a periodic beat — a Poisson stream at the right
        // mean rate does not entrain anything.
        rate = this.constraints.cadenceSpm / 60;
        k = Math.max(k, 24);
      } else if (this.constraints.avoidSyllabicModulation) {
        // Keep onsets clear of the speech syllabic band. This bounds the
        // *mean* rate; the gamma spread could still place occasional
        // intervals inside the band, so k is also raised to tighten the
        // distribution around the sub-syllabic mean.
        rate = Math.min(rate, SUB_SYLLABIC_MAX_RATE_HZ);
        k = Math.max(k, 3);
      }

      const meanSamples = this.sampleRate / Math.max(0.02, rate);
      const interval = gammaSample(this.rng, k) * (meanSamples / k);
      this.nextEventSamples += Math.max(0.01 * this.sampleRate, interval);
    }

    this.modal.render(outL, outR, offset, n);
    this.drone.render(outL, outR, offset, n, this.droneLevel);
    this.grains.render(
      outL,
      outR,
      offset,
      n,
      this.grainRate,
      this.grainCentre,
      this.grainSpread,
      this.grainBright,
      this.stereoWidth,
      this.rng,
    );
    this.bed.render(outL, outR, offset, n, this.bedLevel, this.stereoWidth, this.rng);
  }

  private fireEvent(): void {
    const c = this.current;
    const point = this.walker.step(c.tension, c.complexity);
    // Register distribution: brightness pulls the tessitura up.
    const rWeights = [
      0.9 * (1 - c.brightness) + 0.1,
      0.8,
      0.45 + 0.7 * c.brightness,
      0.15 + 0.85 * c.brightness,
      0.05 + 0.5 * c.brightness * c.arousal,
    ];
    const register = this.rng.pick(rWeights) + 1;
    const f = this.walker.frequency(point, register);
    if (f > this.sampleRate * 0.4) return;

    // Amplitude is heavy-tailed: mostly quiet events with occasional accents.
    // A uniform amplitude distribution sounds mechanical.
    const u = this.rng.next();
    const amp = this.strikeAmp * (0.25 + 1.5 * u * u * u);
    const pan = Math.max(-1, Math.min(1, this.rng.normal() * this.stereoWidth * 0.7));
    this.modal.strike(f, amp, this.strikeT60, this.partials, this.stretch, pan, this.rng);
    this.eventCount++;
  }
}

/**
 * Marsaglia-Tsang gamma sampler, shape k >= 0.1, scale 1.
 * Used for the event renewal process; see renderChunk.
 */
function gammaSample(rng: Rng, k: number): number {
  if (k < 1) {
    const u = Math.max(1e-9, rng.next());
    return gammaSample(rng, k + 1) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 64; i++) {
    let x = 0;
    let v = 0;
    do {
      x = rng.normal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.next();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(1e-12, u)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d;
}

export { BED_BANDS };
