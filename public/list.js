const CONF_LABEL = { A: "VERIFIED", B: "PROBABLE", C: "UNCERTAIN", D: "UNVERIFIED" };

const state = {
  individuals: [],
  filter: "all",
  selectedId: null,
  streaming: null, // { eventSource, accumulated }
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fetchIndividuals = async () => {
  const res = await fetch("/api/individuals");
  state.individuals = await res.json();
  renderList();
};

const filteredIndividuals = () => {
  const all = state.individuals.filter((p) =>
    state.filter === "all" ? p.confidence === "C" || p.confidence === "D" : p.confidence === state.filter,
  );
  return all.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "D" ? -1 : 1;
    return (b.generation ?? 0) - (a.generation ?? 0);
  });
};

const renderList = () => {
  const ul = $("#people");
  ul.innerHTML = "";
  for (const p of filteredIndividuals()) {
    const li = document.createElement("li");
    if (p.id === state.selectedId) li.classList.add("selected");
    li.dataset.id = p.id;
    const decisionTag = p.decision
      ? `<span class="decision-tag ${p.decision}">${p.decision}</span>`
      : "";
    const tick = p.researched ? '<span class="tick">✓ researched</span>' : "";
    li.innerHTML = `
      <div>
        <span class="person-name">${escapeHtml(p.name || "Unknown")}</span>
        <span class="badge ${p.confidence}">${p.confidence}</span>
      </div>
      <div class="person-meta">
        Gen ${p.generation} · b.${p.birth_year ?? "?"} ·
        ${escapeHtml(p.birth_place || "place unknown")}
        ${tick}${decisionTag}
      </div>
    `;
    li.addEventListener("click", () => selectPerson(p.id));
    ul.appendChild(li);
  }
};

const selectPerson = async (id) => {
  state.selectedId = id;
  if (state.streaming) cancelStream();
  renderList();
  $("#empty-state").hidden = true;
  $("#detail").hidden = false;
  $("#status").hidden = true;
  $("#decision-bar").hidden = false;

  const p = state.individuals.find((x) => x.id === id);
  $("#detail-header").innerHTML = `
    <h2>${escapeHtml(p.name)}</h2>
    <div class="meta">
      b.${p.birth_year ?? "?"} ·
      ${escapeHtml(p.birth_place || "place unknown")} ·
      Gen ${p.generation} ·
      <span class="badge ${p.confidence}">${p.confidence} ${CONF_LABEL[p.confidence] ?? ""}</span>
    </div>
    ${p.warnings?.length ? `<div class="warnings">⚠ ${p.warnings.map(escapeHtml).join(" · ")}</div>` : ""}
    ${p.alerts?.length ? `<div class="alerts">⛔ ${escapeHtml(p.alerts[0])}</div>` : ""}
  `;

  // Load saved evidence if it exists
  const evRes = await fetch(`/api/evidence/${encodeURIComponent(id)}`);
  const ev = await evRes.json();
  if (ev) {
    renderResult(ev.agent_result);
    showDecisionButtons(true, p.decision);
  } else {
    $("#result").innerHTML = '<p class="muted">No research run yet for this individual. Click <strong>Run Agent</strong> to begin.</p>';
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

const renderResult = (text) => {
  // Light markdown rendering: headings + line breaks. Keep raw text otherwise.
  const safe = escapeHtml(text);
  const html = safe.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  $("#result").innerHTML = html;
};

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
    if (event.type === "start") {
      $("#status-text").textContent = "Agent running…";
    } else if (event.type === "search") {
      accumulated.searches += 1;
      $("#status-text").textContent = `Web search ${accumulated.searches} running…`;
      $("#status-query").textContent = event.query;
    } else if (event.type === "text") {
      accumulated.text += event.text;
      // Stream into result panel as it arrives
      renderResult(accumulated.text);
    } else if (event.type === "done") {
      const u = event.result.usage;
      $("#status-meta").textContent = `Done. ${event.result.search_count} searches · ${u.input_tokens + u.output_tokens} tokens`;
    } else if (event.type === "saved") {
      cleanupStream();
      // Reload the individual list to update researched flag
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
  for (const btn of $$("#filters button")) {
    btn.addEventListener("click", () => {
      $$("#filters button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.filter = btn.dataset.filter;
      renderList();
    });
  }
};

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

$("#run-btn").addEventListener("click", runAgent);
$("#stop-btn").addEventListener("click", cancelStream);
wireFilters();
wireDialogs();
fetchIndividuals();
