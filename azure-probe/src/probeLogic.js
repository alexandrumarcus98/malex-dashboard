const DEFAULT_TARGETS = [
  { label: "site", url: "https://example.com/" },
  { label: "api", url: "https://api.example.com/api/health", checkHealthJson: true },
];

function isValidHttpUrl(raw) {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function getTargets(env) {
  const raw = env?.PROBE_TARGETS_JSON;
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    return DEFAULT_TARGETS;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_TARGETS;
    const out = [];
    for (const item of parsed.slice(0, 16)) {
      if (!item || typeof item !== "object") continue;
      const label = typeof item.label === "string" ? item.label.trim().slice(0, 80) : "";
      const url = typeof item.url === "string" ? item.url.trim() : "";
      if (!label || !url || !isValidHttpUrl(url)) continue;
      out.push({
        label,
        url,
        checkHealthJson: Boolean(item.checkHealthJson ?? item.parseJson),
      });
    }
    return out.length > 0 ? out : DEFAULT_TARGETS;
  } catch {
    return DEFAULT_TARGETS;
  }
}

async function safeCancelBody(res) {
  try {
    await res?.body?.cancel?.();
  } catch {
    // Ignore stream cancel failures after status is already read.
  }
}

async function checkTarget(target) {
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      method: "GET",
      headers: { "User-Agent": "edge-ops-probe/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    const ms = Math.max(1, Date.now() - started);
    let ok = res.status >= 200 && res.status < 400;
    let statusLabel = String(res.status);

    if (ok && target.checkHealthJson) {
      try {
        const payload = await res.json();
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          payload.status !== "healthy" ||
          payload.db_ok === false
        ) {
          ok = false;
        }
      } catch {
        ok = false;
        statusLabel = `${res.status}-BADJSON`;
      }
    } else {
      await safeCancelBody(res);
    }

    return { label: target.label, ok, text: `${target.label}:${statusLabel}(${ms}ms)` };
  } catch {
    const ms = Math.max(1, Date.now() - started);
    return { label: target.label, ok: false, text: `${target.label}:ERR(${ms}ms)` };
  }
}

async function runProbeAndPush(env, logger) {
  const log = typeof logger?.log === "function" ? (...args) => logger.log(...args) : () => {};
  const logErr = typeof logger?.error === "function" ? (...args) => logger.error(...args) : log;

  const targets = getTargets(env);
  const results = await Promise.all(targets.map(checkTarget));
  const allOk = results.every((r) => r.ok);
  const region = (env?.PROBE_REGION || env?.REGION_NAME || "remote").trim() || "remote";
  const nodeId = (env?.PROBE_NODE_ID || "remote-probe").trim() || "remote-probe";
  const summary = `[${region}] ${results.map((r) => r.text).join(" | ")}`;
  log(summary);

  const ingestUrl = env.DASHBOARD_INGEST_URL;
  const bearer = env.DASHBOARD_INGEST_TOKEN;
  if (!ingestUrl || !bearer) {
    log("Missing DASHBOARD_INGEST_URL or DASHBOARD_INGEST_TOKEN; skipping push");
    return { summary, allOk, pushed: false };
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  if (env.DASHBOARD_CF_ACCESS_CLIENT_ID && env.DASHBOARD_CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.DASHBOARD_CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.DASHBOARD_CF_ACCESS_CLIENT_SECRET;
  }

  try {
    const resp = await fetch(ingestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        node_id: nodeId,
        status: allOk ? "OK" : "FAIL",
        summary,
      }),
      signal: AbortSignal.timeout(8000),
    });
    await safeCancelBody(resp);
    if (!resp.ok) {
      logErr(`Ingest push returned HTTP ${resp.status}`);
      return { summary, allOk, pushed: false, status: resp.status };
    }
    return { summary, allOk, pushed: true, status: resp.status };
  } catch (err) {
    logErr(`Ingest push failed: ${err instanceof Error ? err.message : String(err)}`);
    return { summary, allOk, pushed: false };
  }
}

module.exports = {
  DEFAULT_TARGETS,
  getTargets,
  checkTarget,
  runProbeAndPush,
};

