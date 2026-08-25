import {
  suggestNext,
  type PersonalRhythmModel,
  type ProtocolSuggestion,
  type RhythmPrediction,
} from "@soundfx/protocol";

/**
 * "Your rhythm" surface.
 *
 * Renders one of two honest states and never anything in between:
 *
 *  - **Not ready.** Shows coverage progress and exactly what is still
 *    missing (`readinessNote`). No curve, no forecast, no placeholder
 *    shape that implies knowledge the model does not have.
 *  - **Ready.** Shows the fitted 24-hour curve *with its uncertainty band*,
 *    which model won the held-out comparison, and the next suggestion.
 *
 * The uncertainty band is not decoration. A forecast drawn as a confident
 * line is a claim; drawn with a visible ±1σ envelope it is an estimate. The
 * band widens at times of day this user rarely uses the app, which is the
 * honest thing for it to do.
 */

const W = 300;
const H = 84;
const PAD_X = 6;
const PAD_Y = 8;
/** Fixed z-range so the curve's vertical scale is stable between renders. */
const Z_MIN = -1.6;
const Z_MAX = 1.6;

function xForIndex(i: number, n: number): number {
  return PAD_X + (i / Math.max(1, n - 1)) * (W - 2 * PAD_X);
}

function yForZ(z: number): number {
  const t = (z - Z_MIN) / (Z_MAX - Z_MIN);
  return PAD_Y + (1 - Math.min(1, Math.max(0, t))) * (H - 2 * PAD_Y);
}

function curveSvg(curve: RhythmPrediction[], nowMs: number): string {
  if (curve.length < 2) return "";
  const n = curve.length;

  const centre = curve.map((p, i) => `${i === 0 ? "M" : "L"}${xForIndex(i, n).toFixed(1)},${yForZ(p.arousalZ).toFixed(1)}`).join(" ");

  // ±1σ envelope, forward along the upper edge then back along the lower.
  const upper = curve.map((p, i) => `${i === 0 ? "M" : "L"}${xForIndex(i, n).toFixed(1)},${yForZ(p.arousalZ + p.std).toFixed(1)}`);
  const lower = curve
    .slice()
    .reverse()
    .map((p, i) => `L${xForIndex(n - 1 - i, n).toFixed(1)},${yForZ(p.arousalZ - p.std).toFixed(1)}`);
  const band = [...upper, ...lower, "Z"].join(" ");

  const zeroY = yForZ(0).toFixed(1);

  // Marker for "now" — the curve starts at the current hour.
  const nowX = xForIndex(0, n).toFixed(1);

  return `
    <svg class="rhythm-curve" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Forecast of your arousal level over the next 24 hours, with an uncertainty band.">
      <line x1="${PAD_X}" y1="${zeroY}" x2="${W - PAD_X}" y2="${zeroY}" class="rc-axis" />
      <path d="${band}" class="rc-band" />
      <path d="${centre}" class="rc-line" />
      <circle cx="${nowX}" cy="${yForZ(curve[0].arousalZ).toFixed(1)}" r="3" class="rc-now" />
    </svg>
    <div class="rhythm-axis-labels" aria-hidden="true">
      <span>now</span><span>+12h</span><span>+24h</span>
    </div>`;
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function suggestionHtml(s: ProtocolSuggestion | null): string {
  if (!s) {
    return `<div class="rhythm-none">Nothing worth suggesting in the next few hours. That's a normal answer — this only speaks up when it has something specific.</div>`;
  }
  const when = s.openNow ? "open now" : `opens ${fmtClock(s.startAtMs)}`;
  return `
    <div class="rhythm-suggestion">
      <div class="rs-head">
        <span class="rs-name">${s.protocol.name}</span>
        <span class="rs-when">${when}</span>
      </div>
      <div class="rs-reason">${s.reason}</div>
      <button class="rs-start" id="rhythmStartBtn" data-protocol="${s.protocol.id}">
        Start ${s.protocol.name}
      </button>
    </div>`;
}

export interface RhythmPanelDeps {
  container: HTMLElement;
  model: PersonalRhythmModel;
  /** Called when the user accepts a suggestion. Never called automatically. */
  onStartProtocol: (protocolId: string) => void;
}

export function renderRhythmPanel({ container, model, onStartProtocol }: RhythmPanelDeps): void {
  const now = Date.now();

  if (!model.isReady()) {
    const c = model.coverage();
    const pct = (v: number, target: number) => Math.min(100, (v / target) * 100);
    container.innerHTML = `
      <div class="rhythm-learning">
        <div class="rl-title">Still learning your rhythm</div>
        <div class="rl-note">${model.readinessNote()}</div>
        <div class="rl-bars">
          <div class="rl-bar"><span>readings</span><div class="rl-track"><div class="rl-fill" style="width:${pct(c.totalObservations, 60).toFixed(0)}%"></div></div><b>${c.totalObservations}/60</b></div>
          <div class="rl-bar"><span>times of day</span><div class="rl-track"><div class="rl-fill" style="width:${pct(c.distinctHours, 5).toFixed(0)}%"></div></div><b>${c.distinctHours}/5</b></div>
          <div class="rl-bar"><span>days</span><div class="rl-track"><div class="rl-fill" style="width:${pct(c.distinctDays, 4).toFixed(0)}%"></div></div><b>${c.distinctDays}/4</b></div>
        </div>
        <div class="rl-why">It won't forecast from a handful of readings at one time of day — that would be extrapolation dressed up as a prediction.</div>
      </div>`;
    return;
  }

  const curve = model.dailyCurve(now, 30);
  const suggestion = suggestNext(model, now);
  const basis = model.selectedBasis();

  container.innerHTML = `
    ${curveSvg(curve, now)}
    ${suggestionHtml(suggestion)}
    <details class="rhythm-explain">
      <summary>How this was fitted</summary>
      <div class="re-body">
        <p>Best-fitting shape for your data: <b>${basis.label}</b>. ${basis.description}</p>
        <p>Chosen by scoring five candidate models on readings they hadn't seen yet, so a richer
        curve only wins if it actually predicts you better.</p>
        <table class="re-table">
          <tr><th>model</th><th>error</th></tr>
          ${model
            .modelScores()
            .map(
              (s) =>
                `<tr class="${s.id === basis.id ? "re-win" : ""}"><td>${s.label}</td><td>${
                  s.meanSquaredError == null ? "—" : s.meanSquaredError.toFixed(3)
                }</td></tr>`,
            )
            .join("")}
        </table>
        <p class="re-caveat">The shaded band is ±1 standard deviation. It widens at times of day
        you rarely use the app, because there the curve is extrapolating.</p>
      </div>
    </details>`;

  container.querySelector<HTMLButtonElement>("#rhythmStartBtn")?.addEventListener("click", (e) => {
    const id = (e.currentTarget as HTMLButtonElement).dataset.protocol;
    if (id) onStartProtocol(id);
  });
}
