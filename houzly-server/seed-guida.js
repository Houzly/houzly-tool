// seed-guida.js — popola le tre collezioni di Houzly Guest Intro
// Uso:  MONGODB_URI="..."  node seed-guida.js
// Idempotente: usa replaceOne({_id}, ..., {upsert:true}) — puoi rilanciarlo quando vuoi.

const { MongoClient } = require('mongodb');

const DB_NAME = process.env.GUIDA_DB || 'houzly';

// ---------- BRAND (singleton) ----------
const BRAND = {
  _id: 'houzly_brand',
  host: {
    company: 'Houzly',
    email: 'info@houzly.it',
    contacts: [
      { name: 'Daniele', role: { it: 'Host', en: 'Host' }, phone: '+393386805606' },
      { name: 'Romeo',   role: { it: 'Host', en: 'Host' }, phone: '+393312127801' }
    ]
  },
  checkin_default:  { time_from: '15:00', time_to: '20:00' },
  checkout_default: { time_by: '10:00' },
  emergency: { europe: '112', medical: '118', police: '113', fire: '115' },
  welcome_eyebrow:      { it: 'Benvenuti', en: 'Welcome' },
  welcome_note_default: { it: 'Benvenuti. Qui trovate tutto ciò che vi serve per il vostro soggiorno.', en: 'Welcome. Here you\'ll find everything you need for your stay.' },
  welcome_sign_default: { it: 'Daniele & Romeo', en: 'Daniele & Romeo' },
  house_rules_default: [
    { key: 'no_smoking',        ic: '🚭', it: 'Vietato fumare all\'interno della casa', en: 'No smoking inside the house' },
    { key: 'no_parties',        ic: '🎉', it: 'Niente feste o eventi', en: 'No parties or events' },
    { key: 'quiet_hours',       ic: '🔇', it: 'Silenzio dalle 22:00 alle 08:00', en: 'Quiet hours 22:00–08:00' },
    { key: 'registered_guests', ic: '👥', it: 'Solo gli ospiti registrati possono soggiornare', en: 'Only registered guests may stay' }
  ],
  checkout_steps_default: [
    { key: 'trash',   it: 'Svuota i cestini e fai la differenziata', en: 'Empty the bins and sort the waste' },
    { key: 'windows', it: 'Chiudi bene porte e finestre', en: 'Close all doors and windows' },
    { key: 'power',   it: 'Spegni luci e climatizzatori', en: 'Switch off lights and AC' },
    { key: 'keys',    it: 'Riponi le chiavi nella cassetta', en: 'Return the keys to the lockbox' }
  ],
  branding: { navy: '#170046', blue: '#4ACBEF', cream: '#f5f1ea', gold: '#c9a84c' },
  languages: ['it', 'en']
};

// stream placeholder riutilizzabile (differenziata da definire)
const STREAMS_PLACEHOLDER = [
  { nm: { it: 'Organico', en: 'Food' },          color: '#6b4423', day: { it: '—', en: '—' } },
  { nm: { it: 'Carta', en: 'Paper' },            color: '#2f6fb0', day: { it: '—', en: '—' } },
  { nm: { it: 'Plastica', en: 'Plastic' },       color: '#e0c200', day: { it: '—', en: '—' } },
  { nm: { it: 'Vetro', en: 'Glass' },            color: '#3a8a4a', day: { it: '—', en: '—' } },
  { nm: { it: 'Indifferenziato', en: 'General' }, color: '#8a8a8a', day: { it: '—', en: '—' } }
];

const REC_PLACEHOLDER = [
  { nm: 'Ristorante (esempio)', meta: { it: 'Cucina tipica · — min', en: 'Local cuisine · — min' }, desc: { it: 'Da sostituire con un consiglio reale.', en: 'Replace with a real pick.' }, q: '' },
  { nm: 'Esperienza (esempio)', meta: { it: 'Da vivere · — min', en: 'Experience · — min' }, desc: { it: 'Da sostituire.', en: 'Replace.' }, q: '' }
];

