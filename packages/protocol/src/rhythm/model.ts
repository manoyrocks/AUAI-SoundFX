import { BASES, basisById, features, timeContext, type BasisSpec } from "./basis.js";
import { OnlineRidge, type RidgeSnapshot } from "./ridge.js";

/**
 * Personal Rhythm Model
 * =====================
 *
 * An on-device, continuously-learned model of one person's daily rhythm,
 * used to forecast when their favourable windows fall over the next 24-48h
 * so protocols can be *scheduled* rather than merely offered from a menu.
 *
 * What it models: an arousal proxy (heart rate expressed as a z-score
 * against the user's own rolling baseline — see baseline.ts) as a function
 * of local clock time. Positive means "running hotter than usual for this
 * person", negative means "running cooler".
 *
 * Three design decisions carry most of the weight:
 *
 * 1. **Prequential model selection.** Five nested candidate models (see
 *    basis.ts) are trained in parallel. Before each observation updates
 *    them, every model first *predicts* it, and the squared error is
 *    accumulated. Selection is therefore on genuinely held-out
 *    predict-then-update accuracy, per user, with no data retention and no
 *    train/test split to get wrong. A user whose rhythm is genuinely flat
 *    gets the flat model; the richer models have to earn their parameters.
 *
 * 2. **Coverage gating.** Predictive accuracy is not the only failure mode
 *    — a model fitted only on 8am and 9pm observations can score well on
 *    those hours while being pure extrapolation at 2pm. `isReady()`
 *    therefore also requires observations spread across enough distinct
 *    hours and distinct days before the model will forecast at all.
 *
 * 3. **Predictive uncertainty, surfaced.** Every prediction carries a
 *    standard deviation from the ridge posterior, and windows are only
 *    reported where confidence clears a floor. The model is built to be
 *    able to say "I don't know yet about that time of day".
 *
 * Explicitly NOT modelled in this build: sleep debt, caffeine, and calendar
 * context — all three are named in the product spec, all three need data
 * sources (wearable sleep staging, user logging, calendar permission) that
 * do not exist here yet. The observation interface takes an opaque
 * `arousalZ`, so adding them later is a matter of enriching the basis, not
 * restructuring this class.
 */

export interface RhythmObservation {
  timestampMs: number;
  /** Arousal proxy: HR z-score against the user's own rolling baseline. */
  arousalZ: number;
  /** 0..1 confidence in this reading; used as the regression weight. */
  weight: number;
}

export interface RhythmPrediction {
  timestampMs: number;
  /** Predicted arousal z-score. */
  arousalZ: number;
  /** Predictive standard deviation, in the same z units. */
  std: number;
  /** Heuristic 0..1 mapping of `std`. Not a probability — see below. */
  confidence: number;
  /** Local rate of change, z-units per hour. Negative = settling. */
  slopePerHour: number;
}

export interface RhythmCoverage {
  totalObservations: number;
  /** Distinct local hours-of-day seen, 0..24. */
  distinctHours: number;
  /** Distinct calendar days seen (capped by the retention window). */
  distinctDays: number;
  /** Effective weighted sample count after forgetting. */
  effectiveN: number;
}

export type RhythmGoal = "focus" | "windDown" | "recovery";

export interface RhythmWindow {
  goal: RhythmGoal;
  startMs: number;
  endMs: number;
  /** Mean predicted arousal across the window. */
  meanArousalZ: number;
  /** Mean confidence across the window. */
  confidence: number;
}

export interface RhythmSnapshot {
  version: 1;
  models: Record<string, RidgeSnapshot>;
  prequential: Record<string, { se: number; n: number }>;
  hourMask: number;
  dayKeys: number[];
  totalObservations: number;
  lastObservationMs: number;
}

/** Weighted observations each model needs before prequential scoring starts. */
const SCORING_WARMUP = 30;

/** Readiness thresholds — see `isReady`. */
const MIN_OBSERVATIONS = 60;
const MIN_DISTINCT_HOURS = 5;
const MIN_DISTINCT_DAYS = 4;

/** Forgetting half-life. A schedule change should wash out over ~6 weeks. */
const FORGET_HALF_LIFE_DAYS = 45;

