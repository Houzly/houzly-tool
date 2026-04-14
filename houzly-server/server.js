const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;

// MongoDB config — set MONGODB_URI as Environment Variable on Render
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME     = 'houzly';

let _client = null;

async function getDb() {
  if (!_client) {
    _client = new MongoClient(MONGODB_URI);
    await _client.connect();
  }
  return _client.db(DB_NAME);
}

async function getCollection(name) {
  const db = await getDb();
  return db.collection(name);
}

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── AUTH ──────────────────────────────────────────────────────────
app.get('/api/auth/exists', async (req, res) => {
  try {
    const col  = await getCollection('auth');
    const auth = await col.findOne({ _id: 'auth' });
    res.json({ exists: !!(auth && auth.hash) });
  } catch (e) { console.error('[auth/exists]', e.message); res.json({ exists: false }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { pin } = req.body;
    const col  = await getCollection('auth');
    const auth = await col.findOne({ _id: 'auth' });
    if (!auth || !auth.hash) return res.json({ ok: false, error: 'no_auth' });
    const hash = crypto.createHash('sha256').update(pin).digest('hex');
    res.json({ ok: hash === auth.hash });
  } catch (e) { console.error('[route]', e.message); res.json({ ok: false, error: e.message }); }
});

app.post('/api/auth/set', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || pin.length < 4) return res.json({ ok: false, error: 'too_short' });
    const hash = crypto.createHash('sha256').update(pin).digest('hex');
    const col  = await getCollection('auth');
    await col.replaceOne({ _id: 'auth' }, { _id: 'auth', hash }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { console.error('[auth/set]', e.message); res.json({ ok: false, error: e.message }); }
});

