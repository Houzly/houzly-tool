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
  mkZone('monte_san_savino',       'Monte San Savino',           'Monte San Savino',           'AR', 'Toscana', 'Sei Toscana'),
  mkZone('greve_in_chianti',       'Greve in Chianti',           'Greve in Chianti',           'FI', 'Toscana', 'Alia Servizi Ambientali'),
  mkZone('chitignano',             'Chitignano · Casentino',     'Chitignano',                 'AR', 'Toscana', 'Sei Toscana')
];

// ---------- PROPRIETÀ ----------
const PROPERTIES = [
  {
    _id: "villa-belvedere", slug: "villa-belvedere", name: "Villa Belvedere",
    subtype: "villa", active: true, zone: "reggello",
    location: { it: "Valdarno Fiorentino · Toscana", en: "Valdarno Fiorentino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Fiorentino · Toscana", en: "Valdarno Fiorentino · Tuscany" }, q: "Villa Belvedere Reggello" }
  },
  {
    _id: "podere-il-cellaino", slug: "podere-il-cellaino", name: "Podere Il Cellaino",
    subtype: "villa", active: true, zone: "reggello",
    location: { it: "Valdarno Fiorentino · Toscana", en: "Valdarno Fiorentino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Fiorentino · Toscana", en: "Valdarno Fiorentino · Tuscany" }, q: "Podere Il Cellaino Reggello" }
  },
  {
    _id: "villa-caterina", slug: "villa-caterina", name: "Villa Caterina",
    subtype: "villa", active: true, zone: "montevarchi",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Villa Caterina Valdarno Aretino" }
  },
  {
    _id: "casa-panorama", slug: "casa-panorama", name: "Casa Panorama",
    subtype: "apartment", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Casa Panorama Terranuova Bracciolini" }
  },
  {
    _id: "tenuta-la-bandita", slug: "tenuta-la-bandita", name: "Tenuta La Bandita",
    subtype: "villa", active: true, zone: "loro_ciuffenna",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Tenuta La Bandita Valdarno Aretino" }
  },
  {
    _id: "sunset-jacuzzi-penthouse", slug: "sunset-jacuzzi-penthouse", name: "Sunset Jacuzzi Penthouse",
    subtype: "apartment", active: true, zone: "firenze",
    location: { it: "Firenze · Toscana", en: "Florence · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Firenze · Toscana", en: "Florence · Tuscany" }, q: "Sunset Jacuzzi Penthouse Firenze" }
  },
  {
    _id: "azzurra-chalet-pratomagno", slug: "azzurra-chalet-pratomagno", name: "Azzurra's Chalet — Pool & Mountains",
    subtype: "villa", active: true, zone: "loro_ciuffenna",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Azzurra's Chalet — Pool & Mountains Loro Ciuffenna" }
  },
  {
    _id: "villa-tommasini-torre", slug: "villa-tommasini-torre", name: "Villa Tommasini — La Torre",
    subtype: "villa", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Villa Tommasini — La Torre Terranuova Bracciolini" }
  },
  {
    _id: "villa-la-quiete-chianti", slug: "villa-la-quiete-chianti", name: "Villa La Quiete in Chianti",
    subtype: "villa", active: true, zone: "greve_in_chianti",
    location: { it: "Chianti · Toscana", en: "Chianti · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Chianti · Toscana", en: "Chianti · Tuscany" }, q: "Villa La Quiete in Chianti Greve in Chianti" }
  },
  {
    _id: "belvedere-cottage-san-leolino", slug: "belvedere-cottage-san-leolino", name: "Belvedere Cottage",
    subtype: "villa", active: true, zone: "bucine",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Belvedere Cottage Bucine" }
  },
  {
    _id: "costa-blue-budoni", slug: "costa-blue-budoni", name: "Costa Blue Holiday Home",
    subtype: "apartment", active: true, zone: "agrustos_budoni",
    location: { it: "Sardegna", en: "Sardinia" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Sardegna", en: "Sardinia" }, q: "Costa Blue Holiday Home Budoni" }
  },
  {
    _id: "borgo-beppe-gloria-suite", slug: "borgo-beppe-gloria-suite", name: "Borgo Beppe & Gloria — The Suite",
    subtype: "apartment", active: true, zone: "san_giovanni_valdarno",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Borgo Beppe & Gloria — The Suite Valdarno Aretino" }
  },
  {
    _id: "borgo-beppe-gloria-lodge", slug: "borgo-beppe-gloria-lodge", name: "Borgo Beppe & Gloria — The Lodge",
    subtype: "villa", active: true, zone: "san_giovanni_valdarno",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Borgo Beppe & Gloria — The Lodge Valdarno Aretino" }
  },
  {
    _id: "villa-fiorita-chitignano", slug: "villa-fiorita-chitignano", name: "Villa Fiorita Chitignano",
    subtype: "villa", active: true, zone: "chitignano",
    location: { it: "Arezzo · Casentino", en: "Arezzo · Casentino" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Arezzo · Casentino", en: "Arezzo · Casentino" }, q: "Villa Fiorita Chitignano Arezzo" }
  },
  {
    _id: "sabri-modern-home", slug: "sabri-modern-home", name: "Sabri's Modern Home",
    subtype: "apartment", active: true, zone: "loro_ciuffenna",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Sabri's Modern Home Loro Ciuffenna" }
  },
  {
    _id: "giovanni-smart-flat", slug: "giovanni-smart-flat", name: "Giovanni's Smart Flat",
    subtype: "apartment", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Giovanni's Smart Flat Terranuova Bracciolini" }
  },
  {
    _id: "villetta-di-sara", slug: "villetta-di-sara", name: "Villetta di Sara",
    subtype: "villa", active: true, zone: "san_giovanni_valdarno",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Villetta di Sara Valdarno Aretino" }
  },
  {
    _id: "milu-holiday-home", slug: "milu-holiday-home", name: "Milu's Holiday Home",
    subtype: "villa", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Milu's Holiday Home Terranuova Bracciolini" }
  },
  {
    _id: "san-niccolo-olmeto-estate", slug: "san-niccolo-olmeto-estate", name: "San Niccolò a Olmeto — Estate & Pool",
    subtype: "villa", active: true, zone: "figline_incisa",
    location: { it: "Valdarno Fiorentino · Toscana", en: "Valdarno Fiorentino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Fiorentino · Toscana", en: "Valdarno Fiorentino · Tuscany" }, q: "San Niccolò a Olmeto — Estate & Pool Valdarno Fiorentino" }
  },
  {
    _id: "villa-il-molino-polo-club", slug: "villa-il-molino-polo-club", name: "Villa Il Molino — Polo Club",
    subtype: "villa", active: true, zone: "bucine",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Villa Il Molino — Polo Club Bucine" }
  },
  {
    _id: "il-pino-lilla", slug: "il-pino-lilla", name: "Il Pino Bioagricoltura — Lilla",
    subtype: "apartment", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Il Pino Bioagricoltura — Lilla Terranuova Bracciolini" }
  },
  {
    _id: "il-pino-fiordaliso", slug: "il-pino-fiordaliso", name: "Il Pino Bioagricoltura — Fiordaliso",
    subtype: "apartment", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Il Pino Bioagricoltura — Fiordaliso Terranuova Bracciolini" }
  },
  {
    _id: "il-pino-ginestra", slug: "il-pino-ginestra", name: "Il Pino Bioagricoltura — Ginestra",
    subtype: "apartment", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Il Pino Bioagricoltura — Ginestra Terranuova Bracciolini" }
  },
  {
    _id: "il-pino-salvia", slug: "il-pino-salvia", name: "Il Pino Bioagricoltura — Salvia",
    subtype: "apartment", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Il Pino Bioagricoltura — Salvia Terranuova Bracciolini" }
  },
  {
    _id: "il-pino-rosmarino", slug: "il-pino-rosmarino", name: "Il Pino Bioagricoltura — Rosmarino",
    subtype: "apartment", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Il Pino Bioagricoltura — Rosmarino Terranuova Bracciolini" }
  },
  {
    _id: "il-pino-rosa-canina", slug: "il-pino-rosa-canina", name: "Il Pino Bioagricoltura — Rosa Canina",
    subtype: "apartment", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Il Pino Bioagricoltura — Rosa Canina Terranuova Bracciolini" }
  },
  {
    _id: "il-pino-margherita", slug: "il-pino-margherita", name: "Il Pino Bioagricoltura — Margherita",
    subtype: "apartment", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Il Pino Bioagricoltura — Margherita Terranuova Bracciolini" }
  },
  {
    _id: "il-pino-giglio", slug: "il-pino-giglio", name: "Il Pino Bioagricoltura — Giglio",
    subtype: "apartment", active: true, zone: "terranuova_bracciolini",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Il Pino Bioagricoltura — Giglio Terranuova Bracciolini" }
  },
  {
    _id: "cala-di-seta", slug: "cala-di-seta", name: "Cala di Seta",
    subtype: "apartment", active: true, zone: "cala_di_seta_calasetta",
    location: { it: "Sardegna · Calasetta", en: "Sardinia · Calasetta" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Sardegna · Calasetta", en: "Sardinia · Calasetta" }, q: "Cala di Seta Sardegna" }
  },
  {
    _id: "casa-levante", slug: "casa-levante", name: "Casa Levante",
    subtype: "apartment", active: true, zone: "loro_ciuffenna",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Casa Levante Valdarno Aretino" }
  },
  {
    _id: "casa-ponente", slug: "casa-ponente", name: "Casa Ponente",
    subtype: "apartment", active: true, zone: "loro_ciuffenna",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Casa Ponente Valdarno Aretino" }
  },
  {
    _id: "casa-vacanze-marina", slug: "casa-vacanze-marina", name: "Casa Vacanze Marina",
    subtype: "apartment", active: true, zone: "bucine",
    location: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Aretino · Toscana", en: "Valdarno Aretino · Tuscany" }, q: "Casa Vacanze Marina Valdarno Aretino" }
  },
  {
    _id: "casa-degli-olivi", slug: "casa-degli-olivi", name: "Casa degli Olivi",
    subtype: "villa", active: true, zone: "monte_san_savino",
    location: { it: "Val di Chiana · Toscana", en: "Val di Chiana · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Val di Chiana · Toscana", en: "Val di Chiana · Tuscany" }, q: "Casa degli Olivi Val di Chiana" }
  },
  {
    _id: "corte-gorizia", slug: "corte-gorizia", name: "Corte Gorizia",
    subtype: "villa", active: true, zone: "figline_incisa",
    location: { it: "Valdarno Fiorentino · Toscana", en: "Valdarno Fiorentino · Tuscany" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Valdarno Fiorentino · Toscana", en: "Valdarno Fiorentino · Tuscany" }, q: "Corte Gorizia Valdarno Fiorentino" }
  },
  {
    _id: "la-dimora-dei-glicini", slug: "la-dimora-dei-glicini", name: "La Dimora dei Glicini",
    subtype: "apartment", active: true, zone: "chitignano",
    location: { it: "Arezzo · Casentino", en: "Arezzo · Casentino" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Arezzo · Casentino", en: "Arezzo · Casentino" }, q: "La Dimora dei Glicini Arezzo" }
  },
  {
    _id: "la-dimora-di-giulia", slug: "la-dimora-di-giulia", name: "La Dimora di Giulia",
    subtype: "apartment", active: true, zone: "siena",
    location: { it: "Val d'Elsa · Siena Centro", en: "Val d'Elsa · Siena Centre" },
    welcome_note: null,
    facts: { guests: null, bedrooms: null, bathrooms: null },
    wifi: { network: '', password: '', note: { it: '', en: '' } },
    checkin: { instructions: { it: '', en: '' } },
    checkout: { steps_extra: [] },
    amenities: [], parking: { it: '', en: '' },
    house_rules_extra: [], recommendations_extra: [], contacts_extra: [],
    address: { line: { it: "Val d'Elsa · Siena Centro", en: "Val d'Elsa · Siena Centre" }, q: "La Dimora di Giulia Val d'Elsa" }
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
