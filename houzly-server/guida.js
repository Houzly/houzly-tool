// guida.js — Houzly Guest Intro backend
// Drop-in Express router. Nel tuo server:  const guida = require('./guida'); app.use(guida);
// Espone:  GET /api/guida/:slug  ->  manuale "fuso" (forma identica a quella che guida.html consuma)
//
// Env richiesto: MONGODB_URI   (Atlas)
// Env opzionali: GUIDA_DB (default "houzly"), GUIDA_CORS_ORIGIN (default "*")

const express = require('express');
const { MongoClient } = require('mongodb');

const router = express.Router();

const DB_NAME     = process.env.GUIDA_DB || 'houzly';
const CORS_ORIGIN = process.env.GUIDA_CORS_ORIGIN || '*';
const CACHE_TTL   = 5 * 60 * 1000; // 5 min

// ---- connessione Mongo cache-ata (riusata tra le richieste) ----
let _client;
async function getDb() {
  if (!_client) {
    _client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5 });
    await _client.connect();
  }
  return _client.db(DB_NAME);
}

// ---- cache in-memory per slug (i manuali cambiano di rado) ----
const _cache = new Map(); // slug -> { at, data }

// ---- merge: PROPRIETÀ > ZONA > BRAND ----
function dedupByKey(arr) {
  const seen = new Map();
  for (const x of arr) seen.set(x.key ?? Math.random(), x); // l'ultimo (proprietà) vince
  return [...seen.values()];
}

function mergeWaste(zone, p) {
  const w = p.waste_override || {};
  const zw = (zone && zone.waste) || {};
  return {
    expose:       w.expose       ?? zw.expose       ?? null,
    streams:      w.streams      ?? zw.streams      ?? [],
    bin_location: w.bin_location ?? zw.bin_location ?? null,
    note:         w.note         ?? zw.note         ?? null
  };
}

async function buildManual(db, slug) {
  const property = await db.collection('gi_properties').findOne({ slug, active: true });
  if (!property) return null;

  const zone  = await db.collection('gi_zones').findOne({ _id: property.zone });
  const brand = await db.collection('gi_brand').findOne({ _id: 'houzly_brand' });
  if (!brand) throw new Error('gi_brand singleton mancante: esegui seed-guida.js');

  const ci = property.checkin  || {};
  const co = property.checkout || {};

  return {
    name: property.name,
    subtype: property.subtype,
    location: property.location || (zone ? zone.location : null) || { it: '', en: '' },
    hero_image: property.hero_image || null,

    welcome: {
      eyebrow: brand.welcome_eyebrow || { it: 'Benvenuti', en: 'Welcome' },
      note:    property.welcome_note || brand.welcome_note_default || { it: '', en: '' },
      sign:    property.welcome_sign || brand.welcome_sign_default || { it: '', en: '' }
    },

    facts: property.facts || { guests: null, bedrooms: null, bathrooms: null },

    wifi: property.wifi || { network: '', password: '', note: { it: '', en: '' } },

    checkin: {
      time_from:    ci.time_from || (brand.checkin_default && brand.checkin_default.time_from) || '16:00',
      time_to:      ci.time_to   || (brand.checkin_default && brand.checkin_default.time_to)   || '21:00',
      instructions: ci.instructions || { it: '', en: '' }
    },
    checkout: {
      time_by: co.time_by || (brand.checkout_default && brand.checkout_default.time_by) || '10:00',
      steps:   [ ...(brand.checkout_steps_default || []), ...(co.steps_extra || []) ]
    },

    amenities: property.amenities || [],
    parking:   property.parking   || null,

    house_rules: dedupByKey([ ...(brand.house_rules_default || []), ...(property.house_rules_extra || []) ]),

    waste: mergeWaste(zone, property),

    recommendations: [ ...((zone && zone.recommendations) || []), ...(property.recommendations_extra || []) ],

    dining: {
      restaurants: (property.dining_override && property.dining_override.restaurants) || (zone && zone.dining && zone.dining.restaurants) || [],
      pizzerias:   (property.dining_override && property.dining_override.pizzerias)   || (zone && zone.dining && zone.dining.pizzerias)   || []
    },
    attractions: [ ...((zone && zone.attractions) || []), ...(property.attractions_extra || []) ],

    contacts: [ ...((brand.host && brand.host.contacts) || []), ...(property.contacts_extra || []) ],

    address: property.address || {
      line: (zone && zone.location) || { it: '', en: '' },
      q: property.name + (zone ? ' ' + zone.comune : '')
    },

    emergency: {
      europe: (brand.emergency && brand.emergency.europe) || '112',
      hospital: (zone && zone.emergency_local && zone.emergency_local.hospital) || { nm: { it: '', en: '' }, note: { it: '', en: '' } }
    }
  };
}

// ---- CORS leggero (manuali pubblici, solo GET) ----
router.use('/api/guida', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- endpoint ----
router.get('/api/guida/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  try {
    const hit = _cache.get(slug);
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      res.set('Cache-Control', 'public, max-age=300');
      return res.json(hit.data);
    }
    const db = await getDb();
    const manual = await buildManual(db, slug);
    if (!manual) return res.status(404).json({ error: 'not_found', slug });

    _cache.set(slug, { at: Date.now(), data: manual });
    res.set('Cache-Control', 'public, max-age=300');
    res.json(manual);
  } catch (err) {
    console.error('[guida]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// opzionale: svuota la cache dopo un aggiornamento contenuti
function flushCache(){ _cache.clear(); }
router.post('/api/guida/_flush', (req, res) => { flushCache(); res.json({ ok: true }); });

module.exports = router;
module.exports.buildManual = buildManual;
module.exports.flushCache = flushCache;
module.exports.getDb = getDb;
