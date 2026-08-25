/**
 * Distress detection and escalation.
 *
 * Part 6: "clear escalation copy for users showing signs of distress."
 *
 * Design stance — read this before changing any threshold:
 *
 * This module deliberately does NOT attempt to detect emotional distress,
 * panic, or a mental-health crisis from biosignals. That would be both
 * technically unsound (a webcam heart-rate estimate cannot distinguish
 * anxiety from caffeine, exercise, a warm room, or a detector artefact) and
 * ethically wrong (a wellness app inferring psychiatric state from a face
 * on camera is exactly the kind of thing this product should not do).
 *
 * What it does instead is narrow and defensible: it notices when the
 * product's own closed loop is *not working* — the user is in a calming
 * mode, the loop has been pushing toward calm for a sustained period, and
 * their measured arousal proxy has stayed elevated the whole time. That is
 * a statement about the intervention's efficacy for this session, not a
 * diagnosis of the person.
 *
 * The response is correspondingly modest: stop trying harder, say plainly
 * that the session doesn't seem to be helping, and surface support
 * resources without alarm or urgency. Never a popup, never a modal, never
 * anything that reads as "we think something is wrong with you."
 */

import type { AnchorName } from "@soundfx/engine";
import type { PhysiologyBaseline } from "./baseline.js";
import type { StateVector } from "./state.js";

/** Modes where sustained elevated arousal means the intervention isn't landing. */
const CALMING_MODES: ReadonlySet<AnchorName> = new Set<AnchorName>(["calm", "sleep", "recovery"]);

/** How long arousal must stay elevated before we say anything at all. */
const SUSTAINED_MS = 8 * 60 * 1000;

/** z-score above the personal baseline that counts as "elevated". */
const ELEVATED_Z = 1.2;

/** Minimum confident samples before this is allowed to fire at all. */
const MIN_SAMPLES = 30;

export type DistressLevel = "none" | "notLanding";

export interface DistressAssessment {
  level: DistressLevel;
  /** Copy to show. Empty when level is "none". */
  message: string;
  /** True when the controller should stop pushing and hold neutral. */
  shouldDisengage: boolean;
}

const NOT_LANDING_MESSAGE =
  "This session doesn't seem to be helping settle things, and that's okay — it doesn't work for everyone every time. " +
  "Feel free to stop whenever you like. If you're going through something difficult and want to talk to someone, " +
  "findahelpline.com lists free, confidential support lines in your country.";

/**
 * Tracks sustained elevation across a session.
 *
 * Stateful because the signal of interest is duration, not any instant.
 * Reset between sessions.
 */
export class DistressMonitor {
  private elevatedSinceMs: number | null = null;
  private confidentSamples = 0;
  private alreadyNotified = false;

  reset(): void {
    this.elevatedSinceMs = null;
    this.confidentSamples = 0;
    this.alreadyNotified = false;
  }

  /**
   * Feed each confident reading. Returns the current assessment.
   *
   * Fires at most once per session (`alreadyNotified`) — repeating the
   * message would turn a gentle offer into nagging, which is the exact
   * dark-pattern shape Part 6 rules out.
   */
  update(mode: AnchorName, state: StateVector, baseline: PhysiologyBaseline): DistressAssessment {
    const quiet: DistressAssessment = { level: "none", message: "", shouldDisengage: false };

    if (!CALMING_MODES.has(mode)) {
      this.elevatedSinceMs = null;
      return quiet;
    }
    if (state.heartRateBpm == null || state.heartRateConfidence < 0.3 || !baseline.hr.trusted) {
      return quiet;
    }

    this.confidentSamples++;
    const z = baseline.hr.zScore(state.heartRateBpm, 3);

    if (z < ELEVATED_Z) {
      // Any genuine settling resets the clock — we only care about
      // *sustained, uninterrupted* non-response.
      this.elevatedSinceMs = null;
      return quiet;
    }

    if (this.elevatedSinceMs == null) {
      this.elevatedSinceMs = state.timestampMs;
      return quiet;
    }

    const sustainedFor = state.timestampMs - this.elevatedSinceMs;
    if (sustainedFor >= SUSTAINED_MS && this.confidentSamples >= MIN_SAMPLES && !this.alreadyNotified) {
      this.alreadyNotified = true;
      return { level: "notLanding", message: NOT_LANDING_MESSAGE, shouldDisengage: true };
    }

    return quiet;
  }
}
