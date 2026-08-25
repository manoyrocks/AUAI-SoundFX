import type { AnchorName } from "@soundfx/engine";
import type { PhysiologyBaseline } from "./baseline.js";

/**
 * Session outcomes log — the first, honest slice of the "trust moat" pillar
 * (Part 2, item 6: "provable efficacy... shows its receipts").
 *
 * Scope note: this is deliberately NOT the full N-of-1 blinded-experiment
 * engine from the product spec — that needs weeks of data and a randomised
 * withholding design to make a defensible causal claim. What this *is*: an
 * honest before/after record of each session's own physiological signal,
 * computed the same way every time, with confidence and sample-size caveats
 * attached rather than hidden. It answers "what happened during this
 * session", not yet "did SoundFX cause it" — the dashboard copy must
 * preserve that distinction (see docs/07-claims.md).
 *
 * Storage: the caller owns persistence (the web app uses localStorage; a
 * future mobile app would use its own local store). This module only knows
 * how to build and summarise records — it never itself reaches the network,
 * matching the "raw biometrics never leave the device" rule.
 */

export interface SessionOutcome {
  id: string;
  mode: AnchorName;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  cameraUsed: boolean;
  /** Null whenever confidence never crossed the controller's action threshold. */
  startHrBpm: number | null;
  endHrBpm: number | null;
  startHrvMs: number | null;
  endHrvMs: number | null;
  /** Count of confident HR samples observed — the honesty gate for the UI. */
  sampleCount: number;
}

export interface OutcomeDelta {
  hrDeltaBpm: number | null;
  hrvDeltaMs: number | null;
  /** Below this, the UI must show "not enough signal" rather than a number. */
  reliable: boolean;
}

const MIN_SAMPLES_FOR_RELIABLE_DELTA = 8;

export function computeDelta(o: SessionOutcome): OutcomeDelta {
  const reliable = o.sampleCount >= MIN_SAMPLES_FOR_RELIABLE_DELTA;
  return {
    hrDeltaBpm: o.startHrBpm != null && o.endHrBpm != null ? o.endHrBpm - o.startHrBpm : null,
    hrvDeltaMs: o.startHrvMs != null && o.endHrvMs != null ? o.endHrvMs - o.startHrvMs : null,
    reliable,
  };
}

/**
 * Aggregate-honest summary across a set of past sessions for one mode.
 * Deliberately simple (mean + n), no hidden inferential statistics — a
 * headline "72% of sessions ended calmer" claim needs a real N and a
 * pre-registered definition of "calmer", neither of which a handful of local
 * sessions can support. This surfaces the raw numbers instead of a verdict.
 */
export interface ModeSummary {
  mode: AnchorName;
  n: number;
  nReliable: number;
  meanHrDeltaBpm: number | null;
  meanSessionMinutes: number;
}

export function summariseMode(mode: AnchorName, sessions: SessionOutcome[]): ModeSummary {
  const inMode = sessions.filter((s) => s.mode === mode);
  const reliableDeltas = inMode.map(computeDelta).filter((d) => d.reliable && d.hrDeltaBpm != null);
  const meanHrDeltaBpm =
    reliableDeltas.length > 0
      ? reliableDeltas.reduce((sum, d) => sum + (d.hrDeltaBpm as number), 0) / reliableDeltas.length
      : null;
  const meanSessionMinutes =
    inMode.length > 0 ? inMode.reduce((sum, s) => sum + s.durationMs, 0) / inMode.length / 60000 : 0;
  return { mode, n: inMode.length, nReliable: reliableDeltas.length, meanHrDeltaBpm, meanSessionMinutes };
}

/**
 * Recorder — call `begin()` at session start and `end()` at session end; it
 * reads the live baseline estimator (see baseline.ts) rather than duplicating
 * signal tracking. Pure/side-effect-free beyond returning records; the caller
 * decides how (or whether) to persist them.
 */
export class OutcomeRecorder {
  private openId: string | null = null;
  private openMode: AnchorName | null = null;
  private openStartedAt = 0;
  private openCameraUsed = false;
  private startHr: number | null = null;
  private startHrv: number | null = null;
  private samples = 0;

  begin(mode: AnchorName, cameraUsed: boolean, baseline: PhysiologyBaseline, nowMs: number): void {
    this.openId = `${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
    this.openMode = mode;
    this.openStartedAt = nowMs;
    this.openCameraUsed = cameraUsed;
    this.startHr = baseline.hr.trusted ? baseline.hr.value : null;
    this.startHrv = baseline.hrv.trusted ? baseline.hrv.value : null;
    this.samples = 0;
  }

  /** Call once per confident biosignal reading during the session. */
  recordSample(): void {
    this.samples++;
  }

  end(baseline: PhysiologyBaseline, nowMs: number): SessionOutcome | null {
    if (this.openId == null || this.openMode == null) return null;
    const outcome: SessionOutcome = {
      id: this.openId,
      mode: this.openMode,
      startedAtMs: this.openStartedAt,
      endedAtMs: nowMs,
      durationMs: Math.max(0, nowMs - this.openStartedAt),
      cameraUsed: this.openCameraUsed,
      startHrBpm: this.startHr,
      endHrBpm: baseline.hr.trusted ? baseline.hr.value : null,
      startHrvMs: this.startHrv,
      endHrvMs: baseline.hrv.trusted ? baseline.hrv.value : null,
      sampleCount: this.samples,
    };
    this.openId = null;
    this.openMode = null;
    return outcome;
  }

  get isOpen(): boolean {
    return this.openId != null;
  }
}
