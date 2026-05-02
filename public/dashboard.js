// Dashboard page — Active Projects (default tab) and Evidence Queue.
// All cards driven by the new /api/dashboard/* endpoints.

const $ = (sel) => document.querySelector(sel);

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const fmtRelative = (iso) => {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const now = Date.now();
  const m = Math.round((now - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
};

const renderDistribution = ({ bands, total }) => {
  $("#distribution-total").textContent = `N = ${total} individuals`;
  const max = Math.max(1, ...Object.values(bands));
  const order = ["A", "B", "C", "D"];
  const labels = { A: "A — Verified", B: "B — Probable", C: "C — Uncertain", D: "D — Unverified" };
  $("#distribution-chart").innerHTML = order
    .map((b) => {
      const n = bands[b] ?? 0;
      const pct = (n / max) * 100;
      return `
        <a class="wb-bar" href="/list.html?band=${b}" title="View ${labels[b]} in list">
          <div class="wb-bar-fill band-${b}" style="height:${pct}%"></div>
          <div class="wb-bar-count">${n}</div>
          <div class="wb-bar-label">${labels[b]}</div>
        </a>`;
    })
    .join("");
};

const renderActiveThreads = (runs) => {
  const root = $("#active-threads");
  if (!runs.length) {
    root.innerHTML = `<p class="muted wb-empty">No agents running.</p>`;
    return;
  }
  root.innerHTML = runs
    .map(
      (r) => `
      <a class="wb-thread" href="/?id=${encodeURIComponent(r.id)}">
        <span class="wb-thread-dot running"></span>
        <span class="wb-thread-name">${escapeHtml(r.label ?? r.id)}</span>
        <span class="wb-thread-time muted">${Math.round((r.elapsed_ms ?? 0) / 1000)}s</span>
      </a>`,
    )
    .join("");
};

const renderRecentRuns = (items) => {
  const root = $("#recent-runs");
  if (!items.length) {
    root.innerHTML = `<p class="muted wb-empty">No agent runs on record yet.</p>`;
    return;
  }
  root.innerHTML = items
    .map(
      (r) => `
      <a class="wb-thread" href="/?id=${encodeURIComponent(r.individual_id)}">
        <span class="wb-thread-dot"></span>
        <span class="wb-thread-name">${escapeHtml(r.individual_name)}</span>
        <span class="wb-thread-time muted">${escapeHtml(fmtRelative(r.searched_at))}</span>
      </a>`,
    )
    .join("");
};

const renderRecentEvidence = (items) => {
  const root = $("#recent-evidence");
  if (!items.length) {
    root.innerHTML = `<p class="muted wb-empty">No ingested evidence yet — accept a citation, or run the Ingest flow on a document.</p>`;
    return;
  }
  root.innerHTML = items
    .map(
      (it) => `
      <a class="wb-feed-row" href="/?id=${encodeURIComponent(it.individual_id)}">
        <div class="wb-feed-main">
          <div class="wb-feed-title">${escapeHtml(it.individual_name)} <span class="muted">— ${escapeHtml(it.kind)}</span></div>
          <div class="wb-feed-source muted">${escapeHtml(it.source ?? "")}</div>
        </div>
        <div class="wb-feed-meta muted">${escapeHtml(fmtRelative(it.added_at))}${it.source_tier ? ` · T${it.source_tier}` : ""}</div>
      </a>`,
    )
    .join("");
};

const renderQueue = (items) => {
  $("#queue-count").textContent = items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : "All clear";
  const tbody = $("#queue-table tbody");
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Nothing flagged. The reviewer found no issues, no decisions are flagged, and no contradictions are recorded.</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map(
      (it) => `
      <tr>
        <td><span class="wb-pill ${it.severity === "high" ? "conflicting" : it.severity === "medium" ? "verified" : "confirmed"}">${escapeHtml(it.severity)}</span></td>
        <td><strong>${escapeHtml(it.individual_name)}</strong></td>
        <td>${escapeHtml((it.kind ?? "").replace(/_/g, " "))}</td>
        <td>${escapeHtml(it.summary ?? "")}</td>
        <td><a class="wb-card-link" href="/?id=${encodeURIComponent(it.individual_id)}">Open →</a></td>
      </tr>`,
    )
    .join("");
};

const fetchJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
};

let activeRunsTimer = null;
const pollActiveRuns = async () => {
  try {
    const { runs } = await fetchJson("/api/runs/active");
    renderActiveThreads(runs ?? []);
  } catch {
    /* keep last render */
  }
};

export const initDashboard = async () => {
  // Active Projects view
  try {
    const dist = await fetchJson("/api/dashboard/distribution");
    renderDistribution(dist);
  } catch (e) {
    $("#distribution-chart").innerHTML = `<p class="muted">Could not load distribution: ${escapeHtml(e.message)}</p>`;
  }

  pollActiveRuns();
  if (activeRunsTimer) clearInterval(activeRunsTimer);
  activeRunsTimer = setInterval(pollActiveRuns, 5000);

  fetchJson("/api/dashboard/recent-runs?limit=5").then((j) => renderRecentRuns(j.items ?? [])).catch(() => {});
  fetchJson("/api/dashboard/recent-evidence?limit=20").then((j) => renderRecentEvidence(j.items ?? [])).catch(() => {});

  // Evidence Queue is loaded lazily on tab switch (cheap enough to do now too).
  fetchJson("/api/dashboard/queue").then((j) => renderQueue(j.items ?? [])).catch((e) => {
    $("#queue-table tbody").innerHTML = `<tr><td colspan="5" class="muted">Failed: ${escapeHtml(e.message)}</td></tr>`;
  });
};
