import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHistory, getOverview } from "../src/api";
import { jsonResponse, timingSafeSecretEqual, verifyIngestAuth } from "../src/auth";
import { runScheduledTasks } from "../src/cron";
import { readCache, syncCfAnalytics, writeCache } from "../src/external";
import { syncIncidentState } from "../src/incidents";
import worker from "../src/index";
import { handleIngest } from "../src/ingest";
import { runEdgeProbes } from "../src/probes";
import { NODE_STALE_SEC, type Env } from "../src/types";

interface SnapshotRow {
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

interface ProbeSampleRow {
  id: number;
  target: string;
  ok: number;
  status_code: number;
  latency_ms: number;
  detail_json: string | null;
  error: string | null;
  checked_at: number;
}

interface IncidentRowMock {
  id: number;
  source: string;
  severity: string;
  status: string;
  title: string;
  detail: string | null;
  opened_at: number;
  resolved_at: number | null;
}

interface CacheKvRow {
  key: string;
  value_json: string;
  updated_at: number;
}

function createMockDb() {
  const rows = {
    probe_samples: [] as ProbeSampleRow[],
    vps_snapshots: [] as SnapshotRow[],
    incidents: [] as IncidentRowMock[],
    cache_kv: [] as CacheKvRow[],
  };
  const executedSql: string[] = [];
  let nextSnapshotId = 1;
  let nextProbeId = 1;
  let nextIncidentId = 1;

  function makePrepared(sql: string) {
    let bound: unknown[] = [];

    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async first<T>() {
        executedSql.push(sql);
        if (sql.includes("FROM incidents") && sql.includes("status = 'open'")) {
          const source = bound[0] as string;
          const matches = rows.incidents
            .filter((r) => r.source === source && r.status === "open")
            .sort((a, b) => b.opened_at - a.opened_at || b.id - a.id);
          return (matches[0] as T) ?? null;
        }
        if (sql.includes("FROM cache_kv WHERE key = ?")) {
          const key = bound[0] as string;
          const found = rows.cache_kv.find((r) => r.key === key);
          return (found as T) ?? null;
        }
        if (sql.includes("SELECT created_at FROM vps_snapshots WHERE node_id = ?")) {
          const nodeId = bound[0] as string;
          const matches = rows.vps_snapshots
            .filter((r) => r.node_id === nodeId)
            .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
          return (matches[0] ? ({ created_at: matches[0].created_at } as T) : null);
        }
        return null;
      },
      async all<T>() {
        executedSql.push(sql);
        if (sql.includes("FROM vps_snapshots v") && sql.includes("WHERE v.id =")) {
          const byNode = new Map<string, SnapshotRow>();
          const sorted = [...rows.vps_snapshots].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
          for (const row of sorted) {
            if (!byNode.has(row.node_id)) {
              byNode.set(row.node_id, row);
            }
          }
          const ordered = [...byNode.values()].sort((a, b) => {
            const aRank = a.node_id === "vps" ? 0 : 1;
            const bRank = b.node_id === "vps" ? 0 : 1;
            if (aRank !== bRank) return aRank - bRank;
            return a.node_id.localeCompare(b.node_id);
          });
          return { results: ordered as T[] };
        }
        if (sql.includes("GROUP BY target")) {
          const since24h = bound[0] as number;
          const since7d = bound[3] as number;
          const grouped = new Map<
            string,
            { target: string; total_7d: number; ok_7d: number; total_24h: number; ok_24h: number; sum_ms: number }
          >();
          for (const p of rows.probe_samples) {
            if (p.checked_at < since7d) continue;
            const cur = grouped.get(p.target) ?? {
              target: p.target,
              total_7d: 0,
              ok_7d: 0,
              total_24h: 0,
              ok_24h: 0,
              sum_ms: 0,
            };
            cur.total_7d += 1;
            cur.ok_7d += p.ok;
            if (p.checked_at >= since24h) {
              cur.total_24h += 1;
              cur.ok_24h += p.ok;
              cur.sum_ms += p.latency_ms;
            }
            grouped.set(p.target, cur);
          }
          const results = [...grouped.values()].map((g) => ({
            target: g.target,
            total_7d: g.total_7d,
            ok_7d: g.ok_7d,
            total_24h: g.total_24h,
            ok_24h: g.ok_24h,
            avg_ms_24h: g.total_24h > 0 ? Math.round(g.sum_ms / g.total_24h) : null,
          }));
          return { results: results as T[] };
        }
        if (sql.includes("FROM probe_samples") && sql.includes("LIMIT 300")) {
          const since = bound[0] as number;
          const results = rows.probe_samples
            .filter((p) => p.checked_at >= since)
            .sort((a, b) => b.checked_at - a.checked_at || b.id - a.id)
            .slice(0, 300);
          return { results: results as T[] };
        }
        if (sql.includes("FROM probe_samples") && sql.includes("ORDER BY checked_at DESC, id DESC")) {
          const since = bound[0] as number;
          const limit = bound[1] as number;
          const results = rows.probe_samples
            .filter((p) => p.checked_at >= since)
            .sort((a, b) => b.checked_at - a.checked_at || b.id - a.id)
            .slice(0, limit);
          return { results: results as T[] };
        }
        if (sql.includes("FROM vps_snapshots") && sql.includes("node_id = 'vps'")) {
          const since = bound[0] as number;
          const results = rows.vps_snapshots
            .filter((v) => v.node_id === "vps" && v.created_at >= since)
            .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
            .slice(0, 720);
          return { results: results as T[] };
        }
        if (sql.includes("FROM incidents ORDER BY")) {
          const results = [...rows.incidents]
            .sort((a, b) => {
              const aOpen = a.status === "open" ? 0 : 1;
              const bOpen = b.status === "open" ? 0 : 1;
              if (aOpen !== bOpen) return aOpen - bOpen;
              return b.opened_at - a.opened_at;
            })
            .slice(0, 20);
          return { results: results as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        executedSql.push(sql);
        if (sql.startsWith("INSERT INTO vps_snapshots")) {
          rows.vps_snapshots.push({
            id: nextSnapshotId++,
            node_id: bound[0] as string,
            status: bound[1] as string,
            disk_pct: bound[2] as number | null,
            mem_avail_mb: bound[3] as number | null,
            mem_total_mb: bound[4] as number | null,
            swap_used_pct: bound[5] as number | null,
            swap_used_mb: bound[6] as number | null,
            restic_age_h: bound[7] as number | null,
            muuvies_age_h: bound[8] as number | null,
            seedbox_sync_age_h: bound[9] as number | null,
            containers_json: bound[10] as string | null,
            jibe_running: bound[11] as number | null,
            jibe_total: bound[12] as number | null,
            ports_json: bound[13] as string | null,
            summary: bound[14] as string | null,
            created_at: bound[15] as number,
          });
        } else if (sql.startsWith("INSERT INTO probe_samples")) {
          rows.probe_samples.push({
            id: nextProbeId++,
            target: bound[0] as string,
            ok: bound[1] as number,
            status_code: bound[2] as number,
            latency_ms: bound[3] as number,
            detail_json: bound[4] as string | null,
            error: bound[5] as string | null,
            checked_at: bound[6] as number,
          });
        } else if (sql.startsWith("INSERT INTO incidents")) {
          rows.incidents.push({
            id: nextIncidentId++,
            source: bound[0] as string,
            severity: bound[1] as string,
            status: "open",
            title: bound[2] as string,
            detail: bound[3] as string | null,
            opened_at: bound[4] as number,
            resolved_at: null,
          });
        } else if (sql.startsWith("UPDATE incidents SET status = 'resolved'")) {
          const id = bound[1] as number;
          const found = rows.incidents.find((r) => r.id === id);
          if (found) {
            found.status = "resolved";
            found.resolved_at = bound[0] as number;
          }
        } else if (sql.startsWith("UPDATE incidents SET severity = ?, title = ?, detail = ?")) {
          const id = bound[3] as number;
          const found = rows.incidents.find((r) => r.id === id);
          if (found) {
            found.severity = bound[0] as string;
            found.title = bound[1] as string;
            found.detail = bound[2] as string | null;
          }
        } else if (sql.startsWith("INSERT INTO cache_kv")) {
          const key = bound[0] as string;
          const valueJson = bound[1] as string;
          const updatedAt = bound[2] as number;
          const idx = rows.cache_kv.findIndex((r) => r.key === key);
          if (idx >= 0) {
            rows.cache_kv[idx] = { key, value_json: valueJson, updated_at: updatedAt };
          } else {
            rows.cache_kv.push({ key, value_json: valueJson, updated_at: updatedAt });
          }
        } else if (sql.startsWith("DELETE FROM probe_samples")) {
          const cutoff = bound[0] as number;
          rows.probe_samples = rows.probe_samples.filter((r) => r.checked_at >= cutoff);
        } else if (sql.startsWith("DELETE FROM vps_snapshots")) {
          const cutoff = bound[0] as number;
          rows.vps_snapshots = rows.vps_snapshots.filter((r) => r.created_at >= cutoff);
        } else if (sql.startsWith("DELETE FROM incidents")) {
          const cutoff = bound[0] as number;
          rows.incidents = rows.incidents.filter((r) => !(r.status === "resolved" && (r.resolved_at ?? 0) < cutoff));
        }
        return { success: true };
      },
    };

    return stmt;
  }

  const db = {
    prepare(sql: string) {
      return makePrepared(sql);
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      const res = [];
      for (const s of stmts) {
        res.push(await s.run());
      }
      return res;
    },
  };

  return { db: db as unknown as D1Database, rows, executedSql };
}

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    ASSETS: {
      fetch: async () => new Response("asset-ok", { status: 200 }),
    } as unknown as Fetcher,
    CF_ZONE_ID: "zone-123",
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: "user-aud",
    CF_INGEST_ACCESS_AUD: "ingest-aud",
    INGEST_BEARER_TOKEN: "top-secret-123",
    LOCAL_DEV_BYPASS: "true",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("timingSafeSecretEqual", () => {
  it("matches identical non-empty secrets and rejects mismatches or empty expected values", async () => {
    expect(await timingSafeSecretEqual("super-secret-token", "super-secret-token")).toBe(true);
    expect(await timingSafeSecretEqual("super-secret-token", "different-token")).toBe(false);
    expect(await timingSafeSecretEqual("", "")).toBe(false);
  });
});

describe("verifyIngestAuth", () => {
  const baseEnv = {
    CF_ZONE_ID: "zone",
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: "user-aud",
    CF_INGEST_ACCESS_AUD: "ingest-aud",
    INGEST_BEARER_TOKEN: "top-secret-123",
    LOCAL_DEV_BYPASS: "true",
  } as unknown as Env;

  it("allows localhost with valid Bearer when LOCAL_DEV_BYPASS=true", async () => {
    const req = new Request("http://localhost/api/ingest/vps", {
      method: "POST",
      headers: { Authorization: "Bearer top-secret-123" },
    });
    expect(await verifyIngestAuth(req, baseEnv)).toEqual({ ok: true });
  });

  it("rejects missing or bad Bearer tokens even on localhost", async () => {
    const reqBad = new Request("http://localhost/api/ingest/vps", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    });
    const res = await verifyIngestAuth(reqBad, baseEnv);
    expect(res.ok).toBe(false);
  });

  it("requires Access Service Token assertion in non-localhost production traffic", async () => {
    const reqProd = new Request("https://dashboard.malex.tech/api/ingest/vps", {
      method: "POST",
      headers: { Authorization: "Bearer top-secret-123" },
    });
    const res = await verifyIngestAuth(reqProd, { ...baseEnv, LOCAL_DEV_BYPASS: undefined } as unknown as Env);
    expect(res).toEqual({ ok: false, status: 401, reason: "Missing Access Service Token assertion" });
  });

  it("enforces strict CF_INGEST_ACCESS_AUD separation and rejects user-audience JWTs", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "kid-1";
    jwk.alg = "RS256";
    jwk.use = "sig";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
    );

    const prodEnv = {
      ...baseEnv,
      CF_ACCESS_TEAM_DOMAIN: "strict-team.cloudflareaccess.com",
      LOCAL_DEV_BYPASS: undefined,
    } as unknown as Env;

    const userJwt = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "kid-1" })
      .setIssuer("https://strict-team.cloudflareaccess.com")
      .setAudience("user-aud")
      .setExpirationTime("5m")
      .sign(privateKey);

