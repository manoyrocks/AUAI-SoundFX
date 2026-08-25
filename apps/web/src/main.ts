import {
  ClfsHost,
  anchor,
  slewToward,
  clampControl,
  CONTROL_KEYS,
  CONTROL_RANGES,
  constraintsFor,
  DEFAULT_CONSTRAINTS,
  type AnchorName,
  type ControlVector,
  type ClfsTelemetry,
} from "@soundfx/engine";
import type { RppgReading } from "@soundfx/biosignal";
import {
  PhysiologyBaseline,
  PersonalRhythmModel,
  computeAdjustment,
  OutcomeRecorder,
  computeDelta,
  summariseMode,
  DistressMonitor,
  GATED_TECHNIQUES,
  isTechniqueEnabled,
  PROTOCOLS,
  protocolById,
  protocolTotalMinutes,
  protocolPositionAt,
  type StateVector,
  type SessionOutcome,
  type TechniqueConsent,
  type Protocol,
} from "@soundfx/protocol";
import { FieldVisual } from "./visual.js";
import { CameraSensor } from "./camera.js";
import { BreathPacer } from "./breathpacer.js";
import { loadSessions, saveSession } from "./sessionStore.js";
import { loadRhythmModel, saveRhythmModel } from "./rhythmStore.js";
import { renderRhythmPanel } from "./rhythmPanel.js";
import { renderSciencePanel } from "./sciencePanel.js";
import { bootSucceeded, installGlobalErrorHandlers, registerServiceWorker } from "./boot.js";
import { renderDataPanel } from "./dataPanel.js";
import { restoreBaseline, saveBaseline } from "./baselineStore.js";

const MODES: { key: AnchorName; label: string }[] = [
  { key: "deepWork", label: "Deep Work" },
  { key: "read", label: "Read" },
  { key: "open", label: "Open" },
  { key: "calm", label: "Calm" },
  { key: "screen", label: "Screen" },
  { key: "move", label: "Move" },
  { key: "energy", label: "Energy" },
  { key: "recovery", label: "Recovery" },
  { key: "sleep", label: "Sleep" },
];

/**
 * The side panel carries eight panels of instrumentation. Stacked, that is
 * an unreasonable amount of scrolling on a tablet and worse on a phone, so
 * they are grouped: what's happening right now, what's planned, and the
 * accumulated record.
 */
const TABS = [
  { id: "now", label: "Now" },
  { id: "plan", label: "Plan" },
  { id: "data", label: "Data" },
] as const;

// Installed before any UI construction so a throw during mount is caught.
installGlobalErrorHandlers();

