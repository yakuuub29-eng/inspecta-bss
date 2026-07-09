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
const TYPE_SHEET = {
  hazard: 'Hazard Report',
  nearmiss: 'Near Miss',
  positive: 'Positive Behavior',
  stopwork: 'Stop Work Authority',
  port: 'Inspeksi Port',
  pit: 'Inspeksi Front Loading',
  hauling: 'Inspeksi Jalan Hauling',
  workshop: 'Inspeksi Workshop',
  workshoptyre: 'Inspeksi Workshop Tyre',
  tpslb3: 'Inspeksi TPS LB3',
  p3k: 'Inspeksi Kotak P3K',
  eyewash: 'Inspeksi Eyewash',
  gabungan: 'Inspeksi Gabungan (Lama)',
  speedgun: 'Laporan Speedgun',
  fatigue: 'Laporan Fatigue Call',
  ttworkshop: 'TT - Workshop',
  ttpit: 'TT - Pit',
  tttpslb3: 'TT - TPS LB3',
  tthauling: 'TT - Jalan Hauling',
  ttcatering: 'TT - Catering',
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
