const CACHE_NAME = 'hopetracker-v5';  // bumped — forces all old SW caches to clear
const OFFLINE_URL = '/offline.html';

const PRECACHE_URLS = [
  '/index.html',
  '/dashboard.html',
  '/register.html',
  '/styles.css',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  OFFLINE_URL
  // NOTE: app.js is intentionally NOT pre-cached — it is always network-first
  // and pre-caching a versioned URL caused stale JS on mobile browsers
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keyList) =>
      Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) return caches.delete(key);
      }))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  const isHTML = e.request.headers.get('accept')?.includes('text/html');
  const isScript = url.pathname.endsWith('.js');
  const isCSS = url.pathname.endsWith('.css');

  // Network-first for HTML, JS, CSS — always gets fresh updates
  if (isHTML || isScript || isCSS) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          // Cache the fresh response for offline fallback
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
          return res;
        })
        .catch(() => {
          return caches.match(e.request).then((cached) =>
            cached || (isHTML ? caches.match(OFFLINE_URL) : new Response('', { status: 503 }))
          );
        })
    );
    return;
  }

  // Cache-first for everything else (icons, images, fonts)
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).catch(() => {
        if (isHTML) return caches.match(OFFLINE_URL);
      });
    })
  );
});

self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'HopeTracker';
  const options = {
    body: data.message || 'New directive received.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/dashboard.html' },
    vibrate: [200, 80, 200],
    requireInteraction: false,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/dashboard.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus an already-open tab if possible
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
