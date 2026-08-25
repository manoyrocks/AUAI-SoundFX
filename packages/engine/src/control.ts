/**
 * The ControlVector is the single contract between *intelligence* and *sound*.
 *
 * Everything upstream — the state estimator, the safe-RL controller, the
 * copilot, the protocol scheduler — speaks only this language. Everything
 * downstream (neural decoder, voices, spatialiser, haptics, light, visuals)
 * consumes only this. No component ever names a stem, a sample, a preset or a
 * "sound pack", because none exist: the vector *is* the composition.
 *
 * This is the structural break from stem-recombination engines. There, the
 * adaptation layer selects and gates pre-authored material. Here, the
 * adaptation layer moves a point through a continuous latent space and the
 * waveform is synthesised from scratch at that point, sample by sample.
 */
export interface ControlVector {
  /** Affective pleasantness. -1 sombre/minor-leaning, +1 bright/consonant. */
  valence: number;
  /** Activation. 0 near-motionless, 1 alert and eventful. */
  arousal: number;
  /** Event rate of the stochastic note field, 0 sparse .. 1 dense. */
  density: number;
  /** Underlying pulse in BPM. Not a metronome — it biases the point process. */
  tempo: number;
  /** Harmonic tension: how far up the prime limit the lattice walk may step. */
  tension: number;
  /** Spectral centroid bias, 0 dark .. 1 open. */
  brightness: number;
  /** Broadband spectral-bed level ("air"). */
  air: number;
  /** Spatial and pitch movement, 0 static .. 1 drifting. */
  motion: number;
  /** Perceived space: reverb time and size, 0 intimate .. 1 cavernous. */
  depth: number;
  /**
   * Structural complexity — the cognitive-load dial. 0 gives near-flat,
   * attention-transparent texture; 1 gives melodic figures that pull focus.
   */
  complexity: number;
}

export const CONTROL_KEYS: readonly (keyof ControlVector)[] = [
  "valence",
  "arousal",
  "density",
  "tempo",
  "tension",
  "brightness",
  "air",
  "motion",
  "depth",
  "complexity",
] as const;

export interface Range {
  min: number;
  max: number;
  /** Maximum permitted change per second. The controller physically cannot jerk. */
  maxRatePerSec: number;
}

export const CONTROL_RANGES: Record<keyof ControlVector, Range> = {
  valence: { min: -1, max: 1, maxRatePerSec: 0.08 },
  arousal: { min: 0, max: 1, maxRatePerSec: 0.05 },
  density: { min: 0, max: 1, maxRatePerSec: 0.06 },
  tempo: { min: 30, max: 120, maxRatePerSec: 1.5 },
  tension: { min: 0, max: 1, maxRatePerSec: 0.05 },
  brightness: { min: 0, max: 1, maxRatePerSec: 0.07 },
  air: { min: 0, max: 1, maxRatePerSec: 0.1 },
  motion: { min: 0, max: 1, maxRatePerSec: 0.06 },
  depth: { min: 0, max: 1, maxRatePerSec: 0.05 },
  complexity: { min: 0, max: 1, maxRatePerSec: 0.04 },
};

export function clampControl(v: ControlVector): ControlVector {
  const out = { ...v };
  for (const k of CONTROL_KEYS) {
    const r = CONTROL_RANGES[k];
    out[k] = Math.min(r.max, Math.max(r.min, out[k]));
  }
  return out;
}

/**
 * Rate-limit a move from `current` toward `target` over `dt` seconds.
 *
 * This is a hard safety mechanism, not a smoothing nicety: it is what
 * guarantees a sleep session can never spike arousal even if the controller,
 * the copilot or a malformed protocol asks it to. See docs/06-safety.md.
 */
export function slewToward(current: ControlVector, target: ControlVector, dt: number): ControlVector {
  const out = { ...current };
  for (const k of CONTROL_KEYS) {
    const r = CONTROL_RANGES[k];
    const maxStep = r.maxRatePerSec * dt;
    const delta = target[k] - current[k];
    out[k] = current[k] + Math.max(-maxStep, Math.min(maxStep, delta));
    out[k] = Math.min(r.max, Math.max(r.min, out[k]));
  }
  return out;
}

/** Linear interpolation between two vectors — used by protocol phase ramps. */
export function lerpControl(a: ControlVector, b: ControlVector, t: number): ControlVector {
  const out = {} as ControlVector;
  const u = Math.min(1, Math.max(0, t));
  for (const k of CONTROL_KEYS) out[k] = a[k] + (b[k] - a[k]) * u;
  return out;
}

