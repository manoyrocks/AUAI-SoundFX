import type { AnchorName } from "@soundfx/engine";

/**
 * Sound-science grounding for each mode.
 *
 * Every mode in this product should be able to answer "why does this exist
 * and what is it based on?" in the user's own interface, including when the
 * honest answer is "weaker evidence than the others". This module is the
 * single source for that copy, so the claims audit has one place to check
 * (docs/07-claims.md) and the UI cannot drift from it.
 *
 * Evidence levels are deliberately coarse and deliberately visible:
 *
 *   established  — replicated across labs over decades, or standardised
 *                  engineering practice. Safe to describe as known.
 *   moderate     — real published findings, but with meaningful caveats:
 *                  fewer replications, contested mechanism, or conditions
 *                  this product cannot reproduce.
 *   mechanism    — the underlying phenomenon is well established, but its
 *                  application here is our engineering inference, not a
 *                  tested result.
 *
 * Nothing in this file may claim a therapeutic or medical effect. These are
 * descriptions of acoustic design intent grounded in cognitive and
 * psychoacoustic literature, not treatment claims. See docs/06-safety.md.
 */

export type EvidenceLevel = "established" | "moderate" | "mechanism";

export interface Citation {
  /** Short reference as a reader would look it up. */
  ref: string;
  /** What this specific source supports — not a general endorsement. */
  supports: string;
}

export interface ModeScience {
  mode: AnchorName;
  label: string;
  /** One line, shown under the mode name. */
  tagline: string;
  /** What the sound actually does, acoustically. */
  design: string;
  /** The finding the design is derived from. */
  mechanism: string;
  evidence: EvidenceLevel;
  citations: Citation[];
  /** What this mode does NOT establish. Always populated. */
  limitations: string;
}

