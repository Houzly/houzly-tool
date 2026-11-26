/**
 * Contratti — write-back nelle anagrafiche.
 *
 * Alla firma, e solo alla firma, i dati che il proprietario ha inserito nel
 * form entrano in `DB.proprietari` e `DB.proprieta`, che sono le sorgenti di
 * DAC7, CU e 770. Prima della firma non si scrive nulla: un'anagrafica
 * aggiornata da una bozza mai conclusa sporcherebbe gli adempimenti con dati
 * che nessuno ha confermato.
 *
 * Due regole che governano tutto il file:
 *
 * 1. Si scrive solo ciò che ha un valore. Un campo lasciato vuoto dal
 *    proprietario non azzera quello che l'anagrafica già conosce: la firma
 *    può arricchire o correggere, mai cancellare.
 *
 * 2. Si aggiornano i singoli campi, non il documento intero. Lo stato vive in
 *    un unico documento Mongo condiviso con il resto dell'applicazione: un
 *    salvataggio completo sovrascriverebbe qualunque modifica fatta altrove
 *    fra la lettura e la scrittura.
 */

const COLLEZIONE_STATO = 'db';
const DOC_STATO = 'main';

async function statoCol(getDb) {
  const db = await getDb();
  return db.collection(COLLEZIONE_STATO);
}

/** Identificatore nello stesso formato usato dal frontend. */
function nuovoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const vuoto = (v) => v === undefined || v === null || String(v).trim() === '';
const testo = (v) => (vuoto(v) ? '' : String(v).trim());
const maiuscolo = (v) => testo(v).toUpperCase();
const ibanPulito = (v) => maiuscolo(v).replace(/\s+/g, '');

/** Scrive la coppia solo se il valore c'è: le regole 1 e 2 stanno qui. */
function poni(destinazione, chiave, valore) {
  if (!vuoto(valore)) destinazione[chiave] = valore;
}

/* ------------------------------------------------------------------ *
 * Mappature: nostri campi → campi dell'anagrafica
 * ------------------------------------------------------------------ */

/**
 * Proprietario. Persona fisica e azienda hanno campi diversi: l'azienda usa
 * `ragione_sociale`, `piva` e `cf_az`, non `nome`/`cognome`/`cf`.
 */
function campiProprietario(m = {}, condizioni = {}) {
  const azienda = m.tipoSoggetto === 'azienda';
  const out = {};

  out.tipo = azienda ? 'azienda' : 'persona_fisica';

  if (azienda) {
    poni(out, 'ragione_sociale', testo(m.ragioneSociale));
    poni(out, 'piva', testo(m.piva) || testo(m.cf));
    poni(out, 'cf_az', maiuscolo(m.cf));
    poni(out, 'legale_rapp', testo(m.legaleRapp));
    poni(out, 'sdi', maiuscolo(m.sdi));
  } else {
    poni(out, 'nome', testo(m.nome));
    poni(out, 'cognome', testo(m.cognome));
    poni(out, 'cf', maiuscolo(m.cf));
    poni(out, 'sesso', maiuscolo(m.sesso));
    poni(out, 'data_nascita', testo(m.dataNascita));
    poni(out, 'comune_nascita', testo(m.comuneNascita));
    poni(out, 'prov_nascita', maiuscolo(m.provNascita));
  }

  poni(out, 'via', testo(m.via));
  poni(out, 'cap', testo(m.cap));
  poni(out, 'comune', testo(m.comune));
  poni(out, 'provincia', maiuscolo(m.provincia));
  poni(out, 'email', testo(m.email));
  poni(out, 'iban', ibanPulito(m.iban));

  // Il profilo fiscale viene dalle condizioni decise da Houzly, non dal
  // proprietario: sono le stesse che il contratto ha appena fissato.
  if (condizioni.compensoPerc != null && !Number.isNaN(+condizioni.compensoPerc)) {
    out.houzly_perc = +condizioni.compensoPerc;
  }
  if (condizioni.regimeIvaCodice) out.fisc_iva22 = condizioni.regimeIvaCodice === 'esclusa';
  if (condizioni.ritenuta !== undefined) out.fisc_cedolare = !!condizioni.ritenuta;

  return out;
}

/**
 * Indirizzo leggibile ricomposto dai campi strutturati.
 * Il form manda `tipoVia`/`viaNome`/`civico`/`cap`/`comune`/`provincia`, ma
 * l'anagrafica tiene anche un `indirizzo` in chiaro: è quello che si vede
 * negli elenchi e che finisce nell'XML della DAC7, quindi va mantenuto.
 */
