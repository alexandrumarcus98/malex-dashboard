const { app } = require("@azure/functions");

const TARGETS = [
  { label: "malex", url: "https://malex.tech/" },
  { label: "www", url: "https://www.malex.tech/" },
  { label: "media", url: "https://media.malex.tech/api/health", checkHealthJson: true },
];

async function checkTarget(target) {
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      method: "GET",
      headers: { "User-Agent": "malex-azure-probe/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    const ms = Math.max(1, Date.now() - started);
    let ok = res.status >= 200 && res.status < 400;
    if (ok && target.checkHealthJson) {
      const payload = await res.json();
      if (payload.status !== "healthy" || payload.db_ok === false) {
        ok = false;
      }
    }
    return { label: target.label, ok, text: `${target.label}:${res.status}(${ms}ms)` };
  } catch (err) {
    const ms = Math.max(1, Date.now() - started);
    return { label: target.label, ok: false, text: `${target.label}:ERR(${ms}ms)` };
  }
}

app.timer("probeTimer", {
  schedule: "0 */15 * * * *",
  runOnStartup: false,
  handler: async (_myTimer, context) => {
    const results = await Promise.all(TARGETS.map(checkTarget));
    const allOk = results.every((r) => r.ok);
    const summary = `[azure-francecentral] ${results.map((r) => r.text).join(" | ")}`;
    context.log(summary);

    const ingestUrl = process.env.DASHBOARD_INGEST_URL;
    const bearer = process.env.DASHBOARD_INGEST_TOKEN;
    if (!ingestUrl || !bearer) {
      context.log("Missing DASHBOARD_INGEST_URL or DASHBOARD_INGEST_TOKEN; skipping push");
      return;
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    };
    if (process.env.DASHBOARD_CF_ACCESS_CLIENT_ID && process.env.DASHBOARD_CF_ACCESS_CLIENT_SECRET) {
      headers["CF-Access-Client-Id"] = process.env.DASHBOARD_CF_ACCESS_CLIENT_ID;
      headers["CF-Access-Client-Secret"] = process.env.DASHBOARD_CF_ACCESS_CLIENT_SECRET;
    }

    const resp = await fetch(ingestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        node_id: "azure-fr",
        status: allOk ? "OK" : "FAIL",
        summary,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      context.log(`Ingest push returned HTTP ${resp.status}`);
    }
  },
});

