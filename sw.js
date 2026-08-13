// INSPECTA Service Worker v1.3
// PT Bina Sarana Sukses — SHE Department
//
// PERBAIKAN v1.3: Tambah TIMEOUT pada strategi network-first untuk app shell (HTML).
// Masalah yang diperbaiki: v1.2 network-first TIDAK punya batas waktu — di lokasi
// sinyal lemah tambang (bukan offline total, tapi lambat/putus-nyambung), fetch()
// bisa menggantung lama menunggu respons server sebelum akhirnya gagal & fallback
// ke cache. Selama menunggu itu, inspector cuma lihat layar putih/loading — padahal
// versi cache sudah ADA dan siap dipakai instan.
//
// Sekarang: kalau jaringan tidak merespons dalam 4 detik, LANGSUNG pakai cache dulu
// (app tetap terasa instan), sambil tetap coba ambil versi terbaru di belakang layar
// untuk cache berikutnya. Kalau jaringan cepat (sinyal bagus), perilaku sama seperti
// v1.2 — selalu dapat versi terbaru begitu online.
//
// CATATAN UNTUK UPDATE SELANJUTNYA: naikkan angka versi di CACHE_NAME setiap kali
// sw.js sendiri diubah, supaya browser mendeteksi ada Service Worker baru dan proses
// install/activate (yang membersihkan cache lama) benar-benar berjalan.

const CACHE_NAME = 'inspecta-v1.3';
const NETWORK_TIMEOUT_MS = 4000; // batas tunggu jaringan sebelum fallback ke cache
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

// Bungkus fetch() dengan batas waktu — kalau tidak selesai dalam ms tertentu,
// dianggap gagal (reject) supaya caller bisa langsung fallback ke cache.
function fetchWithTimeout(request, ms) {
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      reject(new Error('Network timeout setelah ' + ms + 'ms'));
    }, ms);
    fetch(request).then(function(res) {
      clearTimeout(timer);
      resolve(res);
    }).catch(function(err) {
      clearTimeout(timer);
      reject(err);
    });
  });
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
// App shell (HTML)      → network-first DENGAN TIMEOUT, fallback ke cache kalau
//                          lambat/offline. Update cache tetap jalan di belakang
//                          layar walau responsnya dipakai di request berikutnya.
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

  // App shell HTML → NETWORK-FIRST DENGAN TIMEOUT 4 DETIK. Kalau jaringan lambat/
  // tidak merespons dalam waktu itu, langsung pakai cache (app tetap instan di
  // sinyal lemah). Fetch jaringan tetap dilanjutkan di belakang layar untuk update
  // cache berikutnya, tidak dibatalkan hanya karena sudah lewat timeout.
  if (e.request.mode === 'navigate' || isAppShell(url)) {
    e.respondWith(
      fetchWithTimeout(e.request, NETWORK_TIMEOUT_MS).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function() {
        // Timeout ATAU gagal jaringan → pakai cache segera.
        // Tetap coba fetch di belakang layar (tanpa ditunggu) supaya cache
        // ter-update untuk pemakaian berikutnya begitu sinyal membaik.
        fetch(e.request).then(function(response) {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, response); });
          }
        }).catch(function() {});
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