function componiIndirizzo(i = {}) {
  if (!vuoto(i.indirizzo)) return testo(i.indirizzo);
  const pezzi = (...v) => v.filter((x) => !vuoto(x)).map((x) => String(x).trim()).join(' ');
  const strada = pezzi(i.tipoVia, i.viaNome, i.civico);
  const localita = pezzi(i.cap, i.comune);
  if (!strada && !localita) return '';
  return [strada, localita].filter(Boolean).join(', ') +
    (vuoto(i.provincia) ? '' : ` (${maiuscolo(i.provincia)})`);
}

/**
 * Nome della proprietà. Senza, nell'elenco Proprietà comparirebbe una riga
 * vuota e il proprietario non la riconoscerebbe. Si usa, in ordine: il nome
 * dato all'immobile, il nome struttura indicato alla creazione della pratica,
 * e in mancanza d'altro "Villa" più il comune. Resta modificabile a mano.
 */
function nomeProprieta(i = {}, caso = {}) {
  const n = testo(i.nome) || testo(caso.nomeStruttura);
  if (n) return n;
  const comune = testo(i.comune) || testo(i.catComune);
  return comune ? `Villa ${comune}` : '';
}

/** Immobile. `codice_comune` resta escluso: è il codice Belfiore, non lo sa il proprietario. */
function campiProprieta(i = {}, ownerId, caso = {}) {
  const out = {};
  poni(out, 'nome', nomeProprieta(i, caso));
  poni(out, 'indirizzo', componiIndirizzo(i));
  poni(out, 'cin', maiuscolo(i.cin));
  poni(out, 'cat_comune', testo(i.catComune));
  poni(out, 'cat_foglio', testo(i.catFoglio));
  poni(out, 'cat_part', testo(i.catPart));
  poni(out, 'cat_sub', testo(i.catSub));
  poni(out, 'cat_cat', maiuscolo(i.catCat));
  poni(out, 'tipo_via', testo(i.tipoVia));
  poni(out, 'via_nome', testo(i.viaNome));
  poni(out, 'n_civico', testo(i.civico));
  poni(out, 'scala', testo(i.scala));
  poni(out, 'interno', testo(i.interno));
  poni(out, 'piano', testo(i.piano));
  if (ownerId) out.proprietario_id = ownerId;
  return out;
}

/**
 * Comproprietari.
 * ATTENZIONE: in `coprops` la quota è una FRAZIONE (0.5 = 50%), mentre il
 * form la raccoglie in percentuale. Senza la divisione il gestionale
 * mostrerebbe 5000% e il controllo sulla somma delle quote fallirebbe.
 */
function campiCoproprietario(c = {}) {
  const out = {};
  poni(out, 'nome', testo(c.nome));
  poni(out, 'cognome', testo(c.cognome));
  poni(out, 'cf', maiuscolo(c.cf));
  poni(out, 'sesso', maiuscolo(c.sesso));
  poni(out, 'data_nascita', testo(c.dataNascita));
  poni(out, 'comune_nascita', testo(c.comuneNascita));
  poni(out, 'prov_nascita', maiuscolo(c.provNascita));
  poni(out, 'via', testo(c.via));
  poni(out, 'cap', testo(c.cap));
  poni(out, 'comune', testo(c.comune));
  poni(out, 'provincia', maiuscolo(c.provincia));
  poni(out, 'email', testo(c.email));
  poni(out, 'iban', ibanPulito(c.iban));

  const q = parseFloat(String(c.quota || '').replace(',', '.'));
  if (!Number.isNaN(q) && q > 0) out.perc = q / 100;

  return out;
}

/* ------------------------------------------------------------------ *
 * Scrittura
 * ------------------------------------------------------------------ */

/**
 * Aggiorna un elemento di un array di primo livello per id, campo per campo.
 * arrayFilters tocca solo le chiavi indicate: tutto il resto del documento,
 * comprese le modifiche fatte altrove nel frattempo, resta dov'è.
 */
async function aggiornaElemento(col, array, id, campi) {
  const chiavi = Object.keys(campi);
  if (!chiavi.length) return 0;
  const set = {};
  for (const k of chiavi) set[`${array}.$[elem].${k}`] = campi[k];
  const r = await col.updateOne(
    { _id: DOC_STATO },
    { $set: set },
    { arrayFilters: [{ 'elem.id': id }] }
  );
  return r.modifiedCount;
}

