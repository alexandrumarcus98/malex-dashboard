import { readCache } from "./external";
import { PROBE_TARGETS } from "./probes";
import type { CfDayPoint, Env, HealthcheckItem, IncidentRow } from "./types";

interface VpsSnapshotRow {
  id: number;
  node_id: string;
  status: string;
  disk_pct: number | null;
  mem_avail_mb: number | null;
  mem_total_mb: number | null;
  swap_used_pct: number | null;
  swap_used_mb: number | null;
  restic_age_h: number | null;
  muuvies_age_h: number | null;
  seedbox_sync_age_h: number | null;
  containers_json: string | null;
  jibe_running: number | null;
  jibe_total: number | null;
  ports_json: string | null;
  summary: string | null;
  created_at: number;
}

interface ProbeRow {
  target: string;
  ok: number;
  status_code: number;
  latency_ms: number;
  detail_json: string | null;
  error: string | null;
  checked_at: number;
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Build the dashboard overview response used by the UI. */
export async function getOverview(env: Env, userEmail: string, nowSec: number): Promise<Record<string, unknown>> {
  const since24h = nowSec - 86400;
  const since7d = nowSec - 7 * 86400;

  const [vpsRowsRes, probeStatsRes, recentProbesRes, incidentsRes, hcCache, cfCache] = await Promise.all([
    env.DB.prepare(
      `SELECT v.* FROM vps_snapshots v
       INNER JOIN (SELECT node_id, MAX(created_at) AS max_ts FROM vps_snapshots GROUP BY node_id) latest
       ON v.node_id = latest.node_id AND v.created_at = latest.max_ts
       ORDER BY CASE WHEN v.node_id = 'vps' THEN 0 ELSE 1 END, v.node_id ASC`,
    ).all<VpsSnapshotRow>(),
    env.DB.prepare(
      `SELECT
        target,
        COUNT(*) AS total_7d,
        SUM(ok) AS ok_7d,
        SUM(CASE WHEN checked_at >= ? THEN 1 ELSE 0 END) AS total_24h,
        SUM(CASE WHEN checked_at >= ? THEN ok ELSE 0 END) AS ok_24h,
        ROUND(AVG(CASE WHEN checked_at >= ? THEN latency_ms ELSE NULL END)) AS avg_ms_24h
       FROM probe_samples
       WHERE checked_at >= ?
       GROUP BY target`,
    )
      .bind(since24h, since24h, since24h, since7d)
      .all<{
        target: string;
        total_7d: number;
        ok_7d: number;
        total_24h: number;
        ok_24h: number;
        avg_ms_24h: number | null;
      }>(),
    env.DB.prepare(
      `SELECT target, ok, status_code, latency_ms, detail_json, error, checked_at
       FROM probe_samples
       WHERE checked_at >= ?
       ORDER BY checked_at DESC
       LIMIT 300`,
    )
      .bind(since24h)
      .all<ProbeRow>(),
    env.DB.prepare("SELECT * FROM incidents ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, opened_at DESC LIMIT 20").all<IncidentRow>(),
    readCache<HealthcheckItem[]>(env.DB, "healthchecks"),
    readCache<CfDayPoint[]>(env.DB, "cf_analytics"),
  ]);

  const statsMap = new Map(probeStatsRes.results.map((s) => [s.target, s]));
  const probesByTarget = new Map<string, ProbeRow[]>();
  for (const row of recentProbesRes.results) {
    const list = probesByTarget.get(row.target) ?? [];
    list.push(row);
    probesByTarget.set(row.target, list);
  }

  const probes = PROBE_TARGETS.map((target) => {
    const samples = probesByTarget.get(target.id) ?? [];
    const latest = samples[0] ?? null;
    const stats = statsMap.get(target.id);
    const uptime24h =
      stats && stats.total_24h > 0 ? Number(((stats.ok_24h / stats.total_24h) * 100).toFixed(2)) : null;
    const uptime7d =
      stats && stats.total_7d > 0 ? Number(((stats.ok_7d / stats.total_7d) * 100).toFixed(2)) : null;

    return {
      id: target.id,
      label: target.label,
      url: target.url,
      latest: latest
        ? {
            ok: latest.ok === 1,
            statusCode: latest.status_code,
            latencyMs: latest.latency_ms,
            detail: safeJsonParse<Record<string, unknown> | null>(latest.detail_json, null),
            error: latest.error,
            checkedAt: latest.checked_at,
          }
        : null,
      uptime24h,
      uptime7d,
      avgMs24h: stats?.avg_ms_24h ?? null,
      recentSeries: samples
        .slice(0, 36)
        .reverse()
        .map((s) => ({ t: s.checked_at, ms: s.latency_ms, ok: s.ok === 1 })),
    };
  });

  const nodes = vpsRowsRes.results.map((r) => ({
    nodeId: r.node_id,
    status: r.status,
    stale: nowSec - r.created_at > 25 * 60,
    ageMinutes: Math.max(0, Math.round((nowSec - r.created_at) / 60)),
    diskPct: r.disk_pct,
    memAvailMb: r.mem_avail_mb,
    memTotalMb: r.mem_total_mb,
    swapUsedPct: r.swap_used_pct,
    swapUsedMb: r.swap_used_mb,
    resticAgeH: r.restic_age_h,
    muuviesAgeH: r.muuvies_age_h,
    seedboxSyncAgeH: r.seedbox_sync_age_h,
    containers: safeJsonParse(r.containers_json, []),
    jibeRunning: r.jibe_running,
    jibeTotal: r.jibe_total,
    ports: safeJsonParse(r.ports_json, []),
    summary: r.summary,
    createdAt: r.created_at,
  }));

  const vps = nodes.find((n) => n.nodeId === "vps") ?? nodes[0] ?? null;
  const incidents = incidentsRes.results;
  const openCritical = incidents.some((i) => i.status === "open" && i.severity === "critical");
  const openWarn = incidents.some((i) => i.status === "open");
  const overallStatus = openCritical ? "FAIL" : openWarn || (vps && vps.stale) ? "WARN" : "OK";

  return {
    generatedAt: nowSec,
    userEmail,
    overallStatus,
    vps,
    nodes,
    probes,
    healthchecks: {
      updatedAt: hcCache?.updatedAt ?? null,
      checks: hcCache?.value ?? [],
    },
    cfAnalytics: {
      updatedAt: cfCache?.updatedAt ?? null,
      days: cfCache?.value ?? [],
    },
    incidents,
  };
}

/** Return time-series points for VPS telemetry and probe latency over 24h or 7d. */
export async function getHistory(
  db: D1Database,
  range: "24h" | "7d",
  nowSec: number,
): Promise<Record<string, unknown>> {
  const windowSec = range === "7d" ? 7 * 86400 : 24 * 3600;
  const since = nowSec - windowSec;

  const [vpsRes, probeRes] = await Promise.all([
    db
      .prepare(
        `SELECT disk_pct, mem_avail_mb, mem_total_mb, swap_used_pct, created_at
         FROM vps_snapshots
         WHERE node_id = 'vps' AND created_at >= ?
         ORDER BY created_at ASC
         LIMIT 720`,
      )
      .bind(since)
      .all<{
        disk_pct: number | null;
        mem_avail_mb: number | null;
        mem_total_mb: number | null;
        swap_used_pct: number | null;
        created_at: number;
      }>(),
    db
      .prepare(
        `SELECT target, ok, latency_ms, checked_at
         FROM probe_samples
         WHERE checked_at >= ?
         ORDER BY checked_at ASC
         LIMIT 2500`,
      )
      .bind(since)
      .all<{ target: string; ok: number; latency_ms: number; checked_at: number }>(),
  ]);

  return {
    range,
    since,
    vpsSeries: vpsRes.results.map((r) => ({
      t: r.created_at,
      diskPct: r.disk_pct,
      memAvailMb: r.mem_avail_mb,
      memTotalMb: r.mem_total_mb,
      swapUsedPct: r.swap_used_pct,
    })),
    probeSeries: probeRes.results.map((p) => ({
      t: p.checked_at,
      target: p.target,
      ok: p.ok === 1,
      ms: p.latency_ms,
    })),
  };
}

