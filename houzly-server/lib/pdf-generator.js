/**
 * Generatore PDF del contratto di mandato Houzly.
 *
 * Due funzioni pubbliche:
 *   risolviTemplate(template, caso) → snapshot con i placeholder sostituiti.
 *                                     Questo è ciò che va salvato in DB alla firma.
 *   generaPdf(snapshot, caso, opts) → { buffer, sha256 }
 *
 * La generazione è deterministica a parità di input, tranne che per la data di
 * creazione nei metadati PDF: per questo l'hash si calcola sul buffer finale e
 * si salva una volta sola, alla firma.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PdfPrinter = require('pdfmake');
const { FIRMA_MANDATARIA } = require('../assets/firma-mandataria');
const { LOGO_HEADER, LOGO_COPERTINA } = require('../assets/logo-houzly');

const INDIGO = '#170046';
const ORO = '#C8A55B';
const GRIGIO = '#666666';

/**
 * I font arrivano dal pacchetto npm @fontsource/roboto, non da node_modules/pdfmake:
 * pdfmake 0.2.x non distribuisce i .ttf per l'uso server-side e la loro posizione
 * cambia fra le versioni. Con @fontsource sono una dipendenza dichiarata, quindi
 * non serve committare file binari nel repo. pdfkit legge i .woff senza problemi.
 * Roboto è Apache 2.0 → uso commerciale libero.
 */
const FONT_DIR = path.join(
  path.dirname(require.resolve('@fontsource/roboto/package.json')),
  'files'
);

const FONT_FILES = {
  normal: 'roboto-latin-400-normal.woff',
  bold: 'roboto-latin-500-normal.woff',
  italics: 'roboto-latin-400-italic.woff',
  bolditalics: 'roboto-latin-500-italic.woff',
};

for (const f of Object.values(FONT_FILES)) {
  if (!fs.existsSync(path.join(FONT_DIR, f))) {
    throw new Error(
      `Font mancante: ${f}. Eseguire "npm install @fontsource/roboto" (vedi README).`
    );
  }
}

const printer = new PdfPrinter({
  Roboto: {
    normal: path.join(FONT_DIR, FONT_FILES.normal),
    bold: path.join(FONT_DIR, FONT_FILES.bold),
    italics: path.join(FONT_DIR, FONT_FILES.italics),
    bolditalics: path.join(FONT_DIR, FONT_FILES.bolditalics),
  },
});

/* ------------------------------------------------------------------ *
 * Risoluzione placeholder
 * ------------------------------------------------------------------ */

