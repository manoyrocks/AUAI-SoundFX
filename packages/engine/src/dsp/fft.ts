/**
 * In-place radix-2 FFT with precomputed twiddles, allocation-free after
 * construction. Used by the spectral-bed voice (overlap-add IFFT resynthesis)
 * and by the ambient-noise analyser.
 *
 * Real-time constraint: no allocation, no closures, no trig in the hot loop.
 */
export class Fft {
  readonly n: number;
  private readonly levels: number;
  private readonly cosT: Float32Array;
  private readonly sinT: Float32Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    if ((n & (n - 1)) !== 0) throw new Error("Fft size must be a power of two");
    this.n = n;
    this.levels = Math.round(Math.log2(n));
    this.cosT = new Float32Array(n / 2);
    this.sinT = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cosT[i] = Math.cos((2 * Math.PI * i) / n);
      this.sinT[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.rev[i] = reverseBits(i, this.levels);
  }

  /** Forward transform, in place on (re, im). */
  forward(re: Float32Array, im: Float32Array): void {
    this.transform(re, im);
  }

  /**
   * Inverse transform, in place, scaled by 1/n.
   * Swapping the real and imaginary arrays turns the forward butterfly into the
   * conjugate transform, so we only need one kernel.
   */
  inverse(re: Float32Array, im: Float32Array): void {
    this.transform(im, re);
    const inv = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }

  private transform(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = this.cosT[k];
          const s = this.sinT[k];
          const tre = re[l] * c + im[l] * s;
          const tim = -re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}

function reverseBits(x: number, bits: number): number {
  let y = 0;
  for (let i = 0; i < bits; i++) {
    y = (y << 1) | (x & 1);
    x >>>= 1;
  }
  return y >>> 0;
}

/** Periodic Hann window — correct for overlap-add analysis/synthesis. */
export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
