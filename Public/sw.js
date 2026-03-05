const CACHE = 'wedgelab-v1';

const STATIC_ASSETS = [
  '/index.html',
  '/challenge-setup.html',
  '/shot-entry.html',
  '/results-round.html',
  '/results-history.html',
  '/distance-home.html',
  '/distance-active.html',
  '/distance-post-test.html',
  '/distance-progress.html',
  '/distance-settings.html',
  '/manifest.json',
  '/wedgelab-engine.js',
  '/wedgelab-config.js',
  '/wedgelab-dropbox.js',
];

// Install — cache all static assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate — remove old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
// - API calls: network first, fall back to cache
// - Everything else: cache first, fall back to network
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go network-first for API calls
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      });
    })
  );
});
