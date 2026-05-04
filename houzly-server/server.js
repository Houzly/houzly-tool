const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const { MongoClient } = require('mongodb');
// ── Check-in module dependencies ──────────────────────────────────
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');
const { runSeed: runOnboardingSeed } = require('./onboarding/seed');
const { createOnboardingRouter } = require('./onboarding/routes');

// R2 client (S3-compatible)
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'houzly-guest-documents';

// Resend client (email fallback for direct bookings)
const resend = new Resend(process.env.RESEND_API_KEY);

// Anthropic client (OCR Claude Vision — used in Phase 1B)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// JWT config
const JWT_SECRET = process.env.JWT_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://houzly-tool.onrender.com';

// Smoobu channel IDs
const SMOOBU_CHANNEL_DIRECT = 4090393;  // "Direct booking" — houzly.it booking engine

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
// ── Check-in helpers ──────────────────────────────────────────────

function generateCheckinToken(bookingId, checkoutDate) {
  const checkout = new Date(checkoutDate);
  const expiresAt = new Date(checkout.getTime() + 7 * 24 * 60 * 60 * 1000);
  const token = jwt.sign(
    { bookingId, exp: Math.floor(expiresAt.getTime() / 1000) },
    JWT_SECRET
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

function verifyCheckinToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

function calculateNights(arrival, departure) {
  const a = new Date(arrival);
  const d = new Date(departure);
  return Math.round((d - a) / (24 * 60 * 60 * 1000));
}

function inferRegion(propertyName) {
  if (!propertyName) return null;
  const name = propertyName.toLowerCase();
  if (/firenze|florence|prato|pistoia/i.test(name)) return 'tuscany_turismo5';
  if (/sardegna|sardinia|porto|alghero|olbia|cagliari|sassari|nuoro/i.test(name)) return 'sardinia_ross1000';
  return 'tuscany_motourist';
}

async function r2Upload(key, body, contentType = 'image/jpeg') {
  await r2Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: body, ContentType: contentType,
  }));
  return { key, bucket: R2_BUCKET };
}

async function r2GetSignedUrl(key, expiresInSec = 3600) {
  const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  return await getSignedUrl(r2Client, command, { expiresIn: expiresInSec });
}

