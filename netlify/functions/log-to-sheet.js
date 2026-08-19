// netlify/functions/log-to-sheet.js
//
// Menerima 1 laporan INSPECTA (dikirim dari app-user.html tiap ada laporan baru masuk
// Firebase) lalu menambahkannya sebagai baris baru di Google Sheets — 1 tab per jenis form.
// Tab otomatis dibuat kalau belum ada, lengkap dengan header di baris pertama.
//
// ENV VARS yang dibutuhkan di Netlify (Site settings → Environment variables):
//   GOOGLE_SA_EMAIL        -> email Service Account (xxx@xxx.iam.gserviceaccount.com)
//   GOOGLE_SA_PRIVATE_KEY  -> private key dari file JSON Service Account (yang ada \n di dalamnya)
//   GOOGLE_SHEET_ID        -> ID spreadsheet (dari URL: docs.google.com/spreadsheets/d/{ID}/edit)
//
// Spreadsheet-nya WAJIB di-share (Editor) ke email Service Account di atas.

import crypto from 'node:crypto';

// Nama tab per jenis laporan — urutan & label bebas diubah sesuai kebutuhan.
// PENTING: key di sini HARUS sama persis dengan value `type` yang dikirim app-user.html
// (lihat TYPE_CODE di app-user.html). Sejak migrasi "Master Area V1.0", semua tipe area
// checklist pakai prefix "ma_" (ma_workshop, ma_tpslb3, dst) — sebelumnya di sini masih
// pakai nama lama (workshop, port, pit, dst) yang sudah tidak pernah dikirim lagi oleh
// app, jadi SEMUA laporan checklist nyasar ke tab "Lainnya - ma_xxx" alih-alih ke tab
// yang seharusnya (mis. "Inspeksi Workshop"). Ini penyebab tab-tab utama terlihat kosong.
const TYPE_SHEET = {
  hazard: 'Hazard Report',
  nearmiss: 'Near Miss',
  positive: 'Positive Behavior',
  stopwork: 'Stop Work Authority',
  speedgun: 'Laporan Speedgun',
  fatigue: 'Laporan Fatigue Call',
  // 16 Area Master Area V1.0
  ma_workshop: 'Inspeksi Workshop',
  ma_tpslb3: 'Inspeksi TPS LB3',
  ma_hauling: 'Inspeksi Hauling Road',
  ma_fuel: 'Inspeksi Fuel Station',
  ma_tyre: 'Inspeksi Tyre Bay',
  ma_dumping: 'Inspeksi Dumping Point',
  ma_port: 'Inspeksi Port / Jetty',
  ma_loading: 'Inspeksi Loading Area',
  ma_warehouse: 'Inspeksi Warehouse',
  ma_genset: 'Inspeksi Genset Room',
  ma_compressor: 'Inspeksi Compressor',
  ma_office: 'Inspeksi Office',
  ma_parking: 'Inspeksi Parking Area',
  ma_firstaid: 'Inspeksi First Aid Room',
  ma_catering: 'Inspeksi Katering',
  ma_p3k: 'Inspeksi Kotak P3K',
};

const HEADER_ROW = [
  'Waktu Kirim', 'No. Laporan', 'Tipe', 'Pelapor', 'Departemen', 'Shift',
  'Area/Lokasi', 'Status', 'Severity', 'Jumlah NC',
];

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getAccessToken() {
  const email = Netlify.env.get('GOOGLE_SA_EMAIL');
  const rawKey = Netlify.env.get('GOOGLE_SA_PRIVATE_KEY') || '';
  const privateKey = rawKey.replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY belum diset di Netlify env vars');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claim));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer
    .sign(privateKey)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const jwt = unsigned + '.' + signature;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=' +
      encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' +
      jwt,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Gagal ambil access token Google: ' + JSON.stringify(json));
  return json.access_token;
}

async function ensureTab(sheetId, tabName, token) {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const meta = await metaRes.json();
  if (meta.error) throw new Error('Gagal baca spreadsheet: ' + JSON.stringify(meta.error));
  const exists = (meta.sheets || []).some((s) => s.properties.title === tabName);
  if (exists) return;

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
  });

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
      tabName
    )}!A1:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [HEADER_ROW] }),
    }
  );
}

async function appendRow(sheetId, tabName, row, token) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
      tabName
    )}!A1:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    }
  );
  const json = await res.json();
  if (json.error) throw new Error('Gagal menambah baris: ' + JSON.stringify(json.error));
}

