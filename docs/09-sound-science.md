# Four new categories: behavioural sound science

Components: `packages/engine/src/psychoacoustics.ts`,
`packages/engine/src/control.ts` (anchors + `SynthesisConstraints`),
`packages/protocol/src/soundScience.ts`, surfaced in
`apps/web/src/sciencePanel.ts`.

The five original modes were tuned by ear against the control vector. These
four are derived from specific literature, and each one demanded a
capability the engine did not previously have — that was the bar for
including them. A mode that is only a new set of anchor values is a preset,
not a category.

| Mode | Question it answers | New engine capability |
|---|---|---|
| **Read** | What should play while holding words in order? | Syllabic-modulation suppression; token-set cap |
| **Open** | What should play while trying to think of something? | (parameterisation only — see caveat) |
| **Screen** | What should play in an open-plan office? | Masking-spectrum override; Articulation Index |
| **Move** | What should play while walking or running? | Cadence-locked near-periodic onsets |

---

## Architecture: constraints are not control-vector values

The four modes forced a split that should have existed from the start.

`ControlVector` is a continuous **aesthetic** space. Every dimension is
negotiable, slew-limited, and steerable by the biofeedback controller.

`SynthesisConstraints` are categorical **acoustic** rules the synthesis must
obey regardless of where the vector currently sits. Read's suppression of
syllabic-rate modulation is the clearest case: it is not "less of something"
on a continuum, it is a forbidden band, and the controller must not be able
to negotiate it away while steering arousal.

They are also transported differently. Constraints are sent to the worklet
as a whole object, never merged — a partial merge is exactly how one mode's
acoustic rule survives into the next.

---

## Read — verbal serial tasks

**Not a synonym for Deep Work.** Deep Work is general focus; Read targets
tasks that hold words in order — reading, writing, editing, mental
arithmetic.

### The finding

Irrelevant background speech disrupts serial recall even when the speech is
meaningless to the listener (Salamé & Baddeley, 1982). The more useful
refinement is the **changing-state hypothesis** (Jones & Macken): disruption
tracks *acoustic change between successive tokens*, not speech content. A
sequence of distinguishable sounds disrupts; a steady repeating one barely
does. Disruption also grows with **token-set size** — the number of distinct
sounds in the stream.

Separately, speech's temporal-envelope modulation spectrum peaks around
**3.9–4.8 Hz**, matching mean syllable rate, and that band carries
syllable-pattern information.

### Why this is uncomfortable for this engine

Never repeating is SoundFX's headline property — the aperiodic latent
trajectory, the "zero audible loops in 8 hours" bar. The irrelevant-sound
literature says that endless novelty is precisely the most disruptive
property a background stream can have for verbal work.

So Read deliberately runs the engine against its own grain. This is the most
interesting thing about the mode and it should not be smoothed over in the
marketing.

### What was built

- **Bed modulation limit.** The spectral bed normally draws independent
  Rayleigh magnitudes per frame, which puts energy at *every* modulation
  frequency including 2–8 Hz. `SpectralBed.setModulationLimit()` lowpasses
  per-bin magnitudes across frames, confining fluctuation below ~1 Hz.
- **Sub-syllabic event and grain rates**, capped below 1.4 Hz. Falling below
  the band rather than above it: above 8 Hz would also clear it, but fuses
  into a continuous buzz.
- **Token-set cap** on the harmonic walker (`setTokenSetLimit`).
- **Detune narrowing** on the drone — see the bug below.

### The bug worth recording

The obvious move was to *extend* ring times so sparse events overlap into
continuous texture. Measured, it made things **worse**: syllabic modulation
depth rose from 0.201 to 0.261.

Longer tails mean more simultaneously sounding strikes, and each strike's
partials are micro-detuned by up to ~4 cents. Overlapping copies beat at
roughly `f × 0.0023` — about **4.6 Hz at 2 kHz**, dead centre of the band
being protected. The same mechanism applies to the drone's 1.5–7.5 cent
detune, which is warmth in every other mode and a syllabic-rate beat here.

Capping the tail and narrowing the detune instead gives **0.134**, a 33%
reduction against unconstrained and below Deep Work's 0.197.

### The metric

`packages/engine/test/constraints.test.js` measures **modulation depth**:
RMS of band-limited envelope fluctuation divided by mean envelope level.

The first version measured the *fraction* of total modulation energy in the
syllabic band, which was wrong and actively misleading — a lowpass that
removes more energy above 8 Hz than inside 2–8 Hz raises that fraction while
genuinely reducing syllabic modulation. Depth relative to mean level is what
corresponds to perceived fluctuation, and it is level-independent.

Tests also assert the suppression is *band-specific* (slow drift survives)
and that Deep Work is not accidentally flattened.

---

## Open — divergent thinking

**Deliberately busier and less comfortable than Deep Work.**

Mehta, Zhu & Cheema (2012) found across five experiments that 70 dB ambient
noise improved creative-task performance relative to 50 dB, with 85 dB
impairing it; the proposed route is increased processing difficulty raising
construal level and promoting abstract thought.

### The honest caveat

**The effect is defined by absolute sound level, which no app can observe or
control.** We do not know the user's volume setting, their headphones, or
their room. This mode shapes *character* — wider latent wandering, a larger
reachable harmonic region, higher event rate — which is an interpretation of
the finding, not a reproduction of it. The construal-level mechanism is also
contested.

