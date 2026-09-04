// INSPECTA Service Worker v1.5
// PT Bina Sarana Sukses — HSE Department
//
// PERBAIKAN v1.5: Naikkan versi cache lagi — app-user.html & dashboard-admin.html
// berubah signifikan sejak v1.4: fitur tanda tangan digital persetujuan atasan
// (Inspeksi/Fatigue Call/PICA), redesain tabel temuan NC + kolom foto sejajar,
// dan penggantian penyebutan SHE→HSE Department di seluruh UI/PDF. Tanpa
// menaikkan versi ini, HP yang sudah pernah buka app akan terus memakai app
// shell LAMA dari cache (masih nampilin "SHE" & belum ada fitur TTD atasan)
// sampai entah kapan, karena strategi network-first di bawah baru mengganti isi
// cache SETELAH fetch jaringan berhasil.
//
// PERBAIKAN v1.4 (referensi): Naikkan versi cache (app-user.html sudah banyak berubah sejak
// v1.3 — fix severity checklist, 482 regDetail checklist, dll — tanpa menaikkan
// versi ini, HP yang sudah pernah buka app akan terus memakai file HTML LAMA dari
// cache tanpa pernah tahu ada versi baru, karena strategi network-first di bawah
// baru mengganti cache SETELAH fetch jaringan berhasil — kalau baris ini tidak
// diubah, browser menganggap tidak ada Service Worker baru sama sekali (isi file
// dianggap identik) sehingga event install/activate tidak pernah terpicu ulang.
//
// PERBAIKAN v1.3 (referensi): Tambah TIMEOUT pada strategi network-first untuk app
// shell (HTML). Masalah yang diperbaiki: v1.2 network-first TIDAK punya batas waktu
// — di lokasi sinyal lemah tambang (bukan offline total, tapi lambat/putus-nyambung),
// fetch() bisa menggantung lama menunggu respons server sebelum akhirnya gagal &
// fallback ke cache. Selama menunggu itu, inspector cuma lihat layar putih/loading —
// padahal versi cache sudah ADA dan siap dipakai instan.
//
// CATATAN PENTING (baca sebelum lapor "loading masih lama"): perbaikan timeout di
// sini HANYA membantu kunjungan KE-2 dan seterusnya (setelah Service Worker berhasil
// terpasang & app shell tersimpan di cache). Kunjungan PERTAMA KALI di HP tertentu
// (belum ada Service Worker & belum ada cache sama sekali) TIDAK bisa dipercepat dari
// sisi kode ini — itu murni waktu download file HTML utuh oleh browser, dibatasi oleh
// kecepatan sinyal saat itu. Untuk kunjungan pertama, satu-satunya solusi nyata adalah
// memperkecil ukuran file app-user.html itu sendiri (mis. memecah data checklist besar
// ke file terpisah yang di-lazy-load) — ini perubahan arsitektur lebih besar, di luar
// cakupan perbaikan Service Worker ini.
//
// CATATAN UNTUK UPDATE SELANJUTNYA: naikkan angka versi di CACHE_NAME setiap kali
// app-user.html/dashboard-admin.html/sw.js sendiri diubah, supaya browser mendeteksi
// ada Service Worker baru dan proses install/activate (yang membersihkan cache lama
// & mengambil versi terbaru) benar-benar berjalan.

const CACHE_NAME = 'inspecta-v1.5';
const NETWORK_TIMEOUT_MS = 3000; // dipersingkat dari 4000ms — fallback ke cache lebih cepat terasa instan di sinyal lemah, tanpa terlalu agresif memotong request yang sebenarnya hampir selesai
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
