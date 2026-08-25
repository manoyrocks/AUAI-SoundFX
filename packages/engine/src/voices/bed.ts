import { Fft, hann } from "../dsp/fft.js";
import { Rng } from "../dsp/rng.js";

/**
 * Spectral bed — inverse-FFT texture synthesis
 * ============================================
 *
 * The continuous "air" layer under every session. It is synthesised directly in
 * the frequency domain: each analysis hop we write a magnitude envelope (14
 * NFD-controlled bands, interpolated across bins on a Bark-like warp) with
 * *fully randomised phase*, inverse-FFT it, and overlap-add with a Hann window
 * at 50% hop.
 *
 * Consequences that matter:
 *  - There is no source recording, so there is nothing to loop. Two frames
 *    never contain the same phase spectrum; recurrence probability is
 *    effectively zero over any session length. This is the technical basis of
 *    the "no audible loops in an 8-hour sleep session" bar.
 *  - The spectral envelope is a *continuous* function of the control vector, so
 *    the bed can morph from ocean-ish to rain-ish to pure pink air without a
 *    crossfade between two different recordings.
 *  - Randomised phase with a 50%-hop Hann pair gives constant-overlap-add power,
 *    so there is no amplitude ripple at the frame rate.
 *
 * Cost: one 1024-point real-ish FFT per 512 samples ~ 94 Hz at 48 kHz, about
 * 0.5% of a core.
 */

export const BED_BANDS = 14;

export class SpectralBed {
  private readonly fftSize: number;
  private readonly hop: number;
  private readonly fft: Fft;
  private readonly win: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly olaL: Float32Array;
  private readonly olaR: Float32Array;
  private readonly reR: Float32Array;
  private readonly imR: Float32Array;
  private olaPos = 0;
  private hopCountdown = 0;
  /** Bin -> band index and interpolation weight, precomputed. */
  private readonly binBand: Int32Array;
  private readonly binFrac: Float32Array;
  private readonly bandGain = new Float32Array(BED_BANDS);
  private readonly bandTarget = new Float32Array(BED_BANDS);

  /**
   * Per-bin magnitude memory, used only when modulation smoothing is on.
   *
   * By default each frame draws independent Rayleigh magnitudes, which is
   * what gives natural broadband texture — but independence across frames
   * means the bed's amplitude envelope contains energy at *every* modulation
   * frequency, including the 2-8 Hz syllabic band. Smoothing the magnitudes
   * across frames confines that fluctuation to well below 1 Hz.
   */
  private readonly binMag: Float32Array;
  private smoothing = 0;