async function aggiungiElemento(col, array, elemento) {
  await col.updateOne({ _id: DOC_STATO }, { $push: { [array]: elemento } });
  return elemento.id;
}

/**
 * Esegue il write-back per una pratica firmata.
 * Restituisce un resoconto, che finisce nell'audit: serve a sapere mesi dopo
 * quali anagrafiche sono state toccate da quale contratto.
 */
async function applicaWriteBack(getDb, caso) {
  const col = await statoCol(getDb);
  const stato = await col.findOne(
    { _id: DOC_STATO },
    { projection: { proprietari: 1, proprieta: 1 } }
  );
  if (!stato) throw new Error('documento di stato non trovato');

  const proprietari = stato.proprietari || [];
  const proprieta = stato.proprieta || [];
  const esito = { ownerId: null, propertyId: null, ownerCreato: false, propCreata: false, coprops: 0 };

  /* — proprietario — */
  const campiOwner = campiProprietario(caso.mandante, caso.condizioni);
  let ownerId = caso.ownerId || null;
  if (ownerId && !proprietari.some((o) => o.id === ownerId)) ownerId = null; // cancellato nel frattempo

  // Nessun id dal backoffice: prima di creare si guarda se quella persona è
  // già in anagrafica, riconoscendola dal codice fiscale o dalla partita IVA.
  // Senza questo controllo un proprietario già censito, ma non selezionato
  // nella tendina, finirebbe duplicato — e un duplicato spezza in due la sua
  // CU e la sua DAC7.
  if (!ownerId) {
    const chiave = (campiOwner.cf || campiOwner.cf_az || campiOwner.piva || '').toUpperCase();
    if (chiave) {
      const gia = proprietari.find((o) =>
        [o.cf, o.cf_az, o.piva].some((x) => x && String(x).toUpperCase() === chiave));
      if (gia) ownerId = gia.id;
    }
  }

  if (ownerId) {
    await aggiornaElemento(col, 'proprietari', ownerId, campiOwner);
  } else {
    ownerId = nuovoId();
    await aggiungiElemento(col, 'proprietari', {
      id: ownerId,
      coprops: [],
      fisc_iva22: false,
      fisc_cedolare: true,
      houzly_perc: 20,
      ...campiOwner,
    });
    esito.ownerCreato = true;
  }
  esito.ownerId = ownerId;

  /* — immobile — */
  const campiImm = campiProprieta(caso.immobile, ownerId, caso);
  let propertyId = caso.propertyId || null;
  if (propertyId && !proprieta.some((p) => p.id === propertyId)) propertyId = null;

  // Stessa logica per l'immobile: il CIN è un identificativo nazionale unico,
  // quindi se c'è già una proprietà con quel CIN è la stessa casa.
  if (!propertyId && campiImm.cin) {
    const gia = proprieta.find((p) => p.cin &&
      String(p.cin).toUpperCase() === String(campiImm.cin).toUpperCase());
    if (gia) propertyId = gia.id;
  }

  if (propertyId) {
    await aggiornaElemento(col, 'proprieta', propertyId, campiImm);
  } else {
    propertyId = nuovoId();
    await aggiungiElemento(col, 'proprieta', {
      id: propertyId,
      coprops: [],
      pulizie_owner: false,
      ...campiImm,
    });
    esito.propCreata = true;
  }
  esito.propertyId = propertyId;

  /* — comproprietari e riga di contratto —
   *
   * I comproprietari NON stanno sulla proprietà: `getPropertyCoprops()` li
   * cerca sul contratto che contiene quell'immobile, con ripiego sul
   * proprietario. Scriverli altrove li rende invisibili all'elenco
   * proprietari, ai report e soprattutto a CU e DAC7, che ripartiscono le
   * quote proprio da lì.
   *
   * Per questo il write-back crea anche la riga in `DB.contratti`: non è un
   * duplicato della pratica, è il record che il gestionale legge per sapere
   * condizioni economiche e cointestazioni di quell'immobile. */
  const coprops = (caso.comproprietari || [])
    .map(campiCoproprietario)
    .filter((c) => c.nome || c.cognome);
  esito.coprops = coprops.length;

  esito.contrattoId = await scriviRigaContratto(col, caso, ownerId, propertyId, coprops);

  return esito;
}

