const HOUR = 3600;

const THRESHOLDS = {
  diskWarn: 80,
  diskFail: 90,
  memAvailWarnMb: 1000,
  staleMin: 35,
  resticWarnH: 26,
  tarWarnH: 26,
  seedboxWarnH: 2,
  latencyWarnMs: 300,
};

const state = {
  range: "24h",
  overview: null,
  history: null,
  updatedAt: null,
};

/* ---------------- helpers ---------------- */

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtTime(epochSec) {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtAgeMin(min) {
  if (!Number.isFinite(min) || min < 1) return "just now";
  if (min < 60) return `${Math.round(min)}m ago`;
  const h = min / 60;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtRelIso(isoStr) {
  if (!isoStr) return "never";
  const parsed = Date.parse(isoStr);
  if (!Number.isFinite(parsed)) return "unknown";
  return fmtAgeMin(Math.max(0, (Date.now() - parsed) / 60000));
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 90) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 2 * HOUR) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / HOUR)}h`;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function probeName(p) {
  return String(p?.label ?? "").split("/")[0] || "Endpoint";
}

function probeSubUrl(p) {
  const raw = String(p?.url ?? "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.pathname && parsed.pathname !== "/") {
      return parsed.pathname;
    }
  } catch {
    // Fall back to raw URL string when not parseable.
  }
  return raw.replace(/\/$/, "");
}

/** Map any status word to ok | warn | fail | muted. */
function tone(status) {
  const s = String(status ?? "").toLowerCase();
  if (["ok", "up", "healthy", "resolved", "new"].includes(s)) return "ok";
  if (["warn", "grace", "late"].includes(s)) return "warn";
  if (["fail", "down", "open", "critical", "error"].includes(s)) return "fail";
  return "muted";
}

function stateLabel(t, text) {
  const cls = t === "ok" ? "" : ` text-${t}`;
  return `<span class="state${cls}"><span class="dot ${t}"></span>${esc(text)}</span>`;
}

function widthClass(pct) {
  const safe = Number.isFinite(pct) ? pct : 0;
  const step = Math.max(0, Math.min(100, Math.round(safe / 5) * 5));
  return `w-${step}`;
}

function meter(pct, t) {
  const cls = t === "warn" || t === "fail" ? ` ${t}` : "";
  return `<div class="meter"><span class="meter-fill ${widthClass(pct)}${cls}"></span></div>`;
}

/**
 * lo/hi fix the y-axis so normal jitter stays flat and real changes stand out.
 * Values outside [lo, hi] are pinned to the edge, so one spike can't rescale the
 * whole line (the row's status and tone already call out a slow endpoint).
 */
function sparkline(values, { large = false, t = "", area = false, lo, hi } = {}) {
  const nums = (values || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length < 2) return `<div class="muted">Collecting samples…</div>`;
  const w = 300;
  const h = large ? 64 : 28;
  const min = lo ?? Math.min(...nums);
  const max = hi ?? Math.max(...nums);
  const span = max - min || 1;
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const pts = nums.map((v, i) => [
    ((i / (nums.length - 1)) * w).toFixed(1),
    (h - 3 - ((clamp(v) - min) / span) * (h - 6)).toFixed(1),
  ]);
  const line = pts.map((p) => p.join(",")).join(" ");
  const areaPath = area ? `<polygon class="area" points="0,${h} ${line} ${w},${h}" />` : "";
  const cls = ["spark", large ? "spark-lg" : "", t === "warn" || t === "fail" ? t : ""].filter(Boolean).join(" ");
  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${areaPath}<polyline points="${line}" /></svg>`;
}

/* ---------------- derived checks ---------------- */

const RANK = { fail: 0, warn: 1, muted: 2, ok: 3 };
const worse = (a, b) => ((RANK[a] ?? 2) <= (RANK[b] ?? 2) ? a : b);

/**
 * Everything that is not OK, most severe first. Drives the title and the attention box.
 * Client-side checks give the specific reasons; open incidents and the server's
 * overallStatus are folded in so the headline can never read better than the backend.
 */
