/* ==========================================================================
   My Shop — sw.js
   Cache-first app shell so the POS keeps working with no connection.
   Bump CACHE_VERSION whenever any precached file changes — this forces
   old clients to fetch the new files instead of serving stale ones.
   ========================================================================== */
const CACHE_VERSION = 'myshop-v4'; // bumped: renamed all "Duket" branding/identifiers to "My Shop" across app.js/styles.css/index.html/sync.js — old clients need this bump or they'll keep serving the stale pre-rename files
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './dexie.min.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
    // NOTE: no self.skipWaiting() here anymore — a new worker now waits
    // until the page tells it to take over (see the 'message' listener
    // below), which app.js triggers only after the user taps the
    // "Update available" toast. Auto-activating instantly used to mean a
    // shop mid-checkout could have its app code swapped under it with no
    // warning.
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('myshop-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept POSTs etc.

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // App shell: cache-first, so it works with zero connection.
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
          return res;
        }).catch(() => {
          if (req.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 504, statusText: 'Offline' });
        });
      })
    );
    return;
  }

  // Cross-origin (e.g. the lazily-loaded Chart.js CDN script): try the
  // network first so it stays current, fall back to the runtime cache
  // once it has been fetched at least once while online.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