    const reqWithUserJwt = new Request("https://dashboard.malex.tech/api/ingest/vps", {
      method: "POST",
      headers: {
        Authorization: "Bearer top-secret-123",
        "cf-access-jwt-assertion": userJwt,
      },
    });
    expect(await verifyIngestAuth(reqWithUserJwt, prodEnv)).toEqual({
      ok: false,
      status: 403,
      reason: "Invalid Service Token JWT",
    });

    const ingestJwt = await new SignJWT({ sub: "service-token" })
      .setProtectedHeader({ alg: "RS256", kid: "kid-1" })
      .setIssuer("https://strict-team.cloudflareaccess.com")
      .setAudience("ingest-aud")
      .setExpirationTime("5m")
      .sign(privateKey);

    const reqWithIngestJwt = new Request("https://dashboard.malex.tech/api/ingest/vps", {
      method: "POST",
      headers: {
        Authorization: "Bearer top-secret-123",
        "cf-access-jwt-assertion": ingestJwt,
      },
    });
    expect(await verifyIngestAuth(reqWithIngestJwt, prodEnv)).toEqual({ ok: true });
  });
});

describe("handleIngest", () => {
  it("clamps metrics, persists snapshots, and opens/resolves incidents on transitions", async () => {
    const { db, rows } = createMockDb();

    const warn = await handleIngest(
      db,
      {
        status: "WARN",
        disk_pct: 120,
        mem_avail_mb: 3500,
        jibe_running: 0,
        jibe_total: 7,
        containers: [{ name: "caddy-proxy", status: "Up", healthy: true }],
      },
      "vps",
      1000,
    );
    expect(warn).toEqual({ ok: true, nodeId: "vps", status: "WARN" });
    expect(rows.vps_snapshots[0].disk_pct).toBe(100);
    expect(rows.incidents).toHaveLength(1);
    expect(rows.incidents[0].status).toBe("open");

    const ok = await handleIngest(db, { status: "OK", disk_pct: 42, mem_avail_mb: 3800 }, "vps", 1900);
    expect(ok).toEqual({ ok: true, nodeId: "vps", status: "OK" });
    expect(rows.incidents[0].status).toBe("resolved");
    expect(rows.incidents[0].resolved_at).toBe(1900);
  });

  it("rejects invalid status payloads and invalid explicit node_id with 400 error", async () => {
    const { db } = createMockDb();
    expect((await handleIngest(db, { status: "UNKNOWN" }, "vps", 1000)).ok).toBe(false);

    const badNode = await handleIngest(db, { node_id: "bad node!", status: "OK" }, "vps", 1000);
    expect(badNode).toEqual({
      ok: false,
      error: "Invalid node_id; expected 1-32 alphanumeric, underscore, or hyphen characters",
    });

    const env = makeEnv(db);
    const resp = await worker.fetch(
      new Request("http://localhost/api/ingest/vps", {
        method: "POST",
        headers: {
          Authorization: "Bearer top-secret-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ node_id: "../etc", status: "OK" }),
      }),
      env,
    );
    expect(resp.status).toBe(400);
  });
});

describe("syncIncidentState", () => {
  it("updates detail on an already-open incident when detail changes", async () => {
    const { db, rows } = createMockDb();

    await syncIncidentState(db, {
      source: "vps:heartbeat",
      isHealthy: false,
      severity: "warn",
      title: "VPS watchdog heartbeat delayed (>35m)",
      detail: "Last ingest 40m ago",
      nowSec: 1000,
    });
    expect(rows.incidents).toHaveLength(1);
    expect(rows.incidents[0].detail).toBe("Last ingest 40m ago");

    await syncIncidentState(db, {
      source: "vps:heartbeat",
      isHealthy: false,
      severity: "warn",
      title: "VPS watchdog heartbeat delayed (>35m)",
      detail: "Last ingest 55m ago",
      nowSec: 1900,
    });
    expect(rows.incidents).toHaveLength(1);
    expect(rows.incidents[0].detail).toBe("Last ingest 55m ago");
  });
});

describe("getOverview & getHistory", () => {
  it("breaks same-second vps_snapshots ties by id DESC and marks stale azure-fr as WARN", async () => {
    const { db } = createMockDb();
    await handleIngest(db, { node_id: "vps", status: "OK", disk_pct: 40 }, "vps", 5000);
    await handleIngest(db, { node_id: "vps", status: "OK", disk_pct: 45 }, "vps", 5000);
    await handleIngest(db, { node_id: "azure-fr", status: "OK", summary: "ok" }, "node", 5000 - NODE_STALE_SEC - 10);

    const env = makeEnv(db);
    const overview = await getOverview(env, "ops@malex.tech", 5000);
    const nodes = overview.nodes as Array<{ nodeId: string; diskPct: number | null; stale: boolean }>;

    expect(nodes.filter((n) => n.nodeId === "vps")).toHaveLength(1);
    expect(nodes.find((n) => n.nodeId === "vps")?.diskPct).toBe(45);
    expect(nodes.find((n) => n.nodeId === "azure-fr")?.stale).toBe(true);
    expect(overview.overallStatus).toBe("WARN");
  });

  it("keeps newest 7d probe samples in chronological order and skips probe_samples when includeProbes=false", async () => {
    const { db, rows, executedSql } = createMockDb();
    const nowSec = 10_000_000;
    const since7d = nowSec - 7 * 86400;

    // Seed 3000 probe samples across 7d (exceeding old 2500 ASC limit)
    for (let i = 0; i < 3000; i++) {
      rows.probe_samples.push({
        id: i + 1,
        target: "malex-apex",
        ok: 1,
        status_code: 200,
        latency_ms: 20 + (i % 10),
        detail_json: null,
        error: null,
        checked_at: since7d + i * 200,
      });
    }
    for (let i = 0; i < 800; i++) {
      rows.vps_snapshots.push({
        id: i + 1,
        node_id: "vps",
        status: "OK",
        disk_pct: 50,
        mem_avail_mb: 3000 + i,
        mem_total_mb: 8000,
        swap_used_pct: 0,
        swap_used_mb: 0,
        restic_age_h: 1,
        muuvies_age_h: 1,
        seedbox_sync_age_h: 1,
        containers_json: "[]",
        jibe_running: 0,
        jibe_total: 0,
        ports_json: "[]",
        summary: null,
        created_at: since7d + i * 750,
      });
    }

    const full7d = await getHistory(db, "7d", nowSec, true);
    const probeSeries = full7d.probeSeries as Array<{ t: number }>;
    const vpsSeries = full7d.vpsSeries as Array<{ t: number; memAvailMb: number }>;

    expect(probeSeries).toHaveLength(3000);
    expect(probeSeries[0].t).toBe(since7d);
    expect(probeSeries[probeSeries.length - 1].t).toBe(since7d + 2999 * 200);

    // vpsSeries capped at 720 newest points, ordered chronologically
    expect(vpsSeries).toHaveLength(720);
    expect(vpsSeries[0].memAvailMb).toBe(3080);
    expect(vpsSeries[719].memAvailMb).toBe(3799);

    executedSql.length = 0;
    const noProbes = await getHistory(db, "7d", nowSec, false);
    expect(noProbes.probeSeries).toEqual([]);
    expect(executedSql.some((s) => s.includes("probe_samples"))).toBe(false);
  });
});

describe("syncCfAnalytics", () => {
  it("preserves existing cache when GraphQL returns HTTP 200 with errors or missing data", async () => {
    const { db } = createMockDb();
    const cachedPoints = [{ date: "2026-11-10", requests: 1200, cachedRequests: 900, bytes: 50000, threats: 1, pageViews: 300 }];
    await writeCache(db, "cf_analytics", cachedPoints, 1000);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: null, errors: [{ message: "quota exceeded" }] }), { status: 200 }),
      ),
    );

    const env = makeEnv(db, { CF_ANALYTICS_TOKEN: "cf-token" });
    await syncCfAnalytics(env, 2000, true);

    const after = await readCache(db, "cf_analytics");
    expect(after?.value).toEqual(cachedPoints);
    expect(after?.updatedAt).toBe(1000);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("probes.ts", () => {
  it("parses db_ok and service without extracting gemini_model or seedbox_host", async () => {
    const { db, rows } = createMockDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/health")) {
          return new Response(
            JSON.stringify({
              status: "healthy",
              db_ok: true,
              service: "muuvies",
              gemini_model: "should-not-store",
              seedbox_host: "should-not-store",
            }),
            { status: 200 },
          );
        }
        return new Response("<html>ok</html>", { status: 200 });
      }),
    );

    const results = await runEdgeProbes(db, 1000);
    const media = results.find((r) => r.target === "media-health");
    expect(media?.ok).toBe(true);
    expect(JSON.parse(media?.detailJson ?? "{}")).toEqual({
      status: "healthy",
      db_ok: true,
      service: "muuvies",
    });

    // Now simulate db_ok: false
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/health")) {
          return new Response(JSON.stringify({ status: "healthy", db_ok: false, service: "muuvies" }), { status: 200 });
        }
        return new Response("ok", { status: 200 });
      }),
    );
    const unhealthy = await runEdgeProbes(db, 1300);
    const mediaBad = unhealthy.find((r) => r.target === "media-health");
    expect(mediaBad?.ok).toBe(false);
    expect(rows.incidents.some((i) => i.source === "probe:media-health" && i.status === "open")).toBe(true);
  });
});

