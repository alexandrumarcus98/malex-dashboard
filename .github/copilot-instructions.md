# Copilot code review: edge-ops-dashboard

Operations dashboard. Cloudflare Worker (TypeScript) + D1 + Cron Triggers, with a static UI in `public/` (plain ES modules, no bundler), behind Cloudflare Access. One developer, small PRs. Full project rules are in `AGENTS.md`.

## Flag these, most important first

1. **Auth separation.** User routes verify the Access JWT against `CF_ACCESS_AUD`. Ingest routes accept only service tokens for `CF_INGEST_ACCESS_AUD` plus the bearer token, compared in constant time (`timingSafeEqual`). Flag anything that lets a user JWT reach ingest, skips verification, or compares secrets with `===`.
2. **Local bypass.** `LOCAL_DEV_BYPASS` must never be set in `wrangler.jsonc`, and the bypass must stay limited to localhost hosts.
3. **Secrets.** No tokens, `.env` values or `azure-probe/local.settings.json` contents in code, logs, error messages or API responses.
4. **API responses.** Every `/api/*` response goes through `jsonResponse()` (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, security headers). `POST /api/cron/run` keeps its same-origin check and cooldown.
5. **CSP.** `public/_headers` is strict (`script-src 'self'; style-src 'self'`). Flag inline `<script>`, `style="..."` attributes (including inside template strings), `element.style` writes, `eval`/`new Function`, and any third-party host. Widths use the `w-0`…`w-100` classes.
6. **XSS.** The UI builds HTML with template strings. Every API value interpolated into `innerHTML` must go through `esc()`.
7. **Status correctness.** The headline and attention list must never look healthier than the server's `overallStatus` or the open incidents. Incident sources are `probe:<id>`, `watchdog:<node>`, `<node>:heartbeat` and `healthchecks:down`. Thresholds must match the worker (35 min stale heartbeat).
8. **D1.** Parameterized queries only (`prepare().bind()`), never string-built SQL. Schema changes are new files in `migrations/`; never edit an applied migration.
9. **Behaviour changes in `src/`** should come with a test in `tests/`.

Stopped auxiliary containers (`aux_running` / `aux_total`) are informational only. Never treat them as an alert.

## Don't comment on

- Formatting, naming, import order, or "consider adding a comment/JSDoc".
- Adding a framework, bundler or build step to `public/`. Plain modules are deliberate.
- Rewriting working code for style alone.

## How to comment

- Comment only when you can name a concrete failure: this input or state leads to this wrong result. Say so when you're unsure.
- One comment per problem; group repeats of the same issue.
- If nothing important is wrong, say that in one line.
