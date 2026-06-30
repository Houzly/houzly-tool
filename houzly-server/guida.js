// guida-admin.js — CRUD per il modulo Guest Intro dentro Houzly Tool
// Nel tuo server:  app.use(require('./guida-admin'));
// Richiede ./guida.js (riusa connessione e flush cache).
// Auth: header  x-guida-pin: <PIN>   (env GUIDA_ADMIN_PIN, default "2912")

const express = require('express');
const guida = require('./guida');           // getDb, flushCache
const router = express.Router();

const PIN = process.env.GUIDA_ADMIN_PIN || '2912';
router.use(express.json({ limit: '1mb' }));

// --- auth PIN su tutto /api/guida-admin ---
router.use('/api/guida-admin', (req, res, next) => {
  if ((req.get('x-guida-pin') || req.query.pin) !== PIN)
    return res.status(401).json({ error: 'unauthorized' });
  next();
});

const after = () => guida.flushCache();   // svuota la cache pubblica dopo ogni scrittura

// ===================== PROPRIETÀ =====================
router.get('/api/guida-admin/properties', async (req, res, next) => {
  try {
    const db = await guida.getDb();
    const list = await db.collection('gi_properties')
      .find({}, { projection: { slug: 1, name: 1, zone: 1, subtype: 1, active: 1 } })
      .sort({ name: 1 }).toArray();
    res.json(list);
  } catch (e) { next(e); }
});

router.get('/api/guida-admin/properties/:slug', async (req, res, next) => {
  try {
    const db = await guida.getDb();
    const doc = await db.collection('gi_properties').findOne({ slug: req.params.slug });
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json(doc);
  } catch (e) { next(e); }
});

router.put('/api/guida-admin/properties/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug).toLowerCase();
    const doc = req.body || {};
    doc.slug = slug;
    doc._id = doc._id || slug;
    if (doc.active === undefined) doc.active = true;
    const db = await guida.getDb();
    await db.collection('gi_properties').replaceOne({ _id: doc._id }, doc, { upsert: true });
    after();
    res.json({ ok: true, slug });
  } catch (e) { next(e); }
});

router.delete('/api/guida-admin/properties/:slug', async (req, res, next) => {
  try {
    const db = await guida.getDb();
    await db.collection('gi_properties').deleteOne({ slug: req.params.slug });
    after();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ===================== ZONE =====================
router.get('/api/guida-admin/zones', async (req, res, next) => {
  try {
    const db = await guida.getDb();
    const list = await db.collection('gi_zones')
      .find({}, { projection: { label: 1, comune: 1, region: 1 } }).sort({ label: 1 }).toArray();
    res.json(list);
  } catch (e) { next(e); }
});

router.get('/api/guida-admin/zones/:id', async (req, res, next) => {
  try {
    const db = await guida.getDb();
    const doc = await db.collection('gi_zones').findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json(doc);
  } catch (e) { next(e); }
});

router.put('/api/guida-admin/zones/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const doc = req.body || {}; doc._id = id;
    const db = await guida.getDb();
    await db.collection('gi_zones').replaceOne({ _id: id }, doc, { upsert: true });
    after();
    res.json({ ok: true, id });
  } catch (e) { next(e); }
});

// ===================== BRAND =====================
router.get('/api/guida-admin/brand', async (req, res, next) => {
  try {
    const db = await guida.getDb();
    const doc = await db.collection('gi_brand').findOne({ _id: 'houzly_brand' });
    res.json(doc || {});
  } catch (e) { next(e); }
});

router.put('/api/guida-admin/brand', async (req, res, next) => {
  try {
    const doc = req.body || {}; doc._id = 'houzly_brand';
    const db = await guida.getDb();
    await db.collection('gi_brand').replaceOne({ _id: 'houzly_brand' }, doc, { upsert: true });
    after();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ===================== SEED (inizializza dati da browser) =====================
// Idempotente: upsert di brand + zone + proprietà pilota. Non sovrascrive case
// che hai già modificato a meno che non passi ?force=1 (ripristina i piloti ai default).
router.post('/api/guida-admin/seed', async (req, res, next) => {
  try {
    const seed = require('./seed-guida'); // espone { BRAND, ZONES, PROPERTIES }
    const db = await guida.getDb();
    const force = req.query.force === '1';

    await db.collection('gi_brand').replaceOne({ _id: seed.BRAND._id }, seed.BRAND, { upsert: true });
    for (const z of seed.ZONES) {
      await db.collection('gi_zones').replaceOne({ _id: z._id }, z, { upsert: true });
    }
    let created = 0, skipped = 0;
    for (const p of seed.PROPERTIES) {
      const exists = await db.collection('gi_properties').findOne({ _id: p._id });
      if (exists && !force) { skipped++; continue; } // non calpestare le modifiche già fatte
      await db.collection('gi_properties').replaceOne({ _id: p._id }, p, { upsert: true });
      created++;
    }
    await db.collection('gi_properties').createIndex({ slug: 1 }, { unique: true });
    after();
    res.json({ ok: true, brand: 1, zones: seed.ZONES.length, properties_written: created, properties_skipped: skipped });
  } catch (e) { next(e); }
});

// error handler locale
router.use('/api/guida-admin', (err, req, res, next) => {
  console.error('[guida-admin]', err);
  res.status(500).json({ error: 'server_error' });
});

module.exports = router;
