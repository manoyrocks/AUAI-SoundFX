/**
 * RMSSD — root mean square of successive differences between inter-beat
 * intervals — the standard time-domain HRV metric, chosen because it is
 * robust to short windows (unlike SDNN, which needs minutes to stabilise) and
 * is what the Personal Rhythm Model's dose-response fitting consumes.
 *
 * Camera-derived HRV is noisy; this function does not pretend otherwise. It
 * rejects outlier intervals (ectopic-beat-like artefacts, most of which here
 * are actually detector glitches, not real ectopy) before computing RMSSD, and
 * returns a quality flag the UI must respect.
 */

export interface HrvResult {
  rmssdMs: number;
  /** Beats retained after artefact rejection. */
  nIntervals: number;
  quality: "low" | "medium" | "unusable";
}

export function computeRmssd(ibiMs: number[]): HrvResult {
  if (ibiMs.length < 5) return { rmssdMs: 0, nIntervals: ibiMs.length, quality: "unusable" };

  // Reject intervals that differ from the local median by more than 20% —
  // a standard artefact filter for short-window HRV.
  const sorted = [...ibiMs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const clean = ibiMs.filter((v) => Math.abs(v - median) / median < 0.2);

  if (clean.length < 5) return { rmssdMs: 0, nIntervals: clean.length, quality: "unusable" };

  let sumSq = 0;
  for (let i = 1; i < clean.length; i++) {
    const d = clean[i] - clean[i - 1];
    sumSq += d * d;
  }
  const rmssd = Math.sqrt(sumSq / (clean.length - 1));

  const quality = clean.length >= 15 ? "medium" : "low";
  return { rmssdMs: rmssd, nIntervals: clean.length, quality };
}
