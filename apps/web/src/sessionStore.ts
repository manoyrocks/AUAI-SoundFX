import type { SessionOutcome } from "@soundfx/protocol";

/**
 * Local-only persistence for session outcomes (localStorage). No network
 * call exists in this file — consistent with "raw biometrics never leave
 * the device": even the *derived* HR/HRV summary numbers stay on-device by
 * default here, never mind raw signal. A future opt-in sync feature would
 * be an explicit, separate, consent-gated path — not a default of this
 * module.
 */

const KEY = "soundfx.sessions.v1";
const MAX_SESSIONS = 100;

export function loadSessions(): SessionOutcome[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt or inaccessible storage (private browsing, quota, manual
    // tampering) degrades to "no history" rather than throwing and taking
    // the rest of the app down with it.
    return [];
  }
}

export function saveSession(outcome: SessionOutcome): SessionOutcome[] {
  const sessions = loadSessions();
  sessions.push(outcome);
  sessions.sort((a, b) => b.endedAtMs - a.endedAtMs);
  const trimmed = sessions.slice(0, MAX_SESSIONS);
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full/unavailable: the in-memory session still ran and the UI
    // still gets the outcome back from this call — only persistence failed.
  }
  return trimmed;
}
