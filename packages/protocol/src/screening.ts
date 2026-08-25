/**
 * Contraindication screening.
 *
 * Part 6: "no entrainment techniques contraindicated for epilepsy/arrhythmia
 * without screening."
 *
 * Design stance, and why this is narrow on purpose:
 *
 * This is NOT a health questionnaire and must never become one. SoundFX is
 * a wellness product, not a medical device — asking users to self-report
 * diagnoses would (a) collect sensitive health data we have promised not to
 * collect, and (b) imply a clinical competence the product does not have.
 *
 * So screening is inverted: instead of asking "do you have epilepsy?", the
 * product asks nothing by default and simply *does not enable* techniques
 * with known contraindications. A feature that carries a contraindication
 * is gated behind an explicit, informed, per-feature opt-in that states the
 * contraindication plainly and lets the user decide — no diagnosis
 * disclosed, no health data stored, no medical judgement made by us.
 *
 * The stored artefact is therefore a set of *feature acknowledgements*
 * ("this user has read the note about rhythmic pulsing and enabled it"),
 * never a health record.
 */

/**
 * Techniques whose safety profile is not universal. Anything added here is
 * off unless explicitly acknowledged.
 */
export type GatedTechnique =
  /**
   * Binaural beats and isochronic pulsing in the ~3-30 Hz band, i.e.
   * amplitude/frequency modulation intended to drive neural entrainment.
   * Photosensitive-epilepsy guidance concerns visual flicker in this band;
   * the auditory analogue is less well characterised, which is precisely
   * why this is opt-in and labelled experimental rather than default-on.
   */
  | "rhythmicEntrainment"
  /**
   * Heart-rate-paced tempo, where the soundscape's pulse is locked to (or
   * deliberately led away from) the user's measured heart rate. Excluded by
   * default for anyone managing an arrhythmia: a soundscape that chases a
   * misdetected beat can produce a confusing or distressing experience.
   */
  | "cardiacPacing"
  /**
   * Sustained low-frequency content below ~40 Hz at levels intended to be
   * felt rather than heard.
   */
  | "infrasonicBass";

export interface TechniqueInfo {
  id: GatedTechnique;
  label: string;
  /** Plain-language statement of who should not enable this, and why. */
  contraindication: string;
  /** True when the underlying mechanism is not well-established. */
  experimental: boolean;
}

export const GATED_TECHNIQUES: readonly TechniqueInfo[] = [
  {
    id: "rhythmicEntrainment",
    label: "Rhythmic entrainment (binaural / pulsing)",
    contraindication:
      "Not recommended if you have epilepsy or are photosensitive. Stop immediately if you feel dizzy, disoriented, or unwell.",
    experimental: true,
  },
  {
    id: "cardiacPacing",
    label: "Heart-rate-paced tempo",
    contraindication:
      "Not recommended if you are managing an arrhythmia or any heart-rhythm condition. This uses a webcam estimate of your pulse, which can be wrong.",
    experimental: true,
  },
  {
    id: "infrasonicBass",
    label: "Sub-bass you feel more than hear",
    contraindication: "Not recommended if you have an inner-ear condition or experience motion sensitivity.",
    experimental: false,
  },
] as const;

export type TechniqueConsent = Partial<Record<GatedTechnique, boolean>>;

/**
 * The single gate every caller must pass through. Default-deny: an unknown
 * or absent acknowledgement is treated as "not enabled", so forgetting to
 * wire consent through fails closed (silent) rather than open (unsafe).
 */
export function isTechniqueEnabled(consent: TechniqueConsent, technique: GatedTechnique): boolean {
  return consent[technique] === true;
}

export function techniqueInfo(id: GatedTechnique): TechniqueInfo {
  const found = GATED_TECHNIQUES.find((t) => t.id === id);
  if (!found) throw new Error(`Unknown gated technique: ${id}`);
  return found;
}

/** Techniques currently switched on — used for the "what's active" surface. */
export function enabledTechniques(consent: TechniqueConsent): TechniqueInfo[] {
  return GATED_TECHNIQUES.filter((t) => isTechniqueEnabled(consent, t.id));
}
