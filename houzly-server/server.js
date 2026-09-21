const express = require('express');
const compression = require('compression');
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

// Anthropic client — non più usato dal check-in (OCR rimosso a settembre 2026,
// l'ospite inserisce i dati a mano). Lasciato disponibile per altri moduli.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// JWT config
const JWT_SECRET = process.env.JWT_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://houzly-tool.onrender.com';
// Check-in: minuti di attesa tra l'arrivo della prenotazione e l'invio del link,
// così il messaggio arriva DOPO il primo messaggio automatico di Airbnb/Booking/Smoobu.
// Modificabile da Render con la env var CHECKIN_INITIAL_DELAY_MINUTES.
const CHECKIN_INITIAL_DELAY_MINUTES = parseInt(process.env.CHECKIN_INITIAL_DELAY_MINUTES || '30', 10);
// Finestra di invio: per arrivi più lontani di questi giorni il link non parte
// subito ma N giorni prima dell'arrivo, alle 10:00 ora italiana.
// Modificabile da Render con la env var CHECKIN_SEND_WINDOW_DAYS.
const CHECKIN_SEND_WINDOW_DAYS = parseInt(process.env.CHECKIN_SEND_WINDOW_DAYS || '14', 10);

// Istante UTC corrispondente alle 10:00 ora di Roma del giorno indicato (YYYY-MM-DD)
function romeTenAmIso(dateStr) {
  for (const utcHour of [8, 9]) {
    const d = new Date(`${dateStr}T${String(utcHour).padStart(2, '0')}:00:00Z`);
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(d);
    if (parseInt(h, 10) === 10) return d.toISOString();
  }
  return new Date(`${dateStr}T08:00:00Z`).toISOString();
}