/** Retained distinct-day keys (bounds the snapshot size). */
const MAX_DAY_KEYS = 90;

/** Predictions below this confidence are never reported as windows. */
const MIN_WINDOW_CONFIDENCE = 0.35;

/** Shortest span that counts as a window. */
const MIN_WINDOW_MINUTES = 30;

/** Sampling resolution when scanning the forecast horizon. */
const SCAN_STEP_MINUTES = 15;

/**
 * Target arousal bands per goal, in z-units against the user's own baseline.
 *
 * Hand-authored starting points, exactly like the engine's ANCHORS — they
 * define which part of *this user's own* range each protocol suits, not a
 * population norm. Flagged as unvalidated in docs/07-claims.md.
 */
const GOAL_BANDS: Record<RhythmGoal, { min: number; max: number; requireSettling: boolean }> = {
  // Alert but not agitated.
  focus: { min: -0.35, max: 0.85, requireSettling: false },
  // Below their own average and actively declining — the natural descent.
  windDown: { min: -3, max: 0.3, requireSettling: true },
  // Running hot, where a parasympathetic reset has something to work on.
  recovery: { min: 0.55, max: 3, requireSettling: false },
};

interface Candidate {
  basis: BasisSpec;
  ridge: OnlineRidge;
  /** Accumulated prequential squared error and its weight. */
  se: number;
  n: number;
}

export class PersonalRhythmModel {
  private candidates: Candidate[];
  private hourMask = 0;
  private dayKeys: number[] = [];
  private totalObservations = 0;
  private lastObservationMs = 0;

  constructor() {
    this.candidates = BASES.map((basis) => ({
      basis,
      ridge: new OnlineRidge(basis.dim),
      se: 0,
      n: 0,
    }));
  }

  coverage(): RhythmCoverage {
    let hours = 0;
    for (let i = 0; i < 24; i++) if (this.hourMask & (1 << i)) hours++;
    return {
      totalObservations: this.totalObservations,
      distinctHours: hours,
      distinctDays: this.dayKeys.length,
      effectiveN: this.candidates[0]?.ridge.effectiveN ?? 0,
    };
  }

  /**
   * Whether the model may forecast at all.
   *
   * Deliberately conservative and multi-dimensional: raw observation count
   * alone would let a model that has only ever seen 9am mornings claim to
   * know about 4pm. Requiring spread across hours *and* days is what makes
   * the resulting curve a rhythm rather than a coincidence.
   */
  isReady(): boolean {
    const c = this.coverage();
    return (
      c.totalObservations >= MIN_OBSERVATIONS &&
      c.distinctHours >= MIN_DISTINCT_HOURS &&
      c.distinctDays >= MIN_DISTINCT_DAYS
    );
  }

  /** Plain-language statement of what is still missing, for the UI. */
  readinessNote(): string {
    const c = this.coverage();
    if (this.isReady()) return "";
    const missing: string[] = [];
    if (c.totalObservations < MIN_OBSERVATIONS) {
      missing.push(`${MIN_OBSERVATIONS - c.totalObservations} more readings`);
    }
    if (c.distinctHours < MIN_DISTINCT_HOURS) {
      missing.push(`sessions at ${MIN_DISTINCT_HOURS - c.distinctHours} more times of day`);
    }
    if (c.distinctDays < MIN_DISTINCT_DAYS) {
      missing.push(`${MIN_DISTINCT_DAYS - c.distinctDays} more days`);
    }
    return `Needs ${missing.join(", ")} before it can forecast.`;
  }