This is the one new mode with **no new engine capability**, and it is marked
`moderate` evidence in the UI for both reasons. It is included because the
direction (optimise for variety, not transparency) is a genuinely different
design target from every other mode, but it should not be presented as
resting on the same footing as Read or Screen.

---

## Screen — speech masking

**The only mode with an acoustic rather than affective target**, and
therefore the only one with a standardised metric.

### The method

Speech intelligibility is predictable from band-by-band signal-to-noise
ratio weighted by each band's contribution to understanding — the
Articulation Index (ASTM E1130 for open-plan spaces; ANSI S3.5-1997 for the
modern Speech Intelligibility Index). The octave-band importance weights are
implemented directly:

| Band | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|
| Weight | 0.062 | 0.167 | 0.237 | 0.265 | 0.214 | 0.055 |

Over 70% of speech information lives in 1–4 kHz, which is why masking effort
concentrates there. The masking target curve follows the speech spectrum's
own shape with a gentle extra tilt — masking effectiveness wants energy in
1–4 kHz, but comfort wants it rolled off above, because a hissy masker gets
turned down and then masks nothing.

The bed's spectrum is **overridden entirely** rather than blended with the
decoder output, since blending would drift the curve away from the shape
that does the masking.

### What we can and cannot claim

`articulationIndex()` is implemented and tested, but a web app **cannot know
the sound pressure level at the user's ear** — not the headphones, not the
system volume, not how loud the conversation two desks away is. Any AI
figure is strictly conditional on assumptions we cannot verify.

So the number surfaced is `spectrumEfficiency()`: how efficiently the
spectrum spends its energy on masking speech, **level-independent** by
construction (a test asserts shifting the whole spectrum ±30 dB does not
change it). That is a property the engine genuinely controls and can stand
behind. The masking curve beats both white and pink noise on it.

---

## Move — cadence entrainment

**The one mode that wants a perceivable pulse.** Every other mode uses low
`complexity` precisely to avoid one.

Auditory-motor entrainment — the involuntary tendency to synchronise
movement to a perceived beat — underlies rhythmic auditory stimulation in
movement rehabilitation (Thaut et al.). Van Dyck et al. (2013) found runners
spontaneously entrain cadence to music tempo within a limited range.

### What was built

`complexity` sets the shape parameter of the onset renewal process. At Move's
0.92 the gamma shape reaches ~11, and the cadence lock raises it further to
24, making onsets near-periodic. Rate comes from **steps per minute**, not
musical tempo.

This matters: a Poisson process at the correct mean rate would pass a rate
test and entrain nothing. A test therefore checks the *modulation spectrum*
has a clear peak at the cadence frequency, not merely that the average rate
is right.

Cadence is **user-entered**. Automatic detection needs motion-sensor
permission and is not built; guessing a cadence would produce a beat at the
wrong rate, which is worse than no beat.

---

## Safety review

**Move is not gated** under `rhythmicEntrainment`. That gate covers binaural
beats and isochronic tones intended to drive EEG frequencies. Move's pulse
is at step cadence (1–3.3 Hz) driving *motor* entrainment — functionally
equivalent to walking to music with a beat, which is not a screened
activity. Gating it would be safety theatre that dilutes the real gates.

**One genuine interaction was found and fixed.** The generative visual's
brightness pulse tracks engine RMS, and telemetry posts at 5 Hz — so a
2.5–3.3 Hz cadence could alias into visible 1–2.5 Hz flicker. That sits
below the WCAG 2.3.1 flash threshold (three flashes per second, high
contrast, large area) and below the 3–60 Hz photosensitivity range, and it
is a soft gradient rather than a flash. But an accident of the telemetry
rate is not the same as a guarantee, so the visual pulse is now explicitly
slewed to under ~0.5 Hz. Nothing is lost — that value is ambience, not
per-event information.

**Distress monitoring** correctly excludes all four: `CALMING_MODES` remains
`calm`/`sleep`/`recovery`, and none of the new modes promises arousal
reduction. **The sleep arousal clamp** is unaffected.

---

## Not established

- None of these modes has been tested with users. The literature is about
  background sound affecting cognitive tasks; what is verified here is that
  the engine's **acoustics** match what that literature describes, measured
  in the test suite. Whether that helps any particular person is unknown.
- Evidence strength differs across the four and is shown in the UI rather
  than flattened: Read and Screen `established`, Open `moderate`, Move
  `mechanism established, application untested`.
- No therapeutic or medical claim is made or implied. See
  [06-safety.md](06-safety.md) and [07-claims.md](07-claims.md).

## Sources

- [Salamé & Baddeley — irrelevant speech and the phonological loop](https://link.springer.com/article/10.3758/BF03201123)
- [Changing-state hypothesis and the irrelevant sound effect](https://pubmed.ncbi.nlm.nih.gov/11958724/)
- [Speech modulation spectrum and syllabic rhythm](https://www.sciencedirect.com/science/article/pii/S0149763423000805)
- [Mehta, Zhu & Cheema — Is Noise Always Bad?](https://academic.oup.com/jcr/article-abstract/39/4/784/1798283)
- [ASTM E1130 — speech privacy via Articulation Index](https://store.astm.org/e1130-16r21.html)
- [ANSI S3.5-1997 Speech Intelligibility Index constants](https://rdrr.io/cran/SII/man/critical.html)
- [Van Dyck et al. — auditory-motor synchronisation in running](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0070758)
