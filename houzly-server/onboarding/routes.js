// onboarding/routes.js
// Tutti gli endpoint dell'Onboarding Cockpit, raggruppati in un Express Router.
// Si monta in server.js con: app.use('/api/onboarding', requireAdminAuth, onboardingRoutes(getDb))
//
// L'auth è applicata a livello di mount, quindi non serve ripeterla qui sotto.

const express = require('express');
const { ObjectId } = require('mongodb');

/**
 * Calcola la target_date di un task date il go_live e il days_before_golive.
 * - days_before_golive positivo  → data PRIMA del go-live
 * - days_before_golive negativo  → data DOPO il go-live (es. ottimizzazioni)
 */
function calcTargetDate(goLive, daysBefore) {
  const d = new Date(goLive);
  d.setDate(d.getDate() - daysBefore);
  return d;
}

/**
 * Genera tutte le istanze di task per una nuova proprietà date una ricetta e un go_live.
 * Non scrive sul DB — restituisce solo gli oggetti pronti per insertMany.
 * Risolve i parent_instance_id per i sotto-task in un secondo passaggio.
 */
function buildInstancesFromCatalog(catalog, property, goLiveDate) {
  const now = new Date();
  // Step 1: crea la mappa dei task applicabili (madri + figli) filtrati per ricetta
  const applicable = catalog.filter(t =>
    !t.archived &&
    Array.isArray(t.recipes) &&
    t.recipes.includes(property.recipe)
  );

  // Step 2: pre-genera _id per ogni catalog _id, così i figli possono linkare al padre
  const instanceIdByTaskId = new Map();
  for (const t of applicable) {
    instanceIdByTaskId.set(t._id, new ObjectId());
  }

  // Step 3: costruisci i documenti istanza
  const instances = applicable.map(t => ({
    _id: instanceIdByTaskId.get(t._id),
    property_id: property._id,
    property_name: property.name,
    task_id: t._id,
    parent_instance_id: t.parent_id ? (instanceIdByTaskId.get(t.parent_id) || null) : null,

    status: t.default_status === 'na' ? 'na' : 'pending',
    completed_at: null,
    completed_by: null,

    target_date: calcTargetDate(goLiveDate, t.days_before_golive),
    go_live_target: new Date(goLiveDate),

    override_assignee: null,
    custom_subtask: false,

    notes: '',
    attachments: [],

    reminded_7d: false,
    reminded_overdue: false,

    created_at: now,
    updated_at: now,
  }));

  return instances;
}

/**
 * Calcola un riepilogo aggregato per una proprietà a partire dalle sue istanze:
 * - %completamento, contatori per stato, in scadenza, in ritardo
 */
function summarizeInstances(instances) {
  const now = Date.now();
  const sevenDays = 7 * 24 * 3600 * 1000;

  let done = 0, pending = 0, na = 0, overdue = 0, dueSoon = 0;
  let active = 0; // = totali esclusi N/A — denominatore per la %

  for (const i of instances) {
    if (i.status === 'done') { done++; active++; }
    else if (i.status === 'na') { na++; }
    else {
      pending++;
      active++;
      const due = new Date(i.target_date).getTime();
      if (due < now) overdue++;
      else if (due - now <= sevenDays) dueSoon++;
    }
  }

  const total = instances.length;
  const pct = active > 0 ? Math.round((done / active) * 100) : 0;

  return { total, done, pending, na, overdue, due_soon: dueSoon, completion_pct: pct };
}

/**
 * Factory: ritorna il Router configurato. Riceve il provider getDb del server host.
 */
