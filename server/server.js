/**
 * Screenly standalone backend
 * ----------------------------------------------------------------
 * A minimal, dependency-light Express server that gives the Screenly
 * front-end (www/index.html) a REAL persistent database and a
 * SECURE server-side AI proxy, so the app can run outside Claude.ai
 * on any normal HTTPS domain.
 *
 * Only 2 npm dependencies: express, cors. Everything else (env
 * loading, JSON file storage, the Anthropic API call) uses Node's
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
const AI_API_KEY = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
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
// Server-side Claude proxy — the front-end NEVER sees AI_API_KEY.
app.post('/api/ai', async (req, res) => {
  if (!AI_API_KEY) {
    return res.status(500).json({ error: 'AI_API_KEY is not configured on the server (.env)' });
  }
  const { prompt, json, modelTier } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  const model = modelTier === 'quick' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: 'AI provider error', detail: errText });
    }
    const data = await r.json();
    const text = (data.content || []).map(b => b.text || '').join('\n');
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
    res.status(502).json({ error: 'AI request failed', detail: String(e) });
  }
});

// ------------------------- STATIC FRONT-END -------------------------
app.use(express.static(path.join(__dirname, '..', 'www')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'www', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Screenly server running on http://localhost:${PORT}`);
  if (!AI_API_KEY) console.warn('⚠️  AI_API_KEY not set — AI screening will not work until you set it in .env');
  if (!AUTH_SECRET) console.warn('⚠️  AUTH_SECRET not set — /api routes are open. Fine for local dev only.');
});
