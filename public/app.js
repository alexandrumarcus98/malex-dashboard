const state = {
  range: "24h",
  overview: null,
  history: null,
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function fmtRelIso(iso) {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  const min = Math.round(ms / 60000);
  if (min < 2) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function badgeClass(status) {
  const s = String(status).toLowerCase();
  if (s === "ok" || s === "up" || s === "healthy" || s === "resolved") return "badge-ok";
  if (s === "warn" || s === "grace") return "badge-warn";
  if (s === "fail" || s === "down" || s === "open" || s === "critical") return "badge-fail";
  return "badge-muted";
}

function renderSparkline(values, color = "#38bdf8") {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length < 2) {
    return `<div class="muted" style="padding:10px 0;">Collecting samples…</div>`;
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const w = 240;
  const h = 44;
  const pts = nums
    .map((v, idx) => {
      const x = ((idx / (nums.length - 1)) * (w - 4) + 2).toFixed(1);
      const y = (h - 4 - ((v - min) / span) * (h - 10)).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${pts}" />
  </svg>`;
}

function renderSummary(ov) {
  const vps = ov.vps;
  const memUsedPct =
    vps && vps.memAvailMb != null && vps.memTotalMb
      ? Math.round(((vps.memTotalMb - vps.memAvailMb) / vps.memTotalMb) * 100)
      : null;

  const cfDays = ov.cfAnalytics?.days ?? [];
  const cfReqs7d = cfDays.reduce((acc, d) => acc + (d.requests || 0), 0);
  const cfCached7d = cfDays.reduce((acc, d) => acc + (d.cachedRequests || 0), 0);
  const cfCachePct = cfReqs7d > 0 ? ((cfCached7d / cfReqs7d) * 100).toFixed(1) : "—";

  const probesUp = (ov.probes || []).filter((p) => p.latest?.ok).length;
  const probesTotal = (ov.probes || []).length;
  const openIncidents = (ov.incidents || []).filter((i) => i.status === "open").length;

  const cards = [
    {
      label: "Overall",
      value: ov.overallStatus,
      sub: openIncidents ? `${openIncidents} active alert(s)` : "All systems nominal",
    },
    {
      label: "Edge Endpoints",
      value: `${probesUp}/${probesTotal} UP`,
      sub: "malex.tech + media",
    },
    {
      label: "VPS Memory Free",
      value: vps?.memAvailMb != null ? `${vps.memAvailMb} MiB` : "—",
      sub: memUsedPct != null ? `${memUsedPct}% used · Swap ${vps.swapUsedPct ?? 0}%` : "Waiting for VPS push",
    },
    {
      label: "VPS Root Disk",
      value: vps?.diskPct != null ? `${vps.diskPct}%` : "—",
      sub: vps ? `Last ping ${vps.ageMinutes}m ago` : "Every 15m via cron",
    },
    {
      label: "CF 7d Traffic",
      value: cfReqs7d.toLocaleString(),
      sub: `${cfCachePct}% edge cached`,
    },
  ];

  document.getElementById("summary-cards").innerHTML = cards
    .map(
      (c) => `<div class="stat-card">
        <div class="stat-label">${esc(c.label)}</div>
        <div class="stat-value">${esc(c.value)}</div>
        <div class="stat-sub">${esc(c.sub)}</div>
      </div>`,
    )
    .join("");
}

function renderProbes(ov) {
  const html = (ov.probes || [])
    .map((p) => {
      const latest = p.latest;
      const statusText = latest ? (latest.ok ? `UP · ${latest.statusCode}` : `DOWN · ${latest.statusCode}`) : "PENDING";
      const cls = latest ? (latest.ok ? "badge-ok" : "badge-fail") : "badge-muted";
      const series = (p.recentSeries || []).map((pt) => pt.ms);
      const extra =
        latest?.detail && latest.detail.gemini_model
          ? `<div class="muted mono" style="margin-top:6px;">db_ok=${esc(String(latest.detail.db_ok))} · ${esc(
              latest.detail.gemini_model,
            )}</div>`
          : "";
      const errLine = latest?.error ? `<div class="muted" style="color:var(--fail);">${esc(latest.error)}</div>` : "";
      return `<div class="subcard">
        <div class="row-between">
          <strong>${esc(p.label)}</strong>
          <span class="badge ${cls}">${esc(statusText)}</span>
        </div>
        <div class="row-between muted mono" style="margin-top:6px;">
          <span>${latest ? `${latest.latencyMs} ms` : "—"}</span>
          <span>24h: ${p.uptime24h ?? "—"}% · 7d: ${p.uptime7d ?? "—"}%</span>
        </div>
        ${extra}
        ${errLine}
        ${renderSparkline(series, latest?.ok === false ? "#ef4444" : "#22c55e")}
      </div>`;
    })
    .join("");

  const externalNodes = (ov.nodes || []).filter((n) => n.nodeId !== "vps");
  const nodesHtml = externalNodes
    .map(
      (n) => `<div class="subcard">
        <div class="row-between">
          <strong>Node: ${esc(n.nodeId)}</strong>
          <span class="badge ${badgeClass(n.status)}">${esc(n.status)}${n.stale ? " · STALE" : ""}</span>
        </div>
        <div class="row-between muted mono" style="margin-top:6px;">
          <span>Heartbeat</span>
          <span>${n.ageMinutes}m ago</span>
        </div>
        ${n.summary ? `<div class="muted mono" style="margin-top:6px;">${esc(n.summary)}</div>` : ""}
      </div>`,
    )
    .join("");

  document.getElementById("probes-grid").innerHTML = html + nodesHtml;
}

function renderVps(ov, hist) {
  const vps = ov.vps;
  const ageEl = document.getElementById("vps-age");
  const container = document.getElementById("vps-content");
  if (!vps) {
    ageEl.textContent = "No snapshots yet";
    container.innerHTML = `<p class="muted">Waiting for first 15-minute telemetry push from <code>vps-watchdog.sh</code>.</p>`;
    return;
  }

  ageEl.textContent = `${vps.status} · ${vps.ageMinutes}m ago${vps.stale ? " (STALE)" : ""}`;
  const containersHtml = (vps.containers || [])
    .map(
      (c) => `<span class="badge ${c.healthy ? "badge-ok" : "badge-fail"}" title="${esc(c.status)}">${esc(c.name)}</span>`,
    )
    .join("");

  const jibeBadge =
    vps.jibeTotal != null
      ? `<span class="badge badge-info">jibe dev: ${vps.jibeRunning ?? 0}/${vps.jibeTotal} running</span>`
      : "";

  const portsHtml = (vps.ports || [])
    .map((p) => `<span class="badge ${p.open ? "badge-ok" : "badge-fail"}">:${p.port} ${esc(p.label)}</span>`)
    .join("");

  const memSeries = (hist?.vpsSeries || []).map((x) => x.memAvailMb);

  container.innerHTML = `
    <div class="kv-grid">
      <div class="kv"><div class="kv-k">Status</div><div class="kv-v"><span class="badge ${badgeClass(vps.status)}">${esc(
        vps.status,
      )}</span></div></div>
      <div class="kv"><div class="kv-k">Root Disk</div><div class="kv-v">${vps.diskPct ?? "—"}%</div></div>
      <div class="kv"><div class="kv-k">Mem Available</div><div class="kv-v">${vps.memAvailMb ?? "—"} / ${
        vps.memTotalMb ?? "—"
      } MiB</div></div>
      <div class="kv"><div class="kv-k">Swap Used</div><div class="kv-v">${vps.swapUsedPct ?? "—"}% (${
        vps.swapUsedMb ?? "—"
      } MiB)</div></div>
    </div>
    <div class="muted">Containers</div>
    <div class="chips">${containersHtml}${jibeBadge}</div>
    ${portsHtml ? `<div class="muted">Seedbox Tunnels</div><div class="chips">${portsHtml}</div>` : ""}
    <div class="muted">Available RAM (${esc(state.range)})</div>
    ${renderSparkline(memSeries, "#38bdf8")}
    ${
      vps.summary
        ? `<details><summary>Raw watchdog summary (${fmtTime(vps.createdAt)})</summary><pre>${esc(vps.summary)}</pre></details>`
        : ""
    }
  `;
}

function renderBackupsAndHc(ov) {
  const vps = ov.vps;
  const hc = ov.healthchecks;
  document.getElementById("hc-age").textContent = hc?.updatedAt ? `Synced ${fmtTime(hc.updatedAt)}` : "Not synced yet";

  const agesHtml = vps
    ? `<div class="kv-grid">
        <div class="kv"><div class="kv-k">Restic Backup Age</div><div class="kv-v">${vps.resticAgeH ?? "—"}h</div></div>
        <div class="kv"><div class="kv-k">Muuvies Tar Age</div><div class="kv-v">${vps.muuviesAgeH ?? "—"}h</div></div>
        <div class="kv"><div class="kv-k">Seedbox Sync Age</div><div class="kv-v">${vps.seedboxSyncAgeH ?? "—"}h</div></div>
      </div>`
    : "";

  const checks = hc?.checks || [];
  const checksHtml = checks.length
    ? `<div class="list">${checks
        .map(
          (c) => `<div class="list-item row-between">
            <div>
              <strong class="mono">${esc(c.name)}</strong>
              <div class="muted">Last ping: ${esc(fmtRelIso(c.lastPing))} · ${c.nPings} pings</div>
            </div>
            <span class="badge ${badgeClass(c.status)}">${esc(c.status.toUpperCase())}</span>
          </div>`,
        )
        .join("")}</div>`
    : `<p class="muted">No Healthchecks checks cached yet.</p>`;

  document.getElementById("backups-content").innerHTML = agesHtml + checksHtml;
}

function renderAnalytics(ov) {
  const days = ov.cfAnalytics?.days || [];
  document.getElementById("cf-age").textContent = ov.cfAnalytics?.updatedAt
    ? `Updated ${fmtTime(ov.cfAnalytics.updatedAt)}`
    : "malex.tech (7d)";

  if (!days.length) {
    document.getElementById("analytics-content").innerHTML = `<p class="muted">Analytics cache populates on next cron sync (needs <code>CF_ANALYTICS_TOKEN</code>).</p>`;
    return;
  }

  const reqs = days.reduce((a, d) => a + d.requests, 0);
  const cached = days.reduce((a, d) => a + d.cachedRequests, 0);
  const bytes = days.reduce((a, d) => a + d.bytes, 0);
  const threats = days.reduce((a, d) => a + d.threats, 0);
  const pct = reqs > 0 ? ((cached / reqs) * 100).toFixed(1) : "0.0";

  document.getElementById("analytics-content").innerHTML = `
    <div class="kv-grid">
      <div class="kv"><div class="kv-k">7d Requests</div><div class="kv-v">${reqs.toLocaleString()}</div></div>
      <div class="kv"><div class="kv-k">Cache Hit</div><div class="kv-v">${pct}%</div></div>
      <div class="kv"><div class="kv-k">Bandwidth</div><div class="kv-v">${fmtBytes(bytes)}</div></div>
      <div class="kv"><div class="kv-k">Threats</div><div class="kv-v">${threats.toLocaleString()}</div></div>
    </div>
    <div class="muted">Daily requests (${esc(days[0].date)} → ${esc(days[days.length - 1].date)})</div>
    ${renderSparkline(days.map((d) => d.requests), "#a78bfa")}
  `;
}

function renderIncidents(ov) {
  const list = ov.incidents || [];
  if (!list.length) {
    document.getElementById("incidents-content").innerHTML = `<p class="muted">No incidents recorded.</p>`;
    return;
  }
  document.getElementById("incidents-content").innerHTML = `<div class="list">${list
    .slice(0, 10)
    .map(
      (i) => `<div class="list-item">
        <div class="row-between">
          <strong>${esc(i.title)}</strong>
          <span class="badge ${badgeClass(i.status === "open" ? i.severity : "resolved")}">${esc(
            i.status.toUpperCase(),
          )}</span>
        </div>
        <div class="muted mono" style="margin-top:4px;">
          ${esc(i.source)} · opened ${fmtTime(i.opened_at)}${i.resolved_at ? ` · resolved ${fmtTime(i.resolved_at)}` : ""}
        </div>
        ${i.detail ? `<div class="muted" style="margin-top:4px;">${esc(i.detail)}</div>` : ""}
      </div>`,
    )
    .join("")}</div>`;
}

function renderAll() {
  const ov = state.overview;
  if (!ov) return;
  const dot = document.getElementById("overall-dot");
  dot.className = `dot dot-${ov.overallStatus === "OK" ? "ok" : ov.overallStatus === "WARN" ? "warn" : "fail"}`;
  document.getElementById("user-email").textContent = ov.userEmail || "Access verified";
  document.getElementById("last-updated").textContent = `Updated ${fmtTime(ov.generatedAt)}`;

  renderSummary(ov);
  renderProbes(ov);
  renderVps(ov, state.history);
  renderBackupsAndHc(ov);
  renderAnalytics(ov);
  renderIncidents(ov);
}

async function loadDashboard() {
  const [ovRes, histRes] = await Promise.all([
    fetch("/api/overview"),
    fetch(`/api/history?range=${encodeURIComponent(state.range)}`),
  ]);
  if (!ovRes.ok) {
    throw new Error(`Overview HTTP ${ovRes.status}`);
  }
  state.overview = await ovRes.json();
  state.history = histRes.ok ? await histRes.json() : null;
  renderAll();
}

async function triggerManualProbe() {
  const btn = document.getElementById("run-probe-btn");
  btn.disabled = true;
  btn.textContent = "Probing…";
  try {
    const res = await fetch("/api/cron/run", { method: "POST" });
    if (res.ok) {
      state.overview = await res.json();
      const histRes = await fetch(`/api/history?range=${encodeURIComponent(state.range)}`);
      state.history = histRes.ok ? await histRes.json() : state.history;
      renderAll();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Run Probe";
  }
}

document.getElementById("run-probe-btn").addEventListener("click", triggerManualProbe);
for (const btn of document.querySelectorAll(".seg-btn")) {
  btn.addEventListener("click", async () => {
    state.range = btn.dataset.range;
    for (const b of document.querySelectorAll(".seg-btn")) {
      b.classList.toggle("active", b === btn);
    }
    const histRes = await fetch(`/api/history?range=${encodeURIComponent(state.range)}`);
    if (histRes.ok) {
      state.history = await histRes.json();
      renderAll();
    }
  });
}

loadDashboard().catch((err) => {
  document.getElementById("last-updated").textContent = err.message;
});
setInterval(() => loadDashboard().catch(() => {}), 60000);

