/**
 * Startup lifecycle: the boot screen, fatal-error surface, and service-worker
 * registration.
 *
 * The pieces here exist because a blank dark page is the default failure mode
 * of a module-script app. If the bundle fails to parse, a top-level throw
 * escapes, or an async init rejects, nothing renders and there is no
 * indication that anything was supposed to. The boot element in index.html is
 * present before any script runs; this module either removes it on success or
 * converts it into a readable failure.
 */

const BOOT_ID = "boot";

function bootEl(): HTMLElement | null {
  return document.getElementById(BOOT_ID);
}

/** Called once the UI has mounted. */
export function bootSucceeded(): void {
  const el = bootEl();
  if (!el) return;
  el.classList.add("boot-hidden");
  // Remove rather than just hide: it is a role="status" live region, and
  // leaving it in the tree means screen readers can still reach "Starting
  // SoundFX…" after the app is up.
  el.remove();
}

/**
 * Convert the boot screen into a fatal-error surface.
 *
 * Deliberately plain: no stack trace, no error code, no "contact support"
 * for a product with no support channel. It says what happened, offers the
 * one action that ever helps (reload), and — because this app stores
 * everything locally — points out that a persistent failure may be corrupt
 * local state, with a way to clear it.
 */
export function bootFailed(reason: string): void {
  let el = bootEl();
  if (!el) {
    // The app had already mounted and then died. Rebuild a surface over it.
    el = document.createElement("div");
    el.id = BOOT_ID;
    document.body.appendChild(el);
  }
  el.classList.remove("boot-hidden");
  el.classList.add("boot-failed");
  el.innerHTML = `
    <div class="boot-mark" aria-hidden="true"></div>
    <p class="boot-text">SoundFX couldn't start.</p>
    <p class="boot-text">${escapeHtml(reason)}</p>
    <button class="boot-retry" id="bootReload">Reload</button>
    <button class="boot-retry" id="bootReset">Reload and clear local data</button>
  `;
  el.querySelector("#bootReload")?.addEventListener("click", () => location.reload());
  el.querySelector("#bootReset")?.addEventListener("click", () => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("soundfx.")) localStorage.removeItem(key);
      }
    } catch {
      /* storage may be unavailable; reloading is still worth trying */
    }
    location.reload();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Catch errors that escape everything else.
 *
 * Two rules kept deliberately narrow:
 *  - Only surface a fatal screen if the app never mounted. Once the UI is up,
 *    an isolated exception (a rendering glitch in one panel) should not
 *    replace a working session with an error page — especially not one that
 *    is mid-audio.
 *  - Nothing is reported anywhere. There is no telemetry endpoint in this
 *    product, and adding one for crash reports would quietly break the
 *    "nothing leaves your device" guarantee.
 */
export function installGlobalErrorHandlers(): void {
  let mounted = false;
  const markMounted = () => {
    mounted = true;
  };
  document.addEventListener("soundfx:mounted", markMounted, { once: true });

  window.addEventListener("error", (ev) => {
    if (mounted) return;
    bootFailed(ev.message || "An unexpected error occurred during startup.");
  });

  window.addEventListener("unhandledrejection", (ev) => {
    if (mounted) return;
    const reason = ev.reason instanceof Error ? ev.reason.message : String(ev.reason ?? "");
    bootFailed(reason || "An unexpected error occurred during startup.");
  });
}

/**
 * Register the service worker.
 *
 * Only in production builds: in dev it would serve stale modules and fight
 * Vite's HMR, which is a well-known way to lose an hour to a phantom bug.
 * Failure is non-fatal — the app works fine without offline support.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline capability is an enhancement, never a requirement.
    });
  });
}
