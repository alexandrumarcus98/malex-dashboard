# malex-dashboard

Serverless operations & monitoring console for `malex.tech` running on **Cloudflare Workers + Static Assets + D1 + Cron Triggers**, gated by **Cloudflare Zero Trust Access** (`$0/month`, `0 MB` steady-state VPS RAM).

## Architecture

- **Frontend (`public/`):** Single-page operations UI served via Worker Assets.
- **Worker (`src/`):**
  - `scheduled()` (`*/5 * * * *`): probes `malex.tech`, `www.malex.tech`, `media.malex.tech/api/health`, syncs Healthchecks.io (read-only API), refreshes Cloudflare GraphQL Analytics (every 15m), detects missed VPS heartbeats, and prunes rows older than 30d.
  - `POST /api/ingest/vps` & `POST /api/ingest/node`: authenticated by Cloudflare Access Service Token (`CF-Access-Client-Id`/`Secret`) + `Bearer` token (`timingSafeEqual`). Receives JSON snapshots pushed from `/home/deploy/infra/scripts/vps-watchdog.sh`.
  - `GET /api/overview`, `GET /api/history`, `POST /api/cron/run`: authenticated by Cloudflare Access user JWT (`cf-access-jwt-assertion`).

## Commands

```bash
npm test
npm run typecheck
npm run db:migrate:remote
npm run deploy
```
