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
 * Dati ricavati dal codice fiscale
 * ------------------------------------------------------------------ */

/**
 * Sesso, data di nascita e codice Belfiore letti dal codice fiscale.
 *
 * Il codice Belfiore (campo 8 della CU, "Codice Comune cat." in anagrafica)
 * non si chiede a nessuno: nessun proprietario lo conosce e nessun modulo
 * ragionevole lo domanda. Ma sta dentro al codice fiscale, che è
 * obbligatorio, insieme a sesso e data di nascita. Ricavarlo qui è l'unico
 * modo perché quel campo non resti vuoto per sempre — ed è esattamente la
 * fonte che usa l'Agenzia delle Entrate.
 *
 * Gestisce l'omocodia: quando due persone otterrebbero lo stesso codice,
 * alcune cifre vengono sostituite da lettere secondo una tabella fissa, e
 * una lettura ingenua darebbe una data senza senso.
 */
const OMOCODIA = { L: '0', M: '1', N: '2', P: '3', Q: '4', R: '5', S: '6', T: '7', U: '8', V: '9' };
const MESI_CF = { A: 1, B: 2, C: 3, D: 4, E: 5, H: 6, L: 7, M: 8, P: 9, R: 10, S: 11, T: 12 };

function cifra(carattere) {
  if (/\d/.test(carattere)) return carattere;
  return OMOCODIA[carattere] !== undefined ? OMOCODIA[carattere] : null;
}

