/* Ward Board — sw.js — v1.1
   Service Worker: offline cache + background sync
*/

const CACHE_NAME = 'ward-board-v2.0';
const STATIC_ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  // Firebase SDK (cached from CDN)
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js',
];

/* ── Install: cache all static assets ───────────────────────── */
self.addEventListener('install', function(event) {
  console.log('[SW] Installing Ward Board v1.1');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS).catch(function(err) {
        // Don't fail install if CDN assets can't be cached
        console.warn('[SW] Some assets failed to cache:', err);
      });
    })
  );
  self.skipWaiting();
});

/* ── Activate: clean old caches ─────────────────────────────── */
self.addEventListener('activate', function(event) {
  console.log('[SW] Activating Ward Board v1.1');
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
      );
    })
  );
  self.clients.claim();
});

/* ── Fetch: network-first for Firebase, cache-first for assets ─ */
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Always go to network for Firebase services — never cache these
  if (url.includes('firebasedatabase.app') ||
      url.includes('firebaseio.com') ||
      url.includes('googleapis.com/identitytoolkit') ||
      url.includes('securetoken.googleapis.com') ||
      url.includes('firebaseauth.googleapis.com') ||
      url.includes('fcmregistrations.googleapis.com') ||
      url.includes('firebase.googleapis.com') ||
      url.includes('gstatic.com/firebasejs')) {
    return; // let it fall through to network
  }

  // Network-first for HTML (always get latest app)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(function(response) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
          return response;
        })
        .catch(function() {
          return caches.match('./index.html');
        })
    );
    return;
  }

  // Cache-first for static assets (CSS, JS, images)
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(response) {
        // Cache valid responses
        if (response && response.status === 200 && response.type !== 'opaque') {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    })
  );
});

/* ── Push notifications (FCM ready) ─────────────────────────── */
self.addEventListener('push', function(event) {
  if (!event.data) return;
  var data = {};
  try { data = event.data.json(); } catch(e) { data = { title: 'Ward Board', body: event.data.text() }; }

  var options = {
    body:    data.body    || 'Ward update',
    icon:    data.icon    || './icons/icon-192.png',
    badge:   data.badge   || './icons/icon-192.png',
    tag:     data.tag     || 'ward-board',
    data:    data.data    || {},
    vibrate: [100, 50, 100],
    actions: data.actions || [],
    requireInteraction: data.urgent || false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Ward Board', options)
  );
});

/* ── Notification click: open/focus the app ─────────────────── */
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if (client.url.includes('ward-board') && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow('./');
        }
      })
  );
});

/* ── Background sync (future: queue failed saves) ───────────── */
self.addEventListener('sync', function(event) {
  if (event.tag === 'ward-board-sync') {
    console.log('[SW] Background sync triggered');
    // Future: retry failed Firebase writes from IndexedDB queue
  }
});