// Quando deve partire il link iniziale per un arrivo (YYYY-MM-DD):
// il più tardi tra "adesso + ritardo" e "N giorni prima dell'arrivo alle 10:00"
// Primo momento in cui il link può partire: N giorni prima dell'arrivo alle 10:00
function computeWindowStartIso(arrival) {
  if (!arrival || !/^\d{4}-\d{2}-\d{2}$/.test(arrival)) return null;
  const d = new Date(`${arrival}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - CHECKIN_SEND_WINDOW_DAYS);
  return romeTenAmIso(d.toISOString().slice(0, 10));
}
function computeInitialDueAt(arrival) {
  const soon = new Date(Date.now() + CHECKIN_INITIAL_DELAY_MINUTES * 60000).toISOString();
  const windowStart = computeWindowStartIso(arrival);
  return windowStart && windowStart > soon ? windowStart : soon;
}

// Riprogramma i link non ancora partiti di una struttura che risultano
// in anticipo rispetto alla finestra (es. programmati prima di questa regola)
async function rescheduleEarlyLinks(prop) {
  const col = await getCollection('checkin_sessions');
  const list = await col.find({
    'property.smoobu_id': String(prop.smoobu_apartment_id),
    status: { $in: ['pending', 'partial'] },
    initial_message_sent_at: null,
    initial_message_due_at: { $ne: null },
  }, { projection: { 'booking.arrival': 1, initial_message_due_at: 1 } }).toArray();
  let n = 0;
  for (const s of list) {
    const ws = computeWindowStartIso(s.booking?.arrival);
    if (ws && s.initial_message_due_at < ws) {
      await col.updateOne({ _id: s._id }, { $set: { initial_message_due_at: ws } });
      n++;
    }
  }
  return n;
}

// Giorni dopo il check-out in cui la scheda resta attiva prima dell'archiviazione
const CHECKIN_ARCHIVE_AFTER_DAYS = 50;
// Destinatari dell'avviso "check-in completato" (uno o più indirizzi separati da virgola).
// Si imposta su Render con la env var CHECKIN_NOTIFY_EMAIL. Se vuota, nessun avviso.
const CHECKIN_NOTIFY_EMAILS = (process.env.CHECKIN_NOTIFY_EMAIL || '')
  .split(',').map(x => x.trim()).filter(Boolean);

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

// ══════════════════════════════════════════════════════════════════
// ── Check-in: validazione dati ospite (versione senza foto) ───────
// ══════════════════════════════════════════════════════════════════
// Da settembre 2026 il check-in online NON raccoglie foto dei documenti:
// l'ospite inserisce i dati a mano, il riconoscimento de visu avviene
// all'arrivo (di persona o in videochiamata). Qui vivono tutte le regole
// di validazione, usate sia da /save (controllo formato) sia da /submit
// (controllo completo con campi obbligatori).

const CHECKIN_DOCUMENT_TYPES = ['ID_CARD', 'PASSPORT', 'DRIVING_LICENSE'];

// Campi che l'ospite può scrivere tramite /save
const CHECKIN_GUEST_FIELDS = [
  'first_name', 'last_name', 'sex', 'date_of_birth',
  'birth_country', 'birth_city', 'birth_province',
  'nationality', 'tax_code',
  'document_type', 'document_number', 'document_issue_country', 'document_issue_city',
  'document_expiry_date',
  'address_street', 'address_zip', 'address_city', 'address_province', 'address_country',
  'privacy_consent',
];

const CHECKIN_UPPERCASE_FIELDS = ['sex', 'birth_country', 'birth_province', 'nationality',
  'document_type', 'document_issue_country', 'address_province', 'address_country', 'address_zip'];

function isValidIsoDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Età compiuta alla data di riferimento (arrivo), entrambe YYYY-MM-DD
function computeAgeAt(dob, refDate) {
  if (!isValidIsoDate(dob)) return null;
  const ref = isValidIsoDate(refDate) ? refDate : new Date().toISOString().slice(0, 10);
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ry, rm, rd] = ref.split('-').map(Number);
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age--;
  return age;
}

// Pulisce l'input grezzo del frontend: spazi, maiuscole, stringhe vuote → null
function normalizeGuestInput(data) {
  const out = {};
  for (const k of CHECKIN_GUEST_FIELDS) {
    if (!(k in data)) continue;
    let v = data[k];
    if (k === 'privacy_consent') { out[k] = v === true; continue; }
    if (v === null || v === undefined) { out[k] = null; continue; }
    v = String(v).replace(/\s+/g, ' ').trim();
    if (v === '') { out[k] = null; continue; }
    if (CHECKIN_UPPERCASE_FIELDS.includes(k)) v = v.toUpperCase();
    if (k === 'tax_code' || k === 'document_number') v = v.toUpperCase().replace(/[\s.\-]/g, '');
    out[k] = v;
  }
  return out;
}

// ── Coerenza codice fiscale con nome, cognome, data di nascita e sesso ──
const CF_MONTH_LETTERS = 'ABCDEHLMPRST';
const CF_OMOCODIA_LETTERS = 'LMNPQRSTUV';

function cfLetters(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z]/g, '');
}
function cfSurnameCode(surname) {
  const l = cfLetters(surname);
  const cons = l.replace(/[AEIOU]/g, ''), vow = l.replace(/[^AEIOU]/g, '');
  return (cons + vow + 'XXX').slice(0, 3);
}
function cfNameCode(name) {
  const l = cfLetters(name);
  const cons = l.replace(/[AEIOU]/g, ''), vow = l.replace(/[^AEIOU]/g, '');
  if (cons.length >= 4) return cons[0] + cons[2] + cons[3];
  return (cons + vow + 'XXX').slice(0, 3);
}
// Omocodia: l'Agenzia sostituisce alcune cifre con lettere → le riconverte
function cfDecodeOmocodia(cf) {
  const ch = cf.split('');
  [6, 7, 9, 10, 12, 13, 14].forEach(i => {
    const pos = CF_OMOCODIA_LETTERS.indexOf(ch[i]);
    if (pos >= 0) ch[i] = String(pos);
  });
  return ch.join('');
}
// Ritorna { dateSexOk, nameOk } — true quando non verificabile (dati mancanti)
function checkTaxCodeCoherence(cf, g) {
  const out = { dateSexOk: true, nameOk: true };
  const c = cfDecodeOmocodia(cf.toUpperCase());
  if (isValidIsoDate(g.date_of_birth) && (g.sex === 'M' || g.sex === 'F')) {
    const [y, m, d] = g.date_of_birth.split('-');
    const day = parseInt(d, 10) + (g.sex === 'F' ? 40 : 0);
    const expected = y.slice(2) + CF_MONTH_LETTERS[parseInt(m, 10) - 1] + String(day).padStart(2, '0');
    out.dateSexOk = c.slice(6, 11) === expected;
  }
  if (g.last_name && g.first_name) {
    out.nameOk = c.slice(0, 3) === cfSurnameCode(g.last_name)
              && c.slice(3, 6) === cfNameCode(g.first_name);
  }
  return out;
}

function checkDocumentNumber(type, issueCountry, num) {
  if (!/^[A-Z0-9]{5,20}$/.test(num)) return false;
  if (issueCountry !== 'IT') return true;
  // CIE (CA12345AB) o numerazione a 2 lettere + 7 cifre
  if (type === 'ID_CARD') return /^[A-Z]{2}\d{5}[A-Z]{2}$/.test(num) || /^[A-Z]{2}\d{7}$/.test(num);
  if (type === 'PASSPORT') return /^[A-Z]{2}\d{7}$/.test(num);
  return true; // patente italiana: formati storici troppo vari, solo controllo generico
}

// Valida un ospite (dati già uniti: salvati + nuovi).
// ctx = { isPrimary, arrival, full }
//   full=false → solo formato dei campi presenti (usato da /save)
//   full=true  → anche campi obbligatori (usato da /submit)
// Ritorna { errors: [{field, code}], warnings: [{field, code}], age, isMinor, taxCodeVerified }
function validateCheckinGuest(g, ctx) {
  const errors = [], warnings = [];
  const add = (field, code) => errors.push({ field, code });
  const empty = f => g[f] === null || g[f] === undefined || g[f] === '';
  const req = f => { if (ctx.full && empty(f)) add(f, 'required'); };
  const iso2 = /^[A-Z]{2}$/;
  const today = new Date().toISOString().slice(0, 10);

  // ── Anagrafica (tutti gli ospiti) ──
  ['first_name', 'last_name', 'sex', 'date_of_birth', 'birth_country', 'nationality'].forEach(req);
  for (const f of ['first_name', 'last_name']) {
    if (!empty(f) && (g[f].length > 60 || !/^[\p{L}' .\-]+$/u.test(g[f]))) add(f, 'invalid_format');
  }
  if (!empty('sex') && !['M', 'F'].includes(g.sex)) add('sex', 'invalid_value');

  let age = null;
  if (!empty('date_of_birth')) {
    if (!isValidIsoDate(g.date_of_birth)) add('date_of_birth', 'invalid_date');
    else if (g.date_of_birth > today || g.date_of_birth < '1900-01-01') add('date_of_birth', 'out_of_range');
    else age = computeAgeAt(g.date_of_birth, ctx.arrival);
  }
  const isMinor = age !== null && age < 18;
  if (ctx.isPrimary && isMinor) add('date_of_birth', 'primary_must_be_adult');

  // ── Luogo di nascita: comune + provincia se Italia, solo nazione se estero ──
  if (!empty('birth_country') && !iso2.test(g.birth_country)) add('birth_country', 'invalid_country');
  if (g.birth_country === 'IT') {
    req('birth_city'); req('birth_province');
    if (!empty('birth_province') && !iso2.test(g.birth_province)) add('birth_province', 'invalid_province');
  }
  if (!empty('birth_city') && g.birth_city.length > 80) add('birth_city', 'invalid_format');

  // ── Cittadinanza + codice fiscale (obbligatorio per tutti gli italiani) ──
  if (!empty('nationality') && !iso2.test(g.nationality)) add('nationality', 'invalid_country');
  if (g.nationality === 'IT') req('tax_code');

  let taxCodeVerified = false;
  if (!empty('tax_code')) {
    if (!validateTaxCode(g.tax_code)) {
      add('tax_code', 'invalid_tax_code');
    } else {
      const coh = checkTaxCodeCoherence(g.tax_code, g);
      if (!coh.dateSexOk) add('tax_code', 'tax_code_birth_date_or_sex_mismatch');
      // Nome/cognome: solo avviso (doppi nomi, cognomi composti, traslitterazioni)
      if (!coh.nameOk) warnings.push({ field: 'tax_code', code: 'tax_code_name_mismatch' });
      taxCodeVerified = coh.dateSexOk && coh.nameOk
        && !empty('date_of_birth') && !empty('sex') && !empty('first_name') && !empty('last_name');
    }
  }

  // ── Documento: obbligatorio per TUTTI gli ospiti, minori e neonati compresi ──
  {
    req('document_type'); req('document_number'); req('document_issue_country');
    if (!empty('document_type') && !CHECKIN_DOCUMENT_TYPES.includes(g.document_type)) add('document_type', 'invalid_value');
    if (!empty('document_issue_country') && !iso2.test(g.document_issue_country)) add('document_issue_country', 'invalid_country');
    if (g.document_issue_country === 'IT') req('document_issue_city');
    if (!empty('document_number') && !empty('document_type') && CHECKIN_DOCUMENT_TYPES.includes(g.document_type)
        && !checkDocumentNumber(g.document_type, g.document_issue_country, g.document_number)) {
      add('document_number', 'invalid_document_number');
    }
    if (!empty('document_expiry_date')) {
      if (!isValidIsoDate(g.document_expiry_date)) add('document_expiry_date', 'invalid_date');
      else if (g.document_expiry_date < (ctx.arrival || today)) add('document_expiry_date', 'document_expired');
    }
  }

  // ── Residenza: solo ospite principale (serve per la fattura) ──
  if (ctx.isPrimary) {
    ['address_street', 'address_city', 'address_country'].forEach(req);
    if (!empty('address_country') && !iso2.test(g.address_country)) add('address_country', 'invalid_country');
    if (g.address_country === 'IT') {
      req('address_zip'); req('address_province');
      if (!empty('address_zip') && !/^\d{5}$/.test(g.address_zip)) add('address_zip', 'invalid_zip');
      if (!empty('address_province') && !iso2.test(g.address_province)) add('address_province', 'invalid_province');
    } else if (!empty('address_zip') && !/^[A-Z0-9 \-]{2,12}$/.test(g.address_zip)) {
      add('address_zip', 'invalid_zip');
    }
    if (ctx.full && g.privacy_consent !== true) add('privacy_consent', 'required');
  }

  return { errors, warnings, age, isMinor, taxCodeVerified };
}

// Stati in cui l'ospite può ancora modificare i dati
const CHECKIN_EDITABLE_STATUSES = ['pending', 'partial', 'complete', 'manual_required'];

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

// ══════════════════════════════════════════════════════════════════
//  SMOOBU API — autenticazione HMAC  (migrazione obbligatoria 25/09/2026)
// ══════════════════════════════════════════════════════════════════
//  Smoobu dismette le richieste firmate con il solo header `Api-Key`.
//  Da qui in avanti ogni chiamata viene firmata con HMAC-SHA256.
//
//  Variabili d'ambiente su Render:
//    SMOOBU_API_KEY     la chiave (Impostazioni > Avanzate > Chiavi API)
//    SMOOBU_API_SECRET  il secret, mostrato una sola volta alla creazione
//
//  INTERRUTTORE DI SICUREZZA: se SMOOBU_API_SECRET non e' impostata, il
//  codice ricade sul vecchio header `Api-Key`. Togliere quella variabile
//  da Render riporta tutto al comportamento precedente in 30 secondi.
//  Dopo il 25/09/2026 il ramo legacy smette di funzionare lato Smoobu.
//
//  Canonical string firmata (a-capo veri fra i campi):
//    METODO \n PATH \n QUERY-ordinata \n TIMESTAMP \n NONCE \n SHA256(body) \n API_KEY
// ══════════════════════════════════════════════════════════════════

const SMOOBU_BASE      = 'https://login.smoobu.com';
const SMOOBU_API_SECRET = process.env.SMOOBU_API_SECRET || '';
const SMOOBU_HMAC_ON    = !!SMOOBU_API_SECRET;

// Costruisce la query string UNA sola volta: la stessa stringa viene usata
// sia per firmare sia per la URL, cosi' non possono divergere.
// I parametri vanno in ordine alfabetico (lo impone Smoobu per il canonical).
function smoobuQuery(query) {
  if (!query) return '';
  const parts = [];
  Object.keys(query).sort().forEach(function (k) {
    const v = query[k];
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) v.forEach(function (x) { parts.push(k + '=' + x); });
    else parts.push(k + '=' + v);
  });
  return parts.join('&');
}

function smoobuAuthHeaders(method, pathOnly, canonicalQuery, bodyStr) {
  const apiKey = process.env.SMOOBU_API_KEY || '';
  if (!SMOOBU_HMAC_ON) return { 'Api-Key': apiKey };   // fallback legacy

  const bodyHash  = crypto.createHash('sha256').update(bodyStr || '', 'utf8').digest('hex');
  // ISO 8601 UTC senza millisecondi: 2026-04-01T12:00:00Z
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce     = crypto.randomUUID();

  const canonical = [method, pathOnly, canonicalQuery || '', timestamp, nonce, bodyHash, apiKey].join('\n');
  const signature = crypto.createHmac('sha256', SMOOBU_API_SECRET).update(canonical, 'utf8').digest('base64');

  return {
    'X-API-Key':   apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce':     nonce,
    'X-Signature': signature
  };
}

// Unico punto di uscita verso Smoobu. Firma e chiama.
//   smoobuFetch('GET',  '/api/apartments')
//   smoobuFetch('GET',  '/api/rates', { query: { 'apartments[]': 398, start_date: a, end_date: b } })
//   smoobuFetch('POST', '/api/reservations', { body: payload })
// Livello basso: permette di firmare una stringa e spedirne un'altra.
// Serve solo alla rotta diagnostica /api/smoobu-hmac-probe, che prova le
// varianti di canonicalizzazione della query per capire quale accetta Smoobu.
async function smoobuRawFetch(method, pathOnly, canonicalQuery, urlQuery, bodyStr, extraHeaders) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    smoobuAuthHeaders(method, pathOnly, canonicalQuery, bodyStr),
    extraHeaders || {}
  );
  const url = SMOOBU_BASE + pathOnly + (urlQuery ? '?' + urlQuery : '');
  const init = { method: method, headers: headers };
  if (bodyStr) init.body = bodyStr;
  return fetch(url, init);
}

async function smoobuFetch(method, pathOnly, opts) {
  opts = opts || {};
  const q = smoobuQuery(opts.query);
  const bodyStr = (opts.body !== undefined && opts.body !== null)
    ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
    : '';
  // SMOOBU_QUERY_MODE (env, opzionale): permette di cambiare la
  // canonicalizzazione senza rideployare il codice. Valori: 'raw' (default),
  // 'encoded' (parentesi in %5B%5D sia nella firma sia nella URL),
  // 'sign-encoded' (firma codificata, URL grezza),
  // 'sign-raw' (firma grezza, URL codificata).
  const mode = process.env.SMOOBU_QUERY_MODE || 'raw';
  const enc  = q.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  let canonicalQuery = q, urlQuery = q;
  if (mode === 'encoded')          { canonicalQuery = enc; urlQuery = enc; }
  else if (mode === 'sign-encoded'){ canonicalQuery = enc; urlQuery = q;   }
  else if (mode === 'sign-raw')    { canonicalQuery = q;   urlQuery = enc; }
  return smoobuRawFetch(method, pathOnly, canonicalQuery, urlQuery, bodyStr, opts.headers);
}

async function sendSmoobuChatMessage(reservationId, messageText) {
  try {
    // Endpoint ufficiale Smoobu: send-message-to-guest, campi subject + messageBody.
    // Per le prenotazioni Airbnb/Booking Smoobu consegna il messaggio nella chat del portale.
    const r = await smoobuFetch('POST', `/api/reservations/${reservationId}/messages/send-message-to-guest`, {
      body: { subject: 'Online Check-in', messageBody: messageText }
    });
    const text = await r.text();
    if (!r.ok) return { success: false, error: `Smoobu ${r.status}: ${text.slice(0, 300)}` };
    console.log('[Smoobu message]', reservationId, r.status, text.slice(0, 200));
    return { success: true, status: r.status };
  } catch (e) { return { success: false, error: e.message }; }
}

async function sendEmailFallback(toEmail, subject, html) {
  try {
    const result = await resend.emails.send({
      from: 'Houzly Check-in <checkin@houzly.it>',
      to: toEmail, subject, html,
    });
    // Resend v4 non lancia eccezioni: gli errori arrivano in result.error
    if (result?.error) return { success: false, error: result.error.message || String(result.error) };
    return { success: true, id: result.data?.id };
  } catch (e) { return { success: false, error: e.message }; }
}

// ── Testi dei messaggi agli ospiti (IT/EN) ────────────────────────
// Data leggibile: "20 settembre" / "20 September" (anno solo se diverso da quello corrente)
function formatStayDate(iso, isItalian) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const it = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  const en = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const yearPart = y !== new Date().getFullYear() ? ` ${y}` : '';
  return `${d} ${(isItalian ? it : en)[m - 1]}${yearPart}`;
}
function cleanFirstName(n) {
  const v = String(n || '').trim();
  return v && v.toLowerCase() !== 'guest' ? v : '';
}

function buildInitialMessage({ guestFirstName, propertyName, checkinDate, checkoutDate, checkinLink, guestLang }) {
  const isItalian = (guestLang || '').toLowerCase().startsWith('it');
  const name = cleanFirstName(guestFirstName);
  const from = formatStayDate(checkinDate, isItalian);
  const to = formatStayDate(checkoutDate, isItalian);
  if (isItalian) {
    return `Buongiorno${name ? ' ' + name : ''},

la aspettiamo a ${propertyName} dal ${from} al ${to}.

Come richiesto dalla legge italiana, prima dell'arrivo dobbiamo registrare tutti gli ospiti presso le autorità. Può farlo in pochi minuti qui:

→ ${checkinLink}

Tenga a portata di mano i documenti d'identità di tutti gli ospiti, bambini compresi, e il codice fiscale per i cittadini italiani. Non serve caricare foto: i documenti verranno verificati al suo arrivo.

Per qualsiasi domanda può rispondere a questo messaggio.

A presto,
Il Team Houzly`;
  }
  return `Hello${name ? ' ' + name : ''},

we look forward to welcoming you at ${propertyName} from ${from} to ${to}.

As required by Italian law, we need to register all guests with the authorities before arrival. You can do it in a few minutes here:

→ ${checkinLink}

Please have the ID documents of all guests at hand, children included. No photo upload is needed: documents will be checked on arrival.

If you have any questions, just reply to this message.

See you soon,
The Houzly Team`;
}

function buildReminderD3({ guestFirstName, propertyName, checkinLink, guestLang }) {
  const isItalian = (guestLang || '').toLowerCase().startsWith('it');
  const name = cleanFirstName(guestFirstName);
  if (isItalian) {
    return `Salve${name ? ' ' + name : ''}, un piccolo promemoria: il suo soggiorno a ${propertyName} inizia tra 3 giorni.

Se non l'ha ancora fatto, può completare il check-in online qui: ${checkinLink}

È richiesto dalla legge italiana e ci permette di accoglierla senza intoppi al suo arrivo. Bastano pochi minuti.

Grazie!`;
  }
  return `Hi${name ? ' ' + name : ''}, just a friendly reminder that your stay at ${propertyName} begins in 3 days.

If you haven't yet, please complete the online check-in here: ${checkinLink}

It is required by Italian law and helps us welcome you smoothly on arrival. It only takes a few minutes.

Thank you!`;
}

function buildReminderD1({ guestFirstName, propertyName, checkinLink, guestLang }) {
  const isItalian = (guestLang || '').toLowerCase().startsWith('it');
  const name = cleanFirstName(guestFirstName);
  const place = propertyName ? ` a ${propertyName}` : '';
  const placeEn = propertyName ? ` at ${propertyName}` : '';
  if (isItalian) {
    return `Salve${name ? ' ' + name : ''}, domani la aspettiamo${place}!

Non abbiamo ancora ricevuto i dati per la registrazione obbligatoria degli ospiti. Può completarli qui in pochi minuti, così al suo arrivo resterà solo la verifica dei documenti: ${checkinLink}

Grazie e buon viaggio!`;
  }
  return `Hi${name ? ' ' + name : ''}, we look forward to welcoming you tomorrow${placeEn}!

We haven't received the details for the mandatory guest registration yet. You can complete them here in a few minutes, so on arrival we'll only need to check your documents: ${checkinLink}

Thank you, and safe travels!`;
}
// ── COMPRESSIONE GZIP ─────────────────────────────────────────────
// Deve stare PRIMA di express.json e express.static, altrimenti non
// intercetta le risposte. Comprime HTML, JS, CSS e tutte le risposte
// JSON delle API (incluso /api/db) — riduzione tipica 70-85%.
app.use(compression({
  threshold: 1024,        // non comprime risposte sotto 1 kB (inutile)
  level: 6                // buon compromesso CPU/compressione
}));

app.use(express.json({ limit: "20mb" }));
app.use("/api/booking", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.get('/guida/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guida.html')));
// Static files con cache: i font (.otf/.woff2) non cambiano mai,
// quindi 1 anno di cache. HTML/JS sempre rivalidati (etag) per non
// servire versioni vecchie dopo un deploy.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(otf|ttf|woff|woff2|eot)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

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
    // Sicurezza: la password si imposta solo la PRIMA volta. Per cambiarla
    // serve quella attuale (/api/auth/change).
    const existing = await col.findOne({ _id: 'auth' });
    if (existing && existing.hash) return res.status(403).json({ ok: false, error: 'already_set' });
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
// Da settembre 2026 le prenotazioni NON stanno più nel blocco db.main ma
// nella collection dedicata "bookings" (un documento per prenotazione, con
// numero di versione _rev). Motivi: il blocco veniva riscritto per intero da
// dashboard e Cleaning Manager (rischio di sovrascritture), e la sincronizzazione
// live con Smoobu deve poter aggiornare una prenotazione senza toccare il resto.
const BOOKINGS_COL = 'bookings';

// Verifica la password admin senza bloccare la richiesta
async function hasAdminPin(req) {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (!pin) return false;
  try {
    const auth = await (await getCollection('auth')).findOne({ _id: 'auth' });
    if (!auth || !auth.hash) return false;
    return crypto.createHash('sha256').update(String(pin)).digest('hex') === auth.hash;
  } catch (e) { return false; }
}

// Migrazione una tantum: sposta db.main.prenotazioni nella collection bookings.
// Prima salva un backup completo del blocco in "backups".
let _bookingsMigrationPromise = null;
function ensureBookingsMigrated() {
  if (!_bookingsMigrationPromise) {
    _bookingsMigrationPromise = (async () => {
      const main = await getCollection('db');
      const doc = await main.findOne({ _id: 'main' });
      if (!doc || !Array.isArray(doc.prenotazioni) || doc.prenotazioni.length === 0) return;
      const now = new Date().toISOString();
      await (await getCollection('backups')).insertOne({
        _id: 'pre_bookings_migration_' + Date.now(), created_at: now, reason: 'prenotazioni → collection bookings', db: doc,
      });
      const col = await getCollection(BOOKINGS_COL);
      const list = doc.prenotazioni.filter(b => b && b.id);
      for (let i = 0; i < list.length; i += 500) {
        const ops = list.slice(i, i + 500).map(b => {
          const { _id, ...clean } = b;
          return { replaceOne: { filter: { _id: String(b.id) }, replacement: { ...clean, _id: String(b.id), _rev: 1, _updated_at: now }, upsert: true } };
        });
        await col.bulkWrite(ops, { ordered: false });
      }
      await col.createIndex({ checkin: 1 }).catch(() => {});
      await col.createIndex({ ota_num: 1 }).catch(() => {});
      await main.updateOne({ _id: 'main' }, { $unset: { prenotazioni: '' }, $set: { _bookings_migrated_at: now } });
      console.log(`[bookings] migrate ${list.length} prenotazioni nella collection dedicata`);
    })().catch(e => { _bookingsMigrationPromise = null; throw e; });
  }
  return _bookingsMigrationPromise;
}

// Migrazione anche all'avvio, così è fatta prima di qualunque altra scrittura
setTimeout(() => { ensureBookingsMigrated().catch(e => console.error('[bookings/migrate]', e.message)); }, 3000);

async function loadAllBookings() {
  const docs = await (await getCollection(BOOKINGS_COL)).find({}).toArray();
  return docs.map(({ _id, ...b }) => b);
}

// Applica le modifiche alle prenotazioni inviate dalla dashboard.
// upsert: [prenotazione con _rev]  delete: [id]
// Se una prenotazione è stata cambiata nel frattempo da altri (es. sync Smoobu)
// non la sovrascrive: la restituisce in "conflicts" con la versione attuale.
async function applyBookingChanges(changes) {
  const col = await getCollection(BOOKINGS_COL);
  const now = new Date().toISOString();
  const revs = {}, conflicts = [];
  for (const b of (changes.upsert || [])) {
    if (!b || !b.id) continue;
    const id = String(b.id);
    const { _id, _rev, _updated_at, ...clean } = b;
    const current = await col.findOne({ _id: id }, { projection: { _rev: 1 } });
    if (current && _rev != null && current._rev !== _rev) {
      const fresh = await col.findOne({ _id: id });
      const { _id: x, ...f } = fresh;
      conflicts.push(f);
      continue;
    }
    const nextRev = (current ? (current._rev || 0) : 0) + 1;
    const filter = current ? { _id: id, _rev: current._rev } : { _id: id };
    const r = await col.replaceOne(filter, { ...clean, _id: id, _rev: nextRev, _updated_at: now }, { upsert: !current });
    if (current && r.matchedCount === 0) {
      const fresh = await col.findOne({ _id: id });
      if (fresh) { const { _id: x, ...f } = fresh; conflicts.push(f); }
      continue;
    }
    revs[id] = nextRev;
  }
  let deleted = 0;
  for (const id of (changes.delete || [])) {
    const r = await col.deleteOne({ _id: String(id) });
    deleted += r.deletedCount;
  }
  return { revs, conflicts, deleted };
}

// GET /api/db            → blocco dati SENZA prenotazioni (usato anche dal Cleaning Manager)
// GET /api/db?bookings=1 → blocco + prenotazioni (solo con password admin)
app.get('/api/db', requireAdminAuth, async (req, res) => {
  try {
    await ensureBookingsMigrated();
    const col = await getCollection('db');
    const doc = await col.findOne({ _id: 'main' }, { projection: { prenotazioni: 0 } });
    if (!doc) return res.json({ ok: true, db: null });
    const { _id, ...db } = doc;
    if (req.query.bookings === '1') {
      if (!(await hasAdminPin(req))) return res.status(401).json({ ok: false, error: 'invalid_pin' });
      db.prenotazioni = await loadAllBookings();
      db._bookings_live = true;
    }
    res.json({ ok: true, db });
  } catch (e) {
    console.error('[GET /api/db]', e.message);
    res.json({ ok: false, db: null, error: e.message });
  }
});

// POST /api/db  body: { db, bookingChanges? }
// Il campo db.prenotazioni viene SEMPRE ignorato (le prenotazioni si salvano
// solo tramite bookingChanges, con password admin).
app.post('/api/db', requireAdminAuth, async (req, res) => {
  try {
    const { db, bookingChanges } = req.body || {};
    if (!db) return res.status(400).json({ ok: false });
    await ensureBookingsMigrated();
    const { _id, prenotazioni, _bookings_live, ...cleanDb } = db;
    const col = await getCollection('db');
    const prev = await col.findOne({ _id: 'main' }, { projection: { _bookings_migrated_at: 1, cleaning: 1 } });
    if (prev && prev._bookings_migrated_at) cleanDb._bookings_migrated_at = prev._bookings_migrated_at;
    // La sezione pulizie la gestiscono Cleaning Manager, webhook e sync:
    // il tool non la sovrascrive più con la copia caricata all'apertura.
    if (prev && prev.cleaning) cleanDb.cleaning = prev.cleaning;
    await col.replaceOne({ _id: 'main' }, { _id: 'main', ...cleanDb }, { upsert: true });
    let bookings = null;
    if (bookingChanges && ((bookingChanges.upsert || []).length || (bookingChanges.delete || []).length)) {
      if (!(await hasAdminPin(req))) return res.status(401).json({ ok: false, error: 'invalid_pin' });
      bookings = await applyBookingChanges(bookingChanges);
    }
    res.json({ ok: true, bookings });
  } catch (e) {
    console.error('[POST /api/db]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Cleaning Manager: accesso dedicato (solo la sezione pulizie) ──────
// L'app delle pulizie non vede più il resto dei dati (proprietari, contratti,
// prenotazioni). Accetta la password del tool oppure un PIN solo-pulizie
// impostato su Render con la variabile CLEANING_PIN.
async function isCleaningPin(pin) {
  if (!pin) return false;
  if (process.env.CLEANING_PIN && String(pin) === String(process.env.CLEANING_PIN)) return true;
  try {
    const auth = await (await getCollection('auth')).findOne({ _id: 'auth' });
    return !!(auth && auth.hash && crypto.createHash('sha256').update(String(pin)).digest('hex') === auth.hash);
  } catch (e) { return false; }
}
async function requireCleaningAuth(req, res, next) {
  const pin = req.headers['x-cleaning-pin'] || req.headers['x-admin-pin'] || req.query.pin;
  if (!pin) return res.status(401).json({ ok: false, error: 'missing_pin' });
  if (!(await isCleaningPin(pin))) return res.status(401).json({ ok: false, error: 'invalid_pin' });
  next();
}

app.post('/api/cleaning/login', async (req, res) => {
  try { res.json({ ok: await isCleaningPin((req.body || {}).pin) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/cleaning/db', requireCleaningAuth, async (req, res) => {
  try {
    const doc = await (await getCollection('db')).findOne({ _id: 'main' }, { projection: { cleaning: 1 } });
    res.json({ ok: true, db: { cleaning: (doc && doc.cleaning) || null } });
  } catch (e) { res.json({ ok: false, db: null, error: e.message }); }
});

app.post('/api/cleaning/db', requireCleaningAuth, async (req, res) => {
  try {
    const { db } = req.body || {};
    if (!db || !db.cleaning) return res.status(400).json({ ok: false, error: 'missing_cleaning' });
    await (await getCollection('db')).updateOne({ _id: 'main' }, { $set: { cleaning: db.cleaning } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Backup (con password: contiene tutti i dati, prenotazioni comprese) ──
app.get('/api/backup', requireAdminAuth, async (req, res) => {
  try {
    await ensureBookingsMigrated();
    const col = await getCollection('db');
    const doc = await col.findOne({ _id: 'main' });
    const { _id, ...db } = doc || {};
    db.prenotazioni = await loadAllBookings();
    const filename = `houzly-backup-${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ version: 4, date: new Date().toISOString(), db }, null, 2));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Ripristino (con password): blocco dati + sostituzione completa delle prenotazioni ──
