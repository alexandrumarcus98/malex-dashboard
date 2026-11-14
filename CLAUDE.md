# CLAUDE.md — malex-dashboard

## Purpose

Private operations dashboard at `https://dashboard.malex.tech` built on **Cloudflare Workers + D1 + Cron Triggers** behind **Cloudflare Access** (`divine-base-c80e.cloudflareaccess.com`). Zero permanent Docker containers or RAM overhead on the Hetzner VPS.

## Guardrails

- Never commit `.env` or echo secret values (`CF_API_TOKEN`, `HEALTHCHECKS_API_KEY`, `INGEST_BEARER_TOKEN`, `CF_ACCESS_CLIENT_SECRET`).
- Keep `LOCAL_DEV_BYPASS` unset in `wrangler.jsonc` production config.
- Exited `jibe-*` dev containers on the VPS are expected when paused for RAM; report counts only, never trigger alerts for stopped `jibe-*` containers.
- Keep `/api/*` responses `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.

## Key Files

- `wrangler.jsonc` — Worker config, D1 binding (`malex-dashboard-db`), 5-min Cron Trigger, Custom Domain `dashboard.malex.tech`.
- `migrations/0001_init.sql` — D1 tables (`probe_samples`, `vps_snapshots`, `incidents`, `cache_kv`).
- `src/auth.ts` — Cloudflare Access JWT & Service Token verification (`jose`) + SHA-256 `timingSafeEqual` Bearer token check.
- `src/cron.ts`, `src/probes.ts`, `src/external.ts` — Edge probes, Healthchecks.io read-only sync, throttled Cloudflare GraphQL Analytics.
- `src/ingest.ts`, `src/api.ts` — Watchdog ingest handler & overview/history query API.
- `public/` — Static operations console UI.
