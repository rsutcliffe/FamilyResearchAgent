// Ancestors → List view. Uses the same Claims Matrix + Confidence Donut +
// agent narrative panel as the tree view; difference is the layout (list +
// detail side-by-side) and the filter set. Honours ?band=A,B from the URL
// so the Dashboard distribution histogram can deep-link in.

import {
  buildClaimsMatrix,
  renderDonut,
  renderBandScale,
} from "/claimsMatrix.js";

const CONF_LABEL = { A: "VERIFIED", B: "PROBABLE", C: "UNCERTAIN", D: "UNVERIFIED" };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const state = {
  individuals: [],
  filter: { band: "all", decision: "all", search: "" },
  selectedId: null,
  streaming: null,
  reviewCache: null,
};

// ---- URL → initial filter ----
const initialFilterFromUrl = () => {
  const p = new URLSearchParams(location.search);
  const band = p.get("band"); // "A" | "A,B" | "all"
  if (band) state.filter.band = band;
  const dec = p.get("decision");
  if (dec) state.filter.decision = dec;
};

// ---- Data ----
const fetchIndividuals = async () => {
  const res = await fetch("/api/individuals");
  state.individuals = await res.json();
  renderList();
};

const filteredIndividuals = () => {
  const bandFilter = state.filter.band; // "all" | "A" | "A,B" | etc.
  const decFilter = state.filter.decision; // "all" | "undecided" | "accepted" | ...
  const q = state.filter.search.trim().toLowerCase();
  const allowedBands = bandFilter === "all" ? null : new Set(bandFilter.split(","));
  return state.individuals
    .filter((p) => {
      if (allowedBands && !allowedBands.has(p.confidence)) return false;
      if (decFilter === "undecided" && p.decision) return false;
      if (decFilter !== "all" && decFilter !== "undecided" && p.decision !== decFilter) return false;
      if (q && !(p.name ?? "").toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => {
      // D first, then C, then B, then A — push the work that needs doing to the top
      const order = { D: 0, C: 1, B: 2, A: 3 };
      const ba = order[a.confidence] ?? 9;
      const bb = order[b.confidence] ?? 9;
      if (ba !== bb) return ba - bb;
      return (b.generation ?? 0) - (a.generation ?? 0);
    });
};

const renderList = () => {
  const ul = $("#people");
  const filtered = filteredIndividuals();
  $("#list-count").textContent = `${filtered.length} of ${state.individuals.length}`;
  ul.innerHTML = filtered
    .map(
      (p) => `
      <li data-id="${escapeHtml(p.id)}" class="${p.id === state.selectedId ? "selected" : ""}">
        <div>
          <span class="person-name">${escapeHtml(p.name || "Unknown")}</span>
          <span class="badge ${p.confidence}">${p.confidence}</span>
          ${p.researched ? '<span class="tick">✓</span>' : ""}
          ${p.decision ? `<span class="decision-tag ${p.decision}">${p.decision}</span>` : ""}
        </div>
        <div class="person-meta">Gen ${p.generation ?? "?"} · b.${p.birth_year ?? "?"} · ${escapeHtml(p.birth_place || "place unknown")}</div>
      </li>`,
    )
    .join("");
  // Re-attach click handlers
  ul.querySelectorAll("li").forEach((li) =>
    li.addEventListener("click", () => selectPerson(li.dataset.id)),
  );
};

// ---- Detail-panel rendering (mirrors tree.js Slice 1) ----
const renderResult = (text) => {
  const safe = escapeHtml(text ?? "");
  const html = safe.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  $("#result").innerHTML = html;
  $("#full-narrative").hidden = !text;
};

const tierBarSegments = (weights) =>
  weights
    .map((s) => `<span class="seg t${s.tier}" style="width:${(s.fraction * 100).toFixed(1)}%"></span>`)
    .join("");

const renderClaimsMatrixInto = (root, rows) => {
  if (!root) return;
  if (!rows.length) {
    root.innerHTML = `<tbody><tr><td class="muted" colspan="4">No accumulated evidence yet — run the agent or accept a citation to populate.</td></tr></tbody>`;
    return;
  }
  const head = `
    <colgroup>
      <col class="col-claim" />
      <col class="col-details" />
      <col class="col-weights" />
      <col class="col-status" />
    </colgroup>
    <thead><tr><th>Fact / claim</th><th>Details</th><th>Sources</th><th>Status</th></tr></thead>`;
  const body = rows
    .map((r) => {
      const pill = r.status
        ? `<span class="wb-pill ${r.status}">${r.status}</span>`
        : `<span class="muted" style="font-size:11px;">—</span>`;
      const weights = r.weights.length
        ? `<div class="wb-weight">${tierBarSegments(r.weights)}</div>`
        : `<span class="muted" style="font-size:11px;">no tier</span>`;
      const count = r.contribution_count > 1 ? ` <span class="muted">×${r.contribution_count}</span>` : "";
      return `
        <tr>
          <td><strong>${escapeHtml(r.claim)}</strong>${count}</td>
          <td>${escapeHtml(r.details)}</td>
          <td>${weights}</td>
          <td>${pill}</td>
        </tr>`;
    })
    .join("");
  root.innerHTML = head + `<tbody>${body}</tbody>`;
};

const renderNextStepsInto = (root, { reviewerFindings = [], reresearch, contradictions = 0 }) => {
  if (!root) return;
  const items = [];
  if (reresearch?.reason) items.push({ title: "Re-research recommended", hint: reresearch.reason });
  for (const f of reviewerFindings) {
    items.push({
      title: f.kind?.replace(/_/g, " ") ?? "Reviewer finding",
      hint: f.message ?? "Open Review for context.",
    });
  }
  if (contradictions > 0) {
    items.push({
      title: `${contradictions} contradiction${contradictions === 1 ? "" : "s"} in evidence`,
      hint: "Expand the matrix rows tagged Conflicting and resolve.",
    });
  }
  if (!items.length) {
    items.push({
      title: "No outstanding actions",
      hint: "Evidence is clean. Run the agent if you want to look for more.",
    });
  }
  root.innerHTML = items
    .map(
      (it) => `
      <li>
        <div class="wb-step-title">${escapeHtml(it.title)}</div>
        <div class="wb-step-hint muted">${escapeHtml(it.hint)}</div>
      </li>`,
    )
    .join("");
};

const fetchReviewOnce = async () => {
  if (state.reviewCache) return state.reviewCache;
  try {
    const r = await fetch("/api/review");
    if (!r.ok) return [];
    const j = await r.json();
    state.reviewCache = j.findings ?? [];
    return state.reviewCache;
  } catch {
    return [];
  }
};

const renderClaimsAndConfidence = async (id, payload, decision) => {
  const section = $("#claims-matrix-section");
  if (!payload?.result) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const contributions = payload.result.contributions ?? [];
  const rows = buildClaimsMatrix({ contributions, decision });
  renderClaimsMatrixInto($("#claims-matrix"), rows);

  const legacyBand = payload.legacy_band ?? "D";
  const bayesianBand = payload.result.band;
  const posterior = payload.result.posterior;
  const hasIndependentEvidence = contributions.some(
    (c) => c.source_kind === "decision_accept" || (c.source_tier && c.source_tier <= 2),
  );

  $("#confidence-donut-slot").innerHTML = renderDonut({
    band: legacyBand,
    posterior: hasIndependentEvidence ? posterior : null,
  });
  $("#confidence-band-scale-slot").innerHTML = renderBandScale({ band: legacyBand });
  const interp = $("#confidence-interpretation");
  const supports = contributions.filter((c) => c.lr > 1).length;
  const conflicts = contributions.filter((c) => c.lr < 1 || c.source_kind === "reviewer").length;
  if (!hasIndependentEvidence) {
    interp.textContent = `Band ${legacyBand} from imported records. Run the agent to gather Bayesian-grade evidence.`;
  } else {
    let t = `Band ${legacyBand} · Bayesian posterior ${(posterior * 100).toFixed(1)}% · ${supports} supporting source${supports === 1 ? "" : "s"}.`;
    if (conflicts > 0) t += ` ${conflicts} conflict${conflicts === 1 ? "" : "s"} flagged.`;
    if (bayesianBand && bayesianBand !== legacyBand)
      t += ` (Bayesian band would be ${bayesianBand} — surface for review.)`;
    interp.textContent = t;
  }

  const [allFindings, kbResp] = await Promise.all([
    fetchReviewOnce(),
    fetch("/api/kb").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (state.selectedId !== id) return;
  const myFindings = allFindings.filter((f) => f.individual_id === id);
  const reresearch = kbResp?.reresearch_recommended?.[id] ?? null;
  const contradictionsCount = contributions.filter((c) => c.lr < 1).length;
  renderNextStepsInto($("#next-steps-list"), {
    reviewerFindings: myFindings,
    reresearch,
    contradictions: contradictionsCount,
  });
};

// ---- Selection ----
const selectPerson = async (id) => {
  state.selectedId = id;
  if (state.streaming) cancelStream();
  renderList();
  $("#empty-state").hidden = true;
  $("#detail").hidden = false;
  $("#status").hidden = true;
  $("#decision-bar").hidden = false;

  const p = state.individuals.find((x) => x.id === id);
  if (!p) return;
  $("#detail-header").innerHTML = `
    <h2>${escapeHtml(p.name)}</h2>
    <div class="meta">
      b.${p.birth_year ?? "?"} ·
      ${escapeHtml(p.birth_place || "place unknown")} ·
      Gen ${p.generation ?? "?"} ·
      <span class="badge ${p.confidence}">${p.confidence} ${CONF_LABEL[p.confidence] ?? ""}</span>
    </div>
    ${p.warnings?.length ? `<div class="warnings">⚠ ${p.warnings.map(escapeHtml).join(" · ")}</div>` : ""}
    ${p.alerts?.length ? `<div class="alerts">⛔ ${escapeHtml(p.alerts[0])}</div>` : ""}
  `;

  // Confidence + Claims Matrix (independent of agent narrative)
  fetch(`/api/confidence/${encodeURIComponent(id)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((payload) => {
      if (state.selectedId !== id || !payload) return;
      renderClaimsAndConfidence(id, payload, p.decision);
    })
    .catch(() => {});

  // Agent narrative
  const evRes = await fetch(`/api/evidence/${encodeURIComponent(id)}`);
  const ev = await evRes.json();
  if (state.selectedId !== id) return;
  if (ev) {
    renderResult(ev.agent_result);
    showDecisionButtons(true, p.decision);
  } else {
    $("#full-narrative").hidden = true;
    showDecisionButtons(false, null);
  }
};

const showDecisionButtons = (afterRun, currentDecision) => {
  $("#run-btn").textContent = afterRun ? "Re-run Agent" : "Run Agent";
  $("#run-btn").hidden = false;
  const showDecisions = afterRun && !currentDecision;
  $("#accept-btn").hidden = !showDecisions;
  $("#reject-btn").hidden = !showDecisions;
  $("#flag-btn").hidden = !showDecisions;
};

// ---- Agent run (SSE) ----
const runAgent = () => {
  const id = state.selectedId;
  if (!id) return;
  $("#run-btn").disabled = true;
  $("#status").hidden = false;
  $("#status-text").textContent = "Connecting to agent…";
  $("#status-query").textContent = "";
  $("#status-meta").textContent = "";
  $("#result").innerHTML = "";

  const accumulated = { text: "", searches: 0 };
  const es = new EventSource(`/api/agent/run/${encodeURIComponent(id)}`);
  state.streaming = { es, accumulated };

  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === "start") $("#status-text").textContent = "Agent running…";
    else if (event.type === "search") {
      accumulated.searches += 1;
      $("#status-text").textContent = `Web search ${accumulated.searches} running…`;
      $("#status-query").textContent = event.query;
    } else if (event.type === "text") {
      accumulated.text += event.text;
      renderResult(accumulated.text);
    } else if (event.type === "done") {
      const u = event.result.usage;
      $("#status-meta").textContent = `Done. ${event.result.search_count} searches · ${u.input_tokens + u.output_tokens} tokens`;
    } else if (event.type === "saved") {
      cleanupStream();
      fetchIndividuals().then(() => selectPerson(id));
    } else if (event.type === "error") {
      $("#status-text").textContent = `Error: ${event.message}`;
      $("#status-query").textContent = "";
      cleanupStream();
    }
  };
  es.onerror = () => {
    if (state.streaming) {
      $("#status-text").textContent = "Connection lost.";
      cleanupStream();
    }
  };
};

const cancelStream = () => {
  if (!state.streaming) return;
  state.streaming.es.close();
  cleanupStream();
};
const cleanupStream = () => {
  if (state.streaming) {
    state.streaming.es.close();
    state.streaming = null;
  }
  $("#run-btn").disabled = false;
};

// ---- Decisions ----
const submitDecision = async (payload) => {
  const id = state.selectedId;
  const res = await fetch(`/api/decision/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(`Could not save decision: ${err.error}`);
    return;
  }
  await fetchIndividuals();
  selectPerson(id);
};

const wireDialogs = () => {
  $("#accept-btn").addEventListener("click", () => $("#accept-dialog").showModal());
  $("#flag-btn").addEventListener("click", () => $("#flag-dialog").showModal());
  $("#reject-btn").addEventListener("click", () => {
    if (confirm("Mark this individual as no match found?")) {
      submitDecision({ decision: "rejected" });
    }
  });
  $("#accept-dialog").addEventListener("close", (e) => {
    const dlg = e.currentTarget;
    if (dlg.returnValue !== "confirm") return;
    const fd = new FormData(dlg.querySelector("form"));
    submitDecision({
      decision: "accepted",
      citation: {
        title: fd.get("title"),
        repository: fd.get("repository"),
        reference: fd.get("reference"),
        url: fd.get("url") || null,
      },
      new_confidence: fd.get("new_confidence"),
      note: fd.get("note") || null,
    });
    dlg.querySelector("form").reset();
  });
  $("#flag-dialog").addEventListener("close", (e) => {
    const dlg = e.currentTarget;
    if (dlg.returnValue !== "confirm") return;
    const fd = new FormData(dlg.querySelector("form"));
    submitDecision({ decision: "flagged", note: fd.get("note") });
    dlg.querySelector("form").reset();
  });
};

const wireFilters = () => {
  // Initialise dropdowns from URL
  initialFilterFromUrl();
  $("#band-filter").value = state.filter.band;
  $("#decision-filter").value = state.filter.decision;
  $("#search-filter").value = state.filter.search;

  $("#band-filter").addEventListener("change", (e) => {
    state.filter.band = e.target.value;
    renderList();
  });
  $("#decision-filter").addEventListener("change", (e) => {
    state.filter.decision = e.target.value;
    renderList();
  });
  $("#search-filter").addEventListener("input", (e) => {
    state.filter.search = e.target.value;
    renderList();
  });
};

$("#run-btn").addEventListener("click", runAgent);
$("#stop-btn").addEventListener("click", cancelStream);
wireFilters();
wireDialogs();
fetchIndividuals();
