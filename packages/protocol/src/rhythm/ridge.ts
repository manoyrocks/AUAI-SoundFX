/**
 * Online ridge regression over accumulated sufficient statistics.
 *
 * The Personal Rhythm Model needs to learn continuously, on-device, from
 * observations that arrive a few at a time over weeks. This class is the
 * numerical core: it never stores an observation, only the running
 * sufficient statistics
 *
 *     XtX = sum_i w_i x_i x_i'      (d x d)
 *     Xty = sum_i w_i x_i y_i       (d)
 *     yty = sum_i w_i y_i^2         (scalar)
 *     n   = sum_i w_i               (scalar)
 *
 * from which the ridge solution beta = (XtX + lambda I)^-1 Xty and the
 * predictive variance follow exactly. With d <= 8 that is at most ~80
 * numbers for a model trained on any number of observations.
 *
 * This is a real privacy property, not just an efficiency one: the stored
 * state is a rank-accumulated outer-product sum. Individual observations —
 * "this person's heart rate was elevated at 21:40 last Tuesday" — are not
 * recoverable from it. See docs/05-privacy.md.
 *
 * Exponential forgetting (`decay`) makes the fit adaptive rather than
 * merely cumulative: a user who changes jobs, timezone, or sleep schedule
 * should not be predicted forever by their old rhythm.
 */

export interface RidgeSnapshot {
  d: number;
  lambda: number;
  xtx: number[];
  xty: number[];
  yty: number;
  n: number;
}

/** Cholesky factorisation of a symmetric positive-definite matrix. */
function cholesky(a: Float64Array, d: number): Float64Array | null {
  const l = new Float64Array(d * d);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * d + j];
      for (let k = 0; k < j; k++) sum -= l[i * d + k] * l[j * d + k];
      if (i === j) {
        // Non-positive pivot means the system is not yet identifiable
        // (too few observations, or perfectly collinear features).
        if (sum <= 1e-12) return null;
        l[i * d + i] = Math.sqrt(sum);
      } else {
        l[i * d + j] = sum / l[j * d + j];
      }
    }
  }
  return l;
}

/** Solve A z = b given the Cholesky factor L of A. */
function cholSolve(l: Float64Array, b: Float64Array, d: number): Float64Array {
  const z = new Float64Array(d);
  for (let i = 0; i < d; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= l[i * d + k] * z[k];
    z[i] = s / l[i * d + i];
  }
  const x = new Float64Array(d);
  for (let i = d - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < d; k++) s -= l[k * d + i] * x[k];
    x[i] = s / l[i * d + i];
  }
  return x;
}

export class OnlineRidge {
  readonly d: number;
  readonly lambda: number;
  private xtx: Float64Array;
  private xty: Float64Array;
  private yty = 0;
  private n = 0;

  /** Cached factorisation, invalidated on every update. */
  private chol: Float64Array | null = null;
  private beta: Float64Array | null = null;
  private dirty = true;

  constructor(d: number, lambda = 1e-2) {
    this.d = d;
    this.lambda = lambda;
    this.xtx = new Float64Array(d * d);
    this.xty = new Float64Array(d);
  }

  /** Effective (weighted) sample count, after any forgetting applied. */
  get effectiveN(): number {
    return this.n;
  }

  /** Multiply all statistics by `factor` in [0,1] — exponential forgetting. */
  decay(factor: number): void {
    if (factor >= 1) return;
    const f = Math.max(0, factor);
    for (let i = 0; i < this.xtx.length; i++) this.xtx[i] *= f;
    for (let i = 0; i < this.xty.length; i++) this.xty[i] *= f;
    this.yty *= f;
    this.n *= f;
    this.dirty = true;
  }

  observe(x: Float64Array, y: number, w = 1): void {
    if (w <= 0 || !Number.isFinite(y)) return;
    const d = this.d;
    for (let i = 0; i < d; i++) {
      const wxi = w * x[i];
      for (let j = 0; j < d; j++) this.xtx[i * d + j] += wxi * x[j];
      this.xty[i] += wxi * y;
    }
    this.yty += w * y * y;
    this.n += w;
    this.dirty = true;
  }

  /** Refresh the cached factorisation if needed. Returns false if unsolvable. */
  private factor(): boolean {
    if (!this.dirty) return this.chol != null;
    this.dirty = false;
    const d = this.d;
    const a = new Float64Array(d * d);
    a.set(this.xtx);
    for (let i = 0; i < d; i++) a[i * d + i] += this.lambda;
    this.chol = cholesky(a, d);
    this.beta = this.chol ? cholSolve(this.chol, this.xty, d) : null;
    return this.chol != null;
  }

  /** Fitted coefficients, or null when the system is not yet identifiable. */
  coefficients(): Float64Array | null {
    this.factor();
    return this.beta;
  }

  predict(x: Float64Array): number | null {
    const beta = this.coefficients();
    if (!beta) return null;
    let acc = 0;
    for (let i = 0; i < this.d; i++) acc += beta[i] * x[i];
    return acc;
  }

  /**
   * Residual variance of the fit. Uses the exact identity
   * RSS = yty - 2 beta'Xty + beta'XtX beta, so no observations are needed.
   */
  residualVariance(): number {
    const beta = this.coefficients();
    if (!beta) return Number.POSITIVE_INFINITY;
    const d = this.d;
    let bXty = 0;
    for (let i = 0; i < d; i++) bXty += beta[i] * this.xty[i];
    let bXtXb = 0;
    for (let i = 0; i < d; i++) {
      let row = 0;
      for (let j = 0; j < d; j++) row += this.xtx[i * d + j] * beta[j];
      bXtXb += beta[i] * row;
    }
    const rss = Math.max(0, this.yty - 2 * bXty + bXtXb);
    const dof = Math.max(1, this.n - d);
    return rss / dof;
  }

  /**
   * Standard deviation of the predictive distribution at x, combining
   * residual noise with parameter uncertainty:
   *     var = sigma^2 * (1 + x' (XtX + lambda I)^-1 x)
   * This is what lets the model say "I don't know yet" for a time of day it
   * has never observed, instead of extrapolating with false confidence.
   */
  predictiveStd(x: Float64Array): number {
    if (!this.factor() || !this.chol) return Number.POSITIVE_INFINITY;
    const d = this.d;
    const u = cholSolve(this.chol, x, d);
    let leverage = 0;
    for (let i = 0; i < d; i++) leverage += x[i] * u[i];
    const sigma2 = this.residualVariance();
    if (!Number.isFinite(sigma2)) return Number.POSITIVE_INFINITY;
    return Math.sqrt(Math.max(0, sigma2 * (1 + Math.max(0, leverage))));
  }

  snapshot(): RidgeSnapshot {
    return {
      d: this.d,
      lambda: this.lambda,
      xtx: Array.from(this.xtx),
      xty: Array.from(this.xty),
      yty: this.yty,
      n: this.n,
    };
  }

  static restore(s: RidgeSnapshot): OnlineRidge | null {
    if (!s || typeof s.d !== "number" || s.d <= 0) return null;
    if (!Array.isArray(s.xtx) || s.xtx.length !== s.d * s.d) return null;
    if (!Array.isArray(s.xty) || s.xty.length !== s.d) return null;
    const r = new OnlineRidge(s.d, typeof s.lambda === "number" ? s.lambda : 1e-2);
    r.xtx.set(s.xtx);
    r.xty.set(s.xty);
    r.yty = typeof s.yty === "number" ? s.yty : 0;
    r.n = typeof s.n === "number" ? s.n : 0;
    r.dirty = true;
    return r;
  }
}
