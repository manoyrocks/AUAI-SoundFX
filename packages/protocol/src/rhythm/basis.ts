/**
 * Feature bases for the Personal Rhythm Model.
 *
 * The model is a harmonic regression on local clock time — the standard
 * chronobiology approach (cosinor analysis, Halberg et al.), where a
 * biological rhythm is fitted as a sum of sinusoids at known periods rather
 * than as a free-form curve. Sinusoidal bases are the right choice here for
 * a specific reason: they extrapolate. A spline or a per-hour lookup can
 * only describe hours you have already observed; a 24-hour sinusoid fitted
 * from morning and evening data still makes a defensible (and honestly
 * uncertain) statement about mid-afternoon.
 *
 * ## On ultradian rhythms — the honest caveat
 *
 * It is common to model a "~90-110 minute ultradian energy cycle" against
 * clock time. There is a real phenomenon behind the name (Kleitman's Basic
 * Rest-Activity Cycle), but two things are worth stating plainly:
 *
 *  1. The evidence for a stable *daytime* ultradian rhythm in alertness is
 *     substantially weaker than the evidence for the circadian rhythm.
 *  2. More decisively: an ultradian cycle is anchored to wake onset, not to
 *     the wall clock. Two days with different wake times put the same clock
 *     hour at a different ultradian phase. **Fitting a fixed ~90-minute
 *     oscillation against clock time is therefore close to unfalsifiable
 *     decoration** unless you also know when the person woke up, which this
 *     build does not (no sleep-stage or wearable integration yet).
 *
 * So the ultradian basis is included as a *candidate* the model may select,
 * not as a component asserted to exist. The prequential model selection in
 * model.ts scores it against the simpler alternatives on held-out
 * predictive accuracy for each individual user; if a clock-anchored
 * ultradian term does not earn its parameters, it is not used. Being able
 * to reject a component is the point — see docs/07-claims.md.
 */

export type ComponentName = "intercept" | "circadian" | "circadianHarmonic" | "weekly" | "ultradian";

/** Feature count contributed by each component. */
const COMPONENT_DIM: Record<ComponentName, number> = {
  intercept: 1,
  circadian: 2,
  circadianHarmonic: 2,
  weekly: 1,
  ultradian: 2,
};

/** Nominal period of the clock-anchored ultradian candidate, in hours. */
export const ULTRADIAN_PERIOD_HOURS = 1.5;

export interface BasisSpec {
  id: string;
  label: string;
  /** Shown in the "why this prediction" surface. */
  description: string;
  components: ComponentName[];
  dim: number;
}

function spec(id: string, label: string, description: string, components: ComponentName[]): BasisSpec {
  return {
    id,
    label,
    description,
    components,
    dim: components.reduce((sum, c) => sum + COMPONENT_DIM[c], 0),
  };
}

/**
 * Candidate models, strictly nested from simplest to richest so that
 * selection is a genuine complexity trade-off rather than a comparison of
 * unrelated shapes.
 */
export const BASES: readonly BasisSpec[] = [
  spec("flat", "Flat", "No rhythm — a single average level. The null hypothesis.", ["intercept"]),
  spec("circadian", "Daily", "One 24-hour cycle: a single daily peak and trough.", ["intercept", "circadian"]),
  spec(
    "circadian2",
    "Daily + afternoon dip",
    "A 24-hour cycle plus its 12-hour harmonic, which is what lets the curve show a post-lunch dip as well as a daily peak.",
    ["intercept", "circadian", "circadianHarmonic"],
  ),
  spec(
    "circadian2-weekly",
    "Daily + weekday/weekend",
    "As above, plus a separate level for weekends.",
    ["intercept", "circadian", "circadianHarmonic", "weekly"],
  ),
  spec(
    "circadian2-weekly-ultradian",
    "Daily + weekend + ultradian",
    "As above, plus a 90-minute oscillation locked to clock time. Rarely justified — see the note in basis.ts.",
    ["intercept", "circadian", "circadianHarmonic", "weekly", "ultradian"],
  ),
] as const;

export function basisById(id: string): BasisSpec | undefined {
  return BASES.find((b) => b.id === id);
}

export interface TimeContext {
  /** Local hour of day in [0, 24). */
  hour: number;
  /** Local day of week, 0 = Sunday. */
  dayOfWeek: number;
}

/**
 * Decompose a timestamp in the *device's local timezone*.
 *
 * Local time, not UTC, is deliberate and load-bearing: circadian rhythm
 * tracks the user's actual light/dark and social schedule. Using UTC would
 * make the fitted curve meaningless for anyone outside UTC and would break
 * discontinuously when they travel.
 */
export function timeContext(timestampMs: number): TimeContext {
  const d = new Date(timestampMs);
  return {
    hour: d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600,
    dayOfWeek: d.getDay(),
  };
}

/** Build the feature vector for a basis at a given time. */
export function features(basis: BasisSpec, ctx: TimeContext, into?: Float64Array): Float64Array {
  const x = into && into.length >= basis.dim ? into : new Float64Array(basis.dim);
  let i = 0;
  for (const c of basis.components) {
    switch (c) {
      case "intercept":
        x[i++] = 1;
        break;
      case "circadian": {
        const w = (2 * Math.PI * ctx.hour) / 24;
        x[i++] = Math.cos(w);
        x[i++] = Math.sin(w);
        break;
      }
      case "circadianHarmonic": {
        const w = (4 * Math.PI * ctx.hour) / 24;
        x[i++] = Math.cos(w);
        x[i++] = Math.sin(w);
        break;
      }
      case "weekly":
        x[i++] = ctx.dayOfWeek === 0 || ctx.dayOfWeek === 6 ? 1 : 0;
        break;
      case "ultradian": {
        const w = (2 * Math.PI * ctx.hour) / ULTRADIAN_PERIOD_HOURS;
        x[i++] = Math.cos(w);
        x[i++] = Math.sin(w);
        break;
      }
    }
  }
  return x;
}
