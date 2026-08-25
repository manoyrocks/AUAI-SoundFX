/**
 * Transposed-direct-form-II biquads.
 *
 * TDF-II over DF-I because the modal voice runs resonators at Q up to ~4000
 * (multi-second ring times) where DF-I accumulates noticeable coefficient
 * quantisation noise, and TDF-II needs only two state words.
 */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  private z1 = 0;
  private z2 = 0;

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  /** Constant-peak-gain bandpass — the modal resonator. */
  setBandpass(sr: number, freq: number, q: number): void {
    const w = (2 * Math.PI * Math.min(freq, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * Math.max(q, 1e-4));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  setLowpass(sr: number, freq: number, q = Math.SQRT1_2): void {
    const w = (2 * Math.PI * Math.min(freq, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cw) / 2 / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  setHighpass(sr: number, freq: number, q = Math.SQRT1_2): void {
    const w = (2 * Math.PI * Math.min(Math.max(freq, 1), sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cw) / 2 / a0;
    this.b1 = -(1 + cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  setPeaking(sr: number, freq: number, q: number, gainDb: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * Math.min(freq, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * cw) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha / A) / a0;
  }
}

/** One-pole smoother; tau in seconds. Every control-rate parameter goes through one. */
export class OnePole {
  private y = 0;
  private a = 0;

  constructor(sr: number, tauSeconds: number, initial = 0) {
    this.setTau(sr, tauSeconds);
    this.y = initial;
  }

  setTau(sr: number, tauSeconds: number): void {
    this.a = Math.exp(-1 / Math.max(1, tauSeconds * sr));
  }

  process(x: number): number {
    this.y = x + this.a * (this.y - x);
    return this.y;
  }

  get value(): number {
    return this.y;
  }

  set value(v: number) {
    this.y = v;
  }
}

/** DC blocker — required downstream of the modal bank and the FDN. */
export class DcBlock {
  private x1 = 0;
  private y1 = 0;

  constructor(private readonly r = 0.9995) {}

  process(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/** Soft saturator with unity slope at zero — the only limiter in the chain. */
export function softClip(x: number): number {
  if (x > 1.5) return 1;
  if (x < -1.5) return -1;
  return x - (4 / 27) * x * x * x;
}
