/**
 * SoundFX service worker.
 *
 * Written by hand rather than generated, because the caching policy here is
 * unusually simple and the generated equivalent would pull in a build
 * dependency to express it. This app has no API, no user accounts, and no
 * remote data of any kind — the entire product is static assets plus
 * localStorage. So "works offline" reduces to "have the shell cached".
 *
 * Policy:
 *   navigation  -> network-first, falling back to the cached shell.
 *                  Network-first so a deployed update is picked up on the
 *                  next online visit rather than being pinned to whatever
 *                  version happened to install first.
 *   same-origin -> cache-first. Vite content-hashes its asset filenames, so
 *                  a cached hit is by definition the correct bytes for that
 *                  URL and can never be stale.
 *   cross-origin-> not handled. Nothing in this app loads cross-origin, and
 *                  a pass-through handler would only add a failure mode.
 *
 * CACHE_VERSION must be bumped whenever the precache list changes. Old
 * caches are deleted on activate, so a stale shell cannot survive a deploy.
 */

const CACHE_VERSION = "soundfx-v1";

/**
 * The static shell. Content-hashed bundles are not listed here — they come
 * from the build-time manifest below, since their names change every build.
 * The worklet IS listed: audio is the product, and a session that starts
 * offline must not fail on a missing processor module.
 */
const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/worklets/clfs-processor.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
];

/**
 * Cache lookup options used everywhere in this worker.
 *
 * `ignoreVary` is essential, not an optimisation. Static hosts commonly send
 * `Vary: Origin` on assets (Vite's own preview server does). Browser-issued
 * module-script and stylesheet requests are CORS-mode and carry an `Origin`
 * header; the `cache.add()` requests this worker makes during install do
 * not. Honouring Vary therefore makes every precached bundle a cache MISS
 * for the exact requests it was cached to serve — the app looks fine online
 * and fails offline with the assets sitting right there in the cache.
 *
 * Ignoring Vary is safe here because every entry is a same-origin,
 * content-hashed static file. There is no legitimate dimension for the
 * response to vary along: the URL fully determines the bytes.
 */
const MATCH_OPTS = { ignoreVary: true };

/**
 * The content-hashed bundles, emitted at build time by the
 * soundfx-precache-manifest Vite plugin.
 *
 * These must be precached explicitly. On a first visit the browser fetches
 * the JS and CSS before this worker takes control, so the fetch handler
 * below never observes them and they would never enter the cache — leaving
 * an app that reports offline support while serving a shell with no bundle.
 */
async function hashedAssets() {
  try {
    const res = await fetch("/precache-manifest.json", { cache: "no-cache" });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.assets) ? data.assets : [];
  } catch {
    return [];
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const urls = [...PRECACHE, ...(await hashedAssets())];
      // addAll fails atomically if any single entry 404s, which would leave
      // the worker permanently uninstalled. Add individually and tolerate
      // misses so a renamed asset degrades to "not precached", not "broken".
      await Promise.all(urls.map((url) => cache.add(url).catch(() => undefined)));
      // Take over as soon as installed rather than waiting for every tab to
      // close; paired with clients.claim() below.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so deploys land, cache as the offline floor.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_VERSION);
          cache.put("/index.html", fresh.clone());
          return fresh;
        } catch {
          const cached =
            (await caches.match("/index.html", MATCH_OPTS)) ?? (await caches.match("/", MATCH_OPTS));
          if (cached) return cached;
          return new Response("Offline, and no cached copy of the app is available.", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          });
        }
      })(),
    );
    return;
  }

  // Everything else same-origin: cache-first, populate on miss.
  event.respondWith(
    (async () => {
      const cached = await caches.match(req, MATCH_OPTS);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        // Only cache successful, basic (same-origin) responses. Caching an
        // opaque or error response would poison the cache for that URL.
        if (fresh.ok && fresh.type === "basic") {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        throw err;
      }
    })(),
  );
});

/** Allow the page to trigger an immediate update after a new SW is found. */
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
