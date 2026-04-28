// onboarding/catalog-seed.js
// Catalogo iniziale dei task di onboarding Houzly.
// Eseguito una sola volta dallo script seed.js per popolare onboarding_catalog.
//
// Per modificare la policy di onboarding in futuro:
//  - aggiungi/modifichi qui
//  - re-runni `node onboarding/seed.js --upsert` (idempotente: aggiorna senza duplicare)

const RECIPES_ALL = ['standard', 'agriturismo', 'urbano'];

const CATALOG = [
  // ═══════════════════════════════════════════════════════════════
  // FASE 1 — LEGALE E FISCALE
  // ═══════════════════════════════════════════════════════════════
  {
    _id: 'tsk_firma_contratto',
    name: 'Firma contratto di mandato',
    description: 'Far firmare al proprietario il contratto di mandato Houzly',
    category: 'legale_fiscale',
    parent_id: null,
    order: 10,
    days_before_golive: 30,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
    instructions_md: 'Template contratto in Drive → Houzly/Contratti/Template_Mandato.docx',
  },
  {
    _id: 'tsk_apertura_ltn_lti',
    name: 'Apertura LTN/LTI in Comune',
    description: 'Aprire pratica di locazione turistica al Comune di competenza',
    category: 'legale_fiscale',
    parent_id: null,
    order: 20,
    days_before_golive: 25,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
    instructions_md: 'Per Reggello: portale telematico SUAP. Per Bucine/Pratovecchio: PEC al Comune.',
  },
  {
    _id: 'tsk_richiesta_cin',
    name: 'Richiesta CIN (Codice Identificativo Nazionale)',
    description: 'Richiedere il CIN sul portale BDSR del Ministero del Turismo',
    category: 'legale_fiscale',
    parent_id: null,
    order: 30,
    days_before_golive: 20,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
    instructions_md: 'Portale BDSR. Servono: SCIA comunale, dati catastali, CIR regionale.',
    external_link: 'https://bdsr.ministeroturismo.gov.it',
  },
  {
    _id: 'tsk_credenziali_alloggiati',
    name: 'Credenziali Alloggiati Web (Questura)',
    description: 'Richiedere credenziali al portale Alloggiati della Questura',
    category: 'legale_fiscale',
    parent_id: null,
    order: 40,
    days_before_golive: 18,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
    instructions_md: 'Portale Alloggiati Web → richiesta credenziali. Allegare doc proprietario + SCIA.',
    external_link: 'https://alloggiatiweb.poliziadistato.it',
  },
  {
    _id: 'tsk_iscrizione_imposta_soggiorno',
    name: 'Iscrizione imposta soggiorno (se dovuta)',
    description: 'Iscriversi al portale dell\'imposta di soggiorno del Comune',
    category: 'legale_fiscale',
    parent_id: null,
    order: 50,
    days_before_golive: 15,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
    default_status: 'pending', // valutare se dovuta caso per caso
  },

  // ═══════════════════════════════════════════════════════════════
  // FASE 2 — FOTO E CONTENUTI
  // ═══════════════════════════════════════════════════════════════
  {
    _id: 'tsk_servizio_foto',
    name: 'Servizio fotografico professionale',
    description: 'Realizzare servizio foto interni + esterni',
    category: 'foto',
    parent_id: null,
    order: 100,
    days_before_golive: 20,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_servizio_foto_esterni',
    name: 'Foto esterni in stagione',
    description: 'Foto giardino/piscina/esterni quando la vegetazione è al meglio',
    category: 'foto',
    parent_id: 'tsk_servizio_foto',
    order: 101,
    days_before_golive: -60, // dopo go-live, in primavera
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
    default_status: 'pending',
    is_blocking_parent: false,
  },
  {
    _id: 'tsk_selezione_foto',
    name: 'Selezione e ritocco foto',
    description: 'Scegliere le ~25 foto migliori e fare leggero ritocco colore',
    category: 'foto',
    parent_id: null,
    order: 110,
    days_before_golive: 15,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_descrizione_listing',
    name: 'Stesura descrizione listing (IT + EN)',
    description: 'Titolo, descrizione completa, highlights — bilingue',
    category: 'foto',
    parent_id: null,
    order: 120,
    days_before_golive: 12,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
  },

  // ═══════════════════════════════════════════════════════════════
  // FASE 3 — PUBBLICAZIONE OTA (con sotto-task pre-pubblicazione)
  // ═══════════════════════════════════════════════════════════════
  {
    _id: 'tsk_pubblicazione_airbnb',
    name: 'Pubblicazione su Airbnb',
    description: 'Creare e pubblicare il listing su Airbnb',
    category: 'ota',
    parent_id: null,
    order: 200,
    days_before_golive: 7,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  // Sotto-task Airbnb (CRITICI prima della pubblicazione)
  {
    _id: 'tsk_airbnb_costo_pulizie',
    name: 'Inserire costo pulizie',
    description: 'Configurare il fee di pulizia (vedi anagrafica proprietà per importo)',
    category: 'ota',
    parent_id: 'tsk_pubblicazione_airbnb',
    is_blocking_parent: true,
    order: 201,
    days_before_golive: 8,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_airbnb_costo_biancheria',
    name: 'Inserire costo biancheria',
    description: 'Tipicamente €8/persona — verificare con proprietario',
    category: 'ota',
    parent_id: 'tsk_pubblicazione_airbnb',
    is_blocking_parent: true,
    order: 202,
    days_before_golive: 8,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_airbnb_sconto_settimana',
    name: 'Sconto settimana 7+ giorni (-10%)',
    description: 'Standard Houzly: -10% per soggiorni 7+ notti',
    category: 'ota',
    parent_id: 'tsk_pubblicazione_airbnb',
    is_blocking_parent: true,
    order: 203,
    days_before_golive: 8,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_airbnb_sconto_mese',
    name: 'Sconto mese 28+ giorni (-25%)',
    description: 'Standard Houzly: -25% per soggiorni 28+ notti',
    category: 'ota',
    parent_id: 'tsk_pubblicazione_airbnb',
    is_blocking_parent: true,
    order: 204,
    days_before_golive: 8,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_airbnb_dotazioni',
    name: 'Inserire dotazioni (Wi-Fi, estintore, ecc.)',
    description: 'Wi-Fi obbligatorio. Estintore se installato. Tutte le dotazioni reali.',
    category: 'ota',
    parent_id: 'tsk_pubblicazione_airbnb',
    order: 205,
    days_before_golive: 8,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_airbnb_regole_casa',
    name: 'Regole casa (no smoking, no pets, ecc.)',
    description: 'Copia da template Houzly + personalizza per la proprietà',
    category: 'ota',
    parent_id: 'tsk_pubblicazione_airbnb',
    order: 206,
    days_before_golive: 8,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },

  // Booking.com (stesso pattern)
  {
    _id: 'tsk_pubblicazione_booking',
    name: 'Pubblicazione su Booking.com',
    description: 'Creare e pubblicare la struttura su Booking.com extranet',
    category: 'ota',
    parent_id: null,
    order: 210,
    days_before_golive: 7,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_booking_costo_pulizie',
    name: 'Inserire costo pulizie',
    description: 'Configurare fee pulizia su Booking.com',
    category: 'ota',
    parent_id: 'tsk_pubblicazione_booking',
    is_blocking_parent: true,
    order: 211,
    days_before_golive: 8,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_booking_imposta_soggiorno',
    name: 'Configurare imposta soggiorno (se dovuta)',
    description: 'Inserire importo e modalità di addebito al guest',
    category: 'ota',
    parent_id: 'tsk_pubblicazione_booking',
    is_blocking_parent: true,
    order: 212,
    days_before_golive: 8,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_booking_sconti',
    name: 'Configurare sconti (settimanale/mensile)',
    description: 'Allineare con sconti Airbnb per parity',
    category: 'ota',
    parent_id: 'tsk_pubblicazione_booking',
    is_blocking_parent: true,
    order: 213,
    days_before_golive: 8,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_booking_genius',
    name: 'Aderire al programma Genius',
    description: 'Importante per visibilità — Houzly è Genius partner',
    category: 'ota',
    parent_id: 'tsk_pubblicazione_booking',
    order: 214,
    days_before_golive: 7,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },

  // VRBO (opzionale)
  {
    _id: 'tsk_pubblicazione_vrbo',
    name: 'Pubblicazione su VRBO',
    description: 'Solo per ville e proprietà con target US',
    category: 'ota',
    parent_id: null,
    order: 220,
    days_before_golive: 5,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
    default_status: 'pending', // attivo di default ma facilmente settabile a N/A
  },

  // ═══════════════════════════════════════════════════════════════
  // FASE 4 — TOOLS (Smoobu, PriceLabs, Vikey)
  // ═══════════════════════════════════════════════════════════════
  {
    _id: 'tsk_smoobu_setup',
    name: 'Configurazione Smoobu (channel manager)',
    description: 'Creare apartment, collegare canali, sync calendari',
    category: 'tools',
    parent_id: null,
    order: 300,
    days_before_golive: 6,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_pricelabs_setup',
    name: 'Configurazione PriceLabs',
    description: 'Importare listing in PriceLabs, settare base price e min stay',
    category: 'tools',
    parent_id: null,
    order: 310,
    days_before_golive: 5,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_vikey_setup',
    name: 'Configurazione Vikey (smart access)',
    description: 'Installare/configurare serratura smart e collegare al booking flow',
    category: 'tools',
    parent_id: null,
    order: 320,
    days_before_golive: 4,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
    default_status: 'pending', // non tutte hanno Vikey
  },

  // ═══════════════════════════════════════════════════════════════
  // FASE 5 — MARKETING WEB
  // ═══════════════════════════════════════════════════════════════
  {
    _id: 'tsk_google_my_business',
    name: 'Google My Business',
    description: 'Creare/aggiornare scheda GMB della struttura',
    category: 'marketing',
    parent_id: null,
    order: 400,
    days_before_golive: 3,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_sito_pagina_generale',
    name: 'Pagina proprietà sul sito Houzly',
    description: 'Creare pagina dedicata su houzly.it con foto e descrizione',
    category: 'marketing',
    parent_id: null,
    order: 410,
    days_before_golive: 3,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_sito_pagina_prenotazione',
    name: 'Pagina prenotazione diretta',
    description: 'Configurare booking engine Houzly per la nuova proprietà',
    category: 'marketing',
    parent_id: null,
    order: 420,
    days_before_golive: 2,
    default_assignee: 'romeo',
    recipes: RECIPES_ALL,
  },

  // ═══════════════════════════════════════════════════════════════
  // FASE 6 — OTTIMIZZAZIONE (post go-live)
  // ═══════════════════════════════════════════════════════════════
  {
    _id: 'tsk_ottimizzazione_airbnb',
    name: 'Ottimizzazione listing Airbnb',
    description: 'Revisione titolo, foto, descrizione dopo prime prenotazioni',
    category: 'ottimizzazione',
    parent_id: null,
    order: 500,
    days_before_golive: -30, // 30 gg dopo go-live
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
  },
  {
    _id: 'tsk_ottimizzazione_booking',
    name: 'Ottimizzazione listing Booking',
    description: 'Revisione foto/descrizione/policy dopo prime recensioni',
    category: 'ottimizzazione',
    parent_id: null,
    order: 510,
    days_before_golive: -30,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
  },

  // ═══════════════════════════════════════════════════════════════
  // RICORRENTI (si rigenerano alla scadenza)
  // ═══════════════════════════════════════════════════════════════
  {
    _id: 'tsk_rinnovo_cin_check',
    name: 'Verifica validità CIN (annuale)',
    description: 'Controllare che il CIN sia ancora valido e dati allineati',
    category: 'ricorrente',
    parent_id: null,
    order: 900,
    days_before_golive: -365,
    default_assignee: 'daniele',
    recipes: RECIPES_ALL,
    recurrence: { years: 1 },
  },
];

const RECIPES = [
  {
    _id: 'standard',
    name: 'Standard appartamento/villa',
    description: 'Onboarding base per la maggior parte delle proprietà',
    is_default: true,
  },
  {
    _id: 'agriturismo',
    name: 'Agriturismo',
    description: 'Variante per agriturismi (gestione esterna pulizie, certificazioni)',
    is_default: false,
  },
  {
    _id: 'urbano',
    name: 'Appartamento urbano',
    description: 'Variante per appartamenti in centro città',
    is_default: false,
  },
];

module.exports = { CATALOG, RECIPES };
