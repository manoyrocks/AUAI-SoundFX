import { Rng } from "../dsp/rng.js";

/**
 * Modal resonator bank
 * ====================
 *
 * Every pitched sound in SoundFX is a physically-modelled resonant body: a set
 * of damped modes excited by a shaped burst. No recorded instrument, no sampled
 * attack, no stem.
 *
 * Each mode is a complex rotation with the per-sample damping folded into the
 * rotation radius:
 *
 *     r  = exp(-6.91 / (T60 * sr))        (T60 = -60 dB time for that mode)
 *     re' = re*c - im*s ,  im' = re*s + im*c ,  c = r cos(w), s = r sin(w)
 *
 * 4 multiplies + 2 adds per mode per sample, unconditionally branch-free, state
 * held in flat typed arrays so the whole bank stays in L1. Exciting a mode is
 * just adding energy to its real part, which means an "attack" costs nothing
 * and can happen on any sample without a scheduler.
 *
 * Mode frequencies are stretched by an inharmonicity coefficient from the NFD:
 *
 *     f_n = f0 * n * sqrt(1 + B n^2)
 *
 * the same relation that governs real stiff strings and bars. B near 0 gives
 * string/voice-like tone; larger B gives bell and metal-bar spectra. Because B
 * is a continuous NFD output, the material of the instrument is itself a
 * dimension the controller can move through.
 */

export const MODES_PER_VOICE = 12;

export class ModalBank {
  private readonly maxVoices: number;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly cosC: Float32Array;
  private readonly sinC: Float32Array;
  private readonly gain: Float32Array;
  private readonly voicePanL: Float32Array;
  private readonly voicePanR: Float32Array;
  private readonly voiceAge: Float32Array;
  private readonly voiceActive: Uint8Array;
  private nextVoice = 0;

  constructor(
    private readonly sr: number,
    maxVoices = 8,
  ) {
    this.maxVoices = maxVoices;
    const n = maxVoices * MODES_PER_VOICE;
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
    this.cosC = new Float32Array(n);
    this.sinC = new Float32Array(n);
    this.gain = new Float32Array(n);
    this.voicePanL = new Float32Array(maxVoices);
    this.voicePanR = new Float32Array(maxVoices);
    this.voiceAge = new Float32Array(maxVoices);
    this.voiceActive = new Uint8Array(maxVoices);
  }

  get polyphony(): number {
    return this.maxVoices;
  }

  get activeVoices(): number {
    let n = 0;
    for (let i = 0; i < this.maxVoices; i++) n += this.voiceActive[i];
    return n;
  }

  /**
   * Strike a body.
   *
   * @param f0        fundamental in Hz
   * @param amp       overall strike energy 0..1
   * @param t60       decay time of the fundamental, seconds
   * @param partials  16 mode gains from the NFD
   * @param stretch   8 inharmonicity coefficients from the NFD (per mode pair)
   * @param pan       -1..1
   * @param rng       for per-strike mode detune, so no two strikes are identical
   */
  strike(
    f0: number,
    amp: number,
    t60: number,
    partials: Float32Array,
    stretch: Float32Array,
    pan: number,
    rng: Rng,
  ): void {
    // Voice stealing: prefer a free voice, else the oldest.
    let v = -1;
    for (let i = 0; i < this.maxVoices; i++) {
      const idx = (this.nextVoice + i) % this.maxVoices;
      if (!this.voiceActive[idx]) {
        v = idx;
        break;
      }
    }
    if (v < 0) {
      let oldest = 0;
      for (let i = 1; i < this.maxVoices; i++) if (this.voiceAge[i] > this.voiceAge[oldest]) oldest = i;
      v = oldest;
      // Do not hard-reset: let the stolen voice's energy fold into the new one.
      const base = v * MODES_PER_VOICE;
      for (let m = 0; m < MODES_PER_VOICE; m++) {
        this.re[base + m] *= 0.3;
        this.im[base + m] *= 0.3;
      }
    }
    this.nextVoice = (v + 1) % this.maxVoices;
    this.voiceActive[v] = 1;
    this.voiceAge[v] = 0;

    const p = Math.min(1, Math.max(-1, pan));
    const theta = ((p + 1) * Math.PI) / 4;
    this.voicePanL[v] = Math.cos(theta);
    this.voicePanR[v] = Math.sin(theta);

    const base = v * MODES_PER_VOICE;
    const nyq = this.sr * 0.47;
    for (let m = 0; m < MODES_PER_VOICE; m++) {
      const n = m + 1;
      const B = Math.abs(stretch[Math.min(7, m >> 1)]) * 0.004;
      let f = f0 * n * Math.sqrt(1 + B * n * n);
      // Per-strike micro-detune (+/- 4 cents): identical strikes never occur.
      f *= 1 + rng.normal() * 0.0023;
      if (f >= nyq || f <= 0) {
        this.gain[base + m] = 0;
        this.cosC[base + m] = 0;
        this.sinC[base + m] = 0;
        continue;
      }
      // Higher modes decay faster — as they do in every real resonator.
      const modeT60 = Math.max(0.02, t60 / Math.pow(n, 0.62));
      const r = Math.exp(-6.907755 / (modeT60 * this.sr));
      const w = (2 * Math.PI * f) / this.sr;
      this.cosC[base + m] = r * Math.cos(w);
      this.sinC[base + m] = r * Math.sin(w);

      const g = partials[m] ?? 0;
      this.gain[base + m] = g;
      // Excite: energy into the real part, randomised phase per mode.
      const phase = rng.next() * 2 * Math.PI;
      const e = amp * g * (0.6 + 0.7 * rng.next());
      this.re[base + m] += e * Math.cos(phase);
      this.im[base + m] += e * Math.sin(phase);
    }
  }

  /** Render `n` samples additively into outL/outR starting at `offset`. */
  render(outL: Float32Array, outR: Float32Array, offset: number, n: number): void {
    const dt = n / this.sr;
    for (let v = 0; v < this.maxVoices; v++) {
      if (!this.voiceActive[v]) continue;
      this.voiceAge[v] += dt;
      const base = v * MODES_PER_VOICE;
      const gl = this.voicePanL[v];
      const gr = this.voicePanR[v];
      let energy = 0;

      for (let m = 0; m < MODES_PER_VOICE; m++) {
        const i = base + m;
        const c = this.cosC[i];
        const s = this.sinC[i];
        if (c === 0 && s === 0) continue;
        let re = this.re[i];
        let im = this.im[i];
        const g = this.gain[i];
        for (let k = 0; k < n; k++) {
          const nre = re * c - im * s;
          im = re * s + im * c;
          re = nre;
          const y = im * g;
          outL[offset + k] += y * gl;
          outR[offset + k] += y * gr;
        }
        this.re[i] = re;
        this.im[i] = im;
        energy += re * re + im * im;
      }

      // Retire the voice once it is inaudible (-96 dBFS), freeing it for reuse.
      if (energy < 1e-10) {
        this.voiceActive[v] = 0;
        for (let m = 0; m < MODES_PER_VOICE; m++) {
          this.re[base + m] = 0;
          this.im[base + m] = 0;
        }
      }
    }
  }
}