export const MODE_SCIENCE: Record<string, ModeScience> = {
  read: {
    mode: "read",
    label: "Read",
    tagline: "For reading, writing, editing — anything that holds words in order.",
    design:
      "Almost no discrete events; a continuous bed carries the sound. Its amplitude " +
      "fluctuation is filtered to stay below 1 Hz, clear of the 2–8 Hz band where " +
      "speech lives. Pitch is nearly static, and the drone's detune is narrowed so " +
      "its beating drops below the same band.",
    mechanism:
      "Verbal working memory is disrupted less by loudness than by acoustic change " +
      "between successive sounds — the changing-state effect. A background that keeps " +
      "presenting new, distinguishable events interferes with holding words in order; " +
      "a steady one barely does. Speech's own envelope modulation peaks near 4–5 Hz, " +
      "matching syllable rate, so that band is the one worth staying out of.",
    evidence: "established",
    citations: [
      {
        ref: "Salamé & Baddeley (1982), J. Verbal Learning & Verbal Behavior",
        supports: "Irrelevant speech disrupts serial recall even when meaningless to the listener.",
      },
      {
        ref: "Jones & Macken — changing-state hypothesis",
        supports:
          "Disruption tracks acoustic change between successive tokens, not speech content; steady-state sequences disrupt far less.",
      },
      {
        ref: "Ding et al. (2017), Neurosci. & Biobehav. Reviews",
        supports: "Speech temporal-envelope modulation spectrum peaks at roughly 3.9–4.8 Hz.",
      },
    ],
    limitations:
      "The acoustic constraint is measured and verified in our own test suite. Whether " +
      "it improves your reading has not been tested with users — the literature is about " +
      "background sound disrupting verbal tasks, not about this engine helping them.",
  },

  open: {
    mode: "open",
    label: "Open",
    tagline: "For ideation and divergent thinking — deliberately less comfortable.",
    design:
      "Busier and more varied than Deep Work: wider latent wandering, a larger reachable " +
      "harmonic region, and a higher event rate. Optimised for variety and mild " +
      "unpredictability rather than for staying out of the way.",
    mechanism:
      "Moderate ambient noise has been found to improve performance on creative tasks " +
      "relative to quiet, with the proposed route being increased processing difficulty " +
      "raising construal level and promoting abstract thought. High noise reverses it.",
    evidence: "moderate",
    citations: [
      {
        ref: "Mehta, Zhu & Cheema (2012), J. Consumer Research 39(4)",
        supports:
          "Across five experiments, 70 dB ambient noise improved creative-task performance versus 50 dB; 85 dB impaired it.",
      },
    ],
    limitations:
      "The original effect is defined by absolute sound level, which no app can observe " +
      "or control — we do not know your volume setting or your headphones. This mode " +
      "shapes character, not level, so it is an interpretation of the finding rather " +
      "than a reproduction of it. The construal-level mechanism is also contested.",
  },

  screen: {
    mode: "screen",
    label: "Screen",
    tagline: "For shared and open-plan spaces — makes nearby conversation harder to follow.",
    design:
      "The only mode with an acoustic rather than emotional target. The bed's spectrum " +
      "is set directly from a speech-masking curve instead of by the decoder, " +
      "concentrating energy in the 1–4 kHz region that carries most speech information " +
      "while rolling off above it so the masker does not become hissy. Essentially no " +
      "events, and reverb is minimised because it would smear the shaped spectrum.",
    mechanism:
      "Speech intelligibility can be predicted from the band-by-band signal-to-noise " +
      "ratio weighted by each band's contribution to understanding — the Articulation " +
      "Index. A masker shaped to those weights buys more privacy per decibel than flat " +
      "or pink noise.",
    evidence: "established",
    citations: [
      {
        ref: "ANSI S3.5-1997 (Speech Intelligibility Index)",
        supports: "Octave-band importance weights used to compute the masking efficiency figure.",
      },
      {
        ref: "ASTM E1130 (Objective Measurement of Speech Privacy in Open Plan Spaces)",
        supports: "Articulation Index method and the privacy bands used to interpret it.",
      },
    ],
    limitations:
      "We can report how efficiently the spectrum is shaped, because that is something " +
      "the engine controls. We cannot report your actual speech privacy: that depends on " +
      "playback level, your headphones, and how loud the people near you are — none of " +
      "which a web app can measure.",
  },

  move: {
    mode: "move",
    label: "Move",
    tagline: "For walking, running, repetitive movement — locks to your cadence.",
    design:
      "The one mode that wants a perceivable pulse. Onset timing is driven by a renewal " +
      "process whose shape parameter is pushed high enough to make events near-periodic, " +
      "and its rate is set from your cadence in steps per minute rather than from a " +
      "musical tempo. Every other mode does the opposite, deliberately.",
    mechanism:
      "Auditory-motor entrainment: movement tends to synchronise involuntarily with a " +
      "perceived beat. Matching the beat to actual cadence is what makes the coupling " +
      "available — a beat at the wrong rate gives nothing to lock onto.",
    evidence: "mechanism",
    citations: [
      {
        ref: "Thaut et al. — rhythmic auditory stimulation",
        supports: "Auditory-motor coupling entrains gait timing; the basis of RAS in movement rehabilitation.",
      },
      {
        ref: "Van Dyck et al. (2013), PLOS ONE 8(8)",
        supports: "Runners spontaneously entrain cadence to music tempo within a limited range of tempo change.",
      },
    ],
    limitations:
      "Entrainment itself is well established; that this engine's synthesised pulse " +
      "produces it as reliably as music has not been tested. Automatic cadence detection " +
      "needs motion-sensor access and has only been verified against synthetic traces, " +
      "so cadence can also be entered by hand.",
  },
};

export function scienceFor(mode: AnchorName): ModeScience | undefined {
  return MODE_SCIENCE[mode];
}

/** Human-readable label for the evidence badge. */
export function evidenceLabel(level: EvidenceLevel): string {
  switch (level) {
    case "established":
      return "well established";
    case "moderate":
      return "moderate evidence";
    case "mechanism":
      return "mechanism established, application untested";
  }
}