function leggiPercorso(obj, percorso) {
  return percorso.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * Sostituisce {{chiave.sottochiave}} con i valori della pratica.
 * Un campo mancante diventa una riga di puntini: il contratto resta leggibile
 * e il buco è visibile, invece di stampare "undefined".
 */
function sostituisci(testo, dati) {
  return testo.replace(/\{\{([\w.]+)\}\}/g, (_, chiave) => {
    const v = leggiPercorso(dati, chiave);
    if (v === undefined || v === null || v === '') return '__________';
    return String(v);
  });
}

/**
 * Costruisce il blocco "E" delle parti: un solo capoverso se il proprietario è
 * unico, altrimenti intro + una voce per ciascun comproprietario + chiusura.
 * In caso di accredito suddiviso, a ogni voce si aggiunge il suo IBAN.
 */
function bloccoParti(template, caso, condivisa, suddiviso) {
  if (!condivisa) return [sostituisci(template.mandante, { mandante: caso.mandante || {} })];
  const m = template.mandanteMultiplo;
  if (!m) return [sostituisci(template.mandante, { mandante: caso.mandante || {} })];

  const parti = [caso.mandante || {}, ...(caso.comproprietari || [])];
  const voci = parti.map((p) => {
    let t = sostituisci(m.voce, p);
    if (suddiviso && p.iban) t = t.replace(/;$/, `, IBAN **${p.iban}**;`);
    return t;
  });
  // L'ultima voce chiude con il punto e virgola sostituito dalla chiusura.
  return [m.intro, ...voci, m.chiusura];
}

/** Formula il complemento oggetto dell'art. 11-bis in base ai servizi scelti. */
function oggettoServizi(verde, piscina) {
  if (verde && piscina) return 'delle aree verdi pertinenziali e della piscina';
  if (verde) return 'delle aree verdi pertinenziali';
  if (piscina) return 'della piscina';
  return 'del verde e della piscina';
}

/**
 * Produce lo snapshot: template + dati della pratica, con tutti i placeholder
 * già risolti e la variante corretta dell'art. 11-bis.
 */
function risolviTemplate(template, caso) {
  const cond = caso.condizioni || {};
  const verde = !!cond.verde;
  const piscina = !!cond.piscina;
  const accessoriAttivi = verde || piscina;

  const comproprietari = caso.comproprietari || [];
  const condivisa = comproprietari.length > 0;
  const suddiviso = (caso.pagamento || {}).modalita === 'suddiviso';

  // Flag usati dai `soloSe` di premesse, articoli e commi.
  const flag = {
    proprietaEsclusiva: !condivisa,
    proprietaCondivisa: condivisa,
    pagamentoUnico: condivisa && !suddiviso,
    pagamentoSuddiviso: condivisa && suddiviso,
  };

  const dati = {
    mandante: caso.mandante || {},
    immobile: caso.immobile || {},
    ...template.defaults,
    ...cond,
    servizi11bisOggetto: oggettoServizi(verde, piscina),
  };

  const mappaTesto = (t) => (typeof t === 'string' ? sostituisci(t, dati) : t);
  const visibile = (x) => !x.soloSe || flag[x.soloSe] === true;

  // L'art. 11-bis ha due varianti che si escludono a vicenda: quella con i
  // servizi attivati e quella che dichiara l'onere in capo al Mandante.
  const articoli = template.articoli
    .filter((a) => {
      if (a.id === 'art11bis') return accessoriAttivi;
      if (a.id === 'art11bis_escluso') return !accessoriAttivi;
      return visibile(a);
    })
    .map((a) => ({
      ...a,
      titolo: mappaTesto(a.titolo),
      commi: a.commi.filter(visibile).map((c) => {
        // Le voci condizionali compaiono solo per i servizi effettivamente scelti.
        const daCondizionale = (c.elencoCondizionale || [])
          .filter((v) => cond[v.chiave] === true)
          .map((v) => v.testo);
        const { elencoCondizionale, ...resto } = c;
        return {
          ...resto,
          testo: mappaTesto(c.testo),
          elenco: [...(c.elenco || []), ...daCondizionale].map(mappaTesto),
        };
      }),
    }));

  // La clausola vessatoria dell'art. 11-bis riguarda la limitazione di
  // responsabilità sui fornitori terzi: senza servizi attivati non esiste.
  const clausole = {
    ...template.clausoleVessatorie,
    elenco: template.clausoleVessatorie.elenco.filter(
      (c) => c.key !== 'art11bis' || accessoriAttivi
    ),
  };

  return {
    versione: template.versione,
    dataVersione: template.dataVersione,
    intestazione: template.intestazione,
    preambolo: template.preambolo,
    mandataria: template.mandataria,
    mandante: mappaTesto(template.mandante),
    mandanteBlocchi: bloccoParti(template, caso, condivisa, suddiviso),
    premesse: template.premesse
      .filter(visibile)
      .map((p) => ({ ...p, testo: mappaTesto(p.testo) })),
    articoli,
    clausoleVessatorie: clausole,
    glossario: template.glossario,
    condizioniApplicate: dati,
  };
}

/* ------------------------------------------------------------------ *
 * Helper di formattazione
 * ------------------------------------------------------------------ */

/** Converte **grassetto** in un array di text node pdfmake. */
function rich(testo, stileBase = {}) {
  const parti = String(testo).split(/\*\*(.+?)\*\*/gs);
  return parti.map((p, i) => ({ text: p, bold: i % 2 === 1, ...stileBase }));
}

function paragrafo(testo, opts = {}) {
  return { text: rich(testo), alignment: 'justify', margin: [0, 0, 0, 6], ...opts };
}

/**
 * Comma con il suo numero. Il numero è un nodo noWrap: senza, pdfmake va a capo
 * sul trattino e stampa "11- bis.2" a fine riga.
 */
function comma(numero, testo) {
  return {
    text: [{ text: numero + ' ', noWrap: true }, ...rich(testo)],
    alignment: 'justify',
    margin: [0, 0, 0, 6],
  };
}

function elencoPuntato(voci) {
  return {
    ul: voci.map((v) => ({ text: rich(v), alignment: 'justify' })),
    margin: [8, 2, 0, 6],
    fontSize: 9.5,
  };
}

/* ------------------------------------------------------------------ *
 * Costruzione documento
 * ------------------------------------------------------------------ */

function buildDocDefinition(snapshot, caso, opts = {}) {
  const bozza = !!opts.bozza;
  const int = snapshot.intestazione;
  const content = [];

  /* --- Frontespizio --- */
  content.push(
    { image: LOGO_COPERTINA, width: 250, alignment: 'center', margin: [0, 150, 0, 26] },
    { text: int.occhiello, style: 'occhiello' },
    {
      canvas: [
        { type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: INDIGO },
      ],
      margin: [0, 6, 0, 14],
    },
    { text: int.titolo, style: 'titoloDoc' },
    { text: int.sottotitolo, style: 'sottotitoloDoc' },
    {
      text: `Modello contratto-tipo \u00b7 Versione ${snapshot.versione} \u00b7 ${snapshot.dataVersione}`,
      style: 'versione',
    },
    {
      text: caso.riferimento ? `Pratica n. ${caso.riferimento}` : '',
      style: 'versione',
      margin: [0, 2, 0, 0],
    },
    { text: '', pageBreak: 'after' }
  );

  /* --- Parti e premesse --- */
  content.push(
    { text: int.titolo, style: 'h1' },
    { text: snapshot.preambolo, style: 'preambolo' },
    { text: 'TRA', style: 'centrato' },
    paragrafo(snapshot.mandataria),
    { text: 'E', style: 'centrato' },
    // Gli snapshot vecchi hanno solo la stringa singola: si continua a leggerli.
    ...(snapshot.mandanteBlocchi || [snapshot.mandante]).map((b) => paragrafo(b)),
    { text: 'PREMESSO CHE', style: 'centrato' }
  );

  snapshot.premesse.forEach((p) => {
    content.push({
      // noWrap sulla lettera: senza, "a-bis)" va a capo sul trattino.
      text: [{ text: `${p.lettera}) `, bold: true, color: INDIGO, noWrap: true }, ...rich(p.testo)],
      alignment: 'justify',
      margin: [14, 0, 0, 5],
    });
  });

  content.push({
    text: 'TUTTO CI\u00d2 PREMESSO, SI CONVIENE E SI STIPULA QUANTO SEGUE',
    style: 'centrato',
    margin: [0, 10, 0, 10],
  });

  /* --- Articoli --- */
  snapshot.articoli.forEach((a) => {
    content.push({
      text: `${a.numero} \u2014 ${a.titolo}`,
      style: 'h2',
      // Evita che un titolo di articolo resti orfano in fondo alla pagina.
      headlineLevel: 1,
    });
    a.commi.forEach((c) => {
      content.push(comma(c.n, c.testo));
      if (c.elenco && c.elenco.length) content.push(elencoPuntato(c.elenco));
    });
  });

  /* --- Firma principale --- */
  content.push(
    { text: '', margin: [0, 10, 0, 0] },
    paragrafo(`Luogo e data: ${caso.luogoFirma || '__________'}, ${caso.dataFirma || '__________'}`),
    {
      columns: [
        { width: '*', stack: bloccoFirma('Il Mandante', caso.firme && caso.firme.contratto, caso) },
        {
          width: '*',
          stack: bloccoFirma('La Mandataria \u2014 Houzly Snc', null, caso, true),
        },
      ],
      columnGap: 30,
      margin: [0, 10, 0, 0],
    }
  );

  /* --- Clausole ex artt. 1341-1342 --- */
  content.push(
    { text: '', pageBreak: 'before' },
    { text: 'Approvazione specifica delle clausole ex artt. 1341 e 1342 c.c.', style: 'h2' },
    paragrafo(snapshot.clausoleVessatorie.intro),
    {
      // Le caselle sono disegnate come vettori, non con i caratteri ☑/☐:
      // Roboto non contiene quei glifi e verrebbero stampati come quadratini vuoti.
      stack: snapshot.clausoleVessatorie.elenco.map((c) => ({
        columns: [
          { width: 16, ...casella(((caso.clausole1341 || {})[c.key]) === true) },
          { width: '*', text: c.label, bold: true, fontSize: 9.5 },
        ],
        margin: [8, 0, 0, 5],
      })),
      margin: [0, 2, 0, 10],
    },
    paragrafo(
      'Il Mandante dichiara di aver preso visione integrale del testo contrattuale e di approvare ' +
        'specificamente, con distinta sottoscrizione, ciascuna delle clausole sopra elencate.'
    ),
    {
      columns: [
        {
          width: '*',
          stack: bloccoFirma(
            'Il Mandante (approvazione specifica)',
            caso.firme && caso.firme.clausole,
            caso
          ),
        },
        { width: '*', text: '' },
      ],
      margin: [0, 10, 0, 0],
    }
  );

  /* --- Appendice glossario --- */
  content.push(
    { text: '', pageBreak: 'before' },
    { text: snapshot.glossario.titolo, style: 'h1' },
    { text: snapshot.glossario.nota, style: 'preambolo' },
    {
      table: {
        headerRows: 1,
        widths: [130, '*'],
        body: [
          [
            { text: 'Termine', style: 'thead' },
            { text: 'Definizione', style: 'thead' },
          ],
          ...snapshot.glossario.voci.map((v) => [
            { text: v.termine, bold: true, fontSize: 9, color: INDIGO },
            { text: v.definizione, fontSize: 9, alignment: 'justify' },
          ]),
        ],
      },
      layout: {
        fillColor: (row) => (row === 0 ? INDIGO : row % 2 === 0 ? '#F5F5F7' : null),
        hLineColor: () => '#DDDDDD',
        vLineColor: () => '#DDDDDD',
      },
      margin: [0, 6, 0, 0],
    }
  );

  /* --- Pagina di audit (solo sul definitivo) --- */
  if (!bozza && caso.audit && caso.audit.length) {
    content.push({ text: '', pageBreak: 'before' }, ...paginaAudit(caso, snapshot));
  }

  return {
    content,
    pageSize: 'A4',
    pageMargins: [55, 62, 55, 55],
    info: {
      title: `Contratto mandato Houzly \u2014 ${(caso.mandante || {}).nomeCognome || 'bozza'}`,
      author: 'Houzly Snc',
      subject: 'Contratto di mandato con rappresentanza e mandato all\u2019incasso',
    },
    defaultStyle: { font: 'Roboto', fontSize: 9.5, lineHeight: 1.25, color: '#1A1A1A' },

    header: () => ({
      margin: [55, 22, 55, 0],
      stack: [
        {
          columns: [
            { image: LOGO_HEADER, width: 74, margin: [0, 1, 0, 0] },
            {
              text: int.headerDx,
              fontSize: 8,
              color: GRIGIO,
              alignment: 'right',
              width: '*',
              margin: [0, 6, 0, 0],
            },
          ],
        },
        {
          canvas: [
            { type: 'line', x1: 0, y1: 2, x2: 485, y2: 2, lineWidth: 1.5, lineColor: ORO },
          ],
        },
      ],
    }),

    footer: (currentPage, pageCount) => ({
      margin: [55, 8, 55, 0],
      columns: [
        { text: int.footer, fontSize: 7.5, color: GRIGIO, width: '*' },
        {
          text: `Pag. ${currentPage} / ${pageCount}`,
          fontSize: 7.5,
          color: GRIGIO,
          alignment: 'right',
          width: 'auto',
        },
      ],
    }),

    background: bozza
      ? () => ({
          text: 'BOZZA \u2014 NON FIRMATO',
          color: ORO,
          opacity: 0.18,
          bold: true,
          fontSize: 58,
          alignment: 'center',
          margin: [0, 380, 0, 0],
        })
      : undefined,

    styles: {
      occhiello: { fontSize: 10, bold: true, alignment: 'center', color: INDIGO, margin: [0, 0, 0, 0] },
      titoloDoc: { fontSize: 18, bold: true, alignment: 'center', color: INDIGO, margin: [0, 0, 0, 6] },
      sottotitoloDoc: { fontSize: 11, italics: true, alignment: 'center', margin: [0, 0, 0, 16] },
      versione: { fontSize: 9, alignment: 'center', color: GRIGIO },
      h1: { fontSize: 12.5, bold: true, color: INDIGO, margin: [0, 0, 0, 8] },
      h2: { fontSize: 10.5, bold: true, color: INDIGO, margin: [0, 10, 0, 5] },
      preambolo: { fontSize: 8.5, italics: true, color: GRIGIO, alignment: 'justify', margin: [0, 0, 0, 10] },
      centrato: { alignment: 'center', bold: true, color: INDIGO, margin: [0, 8, 0, 6] },
      thead: { bold: true, color: '#FFFFFF', fontSize: 9, margin: [0, 3, 0, 3] },
      audit: { fontSize: 8, color: '#333333' },
    },
  };
}

/** Casella di spunta disegnata a vettori (quadrato + eventuale segno di spunta). */
function casella(spuntata) {
  const canvas = [
    {
      type: 'rect',
      x: 0,
      y: 1,
      w: 9,
      h: 9,
      lineWidth: 0.8,
      lineColor: spuntata ? INDIGO : '#999999',
    },
  ];
  if (spuntata) {
    canvas.push(
      { type: 'line', x1: 2, y1: 5.5, x2: 4, y2: 8, lineWidth: 1.3, lineColor: INDIGO },
      { type: 'line', x1: 4, y1: 8, x2: 7.5, y2: 2.8, lineWidth: 1.3, lineColor: INDIGO }
    );
  }
  return { canvas };
}

/** Blocco firma: immagine se presente, altrimenti riga vuota da firmare a penna. */
function bloccoFirma(etichetta, firma, caso, mandataria = false) {
  const stack = [{ text: etichetta, bold: true, color: INDIGO, fontSize: 9.5, margin: [0, 0, 0, 4] }];

  if (firma && firma.dataUrl) {
    stack.push({ image: firma.dataUrl, fit: [170, 48] });
  } else if (mandataria) {
    // Timbro e firma di Houzly: sempre presente, salvo override esplicito.
    // Stesso ingombro della firma del Mandante, così i due blocchi restano allineati.
    stack.push({ image: caso.firmaMandataria || FIRMA_MANDATARIA, fit: [170, 48] });
  } else {
    stack.push({ text: '', margin: [0, 22, 0, 0] });
  }

  stack.push({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 190, y2: 0, lineWidth: 0.7, lineColor: '#999999' }],
    margin: [0, 2, 0, 3],
  });

  if (mandataria) {
    stack.push({ text: 'Timbro e firma della Mandataria', fontSize: 7.5, color: GRIGIO });
  }

  if (firma && firma.ts) {
    stack.push({
      text: `Firmato elettronicamente il ${new Date(firma.ts).toLocaleString('it-IT')}`,
      fontSize: 7.5,
      color: GRIGIO,
    });
  }
  return stack;
}

