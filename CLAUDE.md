# POS Availability Toggle

## Project Overview

A Cloudflare Worker that toggles a PLU item (a daily special) between available and unavailable in the Redcat/Polygon POS system by managing its offline rule. A nightly Cloudflare Cron Trigger automatically re-offlines all stores at midnight.

**Deployment model:** A single Cloudflare Worker handles all stores. Each POS has a management button that opens the store picker URL. No executables, no credentials on POS machines.

**Re-offline model:** A Cloudflare Cron Trigger runs at midnight local time and cycles DELETE→INSERT offline rules for all stores. Can also be triggered manually via `/admin/reoffline?key=ADMIN_KEY`.

## Store Map (demo)

| Store ID | Name |
|---|---|
| 2 | Test HQ (hidden from store picker) |
| 8 | Riverside |
| 42 | Highland |
| 56 | Southport |
| ... | (more in `worker.js`) |

## Confirmed API Details (Redcat Polygon)

**Base URL:** `https://<tenant>.redcatcloud.com.au/api/v1`

- **Auth:** `POST /login` with `{ "username": "...", "psw": "...", "auth_type": "U" }` → returns `{ "token": "..." }` → use via `X-Redcat-Authtoken` header
- **Create rule:** `POST /pluavailabilityrules` with `{ "Action": "INSERT", "StoreID": <id>, "PLUCode": <code>, "Reason": "Out of Stock", "ExportMenus": true }` → returns `{ "data": [{ "ID": ... }] }`
- **Delete rule:** `HTTP DELETE /pluavailabilityrules` with body `{ "IDs": [<id>], "ExportMenus": true }`

## Architecture Decisions

- **INSERT before DELETE:** The API doesn't have a direct GET for existing rule IDs. INSERT on an existing rule returns the same ID without duplicating, so we INSERT to resolve the ID then DELETE it.
- **Centralized re-offline via Cloudflare Cron:** A cron trigger runs at midnight local time and cycles DELETE→INSERT for every store. The cycle is needed because a plain INSERT on an existing rule does not trigger a menu export to third-party platforms (Uber Eats etc). The delete-then-recreate forces the export.
- **Confirmation page:** GET `/toggle/:storeId` shows a confirmation page with "Yes, Make Available" and "Back" buttons. Only POST (clicking the button) triggers the actual toggle. Prevents accidental activation.
- **Store picker:** GET `/toggle` shows a list of stores. One POS button for all stores - staff select their store from the list.
- **Rate limiting:** 5-minute cooldown per store after toggling. Uses KV with auto-expiring keys.
- **Audit logging:** Every toggle and cron event is logged to KV with timestamp, store, IP, and success/failure. Logs kept for 90 days.
- **Teams notifications:** Store toggles and cron failures post to a Microsoft Teams channel via incoming webhook. URL stored as Worker secret.
- **Credentials in Cloudflare Secrets:** `REDCAT_USERNAME`, `REDCAT_PASSWORD`, `ADMIN_KEY`, `TEAMS_WEBHOOK` are stored as encrypted Cloudflare Worker secrets, never in code.
- **No exe, no Python on POS:** POS machines just need a browser shortcut. No installers, no antivirus issues, no per-store rebuilds.

## Cloudflare Worker Setup

### Secrets (set via `wrangler secret put`)

- `REDCAT_USERNAME` - API username
- `REDCAT_PASSWORD` - API password
- `ADMIN_KEY` - Password for admin routes
- `TEAMS_WEBHOOK` - Microsoft Teams incoming webhook URL

### KV Namespace

- `AUDIT_LOG` - Stores audit log entries, rate-limit cooldowns, and the logo image

### Routes

- **POS button (store picker):** `/toggle`
- **Direct store toggle:** `/toggle/:storeId` (GET = confirm, POST = execute)
- **Manual re-offline:** `/admin/reoffline?key=ADMIN_KEY`
- **Audit logs:** `/admin/logs?key=ADMIN_KEY`
- **Logo:** `/logo.png` (served from KV)
- **Cron:** Runs automatically at `0 14 * * *` UTC (midnight AEST)

### Deployment

```bash
cd cloudflare-worker
npx wrangler deploy
```

### Adding a new store

1. Add the store ID and name to the `STORES` object in `cloudflare-worker/src/worker.js`
2. Deploy with `npx wrangler deploy`
3. The POS button already points to `/toggle` - new store appears automatically in the picker

### Updating the logo

```bash
npx wrangler kv key put --namespace-id=<YOUR_KV_ID> "logo.png" --path="./logo.png"
```

## Teams Notifications

An incoming webhook posts to a Microsoft Teams channel for:

- **Store toggle** - green card when a store makes the item available, includes store name
- **Cron partial failure** - red card listing which stores failed, with link to audit logs
- **Cron total failure** - red card with error details and link to manually trigger re-offline

Webhook URL is stored as a Worker secret (`TEAMS_WEBHOOK`).

## UI Features

- **Syne font** for headings via Google Fonts, system-ui for body
- **Branded logo** with floating animation, served from KV
- **Dark premium theme** with radial gradients, noise texture overlay, amber/orange brand accents
- **Touchscreen optimised:** 56px min-height buttons, touch-action manipulation, no tap highlight
- **Responsive:** Card max-width 420px with 16px horizontal margin, reduced padding at 480px
- **Entrance animations:** Card fade-in with translateY, staggered store button animations
- **Inline toggle:** Clicking "Yes, Make Available" shows a spinner then transitions to success/error state without page reload
- **Close flow:** Close buttons navigate to `/closed` - a branded "All done!" page

## Known Gotchas

- **Indefinite offline rule:** The re-offline rule has no `EndDate` - the item stays offline until the button is pressed again. This is intentional.
- **Midnight AEST targeting:** The cron runs at 2 PM UTC (midnight AEST). During AEDT (summer), this is 1 AM local - still fine since stores are closed.
- **Double press:** Rate limited to once per 5 minutes per store. Shows "Already Active" message.
- **Test HQ:** Store 2 is in STORES (for cron re-offline and direct URL access) but hidden from the store picker via filter.
- **Cloudflare free tier limits:** 100k requests/day, 1k KV writes/day, 30s CPU time - well within limits for this workload.

## Files

| File | Purpose |
|---|---|
| `cloudflare-worker/src/worker.js` | Cloudflare Worker - all routes, API logic, cron handler, audit logging |
| `cloudflare-worker/wrangler.toml` | Wrangler config - worker name, KV binding, cron schedule |
| `cloudflare-worker/package.json` | Node dependencies (wrangler) |
| `cloudflare-worker/.dev.vars` | Local dev secrets (not deployed, gitignored) |
| `logo.png` / `logo-256.png` | Brand logo (full-res + 256px web-optimised, embedded in worker.js as a fallback) |
| `screenshots/` | UI screenshots |
| `README.md` | Public-facing project overview |
| `CLAUDE.md` | This file - project documentation for Claude Code sessions |
