# Onboarding — Schema MongoDB

Database: `houzly` (esistente)
Tre collezioni nuove, tutte con prefisso `onboarding_`.

---

## 1. `onboarding_catalog`

Catalogo dei task template. Aggiungi/modifichi qui per cambiare la "policy" di onboarding di Houzly.
Un documento per ogni task possibile (madre o figlio).

```js
{
  _id: "tsk_firma_contratto",         // slug stabile, usato come reference
  name: "Firma contratto di mandato",
  description: "Far firmare al proprietario il contratto di mandato Houzly",
  category: "legale_fiscale",         // legale_fiscale | foto | ota | marketing | tools | ottimizzazione | ricorrente
  parent_id: null,                    // null per task madre, slug parent per sotto-task
  is_blocking_parent: false,          // se true, il completamento della madre richiede questo figlio
  order: 10,                          // ordine di visualizzazione dentro la categoria

  // Tempistica relativa al go-live
  days_before_golive: 30,             // negativo = dopo go-live (per ricorrenti)
  default_assignee: "daniele",        // daniele | romeo | unassigned

  // Applicabilità
  recipes: ["standard", "agriturismo", "urbano"],   // ricette in cui appare
  default_status: "pending",          // pending | na (per task opzionali tipo VRBO)

  // Ricorrenza (solo per task ricorrenti tipo "Rinnovo CIN")
  recurrence: null,                   // null | { years: 1 } | { years: 2 }

  // UI hints
  instructions_md: "Stampare contratto da Drive...",   // markdown opzionale
  external_link: "https://drive.google.com/...",       // link rapido opzionale

  // Metadata
  created_at: ISODate,
  updated_at: ISODate,
  archived: false                     // soft-delete: non più applicato a nuove proprietà
}
```

**Indici:** `{category: 1, order: 1}`, `{parent_id: 1}`, `{archived: 1}`

---

## 2. `onboarding_recipes`

Le ricette di onboarding. Pochi documenti (~3-5).

```js
{
  _id: "standard",
  name: "Standard appartamento/villa",
  description: "Onboarding base per appartamenti e ville senza specificità",
  is_default: true,
  created_at: ISODate
}
```

I task associati a una ricetta sono determinati dal campo `recipes[]` nel catalogo (cross-reference).
Vantaggio: aggiungere un task a una ricetta = un update sul catalogo, non sulla ricetta.

---

## 3. `onboarding_instances`

Le istanze. Un documento per ogni task assegnato a una proprietà.
Questa è la collezione che cresce, ma di poco: ~25 documenti per proprietà.

```js
{
  _id: ObjectId,                      // generato da Mongo
  property_id: "PROP034",             // FK alla tua anagrafica proprietà
  property_name: "Casa Vecchia – Milva",  // denormalizzato per display veloce
  task_id: "tsk_firma_contratto",     // FK a onboarding_catalog._id
  parent_instance_id: null,           // null o ObjectId del padre per sotto-task

  // Stato
  status: "done",                     // pending | in_progress | done | na | blocked
  completed_at: ISODate,              // null se non completato
  completed_by: "daniele",

  // Date
  target_date: ISODate,               // calcolata da go_live_target - days_before_golive
  go_live_target: ISODate,            // ridondante ma utile per ricalcoli quando il go-live cambia

  // Override per istanza (opzionale, se diverso dal catalog)
  override_assignee: null,            // null = usa default_assignee dal catalogo
  custom_subtask: false,              // true se aggiunto solo a questa proprietà, non da catalogo

  // Dati raccolti durante la task
  notes: "CIN ricevuto: IT051030C2KZJ4LK7Z",
  attachments: [],                    // array di {name, url} per ora vuoto

  // Notifiche
  reminded_7d: false,                 // flag idempotenza notifiche
  reminded_overdue: false,

  // Metadata
  created_at: ISODate,
  updated_at: ISODate
}
```

**Indici:**
- `{property_id: 1, task_id: 1}` (lookup veloce singolo task)
- `{property_id: 1}` (tutti i task di una proprietà)
- `{status: 1, target_date: 1}` (cron job notifiche)
- `{parent_instance_id: 1}` (sotto-task di una madre)

---

## Stima dimensioni

- catalog: ~30 documenti × 600 byte ≈ **18 KB**
- recipes: ~3 documenti × 200 byte ≈ **600 byte**
- instances: 33 proprietà × 25 task × 400 byte ≈ **330 KB**

**Totale: ~350 KB.** M0 Atlas (512 MB) è usato allo 0.07%.
A 200 proprietà siamo a ~2 MB, lo 0.4%.
