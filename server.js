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

// Append a held (unmatched) note so it is never silently lost. Kept small.
async function storeHeldNote(item) {
  let store = {};
  try { store = await zapGet(); } catch (e) { /* start fresh if unreadable */ }
  const list = Array.isArray(store.held_notes) ? store.held_notes : [];
  list.unshift({
    title: item.title || '',
    candidate: item.candidate || '',
    scheduleError: item.scheduleError || null,
    at: item.at,
    preview: String(item.note || '').slice(0, 240),
  });
  await zapSet({ held_notes: list.slice(0, 50) });
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

async function fetchPatientsForDate(date) {
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

async function fetchTodaysPatients() { return fetchPatientsForDate(todayInTz(DRCHRONO_TZ)); }

// ---------- Patient name matching ----------
// Plaud names the patient in every note ("[patient]: Sandra" in the summary, and
// after the colon in the subject). Matching that to the day's schedule lets each
// note file to its own chart even when several are synced at once — instead of
// relying on whoever was tapped last, which mixed up batch syncs.
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Similarity of two names (0..1), used to tolerate Plaud's misspellings when
// matching against the small, distinct daily schedule (e.g. "Giselle Rayo" vs
// "Gisselle Raio"). Levenshtein-based ratio on normalized names.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function simRatio(a, b) {
  a = normName(a); b = normName(b);
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

// Pull the recording date out of the Plaud subject ("[Plaud-AutoFlow] 06-29 ...")
// so a note synced in the evening / next morning still matches the right day.
function parseNoteDate(title) {
  const m = String(title || '').match(/\b(\d{2})-(\d{2})\b/); // MM-DD
  if (!m) return null;
  const mm = +m[1], dd = +m[2];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const today = todayInTz(DRCHRONO_TZ); // YYYY-MM-DD
  const year = Number(today.slice(0, 4));
  let cand = `${year}-${m[1]}-${m[2]}`;
  if (cand > today) cand = `${year - 1}-${m[1]}-${m[2]}`; // future date => last year's note
  return cand;
}

function extractPatientName(note, title) {
  const text = String(note || '');
  // Primary: the structured "[patient]: Name" field Plaud emits in the summary.
  const m = text.match(/\[patient\][^\n:]*[:\-]+\s*([^\n\r]+)/i);
  if (m && m[1]) {
    const v = m[1].replace(/\[.*?\]/g, '').trim();
    if (v && !/^(not stated|unknown|n\/?a)$/i.test(v)) return v;
  }
  // Fallback: name after the last colon in the subject ("... Care: Sandra").
  const t = String(title || '');
  if (t.includes(':')) {
    const after = t.split(':').pop().trim();
    if (after && after.length <= 60) return after;
  }
  return '';
}

// Match the extracted name to one scheduled patient. Only returns a match when it
// is unambiguous; anything fuzzy returns null so the caller falls back safely.
function matchPatient(candidate, patients) {
  const c = normName(candidate);
  if (!c) return { match: null, reason: 'no_name_extracted' };
  const exact = patients.filter(p => normName(p.name) === c);
  if (exact.length === 1) return { match: exact[0], reason: 'exact' };
  const contains = patients.filter(p => { const n = normName(p.name); return n.includes(c) || c.includes(n); });
  if (contains.length === 1) return { match: contains[0], reason: 'contains' };
  const cFirst = c.split(' ')[0];
  const firstMatch = patients.filter(p => normName(p.name).split(' ')[0] === cFirst);
  if (firstMatch.length === 1) return { match: firstMatch[0], reason: 'first_name' };
  if (firstMatch.length > 1) return { match: null, reason: 'ambiguous_first_name', candidates: firstMatch.map(p => p.name) };
  // Fuzzy pass: tolerate misspellings, but only accept a clear, unique winner so a
  // garbled or absent name can never be forced onto the wrong chart.
  const scored = patients
    .map(p => ({ p, s: simRatio(c, p.name) }))
    .sort((x, y) => y.s - x.s);
  if (scored[0] && scored[0].s >= 0.82 && (!scored[1] || scored[0].s - scored[1].s >= 0.12)) {
    return { match: scored[0].p, reason: 'fuzzy_' + scored[0].s.toFixed(2) };
  }
  return { match: null, reason: 'no_match', candidates: scored.slice(0, 3).map(x => x.p.name + ':' + x.s.toFixed(2)) };
}

// Reverse match: which scheduled patients are clearly named anywhere in the note
// text. Format-independent (does not depend on Plaud's layout), and only reports a
// patient when the evidence is strong: full name, first+last both present, or a
// last name that is unique on that day's schedule. Used only when the forward
// extraction did not already produce a confident match.
function scanSchedule(text, patients) {
  const t = ' ' + normName(text) + ' ';
  if (!t.trim()) return [];
  const lastCounts = {};
  for (const p of patients) {
    const parts = normName(p.name).split(' ').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) lastCounts[last] = (lastCounts[last] || 0) + 1;
  }
  const has = (w) => w && w.length >= 2 && t.includes(' ' + w + ' ');
  const hits = [];
  for (const p of patients) {
    const parts = normName(p.name).split(' ').filter(Boolean);
    if (!parts.length) continue;
    const first = parts[0], last = parts[parts.length - 1];
    let how = '';
    if (parts.length >= 2 && t.includes(' ' + parts.join(' ') + ' ')) how = 'fullname';
    else if (first && last && first !== last && has(first) && has(last)) how = 'first+last';
    else if (last && last.length >= 4 && lastCounts[last] === 1 && has(last)) how = 'lastname';
    if (how) hits.push({ p, how });
  }
  return hits;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json());

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Held (unmatched) notes, so nothing is ever silently lost — surfaced for manual filing.
app.get('/api/held', async (req, res) => {
  try {
    const s = await zapGet();
    res.json({ held: Array.isArray(s.held_notes) ? s.held_notes : [] });
  } catch (e) {
    res.status(502).json({ error: 'storage_failed', detail: e.message });
  }
});

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
    // PRIMARY: read the patient's name out of the note/subject and match it to that
    // day's schedule, so every note routes to its own chart even when several are
    // synced at once. FALLBACK: the last tapped selection in Storage (old behavior),
    // so this can only improve on the previous result, never regress.
    let pid = '', pname = '', routed = null, scheduleError = null;
    try {
      const noteDate = parseNoteDate(title) || todayInTz(DRCHRONO_TZ);
      const { patients } = await fetchPatientsForDate(noteDate);
      const candidate = extractPatientName(note, title);
      // 1) FORWARD: the name Plaud stated, matched to the schedule.
      const fwd = matchPatient(candidate, patients);
      if (fwd.match) {
        pid = String(fwd.match.id); pname = fwd.match.name; routed = 'name:' + fwd.reason;
      } else {
        // 2) REVERSE: which scheduled patient is actually named in the note text.
        // Rescues the common case where Plaud's layout hides the name from the
        // forward parser. Files only when exactly ONE scheduled patient is named,
        // so it can never be forced onto the wrong chart.
        const hits = scanSchedule(note + ' ' + (title || ''), patients);
        const uniq = [...new Map(hits.map(h => [String(h.p.id), h])).values()];
        if (uniq.length === 1) {
          pid = String(uniq[0].p.id); pname = uniq[0].p.name; routed = 'scan:' + uniq[0].how;
        } else {
          console.warn('no confident match:', JSON.stringify({
            candidate, date: noteDate, scheduleCount: patients.length,
            fwdReason: fwd.reason, reverseHits: uniq.map(h => h.p.name),
          }));
        }
      }
    } catch (e) {
      scheduleError = e.message;
      console.error('schedule/match failed:', e.message);
    }
    // SAFETY: never file onto the wrong chart. If we cannot confidently identify the
    // patient (or the schedule lookup itself failed), HOLD the note — but persist it
    // so it is never silently lost and can be surfaced for manual filing.
    if (!pid) {
      const candidate = extractPatientName(note, title);
      try { await storeHeldNote({ title, note, candidate, scheduleError, at: new Date().toISOString() }); }
      catch (e) { console.error('storeHeldNote failed:', e.message); }
      console.warn('note HELD (not filed):', JSON.stringify({ title, candidate, scheduleError }));
      return res.status(200).json({
        filed: false, held: true, candidate, scheduleError,
        hint: scheduleError
          ? 'Schedule lookup failed, so the note was held (not filed to any chart).'
          : 'No confident patient match, so the note was held for manual filing (never misfiled).',
      });
    }

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
    res.json({ ok: true, routed, patient_id: pid, patient_name: pname, document: JSON.parse(text || '{}') });
  } catch (e) {
    console.error('POST /api/note:', e.message);
    res.status(500).json({ error: 'note_failed', detail: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log('patient-dashboard listening on :' + PORT));
