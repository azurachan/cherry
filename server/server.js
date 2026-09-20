/**
 * Screenly standalone backend
 * ----------------------------------------------------------------
 * A minimal, dependency-light Express server that gives the Screenly
 * front-end (www/index.html) a REAL persistent database and a
 * SECURE server-side AI proxy, so the app can run outside Claude.ai
 * on any normal HTTPS domain.
 *
 * Only 2 npm dependencies: express, cors. Everything else (env
 * loading, JSON file storage, the Gemini API call) uses Node's
 * built-ins (Node 18+ has global fetch).
 *
 * THIS FILE WAS WRITTEN BUT NOT RUN in the environment that produced
 * it — that sandbox has no outbound network access, so `npm install`
 * could not be executed there. Test it yourself with:
 *   npm install
 *   node server/server.js
 * ------------------------------------------------------------------
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

// ---- tiny .env loader (no dependency on the `dotenv` package) ----
(function loadEnv(){
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = (m[2] || '').trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_MAX_RETRIES = 3;
const GEMINI_RETRY_BASE_MS = 250;
const AUTH_SECRET = process.env.AUTH_SECRET || '';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ------------------------------------------------------------------
// STEP 3 placeholder: this uses one JSON file per collection so the
// server works with zero extra setup. For real production use, swap
// this block for a real database (Postgres/Supabase/MySQL) behind
// the exact same readCollection/writeCollection function signatures
// — nothing else in this file (or the front-end) needs to change.
// ------------------------------------------------------------------
function collFile(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DATA_DIR, safe + '.json');
}
function readCollection(name) {
  const f = collFile(name);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8') || '{}'); } catch (e) { return {}; }
}
function writeCollection(name, obj) {
  fs.writeFileSync(collFile(name), JSON.stringify(obj, null, 2));
}

// Simple lease/lock store for the acquire() semantics Screenly's
// seeding logic relies on (prevents two tabs from double-seeding).
const leases = {}; // path -> { holder, expiresAt }

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ---- very small bearer-token auth guard for the /api/db routes ----
// STEP 12 / security: set AUTH_SECRET in .env for anything beyond local dev.
app.use('/api', (req, res, next) => {
  if (!AUTH_SECRET) return next(); // no secret configured: open (local dev only)
  const header = req.headers.authorization || '';
  if (header === `Bearer ${AUTH_SECRET}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// ---------------------------- DB ROUTES ----------------------------
// GET a whole collection: { docs: [{id, data}, ...] }
app.get('/api/db/:collection', (req, res) => {
  const coll = readCollection(req.params.collection);
  res.json({ docs: Object.keys(coll).map(id => ({ id, data: coll[id] })) });
});

// GET one document: { exists, id, data }
app.get('/api/db/:collection/:id', (req, res) => {
  const coll = readCollection(req.params.collection);
  const data = coll[req.params.id];
  res.json({ exists: data !== undefined, id: req.params.id, data: data || null });
});

// PUT (set/replace) one document
app.put('/api/db/:collection/:id', (req, res) => {
  const coll = readCollection(req.params.collection);
  coll[req.params.id] = req.body;
  writeCollection(req.params.collection, coll);
  res.json({ ok: true });
});

// DELETE one document
app.delete('/api/db/:collection/:id', (req, res) => {
  const coll = readCollection(req.params.collection);
  delete coll[req.params.id];
  writeCollection(req.params.collection, coll);
  res.json({ ok: true });
});

// POST acquire a short lease on a doc path (used to avoid duplicate seeding)
app.post('/api/db/:collection/:id/acquire', (req, res) => {
  const key = req.params.collection + '/' + req.params.id;
  const { holder, ttlMs } = req.body || {};
  const now = Date.now();
  const existing = leases[key];
  if (existing && existing.expiresAt > now && existing.holder !== holder) {
    return res.json({ acquired: false });
  }
  leases[key] = { holder, expiresAt: now + (ttlMs || 20000) };
  res.json({ acquired: true });
});

// ---------------------------- AI ROUTE ----------------------------
// Server-side Gemini proxy — the front-end NEVER sees GEMINI_API_KEY.
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableGeminiFailure(status, detail) {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /high demand|temporar|service unavailable|unavailable|overloaded|try again later|rate limit/i.test(String(detail||''));
}

function parseGeminiError(body) {
  let detail = body;
  try {
    const providerError = JSON.parse(body);
    detail = providerError.error?.message || providerError.error?.status || providerError.error || body;
  } catch (e) {}
  return String(detail);
}

async function requestGemini(model, requestBody) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  let lastFailure = 'Gemini sementara tidak tersedia.';
  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      if (response.ok) return response;
      const detail = parseGeminiError(await response.text());
      if (!isRetryableGeminiFailure(response.status, detail) || attempt === GEMINI_MAX_RETRIES) {
        return { response, detail, exhausted: attempt === GEMINI_MAX_RETRIES && isRetryableGeminiFailure(response.status, detail) };
      }
      lastFailure = detail;
    } catch (error) {
      lastFailure = error?.message || String(error);
      if (attempt === GEMINI_MAX_RETRIES) throw Object.assign(new Error(lastFailure), { retryExhausted: true });
    }
    await wait(GEMINI_RETRY_BASE_MS * (2 ** attempt));
  }
  throw Object.assign(new Error(lastFailure), { retryExhausted: true });
}

app.post('/api/ai', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server (.env)' });
  }
  const { prompt, json, modelTier } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  const model = GEMINI_MODEL;
  try {
    const inputText = json && !/\bjson\b/i.test(String(prompt))
      ? `Return the result as valid JSON.\n\n${String(prompt)}`
      : String(prompt);
    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: inputText }] }],
      generationConfig: { maxOutputTokens: 2000 },
    };
    if (json) requestBody.generationConfig.responseMimeType = 'application/json';

    const result = await requestGemini(model, requestBody);
    if (result.response && !result.response.ok) {
      if (result.exhausted) {
        return res.status(503).json({ error: 'AI temporarily unavailable', detail: 'Gemini sedang mengalami permintaan tinggi atau gangguan sementara. Silakan coba lagi beberapa saat lagi.' });
      }
      return res.status(502).json({ error: 'AI provider error', detail: result.detail });
    }
    const data = await result.json();
    const text = (data.candidates || [])
      .flatMap(candidate => candidate.content?.parts || [])
      .map(part => part.text || '')
      .join('\n');
    if (!text) return res.status(502).json({ error: 'AI returned an empty response' });
    if (json) {
      try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        return res.json({ json: JSON.parse(cleaned) });
      } catch (e) {
        return res.status(502).json({ error: 'AI did not return valid JSON', raw: text });
      }
    }
    res.json({ text });
  } catch (e) {
    if (e.retryExhausted) {
      return res.status(503).json({ error: 'AI temporarily unavailable', detail: 'Gemini sedang mengalami gangguan sementara. Silakan coba lagi beberapa saat lagi.' });
    }
    res.status(502).json({ error: 'AI request failed', detail: e?.message || String(e) });
  }
});

// ------------------------- STATIC FRONT-END -------------------------
app.use(express.static(path.join(__dirname, '..', 'www')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'www', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Screenly server running on http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) console.warn('⚠️  GEMINI_API_KEY not set — AI screening will not work until you set it in .env');
  if (!AUTH_SECRET) console.warn('⚠️  AUTH_SECRET not set — /api routes are open. Fine for local dev only.');
});