/** Condizioni del contratto nel formato numerico che usa il gestionale. */
function rigaContratto(caso, ownerId, propertyId, coprops) {
  const c = caso.condizioni || {};
  const num = (v, d) => {
    const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return Number.isNaN(n) ? d : n;
  };
  // `data` in ISO: è il formato che ctrFmtDataEstesa() si aspetta.
  const iso = (caso.pdfFinale?.generatoIl || new Date().toISOString()).slice(0, 10);

  return {
    owner_id: ownerId,
    prop_ids: propertyId ? [propertyId] : [],
    perc: num(c.compensoPerc, 30),
    iva: c.regimeIvaCodice === 'esclusa' ? 'esclusa' : 'inclusa',
    ritenuta: c.ritenuta !== undefined ? !!c.ritenuta : true,
    durata: num(c.durataAnni, 1),
    preavviso: num(String(c.preavvisoRecesso || '').match(/\d+/)?.[0], 6),
    soglia: num(String(c.sogliaSpesa || '').replace(/[^\d,.]/g, '').replace(',', '.'), 50),
    luogo: testo(caso.luogoFirma),
    data: iso,
    extra: testo(c.pattuizioni),
    coprops,
    versione: testo(caso.templateVersione) || '1.9',
    stato: 'firmato',
    testo_override: null,
    // Aggancio alla pratica firmata: da qui si risale al PDF e all'audit.
    pratica_rif: testo(caso.riferimento),
  };
}

/**
 * Scrive o aggiorna la riga di contratto. Se la pratica è già passata di qui
 * (rigenerazione, firma ritentata) si aggiorna quella, non se ne crea un'altra.
 */
async function scriviRigaContratto(col, caso, ownerId, propertyId, coprops) {
  const campi = rigaContratto(caso, ownerId, propertyId, coprops);
  const stato = await col.findOne(
    { _id: DOC_STATO },
    { projection: { contratti: 1 } }
  );
  const esistente = (stato?.contratti || []).find(
    (k) => k.pratica_rif && k.pratica_rif === campi.pratica_rif
  );

  if (esistente) {
    await aggiornaElemento(col, 'contratti', esistente.id, {
      ...campi,
      updated: new Date().toISOString(),
    });
    return esistente.id;
  }

  const id = nuovoId();
  const ora = new Date().toISOString();
  await col.updateOne(
    { _id: DOC_STATO },
    { $push: { contratti: { id, ...campi, created: ora, updated: ora } } }
  );
  return id;
}

/**
 * Elenca i campi che DAC7, CU e 770 richiedono e che risultano ancora vuoti.
 * Non blocca la firma — un contratto valido non può dipendere da un campo
 * fiscale — ma lascia traccia nell'audit e permette al backoffice di
 * segnalarlo invece di scoprirlo a gennaio.
 */
function campiFiscaliMancanti(caso) {
  const m = caso.mandante || {};
  const i = caso.immobile || {};
  const azienda = m.tipoSoggetto === 'azienda';
  const mancanti = [];

  const chiedi = (valore, etichetta) => { if (vuoto(valore)) mancanti.push(etichetta); };

  if (azienda) {
    chiedi(m.ragioneSociale, 'ragione sociale');
    chiedi(m.piva || m.cf, 'partita IVA');
    chiedi(m.legaleRapp, 'legale rappresentante');
  } else {
    chiedi(m.nome, 'nome');
    chiedi(m.cognome, 'cognome');
    chiedi(m.cf, 'codice fiscale');
    chiedi(m.sesso, 'sesso');
    chiedi(m.dataNascita, 'data di nascita');
    chiedi(m.comuneNascita, 'comune di nascita');
    chiedi(m.provNascita, 'provincia di nascita');
  }
  chiedi(m.via, 'indirizzo');
  chiedi(m.cap, 'CAP');
  chiedi(m.comune, 'comune');
  chiedi(m.provincia, 'provincia');
  chiedi(m.iban, 'IBAN');

  chiedi(i.cin, 'CIN immobile');
  chiedi(i.catComune, 'comune catastale');
  chiedi(i.catFoglio, 'foglio');
  chiedi(i.catPart, 'particella');
  chiedi(i.catSub, 'subalterno');
  chiedi(i.catCat, 'categoria catastale');

  return mancanti;
}

module.exports = {
  applicaWriteBack,
  nomeProprieta,
  rigaContratto,
  campiFiscaliMancanti,
  campiProprietario,
  campiProprieta,
  campiCoproprietario,
};
