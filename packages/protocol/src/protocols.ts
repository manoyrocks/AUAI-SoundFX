import { ANCHORS, lerpControl, type AnchorName, type ControlVector } from "@soundfx/engine";

/**
 * Flagship protocols — timed, multi-phase sessions.
 *
 * A protocol is a schedule of control-vector waypoints with a duration and
 * an easing between them. Because the engine's entire interface is one
 * continuous vector, a "phase" needs no special machinery: it is a target
 * the scheduler interpolates toward, and the engine's own rate limiter
 * (control.ts::slewToward) still governs how fast anything is allowed to
 * actually move. A protocol can therefore never violate a safety bound by
 * scheduling an aggressive ramp — it can only ask, and the engine paces.
 *
 * The transition IS the composition: every intermediate point between two
 * phase waypoints is itself a valid, fully-synthesised soundscape that has
 * never existed before. There is no crossfade, because there are no two
 * fixed things to fade between.
 */

export interface ProtocolPhase {
  name: string;
  /** Minutes this phase lasts. */
  minutes: number;
  /** Target the engine is asked to reach by the END of this phase. */
  target: ControlVector;
  /** Shown in the UI to explain what this phase is for. */
  intent: string;
}

export interface Protocol {
  id: string;
  name: string;
  description: string;
  /** Mode used for safety clamping and controller anchoring. */
  mode: AnchorName;
  phases: ProtocolPhase[];
}

function withOverrides(base: ControlVector, overrides: Partial<ControlVector>): ControlVector {
  return { ...base, ...overrides };
}

export const PROTOCOLS: readonly Protocol[] = [
  {
    id: "deep-work",
    name: "Deep Work",
    description: "A 90-minute focus block shaped around a single ultradian cycle.",
    mode: "deepWork",
    phases: [
      {
        name: "Settle",
        minutes: 8,
        intent: "Lower the noise floor and let attention disengage from whatever came before.",
        target: withOverrides(ANCHORS.deepWork, { arousal: 0.3, density: 0.2, complexity: 0.1, air: 0.65 }),
      },
      {
        name: "Engage",
        minutes: 22,
        intent: "Build to a steady, low-complexity texture that supports sustained attention.",
        target: ANCHORS.deepWork,
      },
      {
        name: "Sustain",
        minutes: 45,
        intent: "Hold the working state. Deliberately the least eventful stretch — nothing here should recruit attention.",
        target: withOverrides(ANCHORS.deepWork, { complexity: 0.12, motion: 0.2, density: 0.3 }),
      },
      {
        name: "Release",
        minutes: 15,
        intent: "Ease out rather than stopping abruptly, so the end of the block doesn't feel like a jolt.",
        target: withOverrides(ANCHORS.deepWork, { arousal: 0.3, density: 0.18, air: 0.7, depth: 0.62 }),
      },
    ],
  },
  {
    id: "wind-down",
    name: "Wind-Down → Sleep",
    description: "A 45-minute descent from evening alertness into sleep onset.",
    mode: "sleep",
    phases: [
      {
        name: "Arrive",
        minutes: 10,
        intent: "Meet you roughly where the evening left you, rather than dropping straight to sleep settings.",
        target: withOverrides(ANCHORS.calm, { arousal: 0.24, brightness: 0.32, tempo: 52 }),
      },
      {
        name: "Descend",
        minutes: 20,
        intent: "A long, continuous decline in tempo, brightness, and event density.",
        target: withOverrides(ANCHORS.sleep, { arousal: 0.1, brightness: 0.22, tempo: 44, density: 0.14 }),
      },
      {
        name: "Sleep floor",
        minutes: 15,
        intent: "Settle to a near-static bed with occasional, very sparse detail. Intended to be left running.",
        target: ANCHORS.sleep,
      },
    ],
  },
  {
    id: "recovery",
    name: "Recovery",
    description: "A 20-minute parasympathetic reset for after strain — physical or otherwise.",
    mode: "recovery",
    phases: [
      {
        name: "Downshift",
        minutes: 6,
        intent: "Bring tempo and event density down quickly but smoothly.",
        target: withOverrides(ANCHORS.recovery, { arousal: 0.22, tempo: 52, density: 0.22 }),
      },
      {
        name: "Restore",
        minutes: 10,
        intent: "Warm, low, spacious. The longest-exhale part of the breath pacer sits here.",
        target: withOverrides(ANCHORS.recovery, { depth: 0.76, air: 0.74, brightness: 0.24 }),
      },
      {
        name: "Return",
        minutes: 4,
        intent: "Lift gently back toward baseline so you don't end the session groggy.",
        target: withOverrides(ANCHORS.recovery, { arousal: 0.2, brightness: 0.36, tempo: 50 }),
      },
    ],
  },
] as const;

export function protocolById(id: string): Protocol | undefined {
  return PROTOCOLS.find((p) => p.id === id);
}

export function protocolTotalMinutes(p: Protocol): number {
  return p.phases.reduce((sum, ph) => sum + ph.minutes, 0);
}

export interface ProtocolPosition {
  phaseIndex: number;
  phase: ProtocolPhase;
  /** 0..1 progress through the current phase. */
  phaseProgress: number;
  /** 0..1 progress through the whole protocol. */
  totalProgress: number;
  /** Interpolated control target at this instant. */
  target: ControlVector;
  /** True once the protocol has run past its final phase. */
  complete: boolean;
}

/**
 * Where a protocol is at `elapsedMinutes`, and what the engine should be
 * asked for right now.
 *
 * The target eases from the previous phase's endpoint toward the current
 * phase's endpoint, so waypoints connect continuously rather than stepping.
 */
export function protocolPositionAt(p: Protocol, elapsedMinutes: number): ProtocolPosition {
  const total = protocolTotalMinutes(p);
  const clamped = Math.max(0, elapsedMinutes);

  let acc = 0;
  for (let i = 0; i < p.phases.length; i++) {
    const phase = p.phases[i];
    const start = acc;
    const end = acc + phase.minutes;
    if (clamped < end || i === p.phases.length - 1) {
      const phaseProgress = phase.minutes > 0 ? Math.min(1, (clamped - start) / phase.minutes) : 1;
      const from = i === 0 ? p.phases[0].target : p.phases[i - 1].target;
      // Smoothstep rather than linear: phase boundaries have zero first
      // derivative, so nothing lurches at a waypoint.
      const t = phaseProgress * phaseProgress * (3 - 2 * phaseProgress);
      return {
        phaseIndex: i,
        phase,
        phaseProgress,
        totalProgress: total > 0 ? Math.min(1, clamped / total) : 1,
        target: lerpControl(from, phase.target, t),
        complete: clamped >= total,
      };
    }
    acc = end;
  }

  const last = p.phases[p.phases.length - 1];
  return {
    phaseIndex: p.phases.length - 1,
    phase: last,
    phaseProgress: 1,
    totalProgress: 1,
    target: last.target,
    complete: true,
  };
}
