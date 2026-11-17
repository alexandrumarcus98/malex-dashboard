# CLAUDE.md — malex-dashboard

## Purpose

Private operations dashboard at `https://dashboard.malex.tech` built on **Cloudflare Workers + D1 + Cron Triggers** behind **Cloudflare Access** (`divine-base-c80e.cloudflareaccess.com`). Zero permanent Docker containers or RAM overhead on the Hetzner VPS.

## Project Skills

Read the matching skill in `.agents/skills/` (mirrored at `.claude/skills/`) when working in that area:
- `dashboard-worker`: Worker auth/audience separation, Cron probes, D1 queries, ingest validation, `azure-probe/`, and Vitest suite.
- `dashboard-ui-ops`: Static console UI (`public/`), strict `style-src 'self'` CSP, security headers, D1 migrations, and Wrangler deploys.

## Guardrails

- Never commit `.env`, `azure-probe/local.settings.json`, or echo secret values (`CF_API_TOKEN`, `CF_ANALYTICS_TOKEN`, `HEALTHCHECKS_API_KEY`, `INGEST_BEARER_TOKEN`, `CF_ACCESS_CLIENT_SECRET`).
- Keep `LOCAL_DEV_BYPASS` unset in `wrangler.jsonc` production config.
- Keep `CF_INGEST_ACCESS_AUD` separate from user `CF_ACCESS_AUD` so user JWTs cannot authenticate machine ingest endpoints.
- Exited `jibe-*` dev containers on the VPS are expected when paused for RAM; report counts only, never trigger alerts for stopped `jibe-*` containers.
- Keep `/api/*` responses `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, and strict security headers (`jsonResponse()`).

## Key Files

- `wrangler.jsonc` — Worker config, D1 binding (`malex-dashboard-db`), 5-min Cron Trigger, Custom Domain `dashboard.malex.tech`, `CF_ACCESS_AUD` & `CF_INGEST_ACCESS_AUD`.
- `migrations/0001_init.sql` — D1 tables (`probe_samples`, `vps_snapshots`, `incidents`, `cache_kv`).
- `src/auth.ts` — Cloudflare Access JWT & Service Token verification (`jose`, strict `CF_INGEST_ACCESS_AUD` separation) + SHA-256 `timingSafeEqual` Bearer token check + security headers.
- `src/cron.ts`, `src/probes.ts`, `src/external.ts` — Edge probes, Healthchecks.io read-only sync, throttled Cloudflare GraphQL Analytics, `35m` stale-heartbeat monitoring for `vps` and `azure-fr`, and 60s manual cron cooldown.
- `src/ingest.ts`, `src/api.ts`, `src/index.ts` — Watchdog/probe ingest handler, overview/history query API, and CSRF-protected `POST /api/cron/run`.
- `azure-probe/` — Azure Functions (`0 */15 * * * *`) remote probe pushing `node_id: "azure-fr"` telemetry.
- `public/` — Static operations console UI with strict `style-src 'self'` CSP in `public/_headers`.