function datiDaCodiceFiscale(cfGrezzo) {
  const cf = maiuscolo(cfGrezzo).replace(/\s+/g, '');
  if (!/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/.test(cf.replace(/[LMNPQRSTUV]/g, (c, i) =>
    [6, 7, 9, 10, 12, 13, 14].includes(i) ? OMOCODIA[c] : c))) {
    // Non è un codice fiscale di persona fisica: niente da ricavare.
    if (cf.length !== 16) return {};
  }

  const num = (i) => cifra(cf[i]);
  const aa = [num(6), num(7)];
  const gg = [num(9), num(10)];
  const mese = MESI_CF[cf[8]];
  if (aa.includes(null) || gg.includes(null) || !mese) return {};

  let giorno = parseInt(gg.join(''), 10);
  const sesso = giorno > 40 ? 'F' : 'M';
  if (giorno > 40) giorno -= 40;
  if (giorno < 1 || giorno > 31) return {};

  // Secolo: il codice fiscale porta solo due cifre. Si sceglie il 1900
  // salvo che l'anno nel 2000 dia una persona di almeno diciotto anni —
  // un minore non può essere parte di un contratto di mandato.
  const annoCorrente = new Date().getFullYear();
  const aaNum = parseInt(aa.join(''), 10);
  const anno = aaNum <= (annoCorrente % 100) - 18 ? 2000 + aaNum : 1900 + aaNum;

  // Belfiore: quattro caratteri, una lettera e tre cifre (anche omocodiche).
  const belfiore = cf[11] + [12, 13, 14].map(num).join('');
  const codiceComune = /^[A-Z]\d{3}$/.test(belfiore) ? belfiore : '';

  return {
    sesso,
    dataNascita: `${anno}-${String(mese).padStart(2, '0')}-${String(giorno).padStart(2, '0')}`,
    codiceComune,
  };
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
    const da = datiDaCodiceFiscale(m.cf);
    poni(out, 'nome', testo(m.nome));
    poni(out, 'cognome', testo(m.cognome));
    poni(out, 'cf', maiuscolo(m.cf));
    poni(out, 'sesso', maiuscolo(m.sesso) || da.sesso);
    poni(out, 'data_nascita', testo(m.dataNascita) || da.dataNascita);
    poni(out, 'comune_nascita', testo(m.comuneNascita));
    poni(out, 'prov_nascita', maiuscolo(m.provNascita));
    // Belfiore di nascita, campo 8 della CU: non lo si chiede, sta nel CF.
    poni(out, 'codice_comune', da.codiceComune);
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

  /* Compenso e IVA pattuiti: vanno scritti QUI, sull'immobile.
   *
   * `getEffectiveHouzlyConfig()` tratta la proprietà come fonte primaria e
   * ripiega sul proprietario solo se questi campi sono nulli. Lasciandoli
   * vuoti la scheda della proprietà mostra la casella del compenso in bianco
   * e sotto la riga "Eredita dal Proprietario: 20%" — che è un ripiego, non
   * il dato del contratto: basta cambiare la percentuale di default del
   * proprietario e questo immobile seguirebbe, pur avendo un contratto che
   * dice altro. Il form li tiene in sola lettura proprio perché li fissa il
   * contratto. */
  const c = caso.condizioni || {};
  if (c.compensoPerc != null && !Number.isNaN(+c.compensoPerc)) {
    out.houzly_perc = +c.compensoPerc;
  }
  if (c.regimeIvaCodice) out.iva22_override = c.regimeIvaCodice === 'esclusa';

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
  // Dal codice fiscale si ricava ciò che il modulo non chiede o che il
  // proprietario ha lasciato in bianco: così nella scheda del comproprietario
  // non resta vuoto niente di utile a DAC7, CU e 770.
  const da = datiDaCodiceFiscale(c.cf);

  poni(out, 'nome', testo(c.nome));
  poni(out, 'cognome', testo(c.cognome));
  poni(out, 'cf', maiuscolo(c.cf));
  poni(out, 'sesso', maiuscolo(c.sesso) || da.sesso);
  poni(out, 'data_nascita', testo(c.dataNascita) || da.dataNascita);
  poni(out, 'comune_nascita', testo(c.comuneNascita));
  poni(out, 'prov_nascita', maiuscolo(c.provNascita));
  poni(out, 'codice_comune', da.codiceComune);
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

/* Forma completa di un comproprietario in anagrafica: sono le chiavi che il
 * gestionale mostra nella scheda del proprietario. Si scrivono tutte, anche
 * vuote, perché la scheda le vuole presenti per poterle compilare a mano. */
const COPROP_VUOTO = {
  nome: '', cognome: '', cf: '', sesso: '', data_nascita: '',
  comune_nascita: '', prov_nascita: '', via: '', cap: '', comune: '',
  provincia: '', codice_comune: '', email: '', iban: '', perc: 0,
};

/**
 * Comproprietari nella scheda del proprietario.
 *
 * Non basta scriverli sulla riga di contratto. `getPropertyCoprops()` legge
 * da lì, ma la sezione Proprietari, la ripartizione della CU e l'elenco per
 * DAC7 leggono `proprietari[].coprops`: senza questa scrittura la scheda del
 * proprietario resterebbe senza comproprietari e andrebbero ricompilati a
 * mano, uno per uno, con tutti i dati fiscali.
 *
 * Si fondono con quelli che ci sono già: lo stesso comproprietario si
 * riconosce dal codice fiscale, e in mancanza da nome e cognome. Di chi è
 * già censito si aggiornano solo i campi che arrivano pieni — un comune di
 * nascita inserito a mano in anagrafica non viene cancellato da una pratica
 * in cui quel campo era vuoto.
 */
async function scriviCopropsProprietario(col, ownerId, coprops) {
  if (!coprops.length) return 0;

  const stato = await col.findOne({ _id: DOC_STATO }, { projection: { proprietari: 1 } });
  const owner = (stato?.proprietari || []).find((o) => o.id === ownerId);
  if (!owner) return 0;

  const elenco = (owner.coprops || []).map((c) => ({ ...c }));
  const cf = (c) => String(c.cf || '').toUpperCase().trim();
  const nomeDi = (c) => `${c.nome || ''} ${c.cognome || ''}`.replace(/\s+/g, ' ').trim().toUpperCase();

  // Si tiene traccia di QUALI sono stati aggiunti, non di quanti: serve
  // all'eliminazione della pratica, che deve togliere i comproprietari che
  // ha portato lei e lasciare quelli che c'erano già.
  const aggiunti = [];
  for (const nuovo of coprops) {
    const gia = elenco.find((c) =>
      (cf(nuovo) && cf(c) === cf(nuovo)) ||
      (!cf(nuovo) && nomeDi(nuovo) && nomeDi(c) === nomeDi(nuovo)));

    if (gia) {
      Object.assign(gia, nuovo); // `nuovo` contiene solo campi pieni
    } else {
      elenco.push({ ...COPROP_VUOTO, ...nuovo });
      aggiunti.push({ cf: cf(nuovo), nome: nomeDi(nuovo) });
    }
  }

  await aggiornaElemento(col, 'proprietari', ownerId, { coprops: elenco });
  return aggiunti;
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
      // Firma di provenienza: dice che questa scheda l'ha creata una pratica,
      // e quale. Senza, una volta eliminata la pratica non ci sarebbe modo di
      // distinguere un residuo da un proprietario inserito a mano.
      creato_da_contratto: caso.riferimento || null,
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
      creato_da_contratto: caso.riferimento || null,
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
   * condizioni economiche e cointestazioni di quell'immobile.
   *
   * E li scrive una seconda volta nella scheda del proprietario, perché la
   * sezione Proprietari e la ripartizione per CU e DAC7 leggono da lì. Sono
   * due usi diversi degli stessi dati, non una duplicazione per sbaglio: il
   * contratto dice chi è cointestato di quell'immobile, l'anagrafica tiene i
   * dati fiscali delle persone. */
  const coprops = (caso.comproprietari || [])
    .map(campiCoproprietario)
    .filter((c) => c.nome || c.cognome);
  esito.coprops = coprops.length;

  esito.contrattoId = await scriviRigaContratto(col, caso, ownerId, propertyId, coprops);
  esito.copropsAggiunti = await scriviCopropsProprietario(col, ownerId, coprops);
  esito.copropsNuovi = esito.copropsAggiunti.length;

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

/* ------------------------------------------------------------------ *
 * Eliminazione di una pratica e di ciò che ha scritto
 * ------------------------------------------------------------------ */

/**
 * Quante volte un id compare nel resto del documento di stato.
 *
 * Serve a non cancellare un proprietario o un immobile che nel frattempo
 * qualcosa usa: una prenotazione, un anticipo, una ricevuta, un altro
 * contratto. Si cerca l'id ovunque invece di controllare un elenco fisso di
 * campi, perché il gestionale ha una trentina di raccolte e una dimenticata
 * si pagherebbe con un riferimento rotto che salta fuori mesi dopo.
 *
 * `escludi` sono le raccolte in cui l'id può comparire legittimamente perché
 * stanno per essere rimosse anche loro, e `idProprio` è l'elemento stesso,
 * che ovviamente contiene il proprio id.
 */
function usatoAltrove(stato, id, { escludi = [], saltaElementoConId = true } = {}) {
  if (!id) return [];
  const dove = [];

  const cerca = (valore, percorso) => {
    if (dove.length > 6) return; // bastano i primi per capire
    if (valore === id) { dove.push(percorso); return; }
    if (Array.isArray(valore)) {
      valore.forEach((v, i) => cerca(v, `${percorso}[${i}]`));
      return;
    }
    if (valore && typeof valore === 'object') {
      if (saltaElementoConId && valore.id === id) return; // è l'elemento stesso
      for (const k of Object.keys(valore)) cerca(valore[k], percorso ? `${percorso}.${k}` : k);
    }
  };

  for (const chiave of Object.keys(stato)) {
    if (chiave === '_id' || escludi.includes(chiave)) continue;
    cerca(stato[chiave], chiave);
  }
  return dove;
}

/**
 * Cosa verrebbe rimosso eliminando una pratica, senza rimuovere niente.
 *
 * La regola: si tocca solo ciò che la pratica ha creato. Il write-back ha
 * registrato se proprietario e immobile li ha creati lui o li ha trovati
 * già in anagrafica; un proprietario che esisteva prima resta dov'è, al
 * massimo perde i comproprietari che questa pratica gli ha aggiunto.
 */
async function anteprimaEliminazione(getDb, caso) {
  const col = await statoCol(getDb);
  const stato = (await col.findOne({ _id: DOC_STATO })) || {};
  const wb = caso.writeBack || {};

  const contratti = stato.contratti || [];
  const riga = contratti.find((k) => k.pratica_rif && k.pratica_rif === caso.riferimento) || null;

  const esito = {
    riferimento: caso.riferimento,
    stato: caso.stato,
    fileR2: (caso.allegati || []).filter((a) => a.r2Key).length + (caso.pdfFinale?.r2Key ? 1 : 0),
    rigaContratto: riga ? { id: riga.id, data: riga.data } : null,
    immobile: null,
    proprietario: null,
    coprops: (wb.copropsAggiunti || []).map((c) => c.nome || c.cf),
  };

  // Escludendo `contratti`: la riga di questa pratica sparisce comunque.
  const senzaContratti = { escludi: ['contratti'] };

  /* Due prove indipendenti che una scheda l'ha creata questa pratica: il
   * resoconto del write-back e la firma sulla scheda stessa. Basta una.
   * Il resoconto può essersi perso in un riallineamento fatto con una
   * versione che lo riscriveva da capo; la firma, una volta apposta, resta. */
  const creataDaQui = (r) => !!r && r.creato_da_contratto === caso.riferimento;

  const propTrovata = (stato.proprieta || []).find((x) => x.id === wb.propertyId);
  if ((wb.propCreata || creataDaQui(propTrovata)) && wb.propertyId) {
    const usi = usatoAltrove(stato, wb.propertyId, senzaContratti);
    esito.immobile = propTrovata
      ? {
        id: propTrovata.id,
        nome: propTrovata.nome || '(senza nome)',
        eliminabile: !usi.length,
        usatoIn: usi,
      }
      : null;
  }

  const ownerTrovato = (stato.proprietari || []).find((x) => x.id === wb.ownerId);
  if ((wb.ownerCreato || creataDaQui(ownerTrovato)) && wb.ownerId) {
    const o = ownerTrovato;
    // L'immobile di questa pratica punta al proprietario: non conta come uso
    // esterno, perché sta per essere rimosso anche lui.
    const usi = usatoAltrove(stato, wb.ownerId, senzaContratti)
      .filter((d) => !(esito.immobile?.eliminabile && d.startsWith('proprieta[')));
    esito.proprietario = o
      ? {
        id: o.id,
        nome: [o.nome, o.cognome].filter(Boolean).join(' ') || o.ragione_sociale || '(senza nome)',
        eliminabile: !usi.length,
        usatoIn: usi,
      }
      : null;
  }

  return esito;
}

/**
 * Rimuove dalle anagrafiche ciò che la pratica aveva scritto.
 * Non tocca il documento della pratica né i file su R2: quelli li gestisce
 * la rotta, che sa anche come parlare con R2.
 */
async function eliminaScritture(getDb, caso) {
  const col = await statoCol(getDb);
  const piano = await anteprimaEliminazione(getDb, caso);
  const wb = caso.writeBack || {};
  const fatto = { rigaContratto: false, immobile: false, proprietario: false, coprops: 0, tenuti: [] };

  if (piano.rigaContratto) {
    await col.updateOne(
      { _id: DOC_STATO },
      { $pull: { contratti: { pratica_rif: caso.riferimento } } }
    );
    fatto.rigaContratto = true;
  }

  // Comproprietari aggiunti a un proprietario che esisteva già: il
  // proprietario resta, i comproprietari portati da questa pratica no.
  const aggiunti = wb.copropsAggiunti || [];
  if (aggiunti.length && wb.ownerId && !wb.ownerCreato) {
    const s = await col.findOne({ _id: DOC_STATO }, { projection: { proprietari: 1 } });
    const o = (s?.proprietari || []).find((x) => x.id === wb.ownerId);
    if (o) {
      const daTogliere = new Set(aggiunti.map((c) => (c.cf || c.nome || '').toUpperCase()));
      const restano = (o.coprops || []).filter((c) => {
        const chiavi = [
          String(c.cf || '').toUpperCase(),
          `${c.nome || ''} ${c.cognome || ''}`.replace(/\s+/g, ' ').trim().toUpperCase(),
        ].filter(Boolean);
        return !chiavi.some((k) => daTogliere.has(k));
      });
      fatto.coprops = (o.coprops || []).length - restano.length;
      if (fatto.coprops) await aggiornaElemento(col, 'proprietari', wb.ownerId, { coprops: restano });
    }
  }

  if (piano.immobile) {
    if (piano.immobile.eliminabile) {
      await col.updateOne({ _id: DOC_STATO }, { $pull: { proprieta: { id: piano.immobile.id } } });
      fatto.immobile = true;
    } else {
      fatto.tenuti.push(`immobile "${piano.immobile.nome}" (usato da ${piano.immobile.usatoIn[0]})`);
    }
  }

  if (piano.proprietario) {
    if (piano.proprietario.eliminabile) {
      await col.updateOne({ _id: DOC_STATO }, { $pull: { proprietari: { id: piano.proprietario.id } } });
      fatto.proprietario = true;
    } else {
      fatto.tenuti.push(`proprietario "${piano.proprietario.nome}" (usato da ${piano.proprietario.usatoIn[0]})`);
    }
  }

  return fatto;
}

/* ------------------------------------------------------------------ *
 * Pulizia dei residui
 * ------------------------------------------------------------------ */

/**
 * Cerca in anagrafica quello che è rimasto appeso a pratiche che non ci
 * sono più.
 *
 * Succede dopo le prove, o se una pratica viene eliminata quando il suo
 * immobile risultava ancora usato e poi quell'uso sparisce. Si distingue fra
 * due gradi di certezza, perché non sono la stessa cosa:
 *
 * - "orfani": portano la firma `creato_da_contratto` di una pratica che non
 *   esiste più. Qui si sa con certezza da dove vengono.
 * - "inutilizzati": nessuno li nomina da nessuna parte, ma non portano
 *   firma. Possono essere residui di prove fatte prima, oppure un
 *   proprietario inserito a mano e non ancora attivo: si elencano, non si
 *   cancellano da soli.
 *
 * In nessuno dei due casi si rimuove qualcosa di cui esista un uso.
 */
async function anteprimaPulizia(getDb, riferimentiVivi) {
  const col = await statoCol(getDb);
  const stato = (await col.findOne({ _id: DOC_STATO })) || {};
  const vivi = new Set(riferimentiVivi || []);

  const contratti = stato.contratti || [];
  const proprieta = stato.proprieta || [];
  const proprietari = stato.proprietari || [];

  // Righe di contratto che puntano a una pratica sparita.
  const contrattiOrfani = contratti
    .filter((k) => k.pratica_rif && !vivi.has(k.pratica_rif))
    .map((k) => ({
      id: k.id,
      pratica: k.pratica_rif,
      proprietario: (() => {
        const o = proprietari.find((x) => x.id === k.owner_id);
        return o ? [o.nome, o.cognome].filter(Boolean).join(' ') || o.ragione_sociale || k.owner_id : k.owner_id;
      })(),
      data: k.data || null,
    }));

  // Le righe orfane stanno per sparire: non devono far sembrare "usati"
  // il proprietario e l'immobile che nominano.
  const idOrfani = new Set(contrattiOrfani.map((k) => k.id));
  const statoSenzaOrfani = {
    ...stato,
    contratti: contratti.filter((k) => !idOrfani.has(k.id)),
  };

  const schede = (elenco, tipo, istantanea) => {
    const orfani = [];
    const inutilizzati = [];
    for (const r of elenco) {
      const usi = usatoAltrove(istantanea, r.id, {});
      if (usi.length) continue;
      const nome = tipo === 'proprieta'
        ? (r.nome || '(senza nome)')
        : ([r.nome, r.cognome].filter(Boolean).join(' ') || r.ragione_sociale || '(senza nome)');
      const voce = { id: r.id, nome, pratica: r.creato_da_contratto || null };
      if (r.creato_da_contratto && !vivi.has(r.creato_da_contratto)) orfani.push(voce);
      else if (!r.creato_da_contratto) inutilizzati.push(voce);
    }
    return { orfani, inutilizzati };
  };

  const imm = schede(proprieta, 'proprieta', statoSenzaOrfani);

  /* I proprietari si valutano su un'istantanea senza gli immobili che
   * possono essere rimossi — tutti e due i gruppi, non solo quelli certi.
   *
   * Altrimenti un proprietario di prova non comparirebbe mai nell'elenco:
   * il suo unico immobile lo cita, e finché quell'immobile è in piedi lui
   * risulta "in uso". Si finiva per poter togliere Villa Roma e non il suo
   * proprietario, che restava in anagrafica senza niente attaccato. */
  const idImmFuori = new Set([...imm.orfani, ...imm.inutilizzati].map((x) => x.id));
  const statoSenzaImmobili = {
    ...statoSenzaOrfani,
    proprieta: (statoSenzaOrfani.proprieta || []).filter((p) => !idImmFuori.has(p.id)),
  };
  const own = schede(proprietari, 'proprietari', statoSenzaImmobili);

  /* Da quali immobili dipende la rimovibilità di ciascun proprietario: il
   * modulo li usa per tenere coerente la selezione, perché un proprietario
   * non si può togliere lasciando in piedi un immobile che lo nomina. */
  for (const o of [...own.orfani, ...own.inutilizzati]) {
    o.dipendeDa = (statoSenzaOrfani.proprieta || [])
      .filter((p) => idImmFuori.has(p.id) && usatoAltrove({ x: p }, o.id, {}).length)
      .map((p) => p.id);
  }

  return {
    contrattiOrfani,
    immobiliOrfani: imm.orfani,
    immobiliInutilizzati: imm.inutilizzati,
    proprietariOrfani: own.orfani,
    proprietariInutilizzati: own.inutilizzati,
    totale: contrattiOrfani.length + imm.orfani.length + own.orfani.length,
  };
}

/**
 * Rimuove i residui indicati. Ogni id viene ricontrollato qui: l'elenco
 * arriva dal browser, e fra l'anteprima e la conferma può essere cambiato
 * qualcosa — o l'elenco stesso.
 */
async function applicaPulizia(getDb, riferimentiVivi, scelte = {}) {
  const col = await statoCol(getDb);
  const piano = await anteprimaPulizia(getDb, riferimentiVivi);
  const fatto = { contratti: 0, immobili: 0, proprietari: 0, rifiutati: [] };

  const ammessi = (gruppi, chiesti) => {
    const validi = new Map();
    gruppi.flat().forEach((v) => validi.set(v.id, v));
    return (chiesti || []).filter((id) => {
      if (validi.has(id)) return true;
      fatto.rifiutati.push(id);
      return false;
    });
  };

  for (const id of ammessi([piano.contrattiOrfani], scelte.contratti)) {
    await col.updateOne({ _id: DOC_STATO }, { $pull: { contratti: { id } } });
    fatto.contratti += 1;
  }
  for (const id of ammessi([piano.immobiliOrfani, piano.immobiliInutilizzati], scelte.immobili)) {
    await col.updateOne({ _id: DOC_STATO }, { $pull: { proprieta: { id } } });
    fatto.immobili += 1;
  }
  /* I proprietari per ultimi, e verificati sullo stato REALE di adesso.
   *
   * L'anteprima sconta gli immobili che si potrebbero rimuovere, perché
   * altrimenti un proprietario non comparirebbe mai nell'elenco. Ma qui
   * conta solo cosa è rimasto davvero: se l'immobile che lo nomina non è
   * stato selezionato ed è ancora in piedi, togliere il proprietario
   * lascerebbe quell'immobile a puntare a un id che non esiste. */
  const statoOra = (await col.findOne({ _id: DOC_STATO })) || {};
  const idCandidati = new Set(
    [...piano.proprietariOrfani, ...piano.proprietariInutilizzati].map((v) => v.id)
  );
  for (const id of (scelte.proprietari || [])) {
    const usi = idCandidati.has(id)
      ? usatoAltrove(statoOra, id, { escludi: ['contratti'] })
      : ['non in elenco'];
    if (usi.length) { fatto.rifiutati.push(id); continue; }
    await col.updateOne({ _id: DOC_STATO }, { $pull: { proprietari: { id } } });
    fatto.proprietari += 1;
  }

  return fatto;
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
    // Sesso e data di nascita si ricavano dal codice fiscale: si segnalano
    // solo se manca anche quello, altrimenti sarebbe un allarme per un dato
    // che il write-back ha già scritto.
    const da = datiDaCodiceFiscale(m.cf);
    chiedi(m.nome, 'nome');
    chiedi(m.cognome, 'cognome');
    chiedi(m.cf, 'codice fiscale');
    chiedi(m.sesso || da.sesso, 'sesso');
    chiedi(m.dataNascita || da.dataNascita, 'data di nascita');
    chiedi(m.comuneNascita, 'comune di nascita');
    chiedi(m.provNascita, 'provincia di nascita');
  }

  // Comproprietari: gli stessi dati servono alla loro CU e alla DAC7.
  (caso.comproprietari || []).forEach((c, k) => {
    if (!c || (!c.nome && !c.cognome)) return;
    const chi = [c.nome, c.cognome].filter(Boolean).join(' ') || `comproprietario ${k + 1}`;
    const da = datiDaCodiceFiscale(c.cf);
    const suo = (valore, etichetta) => { if (vuoto(valore)) mancanti.push(`${etichetta} di ${chi}`); };
    suo(c.cf, 'codice fiscale');
    suo(c.sesso || da.sesso, 'sesso');
    suo(c.dataNascita || da.dataNascita, 'data di nascita');
    suo(c.comuneNascita, 'comune di nascita');
    suo(c.via, 'indirizzo');
    suo(c.cap, 'CAP');
    suo(c.comune, 'comune');
    suo(c.provincia, 'provincia');
    suo(c.iban, 'IBAN');
  });
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
  anteprimaEliminazione,
  eliminaScritture,
  anteprimaPulizia,
  applicaPulizia,
  datiDaCodiceFiscale,
  nomeProprieta,
  rigaContratto,
  campiFiscaliMancanti,
  campiProprietario,
  campiProprieta,
  campiCoproprietario,
};
