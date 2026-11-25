# Edge Ops Dashboard

Serverless operations & monitoring console running on **Cloudflare Workers + Static Assets + D1 + Cron Triggers**, gated by **Cloudflare Zero Trust Access** (`$0/month`, zero steady-state host RAM overhead).

## Architecture

- **Frontend (`public/`):** Single-page operations UI served via Worker Assets.
- **Worker (`src/`):**
  - `scheduled()` (`*/5 * * * *`): probes endpoints configured via `PROBE_TARGETS_JSON`, syncs Healthchecks.io (read-only API), optionally refreshes Cloudflare GraphQL Analytics (every 15m when `CF_ZONE_ID` and `CF_ANALYTICS_TOKEN` are set), detects stale node heartbeats (`>35m`), and prunes rows older than 30d.
  - `POST /api/ingest/vps` & `POST /api/ingest/node`: authenticated by Cloudflare Access Service Token (`CF-Access-Client-Id`/`Secret`) + `Bearer` token (`timingSafeEqual`). Receives JSON snapshots from host watchdogs or remote probes (`azure-probe/`).
  - `GET /api/overview`, `GET /api/history`, `GET /api/db/tables`, `GET /api/incidents`, `POST /api/cron/run`: authenticated by Cloudflare Access user JWT (`cf-access-jwt-assertion`).

## Setup

1. Copy `wrangler.example.jsonc` to `wrangler.jsonc` (gitignored) and fill in your domain, D1 `database_id`, and `CF_ACCESS_TEAM_DOMAIN`.
2. Set secrets via `wrangler secret put`: `CF_ACCESS_AUD`, `CF_INGEST_ACCESS_AUD`, `INGEST_BEARER_TOKEN`, and optionally `HEALTHCHECKS_API_KEY`, `CF_ANALYTICS_TOKEN`.
3. Optionally configure `DASHBOARD_NAME`, `PRIMARY_NODE_ID`, `PROBE_TARGETS_JSON`, `DASHBOARD_LINKS_JSON`, `HEARTBEAT_NODES_JSON`, `AUX_CONTAINERS_LABEL`, and `BACKUP_LABELS_JSON` in `wrangler.jsonc` `vars`.

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm db:migrate:remote
pnpm deploy
```
