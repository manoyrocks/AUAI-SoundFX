/**
 * Speech-masking psychoacoustics
 * ==============================
 *
 * Everything here supports the Screen mode, whose goal is acoustic rather
 * than affective: make surrounding conversation less intelligible.
 *
 * That goal has an actual standardised metric — the Articulation Index
 * (ASTM E1130 for open-plan spaces; the modern successor is the Speech
 * Intelligibility Index, ANSI S3.5-1997). AI runs 0 (unintelligible) to 1
 * (fully intelligible), and open-plan acoustics treats roughly:
 *
 *     AI <= 0.15   confidential privacy
 *     0.15 - 0.30  normal privacy
 *     >= 0.45      poor privacy — speech is distracting and followable
 *
 * Being able to compute a number does not mean the number is trustworthy in
 * this product. See the honesty note on `articulationIndex` below: the app
 * cannot observe playback level, so any AI it reports is conditional on a
 * stated assumption, and must be presented that way.
 */

/** Octave-band centre frequencies used throughout, in Hz. */
export const OCTAVE_BANDS = [250, 500, 1000, 2000, 4000, 8000] as const;

/**
 * Band importance weights from ANSI S3.5-1997 (Speech Intelligibility
 * Index), octave-band procedure. They sum to 1 and encode how much each
 * band contributes to understanding speech — note the 1-4 kHz bands carry
 * over 70% of it, which is why masking effort concentrates there.
 */
export const SII_BAND_WEIGHTS = [0.0617, 0.1671, 0.2373, 0.2648, 0.2142, 0.0549] as const;

/**
 * Long-term average speech spectrum for a raised-conversational voice at
 * ~1 m, in dB SPL per octave band. Representative textbook values, not a
 * measurement of any particular talker — treat as an assumption, not data.
 */
export const LTASS_NORMAL_DB = [57, 57, 54, 49, 43, 36] as const;

/**
 * The classic AI speech dynamic range: intelligibility is carried between
 * 12 dB above the long-term average (peaks) and 18 dB below it (valleys),
 * a 30 dB window.
 */
const SPEECH_PEAK_ABOVE_LTASS = 12;
const SPEECH_DYNAMIC_RANGE = 30;

/**
 * Predicted Articulation Index for a given intruding-speech spectrum
 * against a given masker spectrum, both in dB SPL per octave band.
 *
 * ## Honesty note — read before surfacing this number
 *
 * A web app cannot know the sound pressure level at the user's ear. It does
 * not know their headphones, their system volume, or the actual level of
 * the conversation two desks away. Every one of those is required to state
 * an AI figure as fact.
 *
 * What this function computes is therefore strictly conditional: "given a
 * talker at level X and a masker at level Y, predicted AI is Z". The
 * assumptions must travel with the number wherever it is displayed. What
 * the engine genuinely controls, and can honestly claim, is the *shape* of
 * the masker spectrum — see `spectrumEfficiency`.
 */
export function articulationIndex(speechDb: readonly number[], maskerDb: readonly number[]): number {
  let ai = 0;
  for (let i = 0; i < OCTAVE_BANDS.length; i++) {
    const speechPeak = (speechDb[i] ?? 0) + SPEECH_PEAK_ABOVE_LTASS;
    const headroom = speechPeak - (maskerDb[i] ?? 0);
    // Fraction of the 30 dB speech window that clears the masker.
    const audible = Math.min(1, Math.max(0, headroom / SPEECH_DYNAMIC_RANGE));
    ai += SII_BAND_WEIGHTS[i] * audible;
  }
  return Math.min(1, Math.max(0, ai));
}

/** Plain-language band for an AI value, per open-plan acoustics convention. */
export function privacyRating(ai: number): "confidential" | "normal" | "marginal" | "poor" {
  if (ai <= 0.15) return "confidential";
  if (ai <= 0.3) return "normal";
  if (ai < 0.45) return "marginal";
  return "poor";
}

/**
 * Masking target spectrum, in dB relative to the band with the most energy.
 *
 * Two competing requirements shape this curve. Masking effectiveness wants
 * energy concentrated where the SII weights are highest (1-4 kHz). Comfort
 * wants it rolled off up there, because a masker with a bright, hissy
 * spectrum is itself annoying and people turn it down — at which point it
 * masks nothing. Commercial masking systems resolve this by following the
 * speech spectrum's own shape with a gentle additional tilt, which is what
 * this curve does.
 */
export const MASKING_TARGET_DB = [-6, -2, 0, -2, -7, -18] as const;

/**
 * How efficiently a given masker spectrum spends its energy on masking
 * speech, 0..1. Unlike `articulationIndex` this is level-independent — it
 * compares the *shape* against the SII-weighted ideal — so it is a claim
 * the engine can actually stand behind.
 *
 * 1.0 means every dB of masker energy sits exactly where speech
 * intelligibility lives; a flat white-noise masker scores substantially
 * lower because it wastes energy at frequencies that carry little speech.
 */
