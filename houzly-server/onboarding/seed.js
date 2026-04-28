// onboarding/seed.js
// Seed del catalogo onboarding — eseguito on-demand via endpoint HTTP admin.
// Idempotente: lo puoi richiamare ogni volta che modifichi catalog-seed.js
// per propagare i cambi al DB.

const { CATALOG, RECIPES } = require('./catalog-seed');

/**
 * Esegue il seed/upsert del catalogo onboarding.
 * @param {Db} db - istanza MongoDB già connessa
 * @param {Object} opts
 * @param {boolean} opts.forceUpsert - se true, aggiorna anche i task esistenti
 * @param {boolean} opts.dryRun - se true, conta cosa farebbe senza scrivere
 * @returns {Promise<Object>} riepilogo dell'operazione
 */
async function runSeed(db, opts = {}) {
  const { forceUpsert = false, dryRun = false } = opts;
  const log = [];
  const push = (s) => log.push(s);

  push(`mode: ${dryRun ? 'DRY RUN' : (forceUpsert ? 'FORCE UPSERT' : 'safe (insert if missing)')}`);

  // ── Recipes ──
  const recipesCol = db.collection('onboarding_recipes');
  let recIns = 0, recUpd = 0, recSkip = 0;
  for (const recipe of RECIPES) {
    const existing = await recipesCol.findOne({ _id: recipe._id });
    const doc = { ...recipe, created_at: existing?.created_at || new Date() };
    if (!existing) {
      if (!dryRun) await recipesCol.insertOne(doc);
      recIns++;
    } else if (forceUpsert) {
      if (!dryRun) await recipesCol.replaceOne({ _id: recipe._id }, doc);
      recUpd++;
    } else {
      recSkip++;
    }
  }

  // ── Catalog ──
  const catalogCol = db.collection('onboarding_catalog');
  let catIns = 0, catUpd = 0, catSkip = 0;
  for (const task of CATALOG) {
    const existing = await catalogCol.findOne({ _id: task._id });
    const now = new Date();
    const doc = {
      ...task,
      is_blocking_parent: task.is_blocking_parent ?? false,
      default_status: task.default_status || 'pending',
      recurrence: task.recurrence || null,
      instructions_md: task.instructions_md || '',
      external_link: task.external_link || '',
      archived: false,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    if (!existing) {
      if (!dryRun) await catalogCol.insertOne(doc);
      catIns++;
    } else if (forceUpsert) {
      if (!dryRun) await catalogCol.replaceOne({ _id: task._id }, doc);
      catUpd++;
    } else {
      catSkip++;
    }
  }

  // ── Indici ──
  if (!dryRun) {
    await catalogCol.createIndex({ category: 1, order: 1 });
    await catalogCol.createIndex({ parent_id: 1 });
    await catalogCol.createIndex({ archived: 1 });
    const instCol = db.collection('onboarding_instances');
    await instCol.createIndex({ property_id: 1, task_id: 1 });
    await instCol.createIndex({ property_id: 1 });
    await instCol.createIndex({ status: 1, target_date: 1 });
    await instCol.createIndex({ parent_instance_id: 1 });
  }

  // ── Stats finali ──
  const totalCatalog = await catalogCol.countDocuments();
  const parentCount = await catalogCol.countDocuments({ parent_id: null });
  const childCount = await catalogCol.countDocuments({ parent_id: { $ne: null } });

  push(`Recipes: +${recIns} new, updated ${recUpd}, skipped ${recSkip}`);
  push(`Catalog: +${catIns} new, updated ${catUpd}, skipped ${catSkip}`);
  push(`Final: ${totalCatalog} task totali (${parentCount} madre + ${childCount} sotto-task)`);

  return {
    ok: true,
    recipes: { inserted: recIns, updated: recUpd, skipped: recSkip },
    catalog: { inserted: catIns, updated: catUpd, skipped: catSkip },
    totals: { catalog: totalCatalog, parents: parentCount, children: childCount },
    log,
  };
}

module.exports = { runSeed };
