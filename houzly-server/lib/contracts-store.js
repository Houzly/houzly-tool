/**
 * Contratti — livello di accesso ai dati.
 *
 * Collezioni:
 *   contract_cases    una riga per pratica (invito → compilazione → firma)
 *   contract_counters contatore per il riferimento progressivo HZ-AAAA-NNNN
 *
 * Il template NON sta su Mongo: sta nel repo, versionato in templates/.
 * Alla firma se ne salva lo snapshot risolto dentro la pratica.
 */

const crypto = require('crypto');

const COL_CASES = 'contract_cases';
const COL_COUNTERS = 'contract_counters';

/** Stati ammessi e transizioni consentite. */
const STATI = ['bozza', 'inviata', 'in_compilazione', 'firmata', 'annullata'];

const TRANSIZIONI = {
  bozza: ['inviata', 'annullata'],
  inviata: ['in_compilazione', 'annullata'],
  in_compilazione: ['firmata', 'annullata'],
  firmata: [],        // stato terminale: da qui non si esce
  annullata: [],      // idem
};

function puoTransire(da, a) {
  return (TRANSIZIONI[da] || []).includes(a);
}

/* ------------------------------------------------------------------ *
 * Token
 * ------------------------------------------------------------------ */

/**
 * Genera il token dell'invito.
 * In chiaro finisce SOLO nel link inviato per email; su Mongo si salva
 * l'hash. Così un accesso in lettura al database non permette di firmare
 * contratti al posto dei proprietari.
 */
function generaToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Indici
 * ------------------------------------------------------------------ */

async function ensureIndexes(getDb) {
  const db = await getDb();
  const col = db.collection(COL_CASES);

  // Un indice sparse salta i documenti in cui il campo MANCA, non quelli in cui
  // vale null: due pratiche con tokenHash:null violerebbero l'unicità. Le
  // pratiche chiuse rimuovono il campo (unset); qui si sistemano quelle create
  // prima della correzione. L'operazione è idempotente.
  const bonifica = await col.updateMany({ tokenHash: null }, { $unset: { tokenHash: '' } });
  if (bonifica.modifiedCount) {
    console.log(`[contracts] bonificate ${bonifica.modifiedCount} pratiche con tokenHash null`);
  }

  await col.createIndex({ tokenHash: 1 }, { unique: true, sparse: true });
  await col.createIndex({ riferimento: 1 }, { unique: true });
  await col.createIndex({ stato: 1, createdAt: -1 });
  await col.createIndex({ email: 1 });
  return true;
}

/* ------------------------------------------------------------------ *
 * Riferimento progressivo
 * ------------------------------------------------------------------ */

async function prossimoRiferimento(getDb) {
  const db = await getDb();
  const anno = new Date().getFullYear();
  const r = await db.collection(COL_COUNTERS).findOneAndUpdate(
    { _id: `contracts-${anno}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const seq = (r && r.seq) || (r && r.value && r.value.seq) || 1;
  return `HZ-${anno}-${String(seq).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

/**
 * Estrae l'IP reale del client.
 * Render sta dietro a un proxy: req.ip restituirebbe l'indirizzo del proxy,
 * quindi si legge il primo valore di X-Forwarded-For. Senza questo, tutta
 * la pagina di audit riporterebbe sempre lo stesso IP interno e non
 * proverebbe nulla.
 */
function ipClient(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || null;
}

function eventoAudit(evento, req, extra = {}) {
  return {
    ts: new Date().toISOString(),
    evento,
    ip: req ? ipClient(req) : null,
    userAgent: req ? (req.headers['user-agent'] || null) : 'backoffice/houzly-tool',
    ...extra,
  };
}

async function pushAudit(getDb, filtro, evento) {
  const db = await getDb();
  await db.collection(COL_CASES).updateOne(filtro, { $push: { audit: evento } });
}

/* ------------------------------------------------------------------ *
 * Accesso pratiche
 * ------------------------------------------------------------------ */

async function cases(getDb) {
  const db = await getDb();
  return db.collection(COL_CASES);
}

async function trovaPerToken(getDb, token) {
  const col = await cases(getDb);
  return col.findOne({ tokenHash: hashToken(token) });
}

/** Scadenza superata? Le pratiche firmate non scadono mai. */
function scaduta(caso) {
  if (!caso || caso.stato === 'firmata') return false;
  if (!caso.scadenzaAt) return false;
  return new Date(caso.scadenzaAt).getTime() < Date.now();
}

module.exports = {
  COL_CASES,
  COL_COUNTERS,
  STATI,
  puoTransire,
  generaToken,
  hashToken,
  ensureIndexes,
  prossimoRiferimento,
  ipClient,
  eventoAudit,
  pushAudit,
  cases,
  trovaPerToken,
  scaduta,
};