export default async (req) => {
  const url = new URL(req.url);

  // ── MODE TES ── Buka link ini langsung di browser (GET, bukan dari aplikasi) untuk
  // mengecek koneksi ke Google Sheets tanpa perlu submit laporan sungguhan:
  //   https://<site-anda>.netlify.app/api/log-to-sheet?test=1
  // Hasilnya (sukses / pesan error persis) langsung tampil di layar sebagai teks.
  if (req.method === 'GET' && url.searchParams.get('test') === '1') {
    try {
      const sheetId = Netlify.env.get('GOOGLE_SHEET_ID');
      if (!sheetId) {
        return new Response('❌ GAGAL: env var GOOGLE_SHEET_ID belum diset di Netlify.', { status: 200 });
      }
      const email = Netlify.env.get('GOOGLE_SA_EMAIL');
      if (!email) {
        return new Response('❌ GAGAL: env var GOOGLE_SA_EMAIL belum diset di Netlify.', { status: 200 });
      }
      const privateKey = Netlify.env.get('GOOGLE_SA_PRIVATE_KEY');
      if (!privateKey) {
        return new Response('❌ GAGAL: env var GOOGLE_SA_PRIVATE_KEY belum diset di Netlify.', { status: 200 });
      }

      // FIX diagnosa "1E08010C:DECODER routines::unsupported": error ini SELALU berarti
      // format PEM private key rusak/tidak lengkap saat disalin (paling sering karena
      // Notepad tanpa Word Wrap bikin baris super panjang gampang ke-potong saat select).
      // Cek di sini SEBELUM dipakai, supaya pesannya persis apa yang salah, bukan cuma
      // error mentah dari Node.js yang membingungkan.
      const normalizedKey = privateKey.replace(/\\n/g, '\n');
      const keyChecks = [];
      if (!normalizedKey.includes('-----BEGIN PRIVATE KEY-----')) keyChecks.push('Tidak ditemukan baris "-----BEGIN PRIVATE KEY-----" — bagian awal key kemungkinan terpotong/tidak ikut ter-copy.');
      if (!normalizedKey.includes('-----END PRIVATE KEY-----')) keyChecks.push('Tidak ditemukan baris "-----END PRIVATE KEY-----" — bagian akhir key kemungkinan terpotong/tidak ikut ter-copy.');
      const beginCount = (normalizedKey.match(/-----BEGIN PRIVATE KEY-----/g) || []).length;
      if (beginCount > 1) keyChecks.push('Key ter-paste LEBIH DARI SEKALI (dobel) — value-nya kelihatannya ke-copy 2x saat paste ke Netlify.');
      if (normalizedKey.trim().length < 1000) keyChecks.push('Panjang key cuma ' + normalizedKey.trim().length + ' karakter — key asli biasanya 1600+ karakter, ini kependekan, kemungkinan besar terpotong saat di-copy dari Notepad.');
      if (keyChecks.length) {
        return new Response(
          '❌ GAGAL: GOOGLE_SA_PRIVATE_KEY rusak/tidak lengkap.\n\nMasalah yang ditemukan:\n- ' +
          keyChecks.join('\n- ') +
          '\n\nSolusi: buka lagi file JSON Service Account di Notepad, aktifkan "Format > Word Wrap" ' +
          'supaya baris private_key ikut melipat (tidak 1 baris panjang ke samping), lalu select ulang ' +
          'dari karakter tepat setelah tanda kutip pembuka sampai tepat sebelum tanda kutip penutup ' +
          '(seluruh isi -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----\\n), copy, lalu ' +
          'ganti (edit) value env var GOOGLE_SA_PRIVATE_KEY di Netlify dengan hasil copy yang baru ini. ' +
          'Redeploy lagi setelah diganti.',
          { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
        );
      }

      const token = await getAccessToken();
      const tabName = 'TES KONEKSI';
      await ensureTab(sheetId, tabName, token);
      await appendRow(sheetId, tabName, [
        new Date().toISOString(), 'TEST-' + Date.now(), 'Tes Koneksi', 'System Test', '-', '-', '-', 'OK', '-', '-',
      ], token);

      return new Response(
        '✅ BERHASIL! Cek Google Sheet Anda, harus ada tab baru bernama "TES KONEKSI" dengan 1 baris data.\n\n' +
        'Kalau ini muncul tapi laporan asli dari aplikasi tetap tidak masuk, berarti masalahnya ada di sisi ' +
        'aplikasi (app-user.html) — kemungkinan besar HP masih pakai versi cache lama.',
        { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    } catch (e) {
      return new Response(
        '❌ GAGAL: ' + String((e && e.message) || e) +
        '\n\nPenyebab paling umum:\n' +
        '1. Spreadsheet belum di-share (Editor) ke email service account\n' +
        '2. Google Sheets API belum di-Enable di Google Cloud Console\n' +
        '3. GOOGLE_SA_PRIVATE_KEY tidak lengkap / rusak saat disalin',
        { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405 });
  }
  try {
    const data = await req.json();
    const sheetId = Netlify.env.get('GOOGLE_SHEET_ID');
    if (!sheetId) {
      return new Response(JSON.stringify({ ok: false, error: 'GOOGLE_SHEET_ID belum diset' }), { status: 500 });
    }

    const tabName = TYPE_SHEET[data.type] || 'Lainnya - ' + (data.type || 'unknown');
    const token = await getAccessToken();
    await ensureTab(sheetId, tabName, token);

    const row = [
      data.timestamp || new Date().toISOString(),
      data.noTemuan || '',
      data.typeName || data.type || '',
      data.reporter || '',
      data.dept || '',
      data.shift || '',
      data.location || '',
      data.status || '',
      data.severity || '',
      data.ncCount != null ? data.ncCount : '',
    ];
    await appendRow(sheetId, tabName, row, token);

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    console.error('[log-to-sheet]', e);
    return new Response(JSON.stringify({ ok: false, error: String((e && e.message) || e) }), { status: 500 });
  }
};

export const config = { path: '/api/log-to-sheet' };

