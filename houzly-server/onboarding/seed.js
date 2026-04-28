// onboarding/seed.js
// Script di seeding del catalogo onboarding.
// Idempotente: lo puoi rilanciare per applicare modifiche fatte a catalog-seed.js
//
// Uso:
//   node onboarding/seed.js              # popola SE mancano (safe default)
//   node onboarding/seed.js --upsert     # forza update di tutti i campi (perde override manuali)
//   node onboarding/seed.js --dry-run    # mostra cosa farebbe senza scrivere

const { MongoClient } = require('mongodb');
const { CATALOG, RECIPES } = require('./catalog-seed');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'houzly';

const args = process.argv.slice(2);
const FORCE_UPSERT = args.includes('--upsert');
const DRY_RUN = args.includes('--dry-run');

(async () => {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI non settata nelle environment variables');
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  console.log(`\n🌱 Onboarding seed — db: ${DB_NAME}`);
  console.log(`   mode: ${DRY_RUN ? 'DRY RUN' : (FORCE_UPSERT ? 'FORCE UPSERT' : 'safe (insert if missing)')}\n`);

  // ── Recipes ──────────────────────────────────────────────
  const recipesCol = db.collection('onboarding_recipes');
  let recIns = 0, recUpd = 0, recSkip = 0;

  for (const recipe of RECIPES) {
    const existing = await recipesCol.findOne({ _id: recipe._id });
    const doc = { ...recipe, created_at: existing?.created_at || new Date() };

    if (!existing) {
      if (!DRY_RUN) await recipesCol.insertOne(doc);
      recIns++;
      console.log(`  + recipe inserita: ${recipe._id}`);
    } else if (FORCE_UPSERT) {
      if (!DRY_RUN) await recipesCol.replaceOne({ _id: recipe._id }, doc);
      recUpd++;
      console.log(`  ↻ recipe aggiornata: ${recipe._id}`);
    } else {
      recSkip++;
    }
  }

  // ── Catalog ──────────────────────────────────────────────
  const catalogCol = db.collection('onboarding_catalog');
  let catIns = 0, catUpd = 0, catSkip = 0;

  for (const task of CATALOG) {
    const existing = await catalogCol.findOne({ _id: task._id });
    const now = new Date();
    const doc = {
      ...task,
      // applichi default per i campi opzionali
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
      if (!DRY_RUN) await catalogCol.insertOne(doc);
      catIns++;
      console.log(`  + task inserito: ${task._id}`);
    } else if (FORCE_UPSERT) {
      if (!DRY_RUN) await catalogCol.replaceOne({ _id: task._id }, doc);
      catUpd++;
      console.log(`  ↻ task aggiornato: ${task._id}`);
    } else {
      catSkip++;
    }
  }

  // ── Indici ──────────────────────────────────────────────
  if (!DRY_RUN) {
    await catalogCol.createIndex({ category: 1, order: 1 });
    await catalogCol.createIndex({ parent_id: 1 });
    await catalogCol.createIndex({ archived: 1 });

    const instCol = db.collection('onboarding_instances');
    await instCol.createIndex({ property_id: 1, task_id: 1 });
    await instCol.createIndex({ property_id: 1 });
    await instCol.createIndex({ status: 1, target_date: 1 });
    await instCol.createIndex({ parent_instance_id: 1 });
    console.log('\n  ✓ indici creati/verificati');
  }

  console.log(`\n📊 Riepilogo`);
  console.log(`   Recipes:   inserite ${recIns}, aggiornate ${recUpd}, skippate ${recSkip}`);
  console.log(`   Catalog:   inseriti ${catIns}, aggiornati ${catUpd}, skippati ${catSkip}`);

  // Statistiche utili
  const totalCat = await catalogCol.countDocuments();
  const parentCount = await catalogCol.countDocuments({ parent_id: null });
  const childCount = await catalogCol.countDocuments({ parent_id: { $ne: null } });

  console.log(`\n📦 Catalogo finale: ${totalCat} task totali (${parentCount} madre + ${childCount} sotto-task)`);

  await client.close();
  console.log('\n✓ done\n');
})().catch(err => {
  console.error('❌ errore:', err);
  process.exit(1);
});
