import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

function pkgSrc(pkg: string): string {
  return fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));
}

export default defineConfig({
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
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
});
