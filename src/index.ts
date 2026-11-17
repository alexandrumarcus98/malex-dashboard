import { getHistory, getOverview } from "./api";
import { jsonResponse, verifyIngestAuth, verifyUserAccess } from "./auth";
import { runScheduledTasks, tryAcquireManualCronCooldown } from "./cron";
import { handleIngest } from "./ingest";
import type { Env } from "./types";

function isSameOriginPost(request: Request, url: URL): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin") {
    return false;
  }
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }
  return secFetchSite === "same-origin";
}

async function parseJsonBody(request: Request): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    const data = await request.json();
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const nowSec = Math.floor(Date.now() / 1000);

      if (url.pathname === "/api/ingest/vps" || url.pathname === "/api/ingest/node") {
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, 405);
        }
        const auth = await verifyIngestAuth(request, env);
        if (!auth.ok) {
          return jsonResponse({ error: auth.reason }, auth.status);
        }
        const parsed = await parseJsonBody(request);
        if (!parsed.ok) {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        const defaultNode = url.pathname.endsWith("/vps") ? "vps" : "node";
        const result = await handleIngest(env.DB, parsed.data, defaultNode, nowSec);
        if (!result.ok) {
          return jsonResponse({ error: result.error }, 400);
        }
        return jsonResponse({ ok: true, nodeId: result.nodeId, status: result.status, recordedAt: nowSec }, 202);
      }

      if (url.pathname.startsWith("/api/")) {
        const user = await verifyUserAccess(request, env);
        if (!user.ok) {
          return jsonResponse({ error: user.reason }, user.status);
        }

        if (url.pathname === "/api/overview" && request.method === "GET") {
          const overview = await getOverview(env, user.email, nowSec);
          return jsonResponse(overview);
        }

        if (url.pathname === "/api/history" && request.method === "GET") {
          const range = url.searchParams.get("range") === "7d" ? "7d" : "24h";
          const includeProbes = url.searchParams.get("includeProbes") !== "0";
          const history = await getHistory(env.DB, range, nowSec, includeProbes);
          return jsonResponse(history);
        }

        if (url.pathname === "/api/cron/run" && request.method === "POST") {
          if (!isSameOriginPost(request, url)) {
            return jsonResponse({ error: "Cross-origin request rejected" }, 403);
          }
          const cooldown = await tryAcquireManualCronCooldown(env.DB, nowSec);
          if (!cooldown.allowed) {
            return jsonResponse(
              {
                error: `Manual probe cooldown active; retry in ${cooldown.retryAfterSec}s`,
                retryAfterSec: cooldown.retryAfterSec,
              },
              429,
              { "Retry-After": String(cooldown.retryAfterSec) },
            );
          }
          await runScheduledTasks(env, nowSec, true);
          const overview = await getOverview(env, user.email, nowSec);
          return jsonResponse(overview);
        }

        return jsonResponse({ error: "Not found" }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("Unhandled worker error:", err instanceof Error ? err.message : "Unknown error");
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    ctx.waitUntil(runScheduledTasks(env, nowSec, false));
  },
};

