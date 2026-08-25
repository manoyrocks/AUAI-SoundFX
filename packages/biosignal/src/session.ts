import { findRoi, meanRgb, type Roi } from "./roi.js";
import { posSignal } from "./pos.js";
import { bandpassZeroPhase, estimateHeartRate, pickBeats } from "./filters.js";
import { computeRmssd, type HrvResult } from "./hrv.js";

/**
 * RppgSession — orchestrates camera frames into a live HR/HRV stream.
 *
 * All processing happens on-device, synchronously in the browser's rVFC/rAF
 * loop; no video frame and no derived trace ever leaves this object. This is
 * the concrete implementation of the "raw biometrics never leave the device"
 * privacy rule for camera-based sensing (see docs/05-privacy.md) — there is
 * simply no network call anywhere in this file.
 *
 * Usage: feed it frames (`pushFrame`) at whatever rate the camera delivers
 * (typically 15-30 fps); it maintains a rolling trace buffer and re-estimates
 * heart rate on a 1 Hz timer once enough history has accumulated.
 */

export interface RppgReading {
  timestampMs: number;
  bpm: number;
  confidence: number;
  hrv: HrvResult | null;
  roi: Roi | null;
  /** True once >= MIN_WINDOW_S of usable frames have been collected. */
  warmedUp: boolean;
}

const TRACE_SR_TARGET = 20; // resample target rate for the RGB trace, Hz
const MIN_WINDOW_S = 8; // shortest window we'll attempt an estimate from
const MAX_WINDOW_S = 30; // rolling buffer length
const HR_LO_HZ = 0.7; // 42 bpm
const HR_HI_HZ = 3.5; // 210 bpm

export class RppgSession {
  private readonly rBuf: number[] = [];
  private readonly gBuf: number[] = [];
  private readonly bBuf: number[] = [];
  private readonly tBuf: number[] = []; // frame timestamps, ms

  private lastRoi: Roi | null = null;
  private roiMissCount = 0;
  private lastEstimateAt = 0;
  private latest: RppgReading = {
    timestampMs: 0,
    bpm: 0,
    confidence: 0,
    hrv: null,
    roi: null,
    warmedUp: false,
  };
  private readonly listeners = new Set<(r: RppgReading) => void>();
  private recentBpm: number[] = [];

  get reading(): RppgReading {
    return this.latest;
  }

  onReading(fn: (r: RppgReading) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Feed one video frame. `source` must be drawable (HTMLVideoElement or
   * VideoFrame-wrapping canvas). Cheap enough to call every rAF: ROI tracking
   * runs on a downsampled 96x72 copy, and full re-localisation is skipped on
   * frames where the previous ROI is still plausible.
   */
  pushFrame(source: CanvasImageSource, srcW: number, srcH: number, nowMs: number): void {
    // Re-run skin localisation every ~10 frames; between those, reuse the last
    // ROI. Full localisation is the expensive step (whole-frame scan).
    if (!this.lastRoi || this.roiMissCount++ >= 10) {
      this.lastRoi = findRoi(source, srcW, srcH);
      this.roiMissCount = 0;
    }
    if (!this.lastRoi) {
      // No face/skin in frame: do not push a stale trace sample, and decay
      // confidence so the UI reflects "lost signal" quickly rather than
      // coasting on the last good estimate.
      this.latest = { ...this.latest, confidence: this.latest.confidence * 0.85, roi: null, timestampMs: nowMs };
      this.notify();
      return;
    }

    const [r, g, b] = meanRgb(source, this.lastRoi);
    this.tBuf.push(nowMs);
    this.rBuf.push(r);
    this.gBuf.push(g);
    this.bBuf.push(b);

    const cutoffMs = nowMs - MAX_WINDOW_S * 1000;
    while (this.tBuf.length && this.tBuf[0] < cutoffMs) {
      this.tBuf.shift();
      this.rBuf.shift();
      this.gBuf.shift();
      this.bBuf.shift();
    }

    if (nowMs - this.lastEstimateAt >= 1000 && this.tBuf.length >= 2) {
      this.lastEstimateAt = nowMs;
      this.reestimate(nowMs);
    } else {
      this.latest = { ...this.latest, roi: this.lastRoi, timestampMs: nowMs };
      this.notify();
    }
  }

  reset(): void {
    this.rBuf.length = 0;
    this.gBuf.length = 0;
    this.bBuf.length = 0;
    this.tBuf.length = 0;
    this.recentBpm = [];
    this.latest = { timestampMs: 0, bpm: 0, confidence: 0, hrv: null, roi: null, warmedUp: false };
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this.latest);
  }