export function spectrumEfficiency(maskerDb: readonly number[]): number {
  // Convert to linear power, normalised to sum 1 — the energy distribution.
  const power: number[] = [];
  let total = 0;
  for (let i = 0; i < OCTAVE_BANDS.length; i++) {
    const p = Math.pow(10, (maskerDb[i] ?? -120) / 10);
    power.push(p);
    total += p;
  }
  if (total <= 0) return 0;

  // Overlap between the energy distribution and the importance weights.
  // The maximum achievable value is the same overlap for a masker whose
  // energy follows the weights exactly, so normalise by that.
  let overlap = 0;
  let ideal = 0;
  for (let i = 0; i < OCTAVE_BANDS.length; i++) {
    overlap += (power[i] / total) * SII_BAND_WEIGHTS[i];
    ideal += SII_BAND_WEIGHTS[i] * SII_BAND_WEIGHTS[i];
  }
  return Math.min(1, overlap / ideal);
}

/** Bark scale, matching the warp used by the spectral bed. */
function hzToBark(f: number): number {
  return 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan(Math.pow(f / 7500, 2));
}

/** Invert the Bark warp by bisection — no closed form exists. */
function barkToHz(bark: number): number {
  let lo = 20;
  let hi = 20000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (hzToBark(mid) < bark) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Render the masking target onto the spectral bed's Bark-spaced bands.
 *
 * The bed synthesises from 14 bands warped over 0-24 Bark; this maps the
 * octave-band dB curve onto those bands by log-frequency interpolation and
 * converts to the linear gains the bed expects.
 */
export function maskingBedEnvelope(bands: number, into?: Float32Array): Float32Array {
  const out = into && into.length >= bands ? into : new Float32Array(bands);
  for (let i = 0; i < bands; i++) {
    const f = barkToHz((i / (bands - 1)) * 24);
    out[i] = dbAtFrequency(f);
  }
  // Normalise so the loudest band is unity; overall level stays the bed's job.
  let peak = 0;
  for (let i = 0; i < bands; i++) peak = Math.max(peak, out[i]);
  if (peak > 0) for (let i = 0; i < bands; i++) out[i] /= peak;
  return out;
}

/** Linear gain of the masking curve at an arbitrary frequency. */
function dbAtFrequency(f: number): number {
  const clamped = Math.min(Math.max(f, OCTAVE_BANDS[0]), OCTAVE_BANDS[OCTAVE_BANDS.length - 1]);
  // Annotated: `as const` on the table would otherwise narrow this to the
  // literal type of the first entry.
  let db: number = MASKING_TARGET_DB[0];
  for (let i = 0; i < OCTAVE_BANDS.length - 1; i++) {
    const f0 = OCTAVE_BANDS[i];
    const f1 = OCTAVE_BANDS[i + 1];
    if (clamped >= f0 && clamped <= f1) {
      const t = Math.log2(clamped / f0) / Math.log2(f1 / f0);
      db = MASKING_TARGET_DB[i] + (MASKING_TARGET_DB[i + 1] - MASKING_TARGET_DB[i]) * t;
      break;
    }
    if (clamped > f1) db = MASKING_TARGET_DB[i + 1];
  }
  // Roll off below the lowest octave band so the bed keeps some low warmth
  // without wasting energy where speech carries almost nothing.
  if (f < OCTAVE_BANDS[0]) db = MASKING_TARGET_DB[0] - 6 * Math.log2(OCTAVE_BANDS[0] / Math.max(20, f));
  return Math.pow(10, db / 20);
}

/**
 * The speech syllabic modulation band, in Hz.
 *
 * Speech's temporal-envelope modulation spectrum peaks around 3.9-4.8 Hz,
 * matching mean syllable rate, and syllable rates run roughly 4-8 Hz across
 * talkers and languages. Envelope fluctuation in this band is what carries
 * syllable-pattern information — so a non-speech texture that fluctuates
 * here is doing the one thing most likely to engage verbal processing.
 *
 * Bounds are set slightly wider than the peak to cover the range across
 * speakers, and slightly lower to catch the phrase-rate skirt.
 */
export const SYLLABIC_BAND_HZ = { low: 2, high: 8 } as const;

/**
 * Largest event rate that stays clear of the syllabic band.
 *
 * Sparse is the right side to fall off. Going *above* 8 Hz would also avoid
 * the band, but at that rate discrete events fuse into a continuous buzz
 * and the mode stops being quiet — which defeats the point for reading.
 */
export const SUB_SYLLABIC_MAX_RATE_HZ = 1.4;
