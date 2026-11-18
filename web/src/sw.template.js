// Service worker TEMPLATE — vite.config.js (fallguardServiceWorker) fills in the
// precache list and version at build time and emits it as dist/sw.js.
// Goal: after ONE online visit, FallGuard works offline — detection must not depend
// on the network (the models run on the device anyway).
//   * install: precache every built file (JS/CSS bundle, ONNX Runtime .wasm, models,
//     demo replays, icons, manifest), so even the first visit makes it offline-ready
//   * /assets/* (content-hashed by Vite)  -> cache-first
//   * everything else same-origin (page, models, replays, config) -> network-first,
//     falling back to the cache when offline, so retrained models are picked up
//   * activate: delete caches from previous builds (the version is a content hash)
// Cross-origin requests (e.g. Firebase) are not touched.
const VERSION = '__VERSION__';
const CACHE = `fallguard-${VERSION}`;
const scope = new URL(self.registration.scope);
const PRECACHE = /*__PRECACHE__*/[].map((p) => new URL(p, scope).href);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return caches.match(new URL('index.html', scope).href);
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== scope.origin) return;
  e.respondWith(url.pathname.includes('/assets/') ? cacheFirst(e.request) : networkFirst(e.request));
});
