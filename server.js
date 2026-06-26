// Patient Notes dashboard backend.
// - Refreshes the DrChrono OAuth access token (rotating refresh token persisted to Zapier Storage).
// - Serves today's schedule so the front-end shows a tappable patient list instead of typing names.
// - Writes the selected patient NAME and DrChrono ID into Zapier Storage for the Zap to read.

const express = require('express');
const path = require('path');
const PDFDocument = require('pdfkit');

const {
  DRCHRONO_CLIENT_ID,
  DRCHRONO_CLIENT_SECRET,
  DRCHRONO_REFRESH_TOKEN,
  DRCHRONO_DOCTOR_ID,
  ZAPIER_STORAGE_SECRET,
  DRCHRONO_TZ = 'America/New_York',
  PORT = 3000,
} = process.env;

const TOKEN_URL = 'https://drchrono.com/o/token/';
const API = 'https://drchrono.com/api';
const ZAP_STORE = 'https://store.zapier.com/api/records';

// ---------- Zapier Storage (also durable home for the rotating refresh token) ----------
async function zapGet() {
  const r = await fetch(ZAP_STORE, { headers: { 'X-Secret': ZAPIER_STORAGE_SECRET } });
  if (!r.ok) throw new Error('zapier storage GET ' + r.status);
  return r.json();
}

async function zapSet(obj) {
  const r = await fetch(ZAP_STORE, {
    method: 'POST',
    headers: { 'X-Secret': ZAPIER_STORAGE_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (!r.ok) throw new Error('zapier storage POST ' + r.status);
  return r.json().catch(() => ({}));
}

// ---------- DrChrono token management ----------
// DrChrono rotates the refresh token on every refresh, so we persist the newest one
// to Zapier Storage. Cold starts (Render free tier spins down) read the latest, never a
// stale seed. The env var is only the first-ever seed.
let accessToken = null;
let accessExpiry = 0;
let refreshing = null;

async function currentRefreshToken() {
  try {
    const store = await zapGet();
    if (store && store.drchrono_refresh_token) return store.drchrono_refresh_token;
  } catch (e) {
    console.error('could not read persisted refresh token, using seed:', e.message);
  }
  return DRCHRONO_REFRESH_TOKEN;
}

async function refreshAccessToken() {
  const rt = await currentRefreshToken();
  if (!rt) throw new Error('no refresh token available');
  if (!DRCHRONO_CLIENT_SECRET) throw new Error('DRCHRONO_CLIENT_SECRET not set');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: rt,
    client_id: DRCHRONO_CLIENT_ID,
    client_secret: DRCHRONO_CLIENT_SECRET,
  });

  const r = await fetch(TOKEN_URL, { method: 'POST', body });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('token refresh ' + r.status + ': ' + t.slice(0, 300));
  }
  const j = await r.json();
  accessToken = j.access_token;
  accessExpiry = Date.now() + ((j.expires_in || 3600) - 120) * 1000; // refresh 2 min early

  if (j.refresh_token && j.refresh_token !== rt) {
    try {
      await zapSet({ drchrono_refresh_token: j.refresh_token });
    } catch (e) {
      console.error('FAILED to persist rotated refresh token:', e.message);
    }
  }
  return accessToken;
}

async function getAccessToken() {
  if (accessToken && Date.now() < accessExpiry) return accessToken;
  if (!refreshing) refreshing = refreshAccessToken().finally(() => { refreshing = null; });
  return refreshing;
}

