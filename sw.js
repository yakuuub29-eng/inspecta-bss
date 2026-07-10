// INSPECTA Service Worker v1.2
// PT Bina Sarana Sukses — SHE Department
//
// PERBAIKAN v1.2: Strategi fetch untuk file HTML (app-user.html, dashboard-admin.html)
// diubah dari "cache-first" menjadi "network-first". Sebelumnya, begitu file sempat
// ke-cache sekali, PWA akan TERUS menampilkan versi lama itu selama-lamanya walau
// server sudah di-update — karena SW hanya mengambil versi baru di belakang layar
// untuk cache berikutnya, bukan untuk ditampilkan saat itu juga. Sekarang: kalau HP
// online, selalu ambil versi TERBARU dari server dulu; kalau gagal/offline, baru
// pakai cache sebagai fallback (jadi tetap bisa dipakai offline di lapangan seperti
// biasa, tapi update selalu langsung kepakai begitu ada sinyal).
//
// CATATAN UNTUK UPDATE SELANJUTNYA: naikkan angka versi di CACHE_NAME setiap kali
// sw.js sendiri diubah, supaya browser mendeteksi ada Service Worker baru dan proses
// install/activate (yang membersihkan cache lama) benar-benar berjalan.

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

// File yang WAJIB selalu dicek ke jaringan dulu (app shell utama).
// Ekstensi statis (icon, manifest) tetap boleh cache-first karena jarang berubah.
function isAppShell(url) {
  return url.endsWith('/app-user.html') || url.endsWith('/dashboard-admin.html') ||
         url.endsWith('/') || url.endsWith('/index.html');
}

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

// ── FETCH ──
// Firebase/CDN/API      → network only (data real-time, tidak boleh cache)
// App shell (HTML)      → network-first, fallback ke cache kalau offline
// Static assets lainnya → cache-first, update cache di belakang layar
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

  // App shell HTML → NETWORK-FIRST supaya update selalu langsung kepakai saat online
  if (e.request.mode === 'navigate' || isAppShell(url)) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function() {
        return caches.match(e.request).then(function(cached) {
          return cached || caches.match('./offline.html');
        });
      })
    );
    return;
  }

  // Static assets lain (icon, manifest, dll) → cache-first, update di belakang layar
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
