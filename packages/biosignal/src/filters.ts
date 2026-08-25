/**
 * Small DSP kit for the rPPG pipeline: a fixed-band Butterworth bandpass, an
 * FFT-based dominant-frequency estimator with parabolic refinement, and a
 * beat picker for interval-based HRV. Deliberately independent of
 * @soundfx/engine's DSP module — this package must stay usable standalone
 * (e.g. inside a Node-based accuracy eval against a reference PPG dataset)
 * without pulling in audio-worklet-oriented code.
 */

export class Biquad2 {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  setBandpass(sr: number, f0: number, q: number): void {
    const w = (2 * Math.PI * f0) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/**
 * Zero-phase bandpass over a finite buffer (forward-backward filtering), which
 * matters here because group delay would smear beat timing and corrupt the
 * interval-based HRV estimate.
 */
export function bandpassZeroPhase(x: Float32Array, sr: number, loHz: number, hiHz: number): Float32Array {
  const centre = Math.sqrt(loHz * hiHz);
  const q = centre / (hiHz - loHz);
  const fwd = new Biquad2();
  fwd.setBandpass(sr, centre, q);
  const stage1 = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) stage1[i] = fwd.process(x[i]);

  const bwd = new Biquad2();
  bwd.setBandpass(sr, centre, q);
  const out = new Float32Array(x.length);
  for (let i = x.length - 1; i >= 0; i--) out[i] = bwd.process(stage1[i]);
  return out;
}

export interface FreqEstimate {
  bpm: number;
  /** 0..1, peak prominence relative to in-band power. Not a statistical CI. */
  confidence: number;
}

/**
 * Naive DFT-via-Goertzel over the plausible HR band. A full FFT would need a
 * power-of-two buffer and window bookkeeping; at these small sizes (a few
 * hundred samples, ~120 candidate frequencies) direct Goertzel is simpler and
 * fast enough at the ~1 Hz rate this runs.
 */
export function estimateHeartRate(signal: Float32Array, sr: number, minBpm = 42, maxBpm = 180): FreqEstimate {
  const n = signal.length;
  if (n < sr * 3) return { bpm: 0, confidence: 0 };

  // Hann window to reduce edge leakage.
  const windowed = new Float32Array(n);
  for (let i = 0; i < n; i++) windowed[i] = signal[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));

  const step = 0.2; // bpm resolution
  const nBins = Math.round((maxBpm - minBpm) / step) + 1;
  const power = new Float32Array(nBins);
  let totalPower = 0;

  for (let bin = 0; bin < nBins; bin++) {
    const bpm = minBpm + bin * step;
    const f = bpm / 60;
    const w = (2 * Math.PI * f) / sr;
    const coeff = 2 * Math.cos(w);
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      s0 = windowed[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const re = s1 - s2 * Math.cos(w);
    const im = s2 * Math.sin(w);
    const p = re * re + im * im;
    power[bin] = p;
    totalPower += p;
  }

  let peakBin = 0;
  for (let i = 1; i < nBins; i++) if (power[i] > power[peakBin]) peakBin = i;

  // Parabolic interpolation across the peak for sub-bin accuracy.
  let refined = minBpm + peakBin * step;
  if (peakBin > 0 && peakBin < nBins - 1) {
    const a = power[peakBin - 1];
    const b = power[peakBin];
    const c = power[peakBin + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) {
      const delta = (0.5 * (a - c)) / denom;
      refined = minBpm + (peakBin + delta) * step;
    }
  }

  const confidence = totalPower > 1e-9 ? Math.min(1, power[peakBin] / totalPower) * nBins * 0.02 : 0;
  return { bpm: refined, confidence: Math.max(0, Math.min(1, confidence)) };
}

export interface BeatPickResult {
  /** Sample indices of detected beats. */
  indices: number[];
  /** Inter-beat intervals in milliseconds. */
  ibiMs: number[];
}

/**
 * Adaptive-threshold peak picker with a physiological refractory period.
 * Feeds the HRV proxy (RMSSD) — see hrv.ts. This is a coarse, webcam-grade
 * estimate: expect noise floor well above what a chest strap or PPG ring
 * gives you. The UI must present it as low-confidence, never as clinical HRV.
 */
export function pickBeats(signal: Float32Array, sr: number, minBpm = 42, maxBpm = 180): BeatPickResult {
  const refractorySamples = Math.round(((60 / maxBpm) * sr) / 1);
  let mean = 0;
  for (let i = 0; i < signal.length; i++) mean += signal[i];
  mean /= signal.length;
  let variance = 0;
  for (let i = 0; i < signal.length; i++) variance += (signal[i] - mean) ** 2;
  const std = Math.sqrt(variance / signal.length);
  const threshold = mean + 0.5 * std;

  const indices: number[] = [];
  let lastBeat = -Infinity;
  for (let i = 1; i < signal.length - 1; i++) {
    if (signal[i] > threshold && signal[i] >= signal[i - 1] && signal[i] >= signal[i + 1]) {
      if (i - lastBeat >= refractorySamples) {
        indices.push(i);
        lastBeat = i;
      }
    }
  }

  const ibiMs: number[] = [];
  for (let i = 1; i < indices.length; i++) {
    const dtMs = ((indices[i] - indices[i - 1]) / sr) * 1000;
    const bpmEquiv = 60000 / dtMs;
    if (bpmEquiv >= minBpm && bpmEquiv <= maxBpm) ibiMs.push(dtMs);
  }
  return { indices, ibiMs };
}
