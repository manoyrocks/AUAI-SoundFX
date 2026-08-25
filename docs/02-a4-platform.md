# A4 — Full-Stack/Platform Engineer

Component: `apps/web/*`, root workspace configuration.

## What's built: the web PWA

A real npm-workspaces monorepo (`packages/engine`, `packages/biosignal`,
`packages/protocol`, `apps/web`), TypeScript project references end to end
(`tsc -b` builds and typechecks the whole graph in dependency order — see
root `tsconfig.json`), Vite for the app bundle and dev server.

**Package boundary decision, and a real bug it caused:** workspace packages
publish their `main`/`exports` at compiled `dist/` output — the correct
public interface for any plain-Node consumer (the test suites import `dist`
directly). The web app's dev server instead aliases those same specifiers
straight to TS source (`apps/web/vite.config.ts::resolve.alias`) purely for
its own hot-reload convenience. This split exists because the first version
of this got it backwards — package.json pointed at `src/*.ts`, which worked
for Vite's bundler resolution but broke `node --test` resolving a bare
`@soundfx/engine` import from *compiled* `dist/controller.js` (Node's ESM
resolver doesn't do TypeScript's `.js`-specifier-means-sibling-`.ts`
rewriting). Worth recording because it's the kind of thing that looks fine
until something other than the bundler tries to consume the package.

**AudioWorklet delivery:** the worklet processor is bundled *separately* via
esbuild (`packages/engine/package.json::build:worklet`) into a
self-contained ESM file with no bare imports, because `audioWorklet.
addModule()` does not go through the app's normal module graph or resolve
bare specifiers — it fetches a URL and evaluates it in the
`AudioWorkletGlobalScope`. This is wired into both `npm run dev` and
`npm run build` at the root so it can't be forgotten before a run.

**Camera/rPPG delivery:** `apps/web/src/camera.ts` — `getUserMedia` feeding
a `<video>` element and an in-memory analysis canvas only. No `fetch`, `XHR`,
or `WebSocket` anywhere in the camera→biosignal→controller path — this is
literally how "raw biometrics never leave the device" is implemented for
the camera channel, not just a policy statement. Verified live: camera
permission denial produces a clean `"Camera unavailable: Permission
denied"` banner with no console error and a re-usable toggle, not a stuck
or crashed UI.

**Local telemetry/outcomes, explicitly not analytics:** `apps/web/src/
sessionStore.ts` persists session outcomes to `localStorage` only. There is
no analytics SDK, no crash reporter, no first- or third-party tracking
script anywhere in `apps/web`. "Telemetry with privacy budgets" per Part 3's
non-negotiables is satisfied by *not collecting it off-device at all* at
this stage, which is a stricter bar than a budgeted collection pipeline
would be — the honest gap is that this also means there is currently no way
to detect the app breaking for a real user except them telling you.

## What's not built, and why not

**Mobile shells (iOS/Android).** Not started. This needs a Kotlin
Multiplatform or Rust-core-plus-native-UI project, platform-specific audio
backends (AVAudioEngine / Oboe), and an actual device or emulator to verify
against — none of which exist in this environment. **Recommendation on the
RN/Expo vs. native question the spec asks engineers to resolve:** go native
(SwiftUI/Compose) over React Native/Expo for the audio-adjacent UI
specifically, not for the whole app. The reasoning follows directly from
what A1 already had to guarantee for the web build: real-time audio
correctness requires the render callback to be isolated from anything that
can pause unpredictably (GC, a slow re-render, a bridge round-trip). RN's
JS-thread/native-bridge architecture reintroduces exactly the coupling the
AudioWorklet isolation was built to avoid; a Kotlin-Multiplatform or shared
Rust core with thin native UI does not. Screens with no real-time audio
dependency (settings, session history, onboarding) are a reasonable place
to reconsider RN/Expo for velocity — but that's a per-screen call for
whoever actually builds the mobile app, not a whole-app default.

**Cloud (auth, sync, federated aggregation, model distribution).** Not
started. There is currently no user account system and nothing
cross-device-worthy to sync (no trained model, no cross-session preference
vector beyond what's already local). Building sync infrastructure before
there's a real payload to move is the kind of work that looks like progress
and isn't — flagged in [00-orchestrator.md](00-orchestrator.md) as
correctly deprioritized, not forgotten.

**SDK/API surface.** Not started; explicitly "design for, don't build
first" per Part 2's business/ecosystem framing.

**CI/CD.** No pipeline configuration exists (no GitHub Actions/etc). The
repo *is* CI-ready in the sense that `npm test` (build every package,
typecheck, run all 32 tests) and `npm run build` are single deterministic
commands with real exit codes — wiring that into an actual CI runner is
mechanical, not designed, work that just hasn't been done.

## Accessibility pass (opportunistic, not the full M4 pass)

Done in this session, not deferred: `prefers-reduced-motion` support in the
generative visual (motion-linked parameters scale down to ~12%, colour/size
— which carry the actual state information — stay untouched), `aria-live`
regions on the status/heart-rate text so screen readers get session-state
changes, `aria-pressed` kept in sync on mode buttons, `aria-hidden` on the
purely-decorative canvas and self-view video (their information is
duplicated in real text elsewhere), and a labelled camera-toggle switch that
previously had no accessible name at all (`read_page` showed it as a bare
`button` with no label before the fix). **Not done**: a haptic-only,
no-audio relaxation mode for hearing-impaired users (explicitly named in
Part 3's non-negotiables) and a full screen-reader walkthrough — both real,
scoped M4 work, not started here.
