import { clearAll, clearStore, formatBytes, inventory, type StoreId } from "./storage.js";

/**
 * "Your data" — inventory and deletion.
 *
 * The privacy documentation says everything stays on this device. That claim
 * is only half-honest without a way to see what "everything" is and remove
 * it: telling someone their data is local while giving them no control over
 * it leaves them with browser settings as the only option, which most people
 * will never find.
 *
 * Deletion is genuinely destructive and irreversible, so every button is
 * two-step. A native `confirm()` would be less code, but it is suppressible
 * per-origin in some browsers, and a suppressed confirm on a destructive
 * action silently turns a two-step flow into a one-step one.
 */

export interface DataPanelDeps {
  container: HTMLElement;
  /** Refresh whatever depended on the cleared store. */
  onCleared: (what: StoreId | "all") => void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function describe(count: number | null, bytes: number): string {
  const size = formatBytes(bytes);
  if (count === null) return size;
  return `${count} ${count === 1 ? "entry" : "entries"} · ${size}`;
}

export function renderDataPanel({ container, onCleared }: DataPanelDeps): void {
  const items = inventory();
  const anyPresent = items.some((i) => i.present);
  const totalBytes = items.reduce((s, i) => s + i.bytes, 0);

  container.innerHTML = `
    <p class="data-intro">
      Everything below is stored in this browser on this device only. There is no
      account, no server, and no copy anywhere else — so clearing it here removes it
      permanently, and it cannot be restored.
    </p>
    <div class="data-list">
      ${items
        .map(
          (i) => `
        <div class="data-row${i.present ? "" : " data-empty"}" data-store="${i.descriptor.id}">
          <div class="data-meta">
            <div class="data-label">${escapeHtml(i.descriptor.label)}</div>
            <div class="data-desc">${escapeHtml(i.descriptor.description)}</div>
          </div>
          <div class="data-actions">
            <span class="data-size">${i.present ? describe(i.count, i.bytes) : "nothing stored"}</span>
            ${
              i.present
                ? `<button class="data-clear" data-clear="${i.descriptor.id}">Delete</button>`
                : ""
            }
          </div>
        </div>`,
        )
        .join("")}
    </div>
    ${
      anyPresent
        ? `<div class="data-all">
             <span class="data-total">${formatBytes(totalBytes)} total</span>
             <button class="data-clear data-clear-all" data-clear="all">Delete everything</button>
           </div>`
        : `<p class="data-none">Nothing is stored yet.</p>`
    }
  `;

  for (const btn of container.querySelectorAll<HTMLButtonElement>("[data-clear]")) {
    btn.addEventListener("click", () => armConfirm(btn, container, onCleared));
  }
}

/**
 * Turn a Delete button into an inline confirm, reverting after 6 seconds so
 * an armed destructive control never sits waiting indefinitely for a
 * mis-tap.
 */
function armConfirm(
  btn: HTMLButtonElement,
  container: HTMLElement,
  onCleared: (what: StoreId | "all") => void,
): void {
  if (btn.dataset.armed === "true") return;
  const target = btn.dataset.clear as StoreId | "all";
  const original = btn.textContent ?? "Delete";

  btn.dataset.armed = "true";
  btn.classList.add("armed");
  btn.textContent = "Tap again to confirm";

  const disarm = () => {
    clearTimeout(timer);
    btn.dataset.armed = "false";
    btn.classList.remove("armed");
    btn.textContent = original;
    btn.removeEventListener("click", confirmHandler);
  };
  const timer = setTimeout(disarm, 6000);

  const confirmHandler = (e: Event) => {
    e.stopPropagation();
    clearTimeout(timer);
    if (target === "all") clearAll();
    else clearStore(target);
    onCleared(target);
    renderDataPanel({ container, onCleared });
  };

  // Re-bind on the next tick so the click that armed it doesn't immediately
  // fire the confirm handler.
  setTimeout(() => btn.addEventListener("click", confirmHandler, { once: true }), 0);
}
