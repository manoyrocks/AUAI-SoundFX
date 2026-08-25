# Personal Rhythm Model

Component: `packages/protocol/src/rhythm/*`, surfaced in
`apps/web/src/rhythmPanel.ts`.

The spec (Part 2, pillar 3) asks for a continuously-learned on-device model
of the user's rhythms that predicts energy/focus windows 24–48h ahead and
powers proactive suggestions. This is the built subset, and an honest
account of the parts that are not built.

## What it models

An **arousal proxy** — heart rate expressed as a z-score against the user's
own rolling baseline (`baseline.ts`) — as a function of local clock time.
Positive means "running hotter than usual *for this person* at this hour".

Using a personal z-score rather than absolute BPM is the load-bearing
choice: it makes observations comparable across days, removes the
population-average offset that makes generic thresholds wrong for
individuals, and means the fitted curve describes a person's *deviation from
their own normal* rather than their cardiovascular fitness.

## Method: harmonic regression with prequential model selection

**Basis.** Sinusoids at known periods — the standard chronobiology approach
(cosinor analysis, Halberg et al.). Sinusoidal bases are chosen over splines
or per-hour lookups for a specific reason: they *extrapolate*. A per-hour
average can only describe hours already observed; a fitted 24-hour sinusoid
still makes a defensible — and honestly uncertain — statement about an hour
seen less often.

**Fitting.** Online ridge regression over accumulated sufficient statistics
(`ridge.ts`). The model stores only

```
XtX (d×d)   Xty (d)   yty   n
```

never the observations themselves. With d ≤ 8 that is at most ~80 numbers
regardless of how many readings have been seen. Exponential forgetting
(45-day half-life) makes the fit adaptive rather than merely cumulative — a
user who changes job, timezone or sleep schedule stops being predicted by
their old rhythm.

**Selection.** Five nested candidate models are trained in parallel. Before
each observation updates them, every candidate first *predicts* it and the
squared error is accumulated. Selection is therefore on genuine
predict-then-update (prequential) accuracy, per user — no train/test split
to get wrong, no data retained. A user whose rhythm is genuinely flat gets
the flat model.

Verified working: seeded with a pure 24-hour cosine, the model selects
`circadian` (MSE 0.013) over both the flat null model (0.102) and the richer
candidates whose extra parameters do not earn their keep (0.0137–0.0138).

## The ultradian question — why a component exists to be rejected

Endel maps a "~110-minute ultradian energy cycle" onto clock time. Two
things are worth stating plainly:

1. Evidence for a stable *daytime* ultradian rhythm in alertness is
   substantially weaker than for the circadian rhythm.
2. More decisively: an ultradian cycle is anchored to **wake onset, not the
   wall clock**. Two days with different wake times put the same clock hour
   at a different ultradian phase. Fitting a fixed ~90-minute oscillation
   against clock time is therefore close to unfalsifiable decoration unless
   you also know when the person woke — which this build does not.

So the ultradian basis ships as a *candidate the model may reject*, not a
component asserted to exist. On clean circadian data it is correctly not
selected (test: `selection rejects the clock-anchored ultradian term on data
that has none`). Being able to reject a component is the point.

## Honesty gates

Predictive accuracy alone is not enough. A model fitted only on 8am and 9pm
readings can score well on those hours while being pure extrapolation at
2pm. `isReady()` therefore requires **all three** of:

| Gate | Threshold | Guards against |
|---|---|---|
| Total observations | ≥ 60 | Fitting noise |
| Distinct hours-of-day | ≥ 5 | Extrapolating across unobserved hours |
| Distinct days | ≥ 4 | Mistaking one unusual day for a rhythm |

Until then the model returns `null` from `predictAt`, `[]` from
`findWindows`, and the UI shows coverage progress plus exactly what is
missing — never a placeholder curve. Two tests specifically cover the
failure modes: many readings at a single hour, and many hours within a
single day. Both correctly stay not-ready.

Every prediction also carries a predictive standard deviation from the ridge
posterior (`σ²(1 + xᵀ(XtX+λI)⁻¹x)`), and the panel draws it as a visible ±1σ
band. The band widens at times of day the user rarely uses the app, which is
the honest thing for it to do. A forecast drawn as a confident line is a
claim; drawn with its envelope it is an estimate.

## Scheduling: what this was built for

`rhythm/suggest.ts` turns forecast windows into protocol proposals — the
actual payoff, since the protocol scheduler already existed. Goal bands map
to protocols (focus → Deep Work, windDown → Wind-Down, recovery →
Recovery), and a suggestion carries a start time and a plain-language
rationale.

Two product rules are enforced here rather than left to each UI surface:

- **Propose, never start.** Nothing in the module begins a session. An app
  that starts playing because a model predicted you'd want it is a dark
  pattern regardless of prediction quality. The UI requires an explicit tap.
- **Silence is a valid output.** `suggestNext` returns `null` when the model
  is not ready or nothing clears the confidence floor, and there is no
  fallback that manufactures a prompt. Ranking is by *imminence*, not
  predicted magnitude — ranking by strength would push the product toward
  always finding something impressive to say.

Suggestions further out than 4 hours are suppressed (a suggestion for
tomorrow afternoon is noise at 9am today).

## Privacy

The stored artefact is a rank-accumulated outer-product sum. Individual
observations — "this person's heart rate was elevated at 21:40 last
Tuesday" — are **not recoverable from it**. A test asserts that a distinctive
observation value never appears in a serialised snapshot, and that day-level
keys are retained rather than per-observation timestamps. Persistence is
`localStorage` only; no network call exists in the rhythm path. See
[05-privacy.md](05-privacy.md).

## Not built

- **Sleep debt, caffeine, and calendar context**, all named in the spec.
  Each needs a data source that does not exist here (wearable sleep staging,
  user logging, calendar permission). The observation interface takes an
  opaque `arousalZ`, so adding these later means enriching the basis, not
  restructuring the model.
- **Wake-time anchoring**, which is the prerequisite for modelling ultradian
  rhythms honestly (see above).
- **Federated aggregation with differential privacy.** Nothing is
  aggregated; there is no cloud component.
- **Validation against real longitudinal data.** Every test uses synthetic
  ground truth. That validates the *estimator* — it recovers a known curve,
  rejects components the data doesn't support, and refuses to forecast
  without coverage — but it does not establish that the arousal proxy
  tracks anything a user would recognise as their energy level. That needs
  real users and is the honest next step.
