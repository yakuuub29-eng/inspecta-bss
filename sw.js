// INSPECTA Service Worker v1.2
// PT Bina Sarana Sukses — SHE Department
// v1.2: bump cache version untuk paksa hapus Cache Storage lama
// (memperbaiki isu: app-user selalu terbuka sebagai dashboard-admin
// akibat cache lama yang tidak terhapus oleh "clear cache" browser biasa)

const CACHE_NAME = 'inspecta-v1.2';
const STATIC_FILES = [
  './app-user.html',
  './dashboard-admin.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './offline.html',
  './404.html'
];

// ── INSTALL ──
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.allSettled(
        STATIC_FILES.map(function(file) {
          return cache.add(file).catch(function(err) {
            console.warn('[INSPECTA SW] Failed to cache:', file, err);
          });
        })
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
          .map(function(key) { return caches.delete(key); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── FETCH: Cache-first untuk HTML/assets, Network-first untuk Firebase ──
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Firebase, CDN, external API → network only
  if (url.includes('firebase') || url.includes('googleapis') ||
      url.includes('gstatic') || url.includes('cdnjs') ||
      url.includes('fonts.')) {
    e.respondWith(
      fetch(e.request).catch(function() {
        return new Response('{"offline":true}', { headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }

  // App files → Cache-first, background update
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      var networkFetch = fetch(e.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function() { return null; });

      return cached || networkFetch.then(function(r) {
        return r || (e.request.destination === 'document' ? caches.match('./offline.html') : null);
      });
    })
  );
});