const app = document.getElementById("app")!;
app.innerHTML = `
  <header class="topbar">
    <h1 class="wordmark"><b>SOUND</b>FX</h1>
    <nav class="modes" id="modes" aria-label="Session mode">
      ${MODES.map((m, i) => `<button class="mode-btn${i === 0 ? " active" : ""}" data-mode="${m.key}" aria-pressed="${i === 0}">${m.label}</button>`).join("")}
    </nav>
  </header>
  <main class="main" id="main">
    <section class="stage" aria-label="Session">
      <canvas id="field" aria-hidden="true"></canvas>
      <div class="stage-content">
        <div class="phase-banner" id="phaseBanner" style="display:none" aria-live="polite">
          <div class="phase-name" id="phaseName"></div>
          <div class="phase-intent" id="phaseIntent"></div>
          <div class="phase-track"><div class="phase-fill" id="phaseFill"></div></div>
        </div>
        <div class="stage-bottom">
          <div class="distress-notice" id="distressNotice" style="display:none" role="status"></div>
          <div class="breath-wrap" id="breathWrap" style="display:none">
            <div class="breath-ring-outer" aria-hidden="true"><div class="breath-ring-inner" id="breathRing"></div></div>
            <div class="breath-text">Breathing pacer: <b id="breathPhase">inhale</b><br /><span id="breathHapticNote"></span></div>
          </div>
          <div class="transport">
            <button id="beginBtn" class="begin-btn">Begin session</button>
            <div class="hint" id="hint" aria-live="polite">Tap to begin — audio starts only after your gesture.</div>
          </div>
        </div>
      </div>
    </section>
    <div class="side" role="complementary" aria-label="Instrumentation">
      <div class="tabs" role="tablist" aria-label="Panels">
        ${TABS.map(
          (t, i) =>
            `<button class="tab-btn" role="tab" id="tab-${t.id}" data-tab="${t.id}"
                     aria-selected="${i === 0}" aria-controls="panel-${t.id}"
                     tabindex="${i === 0 ? 0 : -1}">${t.label}</button>`,
        ).join("")}
      </div>
      <div class="side-scroll">
      <div class="tab-panels">
        <div class="tab-panel" id="panel-now" role="tabpanel" aria-labelledby="tab-now">
          <div class="panel span-2">
            <h2>Heart rate — camera rPPG</h2>
            <div class="hr-row">
              <div class="hr-value" id="hrValue" aria-live="polite">—</div>
              <div class="hr-unit">bpm</div>
            </div>
            <div class="hr-status" id="hrStatus" aria-live="polite">Enable your camera to close the loop: heart rate will steer the soundscape live.</div>
            <div class="confidence-bar"><div class="confidence-fill" id="confFill"></div></div>
            <div class="camera-toggle">
              <span id="camSwitchLabel">Camera sensing</span>
              <button class="switch" id="camSwitch" aria-pressed="false" aria-labelledby="camSwitchLabel"></button>
            </div>
            <div class="self-view hidden" id="selfView" aria-hidden="true">
              <video id="selfVideo" muted playsinline autoplay></video>
              <canvas id="selfOverlay"></canvas>
            </div>
            <div id="permBanner" style="display:none" class="perm-banner" role="alert"></div>
          </div>

          <div class="panel">
            <h2>Control vector (live)</h2>
            <div class="vector-grid" id="vectorGrid"></div>
          </div>

          <div class="panel">
            <h2>Engine telemetry</h2>
            <div class="telemetry-grid" id="telemetryGrid"></div>
          </div>
        </div>

        <div class="tab-panel" id="panel-plan" role="tabpanel" aria-labelledby="tab-plan" hidden>
          <div class="panel span-2">
            <h2>Why this mode sounds like this</h2>
            <div id="modeScience"></div>
          </div>

          <div class="panel span-2">
            <h2>Your rhythm — next 24 hours</h2>
            <div id="rhythmPanel"></div>
          </div>

          <div class="panel span-2">
            <h2>Protocols</h2>
            <div class="protocol-list" id="protocolList"></div>
          </div>
        </div>

        <div class="tab-panel" id="panel-data" role="tabpanel" aria-labelledby="tab-data" hidden>
          <div class="panel span-2">
            <h2>Does this work for me?</h2>
            <div id="dashboard"></div>
          </div>

          <div class="panel">
            <h2>Session history — this device only</h2>
            <div class="session-list" id="sessionList"></div>
          </div>

          <div class="panel">
            <h2>Optional techniques — off by default</h2>
            <div class="technique-list" id="techniqueList"></div>
          </div>

          <div class="panel span-2">
            <h2>Your data — stored on this device</h2>
            <div id="dataPanel"></div>
          </div>
        </div>
      </div>

      <div class="footer-note">
        <b>Runs entirely on this device.</b> No audio, video frame, or biometric
        reading is ever uploaded — check the network tab. Sound is synthesised
        sample-by-sample from a neural field decoder; nothing here is a
        recording. Camera-derived heart rate and HRV are estimates from a
        consumer webcam, not a medical measurement.
      </div>
      </div>
    </div>
  </main>
`;

// ---------------------------------------------------------------- DOM refs

const fieldCanvas = document.getElementById("field") as HTMLCanvasElement;
const beginBtn = document.getElementById("beginBtn") as HTMLButtonElement;
const hint = document.getElementById("hint")!;
const modesEl = document.getElementById("modes")!;
const hrValue = document.getElementById("hrValue")!;
const hrStatus = document.getElementById("hrStatus")!;
const confFill = document.getElementById("confFill") as HTMLDivElement;
const camSwitch = document.getElementById("camSwitch") as HTMLButtonElement;
const selfView = document.getElementById("selfView")!;
const selfVideo = document.getElementById("selfVideo") as HTMLVideoElement;
const selfOverlay = document.getElementById("selfOverlay") as HTMLCanvasElement;
const permBanner = document.getElementById("permBanner") as HTMLDivElement;
const vectorGrid = document.getElementById("vectorGrid")!;
const telemetryGrid = document.getElementById("telemetryGrid")!;
const sessionList = document.getElementById("sessionList")!;
const breathWrap = document.getElementById("breathWrap") as HTMLDivElement;
const breathRing = document.getElementById("breathRing") as HTMLDivElement;
const breathPhaseEl = document.getElementById("breathPhase")!;
const breathHapticNote = document.getElementById("breathHapticNote")!;
const protocolList = document.getElementById("protocolList")!;
const dashboard = document.getElementById("dashboard")!;
const techniqueList = document.getElementById("techniqueList")!;
const phaseBanner = document.getElementById("phaseBanner") as HTMLDivElement;
const phaseName = document.getElementById("phaseName")!;
const phaseIntent = document.getElementById("phaseIntent")!;
const phaseFill = document.getElementById("phaseFill") as HTMLDivElement;
const distressNotice = document.getElementById("distressNotice") as HTMLDivElement;
const rhythmPanel = document.getElementById("rhythmPanel")!;
const modeSciencePanel = document.getElementById("modeScience")!;
const dataPanelEl = document.getElementById("dataPanel")!;

