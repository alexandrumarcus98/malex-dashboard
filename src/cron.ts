import { syncCfAnalytics, syncHealthchecks } from "./external";
import { syncIncidentState } from "./incidents";
import { runEdgeProbes } from "./probes";
import type { Env } from "./types";

/** Execute all periodic edge checks, external syncs, stale-heartbeat detection, and retention cleanup. */
export async function runScheduledTasks(env: Env, nowSec: number, forceAnalytics = false): Promise<void> {
  await runEdgeProbes(env.DB, nowSec);
  await Promise.all([
    syncHealthchecks(env, nowSec),
    syncCfAnalytics(env, nowSec, forceAnalytics),
  ]);

  const latestVps = await env.DB
    .prepare("SELECT created_at FROM vps_snapshots WHERE node_id = 'vps' ORDER BY created_at DESC LIMIT 1")
    .first<{ created_at: number }>();

  if (latestVps) {
    const stale = nowSec - latestVps.created_at > 35 * 60;
    await syncIncidentState(env.DB, {
      source: "vps:heartbeat",
      isHealthy: !stale,
      severity: "warn",
      title: "VPS watchdog heartbeat delayed (>35m)",
      detail: `Last ingest ${Math.round((nowSec - latestVps.created_at) / 60)}m ago`,
      nowSec,
    });
  }

  // Prune raw samples older than 30 days and resolved incidents older than 90 days.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM probe_samples WHERE checked_at < ?").bind(nowSec - 30 * 86400),
    env.DB.prepare("DELETE FROM vps_snapshots WHERE created_at < ?").bind(nowSec - 30 * 86400),
    env.DB.prepare("DELETE FROM incidents WHERE status = 'resolved' AND resolved_at < ?").bind(nowSec - 90 * 86400),
  ]);
}

