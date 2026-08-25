import { protocolById, type Protocol } from "../protocols.js";
import type { PersonalRhythmModel, RhythmGoal, RhythmWindow } from "./model.js";

/**
 * Rhythm-driven protocol scheduling.
 *
 * This is the payoff for building the Rhythm Model: instead of the user
 * picking a protocol from a list and deciding when to run it, the model
 * forecasts their own favourable windows and proposes a protocol *and a
 * start time* to fit one.
 *
 * Two product rules are enforced here rather than left to the UI, because
 * they are ethics-of-attention requirements from the spec and should not be
 * re-litigated per surface:
 *
 *  1. **Propose, never start.** A suggestion is data. Nothing in this module
 *     begins a session, and the UI must require an explicit tap. An app that
 *     starts playing audio because a model predicted you'd want it is a dark
 *     pattern regardless of how good the prediction is.
 *
 *  2. **Silence is a valid output.** `suggestNext` returns null whenever the
 *     model is not ready or no window clears the confidence floor. There is
 *     no fallback to "suggest something anyway" — a product whose success
 *     metric is user state, not engagement, has no reason to manufacture a
 *     prompt.
 */

/** Which protocol serves which forecast goal. */
const GOAL_TO_PROTOCOL: Record<RhythmGoal, string> = {
  focus: "deep-work",
  windDown: "wind-down",
  recovery: "recovery",
};

export interface ProtocolSuggestion {
  goal: RhythmGoal;
  protocol: Protocol;
  window: RhythmWindow;
  /** When to begin so the protocol sits inside the window. */
  startAtMs: number;
  /** Minutes from now until `startAtMs`. Negative means it is open now. */
  minutesUntilStart: number;
  /** True when the window is already open. */
  openNow: boolean;
  /** Plain-language rationale for the "why now" surface. */
  reason: string;
}

/** How far ahead to look. Two days, per the spec's 24-48h forecast target. */
const DEFAULT_HORIZON_HOURS = 48;

/**
 * Do not propose something starting further out than this — a suggestion for
 * tomorrow afternoon is noise at 9am today.
 */
const MAX_LEAD_MINUTES = 240;

function describeWhen(minutesUntil: number): string {
  if (minutesUntil <= 5) return "now";
  if (minutesUntil < 60) return `in ${Math.round(minutesUntil)} min`;
  const hours = minutesUntil / 60;
  return `in about ${hours < 2 ? "an hour" : `${Math.round(hours)} hours`}`;
}

function reasonFor(goal: RhythmGoal, window: RhythmWindow, minutesUntil: number): string {
  const when = describeWhen(minutesUntil);
  switch (goal) {
    case "focus":
      return `Your steadiest stretch of the day usually starts ${when}, going by your own readings.`;
    case "windDown":
      return `You typically start settling ${when} — a wind-down session lines up with that rather than fighting it.`;
    case "recovery":
      return `You tend to run hot ${when}. That's when a recovery session has something to work with.`;
  }
}

/**
 * The single best upcoming suggestion, or null.
 *
 * Ranking is by imminence, not by predicted magnitude: a strong window
 * tomorrow is less useful than a decent one this afternoon, and ranking by
 * "strength" would push the product toward always finding something
 * impressive to say.
 */
export function suggestNext(
  model: PersonalRhythmModel,
  nowMs: number,
  horizonHours = DEFAULT_HORIZON_HOURS,
): ProtocolSuggestion | null {
  if (!model.isReady()) return null;

  const candidates: ProtocolSuggestion[] = [];

  for (const goal of Object.keys(GOAL_TO_PROTOCOL) as RhythmGoal[]) {
    const window = model.nextWindow(nowMs, horizonHours, goal);
    if (!window) continue;

    const protocol = protocolById(GOAL_TO_PROTOCOL[goal]);
    if (!protocol) continue;

    const startAtMs = Math.max(nowMs, window.startMs);
    const minutesUntilStart = (startAtMs - nowMs) / 60000;
    if (minutesUntilStart > MAX_LEAD_MINUTES) continue;

    candidates.push({
      goal,
      protocol,
      window,
      startAtMs,
      minutesUntilStart,
      openNow: window.startMs <= nowMs && window.endMs > nowMs,
      reason: reasonFor(goal, window, minutesUntilStart),
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.minutesUntilStart - b.minutesUntilStart);
  return candidates[0];
}

/** All upcoming windows across every goal, for a schedule view. */
export function upcomingWindows(
  model: PersonalRhythmModel,
  nowMs: number,
  horizonHours = DEFAULT_HORIZON_HOURS,
): RhythmWindow[] {
  if (!model.isReady()) return [];
  const all: RhythmWindow[] = [];
  for (const goal of Object.keys(GOAL_TO_PROTOCOL) as RhythmGoal[]) {
    all.push(...model.findWindows(nowMs, horizonHours, goal));
  }
  all.sort((a, b) => a.startMs - b.startMs);
  return all;
}
