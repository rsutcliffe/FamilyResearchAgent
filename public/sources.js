// Sources page — three categories (archive citations, accepted citations,
// agent search trail) each rendered with By-individual accordion or Flat
// table view. Driven by /api/sources catalogue.

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

// Archive citations are repository + reference strings — full text shown
// as the title; no URL extraction. Accepted/trail entries may be free
// text. Truncate the title for table display.
const titleOf = (s, limit = 90) => {
  if (!s) return "(unknown)";
  if (s.length <= limit) return s;
  return s.slice(0, limit) + "…";
};

const state = {
  catalogue: { archive_citations: [], accepted_citations: [], search_trail: [] },
  view: "individual", // "individual" | "flat"
  sort: "name",
};

// Pure: regroup a flat sources list by individual.
export const groupByIndividual = (sources) => {
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
  if (mode === "name") arr.sort((a, b) => a.name.localeCompare(b.name));
  else if (mode === "count-desc") arr.sort((a, b) => b.sources.length - a.sources.length);
  else if (mode === "count-asc") arr.sort((a, b) => a.sources.length - b.sources.length);
  else if (mode === "recent") arr.sort((a, b) => (b.lastCited ?? "").localeCompare(a.lastCited ?? ""));
  return arr;
};

const sortSources = (sources, mode) => {
  const arr = [...sources];
  if (mode === "count-desc") arr.sort((a, b) => b.citation_count - a.citation_count);
  else if (mode === "count-asc") arr.sort((a, b) => a.citation_count - b.citation_count);
  else if (mode === "recent") arr.sort((a, b) => (b.last_cited ?? "").localeCompare(a.last_cited ?? ""));
  else arr.sort((a, b) => (a.source ?? "").localeCompare(b.source ?? ""));
  return arr;
};

// Per-source context list. Surfaces the per-citation note, claim backed,
// and LR contribution that buildSourcesCatalog now attaches via contexts[].
// "Context over aggregation" rule: never reduce a list view to source+count.
const renderContexts = (contexts = []) => {
  if (!contexts.length) return "";
  const items = contexts
    .map((c) => {
      const indLink = c.individual_id
        ? `<a href="/?id=${encodeURIComponent(c.individual_id)}">${escapeHtml(c.individual_name ?? c.individual_id)}</a>`
        : "";
      const noteFragment = c.note ? `<span class="wb-ctx-note">"${escapeHtml(c.note)}"</span>` : "";
      const claimFragment = c.claim_kind && c.claim_kind !== "search_query" && c.claim_kind !== "archive_citation"
        ? `<span class="wb-ctx-claim">backs ${escapeHtml(c.claim_kind)}</span>`
        : "";
      const lrFragment = c.lr_match != null
        ? `<span class="wb-ctx-lr">LR ×${c.lr_match}</span>`
        : "";
      return `<li>${indLink}${noteFragment ? " · " + noteFragment : ""}${claimFragment ? " · " + claimFragment : ""}${lrFragment ? " · " + lrFragment : ""}</li>`;
    })
    .join("");
  return `
    <details class="wb-source-contexts">
      <summary class="muted">Show ${contexts.length} per-cite context${contexts.length === 1 ? "" : "s"}</summary>
      <ul class="wb-ctx-list">${items}</ul>
    </details>`;
};

const renderSourcesTable = (sources, opts = {}) => {
  if (!sources.length) return `<p class="muted">None.</p>`;
  const showTier = opts.showTier ?? true;
  return `
    <table class="wb-claims wb-sources-table wb-sortable">
      <thead>
        <tr>
          <th>Source</th>
          ${showTier ? "<th>Tier</th>" : ""}
          <th>Backs</th>
          <th>Individuals</th>
          <th>Last cited</th>
        </tr>
      </thead>
      <tbody>
        ${sources
          .map((s) => {
            const lrSummary = (() => {
              const lrs = (s.contexts ?? []).map((c) => c.lr_match).filter((x) => x != null);
              if (!lrs.length) return "";
              const max = Math.max(...lrs);
              return ` <span class="muted">· max LR ×${max}</span>`;
            })();
            return `
          <tr>
            <td>
              <div class="wb-source-title"><strong>${escapeHtml(titleOf(s.source))}</strong></div>
              ${s.source_id ? `<div class="muted wb-source-url">GEDCOM ref: ${escapeHtml(s.source_id)}</div>` : ""}
              ${s.sample ? `<div class="muted wb-source-url">${escapeHtml(s.sample)}</div>` : ""}
              ${renderContexts(s.contexts)}
            </td>
            ${showTier ? `<td>${s.tier ? `T${s.tier}` : "—"}</td>` : ""}
            <td>${s.citation_count} cite${s.citation_count === 1 ? "" : "s"}${lrSummary}</td>
            <td>${s.individuals
              .slice(0, 3)
              .map((i) => `<a href="/?id=${encodeURIComponent(i.id)}">${escapeHtml(i.name)}</a>`)
              .join(", ")}${s.individuals.length > 3 ? ` <span class="muted">+${s.individuals.length - 3}</span>` : ""}</td>
            <td class="muted">${escapeHtml(fmtRelative(s.last_cited))}</td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
};

