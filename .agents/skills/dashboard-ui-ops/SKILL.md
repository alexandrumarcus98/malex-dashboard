---
name: dashboard-ui-ops
description: Static operations console UI (public/index.html, public/app.js, public/styles.css), strict CSP and security headers (public/_headers, jsonResponse), D1 migrations, and Wrangler deployment for dashboard.malex.tech. Use when editing public/, _headers, or deploying malex-dashboard.
---

# malex-dashboard UI, Headers & Deploy Ops Skill

Follow these rules when updating the static console UI, security headers, or deploying `dashboard.malex.tech`.

## 1. Static Console UI & Strict CSP (`public/`)
- Static assets live in `public/` (`index.html`, `app.js`, `styles.css`, `_headers`) and are served via Worker Assets with `run_worker_first: ["/api/*"]` in `wrangler.jsonc`.
- **Strict `style-src 'self'` CSP (`public/_headers`):** Never introduce inline `style=""` attributes in `public/index.html` or dynamically in `public/app.js`, and never add inline `<script>` blocks. Put styling in classes in `public/styles.css`.
- **API Response Headers (`jsonResponse()`):** Keep `/api/*` responses with `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, and strict security headers.

## 2. Secrets & Deployment Hygiene
- **Never commit or echo secrets:** Covers `.env`, `azure-probe/local.settings.json`, `CF_API_TOKEN`, `CF_ANALYTICS_TOKEN`, `HEALTHCHECKS_API_KEY`, `INGEST_BEARER_TOKEN`, and `CF_ACCESS_CLIENT_SECRET`. Manage Worker secrets via `wrangler secret put`.
- **Deploy Order:** Always run typecheck and tests before `npm run deploy` (`wrangler deploy` only updates the Cloudflare Worker and `public/` assets; deploy `azure-probe/` separately if timer code changed):
  ```bash
  npm run typecheck && npm test
  npm run deploy
  ```
- Note: `dashboard.malex.tech` sits behind Cloudflare Zero Trust Access (`302` redirect to `divine-base-c80e.cloudflareaccess.com` when unauthenticated).