// ---------------------------------------------------------------- tabs

const tabList = document.querySelector<HTMLDivElement>(".tabs")!;
const tabButtons = [...tabList.querySelectorAll<HTMLButtonElement>(".tab-btn")];
const tabPanelsEl = document.querySelector<HTMLDivElement>(".tab-panels")!;
const sideScrollEl = document.querySelector<HTMLDivElement>(".side-scroll")!;

function selectTab(id: string, focus = false): void {
  for (const btn of tabButtons) {
    const active = btn.dataset.tab === id;
    btn.setAttribute("aria-selected", String(active));
    // Roving tabindex: only the selected tab is in the tab order, so Tab
    // moves past the whole tablist rather than through every tab.
    btn.tabIndex = active ? 0 : -1;
    if (active && focus) btn.focus();
  }
  for (const panel of tabPanelsEl.querySelectorAll<HTMLElement>(".tab-panel")) {
    panel.hidden = panel.id !== `panel-${id}`;
  }
  // A tab switch is a context change; start the new panel at the top.
  sideScrollEl.scrollTop = 0;
}

tabList.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".tab-btn");
  if (btn?.dataset.tab) selectTab(btn.dataset.tab);
});

tabList.addEventListener("keydown", (e) => {
  const current = tabButtons.findIndex((b) => b.getAttribute("aria-selected") === "true");
  if (current < 0) return;
  let next = -1;
  if (e.key === "ArrowRight") next = (current + 1) % tabButtons.length;
  else if (e.key === "ArrowLeft") next = (current - 1 + tabButtons.length) % tabButtons.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = tabButtons.length - 1;
  if (next < 0) return;
  e.preventDefault();
  selectTab(tabButtons[next].dataset.tab!, true);
});

// ---------------------------------------------------------------- state

let currentMode: AnchorName = "deepWork";

/**
 * Cadence for Move mode, in steps per minute. User-entered: automatic
 * detection needs motion-sensor permission and is unverified on real
 * hardware here (see docs/09-sound-science.md).
 *
 * Declared with the rest of the module state rather than beside setMode,
 * because the initial science-panel render reads it during module
 * evaluation — a `let` declared further down is in its temporal dead zone
 * at that point and throws.
 */
let cadenceSpm = 150;

/** Push the current mode's hard acoustic rules to the engine. */
function applyConstraints(): void {
  const base = constraintsFor(currentMode);
  host.setConstraints(currentMode === "move" ? { ...base, cadenceSpm } : base);
}
let sessionRunning = false;
let cameraEnabled = false;
let lastState: StateVector | null = null;
const baseline = new PhysiologyBaseline();
// Resume a previously learned baseline so the closed loop is usable from the
// first reading rather than spending the first minute or two of every
// session re-learning what normal means. Silently no-ops if absent or stale.
const baselineRestored = restoreBaseline(baseline);

let displayCurrent: ControlVector = anchor(currentMode);
let displayTarget: ControlVector = anchor(currentMode);

const visual = new FieldVisual(fieldCanvas);
const camera = new CameraSensor(selfVideo, selfOverlay);
const breathPacer = new BreathPacer(displayCurrent);
const outcomeRecorder = new OutcomeRecorder();
const distressMonitor = new DistressMonitor();
// Mutable: clearing stored data must be able to replace the live model, not
// just the persisted copy. See renderData's onCleared handler.
let rhythmModel = loadRhythmModel();

/** Active protocol, if the user started one instead of a free-running mode. */
let activeProtocol: Protocol | null = null;
let protocolStartedAtMs = 0;

/** Set once the distress monitor asks the loop to stop pushing. */
let distressDisengaged = false;

/**
 * Consent for gated techniques. Local-only and default-deny; see
 * packages/protocol/src/screening.ts for why this is an acknowledgement
 * record rather than a health questionnaire.
 */
const TECHNIQUE_KEY = "soundfx.techniques.v1";
let techniqueConsent: TechniqueConsent = (() => {
  try {
    const raw = localStorage.getItem(TECHNIQUE_KEY);
    return raw ? (JSON.parse(raw) as TechniqueConsent) : {};
  } catch {
    return {};
  }
})();

const host = new ClfsHost({
  workletUrl: "/worklets/clfs-processor.js",
  onTelemetry: (t) => {
    visual.setTelemetry(t);
    renderTelemetry(t);
  },
});

