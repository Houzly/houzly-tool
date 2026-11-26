/**
 * Contratti — router Express.
 *
 * Due router separati, montati diversamente in server.js:
 *   createContractsAdminRouter   → /api/contracts, dietro requireAdminAuth
 *   createContractsPublicRouter  → /api/sign, senza auth (protetto dal token)
 *
 * Le dipendenze arrivano dall'esterno (stesso schema di createOnboardingRouter)
 * per non duplicare client R2, Resend e validatori già istanziati in server.js.
 */

const express = require('express');
const { getTemplate, VERSIONE_ATTIVA } = require('../templates');
const { risolviTemplate, generaPdf, nomeMandante } = require('./pdf-generator');
const store = require('./contracts-store');
const {
  applicaWriteBack, campiFiscaliMancanti, anteprimaEliminazione, eliminaScritture,
  anteprimaPulizia, applicaPulizia,
} = require('./contracts-writeback');

/** Sede di Houzly: luogo di conclusione di ogni contratto. */
const LUOGO_FIRMA_STANDARD = 'Terranuova Bracciolini';

/** Giorni di validità del link di firma. */
const GIORNI_VALIDITA = 30;

/** Tetto per singolo allegato (byte decodificati). */
const MAX_ALLEGATO_BYTE = 8 * 1024 * 1024;

// 'documento' resta ammesso per le pratiche aperte prima della v1.8, che
// avevano un unico caricamento invece di fronte e retro.
const TIPI_ALLEGATO = [
  'visura', 'planimetria', 'conformita',
  'documento', 'documento_fronte', 'documento_retro', 'altro',
];

/**
 * Allegati senza i quali non si firma.
 * documento fronte/retro → identifica il firmatario, con scadenza e rilascio
 *                          leggibili sul retro
 * visura                 → verifica titolarità e dati catastali dichiarati
 */
const ALLEGATI_OBBLIGATORI = ['documento_fronte', 'documento_retro', 'visura'];

/* ── Documenti d'identità: uno per ogni titolare ───────────────────────
 *
 * Non basta il documento di chi firma. Chi firma dichiara di agire anche
 * in nome degli altri comproprietari (premessa a-bis), e quella
 * dichiarazione va verificata: senza il documento di ciascuno non si sa
 * se le persone indicate in visura sono davvero quelle dichiarate, né si
 * possono controllare i codici fiscali che finiscono in CU e DAC7.
 *
 * Il soggetto è `mandante` oppure `cp<indice>` (cp0, cp1, …) secondo la
 * posizione nell'array `comproprietari`. Un allegato senza `soggetto` è
 * del mandante: è così che restano validi gli allegati delle pratiche
 * caricate prima di questa modifica.
 */
const SOGGETTO_MANDANTE = 'mandante';

function etichettaSoggetto(soggetto, caso) {
  if (soggetto === SOGGETTO_MANDANTE) {
    const m = caso.mandante || {};
    const nome = m.tipoSoggetto === 'azienda'
      ? [m.legaleRapp, m.ragioneSociale && `(${m.ragioneSociale})`].filter(Boolean).join(' ')
      : [m.nome, m.cognome].filter(Boolean).join(' ');
    return nome || 'Firmatario';
  }
  const i = Number(String(soggetto).slice(2));
  const c = (caso.comproprietari || [])[i] || {};
  return [c.nome, c.cognome].filter(Boolean).join(' ') || `Comproprietario ${i + 1}`;
}

/** Elenco dei documenti d'identità attesi, uno per titolare. */
function documentiRichiesti(caso) {
  const elenco = [{
    soggetto: SOGGETTO_MANDANTE,
    etichetta: etichettaSoggetto(SOGGETTO_MANDANTE, caso),
    tipi: ['documento_fronte', 'documento_retro'],
  }];
  (caso.comproprietari || []).forEach((c, i) => {
    // Una riga appena aggiunta e ancora vuota non richiede niente: il
    // documento si chiede quando c'è una persona a cui attribuirlo.
    if (!c || (!c.nome && !c.cognome)) return;
    const soggetto = `cp${i}`;
    elenco.push({
      soggetto,
      etichetta: etichettaSoggetto(soggetto, caso),
      tipi: ['documento_fronte', 'documento_retro'],
    });
  });
  return elenco;
}

/** Soggetto di un allegato, con il ripiego per le pratiche di prima. */
function soggettoAllegato(a) {
  return a && a.soggetto ? a.soggetto : SOGGETTO_MANDANTE;
}

const chiave = (v) => String(v || '').replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * Il documento caricato è davvero di chi occupa oggi quella posizione?
 *
 * `cp0`, `cp1` … sono posizioni nell'elenco, e l'elenco si può riordinare:
 * se il proprietario rimuove il primo comproprietario, il secondo scala al
 * suo posto e si ritroverebbe il documento di un altro. Al caricamento si
 * registra quindi anche a chi apparteneva — codice fiscale se c'è, altrimenti
 * nome e cognome — e qui si verifica che corrisponda ancora. Se non
 * corrisponde il documento non vale e va chiesto di nuovo: meglio una
 * richiesta in più che un'identità sbagliata agli atti.
 */
function combaciaSoggetto(allegato, persona) {
  if (!allegato.soggettoCf && !allegato.soggettoNome) return true; // caricato prima di questo controllo
  if (allegato.soggettoCf && chiave(persona.cf)) {
    return chiave(allegato.soggettoCf) === chiave(persona.cf);
  }
  if (allegato.soggettoNome) {
    return chiave(allegato.soggettoNome) === chiave(`${persona.nome || ''} ${persona.cognome || ''}`);
  }
  return true;
}

/** La persona che occupa una posizione: `mandante` oppure `cp<indice>`. */
function personaDelSoggetto(soggetto, caso) {
  if (soggetto === SOGGETTO_MANDANTE) return caso.mandante || {};
  return (caso.comproprietari || [])[Number(String(soggetto).slice(2))] || {};
}

/**
 * Allegati che mancano per poter firmare: i documenti di ciascun titolare
 * più la visura, che è una sola per immobile e non appartiene a nessuno.
 */
function allegatiMancanti(caso) {
  const allegati = caso.allegati || [];
  // 'documento' singolo delle pratiche pre-v1.8 vale come fronte e retro.
  const vecchioUnico = allegati.some(
    (a) => a.tipo === 'documento' && soggettoAllegato(a) === SOGGETTO_MANDANTE
  );
  const mancanti = [];

  for (const d of documentiRichiesti(caso)) {
    const persona = personaDelSoggetto(d.soggetto, caso);
    for (const tipo of d.tipi) {
      const trovato = allegati.some(
        (a) => a.tipo === tipo && soggettoAllegato(a) === d.soggetto && combaciaSoggetto(a, persona)
      );
      if (trovato) continue;
      if (vecchioUnico && d.soggetto === SOGGETTO_MANDANTE) continue;
      mancanti.push({ soggetto: d.soggetto, etichetta: d.etichetta, tipo });
    }
  }
  if (!(caso.allegati || []).some((a) => a.tipo === 'visura')) {
    mancanti.push({ soggetto: null, etichetta: 'Immobile', tipo: 'visura' });
  }
  return mancanti;
}