app.post('/api/restore', requireAdminAuth, async (req, res) => {
  try {
    const { backup } = req.body;
    if (!backup) return res.status(400).json({ ok: false });
    await ensureBookingsMigrated();
    const { _id: _rid, prenotazioni, _bookings_live, ...cleanBackup } = backup;
    const now = new Date().toISOString();
    // backup di sicurezza dello stato attuale prima di sovrascrivere
    const curMain = await (await getCollection('db')).findOne({ _id: 'main' });
    const curBookings = await loadAllBookings();
    await (await getCollection('backups')).insertOne({
      _id: 'pre_restore_' + Date.now(), created_at: now, reason: 'prima di un ripristino',
      db: { ...(curMain || {}), prenotazioni: curBookings },
    });
    cleanBackup._bookings_migrated_at = cleanBackup._bookings_migrated_at || now;
    await (await getCollection('db')).replaceOne({ _id: 'main' }, { _id: 'main', ...cleanBackup }, { upsert: true });
    if (Array.isArray(prenotazioni)) {
      const col = await getCollection(BOOKINGS_COL);
      await col.deleteMany({});
      const list = prenotazioni.filter(b => b && b.id);
      for (let i = 0; i < list.length; i += 500) {
        await col.insertMany(list.slice(i, i + 500).map(b => {
          const { _id, _rev, ...clean } = b;
          return { ...clean, _id: String(b.id), _rev: 1, _updated_at: now };
        }), { ordered: false });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /api/smoobu/hmac-test ─────────────────────────────────────
// Diagnostica della migrazione HMAC. Chiama /api/me su Smoobu (sola
// lettura, innocua) e riporta se la firma viene accettata.
// Da aprire nel browser PRIMA di fidarsi del resto:
//   https://houzly-tool.onrender.com/api/smoobu-hmac-test
app.get('/api/smoobu-hmac-test', requireAdminAuth, async (req, res) => {
  const key = process.env.SMOOBU_API_KEY || '';
  const out = {
    modalita: SMOOBU_HMAC_ON ? 'HMAC (firmata)' : 'LEGACY (header Api-Key)',
    chiave_presente: !!key,
    chiave_mascherata: key ? key.slice(0, 4) + '…' + key.slice(-4) : null,
    secret_presente: !!SMOOBU_API_SECRET
  };
  if (!key) return res.status(500).json(Object.assign(out, { ok: false, errore: 'SMOOBU_API_KEY non impostata su Render' }));
  try {
    const r = await smoobuFetch('GET', '/api/me');
    const testo = await r.text();
    out.http = r.status;
    if (r.ok) {
      let me = {}; try { me = JSON.parse(testo); } catch (e) {}
      out.ok = true;
      out.esito = 'Smoobu ha accettato la richiesta';
      out.utente = [me.firstName, me.lastName].filter(Boolean).join(' ') || null;
    } else {
      out.ok = false;
      out.esito = r.status === 401
        ? 'Rifiutata (401): firma, chiave, orologio o nonce. Se sei in HMAC, controlla SMOOBU_API_SECRET.'
        : 'Rifiutata da Smoobu';
      out.risposta = testo.slice(0, 300);
    }
    res.status(r.ok ? 200 : 502).json(out);
  } catch (e) {
    res.status(500).json(Object.assign(out, { ok: false, errore: e.message }));
  }
});

// ── GET /api/smoobu-hmac-probe ────────────────────────────────────
// Prova le varianti di canonicalizzazione della query su /api/rates e
// riporta quale viene accettata da Smoobu. Serve una volta sola, per
// scoprire il formato giusto senza rideployare a tentativi.
app.get('/api/smoobu-hmac-probe', requireAdminAuth, async (req, res) => {
  if (!SMOOBU_HMAC_ON) return res.status(400).json({ ok: false, errore: 'SMOOBU_API_SECRET non impostata: la sonda serve solo in modalita HMAC' });

  const apt   = req.query.apartmentId || '2642743';
  const start = req.query.start || '2026-10-10';
  const end   = req.query.end   || '2026-10-13';

  const raw = `apartments[]=${apt}&end_date=${end}&start_date=${start}`;
  const enc = raw.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  const unsorted = `apartments[]=${apt}&start_date=${start}&end_date=${end}`;

  const varianti = [
    { nome: 'A · firma grezza, URL grezza (attuale)',      SMOOBU_QUERY_MODE: 'raw',          firma: raw,      url: raw },
    { nome: 'B · firma %5B%5D, URL %5B%5D',                SMOOBU_QUERY_MODE: 'encoded',      firma: enc,      url: enc },
    { nome: 'C · firma %5B%5D, URL grezza',                SMOOBU_QUERY_MODE: 'sign-encoded', firma: enc,      url: raw },
    { nome: 'D · firma grezza, URL %5B%5D',                SMOOBU_QUERY_MODE: 'sign-raw',     firma: raw,      url: enc },
    { nome: 'E · ordine di invio invece che alfabetico',   SMOOBU_QUERY_MODE: null,           firma: unsorted, url: unsorted }
  ];

  const esiti = [];
  for (const v of varianti) {
    try {
      const r = await smoobuRawFetch('GET', '/api/rates', v.firma, v.url, '');
      const testo = await r.text();
      esiti.push({
        variante: v.nome,
        http: r.status,
        accettata: r.ok,
        imposta_su_render: r.ok ? (v.SMOOBU_QUERY_MODE ? ('SMOOBU_QUERY_MODE=' + v.SMOOBU_QUERY_MODE) : 'richiede modifica al codice (ordine query)') : null,
        risposta: testo.slice(0, 120)
      });
    } catch (e) {
      esiti.push({ variante: v.nome, errore: e.message });
    }
    await new Promise(r => setTimeout(r, 350)); // gentile col rate limit
  }

  const vincente = esiti.find(e => e.accettata);
  res.json({
    appartamento: apt, dal: start, al: end,
    esito: vincente ? ('FUNZIONA: ' + vincente.variante) : 'nessuna variante accettata — mandare l\'esito a Smoobu',
    azione: vincente ? vincente.imposta_su_render : null,
    dettaglio: esiti
  });
});

// ── Smoobu Proxy (Houzly Tool — cleaning sync) ────────────────────
app.get('/api/smoobu/reservations', requireAdminAuth, async (req, res) => {
  try {
    // v53-HMAC: la chiave NON arriva piu' dal browser — solo da process.env.
    // req.query.apiKey viene ignorato (accettato per compatibilita' col frontend vecchio).
    const pageSize = req.query.pageSize || 100;
    const page     = req.query.page || 1;
    if (!process.env.SMOOBU_API_KEY) return res.status(500).json({ ok: false, error: 'missing_api_key_server' });
    const r = await smoobuFetch('GET', '/api/reservations', {
      query: { pageSize: pageSize, page: page }
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
app.post('/api/smoobu/sync', requireCleaningAuth, async (req, res) => {
  try {
    const col = await getCollection('db');
    const doc = await col.findOne({ _id: 'main' });
    if (!doc) return res.status(404).json({ ok: false, error: 'db_not_found' });

    const { _id, ...db } = doc;
    if (!db.cleaning) db.cleaning = { tasks: [], defaultChecklist: [], apiKey: '', lastSync: null };
    if (!db.cleaning.tasks) db.cleaning.tasks = [];

    // v53-HMAC: chiave e secret solo lato server. Il valore eventualmente
    // inviato dal frontend (req.body.apiKey) viene deliberatamente ignorato.
    if (!process.env.SMOOBU_API_KEY) return res.status(500).json({ ok: false, error: 'missing_api_key_server' });

    // Finestra temporale — scarica 60 giorni indietro + N mesi avanti
    // (60gg indietro per non perdere task recenti ancora in lavorazione)
    const months  = parseInt(req.body?.months || db.cleaning.syncMonths || 3);
    const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - 60);
    const toDate   = new Date(); toDate.setMonth(toDate.getMonth() + months);
    const fromISO  = fromDate.toISOString().split('T')[0];
    const toISO    = toDate.toISOString().split('T')[0];
    // Scarica tutte le pagine da Smoobu
    let allReservations = [];
    let page = 1;
    const MAX_PAGES = 20;
    while (page <= MAX_PAGES) {
      // departureFrom: forza Smoobu a includere prenotazioni con checkout >= fromISO
      const r = await smoobuFetch('GET', '/api/reservations', {
        query: { pageSize: 100, page: page, departureFrom: fromISO }
      });
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

    // ══════════════════════════════════════════════════════════════
    // RICONCILIAZIONE — rimozione task fantasma (v-reconcile 2026-08)
    //
    // Un task è "fantasma" se il suo smoobu_id non compare più tra le
    // prenotazioni attive di Smoobu (prenotazione cancellata o modificata
    // con cambio di id). Va rimosso anche se ha una pulitrice assegnata,
    // perché è proprio quel caso a creare i doppioni.
    //
    // PROTEZIONI (per non cancellare per errore):
    //  A. Non tocca mai i task manuali (senza smoobu_id)
    //  B. Non tocca mai i task 'done' (storico)
    //  C. Non tocca mai i task con checkout nel PASSATO o oggi
    //  D. SAFETY: se Smoobu ha restituito 0 prenotazioni (probabile errore
    //     temporaneo/API down), NON rimuove nulla — evita disastri di massa
    //  E. Non tocca mai i task con date_override (spostati a mano) —
    //     il lavoro manuale è sacro; eventuali fantasmi-con-override si
    //     gestiscono col rilevatore duplicati del frontend.
    // ══════════════════════════════════════════════════════════════
    const activeIds = new Set(relevant.map(b => String(b.id || '')));
    const todayISO = new Date().toISOString().split('T')[0];
    const before = db.cleaning.tasks.length;

    // SAFETY D: se non è arrivata nessuna prenotazione, salta la rimozione
    const safeToRemove = relevant.length > 0;

    db.cleaning.tasks = db.cleaning.tasks.filter(t => {
      if (!safeToRemove) return true;                         // D: Smoobu vuoto → non rimuovere nulla
      if (!t.smoobu_id) return true;                          // A: manuale → mai toccare
      if (t.status === 'done') return true;                   // B: completato → mai toccare (storico)
      if (t.date_override) return true;                       // E: data spostata a mano → mai toccare (protezione lavoro manuale)
      // Data effettiva del task
      const dEff = t.date_override || t.date;
      if (!dEff || dEff <= todayISO) return true;             // C: passato/oggi → mai toccare
      // Se la prenotazione è ancora attiva su Smoobu → mantieni
      if (activeIds.has(t.smoobu_id)) return true;
      // Altrimenti è un fantasma (prenotazione cancellata/modificata):
      // rimuovi anche se ha pulitrice assegnata, perché è obsoleto.
      return false;
    });
    const removed = before - db.cleaning.tasks.length;

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
    // Scrive SOLO la sezione pulizie (non riscrive più l'intero blocco dati)
    await col.updateOne({ _id: 'main' }, { $set: { cleaning: db.cleaning } }, { upsert: true });

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
        await col.updateOne({ _id: 'main' }, { $set: { cleaning: db.cleaning } }, { upsert: true });
      }
    }

    // ──────────────────────────────────────────────────────────────
    // PARTE 1b: SPECCHIO SMOOBU per la sincronizzazione live delle prenotazioni
    // (errori isolati: non devono mai rompere pulizie o check-in)
    try { await mirrorFromWebhook(b, action); }
    catch (mirrorErr) { console.error('[Mirror] error:', mirrorErr.message); }

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
// ── SINCRONIZZAZIONE LIVE PRENOTAZIONI (specchio Smoobu) ──────────
// ══════════════════════════════════════════════════════════════════
// Il server conserva i dati GREZZI di Smoobu (prenotazione + dettaglio prezzi)
// nella collection "smoobu_mirror". Non calcola nulla: la trasformazione in
// prenotazione del tool la fa la dashboard, con le stesse regole dell'import CSV.
// Si sincronizzano solo le prenotazioni con check-in dal BOOKINGS_SYNC_FROM.
const BOOKINGS_SYNC_FROM = process.env.BOOKINGS_SYNC_FROM || '2026-09-01';
const MIRROR_COL = 'smoobu_mirror';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function smoobuGetJson(path, query) {
  const r = await smoobuFetch('GET', path, query ? { query } : undefined);
  const text = await r.text();
  if (!r.ok) throw new Error(`Smoobu ${r.status} ${path}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function fetchPriceElements(id) {
  const d = await smoobuGetJson(`/api/reservations/${id}/price-elements`);
  return (d && d.priceElements) || [];
}

// Salva/aggiorna una prenotazione nello specchio (con il dettaglio prezzi)
async function mirrorUpsert(res, priceElements) {
  const col = await getCollection(MIRROR_COL);
  const now = new Date().toISOString();
  await col.updateOne({ _id: String(res.id) }, { $set: {
    res,
    priceElements: priceElements || [],
    arrival: (res.arrival || '').slice(0, 10),
    departure: (res.departure || '').slice(0, 10),
    modifiedAt: res.modifiedAt || null,
    cancelled: false,
    cancelled_at: null,
    synced_at: now,
  } }, { upsert: true });
}

async function mirrorMarkCancelled(id, reason) {
  const col = await getCollection(MIRROR_COL);
  const now = new Date().toISOString();
  const r = await col.updateOne({ _id: String(id), cancelled: { $ne: true } },
    { $set: { cancelled: true, cancelled_at: now, cancel_reason: reason || null, synced_at: now } });
  return r.modifiedCount;
}

// Dal webhook Smoobu: nuove/modificate → scarica dettaglio prezzi; cancellate → segna
async function mirrorFromWebhook(b, action) {
  const id = String(b.id || b.reservationId || '');
  if (!id) return;
  const arrival = (b.arrival || '').slice(0, 10);
  if (action === 'cancelledReservation' || action === 'deleteReservation') {
    await mirrorMarkCancelled(id, 'webhook:' + action);
    return;
  }
  if (b['is-blocked-booking'] === true) return;
  if (!arrival || arrival < BOOKINGS_SYNC_FROM) return;
  // Il webhook a volte arriva con dati parziali: rileggiamo la prenotazione completa
  let full = b;
  try { full = await smoobuGetJson(`/api/reservations/${id}`); } catch (e) { /* usiamo i dati del webhook */ }
  if (full.type === 'cancellation') { await mirrorMarkCancelled(id, 'type:cancellation'); return; }
  const pe = await fetchPriceElements(id);
  await mirrorUpsert(full, pe);
  console.log('[Mirror] aggiornata', id, action);
}

// Riallineamento completo con Smoobu (ogni ora da cron + pulsante "Sincronizza ora").
// Gira in background: la risposta HTTP torna subito, l'esito si legge da sync_status.
let _reconcileRunning = false;
async function reconcileMirror(trigger) {
  if (_reconcileRunning) return { ok: false, error: 'already_running' };
  _reconcileRunning = true;
  const started = new Date().toISOString();
  const status = await getCollection('sync_status');
  await status.updateOne({ _id: 'bookings' }, { $set: { running: true, started_at: started, trigger } }, { upsert: true });
  const out = { found: 0, updated: 0, unchanged: 0, cancelled: 0, errors: 0 };
  try {
    const col = await getCollection(MIRROR_COL);
    // 1. tutte le prenotazioni attive con check-in dal BOOKINGS_SYNC_FROM
    let items = [];
    for (let page = 1; page <= 30; page++) {
      const d = await smoobuGetJson('/api/reservations', { pageSize: 100, page, arrivalFrom: BOOKINGS_SYNC_FROM });
      const list = (d._embedded && d._embedded.bookings) || d.bookings || [];
      items = items.concat(list);
      const pages = d.page_count || 1;
      if (page >= pages || !list.length) break;
    }
    items = items.filter(b => b && b.id && b['is-blocked-booking'] !== true && b.type !== 'cancellation'
      && (b.arrival || '').slice(0, 10) >= BOOKINGS_SYNC_FROM);
    out.found = items.length;

    // 2. aggiorna solo quelle nuove o modificate (il dettaglio prezzi costa una chiamata)
    const existing = await col.find({}, { projection: { modifiedAt: 1, cancelled: 1, arrival: 1 } }).toArray();
    const byId = {};
    existing.forEach(m => { byId[m._id] = m; });
    for (const b of items) {
      const m = byId[String(b.id)];
      if (m && !m.cancelled && m.modifiedAt === (b.modifiedAt || null)) { out.unchanged++; continue; }
      try {
        const pe = await fetchPriceElements(b.id);
        await mirrorUpsert(b, pe);
        out.updated++;
        await sleep(120);
      } catch (e) { out.errors++; console.error('[reconcile]', b.id, e.message); }
    }

    // 3. nello specchio ma non più su Smoobu → cancellate
    //    Sicurezza: se Smoobu restituisce 0 prenotazioni ma lo specchio ne ha molte, non cancelliamo nulla
    const active = new Set(items.map(b => String(b.id)));
    const activeInMirror = existing.filter(m => !m.cancelled && (m.arrival || '') >= BOOKINGS_SYNC_FROM);
    if (items.length === 0 && activeInMirror.length > 5) {
      out.warning = 'Smoobu ha restituito 0 prenotazioni: cancellazioni saltate per sicurezza';
    } else {
      for (const m of activeInMirror) {
        if (!active.has(m._id)) out.cancelled += await mirrorMarkCancelled(m._id, 'reconcile:not_in_smoobu');
      }
    }
    await status.updateOne({ _id: 'bookings' }, { $set: { running: false, finished_at: new Date().toISOString(), last_ok: true, last_result: out, last_error: null } });
    console.log('[reconcile] ok', JSON.stringify(out));
    return { ok: true, ...out };
  } catch (e) {
    await status.updateOne({ _id: 'bookings' }, { $set: { running: false, finished_at: new Date().toISOString(), last_ok: false, last_error: e.message, last_result: out } });
    console.error('[reconcile] error', e.message);
    return { ok: false, error: e.message, ...out };
  } finally {
    _reconcileRunning = false;
  }
}

// POST /api/cron/bookings/reconcile  → da cron-job.org ogni ora (x-cron-secret)
app.post('/api/cron/bookings/reconcile', requireCronSecret, (req, res) => {
  reconcileMirror('cron').catch(() => {});
  res.json({ ok: true, started: true });
});

// POST /api/bookings/sync-now  → pulsante "Sincronizza ora" della dashboard
app.post('/api/bookings/sync-now', requireAdminAuth, (req, res) => {
  if (_reconcileRunning) return res.json({ ok: true, started: false, running: true });
  reconcileMirror('manual').catch(() => {});
  res.json({ ok: true, started: true });
});

// GET /api/bookings/sync-status
app.get('/api/bookings/sync-status', requireAdminAuth, async (req, res) => {
  try {
    const st = await (await getCollection('sync_status')).findOne({ _id: 'bookings' });
    res.json({ ok: true, sync_from: BOOKINGS_SYNC_FROM, status: st || null, running: _reconcileRunning });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/bookings/mirror?since=ISO  → voci dello specchio aggiornate dopo "since"
// (senza since: tutte). La dashboard le trasforma in prenotazioni.
app.get('/api/bookings/mirror', requireAdminAuth, async (req, res) => {
  try {
    const q = { arrival: { $gte: BOOKINGS_SYNC_FROM } };
    if (req.query.since) q.synced_at = { $gt: String(req.query.since) };
    const docs = await (await getCollection(MIRROR_COL)).find(q).toArray();
    const items = docs.map(m => ({
      id: m._id, cancelled: !!m.cancelled, synced_at: m.synced_at, modifiedAt: m.modifiedAt,
      res: m.res ? {
        id: m.res.id, 'reference-id': m.res['reference-id'], type: m.res.type,
        arrival: m.res.arrival, departure: m.res.departure,
        apartment: m.res.apartment, channel: m.res.channel,
        'guest-name': m.res['guest-name'], firstname: m.res.firstname, lastname: m.res.lastname,
        email: m.res.email, adults: m.res.adults, children: m.res.children,
        notice: m.res.notice, price: m.res.price, 'price-details': m.res['price-details'],
        'city-tax': m.res['city-tax'], 'commission-included': m.res['commission-included'],
        language: m.res.language,
      } : null,
      priceElements: (m.priceElements || []).map(p => ({ type: p.type, name: p.name, amount: p.amount, priceIncludedInId: p.priceIncludedInId })),
    }));
    res.json({ ok: true, sync_from: BOOKINGS_SYNC_FROM, server_time: new Date().toISOString(), items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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

// Helper: headers Smoobu — DEPRECATO dal 08/09/2026, non piu' usato.
// Non puo' firmare in HMAC perche' la firma dipende da metodo, path e query.
// Ogni chiamata a Smoobu passa ora da smoobuFetch(). Non riutilizzare.
function smoobuHdr() {
  return { 'Api-Key': SMOOBU_API_KEY, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' };
}

// ── GET /api/booking/apartments ───────────────────────────────────
// Recupera lista appartamenti Smoobu con i loro ID.
// Usare una volta per mappare smoobuId nelle PROPERTIES del sito.
// Esempio: https://houzly-tool.onrender.com/api/booking/apartments
app.get('/api/booking/apartments', bookingCors, async (req, res) => {
  try {
    const r = await smoobuFetch('GET', '/api/apartments');
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
      smoobuFetch('GET', '/api/rates', { query: { 'apartments[]': apartmentId, start_date: arrival, end_date: departure } }),
      smoobuFetch('GET', `/api/apartments/${apartmentId}`)
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
    const r = await smoobuFetch('GET', '/api/rates', {
      query: { 'apartments[]': apartmentId, start_date: start, end_date: end }
    });
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
    const r = await smoobuFetch('POST', '/api/reservations', { body: payload });
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
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

// ══════════════════════════════════════════════════════════════════
// ── DELETE /api/cloudinary/delete-asset — elimina UNA foto ────────
//
//  Usata dal Photo Studio quando l'utente sceglie "Anche da Cloudinary"
//  nel dialog di rimozione foto singola.
//
//  Body JSON:  { publicId: "houzly-site/villa-belvedere/abc123" }
//  Auth:       X-Admin-PIN header (o ?pin= query)
//
//  Flow:
//   1. Verifica esistenza asset (GET resources/image/upload/{publicId})
//   2. Se esiste → firma richiesta e chiama /image/destroy
//   3. Ritorna { ok:true, deleted:true, result:"ok" }
//   4. Se non esiste → { ok:true, deleted:false, result:"not_found" }
//      (non è errore: la foto era già stata cancellata a mano da qualcuno)
//
//  invalidate:true → svuota anche la CDN cache di Cloudinary, così la foto
//  sparisce subito dagli URL già in cache invece che dopo ore.
// ══════════════════════════════════════════════════════════════════
app.options('/api/cloudinary/delete-asset', cloudinaryCors, (req, res) => {
  res.sendStatus(204);
});

app.delete('/api/cloudinary/delete-asset', cloudinaryCors, requireAdminAuth, async (req, res) => {
  try {
    const publicId = (req.body && req.body.publicId) || req.query.publicId;

    if (!publicId || typeof publicId !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing_public_id' });
    }
    if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return res.status(500).json({
        ok: false,
        error: 'cloudinary_credentials_not_configured',
      });
    }

    const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
    const authHeader = { 'Authorization': `Basic ${auth}` };

    // ── Step 1: verifica esistenza asset (evita "silent not found") ──
    const verifyUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/image/upload/${encodeURIComponent(publicId)}`;
    const verifyResp = await fetch(verifyUrl, { method: 'GET', headers: authHeader });

    if (verifyResp.status === 404) {
      // Asset non trovato: probabilmente già cancellato a mano.
      // Non è un errore per il client — comunichiamolo per trasparenza.
      return res.json({
        ok: true,
        deleted: false,
        result: 'not_found',
        publicId,
        message: 'Asset non trovato su Cloudinary (forse già cancellato)',
      });
    }
    if (!verifyResp.ok) {
      const txt = await verifyResp.text().catch(() => '');
      return res.status(500).json({
        ok: false,
        error: `cloudinary_verify_failed_${verifyResp.status}`,
        detail: txt.slice(0, 300),
      });
    }

    // ── Step 2: elimina via /image/destroy (richiesta firmata) ──
    const timestamp = Math.floor(Date.now() / 1000);
    // Signature = SHA1("invalidate=true&public_id={pid}&timestamp={ts}" + API_SECRET)
    // NB: parametri in ordine alfabetico, escluso api_key e signature.
    const paramsToSign = `invalidate=true&public_id=${publicId}&timestamp=${timestamp}`;
    const signature = crypto
      .createHash('sha1')
      .update(paramsToSign + CLOUDINARY_API_SECRET)
      .digest('hex');

    const destroyUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`;
    const destroyBody = new URLSearchParams({
      public_id: publicId,
      timestamp: String(timestamp),
      api_key: CLOUDINARY_API_KEY,
      signature: signature,
      invalidate: 'true',
    });

    const destroyResp = await fetch(destroyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: destroyBody.toString(),
    });

    const destroyData = await destroyResp.json().catch(() => ({}));

    if (!destroyResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `cloudinary_destroy_failed_${destroyResp.status}`,
        detail: destroyData,
      });
    }

    // Cloudinary risponde { result: "ok" } se cancellato, "not found" se già rimosso
    const result = destroyData.result || 'unknown';
    console.log(`[cloudinary/delete-asset] ${publicId} → ${result}`);
    return res.json({
      ok: true,
      deleted: result === 'ok',
      result,
      publicId,
    });

  } catch (e) {
    console.error('[cloudinary/delete-asset]', e.message);
    return res.status(500).json({
      ok: false,
      error: 'internal_error',
      detail: String(e && e.message || e),
    });
  }
});


// ══════════════════════════════════════════════════════════════════
// ── POST /api/cloudinary/delete-many — elimina PIÙ foto in batch ──
//
//  Usata dal Photo Studio per "Rimuovi N dal sito + Cloudinary"
//  (rimozione multipla via checkbox selection).
//
//  Body JSON:  { publicIds: ["path/a", "path/b", ...] }  max 100/chiamata
//  Auth:       X-Admin-PIN header (o ?pin= query)
//
//  Risposta:
//   {
//     ok: true,
//     requested: 15,
//     deleted:  ["public/id/a","public/id/b"],   // effettivamente cancellati
//     notFound: ["public/id/c"],                  // non esistevano già
//     failed:   [{ publicId, error }],            // errori specifici
//     partial: false                              // true se Cloudinary ha truncato
//   }
//
//  Usa l'endpoint Admin DELETE resources/image/upload che accetta
//  fino a 100 public_ids per chiamata (più efficiente del loop singolo).
//  Auth via Basic Auth (API Key + Secret), no signature.
// ══════════════════════════════════════════════════════════════════
app.options('/api/cloudinary/delete-many', cloudinaryCors, (req, res) => {
  res.sendStatus(204);
});

app.post('/api/cloudinary/delete-many', cloudinaryCors, requireAdminAuth, async (req, res) => {
  try {
    const publicIds = (req.body && req.body.publicIds) || [];

    if (!Array.isArray(publicIds) || publicIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'missing_public_ids' });
    }
    if (publicIds.length > 100) {
      return res.status(400).json({
        ok: false,
        error: 'too_many_public_ids',
        hint: 'max 100 per chiamata (limite Cloudinary Admin API)',
      });
    }
    if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return res.status(500).json({
        ok: false,
        error: 'cloudinary_credentials_not_configured',
      });
    }

    const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
    const authHeader = { 'Authorization': `Basic ${auth}` };

    // Costruisco query string: public_ids[]=id1&public_ids[]=id2...
    // + invalidate=true per svuotare anche la CDN cache
    const params = new URLSearchParams();
    publicIds.forEach(pid => params.append('public_ids[]', pid));
    params.append('invalidate', 'true');

    const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/image/upload?${params.toString()}`;

    const resp = await fetch(url, {
      method: 'DELETE',
      headers: authHeader,
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return res.status(500).json({
        ok: false,
        error: `cloudinary_bulk_delete_failed_${resp.status}`,
        detail: data,
      });
    }

    // Cloudinary risponde con { deleted: { "id1": "deleted", "id2": "not_found" } }
    const deletedMap = data.deleted || {};
    const deleted = [];
    const notFound = [];
    const failed = [];

    Object.entries(deletedMap).forEach(([pid, status]) => {
      if (status === 'deleted') deleted.push(pid);
      else if (status === 'not_found') notFound.push(pid);
      else failed.push({ publicId: pid, error: status });
    });

    console.log(`[cloudinary/delete-many] requested:${publicIds.length} deleted:${deleted.length} notFound:${notFound.length} failed:${failed.length}`);
    return res.json({
      ok: true,
      requested: publicIds.length,
      deleted,
      notFound,
      failed,
      partial: data.partial || false,
    });

  } catch (e) {
    console.error('[cloudinary/delete-many]', e.message);
    return res.status(500).json({
      ok: false,
      error: 'internal_error',
      detail: String(e && e.message || e),
    });
  }
});

// ─────────────────────────────────────────────────────────────────

// ── Reset checklist su tutti i task (one-shot) ───────────────────
// GET /api/cleaning/reset-checklist
// Sostituisce la checklist su TUTTI i task con quella di default corrente
app.get('/api/cleaning/reset-checklist', requireCleaningAuth, async (req, res) => {
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

    await col.updateOne({ _id: 'main' }, { $set: { cleaning: db.cleaning } }, { upsert: true });
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
    const r = await smoobuFetch('GET', '/api/apartments');
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
    const before = await col.findOne({ _id: id });
    if (!before) return res.status(404).json({ ok: false, error: 'property_not_found' });
    await col.updateOne({ _id: id }, { $set: toSet });
    const updated = await col.findOne({ _id: id });

    // Accensione/spegnimento del check-in: allinea le prenotazioni future
    let sessionsChanged = 0, imported = null, importError = null;
    if ('checkin_required' in toSet && toSet.checkin_required !== before.checkin_required) {
      if (toSet.checkin_required) {
        const startIso = new Date().toISOString();
        // 1. scarica da Smoobu le prenotazioni future (anche quelle mai arrivate via webhook)
        try { imported = await importFutureSessionsFromSmoobu(updated); }
        catch (e) { importError = e.message; console.error('[checkin/import]', e.message); }
        // 2. riattiva quelle già registrate come "struttura spenta"
        await activateFutureSessions(updated);
        await rescheduleEarlyLinks(updated);
        // prenotazioni che riceveranno il link (nuove o riattivate adesso)
        sessionsChanged = await (await getCollection('checkin_sessions')).countDocuments({
          'property.smoobu_id': String(updated.smoobu_apartment_id),
          status: 'pending',
          initial_message_sent_at: null,
          initial_message_due_at: { $gte: startIso },
        });
      } else {
        sessionsChanged = await suspendFutureSessions(updated);
      }
    }
    res.json({ ok: true, property: updated, sessionsChanged, imported, importError });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Scarica da Smoobu le prenotazioni future di un appartamento (no blocchi, no cancellate)
async function fetchFutureSmoobuReservations(apartmentId) {
  const today = new Date().toISOString().slice(0, 10);
  let all = [];
  for (let page = 1; page <= 10; page++) {
    const r = await smoobuFetch('GET', '/api/reservations', {
      query: { pageSize: 100, page: page, apartmentId: String(apartmentId), departureFrom: today },
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Smoobu ${r.status}: ${text.slice(0, 200)}`);
    }
    const data = await r.json();
    const items = (data._embedded && data._embedded.bookings) || data.bookings || data.reservations || [];
    if (!items.length) break;
    all = all.concat(items);
    const totalPages = data.page_count || data.total_pages || data.pages || 1;
    if (page >= totalPages) break;
  }
  return all.filter(b =>
    b['is-blocked-booking'] !== true &&
    String(b.apartment?.id || '') === String(apartmentId) &&
    (b.departure || '').slice(0, 10) >= today &&
    b.type !== 'cancellation' &&
    String(b.status || '').toLowerCase() !== 'cancelled'
  );
}

// Registra nel check-in le prenotazioni future di una struttura prese da Smoobu.
// Usa la stessa logica del webhook: le nuove vengono create, le esistenti aggiornate.
async function importFutureSessionsFromSmoobu(prop) {
  const list = await fetchFutureSmoobuReservations(prop.smoobu_apartment_id);
  let created = 0, updated = 0;
  for (const b of list) {
    const r = await upsertCheckinSession(b, 'import');
    if (r?.action === 'created') created++;
    else if (r?.action === 'updated') updated++;
  }
  return { found: list.length, created, updated };
}

// ── Check-in: allineamento prenotazioni quando si accende/spegne una struttura ──
// Accensione: le prenotazioni future già registrate come "struttura disattivata"
// diventano "da compilare" e il link parte col solito ritardo (cron dispatch).
async function activateFutureSessions(prop) {
  const col = await getCollection('checkin_sessions');
  const today = new Date().toISOString().slice(0, 10);
  const list = await col.find({
    'property.smoobu_id': String(prop.smoobu_apartment_id),
    status: 'excluded_property_disabled',
    'booking.departure': { $gte: today },
    is_test: { $ne: true },
  }).toArray();
  let n = 0;
  for (const s of list) {
    if (!s.booking?.departure) continue;
    const tokenData = generateCheckinToken(s.smoobu_booking_id, s.booking.departure);
    const set = {
      status: 'pending',
      exclusion_reason: null,
      access_token: tokenData.token,
      token_expires_at: tokenData.expiresAt,
      'property.prop_code': prop.prop_code || null,
      'property.region': prop.region || null,
      'property.city': prop.city || null,
      updated_at: new Date().toISOString(),
    };
    if (!s.initial_message_sent_at) {
      set.initial_message_due_at = computeInitialDueAt(s.booking.arrival);
      set.initial_message_sent_at = null;
      set.initial_message_attempts = 0;
      set.initial_dispatch_claimed_at = null;
    }
    await col.updateOne({ _id: s._id }, { $set: set });
    n++;
  }
  return n;
}

// Spegnimento: le prenotazioni future ancora "da compilare" (nessun dato
// inserito) tornano "struttura disattivata": niente link né promemoria.
// Quelle già iniziate o complete restano come sono.
async function suspendFutureSessions(prop) {
  const col = await getCollection('checkin_sessions');
  const today = new Date().toISOString().slice(0, 10);
  const r = await col.updateMany(
    {
      'property.smoobu_id': String(prop.smoobu_apartment_id),
      status: 'pending',
      'booking.departure': { $gte: today },
      is_test: { $ne: true },
    },
    { $set: {
      status: 'excluded_property_disabled',
      exclusion_reason: 'Property has checkin_required=false',
      initial_message_due_at: null,
      updated_at: new Date().toISOString(),
    } }
  );
  return r.modifiedCount;
}

// GET /api/debug/smoobu-sample?pin=XXXX            → 2 prenotazioni recenti per canale
// GET /api/debug/smoobu-sample?pin=XXXX&id=12345   → una prenotazione precisa (ID Smoobu)
// Diagnosi SOLA LETTURA per progettare la sincronizzazione live delle prenotazioni:
// mostra tutti i campi della prenotazione e il dettaglio prezzi (price-elements).
app.get('/api/debug/smoobu-sample', requireAdminAuth, async (req, res) => {
  try {
    const getJson = async (path, query) => {
      const r = await smoobuFetch('GET', path, query ? { query } : undefined);
      const text = await r.text();
      let data = null; try { data = JSON.parse(text); } catch (e) {}
      return { status: r.status, data, raw: data ? undefined : text.slice(0, 300) };
    };
    const withPrices = async (b) => {
      const pe = await getJson(`/api/reservations/${b.id}/price-elements`);
      return { prenotazione: b, price_elements: pe.data || { http: pe.status, raw: pe.raw } };
    };

    if (req.query.id) {
      const one = await getJson(`/api/reservations/${encodeURIComponent(req.query.id)}`);
      if (!one.data) return res.json({ ok: false, http: one.status, raw: one.raw });
      return res.json({ ok: true, ...(await withPrices(one.data)) });
    }

    // Prenotazioni con partenza negli ultimi 45 giorni o future
    const from = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const list = await getJson('/api/reservations', { pageSize: 100, page: 1, departureFrom: from });
    const items = (list.data && ((list.data._embedded && list.data._embedded.bookings) || list.data.bookings)) || [];
    const byChannel = {};
    for (const b of items) {
      if (b['is-blocked-booking']) continue;
      const ch = (b.channel && b.channel.name) || 'sconosciuto';
      byChannel[ch] = byChannel[ch] || [];
      if (byChannel[ch].length < 2) byChannel[ch].push(b);
    }
    const out = {};
    for (const [ch, arr] of Object.entries(byChannel)) {
      out[ch] = [];
      for (const b of arr) out[ch].push(await withPrices(b));
    }
    res.json({
      ok: true,
      http_lista: list.status,
      totale_nella_pagina: items.length,
      paginazione: list.data ? { page_count: list.data.page_count, total_items: list.data.total_items, page_size: list.data.page_size } : null,
      canali: out,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/checkin/debug/property?pin=XXXX&name=belvedere
// Diagnosi: cosa restituisce Smoobu per la struttura e cosa c'è nel database.
app.get('/api/checkin/debug/property', requireAdminAuth, async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'missing_name' });
    const rx = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const props = await (await getCollection('checkin_properties_config')).find({ name: rx }).toArray();
    if (!props.length) return res.json({ ok: false, error: 'struttura_non_trovata', cercato: name });
    const out = [];
    const col = await getCollection('checkin_sessions');
    const today = new Date().toISOString().slice(0, 10);
    for (const prop of props) {
      const item = {
        struttura: prop.name, config_id: prop._id, smoobu_apartment_id: prop.smoobu_apartment_id,
        checkin_required: prop.checkin_required, region: prop.region,
      };
      // Risposta grezza di Smoobu (solo i campi utili)
      try {
        const r = await smoobuFetch('GET', '/api/reservations', {
          query: { pageSize: 100, page: 1, apartmentId: String(prop.smoobu_apartment_id), departureFrom: today },
        });
        const text = await r.text();
        item.smoobu_http = r.status;
        let data = null;
        try { data = JSON.parse(text); } catch (e) { item.smoobu_body = text.slice(0, 300); }
        if (data) {
          const items = (data._embedded && data._embedded.bookings) || data.bookings || data.reservations || [];
          item.smoobu_totale_risposta = items.length;
          item.smoobu_chiavi_prima_prenotazione = items[0] ? Object.keys(items[0]) : [];
          item.smoobu_prenotazioni = items.slice(0, 15).map(b => ({
            id: b.id, arrivo: b.arrival, partenza: b.departure,
            apartment: b.apartment, canale: b.channel?.name,
            nome_letto: getSmoobuGuestNames(b),
            blocco: b['is-blocked-booking'], type: b.type, status: b.status,
          }));
        }
      } catch (e) { item.smoobu_errore = e.message; }
      // Database
      const sessions = await col.find(
        { 'property.smoobu_id': String(prop.smoobu_apartment_id), 'booking.departure': { $gte: today } },
        { projection: { status: 1, exclusion_reason: 1, 'booking.arrival': 1, 'booking.primary_guest_name': 1, initial_message_due_at: 1, initial_message_sent_at: 1 } }
      ).toArray();
      item.database_future = sessions.map(x => ({
        id: x._id, stato: x.status, motivo: x.exclusion_reason, arrivo: x.booking?.arrival,
        nome: x.booking?.primary_guest_name, link_previsto: x.initial_message_due_at, link_inviato: x.initial_message_sent_at,
      }));
      out.push(item);
    }
    res.json({ ok: true, oggi: today, strutture: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/checkin/properties/:id/import → riallinea le prenotazioni future da Smoobu
app.post('/api/checkin/properties/:id/import', requireAdminAuth, async (req, res) => {
  try {
    const prop = await (await getCollection('checkin_properties_config')).findOne({ _id: req.params.id });
    if (!prop) return res.status(404).json({ ok: false, error: 'property_not_found' });
    const imported = await importFutureSessionsFromSmoobu(prop);
    const activated = prop.checkin_required ? await activateFutureSessions(prop) : 0;
    const rescheduled = await rescheduleEarlyLinks(prop);
    res.json({ ok: true, imported, activated, rescheduled });
  } catch (e) {
    console.error('[checkin/properties/import]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Quante prenotazioni future verrebbero attivate accendendo la struttura
app.get('/api/checkin/properties/:id/preview', requireAdminAuth, async (req, res) => {
  try {
    const prop = await (await getCollection('checkin_properties_config')).findOne({ _id: req.params.id });
    if (!prop) return res.status(404).json({ ok: false, error: 'property_not_found' });
    const today = new Date().toISOString().slice(0, 10);
    const registered = await (await getCollection('checkin_sessions')).countDocuments({
      'property.smoobu_id': String(prop.smoobu_apartment_id),
      'booking.departure': { $gte: today },
      is_test: { $ne: true },
    });
    let futureBookings = null, smoobuError = null;
    try { futureBookings = (await fetchFutureSmoobuReservations(prop.smoobu_apartment_id)).length; }
    catch (e) { smoobuError = e.message; }
    res.json({ ok: true, futureBookings, registered, smoobuError });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ── Check-in: Booking evaluation ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Nome e cognome dell'ospite da una prenotazione Smoobu.
// Smoobu usa "firstname"/"lastname" e "guest-name" (API e webhook);
// "first-name"/"last-name" sono tenuti per compatibilità.
function getSmoobuGuestNames(booking) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = booking[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  let first = pick('firstname', 'first-name', 'firstName', 'first_name');
  let last = pick('lastname', 'last-name', 'lastName', 'last_name');
  if (!first && !last) {
    const full = pick('guest-name', 'guestName', 'guest_name', 'name');
    if (full) {
      const parts = full.split(/\s+/);
      first = parts.shift() || '';
      last = parts.join(' ');
    }
  }
  return { firstName: first, lastName: last };
}

async function evaluateBooking(booking) {
  const arrival = (booking.arrival || '').split('T')[0];
  const departure = (booking.departure || '').split('T')[0];
  const nights = calculateNights(arrival, departure);

  // Regola 1: durata > 540 giorni → locazione ordinaria, fuori perimetro
  if (nights > 540) {
    return { status: 'excluded_long_term', reason: `Duration ${nights} nights exceeds 540`, nights };
  }

  // (Regola 2 rimossa a settembre 2026: anche i soggiorni oltre 30 notti
  //  ricevono il link — Houzly vuole sempre i documenti degli ospiti)

  // Regola 3: nome ospite vuoto → blocco manutenzione/chiusura
  const { firstName, lastName } = getSmoobuGuestNames(booking);
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
  const nameWords = fullName.split(/[^a-zà-ÿ]+/).filter(Boolean);
  const hasSuspiciousName = suspiciousKeywords.some(k =>
    k.includes(' ') ? fullName.includes(k) : nameWords.includes(k));
  const hasInternalEmail = internalEmails.includes(guestEmail);
  if (hasSuspiciousName || hasInternalEmail) {
    return { status: 'needs_review', reason: 'Suspicious name or internal email (possible forgotten [INTERNAL] marker)', nights };
  }

  // Regola 7: tutto ok → flusso normale
  return { status: 'pending', reason: null, nights, propConfig };
}

// Slot ospite vuoto (schema check-in senza foto, settembre 2026)
function buildEmptyGuest(slot, firstName, lastName) {
  return {
    slot,
    first_name: firstName || null,
    last_name: lastName || null,
    sex: null,
    date_of_birth: null,
    is_minor: false,
    // Nascita: comune + provincia se Italia, altrimenti solo nazione
    birth_country: null,
    birth_city: null,
    birth_province: null,
    nationality: null,
    // Codice fiscale: obbligatorio per tutti i cittadini italiani
    tax_code: null,
    tax_code_verified: false,
    tax_code_warnings: [],
    // Documento: obbligatorio per tutti gli ospiti, neonati compresi
    document_type: null,            // ID_CARD | PASSPORT | DRIVING_LICENSE
    document_number: null,
    document_issue_country: null,
    document_issue_city: null,      // obbligatorio se rilasciato in Italia
    document_expiry_date: null,     // facoltativo
    // Residenza: solo ospite principale (slot 1)
    address_street: null,
    address_zip: null,
    address_city: null,
    address_province: null,
    address_country: null,
    submitted_at: null,
    privacy_consent: false,
    privacy_consent_at: null,
  };
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
  const { firstName, lastName } = getSmoobuGuestNames(booking);
  const adults = parseInt(booking.adults) || 1;
  const children = parseInt(booking.children) || 0;
  const totalGuests = adults + children;

  const apartmentId = booking.apartment?.id ? String(booking.apartment.id) : null;
  const propertyName = booking.apartment?.name || booking.apartmentName || 'N/D';

  const bookingSnapshot = {
    channel_id: booking.channel?.id || null,
    channel_name: booking.channel?.name || null,
    reference_id: booking['reference-id'] || null,
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
    // Vecchio stato "soggiorno lungo" (regola rimossa): prende lo stato della nuova valutazione
    if (existing.status === 'long_stay_review' && evaluation.status !== 'pending') {
      updates.status = evaluation.status;
      updates.exclusion_reason = evaluation.reason;
    }
    // Se lo status attuale era excluded/review e la ri-valutazione dà pending, riattiva
    if ((existing.status.startsWith('excluded_') || existing.status === 'long_stay_review') && evaluation.status === 'pending') {
      updates.status = 'pending';
      updates.exclusion_reason = null;
      if (tokenData) {
        updates.access_token = tokenData.token;
        updates.token_expires_at = tokenData.expiresAt;
        // Se il messaggio iniziale non è mai partito, lo programma ora
        if (!existing.initial_message_sent_at) {
          updates.initial_message_due_at = computeInitialDueAt(arrival);
          updates.initial_message_attempts = 0;
          updates.initial_dispatch_claimed_at = null;
        }
      }
    }
    // Data di arrivo cambiata e link non ancora partito: riprogramma l'invio
    if (!updates.initial_message_due_at && !existing.initial_message_sent_at && existing.initial_message_due_at
        && existing.booking?.arrival !== arrival && ['pending', 'partial'].includes(existing.status)) {
      updates.initial_message_due_at = computeInitialDueAt(arrival);
    }
    // Nome dell'ospite principale rimasto vuoto (vecchio bug di lettura): lo completa
    const g1 = (existing.guests || [])[0];
    if (g1 && !g1.first_name && !g1.last_name && (firstName || lastName)) {
      updates['guests.0.first_name'] = firstName || null;
      updates['guests.0.last_name'] = lastName || null;
    }
    // Se la prenotazione ora prevede più ospiti, aggiunge gli slot mancanti
    // (non rimuove mai slot esistenti: potrebbero contenere dati già inseriti)
    const pushOps = {};
    const currentSlots = Array.isArray(existing.guests) ? existing.guests.length : 0;
    if (totalGuests > currentSlots) {
      pushOps.$push = { guests: { $each: Array.from({ length: totalGuests - currentSlots },
        (_, i) => buildEmptyGuest(currentSlots + i + 1, null, null)) } };
      if (existing.status === 'complete') updates.status = 'partial';
    }
    await sessionsCol.updateOne({ _id: sessionId }, { $set: updates, ...pushOps });
    return { ok: true, action: 'updated', status: updates.status || existing.status };
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
    guests: Array.from({ length: totalGuests }, (_, i) => buildEmptyGuest(i + 1,
      i === 0 ? firstName : null, i === 0 ? lastName : null)),
    messages_sent: [],
    // Invio link programmato (vedi cron /api/cron/checkin/dispatch)
    initial_message_due_at: (evaluation.status === 'pending' && tokenData)
      ? computeInitialDueAt(arrival)
      : null,
    initial_message_sent_at: null,
    initial_message_attempts: 0,
    initial_dispatch_claimed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    archived_at: null,
  };
  await sessionsCol.insertOne(newSession);

  // Il messaggio iniziale NON parte subito: lo invia il cron /api/cron/checkin/dispatch
  // dopo CHECKIN_INITIAL_DELAY_MINUTES, così arriva dopo il primo messaggio automatico.

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
  const guestEmail = session.booking.primary_guest_email;
  let result;
  let channel;

  // Prenotazione diretta senza email: non c'è nessun recapito, inutile provare
  if (isDirectBooking && !guestEmail) {
    const sessionsCol0 = await getCollection('checkin_sessions');
    await sessionsCol0.updateOne({ _id: session._id }, {
      $set: { initial_message_due_at: null },
      $push: { messages_sent: {
        type: 'initial', channel: 'none', sent_at: new Date().toISOString(),
        success: false, error: 'Nessun recapito: prenotazione diretta senza email ospite',
      } },
    });
    return { success: false, error: 'no_guest_email', noRecipient: true };
  }

  if (isDirectBooking && guestEmail) {
    // Direct booking → email via Resend
    const html = messageText.replace(/\n/g, '<br>');
    result = await sendEmailFallback(session.booking.primary_guest_email, 'Houzly Online Check-in', html);
    channel = 'email';
  } else {
    // OTA → chat Smoobu (rimbalza su Airbnb/Booking nativi)
    result = await sendSmoobuChatMessage(session.smoobu_booking_id, messageText);
    channel = 'smoobu_chat';
    // Smoobu non ha un destinatario per questa prenotazione (di solito manca l'email)
    if (!result.success && /recipient/i.test(result.error || '')) {
      if (guestEmail) {
        const html = messageText.replace(/\n/g, '<br>');
        result = await sendEmailFallback(guestEmail, 'Houzly Online Check-in', html);
        channel = 'email';
      } else {
        result = { success: false, error: 'Nessun recapito: manca l\'email dell\'ospite su Smoobu', noRecipient: true };
        channel = 'none';
      }
    }
  }

  const sessionsCol = await getCollection('checkin_sessions');
  const sentFields = result.success
    ? { initial_message_sent_at: new Date().toISOString() }
    : {};
  await sessionsCol.updateOne(
    { _id: session._id },
    {
      $set: sentFields,
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

// Vista ospite restituita al frontend (niente campi interni)
function publicGuestView(g, session) {
  const v = validateCheckinGuest(g, { isPrimary: g.slot === 1, arrival: session.booking?.arrival, full: true });
  return {
    slot: g.slot,
    is_primary: g.slot === 1,
    first_name: g.first_name ?? null,
    last_name: g.last_name ?? null,
    sex: g.sex ?? null,
    date_of_birth: g.date_of_birth ?? null,
    is_minor: v.isMinor,
    birth_country: g.birth_country ?? null,
    birth_city: g.birth_city ?? null,
    birth_province: g.birth_province ?? null,
    nationality: g.nationality ?? null,
    tax_code: g.tax_code ?? null,
    document_type: g.document_type ?? null,
    document_number: g.document_number ?? null,
    document_issue_country: g.document_issue_country ?? null,
    document_issue_city: g.document_issue_city ?? null,
    document_expiry_date: g.document_expiry_date ?? null,
    address_street: g.address_street ?? null,
    address_zip: g.address_zip ?? null,
    address_city: g.address_city ?? null,
    address_province: g.address_province ?? null,
    address_country: g.address_country ?? null,
    privacy_consent: !!g.privacy_consent,
    submitted_at: g.submitted_at ?? null,
    // Stato di compilazione, utile al frontend per mostrare cosa manca
    is_ready: v.errors.length === 0,
    field_errors: v.errors,
    warnings: v.warnings,
  };
}

// GET /api/checkin/session?t=<JWT>
// Restituisce property, booking e ospiti con lo stato di compilazione di ciascuno
app.get('/api/checkin/session', requireGuestAuth, async (req, res) => {
  const s = req.checkinSession;
  res.json({
    ok: true,
    session: {
      bookingId: s.smoobu_booking_id,
      property: s.property,
      booking: s.booking,
      status: s.status,
      editable: CHECKIN_EDITABLE_STATUSES.includes(s.status),
      document_types: CHECKIN_DOCUMENT_TYPES,
      guests: s.guests.map(g => publicGuestView(g, s)),
    },
  });
});

// POST /api/checkin/guest/save
// Body: { token, slot, data: { first_name, last_name, sex, date_of_birth, birth_country,
//         birth_city, birth_province, nationality, tax_code, document_type, document_number,
//         document_issue_country, document_issue_city, document_expiry_date,
//         address_street, address_zip, address_city, address_province, address_country,
//         privacy_consent } }
// Salvataggio parziale: controlla solo il formato dei campi presenti.
// Se c'è anche un solo errore non salva nulla e risponde 400 con field_errors.
// Se l'ospite era già confermato, la modifica annulla la conferma (va riconfermato).
app.post('/api/checkin/guest/save', requireGuestAuth, async (req, res) => {
  try {
    const s = req.checkinSession;
    if (!CHECKIN_EDITABLE_STATUSES.includes(s.status)) {
      return res.status(409).json({ ok: false, error: 'session_not_editable', status: s.status });
    }
    const { slot, data } = req.body || {};
    const slotNum = parseInt(slot);
    if (!slotNum || !data || typeof data !== 'object') {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    const guest = s.guests.find(g => g.slot === slotNum);
    if (!guest) return res.status(404).json({ ok: false, error: 'guest_slot_not_found' });

    const input = normalizeGuestInput(data);
    if (Object.keys(input).length === 0) {
      return res.status(400).json({ ok: false, error: 'no_valid_fields' });
    }

    const merged = { ...guest, ...input };
    const v = validateCheckinGuest(merged, { isPrimary: slotNum === 1, arrival: s.booking?.arrival, full: false });
    if (v.errors.length > 0) {
      return res.status(400).json({ ok: false, error: 'validation_failed', field_errors: v.errors, warnings: v.warnings });
    }

    const now = new Date().toISOString();
    const updates = {};
    for (const [k, val] of Object.entries(input)) updates[`guests.$.${k}`] = val;
    updates['guests.$.is_minor'] = v.isMinor;
    updates['guests.$.tax_code_verified'] = v.taxCodeVerified;
    updates['guests.$.tax_code_warnings'] = v.warnings.filter(w => w.field === 'tax_code').map(w => w.code);
    if (input.privacy_consent === true && !guest.privacy_consent) updates['guests.$.privacy_consent_at'] = now;
    if (input.privacy_consent === false) updates['guests.$.privacy_consent_at'] = null;
    if (guest.submitted_at) updates['guests.$.submitted_at'] = null;

    const sessionsCol = await getCollection('checkin_sessions');
    await sessionsCol.updateOne(
      { _id: s._id, 'guests.slot': slotNum },
      { $set: { ...updates, updated_at: now } }
    );

    await recalculateSessionStatus(s._id);
    const updated = await sessionsCol.findOne({ _id: s._id });
    const fresh = updated.guests.find(g => g.slot === slotNum);
    res.json({ ok: true, status: updated.status, guest: publicGuestView(fresh, updated) });
  } catch (e) {
    console.error('[checkin/guest/save]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/checkin/guest/submit
// Body: { token, slot? }
//   con slot    → conferma solo quell'ospite
//   senza slot  → conferma tutti gli ospiti in un colpo (bottone finale del form)
// Controllo completo: campi obbligatori + formati + coerenza codice fiscale.
// In modalità "tutti" non conferma nessuno se anche un solo ospite ha errori.
app.post('/api/checkin/guest/submit', requireGuestAuth, async (req, res) => {
  try {
    const s = req.checkinSession;
    if (!CHECKIN_EDITABLE_STATUSES.includes(s.status)) {
      return res.status(409).json({ ok: false, error: 'session_not_editable', status: s.status });
    }
    const { slot } = req.body || {};
    let targets;
    if (slot !== undefined && slot !== null && slot !== '') {
      const g = s.guests.find(x => x.slot === parseInt(slot));
      if (!g) return res.status(404).json({ ok: false, error: 'guest_slot_not_found' });
      targets = [g];
    } else {
      targets = s.guests;
    }

    const results = targets.map(g => ({
      g, v: validateCheckinGuest(g, { isPrimary: g.slot === 1, arrival: s.booking?.arrival, full: true }),
    }));
    const failed = results.filter(r => r.v.errors.length > 0);
    if (failed.length > 0) {
      return res.status(400).json({
        ok: false, error: 'validation_failed',
        guests: failed.map(r => ({ slot: r.g.slot, field_errors: r.v.errors })),
      });
    }

    const now = new Date().toISOString();
    const sessionsCol = await getCollection('checkin_sessions');
    for (const { g, v } of results) {
      await sessionsCol.updateOne(
        { _id: s._id, 'guests.slot': g.slot },
        { $set: {
          'guests.$.submitted_at': g.submitted_at || now,
          'guests.$.is_minor': v.isMinor,
          'guests.$.tax_code_verified': v.taxCodeVerified,
          'guests.$.tax_code_warnings': v.warnings.filter(w => w.field === 'tax_code').map(w => w.code),
          updated_at: now,
        } }
      );
    }

    await recalculateSessionStatus(s._id);
    const updated = await sessionsCol.findOne({ _id: s._id });
    res.json({ ok: true, status: updated.status, submitted: results.map(r => r.g.slot) });
  } catch (e) {
    console.error('[checkin/guest/submit]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Avviso interno quando tutti gli ospiti di una prenotazione hanno confermato.
// Contiene solo i dati essenziali: i dati dei documenti restano nel database
// e si consultano dalla dashboard.
async function sendCheckinCompletedNotice(session, isUpdate) {
  if (CHECKIN_NOTIFY_EMAILS.length === 0) return { success: false, error: 'no_recipients' };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = d => {
    if (!d) return '';
    const [y, m, g] = d.split('-');
    return `${g}/${m}/${y}`;
  };
  const b = session.booking || {};
  const prop = session.property?.name || 'Struttura';
  const guests = session.guests || [];
  const unverified = guests.filter(g => g.tax_code && !g.tax_code_verified).length;
  const minors = guests.filter(g => g.is_minor).length;
  const testTag = session.is_test ? '[TEST] ' : '';
  const verb = isUpdate ? 'aggiornato' : 'completato';
  const subject = `${testTag}Check-in ${verb} · ${prop} · ${fmt(b.arrival)}`;

  const row = (k, v) => `<tr><td style="padding:6px 0;color:#5a7aaa;font-size:13px;width:150px;vertical-align:top">${k}</td><td style="padding:6px 0;font-size:14px;color:#170046">${v}</td></tr>`;
  const notes = [];
  if (isUpdate) notes.push('L’ospite ha modificato i dati dopo la prima conferma.');
  if (unverified > 0) notes.push(`${unverified} codic${unverified === 1 ? 'e fiscale' : 'i fiscali'} da controllare (non corrisponde a nome o cognome).`);

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;background:#f0f4fa;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e4edf8">
    <div style="background:#170046;color:#fff;padding:18px 22px">
      <div style="font-size:11px;letter-spacing:3px;color:#4acbef;text-transform:uppercase">✦ Houzly Check-in</div>
      <div style="font-size:20px;margin-top:6px">${testTag}Check-in ${verb}</div>
    </div>
    <div style="padding:18px 22px">
      <table style="width:100%;border-collapse:collapse">
        ${row('Struttura', esc(prop))}
        ${row('Soggiorno', `${fmt(b.arrival)} → ${fmt(b.departure)} (${b.nights || '?'} notti)`)}
        ${row('Ospite principale', esc(b.primary_guest_name || ''))}
        ${row('Ospiti registrati', `${guests.length}${minors ? ` (di cui ${minors} minor${minors === 1 ? 'e' : 'i'})` : ''}`)}
        ${row('Canale', esc(b.channel_name || '—'))}
        ${row('Prenotazione', esc(session.smoobu_booking_id))}
      </table>
      ${notes.length ? `<div style="margin-top:14px;background:#fff7e6;color:#8a5a00;border-radius:8px;padding:10px 12px;font-size:13px">${notes.map(esc).join('<br>')}</div>` : ''}
      <p style="margin-top:16px;font-size:12px;color:#5a7aaa">I dati degli ospiti sono salvati nel database e consultabili dalla dashboard di Houzly Tool.</p>
    </div>
  </div>
</div>`;

  const result = await sendEmailFallback(CHECKIN_NOTIFY_EMAILS, subject, html);
  if (!result.success) console.error('[checkin/notify]', session._id, result.error);
  return result;
}

// Helper: ricalcola lo status della session in base allo stato dei guest
// Chiamato dopo save/submit: pending → partial → complete.
// Una session manual_required (arrivo oggi) passa a complete se l'ospite
// finisce online, altrimenti resta manual_required.
async function recalculateSessionStatus(sessionId) {
  const sessionsCol = await getCollection('checkin_sessions');
  const session = await sessionsCol.findOne({ _id: sessionId });
  if (!session) return;
  if (!['pending', 'partial', 'complete', 'manual_required'].includes(session.status)) return;

  const allSubmitted = session.guests.length > 0 && session.guests.every(g => !!g.submitted_at);
  const someStarted = session.guests.some(g => !!g.submitted_at || !!g.date_of_birth || !!g.document_number);

  let newStatus;
  if (allSubmitted) newStatus = 'complete';
  else if (session.status === 'manual_required') newStatus = 'manual_required';
  else if (someStarted) newStatus = 'partial';
  else newStatus = 'pending';

  const updates = { status: newStatus, updated_at: new Date().toISOString() };
  if (newStatus === 'complete' && !session.completed_at) updates.completed_at = new Date().toISOString();
  if (newStatus !== 'complete') updates.completed_at = null;
  await sessionsCol.updateOne({ _id: sessionId }, { $set: updates });

  // Avviso interno solo nel passaggio a "complete" (prima volta o dopo una modifica)
  if (newStatus === 'complete' && session.status !== 'complete') {
    const fresh = await sessionsCol.findOne({ _id: sessionId });
    const isUpdate = !!session.completion_notified_at;
    const r = await sendCheckinCompletedNotice(fresh, isUpdate);
    if (r.success) {
      await sessionsCol.updateOne({ _id: sessionId }, { $set: { completion_notified_at: new Date().toISOString() } });
    }
  }
}
// ══════════════════════════════════════════════════════════════════
// ── Check-in: Admin routes (PIN-protected) ────────────────────────
// ══════════════════════════════════════════════════════════════════

// GET /api/checkin/sessions
// Query opzionali:
//   view=upcoming (default: soggiorni non ancora finiti) | past (finiti) | all
//   status=<stato> | attention (manual_required + needs_review + long_stay_review)
//   property_id=<id Smoobu>   q=<testo: nome ospite, struttura o n. prenotazione>
//   include_excluded=1 (mostra anche escluse e archiviate)   limit (default 200, max 500)
// Restituisce una lista "leggera" (senza i dati dei documenti) + conteggi per stato.
const CHECKIN_ATTENTION_STATUSES = ['manual_required', 'needs_review', 'long_stay_review'];
// Stati di prenotazioni con ospiti da registrare (esclude escluse e archiviate)
const CHECKIN_REGISTRABLE_STATUSES = ['pending', 'partial', 'complete', 'manual_required', 'needs_review'];
let _checkinIndexesReady = false;
app.get('/api/checkin/sessions', requireAdminAuth, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    if (!_checkinIndexesReady) {
      _checkinIndexesReady = true;
      col.createIndex({ 'booking.departure': 1 }).catch(() => {});
      col.createIndex({ status: 1, 'booking.arrival': 1 }).catch(() => {});
      col.createIndex({ 'property.smoobu_id': 1 }).catch(() => {});
    }
    const { view = 'upcoming', status, property_id, q, include_excluded, reg } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 500);
    const today = new Date().toISOString().slice(0, 10);

    const base = {};
    if (view === 'upcoming') base['booking.departure'] = { $gte: today };
    else if (view === 'past') base['booking.departure'] = { $lt: today };
    if (property_id) base['property.smoobu_id'] = String(property_id);
    if (q && String(q).trim()) {
      const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      base.$or = [
        { 'booking.primary_guest_name': rx },
        { 'property.name': rx },
        { smoobu_booking_id: rx },
        { 'guests.last_name': rx },
      ];
    }
    const showExcluded = include_excluded === '1' || include_excluded === 'true';
    const visibleStatuses = { $not: /^(excluded_|archived$)/ };

    const filter = { ...base };
    if (status === 'attention') filter.status = { $in: CHECKIN_ATTENTION_STATUSES };
    else if (status) filter.status = status;
    else if (!showExcluded) filter.status = visibleStatuses;
    // Registrazione su Alloggiati / ISTAT
    if (reg === 'todo') {
      filter['booking.arrival'] = { $lte: today };
      filter.$and = [{ $or: [{ alloggiati_done_at: null }, { istat_done_at: null }] }];
      if (!status) filter.status = { $in: CHECKIN_REGISTRABLE_STATUSES };
    } else if (reg === 'done') {
      filter.alloggiati_done_at = { $ne: null };
      filter.istat_done_at = { $ne: null };
    }

    const projection = {
      smoobu_booking_id: 1, is_test: 1, status: 1, exclusion_reason: 1,
      'property.name': 1, 'property.smoobu_id': 1,
      'booking.arrival': 1, 'booking.departure': 1, 'booking.nights': 1,
      'booking.primary_guest_name': 1, 'booking.channel_name': 1, 'booking.total_guests_expected': 1,
      initial_message_due_at: 1, initial_message_sent_at: 1, completed_at: 1,
      alloggiati_done_at: 1, istat_done_at: 1,
      'guests.slot': 1, 'guests.submitted_at': 1, 'guests.tax_code': 1, 'guests.tax_code_verified': 1,
      'messages_sent.type': 1, 'messages_sent.success': 1,
    };
    const sortDir = view === 'past' ? -1 : 1;
    const docs = await col.find(filter, { projection })
      .sort({ 'booking.arrival': sortDir }).limit(limit).toArray();

    const sessions = docs.map(d => {
      const guests = d.guests || [];
      return {
        _id: d._id,
        smoobu_booking_id: d.smoobu_booking_id,
        is_test: !!d.is_test,
        status: d.status,
        exclusion_reason: d.exclusion_reason || null,
        property: d.property,
        booking: d.booking,
        guests_total: guests.length,
        guests_submitted: guests.filter(g => g.submitted_at).length,
        tax_code_warnings: guests.filter(g => g.tax_code && !g.tax_code_verified).length,
        link_sent_at: d.initial_message_sent_at || null,
        link_due_at: d.initial_message_due_at || null,
        link_failed: !d.initial_message_sent_at && (d.messages_sent || []).some(m => m.type === 'initial' && !m.success),
        reminders_sent: (d.messages_sent || []).filter(m => m.type && m.type.startsWith('reminder') && m.success).length,
        completed_at: d.completed_at || null,
        alloggiati_done_at: d.alloggiati_done_at || null,
        istat_done_at: d.istat_done_at || null,
      };
    });

    // Conteggi per stato sulla stessa vista (senza filtro stato)
    const agg = await col.aggregate([
      { $match: base },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]).toArray();
    const counts = {};
    for (const a of agg) counts[a._id] = a.n;
    // Ospiti già arrivati non ancora registrati su Alloggiati (scadenza 24h dall'arrivo)
    counts.reg_todo = await col.countDocuments({
      ...base,
      status: { $in: CHECKIN_REGISTRABLE_STATUSES },
      'booking.arrival': { $lte: today },
      alloggiati_done_at: null,
    });

    res.json({ ok: true, sessions, counts, truncated: docs.length === limit });
  } catch (e) {
    console.error('[checkin/sessions]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/checkin/billing-data
// Dati dell'ospite principale dei check-in completati, per precompilare
// Documenti Fiscali nella dashboard (solo slot 1, niente altri ospiti).
// Query: ?since=YYYY-MM-DD (default: 400 giorni fa, per data di arrivo)
app.get('/api/checkin/billing-data', requireAdminAuth, async (req, res) => {
  try {
    const since = isValidIsoDate(req.query.since) ? req.query.since
      : new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const col = await getCollection('checkin_sessions');
    const docs = await col.find(
      { 'booking.arrival': { $gte: since }, is_test: { $ne: true }, 'guests.0.submitted_at': { $ne: null } },
      { projection: {
        smoobu_booking_id: 1, 'property.name': 1, 'property.smoobu_id': 1,
        'booking.arrival': 1, 'booking.departure': 1, 'booking.reference_id': 1,
        'booking.primary_guest_name': 1, 'booking.primary_guest_email': 1,
        guests: { $slice: 1 },
      } }
    ).limit(2000).toArray();
    const items = docs.map(d => {
      const g = (d.guests || [])[0] || {};
      return {
        smoobu_booking_id: d.smoobu_booking_id,
        reference_id: d.booking?.reference_id || null,
        property_name: d.property?.name || null,
        arrival: d.booking?.arrival, departure: d.booking?.departure,
        email: d.booking?.primary_guest_email || null,
        submitted_at: g.submitted_at,
        first_name: g.first_name || null, last_name: g.last_name || null,
        nationality: g.nationality || null,
        tax_code: g.tax_code || null,
        document_type: g.document_type || null, document_number: g.document_number || null,
        address_street: g.address_street || null, address_zip: g.address_zip || null,
        address_city: g.address_city || null, address_province: g.address_province || null,
        address_country: g.address_country || null,
      };
    });
    res.json({ ok: true, items });
  } catch (e) {
    console.error('[checkin/billing-data]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/checkin/sessions/:id
// Restituisce dettaglio completo di una session, con lo stato di
// validazione di ogni ospite (utile alla dashboard per vedere cosa manca).
app.get('/api/checkin/sessions/:id', requireAdminAuth, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    const session = await col.findOne({ _id: req.params.id });
    if (!session) return res.status(404).json({ ok: false, error: 'not_found' });

    const guests = session.guests.map(g => {
      const v = validateCheckinGuest(g, { isPrimary: g.slot === 1, arrival: session.booking?.arrival, full: true });
      return { ...g, is_ready: v.errors.length === 0, field_errors: v.errors, warnings: v.warnings };
    });

    const checkin_link = session.access_token ? `${APP_BASE_URL}/checkin.html?t=${session.access_token}` : null;
    res.json({ ok: true, session: { ...session, guests, checkin_link } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Sessioni di PROVA (test del form ospite) ──────────────────────
// GET o POST /api/checkin/admin/test-session?pin=XXXX
// Parametri facoltativi (query o body):
//   guests  → numero ospiti (1-10, default 2)
//   arrival → data arrivo YYYY-MM-DD (default: tra 10 giorni)
//   nights  → notti (1-30, default 3)
//   name    → nome ospite principale (default "Ospite Prova")
//   property→ nome struttura da mostrare (default "Struttura di prova")
//   lang    → it | en (default it)
// Crea una scheda marcata is_test: nessun messaggio viene inviato, i cron la
// ignorano. Restituisce il link da aprire sul telefono.
app.all('/api/checkin/admin/test-session', requireAdminAuth, async (req, res) => {
  try {
    const q = { ...req.query, ...(req.body || {}) };
    const guests = Math.min(Math.max(parseInt(q.guests) || 2, 1), 10);
    const nights = Math.min(Math.max(parseInt(q.nights) || 3, 1), 30);
    const arrival = isValidIsoDate(q.arrival) ? q.arrival
      : new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const departure = new Date(new Date(arrival + 'T12:00:00Z').getTime() + nights * 86400000).toISOString().slice(0, 10);
    const fullName = String(q.name || 'Ospite Prova').trim().slice(0, 80);
    const [firstName, ...rest] = fullName.split(' ');
    const lastName = rest.join(' ') || null;

    const ts = Date.now();
    const bookingId = `test_${ts}`;
    const tokenData = generateCheckinToken(bookingId, departure);
    const now = new Date().toISOString();

    const session = {
      _id: `booking_${bookingId}`,
      smoobu_booking_id: bookingId,
      is_test: true,
      property: {
        smoobu_id: null,
        name: String(q.property || 'Struttura di prova').slice(0, 80),
        prop_code: null, region: null, city: null,
      },
      booking: {
        channel_id: null, channel_name: 'TEST',
        primary_guest_name: fullName, primary_guest_email: null,
        language: q.lang === 'en' ? 'en' : 'it',
        arrival, departure, nights,
        adults: guests, children: 0, total_guests_expected: guests,
        price_total: 0, notice: '[TEST]',
      },
      status: 'pending',
      exclusion_reason: null,
      access_token: tokenData.token,
      token_expires_at: tokenData.expiresAt,
      guests: Array.from({ length: guests }, (_, i) => buildEmptyGuest(i + 1,
        i === 0 ? firstName : null, i === 0 ? lastName : null)),
      messages_sent: [],
      initial_message_due_at: null,
      initial_message_sent_at: null,
      initial_message_attempts: 0,
      initial_dispatch_claimed_at: null,
      created_at: now, updated_at: now, completed_at: null, archived_at: null,
    };

    const col = await getCollection('checkin_sessions');
    await col.insertOne(session);
    const link = `${APP_BASE_URL}/checkin.html?t=${tokenData.token}`;
    res.json({ ok: true, session_id: session._id, link, arrival, departure, guests });
  } catch (e) {
    console.error('[checkin/admin/test-session]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET o POST /api/checkin/admin/test-sessions/delete?pin=XXXX
// Cancella TUTTE le schede di prova (is_test: true). Le prenotazioni vere non vengono toccate.
app.all('/api/checkin/admin/test-sessions/delete', requireAdminAuth, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    const r = await col.deleteMany({ is_test: true });
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT /api/checkin/sessions/:id/guests/:slot
// Body: { data: {...campi ospite...}, confirm?: true }
// Compilazione/correzione dati da parte di Houzly (es. ospite arrivato senza
// aver compilato). Controlla il formato; con confirm=true richiede anche tutti
// i campi obbligatori e segna l'ospite come confermato.
app.put('/api/checkin/sessions/:id/guests/:slot', requireAdminAuth, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    const session = await col.findOne({ _id: req.params.id });
    if (!session) return res.status(404).json({ ok: false, error: 'not_found' });
    const slotNum = parseInt(req.params.slot);
    const guest = (session.guests || []).find(g => g.slot === slotNum);
    if (!guest) return res.status(404).json({ ok: false, error: 'guest_slot_not_found' });

    const { data, confirm } = req.body || {};
    const input = normalizeGuestInput(data && typeof data === 'object' ? data : {});
    const merged = { ...guest, ...input };
    // L'informativa la accetta l'ospite: se compila Houzly non la richiediamo
    const v = validateCheckinGuest(
      { ...merged, privacy_consent: true },
      { isPrimary: slotNum === 1, arrival: session.booking?.arrival, full: !!confirm }
    );
    if (v.errors.length > 0) {
      return res.status(400).json({ ok: false, error: 'validation_failed', field_errors: v.errors, warnings: v.warnings });
    }

    const now = new Date().toISOString();
    const set = { updated_at: now };
    for (const [k, val] of Object.entries(input)) {
      if (k === 'privacy_consent') continue;
      set[`guests.$.${k}`] = val;
    }
    set['guests.$.is_minor'] = v.isMinor;
    set['guests.$.tax_code_verified'] = v.taxCodeVerified;
    set['guests.$.tax_code_warnings'] = v.warnings.filter(w => w.field === 'tax_code').map(w => w.code);
    set['guests.$.edited_by_admin_at'] = now;
    if (confirm) set['guests.$.submitted_at'] = guest.submitted_at || now;
    else if (guest.submitted_at && Object.keys(input).length) set['guests.$.submitted_at'] = null;

    await col.updateOne({ _id: session._id, 'guests.slot': slotNum }, { $set: set });
    await recalculateSessionStatus(session._id);
    const fresh = await col.findOne({ _id: session._id });
    const g = fresh.guests.find(x => x.slot === slotNum);
    const fv = validateCheckinGuest({ ...g, privacy_consent: true }, { isPrimary: slotNum === 1, arrival: fresh.booking?.arrival, full: true });
    res.json({ ok: true, status: fresh.status, guest: { ...g, is_ready: fv.errors.length === 0, field_errors: fv.errors, warnings: fv.warnings } });
  } catch (e) {
    console.error('[checkin/admin/guest]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/checkin/sessions/:id/guests  → aggiunge uno slot ospite vuoto
app.post('/api/checkin/sessions/:id/guests', requireAdminAuth, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    const session = await col.findOne({ _id: req.params.id });
    if (!session) return res.status(404).json({ ok: false, error: 'not_found' });
    const next = Math.max(0, ...(session.guests || []).map(g => g.slot)) + 1;
    await col.updateOne({ _id: session._id }, {
      $push: { guests: buildEmptyGuest(next, null, null) },
      $set: { updated_at: new Date().toISOString(), ...(session.status === 'complete' ? { status: 'partial', completed_at: null } : {}) },
    });
    res.json({ ok: true, slot: next });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/checkin/sessions/:id/guests/:slot  → rimuove uno slot (non l'ospite principale)
app.delete('/api/checkin/sessions/:id/guests/:slot', requireAdminAuth, async (req, res) => {
  try {
    const slotNum = parseInt(req.params.slot);
    if (slotNum === 1) return res.status(400).json({ ok: false, error: 'cannot_remove_primary' });
    const col = await getCollection('checkin_sessions');
    const r = await col.updateOne({ _id: req.params.id }, {
      $pull: { guests: { slot: slotNum } },
      $set: { updated_at: new Date().toISOString() },
    });
    if (r.matchedCount === 0) return res.status(404).json({ ok: false, error: 'not_found' });
    await recalculateSessionStatus(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PATCH /api/checkin/sessions/:id/registrations
// Body: { alloggiati?: true|false, istat?: true|false }
// Segna (o toglie) l'avvenuta registrazione su Alloggiati Web e sul portale ISTAT regionale.
app.patch('/api/checkin/sessions/:id/registrations', requireAdminAuth, async (req, res) => {
  try {
    const { alloggiati, istat } = req.body || {};
    const now = new Date().toISOString();
    const set = { updated_at: now };
    if (typeof alloggiati === 'boolean') set.alloggiati_done_at = alloggiati ? now : null;
    if (typeof istat === 'boolean') set.istat_done_at = istat ? now : null;
    if (Object.keys(set).length === 1) return res.status(400).json({ ok: false, error: 'nothing_to_update' });
    const col = await getCollection('checkin_sessions');
    const r = await col.findOneAndUpdate({ _id: req.params.id }, { $set: set }, {
      returnDocument: 'after', projection: { alloggiati_done_at: 1, istat_done_at: 1 },
    });
    const doc = r && r.value !== undefined ? r.value : r;
    if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, alloggiati_done_at: doc.alloggiati_done_at || null, istat_done_at: doc.istat_done_at || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
    const result = await dispatchInitialMessage(fresh);
    if (result && result.success === false) {
      return res.status(502).json({ ok: false, error: result.error || 'send_failed' });
    }
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
//   /api/cron/checkin/dispatch  → ogni 5 minuti (invio link programmati)
//   /api/cron/checkin/reminders → ogni giorno alle 10:00 Europe/Rome
//   /api/cron/checkin/cleanup   → ogni notte alle 03:00 Europe/Rome

function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'] || req.query.secret;
  if (!secret) return res.status(500).json({ ok: false, error: 'cron_secret_not_configured' });
  if (provided !== secret) return res.status(401).json({ ok: false, error: 'invalid_cron_secret' });
  next();
}

// Evita doppioni: niente reminder se il link iniziale non è ancora partito
// o è partito da meno di 12 ore (prenotazioni last minute)
function reminderTooEarly(s) {
  if (s.initial_message_due_at && !s.initial_message_sent_at) return true;
  if (s.initial_message_sent_at && Date.now() - new Date(s.initial_message_sent_at).getTime() < 12 * 3600000) return true;
  return false;
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
      is_test: { $ne: true },
      'booking.arrival': d3Str,
    }).toArray();
    for (const s of d3Sessions) {
      const alreadySent = s.messages_sent?.some(m => m.type === 'reminder_d3');
      if (alreadySent || reminderTooEarly(s)) continue;
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
      is_test: { $ne: true },
      'booking.arrival': d1Str,
    }).toArray();
    for (const s of d1Sessions) {
      const alreadySent = s.messages_sent?.some(m => m.type === 'reminder_d1');
      if (alreadySent || reminderTooEarly(s)) continue;
      const link = `${APP_BASE_URL}/checkin.html?t=${s.access_token}`;
      const msg = buildReminderD1({
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
        $push: { messages_sent: { type: 'reminder_d1', channel: isDirect ? 'email' : 'smoobu_chat', sent_at: new Date().toISOString(), success: result.success, error: result.error || null } },
      });
      if (result.success) remindersSent++;
    }

    // Arrivi oggi non ancora completi → manual_required
    const arrivingToday = await col.find({
      status: { $in: ['pending', 'partial'] },
      is_test: { $ne: true },
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

// Rivaluta le prenotazioni future rimaste in "soggiorno lungo" (regola rimossa)
// usando i dati già salvati, senza chiamare Smoobu.
async function reevaluateLongStays() {
  const col = await getCollection('checkin_sessions');
  const today = new Date().toISOString().slice(0, 10);
  const list = await col.find({ status: 'long_stay_review', 'booking.departure': { $gte: today } }).toArray();
  let n = 0;
  for (const s of list) {
    const b = s.booking || {};
    const [first, ...rest] = String(b.primary_guest_name || '').split(' ');
    const fake = {
      id: s.smoobu_booking_id,
      arrival: b.arrival, departure: b.departure,
      apartment: { id: s.property?.smoobu_id, name: s.property?.name },
      firstname: first || '', lastname: rest.join(' '),
      notice: b.notice || '', email: b.primary_guest_email || '',
    };
    const ev = await evaluateBooking(fake);
    const set = { status: ev.status, exclusion_reason: ev.reason || null, updated_at: new Date().toISOString() };
    if (ev.status === 'pending' && b.departure) {
      const tokenData = generateCheckinToken(s.smoobu_booking_id, b.departure);
      set.access_token = tokenData.token;
      set.token_expires_at = tokenData.expiresAt;
      if (!s.initial_message_sent_at) {
        set.initial_message_due_at = computeInitialDueAt(b.arrival);
        set.initial_message_attempts = 0;
        set.initial_dispatch_claimed_at = null;
      }
    }
    await col.updateOne({ _id: s._id }, { $set: set });
    n++;
  }
  if (n) console.log(`[checkin] rivalutati ${n} soggiorni lunghi`);
  return n;
}
// Una volta all'avvio del server (i soggiorni lunghi esistenti si sistemano subito)
setTimeout(() => { reevaluateLongStays().catch(e => console.error('[checkin/longstay]', e.message)); }, 15000);

// POST /api/cron/checkin/dispatch
// Invia i link di check-in programmati (initial_message_due_at scaduto).
// Da chiamare ogni 5 minuti da cron-job.org.
// Ogni session viene "prenotata" in modo atomico prima dell'invio, così due
// esecuzioni sovrapposte non mandano mai lo stesso messaggio due volte.
// In caso di errore riprova fino a 3 volte (ai giri successivi).
app.post('/api/cron/checkin/dispatch', requireCronSecret, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    const nowIso = new Date().toISOString();
    const staleClaim = new Date(Date.now() - 10 * 60000).toISOString();
    let sent = 0, failed = 0;

    for (let i = 0; i < 50; i++) {
      const claimed = await col.findOneAndUpdate(
        {
          status: { $in: ['pending', 'partial', 'manual_required'] },
          is_test: { $ne: true },
          initial_message_due_at: { $ne: null, $lte: nowIso },
          initial_message_sent_at: null,
          initial_message_attempts: { $lt: 3 },
          $or: [{ initial_dispatch_claimed_at: null }, { initial_dispatch_claimed_at: { $lt: staleClaim } }],
        },
        { $set: { initial_dispatch_claimed_at: nowIso }, $inc: { initial_message_attempts: 1 } },
        { returnDocument: 'after' }
      );
      const session = claimed && claimed.value !== undefined ? claimed.value : claimed;
      if (!session) break;

      // Check-out già passato: niente invio
      if (session.booking?.departure && session.booking.departure < nowIso.slice(0, 10)) {
        await col.updateOne({ _id: session._id }, { $set: { initial_message_due_at: null, initial_dispatch_claimed_at: null } });
        continue;
      }
      // Arrivo troppo lontano: non inviare adesso, riprogramma nella finestra
      const windowStart = computeWindowStartIso(session.booking?.arrival);
      if (windowStart && windowStart > nowIso) {
        await col.updateOne({ _id: session._id }, {
          $set: { initial_message_due_at: windowStart, initial_dispatch_claimed_at: null },
          $inc: { initial_message_attempts: -1 },
        });
        continue;
      }
      // Ospite già arrivato (es. soggiorno in corso importato all'accensione):
      // niente link, la registrazione va fatta a mano
      if (session.booking?.arrival && session.booking.arrival < nowIso.slice(0, 10)) {
        await col.updateOne({ _id: session._id }, { $set: {
          initial_message_due_at: null, initial_dispatch_claimed_at: null,
          status: session.status === 'pending' ? 'manual_required' : session.status,
          exclusion_reason: 'Soggiorno già iniziato quando il check-in è stato attivato',
        } });
        continue;
      }

      let result;
      try { result = await dispatchInitialMessage(session); }
      catch (e) { result = { success: false, error: e.message }; }

      const noRecipient = result?.noRecipient || /recipient|no_guest_email/i.test(result?.error || '');
      await col.updateOne({ _id: session._id }, {
        $set: noRecipient
          ? {
              initial_dispatch_claimed_at: null,
              initial_message_due_at: null,
              status: session.status === 'pending' ? 'manual_required' : session.status,
              exclusion_reason: "Nessun recapito per inviare il link: aggiungi l'email dell'ospite su Smoobu e usa Rimanda link",
            }
          : { initial_dispatch_claimed_at: null },
      });
      if (result?.success) sent++; else failed++;
    }

    console.log(`[cron/checkin/dispatch] sent=${sent} failed=${failed}`);
    res.json({ ok: true, sent, failed });
  } catch (e) {
    console.error('[cron/checkin/dispatch]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/cron/checkin/cleanup
// Cleanup notturno:
// - LEGACY: cancella eventuali foto R2 rimaste dalle session di test create
//   quando il check-in raccoglieva le foto (da settembre 2026 non ne arrivano
//   più; il blocco non trova nulla e si può eliminare in futuro)
// - Archivia session con checkout > 50 giorni fa (status=archived).
//   L'archiviazione cambia solo lo stato: i dati restano in MongoDB e
//   visibili in dashboard. Nessun dato ospite viene cancellato.
app.post('/api/cron/checkin/cleanup', requireCronSecret, async (req, res) => {
  try {
    const col = await getCollection('checkin_sessions');
    const now = new Date();
    const cutoff7 = new Date(now); cutoff7.setDate(cutoff7.getDate() - 7);
    const cutoffArchive = new Date(now); cutoffArchive.setDate(cutoffArchive.getDate() - CHECKIN_ARCHIVE_AFTER_DAYS);
    const cutoff7Str = cutoff7.toISOString().slice(0, 10);
    const cutoffArchiveStr = cutoffArchive.toISOString().slice(0, 10);

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

    // Archiviazione session con checkout > 50gg fa
    const archiveResult = await col.updateMany(
      { 'booking.departure': { $lt: cutoffArchiveStr }, status: { $ne: 'archived' } },
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

// ══════════════════════════════════════════════════════════════════
//  CONTRATTI — endpoint di test generazione PDF
// ══════════════════════════════════════════════════════════════════
//
//  Verifica che pdfmake e i font funzionino nell'ambiente Render.
//  Da rimuovere quando il modulo contratti sarà completo.
//
//  Uso dal browser:
//    /api/contracts/test-pdf?pin=<PIN>          → contratto firmato (11 pagine)
//    /api/contracts/test-pdf?pin=<PIN>&bozza=1  → bozza con filigrana
//
//  I require sono DENTRO l'handler, non in cima al file: se il modulo
//  contratti fallisse il caricamento (font mancanti, file non caricato),
//  l'errore resta confinato a questa route invece di impedire l'avvio del
//  server e portare giù check-in e Cleaning Manager.
// ══════════════════════════════════════════════════════════════════

app.get('/api/contracts/test-pdf', requireAdminAuth, async (req, res) => {
  try {
    const { getTemplate, VERSIONE_ATTIVA } = require('./templates');
    const { risolviTemplate, generaPdf } = require('./lib/pdf-generator');

    const bozza = req.query.bozza === '1';

    // PNG 1x1 al posto della firma reale: serve solo a verificare che
    // l'incorporamento delle immagini funzioni. Apparirà come un quadratino.
    const FIRMA_FINTA =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2) Safari/605.1.15';
    const caso = {
      riferimento: 'HZ-TEST-0001',
      email: 'test@houzly.it',
      tokenHash: 'sha256:test (hash del token, mai il token in chiaro)',
      luogoFirma: 'Terranuova Bracciolini (AR)',
      dataFirma: new Date().toLocaleDateString('it-IT'),
      mandante: {
        nomeCognome: 'Mario Rossi',
        luogoNascita: 'Firenze',
        dataNascita: '14/03/1972',
        residenza: 'Via dei Mille 21, 50123 Firenze (FI)',
        cfPiva: 'RSSMRA72C14D612K',
      },
      immobile: {
        indirizzo: 'Via delle Fonti 8, Cavriglia (AR)',
        piano: 'T-1',
        interno: '\u2014',
        foglio: '42',
        particella: '187',
        subalterno: '3',
        categoria: 'A/7',
        cin: 'IT051012B4XY7K9TQ2',
      },
      condizioni: {
        commissione: '30% (trenta per cento)',
        commissioneMaggiorata: '35% (trentacinque per cento)',
        servizi11bis: true,
      },
      clausole1341: bozza
        ? {}
        : { art3: true, art4: true, art10: true, art11bis: true, art14: true, art18: true, art19: true },
      firme: bozza
        ? {}
        : {
            contratto: { dataUrl: FIRMA_FINTA, ts: new Date().toISOString() },
            clausole:  { dataUrl: FIRMA_FINTA, ts: new Date().toISOString() },
          },
      audit: bozza
        ? []
        : [
            { ts: new Date().toISOString(), evento: 'Pratica creata e invito inviato', ip: '81.2.14.9', userAgent: 'backoffice/houzly-tool' },
            { ts: new Date().toISOString(), evento: 'Link aperto dal destinatario', ip: '93.44.201.7', userAgent: ua },
            { ts: new Date().toISOString(), evento: 'Dati anagrafici e immobile salvati', ip: '93.44.201.7', userAgent: ua },
            { ts: new Date().toISOString(), evento: 'Anteprima contratto visualizzata integralmente', ip: '93.44.201.7', userAgent: ua },
            { ts: new Date().toISOString(), evento: 'Firma contratto apposta', ip: '93.44.201.7', userAgent: ua },
            { ts: new Date().toISOString(), evento: 'Clausole 1341-1342 approvate e firmate', ip: '93.44.201.7', userAgent: ua },
          ],
    };

    const template = getTemplate(VERSIONE_ATTIVA);
    const snapshot = risolviTemplate(template, caso);
    const { buffer, sha256, bytes } = await generaPdf(snapshot, caso, { bozza });

    console.log(`[contracts/test-pdf] generato ${bytes} byte, sha256 ${sha256.slice(0, 16)}…`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="contratto-test${bozza ? '-bozza' : ''}.pdf"`);
    res.setHeader('X-Contract-SHA256', sha256);
    res.send(buffer);
  } catch (e) {
    console.error('[contracts/test-pdf]', e);
    res.status(500).json({ ok: false, error: e.message, stack: (e.stack || '').split('\n').slice(0, 5) });
  }
});

// ══════════════════════════════════════════════════════════════════
//  CONTRATTI — router admin e pubblico
// ══════════════════════════════════════════════════════════════════
//
//  /api/contracts  → backoffice, protetto da requireAdminAuth
//  /api/sign       → pubblico, protetto dal token monouso dell'invito
//
//  Il require sta dentro un try/catch: se il modulo contratti avesse un
//  problema di caricamento, il server parte comunque e continua a servire
//  check-in, Cleaning Manager e booking engine. Le due route contratti
//  risponderebbero 404, il resto funziona.
// ══════════════════════════════════════════════════════════════════

let contrattiAttivi = false;
try {
  const { createContractsAdminRouter, createContractsPublicRouter } = require('./lib/contracts-router');

  app.use('/api/contracts', requireAdminAuth, createContractsAdminRouter({
    getDb,
    resend,
    r2GetSignedUrl,
    APP_BASE_URL,
  }));

  app.use('/api/sign', createContractsPublicRouter({
    getDb,
    r2Upload,
    resend,
    validateTaxCode,
  }));

  contrattiAttivi = true;
  console.log('[contracts] router montati su /api/contracts e /api/sign');
} catch (e) {
  console.error('[contracts] modulo NON caricato:', e.message);
}

app.use('/api/onboarding', requireAdminAuth, createOnboardingRouter(getDb));
app.use(require('./guida'));
app.use(require('./guida-admin'));

app.listen(PORT, async () => {
  console.log(`Houzly server running on port ${PORT}`);
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    console.log('[MongoDB] Connected successfully');
  } catch (e) {
    console.error('[MongoDB] Connection FAILED:', e.message);
  }

  // Indici delle collezioni contratti: idempotente, si puo' rieseguire a ogni avvio.
  if (contrattiAttivi) {
    try {
      const { ensureIndexes } = require('./lib/contracts-store');
      await ensureIndexes(getDb);
      console.log('[contracts] indici verificati');
    } catch (e) {
      console.error('[contracts] creazione indici fallita:', e.message);
    }
  }
});
