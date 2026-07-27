// ============================================================================
// sw.js — Service worker. Precaches the full app shell so the site loads
// instantly and works offline after the first visit.
//
// All precache paths are RELATIVE so the worker functions correctly under a
// GitHub Pages subpath (e.g. https://user.github.io/localfishbowl/). The SW's
// scope is its own directory, so relative URLs resolve against that.
//
// NOTE: caching the shell does NOT make multiplayer fully offline — PeerJS
// still needs to reach a signaling broker to set up the WebRTC handshake.
// See js/net.js for self-hosting a broker on the LAN.
// ============================================================================

// Bump this version to invalidate old caches on the next activate.
const CACHE = 'localfishbowl-v2';

// Core app shell (same-origin). Relative to the SW's scope.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/main.js',
  './js/net.js',
  './js/state.js',
  './js/rules.js',
  './js/ui.js',
  './js/util.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

// Cross-origin assets we want available offline (the PeerJS lib). The actual
// font files are cached lazily at runtime on first fetch.
const EXTERNAL = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Same-origin shell: fail the install if any of these are missing.
    await cache.addAll(SHELL);
    // External libs: best-effort (don't block install if a CDN hiccups).
    await Promise.allSettled(EXTERNAL.map((url) =>
      fetch(url, { mode: 'cors' }).then((r) => r.ok && cache.put(url, r.clone()))
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // SPA navigations: serve the cached shell so deep loads work offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (_) {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  const isFont =
    url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const isCDN = url.hostname === 'unpkg.com';

  // Cache-first for shell, fonts, and the pinned CDN lib.
  if (url.origin === self.location.origin || isFont || isCDN) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: false });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // Cache successful & opaque (font) responses for next time.
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (_) {
        return cached || Response.error();
      }
    })());
  }
  // Everything else (e.g. signaling/WebRTC) falls through to the network.
});
