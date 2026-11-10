/* Offline shell: app files are served network-first, bypassing the browser cache (so updates show up right away)
   with the cached copy as a fallback; the Firebase SDK and fonts are cache-first.
   Data itself is handled by Firestore's own offline cache, not here. */
const CACHE = 'wedding-v2';
const SHELL = ['./', './index.html', './platform.js', './firebase-config.js', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const staticCdn = /(^|\.)gstatic\.com$/.test(url.hostname) || url.hostname === 'fonts.googleapis.com' || url.hostname === 'cdnjs.cloudflare.com';
  if (sameOrigin) {
    e.respondWith(fetch(req, { cache: 'no-store' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
  } else if (staticCdn) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
