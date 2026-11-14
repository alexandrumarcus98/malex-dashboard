import { syncIncidentState } from "./incidents";
import type { ContainerState, PortState, VpsIngestPayload } from "./types";

function finiteOrNull(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(max, Math.max(min, value));
}

function sanitizeContainers(input: unknown): ContainerState[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .slice(0, 32)
    .map((item) => {
      const rec = item as Record<string, unknown>;
      return {
        name: String(rec?.name ?? "").slice(0, 64),
        status: String(rec?.status ?? "unknown").slice(0, 64),
        healthy: Boolean(rec?.healthy),
      };
    })
    .filter((c) => c.name.length > 0);
}

function sanitizePorts(input: unknown): PortState[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .slice(0, 16)
    .map((item) => {
      const rec = item as Record<string, unknown>;
      const port = typeof rec?.port === "number" ? Math.trunc(rec.port) : 0;
      return {
        port,
        label: String(rec?.label ?? "").slice(0, 48),
        open: Boolean(rec?.open),
      };
    })
    .filter((p) => p.port > 0 && p.port <= 65535);
}

/** Validate and persist a VPS/node watchdog snapshot into D1, returning normalized record info. */
export async function handleIngest(
  db: D1Database,
  rawBody: unknown,
  defaultNodeId: string,
  nowSec: number,
): Promise<{ ok: true; nodeId: string; status: string } | { ok: false; error: string }> {
  if (!rawBody || typeof rawBody !== "object") {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const body = rawBody as Partial<VpsIngestPayload>;
  const nodeId = typeof body.node_id === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(body.node_id)
    ? body.node_id
    : defaultNodeId;
  const status = body.status === "OK" || body.status === "WARN" || body.status === "FAIL" ? body.status : null;
  if (!status) {
    return { ok: false, error: "Invalid status; expected OK, WARN, or FAIL" };
  }

  const diskPct = finiteOrNull(body.disk_pct, 0, 100);
  const memAvailMb = finiteOrNull(body.mem_avail_mb, 0, 1_048_576);
  const memTotalMb = finiteOrNull(body.mem_total_mb, 0, 1_048_576);
  const swapUsedPct = finiteOrNull(body.swap_used_pct, 0, 100);
  const swapUsedMb = finiteOrNull(body.swap_used_mb, 0, 1_048_576);
  const resticAgeH = finiteOrNull(body.restic_age_h, 0, 8760);
  const muuviesAgeH = finiteOrNull(body.muuvies_age_h, 0, 8760);
  const seedboxSyncAgeH = finiteOrNull(body.seedbox_sync_age_h, 0, 8760);
  const jibeRunning = finiteOrNull(body.jibe_running, 0, 64);
  const jibeTotal = finiteOrNull(body.jibe_total, 0, 64);
  const containers = sanitizeContainers(body.containers);
  const ports = sanitizePorts(body.ports);
  const summary = typeof body.summary === "string" ? body.summary.slice(0, 4096) : null;

  await db
    .prepare(
      `INSERT INTO vps_snapshots (
        node_id, status, disk_pct, mem_avail_mb, mem_total_mb, swap_used_pct, swap_used_mb,
        restic_age_h, muuvies_age_h, seedbox_sync_age_h, containers_json, jibe_running,
        jibe_total, ports_json, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      nodeId,
      status,
      diskPct,
      memAvailMb !== null ? Math.round(memAvailMb) : null,
      memTotalMb !== null ? Math.round(memTotalMb) : null,
      swapUsedPct,
      swapUsedMb !== null ? Math.round(swapUsedMb) : null,
      resticAgeH,
      muuviesAgeH,
      seedboxSyncAgeH,
      JSON.stringify(containers),
      jibeRunning !== null ? Math.round(jibeRunning) : null,
      jibeTotal !== null ? Math.round(jibeTotal) : null,
      JSON.stringify(ports),
      summary,
      nowSec,
    )
    .run();

  await syncIncidentState(db, {
    source: `watchdog:${nodeId}`,
    isHealthy: status === "OK",
    severity: status === "FAIL" ? "critical" : "warn",
    title: `${nodeId} watchdog reported ${status}`,
    detail: summary ? summary.split("\n").slice(0, 4).join(" | ") : null,
    nowSec,
  });

  if (nodeId === "vps") {
    await syncIncidentState(db, {
      source: "vps:heartbeat",
      isHealthy: true,
      severity: "warn",
      title: "VPS watchdog heartbeat restored",
      detail: null,
      nowSec,
    });
  }

  return { ok: true, nodeId, status };
}

