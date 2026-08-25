/**
 * The complete registry of everything this app persists.
 *
 * Centralised deliberately. The privacy claim in the footer and in
 * docs/05-privacy.md is "everything stays on this device", and a claim like
 * that is only auditable if there is one file to audit. Anything that
 * persists must be declared here, so the data-deletion UI can never silently
 * miss a store that some panel added later.
 *
 * Every key is namespaced `soundfx.` so a blanket clear can find them all
 * without touching another app sharing the origin.
 */

export type StoreId = "sessions" | "rhythm" | "techniques" | "baseline";

export interface StoreDescriptor {
  id: StoreId;
  key: string;
  /** Shown in the data panel. */
  label: string;
  /** What it is, in the user's terms — not the implementation's. */
  description: string;
  /** Best-effort count of items, for display. */
  count: (raw: string) => number | null;
}

export const STORE_PREFIX = "soundfx.";

export const STORES: readonly StoreDescriptor[] = [
  {
    id: "sessions",
    key: "soundfx.sessions.v1",
    label: "Session history",
    description: "Mode, duration, and before/after heart rate for each session you've run.",
    count: (raw) => {
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.length : null;
      } catch {
        return null;
      }
    },
  },
  {
    id: "rhythm",
    key: "soundfx.rhythm.v1",
    label: "Rhythm model",
    description:
      "The learned shape of your daily rhythm. Stored as regression statistics, not as a log of readings — individual measurements are not recoverable from it.",
    count: (raw) => {
      try {
        const v = JSON.parse(raw);
        return typeof v?.totalObservations === "number" ? v.totalObservations : null;
      } catch {
        return null;
      }
    },
  },
  {
    id: "baseline",
    key: "soundfx.baseline.v1",
    label: "Personal baseline",
    description: "Your resting heart rate and variability, so sessions don't restart calibration each time.",
    count: () => null,
  },
  {
    id: "techniques",
    key: "soundfx.techniques.v1",
    label: "Technique acknowledgements",
    description:
      "A record of which optional-technique warnings you've read. Not a health disclosure — only which notices were shown.",
    count: (raw) => {
      try {
        const v = JSON.parse(raw);
        return v && typeof v === "object" ? Object.values(v).filter(Boolean).length : null;
      } catch {
        return null;
      }
    },
  },
] as const;

export interface StoreStatus {
  descriptor: StoreDescriptor;
  present: boolean;
  count: number | null;
  /** Approximate size in bytes (UTF-16 code units are 2 bytes each). */
  bytes: number;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function inventory(): StoreStatus[] {
  return STORES.map((d) => {
    const raw = read(d.key);
    return {
      descriptor: d,
      present: raw !== null,
      count: raw === null ? null : d.count(raw),
      bytes: raw === null ? 0 : raw.length * 2,
    };
  });
}

export function clearStore(id: StoreId): void {
  const d = STORES.find((s) => s.id === id);
  if (!d) return;
  try {
    localStorage.removeItem(d.key);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/**
 * Remove every namespaced key, including any left behind by an older
 * version whose descriptor no longer exists. Iterating the actual keyspace
 * rather than the registry is what makes "clear everything" honest.
 */
export function clearAll(): number {
  let removed = 0;
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(STORE_PREFIX));
    for (const k of keys) {
      localStorage.removeItem(k);
      removed++;
    }
  } catch {
    /* storage unavailable */
  }
  return removed;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
