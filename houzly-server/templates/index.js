/**
 * Registro dei template contrattuali.
 *
 * VERSIONE_ATTIVA è quella usata per ogni nuova pratica.
 * Le versioni vecchie restano qui per sempre: servono a rigenerare o rileggere
 * un contratto firmato anni prima. Non si modifica mai un file già usato da
 * una pratica: si crea la versione successiva.
 *
 * 1.5 → prima versione operativa.
 * 1.6 → art. 11-bis riscritto: la commissione dell'art. 7 è unica e totale,
 *       i servizi accessori (verde e piscina) si attivano singolarmente e non
 *       comportano alcuna commissione aggiuntiva.
 * 1.7 → comproprietà: le parti in epigrafe diventano più d'una con le rispettive
 *       quote, documento d'identità e visura diventano obbligatori (art. 5.1),
 *       l'IBAN entra nell'art. 9 con accredito unico o suddiviso per quota.
 * 1.8 → art. 5.1: il documento d'identità va acquisito fronte e retro.
 */

const v15 = require('./mandato-v1.5');
const v16 = require('./mandato-v1.6');
const v17 = require('./mandato-v1.7');
const v18 = require('./mandato-v1.8');

const TEMPLATES = {
  '1.5': v15,
  '1.6': v16,
  '1.7': v17,
  '1.8': v18,
};

const VERSIONE_ATTIVA = '1.8';

function getTemplate(versione = VERSIONE_ATTIVA) {
  const t = TEMPLATES[versione];
  if (!t) throw new Error(`Template contratto versione "${versione}" non trovato`);
  return t;
}

module.exports = { getTemplate, VERSIONE_ATTIVA, TEMPLATES };
