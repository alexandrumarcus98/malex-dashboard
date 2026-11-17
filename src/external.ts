import { syncIncidentState } from "./incidents";
import type { CfDayPoint, Env, HealthcheckItem } from "./types";

export async function writeCache(db: D1Database, key: string, value: unknown, nowSec: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO cache_kv (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    )
    .bind(key, JSON.stringify(value), nowSec)
    .run();
}

export async function readCache<T>(db: D1Database, key: string): Promise<{ value: T; updatedAt: number } | null> {
  const row = await db
    .prepare("SELECT value_json, updated_at FROM cache_kv WHERE key = ?")
    .bind(key)
    .first<{ value_json: string; updated_at: number }>();
  if (!row) {
    return null;
  }
  try {
    return { value: JSON.parse(row.value_json) as T, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

/** Refresh Healthchecks.io check statuses (read-only API key) and cache into D1. */
export async function syncHealthchecks(env: Env, nowSec: number): Promise<void> {
  if (!env.HEALTHCHECKS_API_KEY) {
    return;
  }
  try {
    const resp = await fetch("https://healthchecks.io/api/v3/checks/", {
      headers: { "X-Api-Key": env.HEALTHCHECKS_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      console.warn(`syncHealthchecks HTTP ${resp.status}`);
      await resp.body?.cancel();
      return;
    }
    const data = (await resp.json()) as { checks?: Array<Record<string, unknown>> };
    const checks: HealthcheckItem[] = (data.checks ?? []).map((c) => ({
      name: String(c.name ?? "unnamed"),
      slug: String(c.slug ?? ""),
      status: String(c.status ?? "unknown"),
      lastPing: typeof c.last_ping === "string" ? c.last_ping : null,
      nextPing: typeof c.next_ping === "string" ? c.next_ping : null,
      nPings: typeof c.n_pings === "number" ? c.n_pings : 0,
      graceSec: typeof c.grace === "number" ? c.grace : 0,
    }));
    await writeCache(env.DB, "healthchecks", checks, nowSec);

    const downChecks = checks.filter((c) => c.status === "down");
    await syncIncidentState(env.DB, {
      source: "healthchecks:down",
      isHealthy: downChecks.length === 0,
      severity: "critical",
      title: `Healthchecks down: ${downChecks.map((c) => c.name).join(", ")}`,
      detail: downChecks.map((c) => `${c.name} last ping ${c.lastPing ?? "never"}`).join("; ") || null,
      nowSec,
    });
  } catch (err) {
    // Non-fatal: keep last cached Healthchecks snapshot on transient fetch issues.
    console.error("syncHealthchecks failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Refresh 7-day Cloudflare HTTP Analytics via GraphQL at most once every 15 minutes. */
export async function syncCfAnalytics(env: Env, nowSec: number, force = false): Promise<void> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ZONE_ID) {
    return;
  }
  if (!force) {
    const existing = await readCache<CfDayPoint[]>(env.DB, "cf_analytics");
    if (existing && nowSec - existing.updatedAt < 840) {
      return;
    }
  }

  const end = new Date(nowSec * 1000);
  const start = new Date((nowSec - 7 * 86400) * 1000);
  const dateGeq = start.toISOString().slice(0, 10);
  const dateLeq = end.toISOString().slice(0, 10);

  const query = `query ($zoneTag: String!, $dateGeq: Date!, $dateLeq: Date!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequests1dGroups(limit: 10, orderBy: [date_ASC], filter: { date_geq: $dateGeq, date_leq: $dateLeq }) {
          dimensions { date }
          sum { requests cachedRequests bytes threats pageViews }
        }
      }
    }
  }`;

  try {
    const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { zoneTag: env.CF_ZONE_ID, dateGeq, dateLeq },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      console.warn(`syncCfAnalytics HTTP ${resp.status}`);
      await resp.body?.cancel();
      return;
    }
    const payload = (await resp.json()) as {
      errors?: Array<{ message?: string }>;
      data?: {
        viewer?: {
          zones?: Array<{
            httpRequests1dGroups?: Array<{
              dimensions: { date: string };
              sum: { requests: number; cachedRequests: number; bytes: number; threats: number; pageViews: number };
            }>;
          }>;
        };
      } | null;
    };
    if (payload.errors?.length || !payload.data) {
      const msg = payload.errors?.map((e) => e.message ?? "GraphQL error").join("; ") || "missing data";
      console.warn(`syncCfAnalytics GraphQL error: ${msg}`);
      return;
    }
    const groups = payload.data.viewer?.zones?.[0]?.httpRequests1dGroups;
    if (!Array.isArray(groups)) {
      console.warn("syncCfAnalytics missing httpRequests1dGroups");
      return;
    }
    const points: CfDayPoint[] = groups.map((g) => ({
      date: g.dimensions.date,
      requests: g.sum.requests ?? 0,
      cachedRequests: g.sum.cachedRequests ?? 0,
      bytes: g.sum.bytes ?? 0,
      threats: g.sum.threats ?? 0,
      pageViews: g.sum.pageViews ?? 0,
    }));
    await writeCache(env.DB, "cf_analytics", points, nowSec);
  } catch (err) {
    // Non-fatal: keep last cached analytics points.
    console.error("syncCfAnalytics failed:", err instanceof Error ? err.message : String(err));
  }
}