  constructor(
    private readonly sr: number,
    fftSize = 1024,
  ) {
    this.fftSize = fftSize;
    this.hop = fftSize / 2;
    this.fft = new Fft(fftSize);
    this.win = hann(fftSize);
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    this.reR = new Float32Array(fftSize);
    this.imR = new Float32Array(fftSize);
    this.olaL = new Float32Array(fftSize * 2);
    this.olaR = new Float32Array(fftSize * 2);
    this.binMag = new Float32Array(fftSize / 2);

    const nBins = fftSize / 2;
    this.binBand = new Int32Array(nBins);
    this.binFrac = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) {
      const f = (k * sr) / fftSize;
      // Bark-like warp so bands are perceptually, not linearly, spaced.
      const bark = 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan(Math.pow(f / 7500, 2));
      const pos = Math.min(BED_BANDS - 1.001, Math.max(0, (bark / 24) * (BED_BANDS - 1)));
      this.binBand[k] = Math.floor(pos);
      this.binFrac[k] = pos - this.binBand[k];
    }
  }

  /** Set the target 14-band envelope (NFD output slice). Smoothed internally. */
  setEnvelope(bands: Float32Array, offset: number): void {
    for (let i = 0; i < BED_BANDS; i++) this.bandTarget[i] = bands[offset + i];
  }

  /**
   * Constrain how fast the bed's own amplitude may fluctuate.
   *
   * @param maxModulationHz 0 disables smoothing (full natural texture).
   *   Any positive value sets a one-pole corner on the per-bin magnitudes,
   *   so modulation energy above it is attenuated. Read mode passes ~1 Hz to
   *   clear the speech syllabic band entirely.
   */
  setModulationLimit(maxModulationHz: number): void {
    if (maxModulationHz <= 0) {
      this.smoothing = 0;
      return;
    }
    const frameRate = this.sr / this.hop;
    // One-pole coefficient for the requested corner frequency.
    this.smoothing = Math.exp((-2 * Math.PI * maxModulationHz) / frameRate);
  }

  /**
   * Render n samples additively. `level` is the overall bed gain,
   * `width` 0..1 controls stereo decorrelation (independent phase per channel).
   */
  render(outL: Float32Array, outR: Float32Array, offset: number, n: number, level: number, width: number, rng: Rng): void {
    let produced = 0;
    while (produced < n) {
      if (this.hopCountdown === 0) {
        this.synthesiseFrame(width, rng);
        this.hopCountdown = this.hop;
      }
      const take = Math.min(n - produced, this.hopCountdown);
      for (let i = 0; i < take; i++) {
        const p = (this.olaPos + i) % this.olaL.length;
        outL[offset + produced + i] += this.olaL[p] * level;
        outR[offset + produced + i] += this.olaR[p] * level;
      }
      // Consumed samples are cleared so the ring buffer can be re-accumulated.
      for (let i = 0; i < take; i++) {
        const p = (this.olaPos + i) % this.olaL.length;
        this.olaL[p] = 0;
        this.olaR[p] = 0;
      }
      this.olaPos = (this.olaPos + take) % this.olaL.length;
      this.hopCountdown -= take;
      produced += take;
    }
  }

  private synthesiseFrame(width: number, rng: Rng): void {
    // Smooth band gains toward target: ~200 ms time constant at the hop rate.
    const a = 0.82;
    for (let i = 0; i < BED_BANDS; i++) this.bandGain[i] = this.bandTarget[i] + a * (this.bandGain[i] - this.bandTarget[i]);

    const n = this.fftSize;
    const nBins = n / 2;
    this.re.fill(0);
    this.im.fill(0);
    this.reR.fill(0);
    this.imR.fill(0);

    // Bin 0 and Nyquist stay at zero: no DC, no Nyquist ringing.
    for (let k = 1; k < nBins; k++) {
      const b = this.binBand[k];
      const f = this.binFrac[k];
      const mag = this.bandGain[b] * (1 - f) + this.bandGain[Math.min(BED_BANDS - 1, b + 1)] * f;
      if (mag <= 1e-5) continue;

      // Rayleigh-distributed magnitude around the envelope reproduces the
      // statistics of natural broadband texture; a flat magnitude sounds
      // synthetic and "buzzy".
      let scale = mag * Math.sqrt(-2 * Math.log(1 - rng.next() * 0.999999)) * 0.7071;

      // Optional modulation limiting: lowpass the magnitude across frames so
      // the bed cannot fluctuate at syllabic rates. Phase stays fully random
      // either way — it is magnitude, not phase, that the ear hears as
      // amplitude modulation.
      if (this.smoothing > 0) {
        scale = scale + this.smoothing * (this.binMag[k] - scale);
        this.binMag[k] = scale;
      }

      const phL = rng.next() * 2 * Math.PI;
      // Correlated phase at width=0 (mono), independent at width=1.
      const phR = width > 0.999 ? rng.next() * 2 * Math.PI : phL + rng.normal() * width * Math.PI;

      const reL = scale * Math.cos(phL);
      const imL = scale * Math.sin(phL);
      const reRv = scale * Math.cos(phR);
      const imRv = scale * Math.sin(phR);

      this.re[k] = reL;
      this.im[k] = imL;
      this.re[n - k] = reL;
      this.im[n - k] = -imL; // Hermitian symmetry -> real output
      this.reR[k] = reRv;
      this.imR[k] = imRv;
      this.reR[n - k] = reRv;
      this.imR[n - k] = -imRv;
    }

    this.fft.inverse(this.re, this.im);
    this.fft.inverse(this.reR, this.imR);

    const norm = Math.sqrt(n) * 0.5;
    for (let i = 0; i < n; i++) {
      const p = (this.olaPos + i) % this.olaL.length;
      const w = this.win[i];
      this.olaL[p] += this.re[i] * w * norm;
      this.olaR[p] += this.reR[i] * w * norm;
    }
  }
}