function collectIssues(ov) {
  const out = [];
  // Incident sources (see src/ingest.ts, cron.ts, probes.ts) already explained by an issue above.
  const covered = new Set();
  for (const p of ov.probes || []) {
    if (!p.latest) continue;
    const name = probeName(p);
    if (!p.latest.ok) {
      covered.add(`probe:${p.id}`);
      out.push({
        t: "fail",
        text: `${name} is down (${p.latest.statusCode || p.latest.error || "unreachable"})`,
        href: "#endpoints",
      });
    } else if (p.latest.latencyMs > THRESHOLDS.latencyWarnMs) {
      out.push({ t: "warn", text: `${name} is slow: ${p.latest.latencyMs} ms`, href: "#endpoints" });
    }
  }

  for (const n of (ov.nodes || []).filter((x) => x.nodeId !== "vps")) {
    if (n.stale || (n.ageMinutes != null && n.ageMinutes > THRESHOLDS.staleMin)) {
      covered.add(`${n.nodeId}:heartbeat`);
      out.push({ t: "warn", text: `${n.nodeId} heartbeat is ${n.ageMinutes}m old`, href: "#endpoints" });
    } else if (tone(n.status) !== "ok") {
      covered.add(`watchdog:${n.nodeId}`);
      out.push({ t: tone(n.status), text: `${n.nodeId} reports ${n.status}`, href: "#endpoints" });
    }
  }

  const hcChecks = ov.healthchecks?.checks || [];
  const hcWarned = (pattern) => hcChecks.some((c) => tone(c.status) !== "ok" && pattern.test(String(c.name ?? "")));

  const v = ov.vps;
  if (!v) {
    out.push({ t: "warn", text: "No VPS telemetry received yet", href: "#vps" });
  } else {
    const vpsStart = out.length;
    if (v.stale || (v.ageMinutes != null && v.ageMinutes > THRESHOLDS.staleMin)) {
      covered.add(`${v.nodeId || "vps"}:heartbeat`);
      out.push({ t: "warn", text: `VPS last reported ${v.ageMinutes}m ago`, href: "#vps" });
    }
    if (v.diskPct != null && v.diskPct >= THRESHOLDS.diskWarn) {
      out.push({
        t: v.diskPct >= THRESHOLDS.diskFail ? "fail" : "warn",
        text: `VPS root disk at ${v.diskPct}%`,
        href: "#vps",
      });
    }
    if (v.memAvailMb != null && v.memAvailMb < THRESHOLDS.memAvailWarnMb) {
      out.push({ t: "warn", text: `VPS memory low: ${v.memAvailMb} MiB free`, href: "#vps" });
    }
    for (const c of v.containers || []) {
      if (!c.healthy) {
        out.push({ t: "fail", text: `Container ${c.name}: ${c.status}`, href: "#vps" });
      }
    }
    for (const p of v.ports || []) {
      if (!p.open) {
        out.push({ t: "fail", text: `Tunnel port ${p.port} (${p.label}) closed`, href: "#vps" });
      }
    }
    if (v.resticAgeH != null && v.resticAgeH > THRESHOLDS.resticWarnH && !hcWarned(/restic/i)) {
      out.push({ t: "warn", text: `Restic offsite backup is ${fmtAgeMin(v.resticAgeH * 60)}`, href: "#backups" });
    }
    if (v.muuviesAgeH != null && v.muuviesAgeH > THRESHOLDS.tarWarnH && !hcWarned(/muuvies/i)) {
      out.push({ t: "warn", text: `Muuvies tar backup is ${fmtAgeMin(v.muuviesAgeH * 60)}`, href: "#backups" });
    }
    if (v.seedboxSyncAgeH != null && v.seedboxSyncAgeH > THRESHOLDS.seedboxWarnH && !hcWarned(/seedbox/i)) {
      out.push({ t: "warn", text: `Seedbox sync is ${fmtAgeMin(v.seedboxSyncAgeH * 60)}`, href: "#backups" });
    }
    // The specific checks above explain a WARN, but they must never hide a FAIL:
    // only skip the generic line when they are at least as severe as the watchdog.
    const vpsTone = tone(v.status);
    const specificWorst = out.slice(vpsStart).reduce((acc, i) => worse(acc, i.t), "ok");
    if (vpsTone !== "ok") {
      covered.add(`watchdog:${v.nodeId || "vps"}`);
      if (worse(specificWorst, vpsTone) !== specificWorst) {
        out.push({ t: vpsTone, text: `VPS watchdog reports ${v.status}`, href: "#vps" });
      }
    }
  }

  for (const c of hcChecks) {
    if (tone(c.status) === "fail") covered.add("healthchecks:down");
    if (tone(c.status) !== "ok") {
      out.push({ t: tone(c.status), text: `${c.name} is late: last ping ${fmtRelIso(c.lastPing)}`, href: "#backups" });
    }
  }

  // Open incidents the checks above didn't already explain, so the attention list
  // and the "N open incidents" fact can't disagree.
  for (const i of ov.incidents || []) {
    if (i.status !== "open" || covered.has(i.source)) continue;
    covered.add(i.source);
    out.push({ t: tone(i.severity) === "fail" ? "fail" : "warn", text: i.title, href: "#incidents" });
  }

  // Last line of defence: the headline may never read better than the server's verdict.
  const serverTone = tone(ov.overallStatus);
  if (serverTone === "fail" || serverTone === "warn") {
    const worst = out.reduce((acc, i) => worse(acc, i.t), "ok");
    if (worse(worst, serverTone) !== worst) {
      out.push({ t: serverTone, text: `Server reports overall ${ov.overallStatus}`, href: "#incidents" });
    }
  }

  return out.sort((a, b) => (RANK[a.t] ?? 2) - (RANK[b.t] ?? 2));
}

