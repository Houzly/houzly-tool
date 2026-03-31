const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const DB_FILE  = path.join(__dirname, 'data', 'db.json');
const AUTH_FILE = path.join(__dirname, 'data', 'auth.json');

// Ensure data dir exists
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

app.use(express.json({ limit: '10mb' }));

// Serve the frontend HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ── Helper ────────────────────────────────────────────────────────
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── AUTH ──────────────────────────────────────────────────────────
// POST /api/auth/check   { pin }  → { ok, exists }
// POST /api/auth/login   { pin }  → { ok }
// POST /api/auth/set     { pin }  → { ok }
// POST /api/auth/change  { oldPin, newPin } → { ok }

app.get('/api/auth/exists', (req, res) => {
  const auth = readJSON(AUTH_FILE, null);
  res.json({ exists: !!auth });
});

app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  const auth = readJSON(AUTH_FILE, null);
  if (!auth) return res.json({ ok: false, error: 'no_auth' });
  const hash = crypto.createHash('sha256').update(pin).digest('hex');
  res.json({ ok: hash === auth.hash });
});

app.post('/api/auth/set', (req, res) => {
  const { pin } = req.body;
  if (!pin || pin.length < 4) return res.json({ ok: false, error: 'too_short' });
  const hash = crypto.createHash('sha256').update(pin).digest('hex');
  writeJSON(AUTH_FILE, { hash });
  res.json({ ok: true });
});

app.post('/api/auth/change', (req, res) => {
  const { oldPin, newPin } = req.body;
  const auth = readJSON(AUTH_FILE, null);
  if (!auth) return res.json({ ok: false, error: 'no_auth' });
  const oldHash = crypto.createHash('sha256').update(oldPin).digest('hex');
  if (oldHash !== auth.hash) return res.json({ ok: false, error: 'wrong_pin' });
  const hash = crypto.createHash('sha256').update(newPin).digest('hex');
  writeJSON(AUTH_FILE, { hash });
  res.json({ ok: true });
});

// ── DB (main data) ─────────────────────────────────────────────────
// GET  /api/db      → full DB object
// POST /api/db      → save full DB object { db: {...} }

app.get('/api/db', (req, res) => {
  const db = readJSON(DB_FILE, null);
  res.json({ ok: true, db });
});

app.post('/api/db', (req, res) => {
  const { db } = req.body;
  if (!db) return res.status(400).json({ ok: false, error: 'missing db' });
  writeJSON(DB_FILE, db);
  res.json({ ok: true });
});

// ── Backup / Restore ───────────────────────────────────────────────
// GET  /api/backup  → full JSON export
// POST /api/restore → restore from JSON { backup: {...} }

app.get('/api/backup', (req, res) => {
  const db = readJSON(DB_FILE, {});
  res.setHeader('Content-Disposition', `attachment; filename="houzly-backup-${new Date().toISOString().slice(0,10)}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(db, null, 2));
});

app.post('/api/restore', (req, res) => {
  const { backup } = req.body;
  if (!backup) return res.status(400).json({ ok: false });
  writeJSON(DB_FILE, backup);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Houzly server running on port ${PORT}`));
