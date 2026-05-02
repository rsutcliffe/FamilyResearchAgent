// Evidence Matrix — flat cross-tree table of every claim, filterable.

import { buildClaimsMatrix } from "/claimsMatrix.js";

const $ = (sel) => document.querySelector(sel);

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const state = {
  rows: [], // flattened: each is one (individual × claim category)
  filters: { search: "", claim: "", band: "", status: "" },
  sort: { column: "individual_name", direction: "asc" },
};

const BAND_RANK = { A: 0, B: 1, C: 2, D: 3, E: 4 };
const STATUS_RANK = { confirmed: 0, corroborated: 1, verified: 2, conflicting: 3, "": 4, null: 4 };

const compareRows = (a, b, column, direction) => {
  let av, bv;
  if (column === "band") {
    av = BAND_RANK[a.band] ?? 9;
    bv = BAND_RANK[b.band] ?? 9;
  } else if (column === "status") {
    av = STATUS_RANK[a.status ?? ""] ?? 9;
    bv = STATUS_RANK[b.status ?? ""] ?? 9;
  } else {
    av = String(a[column] ?? "").toLowerCase();
    bv = String(b[column] ?? "").toLowerCase();
  }
  const cmp = av < bv ? -1 : av > bv ? 1 : 0;
  return direction === "desc" ? -cmp : cmp;
};

export const sortRows = (rows, { column, direction }) =>
  [...rows].sort((a, b) => compareRows(a, b, column, direction));

// Pure: flatten { items } from /api/dashboard/all-claims into row records.
// Exported for unit testing.
export const flattenIntoMatrixRows = (items) => {
  const out = [];
  for (const it of items ?? []) {
    const matrix = buildClaimsMatrix({ contributions: it.contributions ?? [], decision: it.decision });
    for (const m of matrix) {
      out.push({
        individual_id: it.individual_id,
        individual_name: it.individual_name,
        band: it.band,
        claim: m.claim,
        details: m.details,
        weights: m.weights,
        status: m.status,
      });
    }
  }
  return out;
};

// Pure: apply current filters. Exported for testing.
export const applyFilters = (rows, f) => {
  const q = (f.search ?? "").trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.individual_name.toLowerCase().includes(q)) return false;
    if (f.claim && r.claim !== f.claim) return false;
    if (f.band && r.band !== f.band) return false;
    if (f.status && r.status !== f.status) return false;
    return true;
  });
};

const tierBarSegments = (weights) =>
  weights
    .map(
      (s) => `<span class="seg t${s.tier}" style="width:${(s.fraction * 100).toFixed(1)}%"></span>`,
    )
    .join("");

const renderTable = (rows) => {
  const tbody = $("#matrix-table tbody");
  $("#filter-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No rows match the current filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr data-id="${escapeHtml(r.individual_id)}">
        <td><a href="/?id=${encodeURIComponent(r.individual_id)}"><strong>${escapeHtml(r.individual_name)}</strong></a></td>
        <td><span class="badge ${r.band ?? "D"}">${r.band ?? "?"}</span></td>
        <td>${escapeHtml(r.claim)}</td>
        <td class="muted">${escapeHtml(r.details ?? "")}</td>
        <td>${r.weights.length ? `<div class="wb-weight">${tierBarSegments(r.weights)}</div>` : '<span class="muted">—</span>'}</td>
        <td>${r.status ? `<span class="wb-pill ${r.status}">${r.status}</span>` : '<span class="muted">—</span>'}</td>
      </tr>`,
    )
    .join("");
};

const refresh = () => {
  const filtered = applyFilters(state.rows, state.filters);
  const sorted = sortRows(filtered, state.sort);
  renderTable(sorted);
  // Update sort indicators on header cells
  document.querySelectorAll("#matrix-table thead th").forEach((th) => {
    const col = th.getAttribute("data-sort-key");
    th.classList.toggle("sorted-asc", col === state.sort.column && state.sort.direction === "asc");
    th.classList.toggle("sorted-desc", col === state.sort.column && state.sort.direction === "desc");
  });
};

export const initEvidenceMatrix = async () => {
  for (const f of ["search", "claim", "band", "status"]) {
    const el = document.getElementById(`filter-${f}`);
    el?.addEventListener("input", () => {
      state.filters[f] = el.value;
      refresh();
    });
  }
  // Sortable headers — click to toggle direction; click another to switch column.
  document.querySelectorAll("#matrix-table thead th[data-sort-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort-key");
      if (state.sort.column === key) {
        state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
      } else {
        state.sort.column = key;
        state.sort.direction = "asc";
      }
      refresh();
    });
  });
  try {
    const r = await fetch("/api/dashboard/all-claims");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { items } = await r.json();
    state.rows = flattenIntoMatrixRows(items);
    refresh();
  } catch (e) {
    $("#matrix-table tbody").innerHTML = `<tr><td colspan="6" class="muted">Failed to load: ${escapeHtml(e.message)}</td></tr>`;
  }
};
