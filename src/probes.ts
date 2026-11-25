import { syncIncidentState } from "./incidents";
import type { ProbeResult, ProbeTarget } from "./types";

export const DEFAULT_PROBE_TARGETS: ProbeTarget[] = [
  { id: "site-apex", label: "example.com", url: "https://example.com/" },
  { id: "api-health", label: "api.example.com/api/health", url: "https://api.example.com/api/health", parseJson: true },
];

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Parse PROBE_TARGETS_JSON env override, falling back to DEFAULT_PROBE_TARGETS if unset or invalid. */
export function getProbeTargets(rawJson?: string): ProbeTarget[] {
  if (!rawJson || !rawJson.trim()) {
    return DEFAULT_PROBE_TARGETS;
  }
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) {
      return DEFAULT_PROBE_TARGETS;
    }
    if (parsed.length === 0) {
      return [];
    }
    const targets: ProbeTarget[] = [];
    for (const item of parsed.slice(0, 16)) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id.trim().slice(0, 48) : "";
      const label = typeof rec.label === "string" ? rec.label.trim().slice(0, 80) : "";
      const url = typeof rec.url === "string" ? rec.url.trim() : "";
      if (!id || !label || !url || !isValidHttpUrl(url)) continue;
      targets.push({
        id,
        label,
        url,
        parseJson: Boolean(rec.parseJson),
      });
    }
    return targets.length > 0 ? targets : DEFAULT_PROBE_TARGETS;
  } catch {
    return DEFAULT_PROBE_TARGETS;
  }
}

async function probeOne(target: ProbeTarget, nowSec: number): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const resp = await fetch(target.url, {
      method: "GET",
      headers: { "User-Agent": "edge-ops-probe/1.0" },
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

/** Probe all configured public endpoints in parallel, record samples, and update incident transitions. */
export async function runEdgeProbes(
  db: D1Database,
  nowSec: number,
  targets: ProbeTarget[] = DEFAULT_PROBE_TARGETS,
): Promise<ProbeResult[]> {
  if (targets.length === 0) {
    return [];
  }
  const results = await Promise.all(targets.map((t) => probeOne(t, nowSec)));

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