const renderByIndividualSection = (root, sources, { showTier = true, emptyMsg = "No entries." } = {}) => {
  const groups = sortGroups(groupByIndividual(sources), state.sort);
  if (!groups.length) {
    root.innerHTML = `<p class="muted">${emptyMsg}</p>`;
    return groups.length;
  }
  root.innerHTML = groups
    .map(
      (g) => `
      <details class="wb-individual-acc" data-id="${escapeHtml(g.id)}">
        <summary>
          <span class="wb-individual-acc-name">${escapeHtml(g.name)}</span>
          <span class="wb-individual-acc-meta">${g.sources.length} entr${g.sources.length === 1 ? "y" : "ies"}${g.lastCited ? ` · last cited ${escapeHtml(fmtRelative(g.lastCited))}` : ""}</span>
        </summary>
        <div class="wb-individual-acc-body">
          ${renderSourcesTable(sortSources(g.sources, state.sort), { showTier })}
        </div>
      </details>`,
    )
    .join("");
  return groups.length;
};

const renderFlatSection = (root, sources, { showTier = true, emptyMsg = "No entries." } = {}) => {
  const sorted = sortSources(sources, state.sort);
  if (!sorted.length) {
    root.innerHTML = `<p class="muted">${emptyMsg}</p>`;
    return 0;
  }
  root.innerHTML = renderSourcesTable(sorted, { showTier });
  return sorted.length;
};

const refresh = () => {
  const cat = state.catalogue;
  const renderer =
    state.view === "individual" ? renderByIndividualSection : renderFlatSection;

  const archCount = renderer($("#archive-body"), cat.archive_citations, {
    showTier: true,
    emptyMsg: "No archive citations imported. Drop a GEDCOM with citations into the import flow.",
  });
  const accCount = renderer($("#accepted-body"), cat.accepted_citations, {
    showTier: true,
    emptyMsg: "No accepted citations yet. Use the Accept Match flow on the agent's recommendations to record a citation here.",
  });
  const trailCount = renderer($("#trail-body"), cat.search_trail, {
    showTier: false,
    emptyMsg: "No agent search history yet — run the agent on an individual to see queries here.",
  });

  $("#archive-count").textContent = `${cat.archive_citations.length} unique source${cat.archive_citations.length === 1 ? "" : "s"}, ${archCount} ${state.view === "individual" ? "individual" : "row"}${archCount === 1 ? "" : "s"}`;
  $("#accepted-count").textContent = `${cat.accepted_citations.length} unique source${cat.accepted_citations.length === 1 ? "" : "s"}`;
  $("#trail-count").textContent = `${cat.search_trail.length} unique quer${cat.search_trail.length === 1 ? "y" : "ies"}`;

  const total = cat.archive_citations.length + cat.accepted_citations.length + cat.search_trail.length;
  $("#sources-count").textContent = `${total} entries across all categories`;
};

const setView = (mode) => {
  state.view = mode;
  document.getElementById("view-individual").setAttribute("aria-pressed", mode === "individual" ? "true" : "false");
  document.getElementById("view-flat").setAttribute("aria-pressed", mode === "flat" ? "true" : "false");
  refresh();
};

export const initSourcesPage = async () => {
  document.getElementById("view-individual")?.addEventListener("click", () => setView("individual"));
  document.getElementById("view-flat")?.addEventListener("click", () => setView("flat"));
  document.getElementById("sort-by")?.addEventListener("change", (e) => {
    state.sort = e.target.value;
    refresh();
  });
  try {
    const r = await fetch("/api/sources");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.catalogue = {
      archive_citations: data.archive_citations ?? [],
      accepted_citations: data.accepted_citations ?? [],
      search_trail: data.search_trail ?? [],
    };
    refresh();
  } catch (e) {
    for (const id of ["archive-body", "accepted-body", "trail-body"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<p class="muted">Could not load: ${escapeHtml(e.message)}</p>`;
    }
  }
};

export { sortGroups, sortSources };