/** Euclidean distance in normalised control space — used by the N-of-1 engine. */
export function controlDistance(a: ControlVector, b: ControlVector): number {
  let acc = 0;
  for (const k of CONTROL_KEYS) {
    const r = CONTROL_RANGES[k];
    const span = r.max - r.min;
    const d = (a[k] - b[k]) / span;
    acc += d * d;
  }
  return Math.sqrt(acc);
}

/** Pack to a Float32Array in CONTROL_KEYS order (wire format to the worklet). */
export function packControl(v: ControlVector, into?: Float32Array): Float32Array {
  const out = into ?? new Float32Array(CONTROL_KEYS.length);
  for (let i = 0; i < CONTROL_KEYS.length; i++) out[i] = v[CONTROL_KEYS[i]];
  return out;
}

export function unpackControl(a: ArrayLike<number>): ControlVector {
  const out = {} as ControlVector;
  for (let i = 0; i < CONTROL_KEYS.length; i++) out[CONTROL_KEYS[i]] = a[i];
  return out;
}

/**
 * Normalised [0,1] view used as neural-decoder input, so the network never sees
 * raw BPM or signed valence.
 */
export function normaliseControl(v: ControlVector, into?: Float32Array): Float32Array {
  const out = into ?? new Float32Array(CONTROL_KEYS.length);
  for (let i = 0; i < CONTROL_KEYS.length; i++) {
    const k = CONTROL_KEYS[i];
    const r = CONTROL_RANGES[k];
    out[i] = (v[k] - r.min) / (r.max - r.min);
  }
  return out;
}

/**
 * Anchor presets. These are *starting points* for the controller's search, not
 * destinations — the per-user dose-response model moves away from them within
 * days. They exist so a cold-start user hears something sensible in <2s.
 */
export const ANCHORS = {
  deepWork: {
    valence: 0.1,
    arousal: 0.42,
    density: 0.34,
    tempo: 62,
    tension: 0.18,
    brightness: 0.44,
    air: 0.55,
    motion: 0.25,
    depth: 0.5,
    complexity: 0.16,
  },
  calm: {
    valence: 0.35,
    arousal: 0.2,
    density: 0.22,
    tempo: 50,
    tension: 0.12,
    brightness: 0.38,
    air: 0.62,
    motion: 0.35,
    depth: 0.66,
    complexity: 0.26,
  },
  sleep: {
    valence: 0.15,
    arousal: 0.05,
    density: 0.1,
    tempo: 40,
    tension: 0.06,
    brightness: 0.16,
    air: 0.78,
    motion: 0.16,
    depth: 0.74,
    complexity: 0.06,
  },
  energy: {
    valence: 0.55,
    arousal: 0.78,
    density: 0.62,
    tempo: 96,
    tension: 0.34,
    brightness: 0.72,
    air: 0.34,
    motion: 0.55,
    depth: 0.34,
    complexity: 0.5,
  },
  recovery: {
    valence: 0.3,
    arousal: 0.14,
    density: 0.16,
    tempo: 45,
    tension: 0.1,
    brightness: 0.28,
    air: 0.7,
    motion: 0.28,
    depth: 0.7,
    complexity: 0.12,
  },

  /**
   * Read — for verbal serial tasks: reading, writing, editing, mental
   * arithmetic. Not a synonym for Deep Work.
   *
   * The irrelevant-sound literature is specific about what disrupts verbal
   * working memory, and it is not loudness: it is *acoustic change between
   * successive tokens* (the changing-state hypothesis). A sound that keeps
   * presenting new, distinguishable events disrupts serial recall; a
   * steady-state one barely does.
   *
   * That is an uncomfortable finding for this engine, because never
   * repeating is its headline property. So Read deliberately runs the
   * engine against its own grain: near-zero latent drift, a tiny reachable
   * lattice region, and almost no discrete events — the continuous bed
   * carries the sound instead. Dark, because energy in the 1-4 kHz formant
   * region is what makes a texture read as voice-like.
   *
   * See docs/09-sound-science.md.
   */
  read: {
    valence: 0.15,
    arousal: 0.38,
    density: 0.12,
    tempo: 46,
    tension: 0.08,
    brightness: 0.3,
    air: 0.7,
    motion: 0.1,
    depth: 0.55,
    complexity: 0.04,
  },

  /**
   * Open — for divergent thinking, ideation, and problem-finding.
   *
   * Deliberately busier and less comfortable than Deep Work. Mehta, Zhu &
   * Cheema (2012) found moderate ambient noise improved creative-task
   * performance relative to quiet, with processing disfluency raising
   * construal level and promoting abstract thought. So this anchor
   * optimises for variety and mild unpredictability rather than for
   * attentional transparency.
   *
   * Honest caveat: that study's effect is defined by absolute sound level
   * (70 dB), which an app cannot control or even observe — see
   * docs/07-claims.md. What this mode controls is character, not level.
   */
  open: {
    valence: 0.45,
    arousal: 0.58,
    density: 0.62,
    tempo: 74,
    tension: 0.48,
    brightness: 0.6,
    air: 0.5,
    motion: 0.65,
    depth: 0.55,
    complexity: 0.58,
  },

  /**
   * Screen — speech masking for shared and open-plan spaces.
   *
   * The only mode whose goal is acoustic rather than affective: reduce the
   * intelligibility of surrounding conversation. Judged by predicted
   * Articulation Index (ASTM E1130), not by how it feels.
   *
   * Almost no discrete events — a masker should be spectrally dense and
   * temporally featureless, because anything eventful draws the attention
   * it is supposed to be protecting. Dry, because reverb smears the
   * carefully-shaped masking spectrum.
   */
  screen: {
    valence: 0.1,
    arousal: 0.3,
    density: 0.06,
    tempo: 44,
    tension: 0.05,
    brightness: 0.55,
    air: 0.95,
    motion: 0.12,
    depth: 0.3,
    complexity: 0.03,
  },

  /**
   * Move — walking, running, repetitive movement.
   *
   * Built around auditory-motor entrainment: the involuntary tendency to
   * synchronise movement to a perceived beat. `complexity` is pushed near
   * its ceiling because that dial sets the shape parameter of the onset
   * renewal process — at 0.92 the gamma shape reaches ~11, which makes
   * onsets near-periodic. Every other mode uses low complexity precisely to
   * avoid a perceivable pulse; this is the one mode that wants one.
   */
  move: {
    valence: 0.6,
    arousal: 0.82,
    density: 0.7,
    tempo: 84,
    tension: 0.3,
    brightness: 0.68,
    air: 0.3,
    motion: 0.5,
    depth: 0.28,
    complexity: 0.92,
  },
} satisfies Record<string, ControlVector>;