/* ---------------- renderers ---------------- */

function renderStatus(ov, issues) {
  const worst = issues[0]?.t ?? "ok";
  const title = document.getElementById("status-title");
  title.className = worst === "ok" ? "" : worst;
  title.textContent =
    worst === "ok" ? "All systems OK" : issues.length === 1 ? "1 thing needs attention" : `${issues.length} things need attention`;
  document.getElementById("overall-dot").className = `dot ${worst}`;

  const probes = ov.probes || [];
  const up = probes.filter((p) => p.latest?.ok).length;
  const lastBackupH = ov.vps
    ? Math.min(
        ov.vps.resticAgeH ?? Infinity,
        ov.vps.muuviesAgeH ?? Infinity,
      )
    : null;
  const open = (ov.incidents || []).filter((i) => i.status === "open").length;
  const facts = [
    `${up}/${probes.length} endpoints up`,
    ov.vps ? `VPS reported ${fmtAgeMin(ov.vps.ageMinutes)}` : "no VPS report yet",
    Number.isFinite(lastBackupH) ? `last backup ${fmtAgeMin(lastBackupH * 60)}` : null,
    open ? `${open} open incident${open > 1 ? "s" : ""}` : "no open incidents",
  ].filter(Boolean);
  document.getElementById("status-facts").textContent = facts.join(" · ");

  document.getElementById("user-email").textContent = ov.userEmail || "Access verified";
  const updatedTs = ov.generatedAt || state.updatedAt || nowSec();
  document.getElementById("last-updated").textContent = `updated ${fmtAgeMin(Math.max(0, (nowSec() - updatedTs) / 60))}`;

  const box = document.getElementById("attention");
  box.hidden = issues.length === 0;
  box.className = `attention${worst === "fail" ? " fail" : ""}`;
  document.getElementById("attention-list").innerHTML = issues
    .map((i) => `<li><a href="${esc(i.href)}"><span class="dot ${esc(i.t)}"></span><span>${esc(i.text)}</span><span class="go">View</span></a></li>`)
    .join("");
}

