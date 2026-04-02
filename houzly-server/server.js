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

// ── Smoobu Proxy ──────────────────────────────────────────────────
// GET /api/smoobu/reservations?apiKey=XXX&pageSize=100&page=1
// Proxies to Smoobu API to avoid CORS issues from the browser.
app.get('/api/smoobu/reservations', async (req, res) => {
  try {
    const apiKey   = req.query.apiKey;
    const pageSize = req.query.pageSize || 100;
    const page     = req.query.page || 1;

    if (!apiKey) return res.status(400).json({ ok: false, error: 'missing_api_key' });

    const url = `https://login.smoobu.com/api/reservations?pageSize=${pageSize}&page=${page}`;
    const r = await fetch(url, {
      headers: {
        'Api-Key': apiKey,
        'Cache-Control': 'no-cache'
      }
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ ok: false, error: `Smoobu error ${r.status}`, detail: text });
    }

    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Smoobu Webhook (new / modified / cancelled in real time) ──────
// Configure this URL in Smoobu → Account → Settings → API → Webhooks:
//   https://houzly-tool.onrender.com/api/smoobu/webhook
app.post('/api/smoobu/webhook', async (req, res) => {
  try {
    const event = req.body;
    // Smoobu sends: action = "newReservation" | "modifiedReservation" | "cancelledReservation"
    console.log('[Smoobu Webhook]', event.action, event.data?.id);

    // Load current DB
    const db = await binGet(JSONBIN_BIN_DB);
    if (!db) return res.json({ ok: false, error: 'db_not_found' });
    if (!db.cleaning) db.cleaning = { tasks: [], cleaners: [], defaultChecklist: [], apiKey: '', lastSync: null };

    const b = event.data || event;

    // Skip blocked bookings (closures, maintenance, etc.)
    if (b['is-blocked-booking'] === true) return res.json({ ok: true, skipped: 'blocked' });

    const bookingId = String(b.id || b.reservationId || '');
    const checkout  = (b.departure || '').split('T')[0];  // departure = checkout date
    const checkin   = (b.arrival   || '').split('T')[0];  // arrival   = checkin date
    const checkoutTime = b['check-out'] || '10:00';       // check-out = checkout time
    const checkinTime  = b['check-in']  || '15:00';       // check-in  = checkin time
    const propName  = (b.apartment?.name || b.apartmentName || 'N/D');
    const propId    = b.apartment?.id ? String(b.apartment.id) : null;

    const action = event.action || '';

    if (action === 'cancelledReservation') {
      // Remove cleaning task for this booking
      db.cleaning.tasks = db.cleaning.tasks.filter(t => t.smoobu_id !== bookingId);
    } else {
      // newReservation or modifiedReservation
      const existsIdx = db.cleaning.tasks.findIndex(t => t.smoobu_id === bookingId);
      if (existsIdx >= 0) {
        // Update dates/property, keep cleaner+notes+checklist
        db.cleaning.tasks[existsIdx].date         = checkout;
        db.cleaning.tasks[existsIdx].checkin_date  = checkin;
        db.cleaning.tasks[existsIdx].prop_name     = propName;
      } else {
        // New task
        const defaultCL = (db.cleaning.defaultChecklist || []).map((item, i) => ({
          id: `dc_${Date.now()}_${i}`, text: item, done: false
        }));
        db.cleaning.tasks.push({
          id:            `cl_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
          smoobu_id:     bookingId,
          prop_name:     propName,
          prop_id:       propId,
          date:          checkout,
          checkin_date:  checkin,
          checkout_time: checkoutTime,
          checkin_time:  checkinTime,
          cleaner:       '',
          notes:         '',
          checklist:     defaultCL,
          status:        'todo',
          created:       new Date().toISOString()
        });
      }
    }

    db.cleaning.lastSync = new Date().toISOString();
    await binSet(JSONBIN_BIN_DB, db);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Smoobu Webhook] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Houzly server running on port ${PORT}`));
