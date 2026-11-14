import { describe, expect, it } from "vitest";
import { timingSafeSecretEqual, verifyIngestAuth } from "../src/auth";
import { handleIngest } from "../src/ingest";
import type { Env } from "../src/types";

function createMockDb() {
  const rows: Record<string, unknown[]> = {
    vps_snapshots: [],
    incidents: [],
  };
  let nextId = 1;

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        async first<T>() {
          if (sql.includes("FROM incidents") && sql.includes("status = 'open'")) {
            const source = bound[0];
            const found = (rows.incidents as Array<Record<string, unknown>>).find(
              (r) => r.source === source && r.status === "open",
            );
            return (found as T) ?? null;
          }
          return null;
        },
        async run() {
          if (sql.startsWith("INSERT INTO vps_snapshots")) {
            rows.vps_snapshots.push({
              node_id: bound[0],
              status: bound[1],
              disk_pct: bound[2],
              mem_avail_mb: bound[3],
              created_at: bound[15],
            });
          } else if (sql.startsWith("INSERT INTO incidents")) {
            rows.incidents.push({
              id: nextId++,
              source: bound[0],
              severity: bound[1],
              status: "open",
              title: bound[2],
              detail: bound[3],
              opened_at: bound[4],
              resolved_at: null,
            });
          } else if (sql.startsWith("UPDATE incidents SET status = 'resolved'")) {
            const id = bound[1];
            const found = (rows.incidents as Array<Record<string, unknown>>).find((r) => r.id === id);
            if (found) {
              found.status = "resolved";
              found.resolved_at = bound[0];
            }
          }
          return { success: true };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, rows };
}

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
    CF_ACCESS_AUD: "aud",
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
    expect((rows.vps_snapshots[0] as Record<string, unknown>).disk_pct).toBe(100);
    expect(rows.incidents).toHaveLength(1);
    expect((rows.incidents[0] as Record<string, unknown>).status).toBe("open");

    const ok = await handleIngest(db, { status: "OK", disk_pct: 42, mem_avail_mb: 3800 }, "vps", 1900);
    expect(ok).toEqual({ ok: true, nodeId: "vps", status: "OK" });
    expect((rows.incidents[0] as Record<string, unknown>).status).toBe("resolved");
    expect((rows.incidents[0] as Record<string, unknown>).resolved_at).toBe(1900);
  });

  it("rejects invalid status payloads", async () => {
    const { db } = createMockDb();
    const res = await handleIngest(db, { status: "UNKNOWN" }, "vps", 1000);
    expect(res.ok).toBe(false);
  });
});

