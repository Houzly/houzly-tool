# Houzly Billing — Server

Backend condiviso per Houzly Billing. Permette a più utenti di accedere agli stessi dati da qualsiasi browser.

## Deploy su Render (gratuito)

### PASSO 1 — Carica su GitHub

1. Vai su https://github.com → **New repository**
2. Nome: `houzly-billing` → **Create repository**
3. Carica questi file (drag & drop nella pagina GitHub):
   - `server.js`
   - `package.json`
   - `render.yaml`
   - `.gitignore`
   - La cartella `public/` con `index.html` dentro

### PASSO 2 — Deploy su Render

1. Vai su https://render.com → **New** → **Web Service**
2. Collega il tuo account GitHub
3. Seleziona il repository `houzly-billing`
4. Render legge automaticamente `render.yaml` e configura tutto
5. Clicca **Deploy** → aspetta 2-3 minuti
6. Render ti dà un URL tipo: `https://houzly-billing-xxxx.onrender.com`

### PASSO 3 — Prima configurazione

1. Apri l'URL sul browser
2. Ti chiede di impostare la password → inserisci la password che vuoi
3. La password vale per tutti gli utenti (tu e il socio)
4. Condividi l'URL con il socio → apre lo stesso URL, inserisce la stessa password → vede tutti i dati

### PASSO 4 — Migra i dati esistenti

1. Apri la **vecchia versione** HTML dal tuo PC
2. Clicca **💾 Backup** → scarica il JSON
3. Apri il nuovo URL su Render
4. Clicca **📌 Ripristina** → carica il JSON scaricato
5. Tutti i dati sono ora sul server

## Note

- Il piano **free** di Render va in sleep dopo 15 minuti di inattività → primo caricamento richiede ~30 secondi
- Per eliminare il delay di startup, upgrade a piano Starter ($7/mese)
- I dati sono salvati in `data/db.json` sul server
- Render non cancella i file tra un deploy e l'altro (persistent disk)