describe("cron.ts azure-fr heartbeat monitoring", () => {
  it("opens azure-fr:heartbeat incident after 35m and resolves immediately on ingest", async () => {
    const { db, rows } = createMockDb();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));

    await handleIngest(db, { node_id: "azure-fr", status: "OK", summary: "ok" }, "node", 1000);
    const env = makeEnv(db, { HEALTHCHECKS_API_KEY: undefined, CF_ANALYTICS_TOKEN: undefined });

    await runScheduledTasks(env, 1000 + NODE_STALE_SEC + 60, false);
    const hb = rows.incidents.find((i) => i.source === "azure-fr:heartbeat");
    expect(hb?.status).toBe("open");

    await handleIngest(db, { node_id: "azure-fr", status: "OK", summary: "ok" }, "node", 1000 + NODE_STALE_SEC + 120);
    expect(hb?.status).toBe("resolved");
  });
});

describe("Worker HTTP security headers, CSRF, cooldown & error handler", () => {
  it("adds full security headers on /api/* responses and returns safe 500 JSON on unhandled exceptions", async () => {
    const { db } = createMockDb();
    const env = makeEnv(db);

    const res = jsonResponse({ ok: true }, 200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect(res.headers.get("Permissions-Policy")).toBe("geolocation=(), camera=(), microphone=()");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenEnv = makeEnv({
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database);
    const errResp = await worker.fetch(new Request("http://localhost/api/overview"), brokenEnv);
    expect(errResp.status).toBe(500);
    expect(errResp.headers.get("Cache-Control")).toBe("no-store");
    expect(errResp.headers.get("X-Frame-Options")).toBe("DENY");
    expect(await errResp.json()).toEqual({ error: "Internal server error" });
    expect(errSpy).toHaveBeenCalled();

    // Ensure healthy overview also carries headers
    const okResp = await worker.fetch(new Request("http://localhost/api/overview"), env);
    expect(okResp.status).toBe(200);
    expect(okResp.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("rejects cross-site POST /api/cron/run with 403 and enforces 60s cooldown with 429", async () => {
    const { db } = createMockDb();
    const env = makeEnv(db);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/health")) {
          return new Response(JSON.stringify({ status: "healthy", db_ok: true, service: "muuvies" }), { status: 200 });
        }
        return new Response("ok", { status: 200 });
      }),
    );

    const crossOrigin = await worker.fetch(
      new Request("http://localhost/api/cron/run", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
      env,
    );
    expect(crossOrigin.status).toBe(403);

    const crossFetchSite = await worker.fetch(
      new Request("http://localhost/api/cron/run", {
        method: "POST",
        headers: { Origin: "http://localhost", "Sec-Fetch-Site": "cross-site" },
      }),
      env,
    );
    expect(crossFetchSite.status).toBe(403);

    const missingHeaders = await worker.fetch(
      new Request("http://localhost/api/cron/run", { method: "POST" }),
      env,
    );
    expect(missingHeaders.status).toBe(403);

    const first = await worker.fetch(
      new Request("http://localhost/api/cron/run", {
        method: "POST",
        headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
      }),
      env,
    );
    expect(first.status).toBe(200);

    const second = await worker.fetch(
      new Request("http://localhost/api/cron/run", {
        method: "POST",
        headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
      }),
      env,
    );
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
  });
});