/**
 * Campi anagrafici, separati e non accorpati.
 * È l'anagrafica che li vuole così — DAC7, CU e il 770 leggono `nome` e
 * `cognome` distinti, `via`/`cap`/`comune`/`provincia` distinti — e spezzare
 * a posteriori una stringa unica funziona quasi sempre, che in un file
 * destinato all'Agenzia delle Entrate non basta.
 */
const CAMPI_COMPROPRIETARIO = [
  'nome', 'cognome', 'sesso', 'dataNascita', 'comuneNascita', 'provNascita',
  'cf', 'via', 'cap', 'comune', 'provincia', 'email', 'iban', 'quota',
];

const CAMPI_MANDANTE = [
  // persona fisica
  'nome', 'cognome', 'sesso', 'dataNascita', 'comuneNascita', 'provNascita', 'cf',
  // azienda
  'ragioneSociale', 'piva', 'legaleRapp', 'sdi',
  // comuni
  'via', 'cap', 'comune', 'provincia', 'email', 'pec', 'telefono', 'iban', 'quota',
  // deciso da Houzly alla creazione, non dal proprietario
  'tipoSoggetto',
];

const CAMPI_IMMOBILE = [
  'nome', 'tipoVia', 'viaNome', 'civico', 'scala', 'interno', 'piano',
  'cap', 'comune', 'provincia',
  'catComune', 'catFoglio', 'catPart', 'catSub', 'catCat', 'cin',
];

/** Condizioni economiche e clausole variabili: le fissa Houzly alla creazione. */
const CAMPI_CONDIZIONI = [
  'commissione', 'compensoPerc', 'regimeIva', 'regimeIvaCodice', 'ritenuta',
  'durata', 'durataAnni', 'preavvisoRecesso', 'sogliaSpesa', 'pattuizioni',
  'verde', 'piscina',
];

/** Il tipo soggetto arriva dal backoffice: il proprietario non lo cambia. */
const CAMPI_MANDANTE_CLIENTE = CAMPI_MANDANTE.filter((c) => c !== 'tipoSoggetto');

const PAROLE_PERC = {
  10: 'dieci', 12: 'dodici', 15: 'quindici', 16: 'sedici', 18: 'diciotto', 20: 'venti',
  22: 'ventidue', 24: 'ventiquattro', 25: 'venticinque', 26: 'ventisei', 28: 'ventotto',
  30: 'trenta', 32: 'trentadue', 33: 'trentatré', 35: 'trentacinque', 38: 'trentotto',
  40: 'quaranta',
};
const PAROLE_ANNI = { 1: 'uno', 2: 'due', 3: 'tre', 4: 'quattro', 5: 'cinque' };

/**
 * Dalle scelte numeriche del backoffice ricava le formule che il contratto
 * stampa. La percentuale resta anche come numero, perché è quella che il
 * write-back porta in `houzly_perc`.
 */
function normalizzaCondizioni(c = {}, template) {
  const d = template.defaults;
  const perc = c.compensoPerc != null && c.compensoPerc !== '' ? +c.compensoPerc : null;
  const anni = c.durataAnni != null && c.durataAnni !== '' ? +c.durataAnni : 1;
  const ivaEsclusa = c.regimeIvaCodice === 'esclusa';
  const mesi = c.preavvisoRecesso != null && c.preavvisoRecesso !== ''
    ? +c.preavvisoRecesso : 6;
  const soglia = c.sogliaSpesa != null && c.sogliaSpesa !== '' ? +c.sogliaSpesa : 50;

  const inLettere = (n, tabella) => (tabella[n] ? ` (${tabella[n]})` : '');

  return {
    compensoPerc: perc,
    commissione: perc != null
      ? `${perc}%${PAROLE_PERC[perc] ? ` (${PAROLE_PERC[perc]} per cento)` : ''}`
      : (c.commissione || d.commissione),
    regimeIvaCodice: ivaEsclusa ? 'esclusa' : 'inclusa',
    regimeIva: ivaEsclusa ? 'oltre IVA di legge (22%)' : 'IVA inclusa',
    ritenuta: c.ritenuta !== undefined ? !!c.ritenuta : true,
    durataAnni: anni,
    durata: anni === 1 ? '1 (uno) anno' : `${anni}${inLettere(anni, PAROLE_ANNI)} anni`,
    preavvisoRecesso: `${mesi}${inLettere(mesi, { 1:'uno',2:'due',3:'tre',4:'quattro',5:'cinque',6:'sei',9:'nove',12:'dodici' })} mesi`,
    sogliaSpesa: `€ ${soglia.toFixed(2).replace('.', ',')}`,
    pattuizioni: String(c.pattuizioni || '').trim().slice(0, 4000),
    verde: !!c.verde,
    piscina: !!c.piscina,
  };
}

/** Copia solo i campi previsti: il client non decide cosa finisce in DB. */
function filtra(oggetto, campiAmmessi) {
  const out = {};
  if (!oggetto || typeof oggetto !== 'object') return out;
  for (const k of campiAmmessi) {
    if (oggetto[k] !== undefined) out[k] = typeof oggetto[k] === 'string' ? oggetto[k].trim() : oggetto[k];
  }
  return out;
}

/** Vista pubblica della pratica: mai token, hash o dati interni. */
function vistaPubblica(caso) {
  return {
    riferimento: caso.riferimento,
    stato: caso.stato,
    nomeStruttura: caso.nomeStruttura || null,
    mandante: caso.mandante || {},
    immobile: caso.immobile || {},
    comproprietari: caso.comproprietari || [],
    pagamento: caso.pagamento || { modalita: 'unico' },
    allegatiObbligatori: ALLEGATI_OBBLIGATORI,
    documentiRichiesti: documentiRichiesti(caso),
    allegatiMancanti: allegatiMancanti(caso),
    allegati: (caso.allegati || []).map((a) => ({
      tipo: a.tipo,
      soggetto: soggettoAllegato(a),
      // `valido: false` = caricato per una posizione che ora è di un'altra
      // persona. Il modulo lo mostra come da rifare, non come fatto.
      valido: combaciaSoggetto(a, personaDelSoggetto(soggettoAllegato(a), caso)),
      nomeFile: a.nomeFile,
      uploadedAt: a.uploadedAt,
    })),
    clausole1341: caso.clausole1341 || {},
    clausoleRichieste: elencoClausole(caso),
    // Al proprietario si mostra solo ciò che lo riguarda: non il regime IVA
    // né il flag ritenuta, che sono scelte fiscali già risolte nel testo.
    condizioni: {
      commissione: caso.condizioni?.commissione,
      durata: caso.condizioni?.durata,
      verde: !!caso.condizioni?.verde,
      piscina: !!caso.condizioni?.piscina,
    },
    tipoSoggetto: caso.mandante?.tipoSoggetto || 'persona_fisica',
    firmato: caso.stato === 'firmata',
    scadenzaAt: caso.scadenzaAt,
  };
}

function elencoClausole(caso) {
  const t = getTemplate(caso.templateVersione || VERSIONE_ATTIVA);
  return t.clausoleVessatorie.elenco
    .filter((c) => c.key !== 'art11bis' || caso.condizioni?.verde || caso.condizioni?.piscina)
    .map((c) => ({ key: c.key, label: c.label }));
}

/* ══════════════════════════════════════════════════════════════════ *
 * ROUTER ADMIN — /api/contracts
 * ══════════════════════════════════════════════════════════════════ */