function renderEndpoints(ov) {
  const probes = ov.probes || [];
  if (!probes.length) {
    document.getElementById("endpoints-content").innerHTML = `<p class="muted">No endpoint probes configured yet.</p>`;
    return;
  }

  const rows = probes
    .map((p) => {
      const l = p.latest;
      const slow = l?.ok && l.latencyMs > THRESHOLDS.latencyWarnMs;
      const t = !l ? "muted" : !l.ok ? "fail" : slow ? "warn" : "ok";
      const statusText = !l ? "Pending" : l.ok ? `${l.statusCode}` : `${l.statusCode || "Error"}`;
      const baseUrl = probeSubUrl(p);
      const parts = [baseUrl];
      if (l?.detail && typeof l.detail.db_ok === "boolean") parts.push(`db_ok=${l.detail.db_ok}`);
      if (l && !l.ok && l.error) parts.push(l.error);
      const sub = parts.filter(Boolean).join(" · ");
      const u24 = p.uptime24h != null ? `${p.uptime24h}%` : "—";
      const u7d = p.uptime7d != null ? `${p.uptime7d}%` : "—";
      const sparkTone = !l ? "" : !l.ok ? "fail" : slow ? "warn" : "";
      const series = (p.recentSeries || []).map((x) => x.ms);

      return `<tr>
        <td><span class="ep-name">${esc(probeName(p))}</span><span class="ep-sub mono">${esc(sub)}</span></td>
        <td>${stateLabel(t, statusText)}</td>
        <td class="num${slow ? " text-warn" : ""}">${l ? `${l.latencyMs} ms` : "—"}</td>
        <td class="num">${u24}</td>
        <td class="num hide-sm">${u7d}</td>
        <td class="trend hide-sm">${sparkline(series, { t: sparkTone, lo: 0, hi: 120 })}</td>
      </tr>`;
    })
    .join("");

  const nodes = (ov.nodes || [])
    .filter((n) => n.nodeId !== "vps")
    .map((n) => {
      const t = n.stale ? "warn" : tone(n.status);
      return `<div class="ext-probe">
        <strong>External probe: ${esc(n.nodeId)}</strong>
        ${stateLabel(t, n.stale ? "Stale" : n.status)}
        <span class="muted">heartbeat ${fmtAgeMin(n.ageMinutes)}</span>
        ${n.summary ? `<span class="mono muted">${esc(n.summary)}</span>` : ""}
      </div>`;
    })
    .join("");

  // recentSeries is the last N samples, not a fixed window, so label it from the data.
  const seriesSpan = Math.max(
    0,
    ...probes.map((p) => {
      const s = p.recentSeries || [];
      return s.length > 1 ? s[s.length - 1].t - s[0].t : 0;
    }),
  );
  const trendLabel = seriesSpan >= 60 ? `Latency, last ${fmtDuration(seriesSpan)}` : "Recent latency";

  document.getElementById("endpoints-content").innerHTML = `<table class="table">
      <thead><tr>
        <th>Endpoint</th><th>Status</th><th class="num">Latency</th><th class="num">24h</th>
        <th class="num hide-sm">7d</th><th class="trend hide-sm">${esc(trendLabel)}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>${nodes}`;
}

