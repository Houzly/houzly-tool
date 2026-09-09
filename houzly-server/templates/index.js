/**
 * Registro dei template contrattuali.
 *
 * VERSIONE_ATTIVA è quella usata per ogni nuova pratica.
 * Le versioni vecchie restano qui per sempre: servono a rigenerare o rileggere
 * un contratto firmato anni prima.
 */

const v15 = require('./mandato-v1.5');

const TEMPLATES = {
  '1.5': v15,
};

const VERSIONE_ATTIVA = '1.5';

function getTemplate(versione = VERSIONE_ATTIVA) {
  const t = TEMPLATES[versione];
  if (!t) throw new Error(`Template contratto versione "${versione}" non trovato`);
  return t;
}

module.exports = { getTemplate, VERSIONE_ATTIVA, TEMPLATES };
