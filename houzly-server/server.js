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

function validateTaxCode(cf) {
  if (!cf || typeof cf !== 'string') return false;
  const upperCF = cf.toUpperCase().trim();
  if (upperCF.length !== 16) return false;
  // Pattern: 6 lettere, 2 cifre, 1 lettera, 2 cifre, 1 lettera, 3 alfanumerici, 1 lettera
  if (!/^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9A-Z]{3}[A-Z]$/.test(upperCF)) return false;
  // Checksum algoritmo Agenzia delle Entrate
  const oddMap = { '0':1,'1':0,'2':5,'3':7,'4':9,'5':13,'6':15,'7':17,'8':19,'9':21,
    'A':1,'B':0,'C':5,'D':7,'E':9,'F':13,'G':15,'H':17,'I':19,'J':21,'K':2,'L':4,'M':18,
    'N':20,'O':11,'P':3,'Q':6,'R':8,'S':12,'T':14,'U':16,'V':10,'W':22,'X':25,'Y':24,'Z':23 };
  const evenMap = { '0':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
    'A':0,'B':1,'C':2,'D':3,'E':4,'F':5,'G':6,'H':7,'I':8,'J':9,'K':10,'L':11,'M':12,
    'N':13,'O':14,'P':15,'Q':16,'R':17,'S':18,'T':19,'U':20,'V':21,'W':22,'X':23,'Y':24,'Z':25 };
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = upperCF[i];
    sum += (i % 2 === 0) ? oddMap[ch] : evenMap[ch];
  }
  const expectedChar = String.fromCharCode(65 + (sum % 26));
  return upperCF[15] === expectedChar;
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
// ── Check-in OCR: prompt builder per tipo documento ──────────────
function buildOcrPrompt(documentType) {
  const baseSchema = `Estrai i dati dal documento e rispondi SOLO con un JSON valido (no markdown, no commenti, no testo prima/dopo) con questo schema esatto:
{
  "first_name": "stringa o null",
  "last_name": "stringa o null",
  "sex": "M oppure F oppure null",
  "date_of_birth": "YYYY-MM-DD o null",
  "place_of_birth": "stringa o null",
  "nationality": "codice ISO 3166-1 alpha-2 (es. IT, FR, DE) o null",
  "document_number": "stringa o null",
  "document_issue_date": "YYYY-MM-DD o null",
  "document_expiry_date": "YYYY-MM-DD o null",
  "document_issue_country": "codice ISO 3166-1 alpha-2 o null",
  "tax_code": "stringa di 16 caratteri (codice fiscale italiano) o null",
  "address_street": "via e numero civico o null",
  "address_zip": "CAP o null",
  "address_city": "comune o null",
  "address_province": "sigla 2 lettere provincia italiana o null",
  "address_country": "codice ISO 3166-1 alpha-2 o null",
  "confidence": "numero decimale da 0 a 1 che indica la tua confidenza media nell'estrazione",
  "warnings": ["array di stringhe con eventuali avvisi (es. 'foto sfocata', 'campo parzialmente coperto')"]
}

Regole importanti:
- Se un campo non è visibile o leggibile, usa null (mai stringhe vuote o placeholder).
- Date sempre in formato ISO YYYY-MM-DD.
- Codici nazione e provincia sempre in maiuscolo.
- Il sesso (sex) deduci da nome/foto/dati nel documento, se non chiaro metti null.
- Rispondi SOLO con il JSON. Nessun altro testo.`;

  if (documentType === 'CIE') {
    return `Hai ricevuto la foto fronte e retro di una Carta d'Identità Elettronica italiana (CIE).
Sul fronte trovi: nome, cognome, data e luogo di nascita, sesso, scadenza, foto.
Sul retro trovi: codice fiscale (testo + barcode), indirizzo di residenza completo (via, civico, CAP, comune, provincia), ente di rilascio.

${baseSchema}`;
  }

  if (documentType === 'PAPER_ID') {
    return `Hai ricevuto la foto fronte e retro di una Carta d'Identità cartacea italiana (formato vecchio, non elettronica).
Sul fronte trovi: nome, cognome, data e luogo di nascita, sesso, foto.
Sul retro trovi: indirizzo di residenza, ente di rilascio, data rilascio/scadenza.
IMPORTANTE: questo tipo di documento NON contiene il codice fiscale. Lascia tax_code a null.

${baseSchema}`;
  }

  if (documentType === 'DRIVING_LICENSE') {
    return `Hai ricevuto la foto della patente di guida italiana (formato carta di credito).
Sul fronte trovi: nome, cognome, data e luogo di nascita, numero patente, data rilascio, scadenza, foto.
IMPORTANTE: la patente italiana NON contiene il codice fiscale né l'indirizzo di residenza. Lascia tax_code, address_* a null.

${baseSchema}`;
  }

  if (documentType === 'PASSPORT') {
    return `Hai ricevuto la foto della pagina principale di un passaporto.
Estrai: nome, cognome, data e luogo di nascita, sesso, nazionalità, numero passaporto, data rilascio e scadenza, paese di rilascio.
IMPORTANTE: il passaporto NON contiene codice fiscale né indirizzo di residenza. Lascia tax_code, address_* a null.

${baseSchema}`;
  }

  // Fallback generico se documentType non riconosciuto
  return `Hai ricevuto la foto di un documento d'identità. Estrai tutti i dati visibili.

${baseSchema}`;
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

// ── Smoobu Webhook (Cleaning + Check-in) ─────────────────────────
app.post('/api/smoobu/webhook', async (req, res) => {
  try {
    const event = req.body;
    console.log('[Smoobu Webhook]', event.action, event.data?.id);

    const b = event.data || event;
    const action = event.action || '';
    const bookingId = String(b.id || b.reservationId || '');

    // ──────────────────────────────────────────────────────────────
    // PARTE 1: CLEANING (logica esistente preservata 1:1)
    // ──────────────────────────────────────────────────────────────
    const col = await getCollection('db');
    const doc = await col.findOne({ _id: 'main' });
    if (doc) {
      const { _id, ...db } = doc;
      if (!db.cleaning) db.cleaning = { tasks: [], cleaners: [], defaultChecklist: [], apiKey: '', lastSync: null };

      if (b['is-blocked-booking'] !== true) {
        const checkout     = (b.departure || '').split('T')[0];
        const checkin      = (b.arrival   || '').split('T')[0];
        const checkoutTime = b['check-out'] || '10:00';
        const checkinTime  = b['check-in']  || '15:00';
        const propName     = (b.apartment?.name || b.apartmentName || 'N/D');
        const propId       = b.apartment?.id ? String(b.apartment.id) : null;

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
            const defaultCL = (db.cleaning.defaultChecklist || []).map((item) => ({
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
      }
    }

    // ──────────────────────────────────────────────────────────────
    // PARTE 2: CHECK-IN (nuova logica)
    // ──────────────────────────────────────────────────────────────
    // I blocchi puri (manutenzione/chiusura) saltano completamente il check-in
    if (b['is-blocked-booking'] === true) {
      return res.json({ ok: true, skipped: 'blocked_booking' });
    }

    // Wrap in try separato per evitare che errori nel check-in
    // rompano la risposta del webhook (cleaning è già stato salvato sopra)
    let checkinResult = null;
    try {
      checkinResult = await upsertCheckinSession(b, action);
      console.log('[Check-in]', bookingId, '→', checkinResult.action, checkinResult.status || '');
    } catch (checkinError) {
      console.error('[Check-in] error:', checkinError.message);
      checkinResult = { ok: false, error: checkinError.message };
    }

    res.json({ ok: true, checkin: checkinResult });
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
// OPTIONS preflight — required because browsers send a preflight when custom
// headers (like X-Admin-PIN) are used. Without this, the browser blocks the
// actual GET request before it even reaches the auth middleware.
app.options('/api/cloudinary/list-folder', cloudinaryCors, (req, res) => {
  res.sendStatus(204);
});

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
// ── Check-in: Booking evaluation ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function evaluateBooking(booking) {
  const arrival = (booking.arrival || '').split('T')[0];
  const departure = (booking.departure || '').split('T')[0];
  const nights = calculateNights(arrival, departure);

  // Regola 1: durata > 540 giorni → locazione ordinaria, fuori perimetro
  if (nights > 540) {
    return { status: 'excluded_long_term', reason: `Duration ${nights} nights exceeds 540`, nights };
  }

  // Regola 2: durata > 30 giorni → locazione transitoria, decisione manuale
  if (nights > 30) {
    return { status: 'long_stay_review', reason: `Duration ${nights} nights > 30 (non-tourist lease)`, nights };
  }

  // Regola 3: nome ospite vuoto → blocco manutenzione/chiusura
  const firstName = (booking['first-name'] || '').trim();
  const lastName = (booking['last-name'] || '').trim();
  if (!firstName && !lastName) {
    return { status: 'excluded_block', reason: 'No guest name (maintenance/closure block)', nights };
  }

  // Regola 4: note contengono [INTERNAL] → cash off-the-books / familiari
  const notice = (booking.notice || '').toLowerCase();
  if (notice.includes('[internal]')) {
    return { status: 'excluded_internal', reason: 'Marked as [INTERNAL] in Smoobu notice', nights };
  }

  // Regola 5: property disabilitata → onboarding incompleto o esclusa
  const apartmentId = booking.apartment?.id ? String(booking.apartment.id) : null;
  if (!apartmentId) {
    return { status: 'needs_review', reason: 'Missing apartment ID', nights };
  }
  const propCol = await getCollection('checkin_properties_config');
  const propConfig = await propCol.findOne({ _id: `prop_${apartmentId}` });
  if (!propConfig) {
    return { status: 'needs_review', reason: 'Property not configured (run properties/sync)', nights };
  }
  if (!propConfig.checkin_required) {
    return { status: 'excluded_property_disabled', reason: 'Property has checkin_required=false', nights };
  }

  // Regola 6: safety net
  const guestEmail = (booking.email || '').toLowerCase();
  const fullName = `${firstName} ${lastName}`.toLowerCase();
  const suspiciousKeywords = ['maintenance', 'manutenzione', 'blocco', 'chiusura', 'owner stay', 'test', 'houzly', 'carella', 'ruberti'];
  const internalEmails = []; // aggiungi qui tue email personali se vuoi protezione
  const hasSuspiciousName = suspiciousKeywords.some(k => fullName.includes(k));
  const hasInternalEmail = internalEmails.includes(guestEmail);
  if (hasSuspiciousName || hasInternalEmail) {
    return { status: 'needs_review', reason: 'Suspicious name or internal email (possible forgotten [INTERNAL] marker)', nights };
  }

  // Regola 7: tutto ok → flusso normale
  return { status: 'pending', reason: null, nights, propConfig };
}

async function upsertCheckinSession(booking, action = 'newReservation') {
  const bookingId = String(booking.id || booking.reservationId || '');
  if (!bookingId) return { ok: false, error: 'missing_booking_id' };

  const sessionsCol = await getCollection('checkin_sessions');
  const sessionId = `booking_${bookingId}`;
  const existing = await sessionsCol.findOne({ _id: sessionId });

  // Cancellazione
  if (action === 'cancelledReservation') {
    if (existing) {
      await sessionsCol.deleteOne({ _id: sessionId });
    }
    return { ok: true, action: 'deleted' };
  }

  // Valuta stato
  const evaluation = await evaluateBooking(booking);

  // Costruisci snapshot booking
  const arrival = (booking.arrival || '').split('T')[0];
  const departure = (booking.departure || '').split('T')[0];
  const firstName = (booking['first-name'] || '').trim();
  const lastName = (booking['last-name'] || '').trim();
  const adults = parseInt(booking.adults) || 1;
  const children = parseInt(booking.children) || 0;
  const totalGuests = adults + children;

  const apartmentId = booking.apartment?.id ? String(booking.apartment.id) : null;
  const propertyName = booking.apartment?.name || booking.apartmentName || 'N/D';

  const bookingSnapshot = {
    channel_id: booking.channel?.id || null,
    channel_name: booking.channel?.name || null,
    primary_guest_name: `${firstName} ${lastName}`.trim() || null,
    primary_guest_email: booking.email || null,
    language: booking.language || null,
    arrival,
    departure,
    nights: evaluation.nights,
    adults,
    children,
    total_guests_expected: totalGuests,
    price_total: parseFloat(booking.price) || 0,
    notice: booking.notice || '',
  };

  const propertySnapshot = {
    smoobu_id: apartmentId,
    name: propertyName,
    prop_code: evaluation.propConfig?.prop_code || null,
    region: evaluation.propConfig?.region || null,
    city: evaluation.propConfig?.city || null,
  };

  // Token + expiry (solo per stati che richiedono link guest)
  let tokenData = null;
  if (evaluation.status === 'pending' && departure) {
    tokenData = generateCheckinToken(bookingId, departure);
  }

  if (existing) {
    // Update: preserva status workflow e guests compilati, aggiorna solo snapshot
    const updates = {
      property: propertySnapshot,
      booking: bookingSnapshot,
      updated_at: new Date().toISOString(),
    };
    // Se lo status attuale era excluded/review e la ri-valutazione dà pending, riattiva
    if (existing.status.startsWith('excluded_') && evaluation.status === 'pending') {
      updates.status = 'pending';
      updates.exclusion_reason = null;
      if (tokenData) {
        updates.access_token = tokenData.token;
        updates.token_expires_at = tokenData.expiresAt;
      }
    }
    await sessionsCol.updateOne({ _id: sessionId }, { $set: updates });
    return { ok: true, action: 'updated', status: existing.status };
  }

  // Insert nuovo
  const newSession = {
    _id: sessionId,
    smoobu_booking_id: bookingId,
    property: propertySnapshot,
    booking: bookingSnapshot,
    status: evaluation.status,
    exclusion_reason: evaluation.reason,
    access_token: tokenData?.token || null,
    token_expires_at: tokenData?.expiresAt || null,
    guests: Array.from({ length: totalGuests }, (_, i) => ({
      slot: i + 1,
      first_name: i === 0 ? firstName || null : null,
      last_name: i === 0 ? lastName || null : null,
      date_of_birth: null,
      place_of_birth: null,
      country_of_residence: null,
      nationality: null,
      document_type: null,
      document_number: null,
      document_issue_country: null,
      document_issue_date: null,
      document_expiry_date: null,
      is_minor: false,
      // Sesso (per compliance e correlazione CF)
      sex: null,
      // Codice fiscale (solo ospite slot 1 italiano)
      tax_code: null,
      tax_code_source: null,
      tax_code_verified: false,
      // Indirizzo di residenza (solo ospite slot 1 italiano)
      address_street: null,
      address_zip: null,
      address_city: null,
      address_province: null,
      address_country: null,
      address_source: null,
      // Metadata OCR
      ocr_confidence_overall: null,
      ocr_warnings: [],
      r2_front_key: null,
      r2_back_key: null,
      submitted_at: null,
      ocr_confidence: null,
      privacy_consent: false,
      privacy_consent_at: null,
    })),
    messages_sent: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    archived_at: null,
  };
  await sessionsCol.insertOne(newSession);

  // Se pending, invia subito il messaggio iniziale
  if (evaluation.status === 'pending' && tokenData) {
    await dispatchInitialMessage(newSession);
  }

  return { ok: true, action: 'created', status: evaluation.status };
}

async function dispatchInitialMessage(session) {
  const checkinLink = `${APP_BASE_URL}/checkin.html?t=${session.access_token}`;
  const messageText = buildInitialMessage({
    guestFirstName: session.booking.primary_guest_name?.split(' ')[0] || 'guest',
    propertyName: session.property.name,
    checkinDate: session.booking.arrival,
    checkoutDate: session.booking.departure,
    checkinLink,
    guestLang: session.booking.language,
  });

  const isDirectBooking = session.booking.channel_id === SMOOBU_CHANNEL_DIRECT;
  let result;
  let channel;

  if (isDirectBooking && session.booking.primary_guest_email) {
    // Direct booking → email via Resend
    const html = messageText.replace(/\n/g, '<br>');
    result = await sendEmailFallback(session.booking.primary_guest_email, 'Houzly Online Check-in', html);
    channel = 'email';
  } else {
    // OTA → chat Smoobu (rimbalza su Airbnb/Booking nativi)
    result = await sendSmoobuChatMessage(session.smoobu_booking_id, messageText);
    channel = 'smoobu_chat';
  }

  const sessionsCol = await getCollection('checkin_sessions');
  await sessionsCol.updateOne(
    { _id: session._id },
    {
      $push: {
        messages_sent: {
          type: 'initial',
          channel,
          sent_at: new Date().toISOString(),
          success: result.success,
          error: result.error || null,
        },
      },
    }
  );

  return result;
}
// ══════════════════════════════════════════════════════════════════
// ── Check-in: Guest-facing routes (JWT-protected) ─────────────────
// ══════════════════════════════════════════════════════════════════

async function requireGuestAuth(req, res, next) {
  const token = req.query.t || req.body?.token || req.headers['x-checkin-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'missing_token' });
  const payload = verifyCheckinToken(token);
  if (!payload) return res.status(401).json({ ok: false, error: 'invalid_or_expired_token' });

  const sessionsCol = await getCollection('checkin_sessions');
  const session = await sessionsCol.findOne({ _id: `booking_${payload.bookingId}` });
  if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' });
  if (session.access_token !== token) return res.status(401).json({ ok: false, error: 'token_revoked' });

  req.checkinSession = session;
  next();
}

// GET /api/checkin/session?t=<JWT>
// Restituisce dati della session: property, booking, guests (slot vuoti o parzialmente compilati)
app.get('/api/checkin/session', requireGuestAuth, async (req, res) => {
  const s = req.checkinSession;
  res.json({
    ok: true,
    session: {
      bookingId: s.smoobu_booking_id,
      property: s.property,
      booking: s.booking,
      status: s.status,
      guests: s.guests.map(g => ({
        slot: g.slot,
        first_name: g.first_name,
        last_name: g.last_name,
        date_of_birth: g.date_of_birth,
        place_of_birth: g.place_of_birth,
        country_of_residence: g.country_of_residence,
        nationality: g.nationality,
        document_type: g.document_type,
        document_number: g.document_number,
        document_issue_country: g.document_issue_country,
        document_issue_date: g.document_issue_date,
        document_expiry_date: g.document_expiry_date,
        is_minor: g.is_minor,
        has_front_photo: !!g.r2_front_key,
        has_back_photo: !!g.r2_back_key,
        submitted_at: g.submitted_at,
        privacy_consent: g.privacy_consent,
      })),
    },
  });
});

// POST /api/checkin/guest/save
// Body: { token, slot, data: { first_name, last_name, date_of_birth, ... } }
app.post('/api/checkin/guest/save', requireGuestAuth, async (req, res) => {
  try {
    const s = req.checkinSession;
    const { slot, data } = req.body;
    if (!slot || !data) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const allowed = ['first_name', 'last_name', 'date_of_birth', 'place_of_birth',
      'country_of_residence', 'nationality', 'document_type', 'document_number',
      'document_issue_country', 'document_issue_date', 'document_expiry_date', 'is_minor', 'privacy_consent'];

    const updates = {};
    for (const k of allowed) { if (k in data) updates[`guests.$.${k}`] = data[k]; }
    if (data.privacy_consent === true) updates['guests.$.privacy_consent_at'] = new Date().toISOString();

    const sessionsCol = await getCollection('checkin_sessions');
    await sessionsCol.updateOne(
      { _id: s._id, 'guests.slot': parseInt(slot) },
      { $set: { ...updates, updated_at: new Date().toISOString() } }
    );

    await recalculateSessionStatus(s._id);
    const updated = await sessionsCol.findOne({ _id: s._id });
    res.json({ ok: true, status: updated.status });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/checkin/guest/upload
// Body: { token, slot, side: 'front'|'back', imageBase64, mimeType }
// Carica foto documento su R2 Cloudflare e salva la key in MongoDB
app.post('/api/checkin/guest/upload', requireGuestAuth, async (req, res) => {
  try {
    const s = req.checkinSession;
    const { slot, side, imageBase64, mimeType } = req.body;
    if (!slot || !side || !imageBase64) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!['front', 'back'].includes(side)) return res.status(400).json({ ok: false, error: 'invalid_side' });

    const buffer = Buffer.from(imageBase64, 'base64');
    if (buffer.length > 5 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'file_too_large' });

    const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
    const key = `${s._id}/guest_${slot}/${side}.${ext}`;
    await r2Upload(key, buffer, mimeType || 'image/jpeg');

    const fieldName = side === 'front' ? 'r2_front_key' : 'r2_back_key';
    const sessionsCol = await getCollection('checkin_sessions');
    await sessionsCol.updateOne(
      { _id: s._id, 'guests.slot': parseInt(slot) },
      { $set: { [`guests.$.${fieldName}`]: key, updated_at: new Date().toISOString() } }
    );

    res.json({ ok: true, key });
  } catch (e) {
    console.error('[checkin/guest/upload]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ── Check-in: OCR via Claude Vision (Sprint 1B.1-C.2) ─────────────
// ══════════════════════════════════════════════════════════════════
//
// POST /api/checkin/guest/ocr
// Body: {
//   token,                      // JWT guest (oppure header X-Checkin-Token)
//   slot,                       // 1..N (numero ospite)
//   documentType,               // 'CIE' | 'PAPER_ID' | 'DRIVING_LICENSE' | 'PASSPORT'
//   frontImageBase64,           // sempre obbligatorio (no prefisso data:image/...)
//   frontMimeType,              // 'image/jpeg' | 'image/png' (default jpeg)
//   backImageBase64?,           // obbligatorio per CIE/PAPER_ID, vietato per gli altri
//   backMimeType?,
// }
//
// Comportamento:
// 1. Valida JWT + slot + documentType
// 2. Verifica che r2_front_key del guest sia ancora null (errore se già caricato)
// 3. CIE/PAPER_ID: 1 chiamata OCR con front+back insieme
//    DRIVING_LICENSE/PASSPORT: 1 chiamata OCR con sola front
// 4. Se OCR fallisce → 422, niente salvato su R2, niente scritto su MongoDB
// 5. Se OCR ok → upload R2 + scrive in guests[] SOLO i campi attualmente null
//    (non sovrascrive eventuale input manuale del guest)
// 6. validateTaxCode: log warning ma accetta comunque (tax_code_verified flag)
// 7. Ritorna extracted (dati grezzi OCR) + written (campi effettivamente scritti) +
//    skipped (campi che erano già pieni) per UX di conferma frontend
app.post('/api/checkin/guest/ocr', requireGuestAuth, async (req, res) => {
  const s = req.checkinSession;
  const { slot, documentType, frontImageBase64, frontMimeType,
          backImageBase64, backMimeType } = req.body || {};

  // ── 1. Validazione input ──────────────────────────────────────
  if (!slot || !documentType || !frontImageBase64) {
    return res.status(400).json({ ok: false, error: 'missing_fields',
      detail: 'slot, documentType, frontImageBase64 obbligatori' });
  }

  const validTypes = ['CIE', 'PAPER_ID', 'DRIVING_LICENSE', 'PASSPORT'];
  if (!validTypes.includes(documentType)) {
    return res.status(400).json({ ok: false, error: 'invalid_document_type',
      detail: `documentType deve essere uno di: ${validTypes.join(', ')}` });
  }

  const twoSided = (documentType === 'CIE' || documentType === 'PAPER_ID');
  if (twoSided && !backImageBase64) {
    return res.status(400).json({ ok: false, error: 'missing_back_image',
      detail: 'CIE e PAPER_ID richiedono anche backImageBase64' });
  }
  if (!twoSided && backImageBase64) {
    return res.status(400).json({ ok: false, error: 'unexpected_back_image',
      detail: 'DRIVING_LICENSE e PASSPORT richiedono solo frontImageBase64' });
  }

  // ── 2. Verifica slot esiste e non ha già foto ─────────────────
  const slotNum = parseInt(slot);
  const guest = s.guests.find(g => g.slot === slotNum);
  if (!guest) {
    return res.status(404).json({ ok: false, error: 'guest_slot_not_found' });
  }
  if (guest.r2_front_key) {
    return res.status(409).json({ ok: false, error: 'document_already_uploaded',
      detail: 'Documento già caricato per questo ospite. Usa /api/checkin/guest/reset prima di ricaricarlo (TODO).' });
  }

  // ── 3. Decodifica base64 + check dimensione ───────────────────
  let frontBuf, backBuf;
  try {
    frontBuf = Buffer.from(frontImageBase64, 'base64');
    if (twoSided) backBuf = Buffer.from(backImageBase64, 'base64');
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'invalid_base64' });
  }

  const MAX_SIZE = 5 * 1024 * 1024; // 5MB per immagine
  if (frontBuf.length > MAX_SIZE) {
    return res.status(413).json({ ok: false, error: 'front_image_too_large',
      detail: `Front max ${MAX_SIZE} bytes, ricevuti ${frontBuf.length}` });
  }
  if (twoSided && backBuf.length > MAX_SIZE) {
    return res.status(413).json({ ok: false, error: 'back_image_too_large' });
  }

  // ── 4. Chiamata OCR a Claude Sonnet 4.6 ───────────────────────
  const frontMime = (frontMimeType || 'image/jpeg').toLowerCase();
  const backMime  = (backMimeType  || 'image/jpeg').toLowerCase();
  const validMimes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!validMimes.includes(frontMime) || (twoSided && !validMimes.includes(backMime))) {
    return res.status(400).json({ ok: false, error: 'invalid_mime_type',
      detail: `Mime types ammessi: ${validMimes.join(', ')}` });
  }

  const promptText = buildOcrPrompt(documentType);
  const userContent = [
    { type: 'text', text: promptText },
    { type: 'image', source: { type: 'base64', media_type: frontMime, data: frontImageBase64 } },
  ];
  if (twoSided) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: backMime, data: backImageBase64 } });
  }

  let extracted = null;
  let rawOcrResponse = null;
  try {
    const ocrResp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: userContent }],
    });
    // La risposta è un array di content blocks; prendiamo il primo text block
    rawOcrResponse = (ocrResp.content || []).map(c => c.text || '').join('').trim();

    // Strip eventuali markdown fences ```json ... ```
    let jsonText = rawOcrResponse
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    extracted = JSON.parse(jsonText);
  } catch (ocrErr) {
    console.error('[checkin/guest/ocr] OCR failed:', ocrErr.message, '| raw:', rawOcrResponse?.slice(0, 300));
    return res.status(422).json({ ok: false, error: 'ocr_failed',
      detail: 'Claude non è riuscito a leggere il documento. Riprovare con foto più nitida.',
      raw_preview: rawOcrResponse?.slice(0, 200) || null });
  }

  // ── 5. Validazione struttura JSON estratto ────────────────────
  if (!extracted || typeof extracted !== 'object') {
    return res.status(422).json({ ok: false, error: 'ocr_invalid_response' });
  }

  // ── 6. Upload immagini su R2 (solo ORA che OCR è andato bene) ─
  const frontExt = frontMime.split('/')[1] || 'jpg';
  const frontKey = `${s._id}/guest_${slotNum}/front.${frontExt}`;
  let backKey = null;

  try {
    await r2Upload(frontKey, frontBuf, frontMime);
    if (twoSided) {
      const backExt = backMime.split('/')[1] || 'jpg';
      backKey = `${s._id}/guest_${slotNum}/back.${backExt}`;
      await r2Upload(backKey, backBuf, backMime);
    }
  } catch (r2Err) {
    console.error('[checkin/guest/ocr] R2 upload failed:', r2Err.message);
    return res.status(500).json({ ok: false, error: 'r2_upload_failed', detail: r2Err.message });
  }

  // ── 7. Mappatura OCR → schema guests[] ────────────────────────
  // Mappa: nome campo nello schema guest ← nome campo nel JSON OCR
  const fieldMap = {
    first_name:            extracted.first_name,
    last_name:             extracted.last_name,
    sex:                   extracted.sex,
    date_of_birth:         extracted.date_of_birth,
    place_of_birth:        extracted.place_of_birth,
    nationality:           extracted.nationality,
    document_number:       extracted.document_number,
    document_issue_date:   extracted.document_issue_date,
    document_expiry_date:  extracted.document_expiry_date,
    document_issue_country:extracted.document_issue_country,
    address_street:        extracted.address_street,
    address_zip:           extracted.address_zip,
    address_city:          extracted.address_city,
    address_province:      extracted.address_province,
    address_country:       extracted.address_country,
  };

  // Tax code: validazione + flag (solo se estratto e formato CF italiano)
  let taxCodeVerified = false;
  if (extracted.tax_code) {
    taxCodeVerified = validateTaxCode(extracted.tax_code);
    if (!taxCodeVerified) {
      console.warn(`[checkin/guest/ocr] CF non valido per session ${s._id} guest ${slotNum}: "${extracted.tax_code}"`);
    }
  }

  // ── 8. Update MongoDB: scrive SOLO campi attualmente null ─────
  const writeUpdates = {};
  const written = [];
  const skipped = [];

  for (const [field, value] of Object.entries(fieldMap)) {
    if (value === null || value === undefined || value === '') continue;
    if (guest[field] === null || guest[field] === undefined || guest[field] === '') {
      writeUpdates[`guests.$.${field}`] = value;
      written.push(field);
    } else {
      skipped.push(field);
    }
  }

  // Tax code: campo speciale, scrive tax_code + source + verified
  if (extracted.tax_code) {
    if (guest.tax_code === null || guest.tax_code === undefined || guest.tax_code === '') {
      writeUpdates['guests.$.tax_code'] = extracted.tax_code.toUpperCase().trim();
      writeUpdates['guests.$.tax_code_source'] = 'ocr';
      writeUpdates['guests.$.tax_code_verified'] = taxCodeVerified;
      written.push('tax_code');
    } else {
      skipped.push('tax_code');
    }
  }

  // Address source (se almeno un campo address scritto)
  const addrFields = ['address_street','address_zip','address_city','address_province','address_country'];
  if (addrFields.some(f => written.includes(f))) {
    writeUpdates['guests.$.address_source'] = 'ocr';
  }

  // Document type + R2 keys + metadata OCR (sempre scritti, sono di sistema)
  writeUpdates['guests.$.document_type'] = documentType;
  writeUpdates['guests.$.r2_front_key']  = frontKey;
  if (backKey) writeUpdates['guests.$.r2_back_key'] = backKey;
  writeUpdates['guests.$.ocr_confidence_overall'] = typeof extracted.confidence === 'number'
    ? extracted.confidence : null;
  writeUpdates['guests.$.ocr_warnings'] = Array.isArray(extracted.warnings)
    ? extracted.warnings : [];

  const sessionsCol = await getCollection('checkin_sessions');
  try {
    await sessionsCol.updateOne(
      { _id: s._id, 'guests.slot': slotNum },
      { $set: { ...writeUpdates, updated_at: new Date().toISOString() } }
    );
  } catch (dbErr) {
    console.error('[checkin/guest/ocr] MongoDB update failed:', dbErr.message);
    // Foto già su R2 → meglio non rollback (compliance > storage cost)
    return res.status(500).json({ ok: false, error: 'db_update_failed', detail: dbErr.message });
  }

  // ── 9. Risposta al frontend ───────────────────────────────────
  console.log(`[checkin/guest/ocr] ${s._id} guest ${slotNum} ${documentType} ok | written: ${written.join(',')} | CF verified: ${taxCodeVerified}`);

  res.json({
    ok: true,
    extracted,                                    // dati grezzi OCR (per UX conferma)
    written,                                      // campi effettivamente scritti
    skipped,                                      // campi non sovrascritti (input manuale)
    tax_code_verified: taxCodeVerified,
    ocr_confidence: extracted.confidence || null,
    ocr_warnings: extracted.warnings || [],
  });
});

// POST /api/checkin/guest/submit
// Body: { token, slot }
// Marca il guest come "submitted" (validato dall'ospite)
app.post('/api/checkin/guest/submit', requireGuestAuth, async (req, res) => {
  try {
    const s = req.checkinSession;
    const { slot } = req.body;
    const sessionsCol = await getCollection('checkin_sessions');

    const guest = s.guests.find(g => g.slot === parseInt(slot));
    if (!guest) return res.status(404).json({ ok: false, error: 'guest_slot_not_found' });

    const required = ['first_name', 'last_name', 'date_of_birth', 'place_of_birth',
      'nationality', 'document_type', 'document_number'];
    const missing = required.filter(k => !guest[k]);
    if (missing.length > 0) return res.status(400).json({ ok: false, error: 'missing_required_fields', missing });
    if (!guest.r2_front_key) return res.status(400).json({ ok: false, error: 'missing_document_photo' });
    if (!guest.privacy_consent) return res.status(400).json({ ok: false, error: 'missing_privacy_consent' });

    await sessionsCol.updateOne(
      { _id: s._id, 'guests.slot': parseInt(slot) },
      { $set: { 'guests.$.submitted_at': new Date().toISOString(), updated_at: new Date().toISOString() } }
    );

    await recalculateSessionStatus(s._id);
    const updated = await sessionsCol.findOne({ _id: s._id });
    res.json({ ok: true, status: updated.status });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Helper: ricalcola lo status della session in base allo stato dei guest
// Chiamato dopo save/submit per aggiornare pending→partial→complete
async function recalculateSessionStatus(sessionId) {
  const sessionsCol = await getCollection('checkin_sessions');
  const session = await sessionsCol.findOne({ _id: sessionId });
  if (!session) return;
  if (!['pending', 'partial', 'complete'].includes(session.status)) return;

  const allSubmitted = session.guests.every(g => !!g.submitted_at);
  const someSubmitted = session.guests.some(g => !!g.submitted_at || !!g.first_name);

  let newStatus = session.status;
  if (allSubmitted) newStatus = 'complete';
  else if (someSubmitted) newStatus = 'partial';
  else newStatus = 'pending';

  const updates = { status: newStatus, updated_at: new Date().toISOString() };
  if (newStatus === 'complete' && !session.completed_at) updates.completed_at = new Date().toISOString();
  await sessionsCol.updateOne({ _id: sessionId }, { $set: updates });
}
// ══════════════════════════════════════════════════════════════════
// ── Check-in: Admin routes (PIN-protected) ────────────────────────
// ══════════════════════════════════════════════════════════════════

// GET /api/checkin/sessions
// Query opzionali: ?status=pending&from=2026-05-01&to=2026-12-31&property_id=2846008
// Restituisce lista delle session ordinate per data di arrivo (max 500)
app.get('/api/checkin/sessions', requireAdminAuth, async (req, res) => {
  try {
    const { status, from, to, property_id } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (property_id) filter['property.smoobu_id'] = property_id;
    if (from || to) {
      filter['booking.arrival'] = {};
      if (from) filter['booking.arrival'].$gte = from;
      if (to) filter['booking.arrival'].$lte = to;
    }
    const col = await getCollection('checkin_sessions');
    const list = await col.find(filter).sort({ 'booking.arrival': 1 }).limit(500).toArray();
    res.json({ ok: true, sessions: list });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/checkin/sessions/:id
// Restituisce dettaglio completo di una session.
// Aggiunge signed URL temporanei (1h) per foto documenti su R2.
app.get('/api/checkin/sessions/:id', requireAdminAuth, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    const session = await col.findOne({ _id: req.params.id });
    if (!session) return res.status(404).json({ ok: false, error: 'not_found' });

    // Genera signed URL per ogni foto caricata (validità 1 ora)
    const guestsWithUrls = await Promise.all(session.guests.map(async g => {
      const urls = {};
      if (g.r2_front_key) urls.front_url = await r2GetSignedUrl(g.r2_front_key, 3600);
      if (g.r2_back_key) urls.back_url = await r2GetSignedUrl(g.r2_back_key, 3600);
      return { ...g, ...urls };
    }));

    res.json({ ok: true, session: { ...session, guests: guestsWithUrls } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/checkin/sessions/:id/resend
// Rigenera token JWT e reinvia il messaggio iniziale (chat Smoobu o email).
// Utile se: token scaduto, ospite ha perso il link, vuoi forzare un reinvio.
app.post('/api/checkin/sessions/:id/resend', requireAdminAuth, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    const session = await col.findOne({ _id: req.params.id });
    if (!session) return res.status(404).json({ ok: false, error: 'not_found' });

    const tokenData = generateCheckinToken(session.smoobu_booking_id, session.booking.departure);
    await col.updateOne(
      { _id: session._id },
      { $set: { access_token: tokenData.token, token_expires_at: tokenData.expiresAt, updated_at: new Date().toISOString() } }
    );

    const fresh = await col.findOne({ _id: session._id });
    await dispatchInitialMessage(fresh);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/checkin/sessions/:id/override-status
// Body: { status, reason? }
// Forza manualmente lo status di una session (uso admin per casi edge).
app.post('/api/checkin/sessions/:id/override-status', requireAdminAuth, async (req, res) => {
  try {
    const { status, reason } = req.body;
    const validStatuses = ['pending', 'partial', 'complete', 'manual_required',
      'excluded_block', 'excluded_internal', 'excluded_property_disabled',
      'excluded_long_term', 'long_stay_review', 'needs_review', 'archived'];
    if (!validStatuses.includes(status)) return res.status(400).json({ ok: false, error: 'invalid_status' });
    const col = await getCollection('checkin_sessions');
    await col.updateOne(
      { _id: req.params.id },
      { $set: { status, exclusion_reason: reason || null, updated_at: new Date().toISOString() } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// ══════════════════════════════════════════════════════════════════
// ── Check-in: Cron endpoints (called by cron-job.org) ─────────────
// ══════════════════════════════════════════════════════════════════
//
// Protezione: shared secret in env var CRON_SECRET (riusiamo la stessa
// dell'onboarding cron-tick). Header X-Cron-Secret o ?secret=...
//
// Schedule consigliato su cron-job.org:
//   /api/cron/checkin/reminders → ogni giorno alle 10:00 Europe/Rome
//   /api/cron/checkin/cleanup   → ogni notte alle 03:00 Europe/Rome

function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'] || req.query.secret;
  if (!secret) return res.status(500).json({ ok: false, error: 'cron_secret_not_configured' });
  if (provided !== secret) return res.status(401).json({ ok: false, error: 'invalid_cron_secret' });
  next();
}

// POST /api/cron/checkin/reminders
// Invia reminder D-3 e D-1 alle session pending/partial.
// Marca come manual_required le prenotazioni con arrivo oggi non completate.
app.post('/api/cron/checkin/reminders', requireCronSecret, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    const today = new Date();
    const d3Target = new Date(today); d3Target.setDate(d3Target.getDate() + 3);
    const d1Target = new Date(today); d1Target.setDate(d1Target.getDate() + 1);
    const d3Str = d3Target.toISOString().slice(0, 10);
    const d1Str = d1Target.toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);

    let remindersSent = 0, manualFlagged = 0;

    // D-3 reminders
    const d3Sessions = await col.find({
      status: { $in: ['pending', 'partial'] },
      'booking.arrival': d3Str,
    }).toArray();
    for (const s of d3Sessions) {
      const alreadySent = s.messages_sent?.some(m => m.type === 'reminder_d3');
      if (alreadySent) continue;
      const link = `${APP_BASE_URL}/checkin.html?t=${s.access_token}`;
      const msg = buildReminderD3({
        guestFirstName: s.booking.primary_guest_name?.split(' ')[0] || 'guest',
        propertyName: s.property.name,
        checkinLink: link,
        guestLang: s.booking.language,
      });
      const isDirect = s.booking.channel_id === SMOOBU_CHANNEL_DIRECT;
      const result = isDirect && s.booking.primary_guest_email
        ? await sendEmailFallback(s.booking.primary_guest_email, 'Check-in reminder', msg.replace(/\n/g, '<br>'))
        : await sendSmoobuChatMessage(s.smoobu_booking_id, msg);
      await col.updateOne({ _id: s._id }, {
        $push: { messages_sent: { type: 'reminder_d3', channel: isDirect ? 'email' : 'smoobu_chat', sent_at: new Date().toISOString(), success: result.success, error: result.error || null } },
      });
      if (result.success) remindersSent++;
    }

    // D-1 reminders (più urgenti)
    const d1Sessions = await col.find({
      status: { $in: ['pending', 'partial'] },
      'booking.arrival': d1Str,
    }).toArray();
    for (const s of d1Sessions) {
      const alreadySent = s.messages_sent?.some(m => m.type === 'reminder_d1');
      if (alreadySent) continue;
      const link = `${APP_BASE_URL}/checkin.html?t=${s.access_token}`;
      const msg = buildReminderD1({
        guestFirstName: s.booking.primary_guest_name?.split(' ')[0] || 'guest',
        checkinLink: link,
        guestLang: s.booking.language,
      });
      const isDirect = s.booking.channel_id === SMOOBU_CHANNEL_DIRECT;
      const result = isDirect && s.booking.primary_guest_email
        ? await sendEmailFallback(s.booking.primary_guest_email, 'Check-in reminder', msg.replace(/\n/g, '<br>'))
        : await sendSmoobuChatMessage(s.smoobu_booking_id, msg);
      await col.updateOne({ _id: s._id }, {
        $push: { messages_sent: { type: 'reminder_d1', channel: isDirect ? 'email' : 'smoobu_chat', sent_at: new Date().toISOString(), success: result.success, error: result.error || null } },
      });
      if (result.success) remindersSent++;
    }

    // Arrivi oggi non ancora completi → manual_required
    const arrivingToday = await col.find({
      status: { $in: ['pending', 'partial'] },
      'booking.arrival': todayStr,
    }).toArray();
    for (const s of arrivingToday) {
      await col.updateOne({ _id: s._id }, { $set: { status: 'manual_required', updated_at: new Date().toISOString() } });
      manualFlagged++;
    }

    console.log(`[cron/checkin/reminders] sent=${remindersSent} manualFlagged=${manualFlagged}`);
    res.json({ ok: true, remindersSent, manualFlagged });
  } catch (e) {
    console.error('[cron/checkin/reminders]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/cron/checkin/cleanup
// Cleanup notturno:
// - Cancella foto R2 con checkout > 7 giorni fa (privacy GDPR + costi storage)
// - Archivia session con checkout > 30 giorni fa (status=archived)
app.post('/api/cron/checkin/cleanup', requireCronSecret, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    const now = new Date();
    const cutoff7 = new Date(now); cutoff7.setDate(cutoff7.getDate() - 7);
    const cutoff30 = new Date(now); cutoff30.setDate(cutoff30.getDate() - 30);
    const cutoff7Str = cutoff7.toISOString().slice(0, 10);
    const cutoff30Str = cutoff30.toISOString().slice(0, 10);

    // Foto da cancellare: session con checkout > 7gg fa che hanno ancora foto
    const toCleanPhotos = await col.find({
      'booking.departure': { $lt: cutoff7Str },
      status: { $ne: 'archived' },
      'guests.r2_front_key': { $ne: null },
    }).toArray();

    let photosDeleted = 0;
    for (const s of toCleanPhotos) {
      for (const g of s.guests) {
        if (g.r2_front_key) {
          try { await r2Delete(g.r2_front_key); photosDeleted++; }
          catch (e) { console.error('[r2Delete]', e.message); }
        }
        if (g.r2_back_key) {
          try { await r2Delete(g.r2_back_key); photosDeleted++; }
          catch (e) { console.error('[r2Delete]', e.message); }
        }
      }
      await col.updateOne({ _id: s._id }, {
        $set: {
          'guests.$[].r2_front_key': null,
          'guests.$[].r2_back_key': null,
          updated_at: new Date().toISOString(),
        },
      });
    }

    // Archiviazione session con checkout > 30gg fa
    const archiveResult = await col.updateMany(
      { 'booking.departure': { $lt: cutoff30Str }, status: { $ne: 'archived' } },
      { $set: { status: 'archived', archived_at: new Date().toISOString() } }
    );

    console.log(`[cron/checkin/cleanup] photos=${photosDeleted} archived=${archiveResult.modifiedCount}`);
    res.json({ ok: true, photosDeleted, sessionsArchived: archiveResult.modifiedCount });
  } catch (e) {
    console.error('[cron/checkin/cleanup]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
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