function renderVps(ov, hist) {
  const v = ov.vps;
  const note = document.getElementById("vps-note");
  const el = document.getElementById("vps-content");
  if (!v) {
    note.textContent = "No reports yet";
    el.innerHTML = `<p class="muted">Waiting for the first push from <code>vps-watchdog.sh</code> (every 15 min).</p>`;
    return;
  }
  note.textContent = `ubuntu-8gb-fsn1-1 · ${v.stale ? "stale, " : ""}${fmtAgeMin(v.ageMinutes)}`;

  const diskT =
    v.diskPct == null ? "muted" : v.diskPct >= THRESHOLDS.diskFail ? "fail" : v.diskPct >= THRESHOLDS.diskWarn ? "warn" : "ok";
  const memUsedPct =
    v.memAvailMb != null && v.memTotalMb
      ? Math.round(((v.memTotalMb - v.memAvailMb) / v.memTotalMb) * 100)
      : 0;
  const memT = v.memAvailMb == null ? "muted" : v.memAvailMb < THRESHOLDS.memAvailWarnMb ? "warn" : "ok";

  const portsList = v.ports || [];
  const openPorts = portsList.filter((p) => p.open).length;
  const mem = (hist?.vpsSeries || [])
    .map((x) => x.memAvailMb)
    .filter((n) => typeof n === "number" && Number.isFinite(n));

  const containers = (v.containers || [])
    .map(
      (c) => `<div class="row"><span class="k mono">${esc(c.name)}</span>${stateLabel(c.healthy ? "ok" : "fail", c.healthy ? "Healthy" : c.status)}</div>`,
    )
    .join("");
  const jibe =
    v.jibeTotal != null
      ? `<div class="row"><span class="k mono">jibe-* (work)</span><span class="muted">${v.jibeRunning ?? 0}/${v.jibeTotal} running</span></div>`
      : "";
  const containerBlock =
    containers || jibe ? `<div class="list-2">${containers}${jibe}</div>` : `<p class="muted">No container status reported.</p>`;

  const portsBlock = portsList.length
    ? `<div class="row ports-row">
        ${stateLabel(openPorts === portsList.length ? "ok" : "fail", `${openPorts}/${portsList.length} ports open`)}
        <span class="ports mono">${portsList.map((p) => `<span class="${p.open ? "" : "text-fail"}">${p.port}&nbsp;${esc(p.label)}</span>`).join(" ")}</span>
      </div>`
    : `<p class="muted">No tunnel ports reported.</p>`;

  const memLabel =
    v.memAvailMb != null && v.memTotalMb
      ? `${v.memAvailMb.toLocaleString()} of ${v.memTotalMb.toLocaleString()} MiB free`
      : v.memAvailMb != null
        ? `${v.memAvailMb.toLocaleString()} MiB free`
        : "—";

  const memRangeLabel = mem.length ? `${Math.min(...mem).toLocaleString()}–${Math.max(...mem).toLocaleString()} MiB` : "—";
  const memTotalHint = v.memTotalMb ? ` (of ${v.memTotalMb.toLocaleString()} MiB)` : "";

  el.innerHTML = `
    <div class="meter-row">
      <div class="row"><span class="k">Root disk</span><span class="${diskT === "ok" || diskT === "muted" ? "" : `text-${diskT}`}">${v.diskPct != null ? `${v.diskPct}% used` : "—"}</span></div>
      ${meter(v.diskPct ?? 0, diskT)}
    </div>
    <div class="meter-row">
      <div class="row"><span class="k">Memory</span><span class="${memT === "ok" || memT === "muted" ? "" : `text-${memT}`}">${memLabel}</span></div>
      ${meter(memUsedPct, memT)}
    </div>
    <div class="row"><span class="k">Swap</span><span>${v.swapUsedMb ?? 0} MiB <span class="meta">${v.swapUsedPct ?? 0}%</span></span></div>

    <div class="subhead">Containers</div>
    ${containerBlock}

    <div class="subhead">Seedbox tunnel</div>
    ${portsBlock}

    <div class="chart-head"><span>Available memory, ${esc(state.range)}${memTotalHint}</span><span>${memRangeLabel}</span></div>
    ${sparkline(mem, { large: true, area: true, t: memT, lo: 0, hi: v.memTotalMb || undefined })}

    ${v.summary ? `<details><summary>Raw watchdog summary · ${fmtTime(v.createdAt)}</summary><pre>${esc(v.summary)}</pre></details>` : ""}
  `;
}

function renderBackups(ov) {
  const v = ov.vps;
  const hc = ov.healthchecks;
  const now = nowSec();
  document.getElementById("hc-note").textContent = hc?.updatedAt
    ? `Synced ${fmtAgeMin(Math.max(0, (now - hc.updatedAt) / 60))}`
    : "Not synced yet";

  const age = (label, h, limit) => {
    if (h == null) return `<div class="row"><span class="k">${label}</span><span class="muted">—</span></div>`;
    const t = h > limit ? "warn" : "ok";
    return `<div class="row"><span class="k">${label}</span><span class="${t === "ok" ? "" : "text-warn"}">${fmtAgeMin(h * 60)}<span class="meta">limit ${limit}h</span></span></div>`;
  };
  const ages =
    age("Restic offsite", v?.resticAgeH ?? null, THRESHOLDS.resticWarnH) +
    age("Muuvies tar", v?.muuviesAgeH ?? null, THRESHOLDS.tarWarnH) +
    age("Seedbox sync", v?.seedboxSyncAgeH ?? null, THRESHOLDS.seedboxWarnH);

  const checks = (hc?.checks || [])
    .map((c) => {
      const t = tone(c.status);
      const rawStatus = String(c.status || "unknown");
      const statusText = rawStatus === "up" ? "Up" : rawStatus[0].toUpperCase() + rawStatus.slice(1);
      return `<div class="row">
        <span class="k mono">${esc(c.name)}</span>
        <span><span class="${t === "ok" ? "muted" : `text-${t}`}">${esc(fmtRelIso(c.lastPing))}</span>
        <span class="meta">${stateLabel(t, statusText)}</span></span>
      </div>`;
    })
    .join("");

  document.getElementById("backups-content").innerHTML = `
    <div class="rows">${ages}</div>
    <div class="subhead">Healthchecks.io</div>
    <div class="rows">${checks || `<p class="muted">No Healthchecks checks cached yet.</p>`}</div>`;
}

