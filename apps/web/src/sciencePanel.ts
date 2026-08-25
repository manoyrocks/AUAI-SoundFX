import { scienceFor, evidenceLabel, type ModeScience } from "@soundfx/protocol";
import type { AnchorName } from "@soundfx/engine";

/**
 * "Why this mode sounds like this" — the transparency surface for the
 * sound-science grounding.
 *
 * Design rule: the evidence badge and the limitations paragraph are not
 * collapsible and not de-emphasised. A product that hides its caveats behind
 * a disclosure triangle while showing citations prominently is using the
 * citations as decoration. If a mode rests on weaker evidence than another,
 * that has to be visible at the same glance as the claim.
 */

const EVIDENCE_CLASS: Record<string, string> = {
  established: "ev-established",
  moderate: "ev-moderate",
  mechanism: "ev-mechanism",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function render(sci: ModeScience): string {
  return `
    <div class="sci">
      <div class="sci-head">
        <span class="sci-name">${escapeHtml(sci.label)}</span>
        <span class="sci-ev ${EVIDENCE_CLASS[sci.evidence]}">${escapeHtml(evidenceLabel(sci.evidence))}</span>
      </div>
      <p class="sci-tagline">${escapeHtml(sci.tagline)}</p>

      <div class="sci-block">
        <div class="sci-label">What the sound does</div>
        <p>${escapeHtml(sci.design)}</p>
      </div>

      <div class="sci-block">
        <div class="sci-label">The finding it comes from</div>
        <p>${escapeHtml(sci.mechanism)}</p>
      </div>

      <div class="sci-block sci-limits">
        <div class="sci-label">What this does not establish</div>
        <p>${escapeHtml(sci.limitations)}</p>
      </div>

      <details class="sci-cites">
        <summary>Sources (${sci.citations.length})</summary>
        <ul>
          ${sci.citations
            .map(
              (c) =>
                `<li><span class="cite-ref">${escapeHtml(c.ref)}</span>
                 <span class="cite-sup">${escapeHtml(c.supports)}</span></li>`,
            )
            .join("")}
        </ul>
      </details>
    </div>`;
}

export interface SciencePanelOptions {
  /** Current cadence in steps per minute; only used by Move. */
  cadenceSpm?: number;
  onCadenceChange?: (spm: number) => void;
}

export function renderSciencePanel(container: HTMLElement, mode: AnchorName, opts: SciencePanelOptions = {}): void {
  const sci = scienceFor(mode);
  if (!sci) {
    // The five original modes have no research writeup yet. Say so plainly
    // rather than inventing one — an empty state is more honest than
    // retrofitting citations onto anchors that were tuned by ear.
    container.innerHTML = `
      <p class="sci-none">This mode was designed by ear against the control vector, not derived
      from a specific published finding. The four newer modes — Read, Open, Screen and Move —
      each trace to particular literature; select one to see it.</p>`;
    return;
  }
  container.innerHTML = render(sci);

  // Move is the only mode with a parameter the user must supply: without a
  // cadence there is nothing to entrain to, and guessing one would produce a
  // beat at the wrong rate, which is worse than no beat at all.
  if (mode === "move") {
    const spm = opts.cadenceSpm ?? 150;
    const row = document.createElement("div");
    row.className = "cadence-row";
    row.innerHTML = `
      <label for="cadenceInput">Your cadence</label>
      <input id="cadenceInput" type="range" min="60" max="200" step="1" value="${spm}"
             aria-label="Cadence in steps per minute" />
      <span class="cadence-val" id="cadenceVal">${spm} spm</span>`;
    container.querySelector(".sci")?.appendChild(row);

    const input = row.querySelector<HTMLInputElement>("#cadenceInput")!;
    const val = row.querySelector<HTMLSpanElement>("#cadenceVal")!;
    input.addEventListener("input", () => {
      const v = Number(input.value);
      val.textContent = `${v} spm`;
      opts.onCadenceChange?.(v);
    });
  }
}
