import { Biquad, DcBlock } from "./biquad.js";

/**
 * Feedback Delay Network reverb — 8 delay lines, Householder feedback matrix,
 * per-line damping, tone-controllable tail.
 *
 * Deliberately *algorithmic*, not convolution: SoundFX ships zero recorded
 * audio assets, impulse responses included. That keeps the download small, lets
 * the room size become a continuous control dimension (a convolution reverb
 * cannot morph its space without artefacts), and keeps the generation method
 * free of any sampled material.
 */
export class Fdn {
  private readonly lines: Float32Array[] = [];
  private readonly lengths: number[] = [];
  private readonly writePos: number[] = [];
  private readonly damp: Biquad[] = [];
  private readonly lowCut: Biquad[] = [];
  private readonly tmp = new Float32Array(8);
  private readonly dc = new DcBlock();
  private feedback = 0.86;

  /** Mutually prime-ish delay lengths in ms, spread over a plausible room. */
  private static readonly BASE_MS = [23.17, 31.13, 41.29, 53.71, 67.03, 79.87, 94.11, 109.3];

  constructor(
    private readonly sr: number,
    sizeScale = 1.0,
  ) {
    for (let i = 0; i < 8; i++) {
      const ms = Fdn.BASE_MS[i] * sizeScale;
      const len = Math.max(64, Math.round((ms / 1000) * sr));
      this.lengths.push(len);
      this.lines.push(new Float32Array(len));
      this.writePos.push(0);
      const d = new Biquad();
      d.setLowpass(sr, 4200, 0.7);
      this.damp.push(d);
      const h = new Biquad();
      h.setHighpass(sr, 90, 0.7);
      this.lowCut.push(h);
    }
  }

  /** rt60 in seconds -> per-line feedback gain. */
  setDecay(rt60: number): void {
    const meanDelay = 0.06; // seconds, mean of BASE_MS
    this.feedback = Math.min(0.995, Math.pow(10, (-3 * meanDelay) / Math.max(0.15, rt60)));
  }

  /** Damping frequency: lower = darker, more absorbent room. */
  setDamping(hz: number): void {
    for (const d of this.damp) d.setLowpass(this.sr, Math.min(Math.max(hz, 400), this.sr * 0.45), 0.7);
  }

  /**
   * Process one stereo sample pair. Input is mono-summed into the network;
   * output taps different line subsets for L and R to get natural decorrelation.
   */
  process(input: number, out: [number, number]): void {
    const t = this.tmp;
    for (let i = 0; i < 8; i++) {
      const line = this.lines[i];
      const len = this.lengths[i];
      const readPos = this.writePos[i]; // write pointer doubles as the oldest sample
      t[i] = line[readPos];
    }

    // Householder mixing: y = t - (2/N) * sum(t). Orthogonal, lossless, one pass.
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += t[i];
    const c = (2 / 8) * sum;

    let l = 0;
    let r = 0;
    for (let i = 0; i < 8; i++) {
      const mixed = t[i] - c;
      const damped = this.damp[i].process(this.lowCut[i].process(mixed));
      const w = input + this.feedback * damped;
      const line = this.lines[i];
      line[this.writePos[i]] = w;
      this.writePos[i] = (this.writePos[i] + 1) % this.lengths[i];
      if ((i & 1) === 0) l += t[i];
      else r += t[i];
    }

    const g = 0.35;
    out[0] = this.dc.process(l * g);
    out[1] = r * g;
  }
}