async function r2Delete(key) {
  await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

async function sendSmoobuChatMessage(reservationId, messageText) {
  try {
    const r = await fetch(`https://login.smoobu.com/api/reservations/${reservationId}/messages`, {
      method: 'POST',
      headers: { 'Api-Key': process.env.SMOOBU_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Online Check-in', message: messageText, emailAddress: null }),
    });
    if (!r.ok) { const text = await r.text(); return { success: false, error: `Smoobu ${r.status}: ${text}` }; }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

async function sendEmailFallback(toEmail, subject, html) {
  try {
    const result = await resend.emails.send({
      from: 'Houzly Check-in <checkin@houzly.it>',
      to: toEmail, subject, html,
    });
    return { success: true, id: result.data?.id };
  } catch (e) { return { success: false, error: e.message }; }
}

function buildInitialMessage({ guestFirstName, propertyName, checkinDate, checkoutDate, checkinLink, guestLang }) {
  const isItalian = (guestLang || '').toLowerCase().startsWith('it');
  if (isItalian) {
    return `Buongiorno ${guestFirstName}, benvenuto in Houzly!

Grazie per aver prenotato ${propertyName}. Non vediamo l'ora di ospitarla dal ${checkinDate} al ${checkoutDate}.

La legge italiana ci obbliga a registrare tutti gli ospiti presso le autorità locali prima dell'arrivo. Per rendere la procedura semplice e veloce, può completare il check-in online qui:

→ ${checkinLink}

Richiede circa 3 minuti per ospite. Servirà una foto del documento d'identità o passaporto di ciascun ospite. Tutti i dati vengono trasmessi in modo sicuro e utilizzati esclusivamente per la registrazione prevista dalla legge.

Per qualsiasi domanda, risponda pure a questo messaggio.

A presto in Toscana,
Il Team Houzly`;
  }
  return `Hello ${guestFirstName}, and welcome to Houzly!

Thank you for booking ${propertyName}. We're looking forward to hosting you from ${checkinDate} to ${checkoutDate}.

Italian law requires us to register all guests with local authorities before arrival. To make this quick and easy, please complete your online check-in here:

→ ${checkinLink}

It takes about 3 minutes per guest. You'll just need a photo of each guest's ID or passport. All data is transmitted securely and used only for the legally required registration.

If you have any questions, just reply to this message.

See you soon in Tuscany,
The Houzly Team`;
}

function buildReminderD3({ guestFirstName, propertyName, checkinLink, guestLang }) {
  const isItalian = (guestLang || '').toLowerCase().startsWith('it');
  if (isItalian) {
    return `Salve ${guestFirstName}, un piccolo promemoria: il suo soggiorno a ${propertyName} inizia tra 3 giorni.

Se non l'ha ancora fatto, può completare il check-in online qui: ${checkinLink}

È richiesto dalla legge italiana e ci permette di accoglierla senza intoppi al suo arrivo. Bastano pochi minuti.

Grazie!`;
  }
  return `Hi ${guestFirstName}, just a friendly reminder that your stay at ${propertyName} begins in 3 days.

If you haven't yet, please complete the online check-in here: ${checkinLink}

This is required by Italian law and helps us welcome you smoothly on arrival day. It only takes a few minutes.

Thank you!`;
}

function buildReminderD1({ guestFirstName, checkinLink, guestLang }) {
  const isItalian = (guestLang || '').toLowerCase().startsWith('it');
  if (isItalian) {
    return `Salve ${guestFirstName}, domani la aspettiamo!

Per cortesia completi il check-in online prima dell'arrivo, altrimenti dovremo raccogliere i documenti di persona e questo potrebbe rallentare la sua sistemazione: ${checkinLink}

Grazie e buon viaggio!`;
  }
  return `Hi ${guestFirstName}, we're almost ready to welcome you tomorrow!

Please complete your online check-in before arrival, otherwise we'll need to collect documents in person which can slow down your arrival: ${checkinLink}

Thank you, and safe travels!`;
}

app.use(express.json({ limit: "20mb" }));
app.use("/api/booking", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
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

// ── Smoobu Full Sync (server-side merge + delete) ───────────────
//  POST /api/smoobu/sync
//  Body: { months: 3 }   (optional, default 3)
//  Legge apiKey da db.cleaning.apiKey
//  1. Scarica tutte le prenotazioni attive da Smoobu (paginazione)
//  2. Rimuove i task con smoobu_id non più presente (cancellati)
//  3. Aggiorna/aggiunge i task esistenti (preserva cleaner/status/notes/checklist/date_override)
//  4. Salva su MongoDB e restituisce { ok, added, updated, removed }
app.post('/api/smoobu/sync', async (req, res) => {
  try {
    const col = await getCollection('db');
    const doc = await col.findOne({ _id: 'main' });
    if (!doc) return res.status(404).json({ ok: false, error: 'db_not_found' });

    const { _id, ...db } = doc;
    if (!db.cleaning) db.cleaning = { tasks: [], defaultChecklist: [], apiKey: '', lastSync: null };
    if (!db.cleaning.tasks) db.cleaning.tasks = [];

    const apiKey = req.body?.apiKey || db.cleaning.apiKey || '';
    if (!apiKey) return res.status(400).json({ ok: false, error: 'missing_api_key' });

    // Finestra temporale — scarica 60 giorni indietro + N mesi avanti
    // (60gg indietro per non perdere task recenti ancora in lavorazione)
    const months  = parseInt(req.body?.months || db.cleaning.syncMonths || 3);
    const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - 60);
    const toDate   = new Date(); toDate.setMonth(toDate.getMonth() + months);
    const fromISO  = fromDate.toISOString().split('T')[0];
    const toISO    = toDate.toISOString().split('T')[0];
    const todayISO = new Date().toISOString().split('T')[0];

    // Scarica tutte le pagine da Smoobu
    let allReservations = [];
    let page = 1;
    const MAX_PAGES = 20;
    while (page <= MAX_PAGES) {
      // departureFrom: forza Smoobu a includere prenotazioni con checkout >= fromISO
      const url = `https://login.smoobu.com/api/reservations?pageSize=100&page=${page}&departureFrom=${fromISO}`;
      const r = await fetch(url, { headers: { 'Api-Key': apiKey, 'Cache-Control': 'no-cache' } });
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({ ok: false, error: `Smoobu ${r.status}`, detail: text });
      }
      const data = await r.json();
      const items = (data._embedded && data._embedded.bookings) || data.bookings || data.reservations || [];
      if (items.length === 0) break;
      allReservations = allReservations.concat(items);
      const totalPages = data.page_count || data.total_pages || data.pages || 1;
      if (page >= totalPages) break;
      page++;
    }

    // Filtra: no blocked, solo nella finestra temporale
    const relevant = allReservations.filter(b => {
      if (b['is-blocked-booking']) return false;
      const checkout = (b.departure || '').split('T')[0];
      return checkout >= fromISO && checkout <= toISO;
    });

    // Rimozione task: MAI durante il sync.
    // I task vengono rimossi SOLO via webhook cancelledReservation (già gestito sotto).
    // Il sync aggiunge nuovi task e aggiorna quelli esistenti — nient'altro.
    const removed = 0;

    // 2. Merge: aggiorna esistenti, aggiungi nuovi
    let added = 0, updated = 0;
    relevant.forEach(b => {
      const bookingId    = String(b.id || '');
      const checkout     = (b.departure || '').split('T')[0];
      const checkin      = (b.arrival   || '').split('T')[0];
      const checkoutTime = b['check-out'] || '10:00';
      const checkinTime  = b['check-in']  || '15:00';
      const propName     = b.apartment?.name || b.apartmentName || 'N/D';
      const propId       = b.apartment?.id ? String(b.apartment.id) : null;

      const idx = db.cleaning.tasks.findIndex(t => t.smoobu_id === bookingId);
      if (idx >= 0) {
        // Aggiorna solo campi Smoobu — preserva TUTTO il resto incluso date_override
        const ex = db.cleaning.tasks[idx];
        db.cleaning.tasks[idx] = {
          ...ex,
          date:          checkout,          // aggiorna data originale Smoobu
          checkin_date:  checkin,
          checkout_time: checkoutTime,
          checkin_time:  checkinTime,
          prop_name:     propName,
          prop_id:       propId,
          // date_override, cleaner, status, notes, checklist: preservati da spread
        };
        updated++;
      } else {
        const defaultCL = (db.cleaning.defaultChecklist || []).map(l =>
          typeof l === 'string' ? { label: l, done: false } : { ...l, done: false }
        );
        db.cleaning.tasks.push({
          id:            `cl_${bookingId}_${Date.now()}`,
          smoobu_id:     bookingId,
          prop_name:     propName,
          prop_id:       propId,
          date:          checkout,
          date_override: null,
          checkin_date:  checkin,
          checkout_time: checkoutTime,
          checkin_time:  checkinTime,
          cleaner:       null,
          notes:         '',
          checklist:     defaultCL,
          status:        'todo',
          created:       new Date().toISOString(),
        });
        added++;
      }
    });

    db.cleaning.lastSync = new Date().toISOString();
    await col.replaceOne({ _id: 'main' }, { _id: 'main', ...db }, { upsert: true });

    console.log(`[smoobu/sync] added:${added} updated:${updated} removed:${removed}`);
    res.json({ ok: true, added, updated, removed, total: relevant.length });

  } catch (e) {
    console.error('[smoobu/sync]', e.message);
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
          label: typeof item === 'string' ? item : (item.label || item.text || ''), done: false
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
// Verifica disponibilità usando rates API + aggiunge costo pulizie da apartment details.
// Body: { apartmentId, arrival: "YYYY-MM-DD", departure: "YYYY-MM-DD", guests }
// Risposta: { ok, available, price, nights, cleaningFee }
app.post('/api/booking/availability', bookingCors, async (req, res) => {
  const { apartmentId, arrival, departure } = req.body || {};
  if (!apartmentId || !arrival || !departure) {
    return res.status(400).json({ ok: false, error: 'Campi obbligatori: apartmentId, arrival, departure' });
  }
  try {
    // Chiamate parallele: rates + apartment details (per costo pulizie)
    const [ratesResp, aptResp] = await Promise.all([
      fetch(`https://login.smoobu.com/api/rates?apartments[]=${apartmentId}&start_date=${arrival}&end_date=${departure}`, { headers: smoobuHdr() }),
      fetch(`https://login.smoobu.com/api/apartments/${apartmentId}`, { headers: smoobuHdr() })
    ]);

    const ratesText = await ratesResp.text();
    let ratesData;
    try { ratesData = JSON.parse(ratesText); } catch(e) {
      return res.status(500).json({ ok: false, error: 'Smoobu risposta rates non valida' });
    }

    const aptDays = ratesData && ratesData.data && ratesData.data[apartmentId];
    if (!aptDays) {
      console.error('[booking/availability] no days data:', JSON.stringify(ratesData).slice(0, 300));
      return res.status(404).json({ ok: false, error: 'Dati non trovati per questo appartamento' });
    }

    // Costo pulizie dall'apartment details
    let cleaningFee = 0;
    try {
      const aptData = await aptResp.json();
      console.log('[booking/availability] apartment keys:', JSON.stringify(Object.keys(aptData)));
      console.log('[booking/availability] apartment data:', JSON.stringify(aptData).slice(0, 500));
      cleaningFee = aptData.cleaningFee || aptData.cleaning_fee || aptData['cleaning-fee'] || 
                    aptData.extra_costs || aptData.extraCosts || 0;
      console.log('[booking/availability] cleaningFee:', cleaningFee);
    } catch(e) {
      console.log('[booking/availability] could not get cleaning fee:', e.message);
    }

    // Calcola notti e verifica disponibilità
    const arrDate = new Date(arrival);
    const depDate = new Date(departure);
    const nights  = Math.round((depDate - arrDate) / 86400000);
    let available = true, totalPrice = 0, minStay = 1, blocked = false;
    for (let i = 0; i < nights; i++) {
      const d = new Date(arrDate); d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      const dayData = aptDays[dateStr];
      if (!dayData || dayData.available === 0) { available = false; blocked = true; break; }
      totalPrice += dayData.price || 0;
      if (i === 0 && dayData.min_length_of_stay) minStay = dayData.min_length_of_stay;
    }
    // Se i giorni sono tutti liberi ma sotto il min-stay: non disponibile per min-stay
    let minStayFail = false;
    if (available && nights < minStay) {
      available = false;
      minStayFail = true;
    }

    const finalPrice = available ? Math.round(totalPrice + cleaningFee) : null;

    // reason: 'min_stay' se bloccato solo per min-stay, 'blocked' se c'è un giorno occupato, null se disponibile
    const reason = blocked ? 'blocked' : (minStayFail ? 'min_stay' : null);

    res.json({
      ok: true,
      available,
      nights,
      price: finalPrice,
      cleaningFee: Math.round(cleaningFee),
      reason,
      minStay
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
  const aptId = parseInt(apartmentId, 10);
  console.log('[booking/create] apartmentId raw:', apartmentId, '→ parsed:', aptId);
  if (!aptId) return res.status(400).json({ ok: false, error: 'apartmentId non valido' });
  try {
    const payload = {
      apartmentId: aptId,
      arrivalDate: arrival,
      departureDate: departure,
      firstName, lastName,
      email,
      adults: parseInt(adults) || 1,
      channelId: 4090393
    };
    if (phone) payload.phone  = phone;
    if (note)  payload.notice = note;

    console.log('[booking/create] payload to Smoobu:', JSON.stringify(payload));
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

// ══════════════════════════════════════════════════════════════════
// ── Cloudinary Proxy (Admin API — list folder assets) ────────────
//
//  Risolve il problema CORS dell'Admin API Cloudinary, che non può
//  essere chiamata direttamente da browser.
//
//  Usata dal Photo Studio per sincronizzare l'array `photos[]` del
//  sito con la Media Library di Cloudinary.
//
//  Richiede CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET nelle Environment
//  Variables di Render.
//  Le credenziali si trovano su:
//  https://console.cloudinary.com/settings/api-keys
//
//  Protetta da requireAdminAuth (header X-Admin-PIN o ?pin=...).
//  CORS aperto per tutti i client (idem booking engine).
// ══════════════════════════════════════════════════════════════════

const CLOUDINARY_API_KEY    = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'dhhwuufhw';

// Middleware CORS aperto (come bookingCors)
function cloudinaryCors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-PIN");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

// ── GET /api/cloudinary/list-folder ──────────────────────────────
//
// Lista gli asset in una cartella della Media Library Cloudinary.
//
// Query: ?folder=houzly-site/casa-panorama  (obbligatorio)
//        ?max=100                             (opzionale, default 100, max 500)
// Auth:  X-Admin-PIN: <pin>  (header)  oppure ?pin=<pin>
//
// Risposta:
//   { ok: true, folder, assets: [
//       { publicId, version, format, bytes, width, height, secureUrl,
//         optimizedUrl, createdAt }
//     ]
//   }
//
// L'optimizedUrl include `q_auto,f_auto` per coerenza col sito.
//
app.get('/api/cloudinary/list-folder', cloudinaryCors, requireAdminAuth, async (req, res) => {
  try {
    const folder = req.query.folder;
    const maxResults = Math.min(parseInt(req.query.max || '100', 10), 500);

    if (!folder) {
      return res.status(400).json({ ok: false, error: 'missing_folder' });
    }
    if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return res.status(500).json({
        ok: false,
        error: 'cloudinary_credentials_not_configured',
        hint: 'Set CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET on Render env vars',
      });
    }

    // Endpoint Admin API — funziona sia per fixed che dynamic folders
    // Tentiamo prima by_asset_folder (dynamic folders); fallback by_folder.
    const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
    const headers = { 'Authorization': `Basic ${auth}` };

    let resources = [];
    let endpointUsed = null;

    // 1. Prova endpoint dynamic folders
    const tryDynamicFolders = async () => {
      const list = [];
      let cursor = null;
      do {
        const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/by_asset_folder` +
                    `?asset_folder=${encodeURIComponent(folder)}&max_results=100` +
                    (cursor ? `&next_cursor=${encodeURIComponent(cursor)}` : '');
        const r = await fetch(url, { headers });
        if (!r.ok) {
          const txt = await r.text();
          throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
        }
        const data = await r.json();
        list.push(...(data.resources || []));
        cursor = data.next_cursor || null;
      } while (cursor && list.length < maxResults);
      return list;
    };

    // 2. Fallback endpoint fixed folders
    const tryFixedFolders = async () => {
      const list = [];
      let cursor = null;
      do {
        const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/by_folder` +
                    `?folder=${encodeURIComponent(folder)}&max_results=100` +
                    (cursor ? `&next_cursor=${encodeURIComponent(cursor)}` : '');
        const r = await fetch(url, { headers });
        if (!r.ok) {
          const txt = await r.text();
          throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
        }
        const data = await r.json();
        list.push(...(data.resources || []));
        cursor = data.next_cursor || null;
      } while (cursor && list.length < maxResults);
      return list;
    };

    // 3. Prefix-based search (universal fallback — public_id starts with folder/)
    const trySearch = async () => {
      const list = [];
      const prefix = folder.endsWith('/') ? folder : folder + '/';
      let cursor = null;
      do {
        const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/image` +
                    `?type=upload&prefix=${encodeURIComponent(prefix)}&max_results=100` +
                    (cursor ? `&next_cursor=${encodeURIComponent(cursor)}` : '');
        const r = await fetch(url, { headers });
        if (!r.ok) {
          const txt = await r.text();
          throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
        }
        const data = await r.json();
        list.push(...(data.resources || []));
        cursor = data.next_cursor || null;
      } while (cursor && list.length < maxResults);
      return list;
    };

    try {
      resources = await tryDynamicFolders();
      endpointUsed = 'by_asset_folder';
    } catch (e1) {
      console.warn(`[cloudinary/list-folder] by_asset_folder failed: ${e1.message}, trying by_folder…`);
      try {
        resources = await tryFixedFolders();
        endpointUsed = 'by_folder';
      } catch (e2) {
        console.warn(`[cloudinary/list-folder] by_folder failed: ${e2.message}, trying prefix search…`);
        resources = await trySearch();
        endpointUsed = 'prefix_search';
      }
    }

    // Mappa in formato consistente per il client
    const assets = resources.slice(0, maxResults).map(r => ({
      publicId:     r.public_id,
      version:      r.version,
      format:       r.format,
      bytes:        r.bytes,
      width:        r.width,
      height:       r.height,
      secureUrl:    r.secure_url,
      optimizedUrl: `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/q_auto,f_auto/v${r.version}/${r.public_id}.${r.format}`,
      createdAt:    r.created_at,
      assetFolder:  r.asset_folder || null,
    }));

    console.log(`[cloudinary/list-folder] ${folder}: ${assets.length} assets via ${endpointUsed}`);
    res.json({ ok: true, folder, count: assets.length, endpointUsed, assets });

  } catch (e) {
    console.error('[cloudinary/list-folder]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────

// ── Reset checklist su tutti i task (one-shot) ───────────────────
// GET /api/cleaning/reset-checklist
// Sostituisce la checklist su TUTTI i task con quella di default corrente
app.get('/api/cleaning/reset-checklist', async (req, res) => {
  try {
    const col = await getCollection('db');
    const doc = await col.findOne({ _id: 'main' });
    if (!doc) return res.status(404).json({ ok: false, error: 'db_not_found' });

    const { _id, ...db } = doc;
    if (!db.cleaning || !db.cleaning.tasks) return res.json({ ok: true, updated: 0 });

    // Checklist canonica — aggiorna anche db.cleaning.defaultChecklist
    const CANONICAL_CHECKLIST = [
      '🔍 Check Danni Proprietà',
      '🍳 Cucina — Stoviglie, Pentole e Moka',
      '🍳 Cucina — Frigo e Freezer',
      '🍳 Cucina — Lavastoviglie',
      '🍳 Cucina — Forno',
      '🍳 Cucina — Consumabili (Olio, Sale, Zucchero, Pastiglia/Sapone, Spugna)',
      '🍳 Cucina — Asciughino',
      '🚿 Bagni — Doccia (calcare)',
      '🚿 Bagni — Carta igienica',
      '🛏 Camere — Cassetti',
      '🧺 Biancheria',
      '🌿 Area Esterna',
    ];
    db.cleaning.defaultChecklist = CANONICAL_CHECKLIST;
    const defaultCL = CANONICAL_CHECKLIST;

    let updated = 0;
    db.cleaning.tasks.forEach(t => {
      if (t.status === 'done') return; // completati: non toccare
      t.checklist = defaultCL.map(l => ({ label: l, done: false }));
      updated++;
    });

    await col.replaceOne({ _id: 'main' }, { _id: 'main', ...db }, { upsert: true });
    console.log(`[reset-checklist] updated ${updated} tasks`);
    res.json({ ok: true, updated, message: `Checklist resettata su ${updated} task` });
  } catch (e) {
    console.error('[reset-checklist]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// ══════════════════════════════════════════════════════════════════
// ── Check-in: Property Configuration ──────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function requireAdminAuth(req, res, next) {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (!pin) return res.status(401).json({ ok: false, error: 'missing_pin' });
  try {
    const col = await getCollection('auth');
    const auth = await col.findOne({ _id: 'auth' });
    if (!auth || !auth.hash) return res.status(401).json({ ok: false, error: 'no_auth_configured' });
    const hash = crypto.createHash('sha256').update(pin).digest('hex');
    if (hash !== auth.hash) return res.status(401).json({ ok: false, error: 'invalid_pin' });
    next();
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

app.get('/api/checkin/properties', requireAdminAuth, async (req, res) => {
  try {
    const col = await getCollection('checkin_properties_config');
    const list = await col.find({}).sort({ name: 1 }).toArray();
    res.json({ ok: true, properties: list });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/checkin/properties/sync', requireAdminAuth, async (req, res) => {
  try {
    const r = await fetch('https://login.smoobu.com/api/apartments', {
      headers: { 'Api-Key': process.env.SMOOBU_API_KEY, 'Cache-Control': 'no-cache' },
    });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: `Smoobu ${r.status}` });
    const data = await r.json();
    let apartments = [];
    if (Array.isArray(data)) apartments = data;
    else if (Array.isArray(data.apartments)) apartments = data.apartments;
    else if (Array.isArray(data.data)) apartments = data.data;

    const col = await getCollection('checkin_properties_config');
    let added = 0, existing = 0;
    const addedList = [];

    for (const apt of apartments) {
      const id = `prop_${apt.id}`;
      const existingDoc = await col.findOne({ _id: id });
      if (existingDoc) { existing++; continue; }
      const inferredRegion = inferRegion(apt.name);
      const newDoc = {
        _id: id,
        smoobu_apartment_id: String(apt.id),
        prop_code: null,
        name: apt.name || 'Unnamed',
        city: null,
        region: inferredRegion,
        region_inferred: true,
        checkin_required: false,
        onboarding_checklist: {
          alloggiati_credentials_ok: false,
          motourist_credentials_ok: false,
          turismo5_credentials_ok: false,
          firenze_ids_registered: false,
          ross1000_credentials_ok: false,
          sardinia_tourist_tax_configured: false,
          airbnb_city_tax_active: false,
          booking_city_tax_active: false,
          direct_booking_engine_city_tax_active: false,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await col.insertOne(newDoc);
      added++;
      addedList.push({ id: apt.id, name: apt.name, inferredRegion });
    }

    res.json({ ok: true, added, existing, total: apartments.length, addedList });
  } catch (e) {
    console.error('[checkin/properties/sync]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/checkin/properties/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    const allowed = ['prop_code', 'city', 'region', 'checkin_required', 'onboarding_checklist', 'region_inferred'];
    const toSet = {};
    for (const k of allowed) { if (k in updates) toSet[k] = updates[k]; }
    toSet.updated_at = new Date().toISOString();

    const col = await getCollection('checkin_properties_config');
    const result = await col.updateOne({ _id: id }, { $set: toSet });
    if (result.matchedCount === 0) return res.status(404).json({ ok: false, error: 'property_not_found' });
    const updated = await col.findOne({ _id: id });
    res.json({ ok: true, property: updated });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ── Onboarding: Seed catalog (admin) ──────────────────────────────
// ══════════════════════════════════════════════════════════════════

app.post('/api/onboarding/seed', requireAdminAuth, async (req, res) => {
  try {
    const { forceUpsert = false, dryRun = false } = req.body || {};
    const db = await getDb();
    const result = await runOnboardingSeed(db, { forceUpsert, dryRun });
    console.log('[Onboarding seed]', result.log.join(' | '));
    res.json(result);
  } catch (e) {
    console.error('[Onboarding seed] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Tutti gli altri endpoint dell'onboarding vivono in onboarding/routes.js,
// montati qui sotto requireAdminAuth (l'auth si applica a tutto il router).

// Eccezione: cron-tick è chiamato da un servizio esterno (cron-job.org),
// non conosce il PIN admin. Si protegge con un shared secret in env var.
app.post('/api/onboarding/cron-tick', async (req, res) => {
  try {
    const secret = process.env.CRON_SECRET;
    const provided = req.headers['x-cron-secret'] || req.query.secret;
    if (!secret) return res.status(500).json({ ok: false, error: 'cron_secret_not_configured' });
    if (provided !== secret) return res.status(401).json({ ok: false, error: 'invalid_cron_secret' });

    const { runNotificationsTick } = require('./onboarding/notifications');
    const db = await getDb();
    const dryRun = req.query.dryRun === '1' || (req.body && req.body.dryRun === true);
    const forceBriefing = req.query.forceBriefing === '1' || (req.body && req.body.forceBriefing === true);

    const result = await runNotificationsTick(db, resend, {
      recipients: ['info@houzly.it'],
      from: process.env.RESEND_FROM || 'Houzly Onboarding <onboarding@houzly.it>',
      dryRun,
      forceBriefing,
    });

    console.log(`[onboarding/cron-tick] briefing=${result.briefingSent} overdueAlerts=${result.overdueAlertsSent} errors=${result.errors.length}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[onboarding/cron-tick]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use('/api/onboarding', requireAdminAuth, createOnboardingRouter(getDb));

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
