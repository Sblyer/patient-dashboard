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
    note: String(item.note || '').slice(0, 8000),
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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// DrChrono rate-limits the whole ACCOUNT (500/hr, plus a harder ~290/10min system
// throttle). Once we trip it, every further call fails AND keeps the throttle hot —
// so we remember when it said we could come back and stop calling until then. Callers
// serve their last-good copy instead, which is what keeps the dashboard usable.
let throttledUntil = 0;
const isThrottled = () => Date.now() < throttledUntil;
const retryAfterSecs = () => (isThrottled() ? Math.ceil((throttledUntil - Date.now()) / 1000) : 0);

function noteThrottle(body) {
  // "Request was throttled. Expected available in 412 seconds."
  const m = String(body || '').match(/available in (\d+)/i);
  const secs = Math.min(m ? +m[1] : 60, 900);
  throttledUntil = Date.now() + secs * 1000;
  console.error('DrChrono throttled; backing off ' + secs + 's');
}

async function drGet(urlOrPath) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : API + urlOrPath;
  if (isThrottled()) throw new Error('drchrono 429 throttled (backing off)');
  let lastStatus = 0, lastBody = '';
  // Retry transient failures. A freshly minted DrChrono token can briefly 401 on
  // patient endpoints before it propagates (seen on cold starts / after a refresh),
  // and the free host cold-starts too — so back off and retry instead of failing the
  // whole schedule/search on the first blip.
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await getAccessToken();
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) return r.json();
    lastStatus = r.status;
    lastBody = (await r.text()).slice(0, 200);
    if (r.status === 401) accessToken = null; // force a fresh token next attempt
    if (r.status === 429) { noteThrottle(lastBody); break; } // piling on keeps it tripped
    if (r.status === 401 || r.status >= 500) {
      await sleep(500 * (attempt + 1)); // 0.5s, 1s, 1.5s: let the token/API settle
      continue;
    }
    break; // 4xx other than 401/429 is not transient
  }
  throw new Error('drchrono ' + lastStatus + ' ' + lastBody);
}

