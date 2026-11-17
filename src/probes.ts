import { syncIncidentState } from "./incidents";
import type { ProbeResult, ProbeTarget } from "./types";

export const PROBE_TARGETS: ProbeTarget[] = [
  { id: "malex-apex", label: "malex.tech", url: "https://malex.tech/" },
  { id: "malex-www", label: "www.malex.tech", url: "https://www.malex.tech/" },
  { id: "media-health", label: "media.malex.tech/api/health", url: "https://media.malex.tech/api/health", parseJson: true },
];

async function probeOne(target: ProbeTarget, nowSec: number): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const resp = await fetch(target.url, {
      method: "GET",
      headers: { "User-Agent": "malex-dashboard-probe/1.0" },
      signal: AbortSignal.timeout(8000),
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const latencyMs = Math.max(1, Date.now() - started);
    let ok = resp.status >= 200 && resp.status < 400;
    let detailJson: string | null = null;
    let error: string | null = ok ? null : `HTTP ${resp.status}`;

    if (target.parseJson) {
      try {
        const parsed = (await resp.json()) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          ok = false;
          error = ok ? "Invalid JSON health response" : `HTTP ${resp.status} (invalid JSON)`;
        } else {
          const rec = parsed as Record<string, unknown>;
          const dbOk = typeof rec.db_ok === "boolean" ? rec.db_ok : null;
          detailJson = JSON.stringify({
            status: rec.status ?? null,
            db_ok: dbOk,
            service: typeof rec.service === "string" ? rec.service : null,
          });
          if (rec.status !== "healthy" || dbOk === false) {
            ok = false;
            error = `Unhealthy payload: status=${String(rec.status)} db_ok=${String(dbOk)}`;
          }
        }
      } catch {
        error = ok ? "Invalid JSON health response" : `HTTP ${resp.status} (invalid JSON)`;
        ok = false;
      }
    } else {
      await resp.body?.cancel();
    }

    return {
      target: target.id,
      label: target.label,
      ok,
      statusCode: resp.status,
      latencyMs,
      detailJson,
      error,
      checkedAt: nowSec,
    };
  } catch (err) {
    return {
      target: target.id,
      label: target.label,
      ok: false,
      statusCode: 0,
      latencyMs: Math.max(1, Date.now() - started),
      detailJson: null,
      error: err instanceof Error ? err.message.slice(0, 200) : "Probe request failed",
      checkedAt: nowSec,
    };
  }
}

/** Probe all public endpoints in parallel, record samples, and update incident transitions. */
export async function runEdgeProbes(db: D1Database, nowSec: number): Promise<ProbeResult[]> {
  const results = await Promise.all(PROBE_TARGETS.map((t) => probeOne(t, nowSec)));

  const stmt = db.prepare(
    "INSERT INTO probe_samples (target, ok, status_code, latency_ms, detail_json, error, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  await db.batch(
    results.map((r) =>
      stmt.bind(r.target, r.ok ? 1 : 0, r.statusCode, r.latencyMs, r.detailJson, r.error, r.checkedAt),
    ),
  );

  for (const r of results) {
    await syncIncidentState(db, {
      source: `probe:${r.target}`,
      isHealthy: r.ok,
      severity: "critical",
      title: `${r.label} unreachable or unhealthy`,
      detail: r.error,
      nowSec,
    });
  }

  return results;
}

