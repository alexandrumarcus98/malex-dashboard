import { invalidateDashboardCaches } from "./api";
import { readCache, syncCfAnalytics, syncHealthchecks, writeCache } from "./external";
import { syncIncidentState } from "./incidents";
import { getProbeTargets, runEdgeProbes } from "./probes";
import { MANUAL_CRON_COOLDOWN_SEC, NODE_STALE_SEC, type Env } from "./types";

const STALE_MINUTES = Math.round(NODE_STALE_SEC / 60);

function parseHeartbeatLabels(rawJson?: string): Map<string, string> {
  const labels = new Map<string, string>();
  if (!rawJson || !rawJson.trim()) {
    return labels;
  }
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        if (typeof rec.nodeId === "string" && typeof rec.label === "string" && rec.nodeId.trim() && rec.label.trim()) {
          labels.set(rec.nodeId.trim(), rec.label.trim());
        }
      }
    } else if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (k.trim() && typeof v === "string" && v.trim()) {
          labels.set(k.trim(), v.trim());
        }
      }
    }
  } catch {
    // Ignore invalid HEARTBEAT_NODES_JSON override.
  }
  return labels;
}

/** Enforce a cooldown window for manual cron triggers using D1 cache_kv. */
export async function tryAcquireManualCronCooldown(
  db: D1Database,
  nowSec: number,
  cooldownSec = MANUAL_CRON_COOLDOWN_SEC,
): Promise<{ allowed: true } | { allowed: false; retryAfterSec: number }> {
  const existing = await readCache<{ ranAt?: number }>(db, "cron_manual_cooldown");
  if (existing && nowSec >= existing.updatedAt && nowSec - existing.updatedAt < cooldownSec) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, cooldownSec - (nowSec - existing.updatedAt)),
    };
  }
  await writeCache(db, "cron_manual_cooldown", { ranAt: nowSec }, nowSec);
  return { allowed: true };
}

/** Execute all periodic edge checks, external syncs, stale-heartbeat detection, and retention cleanup. */
export async function runScheduledTasks(env: Env, nowSec: number, forceAnalytics = false): Promise<void> {
  const targets = getProbeTargets(env.PROBE_TARGETS_JSON);
  await runEdgeProbes(env.DB, nowSec, targets);
  await Promise.all([
    syncHealthchecks(env, nowSec),
    syncCfAnalytics(env, nowSec, forceAnalytics),
  ]);

  const labelMap = parseHeartbeatLabels(env.HEARTBEAT_NODES_JSON);
  const latestNodes = await env.DB
    .prepare("SELECT node_id, MAX(created_at) AS created_at FROM vps_snapshots GROUP BY node_id")
    .all<{ node_id: string; created_at: number }>();

  for (const row of latestNodes.results ?? []) {
    const stale = nowSec - row.created_at > NODE_STALE_SEC;
    const label = labelMap.get(row.node_id) ?? row.node_id;
    await syncIncidentState(env.DB, {
      source: `${row.node_id}:heartbeat`,
      isHealthy: !stale,
      severity: "warn",
      title: `${label} heartbeat delayed (>${STALE_MINUTES}m)`,
      detail: `Last ingest ${Math.round((nowSec - row.created_at) / 60)}m ago`,
      nowSec,
    });
  }

  // Prune raw samples older than 30 days and resolved incidents older than 90 days.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM probe_samples WHERE checked_at < ?").bind(nowSec - 30 * 86400),
    env.DB.prepare("DELETE FROM vps_snapshots WHERE created_at < ?").bind(nowSec - 30 * 86400),
    env.DB.prepare("DELETE FROM incidents WHERE status = 'resolved' AND resolved_at < ?").bind(nowSec - 90 * 86400),
  ]);

  await invalidateDashboardCaches(env.DB);
}