function createContractsAdminRouter(deps) {
  const { getDb, resend, r2GetSignedUrl, r2Delete, APP_BASE_URL } = deps;
  const router = express.Router();

  // POST /api/contracts — crea la pratica e invia l'invito
  router.post('/', async (req, res) => {
    try {
      const {
        email, nomeStruttura, ownerId, propertyId,
        condizioni, mandante, immobile, comproprietari, inviaSubito,
      } = req.body || {};
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ ok: false, error: 'email_non_valida' });
      }

      const template = getTemplate(VERSIONE_ATTIVA);
      const { token, tokenHash } = store.generaToken();
      const riferimento = await store.prossimoRiferimento(getDb);

      const caso = {
        riferimento,
        stato: 'bozza',
        email: String(email).trim().toLowerCase(),
        nomeStruttura: nomeStruttura || null,
        // Legame con l'anagrafica: è su questi id che scriverà il write-back
        // alla firma. Vuoti per un cliente nuovo: i record si creano allora.
        ownerId: ownerId || null,
        propertyId: propertyId || null,
        templateVersione: VERSIONE_ATTIVA,
        tokenHash,
        scadenzaAt: new Date(Date.now() + GIORNI_VALIDITA * 86400000).toISOString(),
        condizioni: normalizzaCondizioni(condizioni, template),
        mandante: filtra(mandante, CAMPI_MANDANTE),
        immobile: filtra(immobile, CAMPI_IMMOBILE),
        comproprietari: Array.isArray(comproprietari)
          ? comproprietari.slice(0, 9).map((c) => filtra(c, CAMPI_COMPROPRIETARIO))
          : [],
        pagamento: { modalita: 'unico' },
        allegati: [],
        clausole1341: {},
        firme: {},
        pdfFinale: null,
        templateSnapshot: null,
        audit: [store.eventoAudit('Pratica creata dal backoffice', null)],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const col = await store.cases(getDb);
      await col.insertOne(caso);

      const link = `${APP_BASE_URL}/firma.html?t=${token}`;
      let inviata = false;

      if (inviaSubito !== false) {
        const esito = await inviaInvito({ resend, email: caso.email, link, caso, baseUrl: APP_BASE_URL });
        if (esito.success) {
          inviata = true;
          await col.updateOne(
            { riferimento },
            {
              $set: { stato: 'inviata', updatedAt: new Date().toISOString() },
              $push: { audit: store.eventoAudit(`Invito inviato a ${caso.email}`, null) },
            }
          );
        } else {
          await store.pushAudit(getDb, { riferimento },
            store.eventoAudit(`Invio invito FALLITO: ${esito.error}`, null));
        }
      }

      // Il token in chiaro esce da qui una volta sola: non è più recuperabile
      // dal database. Se l'email non parte, si usa questo link o si rigenera.
      res.json({ ok: true, riferimento, link, emailInviata: inviata, stato: inviata ? 'inviata' : 'bozza' });
    } catch (e) {
      console.error('[contracts/create]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/contracts/anagrafiche — elenco ridotto per le tendine
  //
  // Non si usa /api/db: quello restituisce l'intero documento di stato, che
  // pesa, e qui servono solo nome e id. Su Render la banda è una risorsa
  // contata, quindi passa solo ciò che serve a riempire due select.
  router.get('/anagrafiche', async (req, res) => {
    try {
      const db = await getDb();
      const stato = await db.collection('db').findOne(
        { _id: 'main' },
        { projection: { proprietari: 1, proprieta: 1 } }
      );
      if (!stato) return res.json({ ok: true, proprietari: [], proprieta: [] });

      const proprietari = (stato.proprietari || []).map((o) => ({
        id: o.id,
        tipo: o.tipo || 'persona_fisica',
        etichetta: o.tipo === 'azienda'
          ? (o.ragione_sociale || '(senza ragione sociale)')
          : [o.cognome, o.nome].filter(Boolean).join(' ') || '(senza nome)',
        email: o.email || '',
        houzlyPerc: o.houzly_perc != null ? o.houzly_perc : null,
        ivaEsclusa: !!o.fisc_iva22,
        ritenuta: o.fisc_cedolare !== false,
      })).sort((a, b) => a.etichetta.localeCompare(b.etichetta, 'it'));

      const proprieta = (stato.proprieta || []).map((p) => ({
        id: p.id,
        nome: p.nome || '(senza nome)',
        ownerId: p.proprietario_id || null,
        indirizzo: p.indirizzo || '',
      })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));

      res.json({ ok: true, proprietari, proprieta });
    } catch (e) {
      console.error('[contracts/anagrafiche]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/contracts — elenco
  router.get('/', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const filtro = {};
      if (req.query.stato) filtro.stato = req.query.stato;
      const lista = await col
        .find(filtro, {
          projection: { tokenHash: 0, templateSnapshot: 0, 'firme.contratto.dataUrl': 0, 'firme.clausole.dataUrl': 0 },
        })
        .sort({ createdAt: -1 })
        .limit(Math.min(parseInt(req.query.limit || '100', 10), 500))
        .toArray();
      res.json({ ok: true, pratiche: lista });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/contracts/:riferimento — dettaglio
  /* — pulizia dei residui —
   *
   * Registrate prima di /:riferimento: Express prende la prima rotta che
   * combacia, e 'pulizia' su un solo segmento verrebbe scambiato per il
   * riferimento di una pratica. */

  /** Riferimenti delle pratiche che esistono ancora: tutto ciò che in
   *  anagrafica ne cita uno diverso è un residuo. */
  async function riferimentiVivi() {
    const col = await store.cases(getDb);
    const righe = await col.find({}, { projection: { riferimento: 1 } }).toArray();
    return righe.map((r) => r.riferimento).filter(Boolean);
  }

  // GET /api/contracts/pulizia — cosa è rimasto appeso a pratiche sparite
  router.get('/pulizia', async (req, res) => {
    try {
      res.json({ ok: true, anteprima: await anteprimaPulizia(getDb, await riferimentiVivi()) });
    } catch (e) {
      console.error('[contracts/pulizia]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/contracts/pulizia — rimuove i residui scelti
  router.post('/pulizia', async (req, res) => {
    try {
      const b = req.body || {};
      if (b.conferma !== 'PULISCI') {
        return res.status(400).json({ ok: false, error: 'conferma_mancante' });
      }
      const fatto = await applicaPulizia(getDb, await riferimentiVivi(), {
        contratti: Array.isArray(b.contratti) ? b.contratti : [],
        immobili: Array.isArray(b.immobili) ? b.immobili : [],
        proprietari: Array.isArray(b.proprietari) ? b.proprietari : [],
      });
      console.log('[contracts/pulizia] ' + JSON.stringify(fatto));
      res.json({ ok: true, ...fatto });
    } catch (e) {
      console.error('[contracts/pulizia]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/:riferimento', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const caso = await col.findOne(
        { riferimento: req.params.riferimento },
        { projection: { tokenHash: 0 } }
      );
      if (!caso) return res.status(404).json({ ok: false, error: 'pratica_non_trovata' });
      res.json({ ok: true, pratica: caso });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/contracts/:riferimento/allegati — elenco dei documenti raccolti
  //
  // Senza questa rotta i documenti d'identità sarebbero raggiungibili solo
  // dall'email interna: se quella si perde, l'unica copia resta su R2 senza
  // un modo per aprirla.
  router.get('/:riferimento/allegati', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const caso = await col.findOne({ riferimento: req.params.riferimento });
      if (!caso) return res.status(404).json({ ok: false, error: 'pratica_non_trovata' });

      const allegati = (caso.allegati || []).map((a, i) => ({
        indice: i,
        tipo: a.tipo,
        nome: NOME_TIPO[a.tipo] || a.tipo,
        soggetto: soggettoAllegato(a),
        chi: a.soggettoNome || null,
        valido: combaciaSoggetto(a, personaDelSoggetto(soggettoAllegato(a), caso)),
        kb: Math.round((a.bytes || 0) / 1024),
        caricatoIl: a.uploadedAt,
      }));
      res.json({ ok: true, riferimento: caso.riferimento, allegati });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/contracts/:riferimento/allegato/:indice — apre il documento
  router.get('/:riferimento/allegato/:indice', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const caso = await col.findOne({ riferimento: req.params.riferimento });
      if (!caso) return res.status(404).json({ ok: false, error: 'pratica_non_trovata' });

      const a = (caso.allegati || [])[Number(req.params.indice)];
      if (!a || !a.r2Key) return res.status(404).json({ ok: false, error: 'allegato_non_trovato' });

      const url = await r2GetSignedUrl(a.r2Key, 300);
      res.redirect(url);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/contracts/:riferimento/eliminazione — cosa verrebbe cancellato
  //
  // Si mostra prima di chiedere conferma: "elimina il contratto" non dice se
  // sparisce anche il proprietario, e una prova fatta su un proprietario
  // vero non deve portarselo via.
  router.get('/:riferimento/eliminazione', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const caso = await col.findOne({ riferimento: req.params.riferimento });
      if (!caso) return res.status(404).json({ ok: false, error: 'pratica_non_trovata' });
      res.json({ ok: true, anteprima: await anteprimaEliminazione(getDb, caso) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // DELETE /api/contracts/:riferimento — elimina pratica, file e scritture
  //
  // Nasce per ripulire le prove, ma vale per qualsiasi pratica, quindi la
  // conferma non è un sì: va rimandato indietro il riferimento esatto. Una
  // pratica firmata è un documento sottoscritto, e questa è l'unica cosa che
  // impedisce di cancellarla con un clic di troppo.
  router.delete('/:riferimento', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const caso = await col.findOne({ riferimento: req.params.riferimento });
      if (!caso) return res.status(404).json({ ok: false, error: 'pratica_non_trovata' });

      if ((req.body || {}).conferma !== caso.riferimento) {
        return res.status(400).json({ ok: false, error: 'conferma_mancante' });
      }

      const scritture = await eliminaScritture(getDb, caso);

      // File su R2. Un fallimento qui non ferma l'eliminazione: resterebbe
      // una pratica a metà, peggio di un file orfano nel bucket.
      const chiavi = [
        ...(caso.allegati || []).map((a) => a.r2Key),
        caso.pdfFinale?.r2Key,
      ].filter(Boolean);
      let fileRimossi = 0;
      if (typeof r2Delete === 'function') {
        for (const k of chiavi) {
          try { await r2Delete(k); fileRimossi += 1; } catch (e) {
            console.error('[contracts/elimina] file non rimosso:', k, e.message);
          }
        }
      }

      await col.deleteOne({ _id: caso._id });

      console.log(`[contracts/elimina] ${caso.riferimento} eliminata — ` +
        `${fileRimossi}/${chiavi.length} file, scritture: ${JSON.stringify(scritture)}`);

      res.json({
        ok: true,
        riferimento: caso.riferimento,
        fileRimossi,
        fileTotali: chiavi.length,
        ...scritture,
      });
    } catch (e) {
      console.error('[contracts/elimina]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/contracts/:riferimento/write-back — riallinea le anagrafiche
  //
  // Il write-back gira alla firma, una volta sola. Serve poterlo rilanciare
  // perché può essere fallito (Mongo non raggiungibile in quel momento) o
  // essere girato quando ancora scriveva i comproprietari nel posto
  // sbagliato. Rifare il contratto per rimediare non avrebbe senso: la firma
  // è valida, è l'anagrafica che è rimasta indietro.
  //
  // Si può ripetere senza danni: il proprietario si riconosce dal codice
  // fiscale, l'immobile dal CIN e la riga di contratto dal riferimento della
  // pratica, quindi la seconda esecuzione aggiorna invece di duplicare.
  // Niente viene cancellato: si scrivono solo i campi che hanno un valore.
  router.post('/:riferimento/write-back', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const caso = await col.findOne({ riferimento: req.params.riferimento });
      if (!caso) return res.status(404).json({ ok: false, error: 'pratica_non_trovata' });
      // Solo da una pratica firmata: i dati si alimentano quando il contratto
      // è ufficiale, mai prima.
      if (caso.stato !== 'firmata') {
        return res.status(409).json({ ok: false, error: 'pratica_non_firmata', stato: caso.stato });
      }

      const esito = await applicaWriteBack(getDb, caso);
      const mancanti = campiFiscaliMancanti(caso);

      await col.updateOne(
        { riferimento: caso.riferimento },
        {
          $set: { writeBack: { ...esito, eseguitoIl: new Date().toISOString(), rilanciato: true } },
          $push: {
            audit: store.eventoAudit(
              `Anagrafiche riallineate a mano: ${esito.ownerCreato ? 'proprietario creato' : 'proprietario aggiornato'}, ` +
              `${esito.propCreata ? 'immobile creato' : 'immobile aggiornato'}, ${esito.coprops} comproprietari`,
              req
            ),
          },
        }
      );

      console.log(`[contracts/write-back] ${caso.riferimento} → owner ${esito.ownerId}, prop ${esito.propertyId}`);
      res.json({ ok: true, esito, campiFiscaliMancanti: mancanti });
    } catch (e) {
      console.error('[contracts/write-back]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/contracts/:riferimento/rigenera-link — nuovo token, nuovo invito
  router.post('/:riferimento/rigenera-link', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const caso = await col.findOne({ riferimento: req.params.riferimento });
      if (!caso) return res.status(404).json({ ok: false, error: 'pratica_non_trovata' });
      if (caso.stato === 'firmata') return res.status(409).json({ ok: false, error: 'gia_firmata' });
      if (caso.stato === 'annullata') return res.status(409).json({ ok: false, error: 'pratica_annullata' });

      const { token, tokenHash } = store.generaToken();
      const link = `${APP_BASE_URL}/firma.html?t=${token}`;
      await col.updateOne(
        { riferimento: caso.riferimento },
        {
          $set: {
            tokenHash,
            scadenzaAt: new Date(Date.now() + GIORNI_VALIDITA * 86400000).toISOString(),
            stato: caso.stato === 'bozza' ? 'bozza' : 'inviata',
            updatedAt: new Date().toISOString(),
          },
          $push: { audit: store.eventoAudit('Link rigenerato (token precedente invalidato)', null) },
        }
      );

      const esito = await inviaInvito({ resend, email: caso.email, link, caso, baseUrl: APP_BASE_URL });
      res.json({ ok: true, link, emailInviata: esito.success, erroreEmail: esito.error || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/contracts/:riferimento/annulla
  router.post('/:riferimento/annulla', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const caso = await col.findOne({ riferimento: req.params.riferimento });
      if (!caso) return res.status(404).json({ ok: false, error: 'pratica_non_trovata' });
      if (!store.puoTransire(caso.stato, 'annullata')) {
        return res.status(409).json({ ok: false, error: `non_annullabile_da_stato_${caso.stato}` });
      }
      await col.updateOne(
        { riferimento: caso.riferimento },
        {
          $unset: { tokenHash: '' },
          $set: { stato: 'annullata', updatedAt: new Date().toISOString() },
          $push: { audit: store.eventoAudit(`Pratica annullata${req.body?.motivo ? ': ' + req.body.motivo : ''}`, null) },
        }
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/contracts/:riferimento/pdf — scarica il contratto firmato
  router.get('/:riferimento/pdf', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const caso = await col.findOne({ riferimento: req.params.riferimento });
      if (!caso) return res.status(404).json({ ok: false, error: 'pratica_non_trovata' });
      if (!caso.pdfFinale?.r2Key) return res.status(404).json({ ok: false, error: 'pdf_non_disponibile' });
      const url = await r2GetSignedUrl(caso.pdfFinale.r2Key, 300);
      res.redirect(url);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/contracts/:riferimento/anteprima — contratto allo stato attuale
  //
  // Serve a vedere dal backoffice cosa ha compilato il proprietario prima che
  // firmi: il token del link non è recuperabile dal database, quindi senza
  // questa route l'unico modo sarebbe chiedere il PDF a lui.
  //
  // Per una pratica già firmata rigenera dallo snapshot salvato, non dal
  // template corrente: il documento deve restare quello che è stato firmato
  // anche dopo un aggiornamento del contratto-tipo. Resta comunque una copia
  // di cortesia — l'originale con valore è il PDF archiviato su R2, servito
  // dalla route /pdf qui sopra.
  router.get('/:riferimento/anteprima', async (req, res) => {
    try {
      const col = await store.cases(getDb);
      const caso = await col.findOne({ riferimento: req.params.riferimento });
      if (!caso) return res.status(404).json({ ok: false, error: 'pratica_non_trovata' });

      const firmata = caso.stato === 'firmata';
      const snapshot = firmata && caso.templateSnapshot
        ? caso.templateSnapshot
        : risolviTemplate(getTemplate(caso.templateVersione || VERSIONE_ATTIVA), caso);

      const { buffer } = await generaPdf(snapshot, caso, { bozza: !firmata });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${caso.riferimento}${firmata ? '' : '-bozza'}.pdf"`
      );
      res.send(buffer);
    } catch (e) {
      console.error('[contracts/anteprima]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

/* ══════════════════════════════════════════════════════════════════ *
 * ROUTER PUBBLICO — /api/sign
 * ══════════════════════════════════════════════════════════════════ */

function createContractsPublicRouter(deps) {
  const { getDb, r2Upload, resend, validateTaxCode, r2GetSignedUrl } = deps;
  const router = express.Router();

  /** Carica la pratica dal token e blocca scadute, annullate, inesistenti. */
  async function caricaCaso(req, res, next) {
    try {
      const token = req.params.token;
      if (!token || token.length < 20) return res.status(404).json({ ok: false, error: 'link_non_valido' });
      const caso = await store.trovaPerToken(getDb, token);
      if (!caso) return res.status(404).json({ ok: false, error: 'link_non_valido' });
      if (caso.stato === 'annullata') return res.status(410).json({ ok: false, error: 'pratica_annullata' });
      if (store.scaduta(caso)) return res.status(410).json({ ok: false, error: 'link_scaduto' });
      req.caso = caso;
      next();
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }

  // GET /api/sign/:token — stato e dati già salvati
  router.get('/:token', caricaCaso, async (req, res) => {
    const caso = req.caso;
    if (caso.stato === 'inviata') {
      const col = await store.cases(getDb);
      await col.updateOne(
        { _id: caso._id },
        {
          $set: { stato: 'in_compilazione', updatedAt: new Date().toISOString() },
          $push: { audit: store.eventoAudit('Link aperto dal destinatario', req) },
        }
      );
      caso.stato = 'in_compilazione';
    } else {
      await store.pushAudit(getDb, { _id: caso._id }, store.eventoAudit('Pagina riaperta', req));
    }
    res.json({ ok: true, pratica: vistaPubblica(caso) });
  });

  // PATCH /api/sign/:token — salvataggio progressivo
  router.patch('/:token', caricaCaso, async (req, res) => {
    try {
      const caso = req.caso;
      if (caso.stato === 'firmata') return res.status(409).json({ ok: false, error: 'gia_firmata' });

      const set = { updatedAt: new Date().toISOString() };
      const mandante = filtra(req.body?.mandante, CAMPI_MANDANTE_CLIENTE);
      const immobile = filtra(req.body?.immobile, CAMPI_IMMOBILE);
      for (const [k, v] of Object.entries(mandante)) set[`mandante.${k}`] = v;
      for (const [k, v] of Object.entries(immobile)) set[`immobile.${k}`] = v;

      // I comproprietari si salvano in blocco: sono un elenco, non campi sparsi.
      if (Array.isArray(req.body?.comproprietari)) {
        set.comproprietari = req.body.comproprietari
          .slice(0, 9)
          .map((c) => filtra(c, CAMPI_COMPROPRIETARIO))
          .filter((c) => c.nome || c.cognome || c.cf);
      }
      if (req.body?.pagamento?.modalita === 'unico' || req.body?.pagamento?.modalita === 'suddiviso') {
        set['pagamento.modalita'] = req.body.pagamento.modalita;
      }

      if (req.body?.clausole1341 && typeof req.body.clausole1341 === 'object') {
        for (const c of elencoClausole(caso)) {
          if (req.body.clausole1341[c.key] !== undefined) {
            set[`clausole1341.${c.key}`] = req.body.clausole1341[c.key] === true;
          }
        }
      }

      const col = await store.cases(getDb);
      await col.updateOne({ _id: caso._id }, { $set: set });

      // Il codice fiscale si valida ma non si blocca: alcuni mandanti sono
      // società con sola P.IVA, e un falso negativo non deve fermare la firma.
      let cfValido = null;
      if (mandante.cfPiva && validateTaxCode) {
        cfValido = mandante.cfPiva.length === 16 ? validateTaxCode(mandante.cfPiva) : null;
      }

      res.json({ ok: true, salvato: Object.keys(set).length - 1, cfValido });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/sign/:token/allegato — upload documento (base64)
  router.post('/:token/allegato', caricaCaso, async (req, res) => {
    try {
      const caso = req.caso;
      if (caso.stato === 'firmata') return res.status(409).json({ ok: false, error: 'gia_firmata' });

      const { tipo, nomeFile, contentType, dataBase64 } = req.body || {};
      if (!TIPI_ALLEGATO.includes(tipo)) return res.status(400).json({ ok: false, error: 'tipo_non_valido' });
      if (!dataBase64) return res.status(400).json({ ok: false, error: 'file_mancante' });

      // Soggetto a cui appartiene il documento. Si accetta solo un indice che
      // corrisponde davvero a un comproprietario della pratica: altrimenti si
      // archivierebbero documenti intestati a nessuno.
      let soggetto = String((req.body || {}).soggetto || SOGGETTO_MANDANTE);
      if (soggetto !== SOGGETTO_MANDANTE) {
        const i = Number(soggetto.replace(/^cp/, ''));
        const n = (caso.comproprietari || []).length;
        if (!/^cp\d+$/.test(soggetto) || !Number.isInteger(i) || i < 0 || i >= n) {
          return res.status(400).json({ ok: false, error: 'soggetto_non_valido' });
        }
      }

      const buffer = Buffer.from(String(dataBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (!buffer.length) return res.status(400).json({ ok: false, error: 'file_illeggibile' });
      if (buffer.length > MAX_ALLEGATO_BYTE) {
        return res.status(413).json({ ok: false, error: 'file_troppo_grande', maxMB: MAX_ALLEGATO_BYTE / 1048576 });
      }

      const estensione = (nomeFile || '').split('.').pop()?.toLowerCase().slice(0, 5) || 'bin';
      const suffisso = soggetto === SOGGETTO_MANDANTE ? '' : `-${soggetto}`;
      const key = `contratti/${caso.riferimento}/${tipo}${suffisso}-${Date.now()}.${estensione}`;
      await r2Upload(key, buffer, contentType || 'application/octet-stream');

      const col = await store.cases(getDb);

      // Ricaricare lo stesso documento sostituisce il precedente. Senza questo
      // una foto venuta male resterebbe in archivio accanto a quella buona, e
      // mesi dopo non si saprebbe quale delle due vale.
      if (tipo !== 'altro') {
        await col.updateOne(
          { _id: caso._id },
          {
            $pull: {
              allegati: soggetto === SOGGETTO_MANDANTE
                ? { tipo, soggetto: { $in: [null, SOGGETTO_MANDANTE] } }
                : { tipo, soggetto },
            },
          }
        );
      }

      await col.updateOne(
        { _id: caso._id },
        {
          $push: {
            allegati: {
              tipo,
              soggetto,
              // A chi apparteneva al momento del caricamento: serve a
              // `combaciaSoggetto()` se poi l'elenco cambia ordine.
              soggettoCf: personaDelSoggetto(soggetto, caso).cf || null,
              soggettoNome: etichettaSoggetto(soggetto, caso),
              nomeFile: nomeFile || key.split('/').pop(),
              r2Key: key,
              bytes: buffer.length,
              uploadedAt: new Date().toISOString(),
            },
            audit: store.eventoAudit(
              `Allegato caricato: ${tipo} [${etichettaSoggetto(soggetto, caso)}] (${Math.round(buffer.length / 1024)} KB)`,
              req
            ),
          },
          $set: { updatedAt: new Date().toISOString() },
        }
      );

      res.json({ ok: true, tipo, soggetto, bytes: buffer.length });
    } catch (e) {
      console.error('[sign/allegato]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/sign/:token/anteprima — PDF con filigrana BOZZA
  router.get('/:token/anteprima', caricaCaso, async (req, res) => {
    try {
      const caso = req.caso;
      const template = getTemplate(caso.templateVersione || VERSIONE_ATTIVA);
      const snapshot = risolviTemplate(template, caso);
      const { buffer } = await generaPdf(snapshot, caso, { bozza: caso.stato !== 'firmata' });

      await store.pushAudit(getDb, { _id: caso._id }, store.eventoAudit('Anteprima contratto generata', req));

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="contratto-anteprima.pdf"');
      res.send(buffer);
    } catch (e) {
      console.error('[sign/anteprima]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/sign/:token/firma — atto finale, irreversibile
  router.post('/:token/firma', caricaCaso, async (req, res) => {
    try {
      const caso = req.caso;

      // Idempotenza: un doppio tap sul telefono non deve produrre due PDF
      // con hash diversi. Chi arriva secondo riceve l'esito del primo.
      if (caso.stato === 'firmata') {
        return res.status(409).json({
          ok: false, error: 'gia_firmata',
          firmataIl: caso.pdfFinale?.generatoIl, sha256: caso.pdfFinale?.sha256,
        });
      }
      if (!store.puoTransire(caso.stato, 'firmata')) {
        return res.status(409).json({ ok: false, error: `non_firmabile_da_stato_${caso.stato}` });
      }

      const { firmaContratto, firmaClausole, clausole1341, luogoFirma } = req.body || {};

      for (const [nome, f] of [['contratto', firmaContratto], ['clausole', firmaClausole]]) {
        if (!f || typeof f !== 'string' || !f.startsWith('data:image/png;base64,')) {
          return res.status(400).json({ ok: false, error: `firma_${nome}_mancante` });
        }
        if (f.length > 800000) return res.status(413).json({ ok: false, error: `firma_${nome}_troppo_grande` });
      }

      // Tutte le clausole vessatorie devono essere spuntate una per una.
      const richieste = elencoClausole(caso);
      const spunte = { ...(caso.clausole1341 || {}), ...(clausole1341 || {}) };
      const mancanti = richieste.filter((c) => spunte[c.key] !== true).map((c) => c.key);
      if (mancanti.length) {
        return res.status(400).json({ ok: false, error: 'clausole_non_approvate', mancanti });
      }

      // Minimo indispensabile perché il contratto identifichi le parti.
      // È volutamente più corto della lista fiscale: un contratto non può
      // essere invalidato da un campo che serve alla CU, non al consenso.
      const azienda = caso.mandante?.tipoSoggetto === 'azienda';
      const obbligatori = azienda
        ? ['ragioneSociale', 'legaleRapp', 'via', 'comune', 'iban']
        : ['nome', 'cognome', 'via', 'comune', 'cf', 'iban'];
      const mancantiAnagrafica = obbligatori.filter((k) => !caso.mandante?.[k]);
      if (mancantiAnagrafica.length) {
        return res.status(400).json({ ok: false, error: 'dati_mancanti', campi: mancantiAnagrafica });
      }

      // Documenti d'identità e visura sono condizione di firma (art. 5.1).
      // I documenti si contano per titolare, non per tipo: con tre
      // comproprietari servono sei facciate, non due.
      const mancantiAllegati = allegatiMancanti(caso);
      if (mancantiAllegati.length) {
        return res.status(400).json({
          ok: false,
          error: 'allegati_mancanti',
          mancanti: mancantiAllegati,
          tipi: [...new Set(mancantiAllegati.map((m) => m.tipo))],
        });
      }

      // Comproprietà: ogni titolare deve essere identificato e le quote devono
      // chiudere a 100, altrimenti l'art. 9 ripartirebbe su una base sbagliata.
      const comprop = caso.comproprietari || [];
      if (comprop.length) {
        const incompleti = comprop.filter((c) => !c.nome || !c.cognome || !c.cf || !c.quota);
        if (incompleti.length) {
          return res.status(400).json({ ok: false, error: 'comproprietari_incompleti' });
        }
        const suddiviso = caso.pagamento?.modalita === 'suddiviso';
        if (suddiviso && comprop.some((c) => !c.iban)) {
          return res.status(400).json({ ok: false, error: 'iban_comproprietari_mancanti' });
        }
        const somma = [caso.mandante, ...comprop]
          .reduce((t, p) => t + (parseFloat(String(p.quota || 0).replace(',', '.')) || 0), 0);
        if (Math.abs(somma - 100) > 0.5) {
          return res.status(400).json({ ok: false, error: 'quote_non_valide', somma });
        }
      }

      const ora = new Date().toISOString();
      const casoFirmato = {
        ...caso,
        clausole1341: spunte,
        // Il luogo è standardizzato sulla sede di Houzly: il contratto si
        // conclude lì, coerentemente col foro competente dell'art. 19.3.
        luogoFirma: luogoFirma || caso.luogoFirma || LUOGO_FIRMA_STANDARD,
        dataFirma: new Date().toLocaleDateString('it-IT'),
        firme: {
          contratto: { dataUrl: firmaContratto, ts: ora },
          clausole: { dataUrl: firmaClausole, ts: ora },
        },
        tokenHash: '(non riportato)',
        audit: [
          ...(caso.audit || []),
          store.eventoAudit('Clausole 1341-1342 approvate singolarmente', req),
          store.eventoAudit('Firma apposta e contratto perfezionato', req),
        ],
      };

      const template = getTemplate(caso.templateVersione || VERSIONE_ATTIVA);
      const snapshot = risolviTemplate(template, casoFirmato);
      const { buffer, sha256, bytes } = await generaPdf(snapshot, casoFirmato, { bozza: false });

      const key = `contratti/${caso.riferimento}/contratto-firmato.pdf`;
      await r2Upload(key, buffer, 'application/pdf');

      // Il passaggio a "firmata" è condizionato allo stato precedente: se due
      // richieste arrivano insieme, solo la prima trova il documento non firmato.
      const col = await store.cases(getDb);
      const esito = await col.updateOne(
        { _id: caso._id, stato: { $ne: 'firmata' } },
        {
          // $unset e non null: con null l'indice unique+sparse considererebbe
          // uguali fra loro tutte le pratiche chiuse e rifiuterebbe la seconda.
          $unset: { tokenHash: '' },       // il link non è più riutilizzabile
          $set: {
            stato: 'firmata',
            clausole1341: spunte,
            luogoFirma: casoFirmato.luogoFirma,
            dataFirma: casoFirmato.dataFirma,
            firme: casoFirmato.firme,
            templateSnapshot: snapshot,    // il testo esatto che è stato firmato
            pdfFinale: { r2Key: key, sha256, bytes, generatoIl: ora },
            updatedAt: ora,
          },
          $push: {
            audit: {
              $each: [
                store.eventoAudit('Clausole 1341-1342 approvate singolarmente', req),
                store.eventoAudit(`Firma apposta — SHA-256 ${sha256.slice(0, 16)}…`, req),
              ],
            },
          },
        }
      );

      if (esito.matchedCount === 0) {
        return res.status(409).json({ ok: false, error: 'gia_firmata' });
      }

      /* — write-back nelle anagrafiche —
       * Solo adesso: il contratto è firmato, quindi il dato è ufficiale.
       * Non è dentro il blocco try principale perché un errore qui non deve
       * annullare una firma già perfezionata e già archiviata su R2: si
       * registra nell'audit e si segnala al backoffice, non si butta via
       * il contratto. */
      let writeBack = null;
      try {
        writeBack = await applicaWriteBack(getDb, casoFirmato);
        const mancanti = campiFiscaliMancanti(casoFirmato);
        await col.updateOne(
          { _id: caso._id },
          {
            $set: {
              ownerId: writeBack.ownerId,
              propertyId: writeBack.propertyId,
              writeBack: { ...writeBack, eseguitoIl: ora, campiFiscaliMancanti: mancanti },
            },
            $push: {
              audit: store.eventoAudit(
                `Anagrafiche aggiornate: proprietario ${writeBack.ownerCreato ? 'creato' : 'aggiornato'}` +
                `, immobile ${writeBack.propCreata ? 'creato' : 'aggiornato'}` +
                (writeBack.coprops ? `, ${writeBack.coprops} comproprietari` : '') +
                (mancanti.length ? ` — restano da completare: ${mancanti.join(', ')}` : ''),
                req
              ),
            },
          }
        );
        console.log(`[sign/firma] write-back ${caso.riferimento} → owner ${writeBack.ownerId}, prop ${writeBack.propertyId}`);
      } catch (err) {
        console.error('[sign/firma] write-back FALLITO:', err.message);
        await store.pushAudit(getDb, { _id: caso._id },
          store.eventoAudit(`Aggiornamento anagrafiche FALLITO: ${err.message}`, req));
        await col.updateOne({ _id: caso._id },
          { $set: { writeBack: { errore: err.message, tentatoIl: ora } } });
      }

      // `casoFirmato` e non `caso`: porta i dati come sono stati firmati, e
      // con pdfFinale l'email interna può riportare l'impronta del PDF.
      inviaCopie({
        resend,
        caso: { ...casoFirmato, pdfFinale: { r2Key: key, sha256, bytes, generatoIl: ora } },
        buffer,
        r2GetSignedUrl,
      }).catch((err) => console.error('[sign/firma] invio copie fallito:', err.message));

      console.log(`[sign/firma] ${caso.riferimento} firmato — ${bytes} byte, sha256 ${sha256.slice(0, 16)}…`);
      res.json({
        ok: true, riferimento: caso.riferimento, sha256, firmatoIl: ora,
        anagraficheAggiornate: !!(writeBack && writeBack.ownerId),
      });
    } catch (e) {
      console.error('[sign/firma]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

/* ══════════════════════════════════════════════════════════════════ *
 * Email
 * ══════════════════════════════════════════════════════════════════ */

const FROM = process.env.RESEND_FROM_CONTRATTI || 'Houzly <contratti@houzly.it>';

async function inviaInvito({ resend, email, link, caso, baseUrl }) {
  const struttura = caso.nomeStruttura ? ` per ${caso.nomeStruttura}` : '';
  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:560px">
      <p>Buongiorno,</p>
      <p>di seguito il link per completare e firmare il contratto di mandato${struttura} con Houzly.</p>
      <p>Le verranno chiesti i dati anagrafici, i riferimenti catastali dell'immobile e alcuni
         documenti. Può interrompere e riprendere in qualsiasi momento: i dati inseriti restano salvati.</p>
      <p style="margin:28px 0">
        <a href="${link}" style="background:#170046;color:#fff;padding:14px 28px;
           border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">
          Compila e firma il contratto
        </a>
      </p>
      <p style="font-size:13px;color:#666">
        Il link è personale e scade fra ${GIORNI_VALIDITA} giorni. Riferimento pratica: ${caso.riferimento}.
      </p>
      <p style="font-size:13px;color:#666">
        Prima di cominciare può dare un'occhiata alla
        <a href="${baseUrl}/guida-firma.html" style="color:#170046">guida in tre minuti</a>:
        spiega cosa serve avere sottomano e risponde alle domande più frequenti.
      </p>
      <p style="font-size:13px;color:#666">
        Per qualsiasi dubbio può rispondere a questa email.
      </p>
      <p>Houzly Snc<br>www.houzly.it</p>
    </div>`;

  try {
    const r = await resend.emails.send({
      from: FROM,
      to: email,
      subject: `Contratto di mandato Houzly${struttura} — da firmare`,
      html,
    });
    return { success: true, id: r.data?.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/* Nomi leggibili dei documenti, per i file in allegato e per l'elenco
   nell'email: "documento_fronte" su un allegato non dice di chi è. */
const NOME_TIPO = {
  documento_fronte: 'documento identità fronte',
  documento_retro: 'documento identità retro',
  documento: 'documento identità',
  visura: 'visura catastale',
  planimetria: 'planimetria',
  conformita: 'conformità impianti',
  altro: 'altro documento',
};

/* Resend accetta fino a 40 MB per messaggio, contando la codifica. Si sta
   larghi: oltre questo tetto i documenti restanti vanno come link invece di
   essere allegati, così l'email parte comunque. */
const TETTO_ALLEGATI_BYTE = 18 * 1024 * 1024;

const ORDINE_TIPO = ['documento_fronte', 'documento_retro', 'documento', 'visura',
  'planimetria', 'conformita', 'altro'];

function nomeFileAllegato(caso, a) {
  const chi = a.soggettoNome
    ? '-' + String(a.soggettoNome).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
    : '';
  const est = (a.nomeFile || '').split('.').pop();
  const estensione = est && est.length <= 5 ? est.toLowerCase() : 'jpg';
  return `${caso.riferimento}-${a.tipo}${chi}.${estensione}`;
}

/**
 * Prepara i documenti raccolti perchè arrivino a info@houzly.it insieme al
 * contratto: sono la prova dell'identità di chi ha firmato e di chi è
 * stato rappresentato, e la verifica della titolarità.
 *
 * Si allegano per riferimento (Resend scarica l'URL firmato al momento
 * dell'invio) invece di passare dalla nostra memoria: con quattro titolari
 * sono nove file, e tenerli tutti in RAM per poi codificarli in base64
 * costerebbe tre volte il loro peso.
 */
async function allegatiDocumenti({ caso, r2GetSignedUrl }) {
  const allegati = (caso.allegati || []).filter((a) => a.r2Key);
  if (!allegati.length || typeof r2GetSignedUrl !== 'function') {
    return { attachments: [], elenco: [], nonAllegati: [] };
  }

  const ordinati = allegati.slice().sort((a, b) => {
    const s = String(a.soggetto || 'mandante').localeCompare(String(b.soggetto || 'mandante'));
    return s || ORDINE_TIPO.indexOf(a.tipo) - ORDINE_TIPO.indexOf(b.tipo);
  });

  const attachments = [];
  const elenco = [];
  const nonAllegati = [];
  let peso = 0;

  for (const a of ordinati) {
    const chi = a.soggettoNome ? ` — ${a.soggettoNome}` : '';
    const voce = `${NOME_TIPO[a.tipo] || a.tipo}${chi}`;
    const kb = Math.round((a.bytes || 0) / 1024);

    if (peso + (a.bytes || 0) > TETTO_ALLEGATI_BYTE && attachments.length) {
      // Oltre il tetto: link valido una settimana invece dell'allegato.
      try {
        nonAllegati.push({ voce, url: await r2GetSignedUrl(a.r2Key, 604800) });
      } catch (e) {
        nonAllegati.push({ voce, url: null });
      }
      continue;
    }

    try {
      const path = await r2GetSignedUrl(a.r2Key, 3600);
      attachments.push({ filename: nomeFileAllegato(caso, a), path });
      peso += a.bytes || 0;
      elenco.push(`${voce} (${kb} KB)`);
    } catch (e) {
      console.error('[sign/firma] allegato non recuperabile:', a.r2Key, e.message);
      nonAllegati.push({ voce, url: null });
    }
  }

  return { attachments, elenco, nonAllegati };
}

async function inviaCopie({ resend, caso, buffer, r2GetSignedUrl }) {
  const contratto = {
    filename: `contratto-${caso.riferimento}.pdf`,
    content: buffer.toString('base64'),
  };

  /* — copia al proprietario: solo il contratto — */
  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:560px">
      <p>Buongiorno,</p>
      <p>in allegato trova copia del contratto di mandato firmato, riferimento
         <strong>${caso.riferimento}</strong>.</p>
      <p>Le consigliamo di conservarlo. Una copia è archiviata anche nei nostri sistemi.</p>
      <p>Grazie per aver scelto Houzly.</p>
      <p>Houzly Snc<br>www.houzly.it</p>
    </div>`;

  await resend.emails.send({
    from: FROM, to: caso.email,
    subject: `Contratto di mandato Houzly ${caso.riferimento} — copia firmata`,
    html, attachments: [contratto],
  });

  /* — copia interna: contratto più tutti i documenti raccolti — */
  const { attachments, elenco, nonAllegati } =
    await allegatiDocumenti({ caso, r2GetSignedUrl });

  const m = caso.mandante || {};
  const cop = (caso.comproprietari || [])
    .filter((c) => c.nome || c.cognome)
    .map((c) => `${[c.nome, c.cognome].filter(Boolean).join(' ')} — CF ${c.cf || 'mancante'}, quota ${c.quota || '?'}%`);

  const riga = (etichetta, valore) =>
    valore ? `<tr><td style="padding:2px 10px 2px 0;color:#666">${etichetta}</td><td>${valore}</td></tr>` : '';

  const htmlInterno = `
    <div style="font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:620px">
      <p><strong>${caso.riferimento}</strong> firmato da
         ${nomeMandante(m) || caso.email}.</p>
      <table style="font-size:13px;border-collapse:collapse">
        ${riga('Struttura', caso.nomeStruttura)}
        ${riga('Email', caso.email)}
        ${riga('CF / P.IVA', m.cf || m.piva || '')}
        ${riga('IBAN', m.iban)}
        ${riga('Immobile', [caso.immobile?.viaNome, caso.immobile?.comune].filter(Boolean).join(', '))}
        ${riga('CIN', caso.immobile?.cin)}
        ${riga('Quota del firmatario', m.quota ? m.quota + '%' : '')}
      </table>
      ${cop.length ? `<p style="font-size:13px"><strong>Comproprietari</strong><br>${cop.join('<br>')}</p>` : ''}
      ${elenco.length
        ? `<p style="font-size:13px"><strong>Documenti in allegato</strong><br>· ${elenco.join('<br>· ')}</p>`
        : '<p style="font-size:13px;color:#9c2231"><strong>Nessun documento allegato</strong> — da verificare in archivio.</p>'}
      ${nonAllegati.length
        ? `<p style="font-size:13px"><strong>Troppo grandi per l’allegato</strong>, link valido una settimana:<br>${
            nonAllegati.map((x) => x.url
              ? `· <a href="${x.url}">${x.voce}</a>`
              : `· ${x.voce} (link non disponibile)`).join('<br>')}</p>`
        : ''}
      <p style="font-size:12px;color:#666">SHA-256 del PDF: ${caso.pdfFinale?.sha256 || ''}</p>
    </div>`;

  await resend.emails.send({
    from: FROM, to: 'info@houzly.it',
    subject: `[Contratti] ${caso.riferimento} firmato — ${nomeMandante(m) || caso.email}`,
    html: htmlInterno,
    attachments: [contratto, ...attachments],
  });
}

module.exports = {
  createContractsAdminRouter,
  createContractsPublicRouter,
  GIORNI_VALIDITA,
  // Esposte per i test: sono le regole che decidono se si può firmare.
  documentiRichiesti,
  allegatiMancanti,
};
