import { PersonalRhythmModel, type RhythmSnapshot } from "@soundfx/protocol";

/**
 * Local-only persistence for the Personal Rhythm Model.
 *
 * What gets written is the model's sufficient statistics (see
 * rhythm/ridge.ts), not a log of readings — so even this stored artefact
 * cannot be turned back into "your heart rate at 21:40 last Tuesday".
 * No network call exists in this file. See docs/05-privacy.md.
 */

const KEY = "soundfx.rhythm.v1";

export function loadRhythmModel(): PersonalRhythmModel {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new PersonalRhythmModel();
    return PersonalRhythmModel.restore(JSON.parse(raw) as RhythmSnapshot);
  } catch {
    // Corrupt or inaccessible storage degrades to a fresh model rather than
    // taking the app down. The user loses learned history, not the session.
    return new PersonalRhythmModel();
  }
}

export function saveRhythmModel(model: PersonalRhythmModel): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(model.snapshot()));
  } catch {
    // Best-effort: the in-memory model keeps working for this session.
  }
}

export function clearRhythmModel(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