function createOnboardingRouter(getDb) {
  const router = express.Router();

  // ────────────────────────────────────────────────────────
  // 1. CATALOGO — lista template task
  // ────────────────────────────────────────────────────────
  router.get('/catalog', async (req, res) => {
    try {
      const db = await getDb();
      const includeArchived = req.query.includeArchived === '1';
      const filter = includeArchived ? {} : { archived: { $ne: true } };
      const tasks = await db.collection('onboarding_catalog')
        .find(filter)
        .sort({ category: 1, order: 1 })
        .toArray();
      res.json({ ok: true, tasks });
    } catch (e) {
      console.error('[onboarding/catalog]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // 2. RICETTE — lista delle ricette di onboarding
  // ────────────────────────────────────────────────────────
  router.get('/recipes', async (req, res) => {
    try {
      const db = await getDb();
      const recipes = await db.collection('onboarding_recipes')
        .find({})
        .sort({ is_default: -1, name: 1 })
        .toArray();
      res.json({ ok: true, recipes });
    } catch (e) {
      console.error('[onboarding/recipes]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // 3. CREA PROPRIETÀ — istanzia tutta la checklist
  // POST body: { property_id, property_name, recipe, go_live_target }
  // ────────────────────────────────────────────────────────
  router.post('/properties', async (req, res) => {
    try {
      const { property_id, property_name, recipe, go_live_target } = req.body || {};

      if (!property_id || !property_name || !recipe || !go_live_target) {
        return res.status(400).json({
          ok: false,
          error: 'missing_fields',
          required: ['property_id', 'property_name', 'recipe', 'go_live_target'],
        });
      }

      const goLive = new Date(go_live_target);
      if (isNaN(goLive.getTime())) {
        return res.status(400).json({ ok: false, error: 'invalid_go_live_target' });
      }

      const db = await getDb();

      // Verifica che la ricetta esista
      const recipeDoc = await db.collection('onboarding_recipes').findOne({ _id: recipe });
      if (!recipeDoc) {
        return res.status(400).json({ ok: false, error: 'recipe_not_found', recipe });
      }

      // Verifica idempotenza: se esistono già istanze per questa property_id, abort
      const existing = await db.collection('onboarding_instances').countDocuments({ property_id });
      if (existing > 0) {
        return res.status(409).json({
          ok: false,
          error: 'property_already_initialized',
          existing_tasks: existing,
        });
      }

      // Carica catalogo e genera istanze
      const catalog = await db.collection('onboarding_catalog')
        .find({ archived: { $ne: true } })
        .toArray();

      const property = { _id: property_id, name: property_name, recipe };
      const instances = buildInstancesFromCatalog(catalog, property, goLive);

      if (instances.length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'no_applicable_tasks_for_recipe',
          recipe,
        });
      }

      await db.collection('onboarding_instances').insertMany(instances);

      console.log(`[onboarding] created property "${property_name}" (${property_id}) with ${instances.length} tasks, recipe=${recipe}, go_live=${goLive.toISOString().slice(0,10)}`);

      res.json({
        ok: true,
        property_id,
        property_name,
        recipe,
        go_live_target: goLive.toISOString(),
        tasks_created: instances.length,
      });
    } catch (e) {
      console.error('[onboarding/properties POST]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // 3-ter. LINK MANUAL TO SMOOBU — quando una proprietà inserita
  //        manualmente ("manual_xxx") deve essere "fusa" con il record
  //        sincronizzato da Smoobu (es. "prop_2642823").
  //        Body: { manual_id, master_id }
  //        Sposta tutte le istanze sotto il master_id e rinomina.
  // ────────────────────────────────────────────────────────
  router.post('/link-manual-to-smoobu', async (req, res) => {
    try {
      const db = await getDb();
      const { manual_id, master_id } = req.body || {};

      if (!manual_id || !master_id) {
        return res.status(400).json({ ok: false, error: 'missing_fields', required: ['manual_id', 'master_id'] });
      }
      if (!manual_id.startsWith('manual_')) {
        return res.status(400).json({ ok: false, error: 'manual_id_must_start_with_manual_' });
      }

      // Verifica che il master esista
      const master = await db.collection('checkin_properties_config').findOne({ _id: master_id });
      if (!master) {
        return res.status(404).json({ ok: false, error: 'master_not_found', master_id });
      }

      // Verifica che la manuale esista
      const manualSample = await db.collection('onboarding_instances').findOne({ property_id: manual_id });
      if (!manualSample) {
        return res.status(404).json({ ok: false, error: 'manual_property_not_found', manual_id });
      }

      // Verifica che il master non sia già in onboarding (eviterei merge complessi)
      const masterAlready = await db.collection('onboarding_instances').countDocuments({ property_id: master_id });
      if (masterAlready > 0) {
        return res.status(409).json({
          ok: false,
          error: 'master_already_in_onboarding',
          existing_tasks: masterAlready,
        });
      }

      // Sposta tutte le istanze sotto il nuovo property_id e aggiorna il property_name al master
      const result = await db.collection('onboarding_instances').updateMany(
        { property_id: manual_id },
        { $set: { property_id: master_id, property_name: master.name, updated_at: new Date() } }
      );

      console.log(`[onboarding] linked manual ${manual_id} → ${master_id} (${result.modifiedCount} tasks moved)`);

      res.json({
        ok: true,
        manual_id,
        master_id,
        master_name: master.name,
        tasks_moved: result.modifiedCount,
      });
    } catch (e) {
      console.error('[onboarding/link-manual-to-smoobu]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/available-properties', async (req, res) => {
    try {
      const db = await getDb();

      // ID già usati nell'onboarding (per escluderli)
      const inOnboardingDocs = await db.collection('onboarding_instances')
        .find({}, { projection: { property_id: 1 } })
        .toArray();
      const onboardingSet = new Set(inOnboardingDocs.map(d => d.property_id));
      const inOnboarding = [...onboardingSet];

      // Tutte le proprietà nel master config
      const all = await db.collection('checkin_properties_config')
        .find({})
        .sort({ name: 1 })
        .toArray();

      // Filtra: solo quelle NON ancora in onboarding
      const available = all
        .filter(p => !onboardingSet.has(p._id))
        .map(p => ({
          _id: p._id,
          name: p.name,
          smoobu_apartment_id: p.smoobu_apartment_id,
          prop_code: p.prop_code,
          city: p.city,
          region: p.region,
        }));

      res.json({
        ok: true,
        count: available.length,
        total_in_master: all.length,
        already_in_onboarding: inOnboarding.length,
        properties: available,
      });
    } catch (e) {
      console.error('[onboarding/available-properties]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // 3-ter. BULK IMPORT — importa proprietà GIÀ LIVE come "complete al 100%"
  //         Body: { property_ids: ["prop_xxx", ...], recipe?: "standard", go_live_target?: ISO }
  //         Se property_ids omesso → importa TUTTE le available (modo "import iniziale").
  //         Idempotente: skippa proprietà già presenti.
  // ────────────────────────────────────────────────────────
  router.post('/bulk-import-live', async (req, res) => {
    try {
      const db = await getDb();
      const {
        property_ids = null,
        recipe = 'standard',
        go_live_target = null,
      } = req.body || {};

      // Verifica ricetta
      const recipeDoc = await db.collection('onboarding_recipes').findOne({ _id: recipe });
      if (!recipeDoc) {
        return res.status(400).json({ ok: false, error: 'recipe_not_found', recipe });
      }

      // Default go_live: 90 giorni nel passato (così tutto risulta "scaduto e completato",
      // niente task in scadenza nei prossimi giorni a sporcare il cockpit con falsi alert).
      const goLive = go_live_target
        ? new Date(go_live_target)
        : new Date(Date.now() - 90 * 86400000);
      if (isNaN(goLive.getTime())) {
        return res.status(400).json({ ok: false, error: 'invalid_go_live_target' });
      }

      // Carica catalogo
      const catalog = await db.collection('onboarding_catalog')
        .find({ archived: { $ne: true } })
        .toArray();

      // Determina lista da importare
      let masterDocs;
      if (Array.isArray(property_ids) && property_ids.length > 0) {
        masterDocs = await db.collection('checkin_properties_config')
          .find({ _id: { $in: property_ids } })
          .toArray();
      } else {
        masterDocs = await db.collection('checkin_properties_config')
          .find({})
          .toArray();
      }

      // Filtra quelle già in onboarding (skip silente)
      const alreadyDocs = await db.collection('onboarding_instances')
        .find({}, { projection: { property_id: 1 } })
        .toArray();
      const alreadySet = new Set(alreadyDocs.map(d => d.property_id));

      const imported = [];
      const skipped = [];
      const now = new Date();

      for (const m of masterDocs) {
        if (alreadySet.has(m._id)) {
          skipped.push({ property_id: m._id, name: m.name, reason: 'already_in_onboarding' });
          continue;
        }

        // Genera istanze usando la stessa logica della creazione normale
        const property = { _id: m._id, name: m.name, recipe };
        const instances = buildInstancesFromCatalog(catalog, property, goLive);

        if (instances.length === 0) {
          skipped.push({ property_id: m._id, name: m.name, reason: 'no_applicable_tasks' });
          continue;
        }

        // Marca TUTTE come done (eccetto quelle con default_status='na' che restano N/A)
        const catalogById = new Map(catalog.map(t => [t._id, t]));
        for (const inst of instances) {
          const tpl = catalogById.get(inst.task_id);
          if (tpl?.default_status === 'na') {
            inst.status = 'na';
          } else {
            inst.status = 'done';
            inst.completed_at = now;
            inst.completed_by = 'bulk_import';
          }
        }

        await db.collection('onboarding_instances').insertMany(instances);
        imported.push({
          property_id: m._id,
          name: m.name,
          tasks_created: instances.length,
        });
      }

      console.log(`[onboarding/bulk-import] imported=${imported.length}, skipped=${skipped.length}`);

      res.json({
        ok: true,
        imported_count: imported.length,
        skipped_count: skipped.length,
        imported,
        skipped,
      });
    } catch (e) {
      console.error('[onboarding/bulk-import-live]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // 4. COCKPIT — lista di tutte le proprietà con summary aggregato
  // ────────────────────────────────────────────────────────
  router.get('/properties', async (req, res) => {
    try {
      const db = await getDb();

      // Aggrega tutte le istanze raggruppando per property_id
      const all = await db.collection('onboarding_instances').find({}).toArray();
      const byProperty = new Map();
      for (const inst of all) {
        if (!byProperty.has(inst.property_id)) {
          byProperty.set(inst.property_id, {
            property_id: inst.property_id,
            property_name: inst.property_name,
            go_live_target: inst.go_live_target,
            instances: [],
          });
        }
        byProperty.get(inst.property_id).instances.push(inst);
      }

      // Per ogni proprietà calcola summary + breakdown per categoria
      const catalog = await db.collection('onboarding_catalog').find({}).toArray();
      const categoryByTask = new Map(catalog.map(t => [t._id, t.category]));

      const properties = [];
      for (const p of byProperty.values()) {
        const summary = summarizeInstances(p.instances);

        // Breakdown per categoria: percentuale per ogni macro-area
        const byCategory = {};
        for (const inst of p.instances) {
          const cat = categoryByTask.get(inst.task_id) || 'other';
          if (!byCategory[cat]) byCategory[cat] = { total: 0, done: 0, na: 0, overdue: 0, due_soon: 0 };
          byCategory[cat].total++;
          const now = Date.now();
          const due = new Date(inst.target_date).getTime();
          if (inst.status === 'done') byCategory[cat].done++;
          else if (inst.status === 'na') byCategory[cat].na++;
          else {
            if (due < now) byCategory[cat].overdue++;
            else if (due - now <= 7 * 86400000) byCategory[cat].due_soon++;
          }
        }

        // Stato sintetico per categoria: green/yellow/red/gray
        const categoryStatus = {};
        for (const [cat, c] of Object.entries(byCategory)) {
          const active = c.total - c.na;
          if (active === 0) categoryStatus[cat] = 'na';
          else if (c.overdue > 0) categoryStatus[cat] = 'red';
          else if (c.done === active) categoryStatus[cat] = 'green';
          else if (c.done > 0 || c.due_soon > 0) categoryStatus[cat] = 'yellow';
          else categoryStatus[cat] = 'gray';
        }

        properties.push({
          property_id: p.property_id,
          property_name: p.property_name,
          go_live_target: p.go_live_target,
          summary,
          category_status: categoryStatus,
        });
      }

      // Ordina: prima quelle in onboarding (incomplete), poi le live (100%), tutte per nome
      properties.sort((a, b) => {
        const aActive = a.summary.completion_pct < 100;
        const bActive = b.summary.completion_pct < 100;
        if (aActive !== bActive) return bActive - aActive ? -1 : 1;
        return a.property_name.localeCompare(b.property_name);
      });

      res.json({ ok: true, count: properties.length, properties });
    } catch (e) {
      console.error('[onboarding/properties GET]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // 5. DETTAGLIO PROPRIETÀ — istanze + dati catalog joinati
  // ────────────────────────────────────────────────────────
  router.get('/properties/:id', async (req, res) => {
    try {
      const db = await getDb();
      const propertyId = req.params.id;

      const instances = await db.collection('onboarding_instances')
        .find({ property_id: propertyId })
        .toArray();

      if (instances.length === 0) {
        return res.status(404).json({ ok: false, error: 'property_not_initialized' });
      }

      // Join col catalogo per arricchire i dati (nome task, descrizione, blocking, etc.)
      const taskIds = [...new Set(instances.map(i => i.task_id))];
      const catalogDocs = await db.collection('onboarding_catalog')
        .find({ _id: { $in: taskIds } })
        .toArray();
      const catalogById = new Map(catalogDocs.map(t => [t._id, t]));

      const enriched = instances.map(inst => {
        const t = catalogById.get(inst.task_id);
        return {
          ...inst,
          task: t ? {
            name: t.name,
            description: t.description,
            category: t.category,
            order: t.order,
            is_blocking_parent: t.is_blocking_parent,
            instructions_md: t.instructions_md,
            external_link: t.external_link,
            default_assignee: t.default_assignee,
            parent_id: t.parent_id,
          } : null,
        };
      });

      // Ordina: per categoria (ordine canonico), poi per order del catalog
      const CAT_ORDER = ['legale_fiscale','foto','ota','tools','marketing','ottimizzazione','ricorrente'];
      enriched.sort((a, b) => {
        const ca = CAT_ORDER.indexOf(a.task?.category ?? 'zzz');
        const cb = CAT_ORDER.indexOf(b.task?.category ?? 'zzz');
        if (ca !== cb) return ca - cb;
        return (a.task?.order || 0) - (b.task?.order || 0);
      });

      const summary = summarizeInstances(instances);
      const property = {
        property_id: propertyId,
        property_name: instances[0].property_name,
        go_live_target: instances[0].go_live_target,
      };

      res.json({ ok: true, property, summary, tasks: enriched });
    } catch (e) {
      console.error('[onboarding/properties/:id]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // 6. AGGIORNA TASK ISTANZA — toggle stato, note, assegnatario
  // PATCH body: campi modificabili (status, notes, override_assignee, target_date)
  // ────────────────────────────────────────────────────────
  router.patch('/tasks/:id', async (req, res) => {
    try {
      const db = await getDb();
      const id = ObjectId.createFromHexString(req.params.id);

      const allowed = ['status', 'notes', 'override_assignee', 'target_date'];
      const updates = {};
      for (const k of allowed) {
        if (k in req.body) updates[k] = req.body[k];
      }

      if ('status' in updates) {
        const valid = ['pending', 'in_progress', 'done', 'na', 'blocked'];
        if (!valid.includes(updates.status)) {
          return res.status(400).json({ ok: false, error: 'invalid_status', valid });
        }
        // Se passa a done, registra timestamp e autore (dal body o "unknown")
        if (updates.status === 'done') {
          updates.completed_at = new Date();
          updates.completed_by = req.body.completed_by || 'unknown';
        } else {
          // Se torna a pending dopo done, pulisce
          updates.completed_at = null;
          updates.completed_by = null;
        }
      }

      if ('target_date' in updates) {
        const d = new Date(updates.target_date);
        if (isNaN(d.getTime())) {
          return res.status(400).json({ ok: false, error: 'invalid_target_date' });
        }
        updates.target_date = d;
        // Reset flag reminder se la data cambia
        updates.reminded_7d = false;
        updates.reminded_overdue = false;
      }

      updates.updated_at = new Date();

      const result = await db.collection('onboarding_instances').findOneAndUpdate(
        { _id: id },
        { $set: updates },
        { returnDocument: 'after' }
      );

      if (!result) {
        return res.status(404).json({ ok: false, error: 'task_not_found' });
      }

      res.json({ ok: true, task: result });
    } catch (e) {
      console.error('[onboarding/tasks PATCH]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // 7. AGGIUNGI SOTTO-TASK CUSTOM A UNA PROPRIETÀ (one-off)
  // POST body: { name, description, parent_instance_id?, target_date?, default_assignee? }
  // Non passa dal catalogo: vive solo per questa proprietà.
  // ────────────────────────────────────────────────────────
  router.post('/properties/:id/custom-task', async (req, res) => {
    try {
      const db = await getDb();
      const propertyId = req.params.id;
      const { name, description, parent_instance_id, target_date, override_assignee } = req.body || {};

      if (!name) {
        return res.status(400).json({ ok: false, error: 'name_required' });
      }

      // Verifica che la proprietà esista (almeno un'istanza)
      const sample = await db.collection('onboarding_instances').findOne({ property_id: propertyId });
      if (!sample) {
        return res.status(404).json({ ok: false, error: 'property_not_initialized' });
      }

      // Se parent specificato, verifica che esista e appartenga alla stessa proprietà
      let parentObjId = null;
      if (parent_instance_id) {
        try {
          parentObjId = ObjectId.createFromHexString(parent_instance_id);
        } catch {
          return res.status(400).json({ ok: false, error: 'invalid_parent_instance_id' });
        }
        const parent = await db.collection('onboarding_instances').findOne({
          _id: parentObjId,
          property_id: propertyId,
        });
        if (!parent) {
          return res.status(404).json({ ok: false, error: 'parent_not_found_in_this_property' });
        }
      }

      const now = new Date();
      const td = target_date ? new Date(target_date) : new Date(sample.go_live_target);
      if (isNaN(td.getTime())) {
        return res.status(400).json({ ok: false, error: 'invalid_target_date' });
      }

      // I custom task non hanno task_id del catalogo: usiamo un id sintetico
      const doc = {
        _id: new ObjectId(),
        property_id: propertyId,
        property_name: sample.property_name,
        task_id: `custom_${Date.now()}`,
        parent_instance_id: parentObjId,

        // Snapshot inline dei campi che normalmente verrebbero dal catalogo
        custom_subtask: true,
        custom_name: name,
        custom_description: description || '',
        custom_category: 'custom',

        status: 'pending',
        completed_at: null,
        completed_by: null,
        target_date: td,
        go_live_target: new Date(sample.go_live_target),

        override_assignee: override_assignee || null,
        notes: '',
        attachments: [],

        reminded_7d: false,
        reminded_overdue: false,
        created_at: now,
        updated_at: now,
      };

      await db.collection('onboarding_instances').insertOne(doc);
      res.json({ ok: true, task: doc });
    } catch (e) {
      console.error('[onboarding/properties/:id/custom-task]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // 8. ELIMINA UNA PROPRIETÀ DALL'ONBOARDING (cancella tutte le sue istanze)
  // Da usare con cautela — utile se hai sbagliato l'inizializzazione e vuoi rifarla.
  // ────────────────────────────────────────────────────────
  router.delete('/properties/:id', async (req, res) => {
    try {
      const db = await getDb();
      const propertyId = req.params.id;
      const result = await db.collection('onboarding_instances').deleteMany({ property_id: propertyId });
      console.log(`[onboarding] deleted property ${propertyId}: removed ${result.deletedCount} tasks`);
      res.json({ ok: true, deleted: result.deletedCount });
    } catch (e) {
      console.error('[onboarding/properties DELETE]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

module.exports = { createOnboardingRouter, buildInstancesFromCatalog, summarizeInstances, calcTargetDate };