breathPacer.onTick(({ phase, level }) => {
  // Scale from 10px (empty) to 30px (full) inside the 34px outer ring —
  // a literal, continuous visualisation of the same envelope any haptic
  // pulse is timed against, so the visual and haptic channels never drift
  // apart (both read from the same BreathPacer/breathCycleFor call).
  const scale = 0.3 + level * 0.7;
  breathRing.style.transform = `scale(${scale.toFixed(3)})`;
  breathRing.style.opacity = String(0.55 + level * 0.45);
  breathPhaseEl.textContent = phase === "holdIn" || phase === "holdOut" ? "hold" : phase;
});
breathHapticNote.textContent = breathPacer.hapticsAvailable
  ? "Vibration synced on this device."
  : "No vibration API on this device — visual pacing only.";

// ---------------------------------------------------------------- vector UI

function fmtValue(key: (typeof CONTROL_KEYS)[number], v: number): string {
  if (key === "tempo") return v.toFixed(0);
  if (key === "valence") return (v >= 0 ? "+" : "") + v.toFixed(2);
  return v.toFixed(2);
}

const vectorRows = new Map<string, { fill: HTMLDivElement; num: HTMLDivElement }>();
for (const key of CONTROL_KEYS) {
  const row = document.createElement("div");
  row.className = "vector-row";
  row.innerHTML = `
    <div class="vector-label">${key}</div>
    <div class="vector-track"><div class="vector-fill" data-k="${key}"></div></div>
    <div class="vector-num" data-n="${key}"></div>
  `;
  vectorGrid.appendChild(row);
  vectorRows.set(key, {
    fill: row.querySelector(`[data-k="${key}"]`) as HTMLDivElement,
    num: row.querySelector(`[data-n="${key}"]`) as HTMLDivElement,
  });
}

function renderVector(v: ControlVector): void {
  for (const key of CONTROL_KEYS) {
    const r = CONTROL_RANGES[key];
    const pct = ((v[key] - r.min) / (r.max - r.min)) * 100;
    const row = vectorRows.get(key)!;
    row.fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    row.num.textContent = fmtValue(key, v[key]);
  }
}
renderVector(displayCurrent);

function renderTelemetry(t: ClfsTelemetry): void {
  const items: [string, string][] = [
    ["rms", t.rms.toFixed(3)],
    ["peak", t.peak.toFixed(3)],
    ["voices", `${t.activeVoices}/8`],
    ["grains", `${t.activeGrains}`],
    ["events/s", t.eventsPerSec.toFixed(2)],
    ["root hz", t.rootHz.toFixed(1)],
    ["lattice ratio", t.currentRatio.toFixed(4)],
    ["tenney height", t.tenneyHeight.toFixed(2)],
    ["decoder", t.decoder],
    ["block µs", t.blockMicros.toFixed(0)],
  ];
  telemetryGrid.innerHTML = items
    .map(([k, v]) => `<div class="telemetry-item"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
}

// ---------------------------------------------------------------- session history

const modeLabel = new Map(MODES.map((m) => [m.key, m.label]));

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "<1 min";
  return `${min} min`;
}

function fmtWhen(ms: number): string {
  const diffMin = (Date.now() - ms) / 60000;
  if (diffMin < 60) return `${Math.max(0, Math.round(diffMin))}m ago`;
  if (diffMin < 24 * 60) return `${Math.round(diffMin / 60)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function renderSessionHistory(): void {
  const sessions: SessionOutcome[] = loadSessions();
  if (sessions.length === 0) {
    sessionList.innerHTML = `<div class="session-empty">No sessions yet. History stays on this device only — see the note below.</div>`;
    return;
  }
  sessionList.innerHTML = sessions
    .slice(0, 8)
    .map((s) => {
      const delta = computeDelta(s);
      let pill: string;
      if (!s.cameraUsed || !delta.reliable || delta.hrDeltaBpm == null) {
        pill = `<span class="delta-pill unreliable">not enough signal</span>`;
      } else {
        const arrow = delta.hrDeltaBpm < 0 ? "↓" : delta.hrDeltaBpm > 0 ? "↑" : "→";
        pill = `<span class="delta-pill">${arrow} ${Math.abs(delta.hrDeltaBpm).toFixed(0)} bpm</span>`;
      }
      return `
        <div class="session-row">
          <div>
            <div class="session-mode">${modeLabel.get(s.mode) ?? s.mode}</div>
            <span class="session-meta">${fmtWhen(s.endedAtMs)} · ${fmtDuration(s.durationMs)}</span>
          </div>
          ${pill}
        </div>`;
    })
    .join("");
}
renderSessionHistory();

// ---------------------------------------------------------------- protocols

function renderProtocolList(): void {
  protocolList.innerHTML = PROTOCOLS.map(
    (p) => `
      <button class="protocol-btn${activeProtocol?.id === p.id ? " active" : ""}" data-protocol="${p.id}"
              aria-pressed="${activeProtocol?.id === p.id}">
        <div class="p-name"><span>${p.name}</span><span class="p-dur">${protocolTotalMinutes(p)} min</span></div>
        <div class="p-desc">${p.description}</div>
      </button>`,
  ).join("");
}
renderProtocolList();

function selectProtocol(id: string): void {
  const p = protocolById(id);
  if (!p) return;
  activeProtocol = p;
  protocolStartedAtMs = performance.now();
  // A protocol carries its own mode for safety clamping — adopt it so the
  // controller and the sleep-arousal clamp apply the right invariants.
  setMode(p.mode);
  renderProtocolList();
  retarget();
}

protocolList.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".protocol-btn");
  if (!btn) return;
  const p = protocolById(btn.dataset.protocol!);
  if (!p) return;
  if (activeProtocol?.id === p.id) {
    activeProtocol = null;
    phaseBanner.style.display = "none";
    renderProtocolList();
    retarget();
  } else {
    selectProtocol(p.id);
  }
});

