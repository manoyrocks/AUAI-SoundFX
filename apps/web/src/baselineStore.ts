import type { PhysiologyBaseline } from "@soundfx/protocol";

/**
 * Local persistence for the personal HR/HRV baseline.
 *
 * Previously the baseline restarted from a wide, untrusted prior on every
 * page load, which had two real costs: the closed loop stayed inactive for
 * the first minute or two of every session while it re-learned what "normal"
 * meant, and the Rhythm Model — which only accepts readings once the
 * baseline is trusted — discarded that same window.
 *
 * This is a privacy decision as much as a UX one, so it follows the same
 * rule as everything else: local storage only, declared in storage.ts,
 * deletable from the data panel, never transmitted.
 *
 * A staleness bound matters here. A baseline learned months ago may no
 * longer describe the person (fitness changes, illness, medication), and a
 * confidently wrong baseline is worse than an honest cold start because the
 * controller acts on it. Anything older than the cutoff is discarded.
 */

const KEY = "soundfx.baseline.v1";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface BaselineSnapshot {
  version: 1;
  savedAtMs: number;
  hr: { mean: number; variance: number; weight: number };
  hrv: { mean: number; variance: number; weight: number };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function saveBaseline(baseline: PhysiologyBaseline): void {
  // Only persist a baseline the controller would actually have trusted.
  // Writing an under-trained one would resurrect noise as if it were fact.
  if (!baseline.hr.trusted) return;
  try {
    const snap: BaselineSnapshot = {
      version: 1,
      savedAtMs: Date.now(),
      hr: baseline.hr.snapshot(),
      hrv: baseline.hrv.snapshot(),
    };
    localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    /* best effort */
  }
}

/**
 * Restore into an existing baseline. Returns true if anything was applied.
 * Any malformed, stale, or non-finite snapshot is ignored, leaving the
 * caller's fresh baseline untouched — degrading to a cold start rather than
 * to corrupt state.
 */
export function restoreBaseline(baseline: PhysiologyBaseline): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw) as BaselineSnapshot;
    if (!snap || snap.version !== 1) return false;
    if (!isFiniteNumber(snap.savedAtMs)) return false;
    if (Date.now() - snap.savedAtMs > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return false;
    }
    const ok =
      snap.hr &&
      snap.hrv &&
      isFiniteNumber(snap.hr.mean) &&
      isFiniteNumber(snap.hr.variance) &&
      isFiniteNumber(snap.hr.weight) &&
      isFiniteNumber(snap.hrv.mean) &&
      isFiniteNumber(snap.hrv.variance) &&
      isFiniteNumber(snap.hrv.weight);
    if (!ok) return false;

    baseline.hr.restore(snap.hr);
    baseline.hrv.restore(snap.hrv);
    return true;
  } catch {
    return false;
  }
}