  private reestimate(nowMs: number): void {
    const spanS = (this.tBuf[this.tBuf.length - 1] - this.tBuf[0]) / 1000;
    if (spanS < MIN_WINDOW_S) {
      this.latest = { ...this.latest, roi: this.lastRoi, timestampMs: nowMs, warmedUp: false };
      this.notify();
      return;
    }

    const resampled = resampleUniform(this.tBuf, this.rBuf, this.gBuf, this.bBuf, TRACE_SR_TARGET);
    if (!resampled) return;
    const { r, g, b, sr } = resampled;

    const pulse = posSignal(r, g, b, Math.round(sr * 1.6));
    const filtered = bandpassZeroPhase(pulse, sr, HR_LO_HZ, HR_HI_HZ);

    const freqEst = estimateHeartRate(filtered, sr, HR_LO_HZ * 60, HR_HI_HZ * 60);
    const { ibiMs } = pickBeats(filtered, sr, HR_LO_HZ * 60, HR_HI_HZ * 60);
    const hrv = ibiMs.length >= 5 ? computeRmssd(ibiMs) : null;

    // Median-of-last-5 smoothing on the reported BPM: the per-second estimate
    // is noisy; the controller downstream needs a stable number, not a raw one.
    this.recentBpm.push(freqEst.bpm);
    if (this.recentBpm.length > 5) this.recentBpm.shift();
    const sortedBpm = [...this.recentBpm].sort((x, y) => x - y);
    const smoothedBpm = sortedBpm[Math.floor(sortedBpm.length / 2)];

    this.latest = {
      timestampMs: nowMs,
      bpm: smoothedBpm,
      confidence: freqEst.confidence * (this.lastRoi ? Math.min(1, this.lastRoi.skinFraction * 8) : 0),
      hrv,
      roi: this.lastRoi,
      warmedUp: true,
    };
    this.notify();
  }
}

function resampleUniform(
  t: number[],
  r: number[],
  g: number[],
  b: number[],
  targetHz: number,
): { r: Float32Array; g: Float32Array; b: Float32Array; sr: number } | null {
  const n = t.length;
  if (n < 2) return null;
  const t0 = t[0];
  const t1 = t[n - 1];
  const durationS = (t1 - t0) / 1000;
  if (durationS <= 0) return null;
  const outN = Math.max(2, Math.floor(durationS * targetHz));
  const outR = new Float32Array(outN);
  const outG = new Float32Array(outN);
  const outB = new Float32Array(outN);

  let srcIdx = 0;
  for (let i = 0; i < outN; i++) {
    const targetT = t0 + (i / targetHz) * 1000;
    while (srcIdx < n - 2 && t[srcIdx + 1] < targetT) srcIdx++;
    const t_a = t[srcIdx];
    const t_b = t[Math.min(n - 1, srcIdx + 1)];
    const span = t_b - t_a;
    const frac = span > 0 ? (targetT - t_a) / span : 0;
    const idxB = Math.min(n - 1, srcIdx + 1);
    outR[i] = r[srcIdx] + (r[idxB] - r[srcIdx]) * frac;
    outG[i] = g[srcIdx] + (g[idxB] - g[srcIdx]) * frac;
    outB[i] = b[srcIdx] + (b[idxB] - b[srcIdx]) * frac;
  }
  return { r: outR, g: outG, b: outB, sr: targetHz };
}