export type AnchorName = keyof typeof ANCHORS;

export function anchor(name: AnchorName): ControlVector {
  return { ...ANCHORS[name] };
}

/**
 * Hard synthesis rules, layered on top of the ControlVector.
 *
 * The separation matters. The ControlVector is a continuous *aesthetic*
 * space — where the sound sits emotionally and texturally — and every
 * dimension is negotiable, slew-limited, and steerable by the controller.
 * Constraints are categorical *acoustic* rules that the synthesis must obey
 * regardless of where the vector currently is.
 *
 * Read's suppression of syllabic-rate modulation is the clearest example:
 * it is not "less of something" on a continuum, it is a forbidden band. It
 * could not be expressed as an anchor value, and the biofeedback controller
 * must not be able to negotiate it away while steering arousal.
 */
export interface SynthesisConstraints {
  /**
   * Keep the output's amplitude modulation out of the speech syllabic band
   * (~2-8 Hz). Speech's modulation spectrum peaks near 4-5 Hz, and that is
   * the band that carries syllable-pattern information. A texture that
   * fluctuates there is the closest a non-verbal sound gets to sounding
   * like talking, and it is the band verbal working memory is most
   * vulnerable to.
   */
  avoidSyllabicModulation: boolean;

  /**
   * Cap how many distinct pitches the harmonic walker may use. 0 leaves it
   * unbounded (the default: maximal variety, no recurrence).
   *
   * Directly implements the token-set-size finding — disruption of serial
   * recall grows with the number of distinguishable tokens in the
   * background stream. A small recurring set is the "steady-state"
   * condition that disrupts least.
   */
  maxTokenSet: number;

  /**
   * Replace the decoder's spectral-bed envelope with a speech-masking
   * target shaped for open-plan speech privacy.
   */
  maskingSpectrum: boolean;

  /**
   * Lock onset timing to an external cadence in steps per minute. 0 leaves
   * the engine free-running on ControlVector.tempo.
   */
  cadenceSpm: number;
}

export const DEFAULT_CONSTRAINTS: SynthesisConstraints = {
  avoidSyllabicModulation: false,
  maxTokenSet: 0,
  maskingSpectrum: false,
  cadenceSpm: 0,
};

/** The constraint set each mode implies. Modes not listed run unconstrained. */
export const MODE_CONSTRAINTS: Partial<Record<AnchorName, Partial<SynthesisConstraints>>> = {
  read: { avoidSyllabicModulation: true, maxTokenSet: 5 },
  screen: { maskingSpectrum: true, avoidSyllabicModulation: true },
  // Move sets cadenceSpm at runtime from measured or user-entered cadence.
};

export function constraintsFor(mode: AnchorName): SynthesisConstraints {
  return { ...DEFAULT_CONSTRAINTS, ...(MODE_CONSTRAINTS[mode] ?? {}) };
}