app.post('/api/auth/change', async (req, res) => {
  try {
    const { oldPin, newPin } = req.body;
    const col  = await getCollection('auth');
    const auth = await col.findOne({ _id: 'auth' });
    const oldHash = crypto.createHash('sha256').update(oldPin).digest('hex');
    if (oldHash !== auth.hash) return res.json({ ok: false, error: 'wrong_pin' });
    const hash = crypto.createHash('sha256').update(newPin).digest('hex');
    await col.replaceOne({ _id: 'auth' }, { _id: 'auth', hash }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { console.error('[route]', e.message); res.json({ ok: false, error: e.message }); }
});

// ── DB ────────────────────────────────────────────────────────────
app.get('/api/db', async (req, res) => {
  try {
    const col = await getCollection('db');
    const doc = await col.findOne({ _id: 'main' });
    if (doc) {
      const { _id, ...db } = doc;
      res.json({ ok: true, db });
    } else {
      res.json({ ok: true, db: null });
    }
  } catch (e) {
    res.json({ ok: false, db: null, error: e.message });
  }
});

app.post('/api/db', async (req, res) => {
  try {
    const { db } = req.body;
    if (!db) return res.status(400).json({ ok: false });
    const { _id, ...cleanDb } = db;
    const col = await getCollection('db');
    await col.replaceOne({ _id: 'main' }, { _id: 'main', ...cleanDb }, { upsert: true });
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/db]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Backup ────────────────────────────────────────────────────────
app.get('/api/backup', async (req, res) => {
  try {
    const col = await getCollection('db');
    const doc = await col.findOne({ _id: 'main' });
    const { _id, ...db } = doc || {};
    const filename = `houzly-backup-${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ version: 3, date: new Date().toISOString(), db }, null, 2));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/restore', async (req, res) => {
  try {
    const { backup } = req.body;
    if (!backup) return res.status(400).json({ ok: false });
    const col = await getCollection('db');
    const { _id: _rid, ...cleanBackup } = backup;
    await col.replaceOne({ _id: 'main' }, { _id: 'main', ...cleanBackup }, { upsert: true });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Smoobu Proxy (Houzly Tool — cleaning sync) ────────────────────
app.get('/api/smoobu/reservations', async (req, res) => {
  try {
    const apiKey   = req.query.apiKey;
    const pageSize = req.query.pageSize || 100;
    const page     = req.query.page || 1;
    if (!apiKey) return res.status(400).json({ ok: false, error: 'missing_api_key' });
    const url = `https://login.smoobu.com/api/reservations?pageSize=${pageSize}&page=${page}`;
    const r = await fetch(url, {
      headers: { 'Api-Key': apiKey, 'Cache-Control': 'no-cache' }
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

// ── Smoobu Webhook ────────────────────────────────────────────────
app.post('/api/smoobu/webhook', async (req, res) => {
  try {
    const event = req.body;
    console.log('[Smoobu Webhook]', event.action, event.data?.id);

    const col = await getCollection('db');
    const doc = await col.findOne({ _id: 'main' });
    if (!doc) return res.json({ ok: false, error: 'db_not_found' });

    const { _id, ...db } = doc;
    if (!db.cleaning) db.cleaning = { tasks: [], cleaners: [], defaultChecklist: [], apiKey: '', lastSync: null };

    const b = event.data || event;
    if (b['is-blocked-booking'] === true) return res.json({ ok: true, skipped: 'blocked' });

    const bookingId    = String(b.id || b.reservationId || '');
    const checkout     = (b.departure || '').split('T')[0];
    const checkin      = (b.arrival   || '').split('T')[0];
    const checkoutTime = b['check-out'] || '10:00';
    const checkinTime  = b['check-in']  || '15:00';
    const propName     = (b.apartment?.name || b.apartmentName || 'N/D');
    const propId       = b.apartment?.id ? String(b.apartment.id) : null;
    const action       = event.action || '';

    if (action === 'cancelledReservation') {
      db.cleaning.tasks = db.cleaning.tasks.filter(t => t.smoobu_id !== bookingId);
    } else {
      const existsIdx = db.cleaning.tasks.findIndex(t => t.smoobu_id === bookingId);
      if (existsIdx >= 0) {
        db.cleaning.tasks[existsIdx].date          = checkout;
        db.cleaning.tasks[existsIdx].checkin_date  = checkin;
        db.cleaning.tasks[existsIdx].prop_name     = propName;
        db.cleaning.tasks[existsIdx].checkout_time = checkoutTime;
        db.cleaning.tasks[existsIdx].checkin_time  = checkinTime;
      } else {
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
    await col.replaceOne({ _id: 'main' }, { _id: 'main', ...db }, { upsert: true });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Smoobu Webhook] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ── Smoobu Booking Engine (houzly.it website proxy) ──────────────
//
//  Queste route fanno da proxy tra il sito houzly.it (GitHub Pages)
//  e le API Smoobu, risolvendo il problema CORS.
//
//  Richiede SMOOBU_API_KEY nelle Environment Variables di Render.
//  (Smoobu → Impostazioni → Sviluppatori → API Key)
//
//  CORS aperto solo per houzly.it e localhost (sviluppo).
// ══════════════════════════════════════════════════════════════════

const SMOOBU_API_KEY = process.env.SMOOBU_API_KEY;

// Middleware CORS per le route /api/booking/*
function bookingCors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

// Helper: headers Smoobu
function smoobuHdr() {
  return { 'Api-Key': SMOOBU_API_KEY, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' };
}

// ── GET /api/booking/apartments ───────────────────────────────────
// Recupera lista appartamenti Smoobu con i loro ID.
// Usare una volta per mappare smoobuId nelle PROPERTIES del sito.
// Esempio: https://houzly-tool.onrender.com/api/booking/apartments
app.get('/api/booking/apartments', bookingCors, async (req, res) => {
  try {
    const r = await fetch('https://login.smoobu.com/api/apartments', { headers: smoobuHdr() });
    const data = await r.json();
    console.log('[booking/apartments] raw response keys:', Object.keys(data));

    // Smoobu può restituire { apartments: [...] } oppure direttamente un array
    // o { data: [...] } — gestiamo tutti i casi
    let list = [];
    if (Array.isArray(data))              list = data;
    else if (Array.isArray(data.apartments)) list = data.apartments;
    else if (Array.isArray(data.data))    list = data.data;
    else {
      // Restituiamo il raw per debug
      return res.json({ ok: true, apartments: [], _raw: data });
    }

    const apartments = list.map(a => ({
      id:   a.id,
      name: a.name,
      type: a.type || null
    }));
    res.json({ ok: true, apartments });
  } catch (e) {
    console.error('[booking/apartments]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/booking/availability ───────────────────────────────
// Verifica disponibilità e prezzo per un appartamento e un periodo.
// Body: { apartmentId, arrival: "YYYY-MM-DD", departure: "YYYY-MM-DD", guests }
// Risposta: { ok, available, price, nights, minStay }
app.post('/api/booking/availability', bookingCors, async (req, res) => {
  const { apartmentId, arrival, departure, guests } = req.body || {};
  if (!apartmentId || !arrival || !departure) {
    return res.status(400).json({ ok: false, error: 'Campi obbligatori: apartmentId, arrival, departure' });
  }
  try {
    const payload = { apartments: [Number(apartmentId)], arrival, departure };
    if (guests) payload.adults = Number(guests);
    const r = await fetch('https://login.smoobu.com/api/availability', {
      method: 'POST', headers: smoobuHdr(), body: JSON.stringify(payload)
    });
    const data = await r.json();
    const apt  = data && data[apartmentId];
    if (!apt) return res.status(404).json({ ok: false, error: 'Apartment non trovato' });
    res.json({
      ok:        true,
      available: apt.available === true,
      price:     apt.price     || null,
      nights:    apt.nights    || null,
      minStay:   apt.minimumLength || null
    });
  } catch (e) {
    console.error('[booking/availability]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/booking/rates ────────────────────────────────────────
// Recupera disponibilità giorno per giorno (per il calendario).
// Query: apartmentId, start=YYYY-MM-DD, end=YYYY-MM-DD
app.get('/api/booking/rates', bookingCors, async (req, res) => {
  const { apartmentId, start, end } = req.query;
  if (!apartmentId || !start || !end) {
    return res.status(400).json({ ok: false, error: 'Campi obbligatori: apartmentId, start, end' });
  }
  try {
    const url = `https://login.smoobu.com/api/rates?apartments[]=${apartmentId}&start_date=${start}&end_date=${end}`;
    const r   = await fetch(url, { headers: smoobuHdr() });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error('[booking/rates]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/booking/create ──────────────────────────────────────
// Crea una prenotazione diretta su Smoobu (canale Direct, senza OTA).
// Body: { apartmentId, arrival, departure, firstName, lastName, email,
//         phone?, adults?, note? }
app.post('/api/booking/create', bookingCors, async (req, res) => {
  const { apartmentId, arrival, departure, firstName, lastName, email, phone, adults, note } = req.body || {};
  if (!apartmentId || !arrival || !departure || !firstName || !lastName || !email) {
    return res.status(400).json({ ok: false, error: 'Campi obbligatori: apartmentId, arrival, departure, firstName, lastName, email' });
  }
  try {
    const payload = {
      'apartment-id': Number(apartmentId),
      arrival, departure,
      'first-name': firstName,
      'last-name':  lastName,
      email,
      adults: Number(adults) || 1,
      'channel-id': 397  // Direct booking in Smoobu
    };
    if (phone) payload.phone  = phone;
    if (note)  payload.notice = note;

    const r = await fetch('https://login.smoobu.com/api/reservations', {
      method: 'POST', headers: smoobuHdr(), body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[booking/create] Smoobu rejected:', data);
      return res.status(r.status).json({ ok: false, error: data.detail || 'Smoobu ha rifiutato la prenotazione' });
    }
    console.log(`[booking/create] New booking #${data.id} — ${firstName} ${lastName} — apt ${apartmentId} — ${arrival}→${departure}`);
    res.json({ ok: true, reservationId: data.id });
  } catch (e) {
    console.error('[booking/create]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Houzly server running on port ${PORT}`);
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    console.log('[MongoDB] Connected successfully');
  } catch (e) {
    console.error('[MongoDB] Connection FAILED:', e.message);
  }
});
