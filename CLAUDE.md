# CLAUDE.md — Edge Ops Dashboard

## Purpose

Generic operations dashboard (`https://ops.example.com`) built on **Cloudflare Workers + D1 + Cron Triggers** behind **Cloudflare Access**. Zero permanent host containers or steady-state RAM overhead.

## Project Skills

Read the matching skill in `.agents/skills/` (mirrored at `.claude/skills/`) when working in that area:
- `dashboard-worker`: Worker auth/audience separation, Cron probes, D1 queries, ingest validation, `azure-probe/`, and Vitest suite.
- `dashboard-ui-ops`: Static console UI (`public/`), strict `style-src 'self'` CSP, security headers, D1 migrations, and Wrangler deploys.

## Guardrails

- Never commit `.env`, `.dev.vars`, `wrangler.jsonc`, `azure-probe/local.settings.json`, or echo secret values (`CF_API_TOKEN`, `CF_ANALYTICS_TOKEN`, `HEALTHCHECKS_API_KEY`, `INGEST_BEARER_TOKEN`, `CF_ACCESS_CLIENT_SECRET`, `CF_ACCESS_AUD`, `CF_INGEST_ACCESS_AUD`).
- Keep `LOCAL_DEV_BYPASS` unset in `wrangler.jsonc` production config.
- Keep `CF_INGEST_ACCESS_AUD` separate from user `CF_ACCESS_AUD` so user JWTs cannot authenticate machine ingest endpoints.
- Auxiliary stopped containers (`aux_running` / `aux_total`) are informational only; never trigger alerts for paused auxiliary containers.
- Keep `/api/*` responses `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, and strict security headers (`jsonResponse()`).

## Key Files

- `wrangler.example.jsonc` — Template Worker config (copy to gitignored `wrangler.jsonc`), D1 binding (`DB`), 5-min Cron Trigger, Custom Domain placeholder, and optional `vars` (`PROBE_TARGETS_JSON`, `DASHBOARD_NAME`, etc.).
- `migrations/0001_init.sql` — D1 tables (`probe_samples`, `vps_snapshots`, `incidents`, `cache_kv`).
- `src/auth.ts` — Cloudflare Access JWT & Service Token verification (`jose`, strict `CF_INGEST_ACCESS_AUD` separation) + SHA-256 `timingSafeEqual` Bearer token check + security headers.
- `src/cron.ts`, `src/probes.ts`, `src/external.ts` — Configurable edge probes (`PROBE_TARGETS_JSON`), Healthchecks.io read-only sync, throttled Cloudflare GraphQL Analytics, `35m` stale-heartbeat monitoring across active nodes, and 60s manual cron cooldown.
- `src/ingest.ts`, `src/api.ts`, `src/index.ts` — Watchdog/probe ingest handler, overview/history query API, and CSRF-protected `POST /api/cron/run`.
- `azure-probe/` — Azure Functions (`0 */15 * * * *`) remote probe pushing `PROBE_NODE_ID` (default `remote-probe`) telemetry.
- `public/` — Static operations console UI with strict `style-src 'self'` CSP in `public/_headers`.
