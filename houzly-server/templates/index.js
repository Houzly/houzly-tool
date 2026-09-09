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
 */

const v15 = require('./mandato-v1.5');
const v16 = require('./mandato-v1.6');

const TEMPLATES = {
  '1.5': v15,
  '1.6': v16,
};

const VERSIONE_ATTIVA = '1.6';

function getTemplate(versione = VERSIONE_ATTIVA) {
  const t = TEMPLATES[versione];
  if (!t) throw new Error(`Template contratto versione "${versione}" non trovato`);
  return t;
}

module.exports = { getTemplate, VERSIONE_ATTIVA, TEMPLATES };
