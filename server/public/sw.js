/**
 * Gantry Fleet Service Worker
 *
 * Strategy:
 * - Static assets (JS, CSS, fonts, images): cache-first with background refresh
 * - API calls (/api/*): network-first, no caching
 * - SSE streams (/api/*stream*, /mcp/*): never cached
 * - HTML pages: network-first, fall back to cached version
 * - Offline: return /offline.html for navigation requests
 */

const CACHE_NAME = 'gantry-v1';
const STATIC_CACHE_NAME = 'gantry-static-v1';

// Patterns that should never be cached
const NEVER_CACHE = [
  /\/api\//,
  /\/mcp\//,
  /\/health/,
  /\/sessions/,
  /text\/event-stream/,
];

// Static asset extensions to cache aggressively
const STATIC_EXTENSIONS = ['.js', '.css', '.woff', '.woff2', '.png', '.svg', '.ico'];

function isStaticAsset(url) {
  const pathname = new URL(url).pathname;
  return STATIC_EXTENSIONS.some(ext => pathname.endsWith(ext));
}

function shouldNeverCache(url) {
  return NEVER_CACHE.some(pattern => pattern.test(url));
}

// ---------------------------------------------------------------------------
// Install: pre-cache nothing (let assets cache on first access)
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Activate: clean up old caches
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch: routing logic
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = request.url;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Never cache API, SSE, or MCP endpoints
  if (shouldNeverCache(url)) return;

  // Static assets: cache-first
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE_NAME));
    return;
  }

  // Navigation (HTML pages): network-first with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }
});

// ---------------------------------------------------------------------------
// Cache strategies
// ---------------------------------------------------------------------------

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // Background refresh
    fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
    }).catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstWithOfflineFallback(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    // Return offline page for navigation requests
    const offlinePage = await cache.match('/offline.html');
    if (offlinePage) return offlinePage;

    // Minimal fallback if offline page not cached yet
    return new Response(
      '<html><body style="background:#1a1e26;color:#d8dee9;font-family:monospace;padding:2rem">' +
      '<h1>Gantry — Offline</h1><p>No network connection. The dashboard is unavailable.</p></body></html>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}
