import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTarget, getTargets, runProbeAndPush } from "../azure-probe/src/probeLogic";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("azure-probe probeLogic", () => {
  it("parses custom PROBE_TARGETS_JSON and falls back safely on invalid JSON", () => {
    const custom = getTargets({
      PROBE_TARGETS_JSON: JSON.stringify([{ label: "app", url: "https://app.example.com/health", parseJson: true }]),
    });
    expect(custom).toEqual([{ label: "app", url: "https://app.example.com/health", checkHealthJson: true }]);
    expect(getTargets({ PROBE_TARGETS_JSON: "not-json" }).length).toBeGreaterThan(0);
  });

  it("cancels non-JSON response bodies and marks non-JSON HTTP 200 health responses as failed", async () => {
    const cancelMock = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/health")) {
          return {
            status: 200,
            ok: true,
            json: async () => {
              throw new SyntaxError("Unexpected token <");
            },
            body: { cancel: cancelMock },
          } as unknown as Response;
        }
        return {
          status: 200,
          ok: true,
          body: { cancel: cancelMock },
        } as unknown as Response;
      }),
    );

    const htmlRes = await checkTarget({ label: "site", url: "https://example.com/" });
    expect(htmlRes.ok).toBe(true);
    expect(cancelMock).toHaveBeenCalledTimes(1);

    const healthBadJson = await checkTarget({
      label: "api",
      url: "https://api.example.com/api/health",
      checkHealthJson: true,
    });
    expect(healthBadJson.ok).toBe(false);
    expect(healthBadJson.text).toContain("api:200-BADJSON");
  });

  it("handles ingest POST network errors without throwing and logs cleanly", async () => {
    const cancelMock = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("ops.example.com")) {
          throw new Error("connect ETIMEDOUT");
        }
        if (url.includes("/api/health")) {
          return new Response(JSON.stringify({ status: "healthy", db_ok: true, service: "media-api" }), { status: 200 });
        }
        return {
          status: 200,
          ok: true,
          body: { cancel: cancelMock },
        } as unknown as Response;
      }),
    );

    const logs: string[] = [];
    const errors: string[] = [];
    const res = await runProbeAndPush(
      {
        DASHBOARD_INGEST_URL: "https://ops.example.com/api/ingest/node",
        DASHBOARD_INGEST_TOKEN: "secret-should-not-leak",
        PROBE_NODE_ID: "eu-probe",
        PROBE_REGION: "eu-west",
      },
      {
        log: (...args: unknown[]) => logs.push(String(args[0] ?? "")),
        error: (...args: unknown[]) => errors.push(String(args[0] ?? "")),
      },
    );

    expect(res.allOk).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.summary).toContain("[eu-west]");
    expect(errors.some((e) => e.includes("Ingest push failed: connect ETIMEDOUT"))).toBe(true);
    expect(errors.join("\n")).not.toContain("secret-should-not-leak");
  });
});
