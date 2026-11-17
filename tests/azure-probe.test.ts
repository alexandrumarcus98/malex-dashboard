import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTarget, runProbeAndPush } from "../azure-probe/src/probeLogic";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("azure-probe probeLogic", () => {
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

    const htmlRes = await checkTarget({ label: "malex", url: "https://malex.tech/" });
    expect(htmlRes.ok).toBe(true);
    expect(cancelMock).toHaveBeenCalledTimes(1);

    const healthBadJson = await checkTarget({
      label: "media",
      url: "https://media.malex.tech/api/health",
      checkHealthJson: true,
    });
    expect(healthBadJson.ok).toBe(false);
    expect(healthBadJson.text).toContain("media:200-BADJSON");
  });

  it("handles ingest POST network errors without throwing and logs cleanly", async () => {
    const cancelMock = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("dashboard.malex.tech")) {
          throw new Error("connect ETIMEDOUT");
        }
        if (url.includes("/api/health")) {
          return new Response(JSON.stringify({ status: "healthy", db_ok: true, service: "muuvies" }), { status: 200 });
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
        DASHBOARD_INGEST_URL: "https://dashboard.malex.tech/api/ingest/node",
        DASHBOARD_INGEST_TOKEN: "secret-should-not-leak",
      },
      {
        log: (...args: unknown[]) => logs.push(String(args[0] ?? "")),
        error: (...args: unknown[]) => errors.push(String(args[0] ?? "")),
      },
    );

    expect(res.allOk).toBe(true);
    expect(res.pushed).toBe(false);
    expect(errors.some((e) => e.includes("Ingest push failed: connect ETIMEDOUT"))).toBe(true);
    expect(errors.join("\n")).not.toContain("secret-should-not-leak");
  });
});
