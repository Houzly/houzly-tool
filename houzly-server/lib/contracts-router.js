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
const { risolviTemplate, generaPdf } = require('./pdf-generator');
const store = require('./contracts-store');

/** Giorni di validità del link di firma. */
const GIORNI_VALIDITA = 30;

/** Tetto per singolo allegato (byte decodificati). */
const MAX_ALLEGATO_BYTE = 8 * 1024 * 1024;

const TIPI_ALLEGATO = ['visura', 'planimetria', 'conformita', 'documento', 'altro'];

const CAMPI_MANDANTE = [
  'nomeCognome', 'luogoNascita', 'dataNascita', 'residenza', 'cfPiva',
  'iban', 'pec', 'telefono', 'tipoSoggetto',
];
const CAMPI_IMMOBILE = [
  'indirizzo', 'piano', 'interno', 'foglio', 'particella', 'subalterno',
  'categoria', 'cin',
];

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
    allegati: (caso.allegati || []).map((a) => ({
      tipo: a.tipo, nomeFile: a.nomeFile, uploadedAt: a.uploadedAt,
    })),
    clausole1341: caso.clausole1341 || {},
    clausoleRichieste: elencoClausole(caso),
    condizioni: {
      commissione: caso.condizioni?.commissione,
      commissioneMaggiorata: caso.condizioni?.commissioneMaggiorata,
      servizi11bis: !!caso.condizioni?.servizi11bis,
    },
    firmato: caso.stato === 'firmata',
    scadenzaAt: caso.scadenzaAt,
  };
}

function elencoClausole(caso) {
  const t = getTemplate(caso.templateVersione || VERSIONE_ATTIVA);
  return t.clausoleVessatorie.elenco
    .filter((c) => c.key !== 'art11bis' || caso.condizioni?.servizi11bis)
    .map((c) => ({ key: c.key, label: c.label }));
}

/* ══════════════════════════════════════════════════════════════════ *
 * ROUTER ADMIN — /api/contracts
 * ══════════════════════════════════════════════════════════════════ */

function createContractsAdminRouter(deps) {
  const { getDb, resend, r2GetSignedUrl, APP_BASE_URL } = deps;
  const router = express.Router();

  // POST /api/contracts — crea la pratica e invia l'invito
  router.post('/', async (req, res) => {
    try {
      const { email, nomeStruttura, propertyId, condizioni, mandante, immobile, inviaSubito } = req.body || {};
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
        propertyId: propertyId || null,
        templateVersione: VERSIONE_ATTIVA,
        tokenHash,
        scadenzaAt: new Date(Date.now() + GIORNI_VALIDITA * 86400000).toISOString(),
        condizioni: {
          commissione: condizioni?.commissione || template.defaults.commissione,
          commissioneMaggiorata: condizioni?.commissioneMaggiorata || template.defaults.commissioneMaggiorata,
          servizi11bis: !!condizioni?.servizi11bis,
        },
        mandante: filtra(mandante, CAMPI_MANDANTE),
        immobile: filtra(immobile, CAMPI_IMMOBILE),
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
        const esito = await inviaInvito({ resend, email: caso.email, link, caso });
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

      const esito = await inviaInvito({ resend, email: caso.email, link, caso });
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
          $set: { stato: 'annullata', tokenHash: null, updatedAt: new Date().toISOString() },
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

  return router;
}

/* ══════════════════════════════════════════════════════════════════ *
 * ROUTER PUBBLICO — /api/sign
 * ══════════════════════════════════════════════════════════════════ */

function createContractsPublicRouter(deps) {
  const { getDb, r2Upload, resend, validateTaxCode } = deps;
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
      const mandante = filtra(req.body?.mandante, CAMPI_MANDANTE);
      const immobile = filtra(req.body?.immobile, CAMPI_IMMOBILE);
      for (const [k, v] of Object.entries(mandante)) set[`mandante.${k}`] = v;
      for (const [k, v] of Object.entries(immobile)) set[`immobile.${k}`] = v;

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

      const buffer = Buffer.from(String(dataBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (!buffer.length) return res.status(400).json({ ok: false, error: 'file_illeggibile' });
      if (buffer.length > MAX_ALLEGATO_BYTE) {
        return res.status(413).json({ ok: false, error: 'file_troppo_grande', maxMB: MAX_ALLEGATO_BYTE / 1048576 });
      }

      const estensione = (nomeFile || '').split('.').pop()?.toLowerCase().slice(0, 5) || 'bin';
      const key = `contratti/${caso.riferimento}/${tipo}-${Date.now()}.${estensione}`;
      await r2Upload(key, buffer, contentType || 'application/octet-stream');

      const col = await store.cases(getDb);
      await col.updateOne(
        { _id: caso._id },
        {
          $push: {
            allegati: {
              tipo,
              nomeFile: nomeFile || key.split('/').pop(),
              r2Key: key,
              bytes: buffer.length,
              uploadedAt: new Date().toISOString(),
            },
            audit: store.eventoAudit(`Allegato caricato: ${tipo} (${Math.round(buffer.length / 1024)} KB)`, req),
          },
          $set: { updatedAt: new Date().toISOString() },
        }
      );

      res.json({ ok: true, tipo, bytes: buffer.length });
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

      const obbligatori = ['nomeCognome', 'residenza', 'cfPiva'];
      const mancantiAnagrafica = obbligatori.filter((k) => !caso.mandante?.[k]);
      if (mancantiAnagrafica.length) {
        return res.status(400).json({ ok: false, error: 'dati_mancanti', campi: mancantiAnagrafica });
      }

      const ora = new Date().toISOString();
      const casoFirmato = {
        ...caso,
        clausole1341: spunte,
        luogoFirma: luogoFirma || caso.immobile?.indirizzo || '',
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
          $set: {
            stato: 'firmata',
            tokenHash: null,               // il link non è più riutilizzabile
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

      inviaCopie({ resend, caso, buffer }).catch((err) =>
        console.error('[sign/firma] invio copie fallito:', err.message)
      );

      console.log(`[sign/firma] ${caso.riferimento} firmato — ${bytes} byte, sha256 ${sha256.slice(0, 16)}…`);
      res.json({ ok: true, riferimento: caso.riferimento, sha256, firmatoIl: ora });
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

async function inviaInvito({ resend, email, link, caso }) {
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

async function inviaCopie({ resend, caso, buffer }) {
  const allegato = [{
    filename: `contratto-${caso.riferimento}.pdf`,
    content: buffer.toString('base64'),
  }];
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
    html, attachments: allegato,
  });

  await resend.emails.send({
    from: FROM, to: 'info@houzly.it',
    subject: `[Contratti] ${caso.riferimento} firmato — ${caso.mandante?.nomeCognome || caso.email}`,
    html: `<p>Contratto ${caso.riferimento} firmato da ${caso.mandante?.nomeCognome || caso.email}.</p>
           <p>Struttura: ${caso.nomeStruttura || 'non indicata'}</p>`,
    attachments: allegato,
  });
}

module.exports = {
  createContractsAdminRouter,
  createContractsPublicRouter,
  GIORNI_VALIDITA,
};