// ------------------------------------------------------------ rhythm panel

function renderModeScience(): void {
  renderSciencePanel(modeSciencePanel, currentMode, {
    cadenceSpm,
    onCadenceChange: (spm) => {
      cadenceSpm = spm;
      // Applies live: re-entraining mid-run is the normal case, not an edge
      // case, since cadence drifts as you tire.
      applyConstraints();
    },
  });
}

function renderRhythm(): void {
  renderRhythmPanel({
    container: rhythmPanel,
    model: rhythmModel,
    // Accepting a suggestion selects the protocol and starts the session —
    // but only ever from this explicit tap. Nothing auto-starts; see
    // packages/protocol/src/rhythm/suggest.ts.
    onStartProtocol: (id) => {
      selectProtocol(id);
      if (!sessionRunning) beginBtn.click();
    },
  });
}
renderRhythm();
renderModeScience();

function renderData(): void {
  renderDataPanel({
    container: dataPanelEl,
    onCleared: (what) => {
      // Refresh whatever the cleared store fed, so the UI can never keep
      // showing data the user just deleted.
      if (what === "sessions" || what === "all") {
        renderSessionHistory();
        renderDashboard();
      }
      if (what === "rhythm" || what === "all") {
        // Replace the in-memory model too. Clearing only storage would leave
        // the learned rhythm live for the rest of the session, so the user
        // would delete their data and still be shown a forecast built from
        // it — and it would be re-persisted at the next session end.
        rhythmModel = new PersonalRhythmModel();
        renderRhythm();
      }
      if (what === "baseline" || what === "all") baseline.reset();
      if (what === "techniques" || what === "all") {
        // Reset the in-memory copy too. Clearing only the stored value would
        // leave the toggles on until reload, so the user would see their
        // acknowledgements still active immediately after deleting them —
        // and, worse, gated techniques would remain enabled.
        techniqueConsent = {};
        renderTechniques();
      }
    },
  });
}
renderData();

/** Advance the active protocol; returns its target, or null if none/finished. */
function protocolTarget(): ControlVector | null {
  if (!activeProtocol) return null;
  const elapsedMin = (performance.now() - protocolStartedAtMs) / 60000;
  const pos = protocolPositionAt(activeProtocol, elapsedMin);
  phaseBanner.style.display = "block";
  phaseName.textContent = `${activeProtocol.name} · ${pos.phase.name}`;
  phaseIntent.textContent = pos.phase.intent;
  phaseFill.style.width = `${(pos.totalProgress * 100).toFixed(1)}%`;
  return pos.target;
}

// ---------------------------------------------------------------- dashboard

function renderDashboard(): void {
  const sessions = loadSessions();
  const summaries = MODES.map((m) => summariseMode(m.key, sessions)).filter((s) => s.n > 0);

  if (summaries.length === 0) {
    dashboard.innerHTML = `<div class="session-empty">Nothing to show yet. After a few sessions with camera sensing on, your own numbers appear here — no one else's.</div>`;
    return;
  }

  const rows = summaries
    .map((s) => {
      const value =
        s.meanHrDeltaBpm == null
          ? `<span class="dash-val">not enough signal</span>`
          : `<span class="dash-val">${s.meanHrDeltaBpm < 0 ? "↓" : "↑"} ${Math.abs(s.meanHrDeltaBpm).toFixed(1)} bpm avg</span>`;
      return `
        <div class="dash-row">
          <div>
            <div class="dash-mode">${modeLabel.get(s.mode) ?? s.mode}</div>
            <span class="dash-n">${s.n} session${s.n === 1 ? "" : "s"} · ${s.nReliable} with usable signal · ${s.meanSessionMinutes.toFixed(0)} min avg</span>
          </div>
          ${value}
        </div>`;
    })
    .join("");

  // The caveat is not boilerplate — it is the difference between an honest
  // dashboard and an efficacy claim. See docs/07-claims.md.
  dashboard.innerHTML = `${rows}
    <div class="dash-caveat">
      These are your own before/after readings, not evidence that SoundFX caused the change.
      Sitting still for ten minutes lowers most people's heart rate on its own. Telling those
      apart needs a blinded comparison, which isn't built yet.
    </div>`;
}
renderDashboard();

