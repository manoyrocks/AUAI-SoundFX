import { OnePole } from "../dsp/biquad.js";
import { Rng } from "../dsp/rng.js";

/**
 * Sustaining drone / sub layer
 * ============================
 *
 * Holds the harmonic field the walker has established, plus a sub octave. Each
 * of the 8 partials is a pair of oscillators detuned by a few cents, so the
 * layer beats slowly against itself. Beat rates are set from irrational
 * multiples of a base so they never phase-align — the low end never "pulses" on
 * a fixed period.
 *
 * Detune is bounded to under 8 cents. Beyond roughly a tenth of a critical band
 * the beating stops reading as warmth and starts reading as roughness, which is
 * the opposite of what a wind-down session needs.
 */

const PARTIALS = 8;

export class Drone {
  private readonly phase = new Float32Array(PARTIALS * 2);
  private readonly inc = new Float32Array(PARTIALS * 2);
  private readonly gain: OnePole[] = [];
  private readonly target = new Float32Array(PARTIALS);
  private readonly panL = new Float32Array(PARTIALS);
  private readonly panR = new Float32Array(PARTIALS);
  private readonly detune = new Float32Array(PARTIALS);

  constructor(
    private readonly sr: number,
    rng: Rng,
  ) {
    for (let i = 0; i < PARTIALS; i++) {
      this.gain.push(new OnePole(sr, 3.5, 0));
      // Irrational detune spread: no two partials beat at a rational ratio.
      this.detune[i] = 1.5 + 6.0 * ((i * 0.6180339887) % 1);
      const p = ((i / (PARTIALS - 1)) * 2 - 1) * 0.7;
      const theta = ((p + 1) * Math.PI) / 4;
      this.panL[i] = Math.cos(theta);
      this.panR[i] = Math.sin(theta);
      this.phase[i * 2] = rng.next();
      this.phase[i * 2 + 1] = rng.next();
    }
  }

  /**
   * Scale the detune spread, 0..1 (1 = the designed 1.5-7.5 cent spread).
   *
   * Beat frequency between the two oscillators of a partial is roughly
   * f * cents * 0.0011, so a 440 Hz partial detuned 7 cents beats at ~3.4 Hz
   * — inside the speech syllabic band. Pleasant warmth in most modes;
   * exactly the wrong thing in Read, which shrinks the spread so every beat
   * falls below 1 Hz.
   */
  setDetuneScale(scale: number): void {
    this.detuneScale = Math.min(1, Math.max(0, scale));
  }
  private detuneScale = 1;

  /**
   * Set the sounding harmonic field.
   * @param freqs up to 8 absolute frequencies in Hz (0 = silent slot)
   * @param gains matching linear gains
   */
  setField(freqs: ArrayLike<number>, gains: ArrayLike<number>): void {
    for (let i = 0; i < PARTIALS; i++) {
      const f = i < freqs.length ? freqs[i] : 0;
      const g = i < gains.length ? gains[i] : 0;
      if (f <= 0 || f >= this.sr * 0.45) {
        this.target[i] = 0;
        continue;
      }
      this.target[i] = g;
      const cents = this.detune[i] * this.detuneScale;
      this.inc[i * 2] = (f * Math.pow(2, -cents / 2400)) / this.sr;
      this.inc[i * 2 + 1] = (f * Math.pow(2, cents / 2400)) / this.sr;
    }
  }

  render(outL: Float32Array, outR: Float32Array, offset: number, n: number, level: number): void {
    for (let i = 0; i < PARTIALS; i++) {
      const g = this.gain[i];
      // Gain slews at control rate; the per-sample loop reads a frozen value,
      // which is fine because tau (3.5 s) is far longer than one quantum.
      const target = this.target[i];
      const gv = g.process(target) * level;
      if (gv < 1e-5) continue;
      let p0 = this.phase[i * 2];
      let p1 = this.phase[i * 2 + 1];
      const i0 = this.inc[i * 2];
      const i1 = this.inc[i * 2 + 1];
      const gl = this.panL[i];
      const gr = this.panR[i];
      for (let k = 0; k < n; k++) {
        const y = (Math.sin(2 * Math.PI * p0) + Math.sin(2 * Math.PI * p1)) * 0.5 * gv;
        outL[offset + k] += y * gl;
        outR[offset + k] += y * gr;
        p0 += i0;
        if (p0 >= 1) p0 -= 1;
        p1 += i1;
        if (p1 >= 1) p1 -= 1;
      }
      this.phase[i * 2] = p0;
      this.phase[i * 2 + 1] = p1;
    }
  }
}