  /**
   * Feed one observation.
   *
   * Order matters: every candidate predicts *before* it learns, so the
   * accumulated error is genuine out-of-sample error.
   */
  observe(obs: RhythmObservation): void {
    if (!Number.isFinite(obs.arousalZ) || obs.weight <= 0) return;

    this.applyForgetting(obs.timestampMs);

    const ctx = timeContext(obs.timestampMs);
    for (const cand of this.candidates) {
      const x = features(cand.basis, ctx);
      if (cand.ridge.effectiveN >= SCORING_WARMUP) {
        const yhat = cand.ridge.predict(x);
        if (yhat != null) {
          const err = obs.arousalZ - yhat;
          cand.se += obs.weight * err * err;
          cand.n += obs.weight;
        }
      }
      cand.ridge.observe(x, obs.arousalZ, obs.weight);
    }

    this.hourMask |= 1 << Math.min(23, Math.max(0, Math.floor(ctx.hour)));
    const dayKey = Math.floor(obs.timestampMs / 86400000);
    if (!this.dayKeys.includes(dayKey)) {
      this.dayKeys.push(dayKey);
      if (this.dayKeys.length > MAX_DAY_KEYS) this.dayKeys.shift();
    }
    this.totalObservations++;
    this.lastObservationMs = obs.timestampMs;
  }

  private applyForgetting(nowMs: number): void {
    if (this.lastObservationMs === 0) return;
    const elapsedDays = (nowMs - this.lastObservationMs) / 86400000;
    if (elapsedDays <= 0) return;
    const factor = Math.pow(0.5, elapsedDays / FORGET_HALF_LIFE_DAYS);
    if (factor >= 0.999) return;
    for (const cand of this.candidates) cand.ridge.decay(factor);
  }

  /**
   * The candidate with the lowest mean prequential error.
   *
   * Falls back to the simplest model until enough scored observations have
   * accumulated to distinguish them — preferring the simpler explanation
   * while evidence is thin is the correct default, not a placeholder.
   */
  selectedBasis(): BasisSpec {
    let best: Candidate | null = null;
    let bestMse = Number.POSITIVE_INFINITY;
    for (const cand of this.candidates) {
      if (cand.n < 10) continue;
      const mse = cand.se / cand.n;
      if (mse < bestMse) {
        bestMse = mse;
        best = cand;
      }
    }
    return (best ?? this.candidates[0]).basis;
  }

  /** Per-candidate scores, for the "how it decided" transparency surface. */
  modelScores(): { id: string; label: string; meanSquaredError: number | null; scoredN: number }[] {
    return this.candidates.map((c) => ({
      id: c.basis.id,
      label: c.basis.label,
      meanSquaredError: c.n >= 10 ? c.se / c.n : null,
      scoredN: c.n,
    }));
  }

  private candidateFor(basis: BasisSpec): Candidate {
    return this.candidates.find((c) => c.basis.id === basis.id) ?? this.candidates[0];
  }

  /**
   * Forecast at a single instant. Returns null when the model is not ready.
   */
  predictAt(timestampMs: number): RhythmPrediction | null {
    if (!this.isReady()) return null;
    const basis = this.selectedBasis();
    const cand = this.candidateFor(basis);

    const ctx = timeContext(timestampMs);
    const x = features(basis, ctx);
    const mean = cand.ridge.predict(x);
    if (mean == null) return null;
    const std = cand.ridge.predictiveStd(x);
    if (!Number.isFinite(std)) return null;

    // Numerical derivative over +/- 15 minutes.
    const dtMs = 15 * 60000;
    const before = cand.ridge.predict(features(basis, timeContext(timestampMs - dtMs)));
    const after = cand.ridge.predict(features(basis, timeContext(timestampMs + dtMs)));
    const slopePerHour = before != null && after != null ? (after - before) / (2 * (dtMs / 3600000)) : 0;

    return {
      timestampMs,
      arousalZ: mean,
      std,
      // Heuristic squashing of a standard deviation into a 0..1 bar. This is
      // a display convenience, NOT a calibrated probability — the honest
      // quantity is `std`, which is reported alongside it.
      confidence: Math.exp(-Math.max(0, std) * 0.9),
      slopePerHour,
    };
  }