function todayInTz(tz) {
  // en-CA formats as YYYY-MM-DD, which is the format DrChrono's ?date= expects.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// A chart id's name does not change, so look it up once per process and never again.
// This is what used to make a schedule cost ~21 DrChrono calls every single load.
const patientNames = new Map(); // id -> name

async function namesFor(ids) {
  const missing = [...ids].filter(id => !patientNames.has(id));
  // Small concurrency: fast on a cold start, still gentle on the rate limit.
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(missing.slice(i, i + 5).map(async (id) => {
      try {
        const p = await drGet(`/patients/${id}`);
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
        if (name) patientNames.set(id, name);
      } catch (e) { /* fall back to the id below; do not poison the cache */ }
    }));
  }
  return [...ids].map(id => ({ id, name: patientNames.get(id) || ('Patient ' + id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function crawlScheduleForDate(date) {
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
  return { date, patients: await namesFor(ids) };
}

// Every page load asks for today's schedule AND one schedule per held note — and the
// held notes are usually all the SAME day. Without this, four held notes meant four
// identical crawls at once, which is what kept tripping the account-wide rate limit and
// blanking the whole dashboard. Cache per date, share in-flight work, and when DrChrono
// is unavailable serve the last good copy rather than an empty list.
const TTL_TODAY = 10 * 60 * 1000; // keep-warm pings /api/today every 5 min, so this is always hot
const TTL_PAST = 12 * 60 * 60 * 1000; // a past day's schedule is settled
const scheduleCache = new Map();   // date -> { at, data }
const scheduleInflight = new Map(); // date -> Promise

async function fetchPatientsForDate(date, { refresh = false } = {}) {
  const ttl = date < todayInTz(DRCHRONO_TZ) ? TTL_PAST : TTL_TODAY;
  const hit = scheduleCache.get(date);
  if (hit && !refresh && Date.now() - hit.at < ttl) return hit.data;
  if (hit && isThrottled()) return { ...hit.data, stale: true };
  if (scheduleInflight.has(date)) return scheduleInflight.get(date);

  const p = (async () => {
    try {
      const data = await crawlScheduleForDate(date);
      // Don't let a transient empty result replace a good list we already have.
      if (data.patients.length || !hit) scheduleCache.set(date, { at: Date.now(), data });
      return data.patients.length || !hit ? data : { ...hit.data, stale: true };
    } catch (e) {
      if (hit) { console.error('schedule ' + date + ' failed, serving last good:', e.message); return { ...hit.data, stale: true }; }
      throw e;
    } finally {
      scheduleInflight.delete(date);
    }
  })();
  scheduleInflight.set(date, p);
  return p;
}

async function fetchTodaysPatients(opts) { return fetchPatientsForDate(todayInTz(DRCHRONO_TZ), opts); }

// ---------- Patient search (asked of DrChrono, not filtered from a local copy) ----------
// We used to crawl the entire roster into memory and substring-filter it here. That
// silently hid patients: the practice has 14,000+ charts, DrChrono caps
// /patients_summary at 50 per page and ignores page_size, and the crawl was bounded at
// 200 pages — so it only ever saw the first 10,000. Because the roster comes back
// oldest-id-first, the 4,000+ it dropped were the NEWEST patients. That is exactly why
// searching "Blanco" returned 3 of 7 charts and "Andrea Blanco" (patient #14,063)
// returned nothing at all.
//
// DrChrono filters first_name/last_name itself, case-insensitively, on a PREFIX match
// ("Blan" matches Blanco and Blank; "lanco" matches nothing), across every chart. So we
// ask DrChrono the question instead of keeping a copy we cannot keep complete. It is
// also far cheaper — 1-2 calls per search instead of ~280 per crawl, which is what kept
// tripping DrChrono's rate limit (500/hr) and taking search down entirely.
const SEARCH_MAX = 50;
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const searchCache = new Map(); // lowercased query -> { at, patients }

// show_inactive is what makes this complete: inactive and deceased charts are excluded
// by default, and Scott still needs to file a note onto one.
async function drSearch(params) {
  const qs = new URLSearchParams({ ...params, show_inactive: 'true', page_size: '250' });
  const out = [];
  let next = `${API}/patients?${qs}`;
  let pages = 0;
  while (next && pages++ < 2) { // 500 matches is already far more than anyone picks from
    const page = await drGet(next);
    for (const p of (page.results || [])) {
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
      if (name) out.push({ id: p.id, name, status: p.patient_status || 'A' });
    }
    next = page.next;
  }
  return out;
}

// Closest matches first: exact full name, then exact surname, then exact first name.
function rankMatches(list, q) {
  const nq = normName(q);
  const score = (p) => {
    const n = normName(p.name);
    if (n === nq) return 0;
    const words = n.split(' ');
    if (words[words.length - 1] === nq) return 1;
    if (words[0] === nq) return 2;
    if (n.startsWith(nq)) return 3;
    return 4;
  };
  return list.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

async function searchPatients(q) {
  // Key on what was actually typed — normName folds apostrophes and hyphens away, so
  // it would let "O'Boyle" and "O Boyle" (different DrChrono queries) share an entry.
  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL) return cached.patients;

  const parts = q.split(' ');
  const byId = new Map();
  const add = (list) => { for (const p of list) if (!byId.has(p.id)) byId.set(p.id, p); };

  if (parts.length === 1) {
    // One word is as likely to be a surname as a first name, so ask for both.
    const both = await Promise.all([
      drSearch({ last_name: parts[0] }),
      drSearch({ first_name: parts[0] }),
    ]);
    both.forEach(add);
  } else {
    const last = parts[parts.length - 1];
    const allButLast = parts.slice(0, -1).join(' ');
    add(await drSearch({ first_name: allButLast, last_name: last })); // "Andrea Blanco"
    if (!byId.size) {
      // Only pay for these when the plain reading found nothing: two-word surnames
      // ("Stacy Norton O'Boyle"), a name typed surname-first, or a first name the
      // chart spells differently — in which case the surname alone still finds them.
      const fallbacks = [
        { first_name: parts[0], last_name: parts.slice(1).join(' ') },
        { first_name: last, last_name: allButLast },
        { last_name: last },
      ].filter(p => JSON.stringify(p) !== JSON.stringify({ first_name: allButLast, last_name: last }));
      const tries = await Promise.all(fallbacks.map(p => drSearch(p)));
      tries.forEach(add);
    }
  }

  const ranked = rankMatches([...byId.values()], q);
  searchCache.set(key, { at: Date.now(), patients: ranked });
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  return ranked;
}

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
  const t = String(title || '');
  // Primary: the structured "[patient]: Name" field older Plaud summaries emit.
  const m = text.match(/\[patient\][^\n:]*[:\-]+\s*([^\n\r]+)/i);
  if (m && m[1]) {
    const v = m[1].replace(/\[.*?\]/g, '').trim();
    if (v && !/^(not stated|unknown|n\/?a)$/i.test(v)) return v;
  }
  // Narrative patterns used by current Plaud summaries (the [patient]: field is
  // gone from recent formats): "The patient, Anisha Augustine, ...",
  // "the patient's, Crystal Lewis (born ...", "@Patient (Jessica)", and
  // "Consultation for Crystal Lewis" in the subject.
  const NAME = "([A-Z][a-z]+(?:\\s+[A-Z][a-z'’.\\-]*[A-Za-z]){1,2})";
  const patterns = [
    new RegExp('@patient[^\\n(]*\\(\\s*([^)\\n]+?)\\s*\\)', 'i'),   // @Patient (Jessica)
    new RegExp("patient(?:'s|’s)?,\\s*" + NAME, 'i'),               // The patient, Anisha Augustine,
    new RegExp('\\bpatient,?\\s+' + NAME + '\\s*\\(', 'i'),         // patient Crystal Lewis (born
    new RegExp('\\bfor\\s+(?:patient\\s+)?' + NAME, 'i'),           // Consultation for Crystal Lewis
  ];
  for (const re of patterns) {
    const mm = text.match(re) || t.match(re);
    if (mm && mm[1]) {
      const v = mm[1].replace(/\[.*?\]/g, '').trim();
      if (v && v.length <= 60 && !/^(not stated|unknown|n\/?a|the|a|patient)$/i.test(v)) return v;
    }
  }
  // Last-resort subject fallback: name after a colon, but ONLY if it actually
  // looks like a person's name (1-3 capitalized words), never a title phrase
  // like "Diagnosing Post-Surgical Breast Discoloration".
  if (t.includes(':')) {
    const after = t.split(':').pop().trim();
    if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+){0,2}$/.test(after) && after.length <= 40) return after;
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
    else if (first && last && lastCounts[last] === 1 && has(first) && last.length >= 5) {
      // Fuzzy last name: tolerate Plaud misspellings ("Augustine" vs schedule
      // "Augustin") only when the first name is present and the last name is
      // unique that day, so a garbled name can never land on the wrong chart.
      for (const w of t.split(' ')) {
        if (w.length >= 5 && simRatio(w, last) >= 0.85) { how = 'fuzzy_last'; break; }
      }
    }
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
    const held = (Array.isArray(s.held_notes) ? s.held_notes : []).map(h => {
      // Re-derive a suggested name for notes held before the extractor improved, so
      // the filing box can pre-select it (older items were stored with candidate '').
      let candidate = h.candidate;
      if (!candidate) {
        try { candidate = extractPatientName(h.note || h.preview || '', h.title || ''); } catch (e) { candidate = ''; }
      }
      // The date the visit was recorded (from "[Plaud-AutoFlow] 07-09 ..."), so the
      // filing picker can load THAT day's schedule — the patient is guaranteed to be
      // on it — instead of today's (empty when the office is closed).
      const noteDate = parseNoteDate(h.title || '') || (h.at ? String(h.at).slice(0, 10) : todayInTz(DRCHRONO_TZ));
      return { ...h, candidate: candidate || '', noteDate };
    });
    res.json({ held });
  } catch (e) {
    res.status(502).json({ error: 'storage_failed', detail: e.message });
  }
});

// The schedule for any given day, so a held note can be filed from the day it was
// recorded (reliable and small) rather than only today's list.
app.get('/api/schedule', async (req, res) => {
  const date = String(req.query.date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.date : todayInTz(DRCHRONO_TZ);
  try {
    res.json(await fetchPatientsForDate(date, { refresh: req.query.refresh === '1' }));
  } catch (e) {
    console.error('GET /api/schedule:', e.message);
    res.status(502).json({ error: 'schedule_unavailable', detail: e.message, retryAfter: retryAfterSecs() });
  }
});

// Search every chart, not just today's schedule — for the note whose patient was not
// on that day's list (walk-in, mis-dated recording) and for looking anyone up by name.
app.get('/api/patients/search', async (req, res) => {
  // Keep the raw words: DrChrono matches them against the real chart, so apostrophes
  // and hyphens in a surname have to survive. normName is for ranking only.
  const q = String(req.query.q || '').trim().replace(/\s+/g, ' ');
  if (q.length < 2) return res.json({ patients: [] });
  try {
    const all = await searchPatients(q);
    res.json({
      patients: all.slice(0, SEARCH_MAX),
      total: all.length,
      truncated: all.length > SEARCH_MAX,
    });
  } catch (e) {
    console.error('GET /api/patients/search:', e.message);
    res.status(502).json({ error: 'patient_search_failed', detail: e.message, retryAfter: retryAfterSecs() });
  }
});

// File a held note onto a chosen patient's chart, then drop it from the held list.
app.post('/api/file-held', async (req, res) => {
  const { at, patientId, patientName } = req.body || {};
  if (!patientId || !patientName) return res.status(400).json({ error: 'patient_required' });
  let store = {};
  try { store = await zapGet(); } catch (e) { return res.status(502).json({ error: 'storage_failed', detail: e.message }); }
  const list = Array.isArray(store.held_notes) ? store.held_notes : [];
  const idx = list.findIndex(x => x.at === at); // stable key, avoids index races
  if (idx < 0) return res.status(404).json({ error: 'held_note_not_found' });
  const item = list[idx];
  try {
    const document = await uploadNoteToChart({ pid: String(patientId), pname: patientName, title: item.title, note: item.note || item.preview || '' });
    list.splice(idx, 1);
    await zapSet({ held_notes: list });
    res.json({ ok: true, filed: true, patient_name: patientName, remaining: list.length, document });
  } catch (e) {
    console.error('file-held upload failed:', e.status, e.detail || e.message);
    res.status(502).json({ error: 'drchrono_upload_failed', status: e.status || 500, detail: e.detail || e.message });
  }
});

app.get('/api/today', async (req, res) => {
  try {
    res.json(await fetchTodaysPatients({ refresh: req.query.refresh === '1' }));
  } catch (e) {
    console.error('GET /api/today:', e.message);
    res.status(502).json({ error: 'schedule_unavailable', detail: e.message, retryAfter: retryAfterSecs() });
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

// Upload a note PDF to a specific patient's chart. Throws on failure with err.status/err.detail.
async function uploadNoteToChart({ pid, pname, title, note }) {
  const pdf = await notePdf(title || `Note for ${pname}`, note);
  const mkForm = () => {
    const form = new FormData();
    form.append('patient', String(pid));
    form.append('doctor', String(DRCHRONO_DOCTOR_ID));
    form.append('date', todayInTz(DRCHRONO_TZ));
    form.append('description', (title || 'Plaud note') + (pname ? ' - ' + pname : ''));
    form.append('document', new Blob([pdf], { type: 'application/pdf' }), 'note.pdf');
    return form;
  };
  let token = await getAccessToken();
  let r = await fetch('https://app.drchrono.com/api/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: mkForm() });
  if (r.status === 401) {
    accessToken = null; token = await getAccessToken();
    r = await fetch('https://app.drchrono.com/api/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: mkForm() });
  }
  const text = await r.text();
  if (!r.ok) { const err = new Error('drchrono ' + r.status); err.status = r.status; err.detail = text.slice(0, 300); throw err; }
  return JSON.parse(text || '{}');
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

    try {
      const document = await uploadNoteToChart({ pid, pname, title, note });
      res.json({ ok: true, routed, patient_id: pid, patient_name: pname, document });
    } catch (e) {
      console.error('note upload failed:', e.status, e.detail || e.message);
      return res.status(502).json({ error: 'drchrono_upload_failed', status: e.status || 500, detail: e.detail || e.message });
    }
  } catch (e) {
    console.error('POST /api/note:', e.message);
    res.status(500).json({ error: 'note_failed', detail: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('patient-dashboard listening on :' + PORT);
  // No roster to warm any more: search asks DrChrono directly, so the first search
  // after a cold start is already fast and a restart no longer costs ~280 API calls.
});
