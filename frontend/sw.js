/* Glass Factory PWA service worker.
 * Strategy:
 * - HTML pages: NETWORK-FIRST (always try server, fall back to cache only when offline).
 *   Reason: a stale HTML can ship a known bug or wrong role-routing.
 * - JS/CSS/icons: stale-while-revalidate (small, version-stable).
 * - Uploaded artifacts (/uploads/*): network-only, never cached, because access is role-gated.
 * - API calls (/api/*): network-only, never cached.
 */
const VERSION = 'v46-2026-06-08-po-order-number';
const STATIC_CACHE = `glassorder-static-${VERSION}`;
const ASSET_CACHE = `glassorder-assets-${VERSION}`;
const PRECACHE_HTML = [
  './login.html',
  './index.html',
  './boss-dashboard.html',
  './boss-workspace.html',
  './boss-new-order.html',
  './boss-order-detail.html',
  './worker-queue.html',
  './worker-pieces.html',
  './customers.html',
  './pickup-search.html',
  './pickup-sign.html',
  './pickup-slip.html',
  './pickup-batches.html',
  './pickup-batch-detail.html',
  './summary.html',
  './summary-customer.html',
];
const PRECACHE_ASSET = [
  './shared.css',
  './js/api.js',
  './js/i18n.js',
  './manifest.json',
  './icons/loading.gif',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE_HTML)),
      caches.open(ASSET_CACHE).then((c) => c.addAll(PRECACHE_ASSET)),
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isApi(u) { return u.pathname.startsWith('/api/'); }
function isUploadArtifact(u) { return u.pathname.startsWith('/uploads/'); }
function isHtml(req, u) {
  if (req.mode === 'navigate') return true;
  if (req.destination === 'document') return true;
  return /\.html?$/i.test(u.pathname) || u.pathname === '/' || u.pathname.endsWith('/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  if (isApi(url) || isUploadArtifact(url)) return; // network-only

  if (isHtml(req, url)) {
    event.respondWith(networkFirst(req, STATIC_CACHE));
    return;
  }

  // Static asset: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(req, ASSET_CACHE));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response('Offline', { status: 503 });
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp && resp.ok) cache.put(req, resp.clone());
  return resp;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networked = fetch(req).then((resp) => {
    if (resp && resp.ok) cache.put(req, resp.clone());
    return resp;
  }).catch(() => null);
  return cached || (await networked) || new Response('Offline', { status: 503 });
}

// Manual cache nuke handle (open DevTools and run navigator.serviceWorker.controller.postMessage('CLEAR_CACHES')).
self.addEventListener('message', (event) => {
  if (event.data === 'CLEAR_CACHES') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});
