const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// JSONBin config — set these as Environment Variables on Render
const JSONBIN_KEY    = process.env.JSONBIN_KEY;    // X-Master-Key
const JSONBIN_BIN_DB = process.env.JSONBIN_BIN_DB; // Bin ID for main DB
const JSONBIN_BIN_AU = process.env.JSONBIN_BIN_AU; // Bin ID for auth

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── JSONBin helpers ───────────────────────────────────────────────
async function binGet(binId) {
  const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_KEY }
  });
  const data = await r.json();
  return data.record;
}

async function binSet(binId, record) {
  const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
    method: 'PUT',
    headers: { 'X-Master-Key': JSONBIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(record)
  });
  return await r.json();
}

// ── AUTH ──────────────────────────────────────────────────────────
app.get('/api/auth/exists', async (req, res) => {
  try {
    const auth = await binGet(JSONBIN_BIN_AU);
    res.json({ exists: !!(auth && auth.hash) });
  } catch { res.json({ exists: false }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { pin } = req.body;
    const auth = await binGet(JSONBIN_BIN_AU);
    if (!auth || !auth.hash) return res.json({ ok: false, error: 'no_auth' });
    const hash = crypto.createHash('sha256').update(pin).digest('hex');
    res.json({ ok: hash === auth.hash });
  } catch { res.json({ ok: false, error: 'server_error' }); }
});

app.post('/api/auth/set', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || pin.length < 4) return res.json({ ok: false, error: 'too_short' });
    const hash = crypto.createHash('sha256').update(pin).digest('hex');
    await binSet(JSONBIN_BIN_AU, { hash });
    res.json({ ok: true });
  } catch { res.json({ ok: false, error: 'server_error' }); }
});

app.post('/api/auth/change', async (req, res) => {
  try {
    const { oldPin, newPin } = req.body;
    const auth = await binGet(JSONBIN_BIN_AU);
    const oldHash = crypto.createHash('sha256').update(oldPin).digest('hex');
    if (oldHash !== auth.hash) return res.json({ ok: false, error: 'wrong_pin' });
    const hash = crypto.createHash('sha256').update(newPin).digest('hex');
    await binSet(JSONBIN_BIN_AU, { hash });
    res.json({ ok: true });
  } catch { res.json({ ok: false, error: 'server_error' }); }
});

// ── DB ────────────────────────────────────────────────────────────
app.get('/api/db', async (req, res) => {
  try {
    const db = await binGet(JSONBIN_BIN_DB);
    res.json({ ok: true, db });
  } catch { res.json({ ok: false, db: null }); }
});

app.post('/api/db', async (req, res) => {
  try {
    const { db } = req.body;
    if (!db) return res.status(400).json({ ok: false });
    await binSet(JSONBIN_BIN_DB, db);
    res.json({ ok: true });
  } catch { res.json({ ok: false, error: 'server_error' }); }
});

// ── Backup ────────────────────────────────────────────────────────
app.get('/api/backup', async (req, res) => {
  try {
    const db = await binGet(JSONBIN_BIN_DB);
    const filename = `houzly-backup-${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ version: 2, date: new Date().toISOString(), db }, null, 2));
  } catch { res.status(500).json({ ok: false }); }
});

app.post('/api/restore', async (req, res) => {
  try {
    const { backup } = req.body;
    if (!backup) return res.status(400).json({ ok: false });
    await binSet(JSONBIN_BIN_DB, backup);
    res.json({ ok: true });
  } catch { res.json({ ok: false, error: 'server_error' }); }
});

app.listen(PORT, () => console.log(`Houzly server running on port ${PORT}`));
