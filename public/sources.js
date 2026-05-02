// Sources page — accordion-style grouped by individual (default) or tier.

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
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const titleFromSource = (s) => {
  if (!s) return "(unknown)";
  if (s.startsWith("http")) {
    try {
      const u = new URL(s);
      return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
    } catch {
      return s;
    }
  }
  return s;
};

const state = {
  raw: [], // /api/sources items
  group: "individual", // "individual" | "tier"
  sort: "name",
};

// Pure: regroup the flat sources list by individual. Each individual gets
// every source they're attached to (a source attached to N individuals
// shows up under each).
const groupByIndividual = (sources) => {
  const byInd = new Map();
  for (const s of sources) {
    for (const ind of s.individuals ?? []) {
      if (!byInd.has(ind.id)) byInd.set(ind.id, { id: ind.id, name: ind.name, sources: [], lastCited: null });
      const g = byInd.get(ind.id);
      g.sources.push(s);
      if (s.last_cited && (!g.lastCited || g.lastCited < s.last_cited)) g.lastCited = s.last_cited;
    }
  }
  return [...byInd.values()];
};

const sortGroups = (groups, mode) => {
  const arr = [...groups];
  if (mode === "name") {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  } else if (mode === "count-desc") {
    arr.sort((a, b) => b.sources.length - a.sources.length);
  } else if (mode === "count-asc") {
    arr.sort((a, b) => a.sources.length - b.sources.length);
  } else if (mode === "recent") {
    arr.sort((a, b) => (b.lastCited ?? "").localeCompare(a.lastCited ?? ""));
  }
  return arr;
};

const sortSources = (sources, mode) => {
  const arr = [...sources];
  if (mode === "count-desc") arr.sort((a, b) => b.citation_count - a.citation_count);
  else if (mode === "count-asc") arr.sort((a, b) => a.citation_count - b.citation_count);
  else if (mode === "recent") arr.sort((a, b) => (b.last_cited ?? "").localeCompare(a.last_cited ?? ""));
  else arr.sort((a, b) => titleFromSource(a.source).localeCompare(titleFromSource(b.source)));
  return arr;
};

const renderSourcesTable = (sources) => {
  if (!sources.length) return `<p class="muted">No sources.</p>`;
  return `
    <table class="wb-claims wb-sources-table">
      <thead>
        <tr>
          <th>Source</th>
          <th>Tier</th>
          <th>Backs</th>
          <th>Last cited</th>
        </tr>
      </thead>
      <tbody>
        ${sources
          .map((s) => `
            <tr>
              <td>
                <div class="wb-source-title"><strong>${escapeHtml(titleFromSource(s.source))}</strong></div>
                ${s.source && s.source.startsWith("http")
                  ? `<div class="muted wb-source-url"><a href="${escapeHtml(s.source)}" target="_blank" rel="noreferrer">${escapeHtml(s.source)}</a></div>`
                  : ""}
              </td>
              <td>${s.tier ? `T${s.tier}` : "—"}</td>
              <td>${s.citation_count} claim${s.citation_count === 1 ? "" : "s"}</td>
              <td class="muted">${escapeHtml(fmtRelative(s.last_cited))}</td>
            </tr>`)
          .join("")}
      </tbody>
    </table>`;
};

const renderByIndividual = () => {
  const root = $("#sources-by-individual");
  const groups = sortGroups(groupByIndividual(state.raw), state.sort);
  $("#sources-count").textContent = `${groups.length} individual${groups.length === 1 ? "" : "s"} cited`;
  if (!groups.length) {
    root.innerHTML = `<p class="muted">No sources have been cited yet.</p>`;
    return;
  }
  root.innerHTML = groups
    .map((g) => `
      <details class="wb-individual-acc" data-id="${escapeHtml(g.id)}">
        <summary>
          <span class="wb-individual-acc-name">${escapeHtml(g.name)}</span>
          <span class="wb-individual-acc-meta">${g.sources.length} source${g.sources.length === 1 ? "" : "s"}${g.lastCited ? ` · last cited ${escapeHtml(fmtRelative(g.lastCited))}` : ""}</span>
        </summary>
        <div class="wb-individual-acc-body">
          ${renderSourcesTable(sortSources(g.sources, state.sort))}
        </div>
      </details>`)
    .join("");
};

const renderByTier = () => {
  const root = $("#sources-by-tier");
  const sorted = sortSources(state.raw, state.sort);
  const t1 = sorted.filter((s) => s.tier === 1);
  const t2 = sorted.filter((s) => s.tier === 2);
  const t3 = sorted.filter((s) => s.tier === 3 || s.tier == null);
  $("#sources-count").textContent = `${state.raw.length} source${state.raw.length === 1 ? "" : "s"} total`;
  root.innerHTML = `
    <section class="wb-card">
      <header><h2>Tier 1 — Primary records</h2><span class="muted">${t1.length} source${t1.length === 1 ? "" : "s"}</span></header>
      ${renderSourcesTable(t1)}
    </section>
    <section class="wb-card">
      <header><h2>Tier 2 — Indexed / derivative</h2><span class="muted">${t2.length} source${t2.length === 1 ? "" : "s"}</span></header>
      ${renderSourcesTable(t2)}
    </section>
    <section class="wb-card">
      <header><h2>Tier 3 — Leads</h2><span class="muted">${t3.length} source${t3.length === 1 ? "" : "s"}</span></header>
      ${renderSourcesTable(t3)}
    </section>`;
};

const refresh = () => {
  if (state.group === "individual") {
    $("#sources-by-individual").hidden = false;
    $("#sources-by-tier").hidden = true;
    renderByIndividual();
  } else {
    $("#sources-by-individual").hidden = true;
    $("#sources-by-tier").hidden = false;
    renderByTier();
  }
};

const setGroup = (mode) => {
  state.group = mode;
  document.getElementById("group-individual").setAttribute("aria-pressed", mode === "individual" ? "true" : "false");
  document.getElementById("group-tier").setAttribute("aria-pressed", mode === "tier" ? "true" : "false");
  refresh();
};

export const initSourcesPage = async () => {
  document.getElementById("group-individual")?.addEventListener("click", () => setGroup("individual"));
  document.getElementById("group-tier")?.addEventListener("click", () => setGroup("tier"));
  document.getElementById("sort-by")?.addEventListener("change", (e) => {
    state.sort = e.target.value;
    refresh();
  });
  try {
    const r = await fetch("/api/sources");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { items } = await r.json();
    state.raw = items ?? [];
    refresh();
  } catch (e) {
    $("#sources-by-individual").innerHTML = `<p class="muted">Could not load: ${escapeHtml(e.message)}</p>`;
  }
};

// Exported for unit testing
export { groupByIndividual, sortGroups, sortSources };
