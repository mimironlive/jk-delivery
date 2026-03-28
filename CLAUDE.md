# JK Delivery — Project Context for Claude Code

## What this app is
A personal delivery route optimisation PWA for Singapore (Lalamove, UParcel, GOGOX jobs).
Deployed at: https://mimironlive.github.io/jk-delivery/
GitHub repo: https://github.com/mimironlive/jk-delivery

## Tech stack
- Vanilla JS / HTML / CSS — no framework, no build step
- OneMap API — free Singapore postal code geocoding (no auth required)
- Leaflet.js + CartoDB tiles — map display
- localStorage — all persistence (jobs, fuel settings, history, API key)
- GitHub Pages — static hosting
- PWA: manifest.json + sw.js service worker
- Cloudflare Worker proxy: https://jk-proxy.jaredkang-drive.workers.dev/
  (CORS proxy forwarding to Anthropic API — needed because browser blocks direct calls)
- Claude Vision (claude-haiku-4-5) — screenshot OCR for auto-filling job form

## Key files
- index.html — app shell, 5 tabs (Next, Jobs, Route, Map, Stats), Settings overlay, scan button
- app.js — all app logic (~1600+ lines)
- style.css — all styles, mobile-first
- sw.js — service worker (bump CACHE version string when deploying changes)
- manifest.json — PWA manifest
- CLAUDE.md — this file

## Cache busting rule
Every deploy: bump `app.js?v=X` in index.html AND bump `const CACHE = 'jkd-vX'` in sw.js together.
Current version: v4

## Job data model
```js
{
  id, contractor, orderType, refNo, pay,
  pickup: { postal, address, lat, lng, twStart, twEnd },
  dropoffs: [{ id, postal, address, lat, lng, dropoffRelative, status }],
  equipment,  // e.g. ["trolley", "food bag"]
  note,
  status      // "pending" | "picked_up" | "delivered"
}
```

## Route optimisation
Nearest-neighbour heuristic with pickup-before-dropoff constraint (PDP).
Time windows enforced during computation.
Dropoff relative windows (Immediate / 1hr / 3hr) calculated from pickup departure time.

## Screenshot scanning (Claude Vision)
User taps scan button → uploads screenshot → base64 → Cloudflare Worker → claude-haiku-4-5.
Prompt uses visual UI fingerprints to identify contractor:
- Lalamove: solid orange header (#F5A623), dotted route line, hollow ○ pickup + ● dropoff, "S$" price, "Slide to Take Order" slider
- UParcel: golden/amber header (#FFBB00), blue "Pickup Details" card + green "Delivery Details" card, "Accept" button, "$" price (no S prefix)
- GOGOX: not yet fingerprinted (catch-all)

## Contractor visual fingerprints (for improving scan prompt)
- Lalamove ✅ fully documented
- UParcel ✅ fully documented
- GOGOX ⬜ pending (need screenshot)

## Batches completed
- Batch 1: Reference number + pay fields
- Batch 2: Full route in Maps/Waze, clipboard detection, same-pickup batch alerts
- Batch 3: Day archive, 7-day history chart, CSV export, revert/undo status
- Scan feature: Claude Vision screenshot OCR with Cloudflare Worker proxy
- Visual fingerprinting: Lalamove + UParcel contractor auto-detection

## Pending / next ideas
- Batch 4: Push notifications / time window alerts
- GOGOX visual fingerprint (need screenshot from user)
- Any other features the user requests

## Deployment
Push to main branch → GitHub Pages auto-deploys.
```
git add <files>
git commit -m "message"
git push
```
User: Jared Kang (jaredkang.drive@gmail.com)
