/**
 * StateVector — the fused estimate of the user's current physiological state.
 *
 * M1 populates this from camera rPPG only (heartRateBpm, hrvRmssdMs). The
 * architecture is written so M2 adds respiration, EDA, sleep stage and
 * keyboard/app-switch telemetry as additional optional fields without
 * changing the controller's interface — every consumer already treats each
 * field as nullable and confidence-weighted.
 */
export interface StateVector {
  timestampMs: number;
  heartRateBpm: number | null;
  heartRateConfidence: number; // 0..1
  hrvRmssdMs: number | null;
  hrvConfidence: number; // 0..1
}

export function emptyState(nowMs: number): StateVector {
  return { timestampMs: nowMs, heartRateBpm: null, heartRateConfidence: 0, hrvRmssdMs: null, hrvConfidence: 0 };
}