  /**
   * Scan forward and return contiguous spans suited to `goal`.
   *
   * Returns an empty array — never a fabricated window — when the model is
   * not ready or when no span clears both the goal band and the confidence
   * floor.
   */
  findWindows(fromMs: number, horizonHours: number, goal: RhythmGoal): RhythmWindow[] {
    if (!this.isReady()) return [];
    const band = GOAL_BANDS[goal];
    const stepMs = SCAN_STEP_MINUTES * 60000;
    const steps = Math.max(1, Math.round((horizonHours * 3600000) / stepMs));

    const windows: RhythmWindow[] = [];
    let runStart: number | null = null;
    let sumZ = 0;
    let sumConf = 0;
    let count = 0;

    const closeRun = (endMs: number) => {
      if (runStart == null || count === 0) return;
      const durationMin = (endMs - runStart) / 60000;
      if (durationMin >= MIN_WINDOW_MINUTES) {
        windows.push({
          goal,
          startMs: runStart,
          endMs,
          meanArousalZ: sumZ / count,
          confidence: sumConf / count,
        });
      }
      runStart = null;
      sumZ = 0;
      sumConf = 0;
      count = 0;
    };

    for (let i = 0; i <= steps; i++) {
      const t = fromMs + i * stepMs;
      const p = this.predictAt(t);
      const ok =
        p != null &&
        p.confidence >= MIN_WINDOW_CONFIDENCE &&
        p.arousalZ >= band.min &&
        p.arousalZ <= band.max &&
        (!band.requireSettling || p.slopePerHour < 0);

      if (ok && p) {
        if (runStart == null) runStart = t;
        sumZ += p.arousalZ;
        sumConf += p.confidence;
        count++;
      } else {
        closeRun(t);
      }
    }
    closeRun(fromMs + steps * stepMs);
    return windows;
  }

  /** The soonest upcoming window for a goal, if any. */
  nextWindow(fromMs: number, horizonHours: number, goal: RhythmGoal): RhythmWindow | null {
    const windows = this.findWindows(fromMs, horizonHours, goal);
    return windows.length > 0 ? windows[0] : null;
  }

  /** A 24h curve for plotting. Empty when not ready. */
  dailyCurve(fromMs: number, stepMinutes = 30): RhythmPrediction[] {
    if (!this.isReady()) return [];
    const out: RhythmPrediction[] = [];
    const steps = Math.round((24 * 60) / stepMinutes);
    for (let i = 0; i < steps; i++) {
      const p = this.predictAt(fromMs + i * stepMinutes * 60000);
      if (p) out.push(p);
    }
    return out;
  }

  snapshot(): RhythmSnapshot {
    const models: Record<string, RidgeSnapshot> = {};
    const prequential: Record<string, { se: number; n: number }> = {};
    for (const c of this.candidates) {
      models[c.basis.id] = c.ridge.snapshot();
      prequential[c.basis.id] = { se: c.se, n: c.n };
    }
    return {
      version: 1,
      models,
      prequential,
      hourMask: this.hourMask,
      dayKeys: [...this.dayKeys],
      totalObservations: this.totalObservations,
      lastObservationMs: this.lastObservationMs,
    };
  }

  /**
   * Restore from a snapshot. Any structural mismatch (a basis that changed
   * dimension between releases, corrupt storage) discards just that
   * candidate and keeps the rest, rather than throwing away the user's
   * whole learned history or crashing.
   */
  static restore(s: RhythmSnapshot | null | undefined): PersonalRhythmModel {
    const model = new PersonalRhythmModel();
    // `typeof null === "object"`, so the null check must be explicit here —
    // a corrupt snapshot with `models: null` otherwise reaches the loop below.
    if (!s || s.version !== 1 || !s.models || typeof s.models !== "object") return model;

    for (const cand of model.candidates) {
      const snap = s.models[cand.basis.id];
      if (!snap || snap.d !== cand.basis.dim) continue;
      const restored = OnlineRidge.restore(snap);
      if (!restored) continue;
      cand.ridge = restored;
      const pq = s.prequential?.[cand.basis.id];
      if (pq && Number.isFinite(pq.se) && Number.isFinite(pq.n)) {
        cand.se = pq.se;
        cand.n = pq.n;
      }
    }
    model.hourMask = Number.isFinite(s.hourMask) ? s.hourMask : 0;
    model.dayKeys = Array.isArray(s.dayKeys) ? s.dayKeys.filter((k) => Number.isFinite(k)) : [];
    model.totalObservations = Number.isFinite(s.totalObservations) ? s.totalObservations : 0;
    model.lastObservationMs = Number.isFinite(s.lastObservationMs) ? s.lastObservationMs : 0;
    return model;
  }
}

export { basisById };