/**
 * Pagina di audit allegata al PDF firmato.
 * È la parte che, in caso di contestazione, sostiene la firma elettronica
 * semplice: va tenuta dentro il documento, non solo in database.
 */
function paginaAudit(caso, snapshot) {
  const righe = caso.audit.map((e) => [
    { text: new Date(e.ts).toLocaleString('it-IT'), style: 'audit' },
    { text: e.evento, style: 'audit' },
    { text: e.ip || '\u2014', style: 'audit' },
    { text: (e.userAgent || '\u2014').slice(0, 70), style: 'audit' },
  ]);

  return [
    { text: 'ATTESTAZIONE DI PROCESSO DI FIRMA ELETTRONICA', style: 'h1' },
    {
      text:
        'Documento generato automaticamente dal sistema Houzly. Riporta la sequenza degli eventi ' +
        'registrati durante la compilazione e la sottoscrizione del contratto, ai fini della ' +
        'formazione della prova ex art. 20 CAD e art. 2712 c.c.',
      style: 'preambolo',
    },
    {
      table: {
        widths: [110, '*', 75, 120],
        body: [
          [
            { text: 'Riferimento pratica', bold: true, style: 'audit' },
            { text: caso.riferimento || caso._id || '\u2014', style: 'audit', colSpan: 3 },
            {},
            {},
          ],
          [
            { text: 'Versione template', bold: true, style: 'audit' },
            { text: snapshot.versione, style: 'audit', colSpan: 3 },
            {},
            {},
          ],
          [
            { text: 'Email destinataria', bold: true, style: 'audit' },
            { text: caso.email || '\u2014', style: 'audit', colSpan: 3 },
            {},
            {},
          ],
          [
            { text: 'Token invito', bold: true, style: 'audit' },
            {
              text: caso.tokenHash || '\u2014',
              style: 'audit',
              colSpan: 3,
            },
            {},
            {},
          ],
        ],
      },
      layout: 'lightHorizontalLines',
      margin: [0, 0, 0, 14],
    },
    { text: 'Registro eventi', style: 'h2' },
    {
      table: {
        headerRows: 1,
        widths: [78, '*', 70, 130],
        body: [
          [
            { text: 'Data e ora', style: 'thead' },
            { text: 'Evento', style: 'thead' },
            { text: 'IP', style: 'thead' },
            { text: 'Dispositivo', style: 'thead' },
          ],
          ...righe,
        ],
      },
      layout: {
        fillColor: (row) => (row === 0 ? INDIGO : null),
        hLineColor: () => '#DDDDDD',
        vLineColor: () => '#DDDDDD',
      },
    },
    {
      text:
        '\nL\u2019impronta informatica (SHA-256) del presente documento \u00e8 registrata negli archivi ' +
        'della Mandataria al momento della generazione e ne garantisce l\u2019integrit\u00e0: qualsiasi ' +
        'modifica successiva produrrebbe un\u2019impronta diversa.',
      style: 'preambolo',
    },
  ];
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

function generaPdf(snapshot, caso, opts = {}) {
  return new Promise((resolve, reject) => {
    let doc;
    try {
      doc = printer.createPdfKitDocument(buildDocDefinition(snapshot, caso, opts));
    } catch (err) {
      return reject(err);
    }
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({
        buffer,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.length,
      });
    });
    doc.end();
  });
}

module.exports = { risolviTemplate, generaPdf, buildDocDefinition, sostituisci };
