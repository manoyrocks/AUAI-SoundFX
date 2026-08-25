import type { StateVector } from "./state.js";

/**
 * Confidence-weighted exponential mean/variance tracker for one scalar signal.
 *
 * Every fused signal is compared against *this specific user's* own recent
 * distribution, learned online, rather than against a fixed population
 * threshold. Resting heart rate varies enormously between individuals, so a
 * generic "elevated" cutoff mislabels a naturally higher resting HR as
 * permanent stress while missing a real spike in someone who runs low.
 * Tracking the personal distribution detects genuine change faster and with
 * far fewer false positives.
 *
 * Deliberately a simple, auditable Welford-style update for M1, not a learned
 * model — the full Personal Rhythm Foundation Model (M3) subsumes this with a
 * time-of-day- and circadian-aware baseline; this is its degenerate
 * single-parameter special case, not a throwaway.
 */
export class ScalarBaseline {
  private mean: number;
  private variance: number;
  private nEff = 2;
  private readonly halfLifeSamples: number;

  private readonly initialMean: number;
  private readonly initialVariance: number;

  constructor(initialMean: number, initialVariance: number, halfLifeSamples = 180) {
    this.mean = initialMean;
    this.variance = initialVariance;
    this.halfLifeSamples = halfLifeSamples;
    this.initialMean = initialMean;
    this.initialVariance = initialVariance;
  }

  /**
   * Return to the untrained prior.
   *
   * Needed so that deleting the stored baseline actually deletes it: clearing
   * only the persisted copy would leave the live, already-learned baseline
   * steering the controller for the rest of the session, which is not what
   * "delete my data" means to anyone.
   */
  reset(): void {
    this.mean = this.initialMean;
    this.variance = this.initialVariance;
    this.nEff = 2;
  }

  get value(): number {
    return this.mean;
  }

  get std(): number {
    return Math.sqrt(this.variance);
  }

  get trusted(): boolean {
    return this.nEff >= 20;
  }

  update(value: number, confidence: number): void {
    if (confidence <= 0) return;
    const decay = Math.exp(-1 / this.halfLifeSamples);
    const effRate = (1 - decay) * confidence;
    const delta = value - this.mean;
    this.mean += effRate * delta;
    this.variance = Math.max(1e-6, (1 - effRate) * (this.variance + effRate * delta * delta));
    this.nEff = Math.min(500, this.nEff + confidence);
  }

  /** Standardised deviation from baseline; positive = above baseline. */
  zScore(value: number, minStd: number): number {
    return (value - this.mean) / Math.max(minStd, this.std);
  }

  /**
   * Serialisable state, for persisting a learned baseline across sessions.
   * `weight` is the effective sample count, which is what determines
   * `trusted` — restoring mean and variance without it would produce a
   * baseline that looks confident but has no evidence behind it.
   */
  snapshot(): { mean: number; variance: number; weight: number } {
    return { mean: this.mean, variance: this.variance, weight: this.nEff };
  }

  /**
   * Restore a previous snapshot. Values are clamped to the same ranges the
   * update path maintains, so a corrupt or hand-edited store cannot inject a
   * degenerate baseline that the controller would then act on.
   */
  restore(s: { mean: number; variance: number; weight: number }): void {
    if (!Number.isFinite(s.mean) || !Number.isFinite(s.variance) || !Number.isFinite(s.weight)) return;
    this.mean = s.mean;
    this.variance = Math.max(1e-6, s.variance);
    this.nEff = Math.min(500, Math.max(0, s.weight));
  }
}

/**
 * Fused physiological baseline: resting heart rate and resting HRV, tracked
 * together so the controller can read their *agreement* (see controller.ts).
 * Agreement between two independent signals is what separates a real
 * physiological shift from sensor noise in either one.
 */
export class PhysiologyBaseline {
  readonly hr = new ScalarBaseline(68, 100, 180);
  readonly hrv = new ScalarBaseline(45, 400, 240);

  update(s: StateVector): void {
    if (s.heartRateBpm != null) this.hr.update(s.heartRateBpm, s.heartRateConfidence);
    if (s.hrvRmssdMs != null) this.hrv.update(s.hrvRmssdMs, s.hrvConfidence);
  }

  /** Return both signals to their untrained priors. See ScalarBaseline.reset. */
  reset(): void {
    this.hr.reset();
    this.hrv.reset();
  }
}
