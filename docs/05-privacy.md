# Privacy — plain-language data map

This is the published, plain-language data map, kept
accurate to what the code actually does rather than what a privacy policy
template would say.

## What data exists, and where it lives

| Data | Where it's created | Where it's stored | Where it's sent |
|---|---|---|---|
| Camera video frames | `apps/web/src/camera.ts` (`getUserMedia`) | Nowhere — drawn to an in-memory `<video>` element and a same-process analysis canvas, never written to disk | Nowhere. No `fetch`/`XHR`/`WebSocket` exists in `packages/biosignal` or `apps/web/src/camera.ts` — this is checkable by grep, not a claim to take on faith. |
| Rolling RGB trace (≤30s window) | `packages/biosignal/src/session.ts` | In-memory array, evicted continuously (`MAX_WINDOW_S` cutoff) | Nowhere |
| Instantaneous HR/HRV reading | `packages/biosignal/src/session.ts` | In-memory (`RppgSession.reading`) | Nowhere directly; feeds the on-device baseline/controller only |
| Personal HR/HRV baseline (running mean/variance) | `packages/protocol/src/baseline.ts` | In-memory for the session's lifetime; not currently persisted across page reloads | Nowhere |
| Session outcome (mode, start/end HR, duration) | `packages/protocol/src/outcomes.ts` | `localStorage` (`apps/web/src/sessionStore.ts`), this browser/device only | Nowhere |
| Personal Rhythm Model | `packages/protocol/src/rhythm/*` | `localStorage` (`apps/web/src/rhythmStore.ts`), this browser/device only. **Sufficient statistics only** — see below | Nowhere |
| Gated-technique acknowledgements | `apps/web/src/main.ts` | `localStorage`. A record that a warning was read, never a health disclosure — see [06-safety.md](06-safety.md) | Nowhere |
| Control vector / audio telemetry | `packages/engine` | In-memory, used to drive UI and audio only | Nowhere |

**There is currently no network request anywhere in the closed-loop or
biosignal path.** The only network activity the app makes at all is the
initial page/asset load itself (HTML/JS/CSS from the dev server or, in
production, a CDN) and — separately, unused in this build — `ClfsHost.
loadWeights()`, a `fetch()` for a `.nfd` model weight file, which is a
one-time asset download with no biometric payload attached to the request.

## The Rhythm Model stores statistics, not history

The Personal Rhythm Model learns from weeks of readings, which would
normally mean retaining weeks of timestamped heart-rate data — a
significantly more sensitive artefact than anything else in this table.

It does not. The model accumulates only the regression sufficient
statistics (`XtX`, `Xty`, `yty`, `n` — see
[08-rhythm-model.md](08-rhythm-model.md)), which is a rank-accumulated
outer-product sum. Individual observations are not recoverable from it:
there is no row for "21:40 last Tuesday" to read out. For a model of any
size this is at most ~80 numbers.

This is enforced by a test (`a snapshot contains no raw observations — only
sufficient statistics`), which writes a distinctive observation value,
serialises the model, and asserts the value does not appear in the output —
and that only day-level keys are retained, never per-observation
timestamps.

## What's opt-in and revocable

- Camera sensing is off by default; the toggle in the UI is the only way it
  turns on, and turning it off (`camera.stop()`) immediately releases the
  `MediaStream` tracks and calls `session.reset()`, discarding the rolling
  trace and in-memory baseline state.
- Session history (`localStorage`) persists across reloads by design (it's
  the point of the feature — see [00-orchestrator.md](00-orchestrator.md)),
  but is entirely local to the browser profile. Clearing site data / browser
  storage removes it completely; there is currently no in-app "clear my
  history" button, which is a real, flagged gap (see below).

## Known gaps (flagged, not hidden)

1. **No in-app data-deletion control.** A user can clear `localStorage` via
   browser settings, but the app itself offers no "delete my session
   history" action. This should exist before any real user relies on the
   product — recommended for the next work cycle.
2. **The personal baseline does not persist across reloads.** Every fresh
   page load starts the HR/HRV baseline from a wide, untrusted prior
   (`ScalarBaseline`'s constructor defaults) rather than resuming a user's
   established baseline. This is a UX/accuracy gap more than a privacy one,
   but is recorded here because the natural fix (persisting the baseline)
   is itself a privacy decision that needs the same "local by default,
   explicit if it ever leaves the device" treatment as everything else.
   It also has a real accuracy consequence now that the Rhythm Model exists:
   the model only accepts readings once the baseline is `trusted`, so a
   session's first minute or two contributes nothing to the fit.
3. **No differential-privacy or federated-aggregation path exists**, because
   nothing is aggregated yet — there is no cloud component in this build at
   all (see [02-platform.md](02-platform.md)). The differential-privacy
   requirement applies to a feature that hasn't been built rather than being
   unmet by something that has.

## Camera-derived numbers are estimates, not measurements

Every user-facing string touching HR/HRV frames it as an estimate from a
consumer webcam (see [07-claims.md](07-claims.md) for the full copy audit).
This is a privacy-adjacent point as much as a claims one: because the
underlying signal quality is genuinely limited, a data map that implied
clinical-grade precision would misrepresent both what's collected and how
good it is.