// ---------------------------------------------------------------- techniques

function renderTechniques(): void {
  techniqueList.innerHTML = GATED_TECHNIQUES.map((t) => {
    const on = isTechniqueEnabled(techniqueConsent, t.id);
    return `
      <div class="technique-row">
        <div>
          <div class="technique-label">${t.label}${t.experimental ? `<span class="technique-exp">experimental</span>` : ""}</div>
          <div class="technique-warn">${t.contraindication}</div>
        </div>
        <button class="switch${on ? " on" : ""}" data-technique="${t.id}" aria-pressed="${on}"
                aria-label="Enable ${t.label}"></button>
      </div>`;
  }).join("");
}
renderTechniques();

techniqueList.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-technique]");
  if (!btn) return;
  const id = btn.dataset.technique as (typeof GATED_TECHNIQUES)[number]["id"];
  techniqueConsent = { ...techniqueConsent, [id]: !isTechniqueEnabled(techniqueConsent, id) };
  try {
    localStorage.setItem(TECHNIQUE_KEY, JSON.stringify(techniqueConsent));
  } catch {
    // Persistence is best-effort; the in-memory consent still applies.
  }
  renderTechniques();
});

// ---------------------------------------------------------------- UI ticker

let lastTick = performance.now();
function tick(): void {
  const now = performance.now();
  const dt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  // Mirrors the audio thread's own slew law (control.ts) so the on-screen
  // vector and the generative visual track the real, audible state rather
  // than jumping straight to target.
  displayCurrent = slewToward(displayCurrent, displayTarget, dt);
  visual.setControl(displayCurrent);
  renderVector(displayCurrent);
  breathPacer.setControl(displayCurrent);
  breathPacer.tick();

  // A running protocol continuously re-derives its scheduled target, so
  // phases advance on wall-clock time whether or not a biosignal arrives.
  if (activeProtocol && sessionRunning) {
    protocolTickAccum += dt;
    if (protocolTickAccum >= 1) {
      protocolTickAccum = 0;
      retarget();
    }
  }

  requestAnimationFrame(tick);
}
let protocolTickAccum = 0;
requestAnimationFrame(tick);
visual.start();

// ---------------------------------------------------------------- mode select