async function drGet(urlOrPath) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : API + urlOrPath;
  let token = await getAccessToken();
  let r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) {
    accessToken = null; // force one refresh and retry
    token = await getAccessToken();
    r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  }
  if (!r.ok) throw new Error('drchrono ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

function todayInTz(tz) {
  // en-CA formats as YYYY-MM-DD, which is the format DrChrono's ?date= expects.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function fetchTodaysPatients() {
  const date = todayInTz(DRCHRONO_TZ);
  const ids = new Set();
  let next = `${API}/appointments?date=${date}&doctor=${DRCHRONO_DOCTOR_ID}`;
  let guard = 0;
  while (next && guard++ < 25) {
    const page = await drGet(next);
    for (const appt of (page.results || [])) {
      if (appt.patient) ids.add(appt.patient); // skip blocks / breaks with no patient
    }
    next = page.next;
  }

  const patients = [];
  for (const id of ids) {
    try {
      const p = await drGet(`/patients/${id}`);
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
      patients.push({ id, name: name || ('Patient ' + id) });
    } catch (e) {
      patients.push({ id, name: 'Patient ' + id });
    }
  }
  patients.sort((a, b) => a.name.localeCompare(b.name));
  return { date, patients };
}

// ---------- HTTP ----------
const app = express();
app.use(express.json());

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/today', async (req, res) => {
  try {
    res.json(await fetchTodaysPatients());
  } catch (e) {
    console.error('GET /api/today:', e.message);
    res.status(502).json({ error: 'schedule_unavailable', detail: e.message });
  }
});

app.post('/api/select', async (req, res) => {
  const { id, name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name_required' });
  try {
    await zapSet({
      selected_patient_name: name,
      selected_patient_id: id ? String(id) : '',
      selected_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/select:', e.message);
    res.status(502).json({ error: 'storage_failed', detail: e.message });
  }
});

// Render the note text to a one-page PDF (DrChrono /documents wants a file, not raw text).
function notePdf(title, body) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(15).text(title || 'Clinical Note');
    doc.moveDown(0.6);
    doc.fontSize(11).text(String(body || ''), { align: 'left' });
    doc.end();
  });
}

// Upload a note straight onto the selected patient's chart in DrChrono.
// This replaces the brittle "upload" step in the Zap: it reads the selected
// patient from Storage and posts the note as a document using our own DrChrono auth.
// The Zap only has to POST the note text here: { "note": "...", "title": "..." }.
app.post('/api/note', async (req, res) => {
  const b = req.body || {};
  // Accept the note text under any common field name so the Zap mapping cannot miss.
  const note = b.note || b.transcript || b.text || b.body || b.message || b.content || b.summary;
  const title = b.title || b.subject || b.name;
  if (!note || !String(note).trim()) return res.status(400).json({ error: 'note_required', hint: 'send the note text as "note"' });
  try {
    const store = await zapGet();
    const pid = store && store.selected_patient_id;
    const pname = (store && store.selected_patient_name) || '';
    if (!pid) return res.status(409).json({ error: 'no_patient_selected' });

    const token = await getAccessToken();
    const pdf = await notePdf(title || `Note for ${pname}`, note);
    const form = new FormData();
    form.append('patient', String(pid));
    form.append('doctor', String(DRCHRONO_DOCTOR_ID));
    form.append('date', todayInTz(DRCHRONO_TZ));
    form.append('description', (title || 'Plaud note') + (pname ? ' - ' + pname : ''));
    form.append('document', new Blob([pdf], { type: 'application/pdf' }), 'note.pdf');

    let r = await fetch('https://app.drchrono.com/api/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
    if (r.status === 401) { accessToken = null; const t2 = await getAccessToken();
      r = await fetch('https://app.drchrono.com/api/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + t2 }, body: form }); }
    const text = await r.text();
    if (!r.ok) { console.error('note upload', r.status, text.slice(0, 200)); return res.status(502).json({ error: 'drchrono_upload_failed', status: r.status, detail: text.slice(0, 300) }); }
    res.json({ ok: true, patient_id: pid, patient_name: pname, document: JSON.parse(text || '{}') });
  } catch (e) {
    console.error('POST /api/note:', e.message);
    res.status(500).json({ error: 'note_failed', detail: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log('patient-dashboard listening on :' + PORT));
