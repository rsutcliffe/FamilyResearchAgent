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

const CATEGORY_LABEL = {
  accepted: "Accepted citation",
  agent_run: "Agent run",
  gedcom_import: "GEDCOM import",
};
const CATEGORY_PILL = {
  accepted: "confirmed",
  agent_run: "verified",
  gedcom_import: "conflicting",
};

const renderRecentEvidence = (items) => {
  const root = $("#recent-evidence");
  if (!items.length) {
    root.innerHTML = `<p class="muted wb-empty">No ingested evidence yet — accept a citation, run the agent, or import a GEDCOM.</p>`;
    return;
  }
  root.innerHTML = items
    .map((it) => {
      const cat = it.category ?? "accepted";
      const label = CATEGORY_LABEL[cat] ?? "Evidence";
      const pillCls = CATEGORY_PILL[cat] ?? "confirmed";
      const detail =
        cat === "agent_run" && it.search_count
          ? `${it.search_count} searches · ${escapeHtml(it.source ?? "")}`
          : escapeHtml(it.source ?? "");
      // Per-row context line: surfaces the citation note + claim backed +
      // LR contribution so feed rows aren't reduced to source+tier alone.
      const ctxBits = [];
      if (it.note) ctxBits.push(`<span class="wb-ctx-note">"${escapeHtml(it.note)}"</span>`);
      if (it.claim_kind && it.claim_kind !== "agent_run" && it.claim_kind !== "gedcom_import") {
        ctxBits.push(`backs ${escapeHtml(it.claim_kind)}`);
      }
      if (it.lr_match != null) ctxBits.push(`<span class="wb-ctx-lr">LR ×${it.lr_match}</span>`);
      const contextLine = ctxBits.length ? `<div class="wb-feed-context">${ctxBits.join(" · ")}</div>` : "";
      return `
      <a class="wb-feed-row" href="/?id=${encodeURIComponent(it.individual_id)}">
        <div class="wb-feed-main">
          <div class="wb-feed-title">
            ${escapeHtml(it.individual_name)}
            <span class="wb-pill ${pillCls}" style="margin-left:6px; font-size:9px;">${escapeHtml(label)}</span>
          </div>
          <div class="wb-feed-source muted">${detail}</div>
          ${contextLine}
        </div>
        <div class="wb-feed-meta muted">${escapeHtml(fmtRelative(it.added_at))}${it.source_tier ? ` · T${it.source_tier}` : ""}</div>
      </a>`;
    })
    .join("");
};

// Map normalised severity to status-pill class. The pill components
// themselves already exist in chrome.css — we just pick the right one.
//   high   → conflicting (red-ish)
//   medium → verified    (amber-ish)
//   low    → confirmed   (neutral/quiet)
const severityPillClass = (sev) =>
  sev === "high" ? "conflicting" : sev === "medium" ? "verified" : "confirmed";

const renderQueue = (items) => {
  $("#queue-count").textContent = items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : "All clear";
  const tbody = $("#queue-table tbody");
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Nothing flagged. The reviewer found no issues, no decisions are flagged, and no contradictions are recorded.</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map((it) => {
      // Grouped rows (e.g. high_band_no_evidence × 80) show the sample
      // names inline + an "Open list" link to the band-filtered list.
      const isGroup = !!it.group;
      const indCell = isGroup
        ? `<strong>${escapeHtml(it.individual_name)}</strong>` +
          `<div class="muted" style="font-size:11px;">e.g. ${it.group.sample_names.map(escapeHtml).join(", ")}${it.group.count > it.group.sample_names.length ? "…" : ""}</div>`
        : `<strong>${escapeHtml(it.individual_name)}</strong>`;
      const linkHref = isGroup
        ? `/list.html?band=A,B`
        : `/?id=${encodeURIComponent(it.individual_id)}`;
      const linkLabel = isGroup ? "Open list →" : "Open →";
      // Triggered-by line (e.g. evidence_contradiction rows) — names which
      // source raised the alarm so the queue isn't a mystery.
      const tb = it.triggered_by;
      const triggeredByLine = tb && (tb.source || tb.kind)
        ? `<div class="wb-feed-triggered-by">Triggered by: ${escapeHtml(tb.source ?? tb.kind)}${tb.source_tier ? ` (T${tb.source_tier})` : ""}${tb.note ? ` — "${escapeHtml(tb.note)}"` : ""}</div>`
        : "";
      return `
        <tr>
          <td><span class="wb-pill ${severityPillClass(it.severity)}">${escapeHtml(it.severity)}</span></td>
          <td>${indCell}</td>
          <td>${escapeHtml((it.kind ?? "").replace(/_/g, " "))}</td>
          <td>${escapeHtml(it.summary ?? "")}${triggeredByLine}</td>
          <td><a class="wb-card-link" href="${linkHref}">${linkLabel}</a></td>
        </tr>`;
    })
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