function setMode(mode: AnchorName): void {
  currentMode = mode;
  applyConstraints();
  renderModeScience();
  modesEl.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((b) => {
    const isActive = b.dataset.mode === mode;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-pressed", String(isActive));
    // The mode strip scrolls horizontally on narrow screens, so a mode
    // adopted programmatically (by starting a protocol) can be off-screen.
    // Bring it into view or the UI appears not to have responded.
    if (isActive) b.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

modesEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mode-btn");
  if (!btn) return;
  const mode = btn.dataset.mode as AnchorName;
  if (mode === currentMode) return;
  // Choosing a mode by hand leaves any running protocol — the two are
  // alternative ways to drive the same control vector, not layers.
  if (activeProtocol) {
    activeProtocol = null;
    phaseBanner.style.display = "none";
    renderProtocolList();
  }
  setMode(mode);
  retarget();
});

/**
 * Recompute the engine target.
 *
 * Precedence: an active protocol supplies the base target (its scheduled
 * phase waypoint); otherwise the mode anchor does. The biofeedback
 * controller then adjusts *relative to the mode's anchor* and that
 * adjustment is applied as a delta on top of the base, so a protocol's
 * shape and the closed loop compose rather than one overwriting the other.
 *
 * `distressDisengaged` short-circuits the controller entirely: when the
 * loop has demonstrably not been helping, it stops pushing rather than
 * pushing harder (see packages/protocol/src/distress.ts).
 */
function retarget(): void {
  const base = protocolTarget() ?? anchor(currentMode);

  if (!distressDisengaged && cameraEnabled && lastState && lastState.heartRateBpm != null) {
    const result = computeAdjustment(currentMode, lastState, baseline);
    const modeAnchor = anchor(currentMode);
    const adjusted: ControlVector = { ...base };
    for (const k of CONTROL_KEYS) {
      adjusted[k] = base[k] + (result.target[k] - modeAnchor[k]);
    }
    displayTarget = clampControl(adjusted);
    hrStatus.textContent = result.explanation;
  } else {
    displayTarget = base;
  }

  if (sessionRunning) host.setTarget(displayTarget);
}

// ---------------------------------------------------------------- session transport

beginBtn.addEventListener("click", async () => {
  if (!sessionRunning) {
    beginBtn.disabled = true;
    beginBtn.textContent = "Starting…";
    displayCurrent = anchor(currentMode);
    displayTarget = anchor(currentMode);
    try {
      await host.start(displayCurrent);
      sessionRunning = true;
      beginBtn.textContent = "End session";
      beginBtn.classList.add("ending");
      hint.textContent = "Session running — switch modes anytime, or enable camera sensing.";
      outcomeRecorder.begin(currentMode, cameraEnabled, baseline, Date.now());
      breathPacer.start();
      breathWrap.style.display = "flex";
      distressMonitor.reset();
      distressDisengaged = false;
      distressNotice.style.display = "none";
      if (activeProtocol) protocolStartedAtMs = performance.now();
    } catch (err) {
      // A stuck "Starting…" button with no way forward is worse than an
      // honest failure message — this covers AudioContext creation being
      // blocked, the worklet module failing to load (404, bad MIME, an
      // engine without AudioWorklet support), etc.
      const reason = err instanceof Error ? err.message : String(err);
      hint.textContent = `Couldn't start the audio engine: ${reason}`;
      beginBtn.textContent = "Begin session";
    } finally {
      beginBtn.disabled = false;
    }
  } else {
    beginBtn.disabled = true;
    beginBtn.textContent = "Ending…";
    try {
      await host.stop(3);
    } finally {
      // host.stop() itself guarantees a clean internal reset even on
      // failure (see host.ts) — mirror that here so the transport button
      // is never left permanently disabled/mislabelled.
      sessionRunning = false;
      beginBtn.disabled = false;
      beginBtn.textContent = "Begin session";
      beginBtn.classList.remove("ending");
      hint.textContent = "Tap to begin — audio starts only after your gesture.";
      breathPacer.stop();
      breathWrap.style.display = "none";
      if (outcomeRecorder.isOpen) {
        const outcome = outcomeRecorder.end(baseline, Date.now());
        if (outcome) {
          saveSession(outcome);
          renderSessionHistory();
          renderDashboard();
        }
      }
      // Persist learned state at session end rather than per reading — one
      // localStorage write instead of one per second.
      saveRhythmModel(rhythmModel);
      saveBaseline(baseline);
      renderRhythm();
      renderData();
    }
  }
});

// ---------------------------------------------------------------- camera / rPPG

camSwitch.addEventListener("click", async () => {
  if (!cameraEnabled) {
    permBanner.style.display = "none";
    camSwitch.disabled = true;
    const res = await camera.start();
    camSwitch.disabled = false;
    if (!res.ok) {
      permBanner.textContent = `Camera unavailable: ${res.reason}`;
      permBanner.style.display = "block";
      return;
    }
    cameraEnabled = true;
    camSwitch.classList.add("on");
    camSwitch.setAttribute("aria-pressed", "true");
    selfView.classList.remove("hidden");
    hrStatus.textContent = "Finding your face…";
  } else {
    camera.stop();
    cameraEnabled = false;
    lastState = null;
    camSwitch.classList.remove("on");
    camSwitch.setAttribute("aria-pressed", "false");
    selfView.classList.add("hidden");
    hrValue.textContent = "—";
    confFill.style.width = "0%";
    hrStatus.textContent = "Enable your camera to close the loop: heart rate will steer the soundscape live.";
    retarget();
  }
});

camera.onReading((reading: RppgReading) => {
  updateHrUi(reading);

  const state: StateVector = {
    timestampMs: reading.timestampMs,
    heartRateBpm: reading.warmedUp ? reading.bpm : null,
    heartRateConfidence: reading.confidence,
    hrvRmssdMs: reading.hrv && reading.hrv.quality !== "unusable" ? reading.hrv.rmssdMs : null,
    hrvConfidence: reading.hrv ? (reading.hrv.quality === "medium" ? 0.6 : reading.hrv.quality === "low" ? 0.3 : 0) : 0,
  };
  baseline.update(state);
  lastState = state;

  if (state.heartRateBpm != null) {
    if (sessionRunning && outcomeRecorder.isOpen) outcomeRecorder.recordSample();

    // Feed the Rhythm Model. The arousal proxy is HR expressed against this
    // user's own rolling baseline, so what the model learns is "hotter or
    // cooler than usual for me at this hour", not an absolute BPM curve —
    // which is what makes it comparable across days and personal by
    // construction. Only confident readings against a trusted baseline
    // count, so a noisy first minute cannot bias the fit.
    if (baseline.hr.trusted && state.heartRateConfidence >= 0.3) {
      rhythmModel.observe({
        timestampMs: state.timestampMs,
        arousalZ: baseline.hr.zScore(state.heartRateBpm, 3),
        weight: state.heartRateConfidence,
      });
    }

    const assessment = distressMonitor.update(currentMode, state, baseline);
    if (assessment.level === "notLanding") {
      distressDisengaged = assessment.shouldDisengage;
      showDistressNotice(assessment.message);
    }

    retarget();
  }
});

function showDistressNotice(message: string): void {
  // Deliberately inline and dismissible, never a modal: a message that
  // blocks the screen at the moment someone is already having a hard time
  // is the opposite of helpful. See docs/06-safety.md.
  distressNotice.innerHTML = `
    <div>${message.replace(
      "findahelpline.com",
      `<a href="https://findahelpline.com" target="_blank" rel="noopener noreferrer">findahelpline.com</a>`,
    )}</div>
    <button class="distress-dismiss" id="distressDismiss">Dismiss</button>`;
  distressNotice.style.display = "block";
  document.getElementById("distressDismiss")?.addEventListener("click", () => {
    distressNotice.style.display = "none";
  });
}

function updateHrUi(reading: RppgReading): void {
  if (reading.roi == null) {
    hrValue.textContent = "—";
    confFill.style.width = "0%";
    if (cameraEnabled) hrStatus.textContent = "No face detected — centre yourself in frame with even lighting.";
    return;
  }
  if (!reading.warmedUp) {
    hrValue.textContent = "…";
    confFill.style.width = `${Math.round(reading.confidence * 100)}%`;
    hrStatus.textContent = "Calibrating — hold still for a few seconds.";
    return;
  }
  hrValue.textContent = reading.bpm.toFixed(0);
  confFill.style.width = `${Math.round(Math.max(8, reading.confidence * 100))}%`;
}

// Keep the self-view overlay canvas pixel-matched to the video element.
function syncOverlaySize(): void {
  selfOverlay.width = selfVideo.clientWidth;
  selfOverlay.height = selfVideo.clientHeight;
}
window.addEventListener("resize", syncOverlaySize);
selfVideo.addEventListener("loadedmetadata", syncOverlaySize);

// Dev-only inspection hook (stripped from production builds by Vite's
// import.meta.env.DEV dead-code elimination). Lets automated QA and the
// eval harness poke live module state from the console/CDP without adding
// any test-only branching to the app logic itself.
if (import.meta.env.DEV) {
  (window as unknown as { __soundfx_debug: unknown }).__soundfx_debug = {
    visual,
    host,
    camera,
    breathPacer,
    outcomeRecorder,
    distressMonitor,
    getState: () => ({
      currentMode,
      sessionRunning,
      cameraEnabled,
      displayCurrent,
      displayTarget,
      activeProtocol: activeProtocol?.id ?? null,
      distressDisengaged,
    }),
    /** Rewind the protocol clock to simulate elapsed minutes, for QA. */
    simulateProtocolMinutes: (minutes: number) => {
      protocolStartedAtMs = performance.now() - minutes * 60000;
      retarget();
    },
    // Getter, not a value: rhythmModel is reassigned when the user deletes
    // their rhythm data, and a captured reference would keep reporting the
    // discarded model.
    get rhythmModel() {
      return rhythmModel;
    },
    /**
     * Seed the Rhythm Model with synthetic history so the "ready" state can
     * be exercised without waiting a real week. Dev-only (this whole block
     * is stripped from production builds) and clearly synthetic — it is a
     * QA affordance, never a way to show a user a rhythm they didn't earn.
     */
    seedSyntheticRhythm: (days = 40) => {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      let s = 424242;
      const rand = () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        s |= 0;
        return (s >>> 0) / 4294967296;
      };
      for (let d = days; d >= 1; d--) {
        const base = midnight.getTime() - d * 86400000;
        for (const hour of [7, 10, 13, 16, 19, 22]) {
          rhythmModel.observe({
            timestampMs: base + hour * 3600000,
            arousalZ: 0.55 * Math.cos((2 * Math.PI * (hour - 15)) / 24) + 0.2 * (rand() * 2 - 1),
            weight: 0.9,
          });
        }
      }
      saveRhythmModel(rhythmModel);
      renderRhythm();
      return rhythmModel.coverage();
    },
  };
}

// ------------------------------------------------------------ startup done

/**
 * The UI is mounted and interactive. Dismiss the boot screen and let the
 * global error handler know that later exceptions should not replace a
 * working session with a fatal-error page.
 */
document.dispatchEvent(new Event("soundfx:mounted"));
bootSucceeded();
registerServiceWorker();