function renderTraffic(ov) {
  const days = (ov.cfAnalytics?.days || []).slice(-7);
  document.getElementById("cf-note").textContent = "malex.tech, last 7 days";
  const el = document.getElementById("traffic-content");
  if (!days.length) {
    el.innerHTML = `<p class="muted">Analytics cache populates on the next cron sync (needs <code>CF_ANALYTICS_TOKEN</code>).</p>`;
    return;
  }

  const sum = (k) => days.reduce((a, d) => a + (d[k] || 0), 0);
  const reqs = sum("requests");
  const cached = sum("cachedRequests");
  const cachedPct = reqs > 0 ? ((cached / reqs) * 100).toFixed(1) : "0.0";
  const max = Math.max(1, ...days.map((d) => d.requests || 0));
  const W = 700;
  const H = 96;
  const slot = W / 7;
  const bw = slot * 0.56;

  const bars = days
    .map((d, i) => {
      const x = (i * slot + (slot - bw) / 2).toFixed(1);
      const th = ((d.requests || 0) / max) * (H - 4);
      const ch = ((d.cachedRequests || 0) / max) * (H - 4);
      return `<rect class="total" x="${x}" y="${(H - th).toFixed(1)}" width="${bw.toFixed(1)}" height="${th.toFixed(1)}" rx="2" />
        <rect class="cached" x="${x}" y="${(H - ch).toFixed(1)}" width="${bw.toFixed(1)}" height="${ch.toFixed(1)}" rx="2" />`;
    })
    .join("");

  const labels = days
    .map((d) => `<span>${esc(new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: "short" }))}</span>`)
    .join("");

  el.innerHTML = `
    <div class="stats">
      <div><div class="stat-k">Requests</div><div class="stat-v">${reqs.toLocaleString()}</div></div>
      <div><div class="stat-k">Cached</div><div class="stat-v">${cachedPct}%</div></div>
      <div><div class="stat-k">Bandwidth</div><div class="stat-v">${fmtBytes(sum("bytes"))}</div></div>
      <div><div class="stat-k">Threats</div><div class="stat-v">${sum("threats").toLocaleString()}</div></div>
    </div>
    <div class="chart-head"><span>Requests per day</span>
      <span class="legend"><span><span class="swatch cached"></span>Cached</span><span><span class="swatch total"></span>Uncached</span></span>
    </div>
    <svg class="bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily requests, last 7 days">${bars}</svg>
    <div class="bar-labels">${labels}</div>`;
}

function renderIncidents(ov) {
  const list = ov.incidents || [];
  const open = list.filter((i) => i.status === "open").length;
  document.getElementById("inc-note").textContent = open ? `${open} open` : "None open";
  const el = document.getElementById("incidents-content");
  if (!list.length) {
    el.innerHTML = `<p class="muted">No incidents recorded.</p>`;
    return;
  }
  const now = nowSec();
  el.innerHTML = list
    .slice(0, 6)
    .map((i) => {
      const isOpen = i.status === "open";
      const t = isOpen ? tone(i.severity) : "muted";
      const lasted = i.resolved_at
        ? `lasted ${fmtDuration(i.resolved_at - i.opened_at)}`
        : `open for ${fmtDuration(Math.max(0, now - i.opened_at))}`;
      return `<div class="incident">
        <div class="incident-top">
          <span class="incident-title">${esc(i.title)}</span>
          ${isOpen ? stateLabel(t, "Open") : `<span class="muted">Resolved</span>`}
        </div>
        <div class="incident-meta"><span class="mono">${esc(i.source)}</span> · ${fmtTime(i.opened_at)} · ${lasted}</div>
        ${i.detail ? `<div class="incident-detail">${esc(i.detail)}</div>` : ""}
      </div>`;
    })
    .join("");
}