// factory: zona con differenziata/servizi placeholder (da completare poi)
function mkZone(id, label, comune, prov, region, operator) {
  const sardo = region === 'Sardegna';
  return {
    _id: id, label, comune, provincia: prov, region,
    location: { it: `${label} · ${sardo ? 'Sardegna' : 'Toscana'}`, en: `${label} · ${sardo ? 'Sardinia' : 'Tuscany'}` },
    tourist_tax: { per_night: null, max_nights: null, currency: 'EUR' },
    waste: {
      operator: operator || 'TODO', granularity: sardo ? 'comune-unico' : 'per-zona',
      expose: { it: 'Esporre entro le 06:00 del giorno di raccolta.', en: 'Put waste out by 06:00 on collection day.' },
      streams: STREAMS_PLACEHOLDER, bin_location: { it: 'Mastelli: —', en: 'Bins: —' }, info_url: ''
    },
    emergency_local: { hospital: { nm: { it: '—', en: '—' }, note: { it: '—', en: '—' } } },
    recommendations: REC_PLACEHOLDER
  };
}

// ---------- ZONE ----------
const ZONES = [
  {
    _id: 'montevarchi',
    label: 'Montevarchi', comune: 'Montevarchi', provincia: 'AR', region: 'Toscana',
    location: { it: 'Montevarchi · Toscana', en: 'Montevarchi · Tuscany' },
    tourist_tax: { per_night: null, max_nights: null, currency: 'EUR' },
    waste: {
      operator: 'Sei Toscana', granularity: 'per-zona', // schedule reale sul waste_override della casa
      expose: { it: 'Esporre entro le 06:00 del giorno di raccolta.', en: 'Put waste out by 06:00 on collection day.' },
      streams: STREAMS_PLACEHOLDER,
      bin_location: { it: 'Mastelli: —', en: 'Bins: —' },
      info_url: 'https://seitoscana.it/comuni/montevarchi'
    },
    emergency_local: { hospital: { nm: { it: 'Ospedale del Valdarno', en: 'Valdarno Hospital' }, note: { it: 'Montevarchi', en: 'Montevarchi' } } },
    recommendations: REC_PLACEHOLDER
  },
  {
    _id: 'loro_ciuffenna',
    label: 'Loro Ciuffenna', comune: 'Loro Ciuffenna', provincia: 'AR', region: 'Toscana',
    location: { it: 'Loro Ciuffenna · Toscana', en: 'Loro Ciuffenna · Tuscany' },
    tourist_tax: { per_night: 2.00, max_nights: 5, currency: 'EUR' },
    waste: {
      operator: 'Sei Toscana', granularity: 'per-zona',
      expose: { it: 'Esporre entro le 06:00 del giorno di raccolta.', en: 'Put waste out by 06:00 on collection day.' },
      streams: STREAMS_PLACEHOLDER,
      bin_location: { it: 'Mastelli: —', en: 'Bins: —' },
      info_url: 'https://seitoscana.it/comuni/loro-ciuffenna/raccolta-rifiuti'
    },
    emergency_local: { hospital: { nm: { it: 'Ospedale del Valdarno', en: 'Valdarno Hospital' }, note: { it: 'Montevarchi', en: 'Montevarchi' } } },
    recommendations: REC_PLACEHOLDER
  },
  {
    _id: 'agrustos_budoni',
    label: 'Agrustos (Budoni)', comune: 'Budoni', provincia: 'SS', region: 'Sardegna',
    location: { it: 'Agrustos · Sardegna', en: 'Agrustos · Sardinia' },
    tourist_tax: { per_night: null, max_nights: null, currency: 'EUR' },
    waste: { // Budoni: calendario UNICO -> vive in zona (Costa Blue lo eredita)
      operator: 'Formula Ambiente', granularity: 'comune-unico',
      expose: { it: 'Esporre dopo le 22:00 del giorno prima o entro le 06:00 del giorno di raccolta.', en: 'Put waste out after 22:00 the day before or by 06:00 on collection day.' },
      streams: [
        { nm: { it: 'Umido', en: 'Food' },             color: '#6b4423', day: { it: '—', en: '—' } },
        { nm: { it: 'Carta e cartone', en: 'Paper' },  color: '#bfae8e', day: { it: '—', en: '—' } },
        { nm: { it: 'Plastica', en: 'Plastic' },       color: '#e0c200', day: { it: '—', en: '—' } },
        { nm: { it: 'Vetro e lattine', en: 'Glass' },  color: '#2f6fb0', day: { it: '—', en: '—' } }, // a Budoni il vetro è BLU
        { nm: { it: 'Secco', en: 'General' },          color: '#8a8a8a', day: { it: '—', en: '—' } }
      ],
      bin_location: { it: 'Mastelli: —', en: 'Bins: —' },
      info_url: 'https://differenziata.junker.app/budoni'
    },
    emergency_local: { hospital: { nm: { it: 'Ospedale (rif. Olbia)', en: 'Hospital (Olbia area)' }, note: { it: '—', en: '—' } } },
    recommendations: REC_PLACEHOLDER
  },

  // ---- zone aggiunte (differenziata e servizi locali = placeholder, da completare nell'editor) ----
  mkZone('reggello',               'Reggello',                   'Reggello',                   'FI', 'Toscana', 'Alia Servizi Ambientali'),
  mkZone('figline_incisa',         'Figline e Incisa Valdarno',  'Figline e Incisa Valdarno',  'FI', 'Toscana', 'Alia Servizi Ambientali'),
  mkZone('terranuova_bracciolini', 'Terranuova Bracciolini',     'Terranuova Bracciolini',     'AR', 'Toscana', 'Sei Toscana'),
  mkZone('san_giovanni_valdarno',  'San Giovanni Valdarno',      'San Giovanni Valdarno',      'AR', 'Toscana', 'Sei Toscana'),
  mkZone('firenze',                'Firenze',                    'Firenze',                    'FI', 'Toscana', 'Alia Servizi Ambientali'),
  mkZone('castel_san_gimignano',   'Castel San Gimignano',       'Castel San Gimignano',       'SI', 'Toscana', 'Sei Toscana'),
  mkZone('siena',                  'Siena centro',               'Siena',                      'SI', 'Toscana', 'Sei Toscana'),
  mkZone('cala_di_seta_calasetta', 'Cala di Seta · Calasetta',   'Calasetta',                  'SU', 'Sardegna', ''),
  mkZone('bucine',                 'Bucine',                     'Bucine',                     'AR', 'Toscana', 'Sei Toscana'),
  mkZone('monte_san_savino',       'Monte San Savino',           'Monte San Savino',           'AR', 'Toscana', 'Sei Toscana')
];

