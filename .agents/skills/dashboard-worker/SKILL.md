---
name: dashboard-worker
description: Cloudflare Worker backend, D1 schema/queries, Cloudflare Access JWT + Service Token separation (CF_ACCESS_AUD vs CF_INGEST_ACCESS_AUD), timing-safe Bearer ingest auth, 5-min Cron probes, 35m stale heartbeat detection, azure-probe timer function, and Vitest unit tests. Use when editing src/, migrations/, wrangler.jsonc, or azure-probe/ in malex-dashboard.
---

# malex-dashboard Worker & Probe Skill

Follow these conventions when modifying Worker endpoints, D1 queries, cron jobs, or the Azure Functions remote probe.

## 1. Strict Audience & Auth Separation (`src/auth.ts`, `wrangler.jsonc`)
- **Separate Access Audiences:** Keep `CF_ACCESS_AUD` (human UI routes: `/api/overview`, `/api/history`, `POST /api/cron/run`) strictly separate from `CF_INGEST_ACCESS_AUD` (machine ingest routes: `POST /api/ingest/vps`, `POST /api/ingest/node`). User JWTs must never authenticate machine ingest endpoints.
- **Timing-Safe Bearer Check:** Machine ingest additionally verifies `Authorization: Bearer ...` using SHA-256 + `timingSafeEqual` against `INGEST_BEARER_TOKEN`.
- **Production Guardrail:** Keep `LOCAL_DEV_BYPASS` unset in `wrangler.jsonc` production config.

## 2. Cron, Edge Probes & Ingest (`src/cron.ts`, `src/probes.ts`, `src/external.ts`, `src/ingest.ts`, `src/api.ts`)
- **5-Min Cron (`*/5 * * * *`):** Probes `malex.tech`, `www.malex.tech`, and `media.malex.tech/api/health`, syncs Healthchecks.io (read-only), refreshes Cloudflare GraphQL Analytics (throttled to 15m), flags stale heartbeats after `35m` for `vps` and `azure-fr`, and prunes rows older than 30d.
- **Manual Cron & CSRF:** `POST /api/cron/run` is CSRF-protected and enforces a 60s cooldown.
- **Jibe Container Counts:** Stopped `jibe-*` dev containers on the VPS are normal when paused to save RAM. Store/render `jibe_running` and `jibe_total` as informational counts only; never trigger incidents or alerts for stopped `jibe-*` containers.
- **D1 Migrations:** Schema lives in `migrations/0001_init.sql` (`probe_samples`, `vps_snapshots`, `incidents`, `cache_kv`). Apply remote migrations with `npm run db:migrate:remote` before deploying schema-dependent code.

## 3. Azure Functions Remote Probe (`azure-probe/`)
- Keep probe logic pure and testable in `azure-probe/src/probeLogic.js` (`runProbeAndPush`, typed via `azure-probe/src/probeLogic.d.ts`), wired by `azure-probe/src/functions/probeTimer.js` (`0 */15 * * * *`).
- Never commit `azure-probe/local.settings.json`. Cover probe changes in `tests/azure-probe.test.ts`.

## 4. Verification
```bash
npm run typecheck && npm test
npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry-run && rm -rf /tmp/wrangler-dry-run
```

