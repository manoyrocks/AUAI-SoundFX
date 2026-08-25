import { defineConfig, type Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";

/**
 * Emit the list of content-hashed build outputs for the service worker to
 * precache.
 *
 * Without this the SW can only precache the static paths it knows by name.
 * The hashed JS/CSS bundles are fetched by the browser *before* the worker
 * takes control on a first visit, so its fetch handler never sees them and
 * they never enter the cache — the app then appears to support offline while
 * actually serving a shell with no bundle. It self-heals on a second visit,
 * which is exactly the kind of bug that passes a casual test and fails a
 * real user who installs and immediately loses connectivity.
 *
 * Emitting the list at build time keeps sw.js free of hashes and needs no
 * regeneration step of its own.
 */
function precacheManifest(): Plugin {
  return {
    name: "soundfx-precache-manifest",
    apply: "build",
    generateBundle(_options, bundle) {
      const urls = Object.keys(bundle)
        .filter((f) => /\.(js|css)$/.test(f))
        .map((f) => `/${f}`)
        .sort();
      this.emitFile({
        type: "asset",
        fileName: "precache-manifest.json",
        source: JSON.stringify({ assets: urls }, null, 2),
      });
    },
  };
}

function pkgSrc(pkg: string): string {
  return fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));
}

export default defineConfig({
  plugins: [precacheManifest()],
  resolve: {
    // Package.json "main"/"exports" point at compiled dist/ output — the
    // correct public interface for a plain-Node consumer (see the workspace
    // packages' own test suites, which import dist directly). For the web
    // app's dev server we instead alias straight to TS source: edits to
    // engine/biosignal/protocol then hot-reload immediately without an
    // intermediate `tsc -b`, which matters constantly during DSP iteration.
    // Production `vite build` still runs through this same alias, so a
    // build always reflects current source too — dist is only the contract
    // for external (non-Vite) consumers.
    alias: {
      "@soundfx/engine": pkgSrc("engine"),
      "@soundfx/biosignal": pkgSrc("biosignal"),
      "@soundfx/protocol": pkgSrc("protocol"),
    },
  },
  optimizeDeps: {
    exclude: ["@soundfx/engine", "@soundfx/biosignal", "@soundfx/protocol"],
  },
  server: {
    port: 5173,
    // rPPG needs a MediaStream; getUserMedia requires a secure context. Vite's
    // dev server is http://localhost, which browsers treat as secure for this
    // purpose, so no local TLS setup is needed for development.
    host: true,
  },
  build: {
    target: "es2021",
    // No sourcemap in production. There is no error-reporting backend to
    // symbolicate against — by design, since nothing leaves the device — so
    // shipping ~250 KB of map per deploy buys nothing and roughly quadruples
    // the JS payload. Dev builds are unaffected and remain fully mapped.
    sourcemap: false,
    // Warn earlier than Vite's 500 KB default: this app has no third-party
    // runtime dependencies, so any large jump is a regression worth seeing.
    chunkSizeWarningLimit: 300,
  },
  worker: {
    format: "es",
  },
});