// ---------- PROPRIETÀ ----------
const PROPERTIES = [
  {
    _id: 'villa-caterina', slug: 'villa-caterina', name: 'Villa Caterina',
    subtype: 'villa', active: true, zone: 'montevarchi',
    cin: null, hero_image: null,
    location: { it: 'Montevarchi · Toscana', en: 'Montevarchi · Tuscany' },
    welcome_note: { it: 'Benvenuti a Villa Caterina, tra le colline del Valdarno. Qui trovate tutto ciò che vi serve.', en: 'Welcome to Villa Caterina, among the hills of the Valdarno. Here\'s everything you need.' },
    facts: { guests: 6, bedrooms: 3, bathrooms: 2 },
    wifi: { network: 'VillaCaterina_Guest', password: 'TODO', note: { it: 'Rete disponibile in tutta la casa e in giardino.', en: 'Available throughout the house and garden.' } },
    checkin: { time_from: '15:00', instructions: { it: 'Check-in autonomo. La cassetta con le chiavi è accanto alla porta principale; il codice vi arriva via messaggio il giorno dell\'arrivo.', en: 'Self check-in. The key lockbox is next to the main door; the code is sent by message on arrival day.' } },
    checkout: { steps_extra: [ { key: 'pool_towels', it: 'Lascia i teli piscina nel cesto in lavanderia', en: 'Leave pool towels in the laundry basket' } ] },
    amenities: [
      { ic: 'waves',    nm: { it: 'Piscina', en: 'Pool' }, info: { it: 'Aperta 08:00–21:00. Doccia prima di entrare, niente vetro a bordo vasca, bambini sorvegliati.', en: 'Open 08:00–21:00. Shower first, no glass poolside, children supervised.' } },
      { ic: 'snow',     nm: { it: 'Climatizzatore', en: 'Air conditioning' }, info: { it: 'Telecomando in ogni camera. Tenete porte e finestre chiuse mentre è acceso.', en: 'Remote in each room. Keep doors/windows closed while on.' } },
      { ic: 'utensils', nm: { it: 'Lavastoviglie', en: 'Dishwasher' }, info: { it: 'Pastiglie nel mobile sotto il lavello. Programma ECO consigliato.', en: 'Tabs under the sink. ECO programme recommended.' } },
      { ic: 'coffee',   nm: { it: 'Macchina del caffè', en: 'Coffee machine' }, info: { it: 'Capsule compatibili nel cassetto della cucina.', en: 'Compatible capsules in the kitchen drawer.' } }
    ],
    parking: { it: 'Parcheggio privato all\'interno della proprietà, accanto al cancello d\'ingresso.', en: 'Private parking within the property, next to the entrance gate.' },
    house_rules_extra: [],
    // Montevarchi è per-zona: la differenziata di QUESTA casa va qui (placeholder finché non abbiamo via/giro)
    waste_override: { streams: STREAMS_PLACEHOLDER, bin_location: { it: 'Mastelli: —', en: 'Bins: —' } },
    address: { line: { it: 'Montevarchi (AR), Toscana', en: 'Montevarchi (AR), Tuscany' }, q: 'Villa Caterina Montevarchi' }
  },
  {
    _id: 'sabris-modern-home', slug: 'sabris-modern-home', name: "Sabri's Modern Home",
    subtype: 'apartment', active: true, zone: 'loro_ciuffenna',
    cin: null, hero_image: null,
    location: { it: 'Loro Ciuffenna · Toscana', en: 'Loro Ciuffenna · Tuscany' },
    welcome_note: null, // usa il default di brand
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: 'TODO', password: 'TODO', note: { it: '', en: '' } },
    checkin: { instructions: { it: 'Check-in autonomo. Dettagli di accesso via messaggio prima dell\'arrivo.', en: 'Self check-in. Access details by message before arrival.' } },
    checkout: { steps_extra: [] },
    amenities: [
      { ic: 'utensils', nm: { it: 'Cucina', en: 'Kitchen' }, info: { it: 'TODO', en: 'TODO' } }
    ],
    parking: { it: 'TODO — in paese il parcheggio è spesso il punto critico.', en: 'TODO — parking in town is often the tricky part.' },
    house_rules_extra: [],
    waste_override: { streams: STREAMS_PLACEHOLDER, bin_location: { it: 'Mastelli: —', en: 'Bins: —' } },
    address: { line: { it: 'Loro Ciuffenna (AR), Toscana', en: 'Loro Ciuffenna (AR), Tuscany' }, q: "Sabri's Modern Home Loro Ciuffenna" }
  },
  {
    _id: 'costa-blue-holiday-home', slug: 'costa-blue-holiday-home', name: 'Costa Blue Holiday Home',
    subtype: 'apartment', active: true, zone: 'agrustos_budoni',
    cin: null, hero_image: null,
    location: { it: 'Agrustos · Sardegna', en: 'Agrustos · Sardinia' },
    welcome_note: { it: 'Benvenuti a Costa Blue, a due passi dal mare di Agrustos.', en: 'Welcome to Costa Blue, a short walk from the Agrustos seaside.' },
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: 'TODO', password: 'TODO', note: { it: '', en: '' } },
    checkin: { instructions: { it: 'Check-in autonomo. Dettagli di accesso via messaggio prima dell\'arrivo.', en: 'Self check-in. Access details by message before arrival.' } },
    checkout: { steps_extra: [] },
    amenities: [
      { ic: 'snow', nm: { it: 'Climatizzatore', en: 'Air conditioning' }, info: { it: 'TODO', en: 'TODO' } }
    ],
    parking: { it: 'TODO', en: 'TODO' },
    house_rules_extra: [],
    // Budoni è unico: NESSUN waste_override -> eredita la zona agrustos_budoni
    address: { line: { it: 'Agrustos, Budoni (SS), Sardegna', en: 'Agrustos, Budoni (SS), Sardinia' }, q: 'Costa Blue Agrustos Budoni' }
  }
];

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Manca MONGODB_URI');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  await db.collection('gi_brand').replaceOne({ _id: BRAND._id }, BRAND, { upsert: true });
  console.log('✓ gi_brand');

  for (const z of ZONES) {
    await db.collection('gi_zones').replaceOne({ _id: z._id }, z, { upsert: true });
    console.log('✓ gi_zones/' + z._id);
  }
  for (const p of PROPERTIES) {
    await db.collection('gi_properties').replaceOne({ _id: p._id }, p, { upsert: true });
    console.log('✓ gi_properties/' + p.slug);
  }

  await db.collection('gi_properties').createIndex({ slug: 1 }, { unique: true });
  console.log('✓ indice slug');

  await client.close();
  console.log('\nFatto. Prova:  GET /api/guida/villa-caterina');
}

// dati riutilizzabili (es. dal dev-server) + esecuzione solo se lanciato direttamente
module.exports = { BRAND, ZONES, PROPERTIES, main };
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