function renderAll() {
  const ov = state.overview;
  if (!ov) return;
  const issues = collectIssues(ov);
  renderStatus(ov, issues);
  renderEndpoints(ov);
  renderVps(ov, state.history);
  renderBackups(ov);
  renderTraffic(ov);
  renderIncidents(ov);
}

/* ---------------- errors & fetching ---------------- */

function showError(message) {
  const banner = document.getElementById("error-banner");
  if (banner) {
    banner.textContent = message;
    banner.hidden = false;
  }
  const updated = document.getElementById("last-updated");
  if (updated) {
    updated.textContent = "sync error";
  }
  if (!state.overview) {
    const title = document.getElementById("status-title");
    title.className = "fail";
    title.textContent = "Unable to load telemetry";
    document.getElementById("overall-dot").className = "dot fail";
  }
}

function clearError() {
  const banner = document.getElementById("error-banner");
  if (banner) {
    banner.textContent = "";
    banner.hidden = true;
  }
}

async function readErrorMessage(res, label) {
  let detail = "";
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") {
      detail = body.error;
    }
  } catch {
    // Ignore non-JSON error responses.
  }
  if (res.status === 401 || res.status === 403) {
    return `${label}: Access session expired or unauthorized (${res.status}). Reload to re-authenticate.`;
  }
  return detail ? `${label}: ${detail}` : `${label}: HTTP ${res.status}`;
}

async function fetchHistory(range) {
  const histRes = await fetch(`/api/history?range=${encodeURIComponent(range)}&includeProbes=0`);
  if (!histRes.ok) {
    throw new Error(await readErrorMessage(histRes, "History"));
  }
  return histRes.json();
}

async function loadDashboard() {
  const [ovRes, histRes] = await Promise.all([
    fetch("/api/overview"),
    fetch(`/api/history?range=${encodeURIComponent(state.range)}&includeProbes=0`),
  ]);
  if (!ovRes.ok) {
    throw new Error(await readErrorMessage(ovRes, "Overview"));
  }
  state.overview = await ovRes.json();
  state.updatedAt = nowSec();
  if (!histRes.ok) {
    renderAll();
    throw new Error(await readErrorMessage(histRes, "History"));
  }
  state.history = await histRes.json();
  clearError();
  renderAll();
}

async function triggerManualProbe() {
  const btn = document.getElementById("run-probe-btn");
  btn.disabled = true;
  btn.textContent = "Probing…";
  try {
    const res = await fetch("/api/cron/run", { method: "POST" });
    if (!res.ok) {
      showError(await readErrorMessage(res, "Run probe"));
      return;
    }
    state.overview = await res.json();
    state.updatedAt = nowSec();
    state.history = await fetchHistory(state.range);
    clearError();
    renderAll();
  } catch (err) {
    showError(err instanceof Error ? `Run probe: ${err.message}` : "Run probe failed");
  } finally {
    btn.disabled = false;
    btn.textContent = "Run probe";
  }
}

/* ---------------- wiring ---------------- */

document.getElementById("run-probe-btn").addEventListener("click", triggerManualProbe);

for (const btn of document.querySelectorAll(".seg-btn")) {
  btn.addEventListener("click", async () => {
    const prevRange = state.range;
    state.range = btn.dataset.range;
    for (const b of document.querySelectorAll(".seg-btn")) {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", String(b === btn));
    }
    try {
      state.history = await fetchHistory(state.range);
      clearError();
      if (state.overview) {
        renderVps(state.overview, state.history);
      }
    } catch (err) {
      state.range = prevRange;
      for (const b of document.querySelectorAll(".seg-btn")) {
        b.classList.toggle("active", b.dataset.range === prevRange);
        b.setAttribute("aria-pressed", String(b.dataset.range === prevRange));
      }
      showError(err instanceof Error ? err.message : "Failed to load history");
    }
  });
}

document.getElementById("theme-btn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  document.documentElement.classList.toggle("dark", next === "dark");
  try { localStorage.setItem("theme", next); } catch {}
});

loadDashboard().catch((err) => {
  showError(err instanceof Error ? err.message : "Failed to load dashboard");
});

setInterval(() => {
  loadDashboard().catch((err) => {
    showError(err instanceof Error ? err.message : "Refresh failed");
  });
}, 60_000);
