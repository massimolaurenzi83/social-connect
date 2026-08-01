# Social Connect

Web app (PWA) che aggrega contenuti e notifiche da più piattaforme social e fonti di informazione in un'unica vista per categorie, con interfaccia in stile Amazon Fire TV.

## Caratteristiche

- **Home stile Fire TV**: tema scuro, riga piattaforme, hero in evidenza, righe orizzontali per categoria
- **Feed aggregato** da fonti reali: RSS/news italiane, YouTube, Reddit, Bluesky, Mastodon
- **Tre livelli di integrazione piattaforme**:
  - Livello 1 — feed completo dentro l'app (YouTube, Reddit, Bluesky, Mastodon, RSS)
  - Livello 2 — post pubblici incorporati (Instagram, Facebook, X, TikTok)
  - Livello 3 — tile launcher con deep-link all'app nativa (tutte)
- **Onboarding per argomenti**: scegli le categorie, il feed è subito pronto (nessun login richiesto)
- **Centro notifiche unificato** per i nuovi contenuti delle fonti seguite
- **Blocco app biometrico** opzionale (WebAuthn / passkey)
- **Multilingua** (italiano/inglese), predisposta per altre lingue
- **PWA installabile** su smartphone
- **Zero backend**: hosting su GitHub Pages, aggregazione automatica dei feed via GitHub Actions

## Architettura

```
index.html            App single-page
css/style.css         Stili (mobile-first, tema scuro Fire TV)
js/                   Logica applicativa (vanilla JS, nessuna build)
data/catalog.json     Catalogo curato di fonti per categoria
data/feeds/*.json     Feed aggregati (generati da tools/aggregate.ps1)
i18n/*.json           Traduzioni interfaccia
tools/aggregate.ps1   Aggregatore feed (PowerShell, gira in locale e in CI)
tools/serve.ps1       Server statico locale per lo sviluppo
.github/workflows/    Aggiornamento automatico dei feed ogni 30 minuti
```

## Sviluppo locale

```powershell
powershell -ExecutionPolicy Bypass -File tools/serve.ps1   # http://localhost:8090
powershell -ExecutionPolicy Bypass -File tools/aggregate.ps1   # rigenera data/feeds
```

## Deploy

Push su GitHub → attivare GitHub Pages sul branch `main` → il workflow `aggregate.yml` aggiorna i feed ogni 30 minuti.

## Roadmap

1. **MVP attuale**: aggregatore per categorie, launcher piattaforme, notifiche in-app, PWA
2. Account utente + sincronizzazione preferenze (backend serverless)
3. Collegamento account personali via OAuth (YouTube, Reddit, ...) — feed personali
4. Pubblicità nativa (tile sponsorizzate)
5. App nativa Android con notifiche di sistema unificate (accesso notifiche)
