import { readCache, syncCfAnalytics, syncHealthchecks, writeCache } from "./external";
import { syncIncidentState } from "./incidents";
import { runEdgeProbes } from "./probes";
import { MANUAL_CRON_COOLDOWN_SEC, NODE_STALE_SEC, type Env } from "./types";

const HEARTBEAT_NODES = [
  { nodeId: "vps", label: "VPS watchdog" },
  { nodeId: "azure-fr", label: "azure-fr probe" },
] as const;

const STALE_MINUTES = Math.round(NODE_STALE_SEC / 60);

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
  await runEdgeProbes(env.DB, nowSec);
  await Promise.all([
    syncHealthchecks(env, nowSec),
    syncCfAnalytics(env, nowSec, forceAnalytics),
  ]);

  for (const node of HEARTBEAT_NODES) {
    const latest = await env.DB
      .prepare("SELECT created_at FROM vps_snapshots WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .bind(node.nodeId)
      .first<{ created_at: number }>();

    if (latest) {
      const stale = nowSec - latest.created_at > NODE_STALE_SEC;
      await syncIncidentState(env.DB, {
        source: `${node.nodeId}:heartbeat`,
        isHealthy: !stale,
        severity: "warn",
        title: `${node.label} heartbeat delayed (>${STALE_MINUTES}m)`,
        detail: `Last ingest ${Math.round((nowSec - latest.created_at) / 60)}m ago`,
        nowSec,
      });
    }
  }

  // Prune raw samples older than 30 days and resolved incidents older than 90 days.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM probe_samples WHERE checked_at < ?").bind(nowSec - 30 * 86400),
    env.DB.prepare("DELETE FROM vps_snapshots WHERE created_at < ?").bind(nowSec - 30 * 86400),
    env.DB.prepare("DELETE FROM incidents WHERE status = 'resolved' AND resolved_at < ?").bind(nowSec - 90 * 86400),
  ]);
}

