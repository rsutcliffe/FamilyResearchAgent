// Pedigree tree view: root at bottom, ancestors above (paternal left, maternal
// right), with confidence-coloured cards and connector lines. Click a card to
// open the detail panel and run the Record Discovery agent.

const ROOT_ID = "@I1825902591@"; // Richard David Sutcliffe
const CONF_LABEL = { A: "VERIFIED", B: "PROBABLE", C: "UNCERTAIN", D: "UNVERIFIED" };
const CARD_W = 140;
const CARD_H = 78;
const SLOT_W = 170; // horizontal slot spacing at deepest generation
const ROW_H = 130; // vertical generation spacing
const PADDING = 80;

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
  families: [],
  byId: new Map(),
  famById: new Map(),
  childToFamily: new Map(),
  positions: new Map(), // id -> {x, y, generation, role}
  depth: 5,
  pan: { x: 0, y: 0 },
  zoom: 1,
  selectedId: null,
  streaming: null,
};

const fetchData = async () => {
  const [individuals, families, relationships, spend, kb] = await Promise.all([
    fetch("/api/individuals").then((r) => r.json()),
    fetch("/api/families").then((r) => r.json()),
    fetch("/api/relationships").then((r) => r.json()),
    fetch("/api/spend").then((r) => r.json()),
    fetch("/api/kb").then((r) => r.json()),
  ]);
  state.individuals = individuals;
  state.families = families;
  state.relationships = relationships;
  state.spend = spend;
  state.kb = kb;
  state.reresearchById = kb?.reresearch_recommended ?? {};
  state.byId = new Map(individuals.map((i) => [i.id, i]));
  state.famById = new Map(families.map((f) => [f.id, f]));
  state.linkByChildParent = new Map();
  for (const rel of relationships) {
    state.linkByChildParent.set(`${rel.child_id}:${rel.parent_id}`, rel);
  }
  state.researchedIds = new Set(individuals.filter((p) => p.researched).map((p) => p.id));
  state.decisionsById = Object.fromEntries(
    individuals.filter((p) => p.decision).map((p) => [p.id, p.decision]),
  );
  renderSpend();
};

const fmtUSD = (n) =>
  n >= 1 ? `$${n.toFixed(2)}` : `${(n * 100).toFixed(1)}¢`;

const renderSpend = () => {
  const s = state.spend;
  if (!s) return;
  const session = fmtUSD(s.session.cost);
  const lifetime = fmtUSD(s.lifetime.cost);
  const cap = s.session.cap > 0 ? ` / ${fmtUSD(s.session.cap)} cap` : "";
  const capWarn = s.session.cap_hit ? " ⛔" : "";
  $("#spend").innerHTML = `
    <span style="font-variant-numeric: tabular-nums;">
      Session <strong>${session}</strong>${cap}${capWarn} · Lifetime <strong>${lifetime}</strong>
    </span>
  `;
  $("#spend").title =
    `Session tokens: in ${s.session.tokens.input.toLocaleString()}, out ${s.session.tokens.output.toLocaleString()}\n` +
    `Lifetime tokens: in ${s.lifetime.tokens.input.toLocaleString()}, out ${s.lifetime.tokens.output.toLocaleString()}\n` +
    `Pricing: $${s.pricing.input_per_million}/M input, $${s.pricing.output_per_million}/M output, $${s.pricing.cache_read_per_million}/M cache-read`;
};

// Recursively place ancestors using slot allocation.
// Father in left half, mother in right half. Root at gen 0.
//
// Rules:
//   - Known people are placed up to gen <= state.depth.
//   - Placeholders for missing parents are placed up to gen <= state.depth + 1
//     (one row past the deepest known generation), so every leaf-of-the-tree
//     individual visibly invites further research.
const placeAncestors = (personId, gen, xLeft, xRight, role = "self") => {
  if (!personId || gen > state.depth) return;
  if (state.positions.has(personId)) return;
  const xMid = (xLeft + xRight) / 2;
  state.positions.set(personId, {
    x: xMid,
    y: -gen * ROW_H,
    generation: gen,
    role,
  });

  const nextGen = gen + 1;
  if (nextGen > state.depth + 1) return;

  const ind = state.byId.get(personId);
  const fam = ind?.famc ? state.famById.get(ind.famc) : null;
  const fatherKnownAndInDepth = fam?.husband && nextGen <= state.depth;
  const motherKnownAndInDepth = fam?.wife && nextGen <= state.depth;

  if (fatherKnownAndInDepth) {
    placeAncestors(fam.husband, nextGen, xLeft, xMid, "father");
  } else {
    placePlaceholder(personId, "father", nextGen, xLeft, xMid);
  }
  if (motherKnownAndInDepth) {
    placeAncestors(fam.wife, nextGen, xMid, xRight, "mother");
  } else {
    placePlaceholder(personId, "mother", nextGen, xMid, xRight);
  }
};

const placePlaceholder = (childId, role, gen, xLeft, xRight) => {
  if (gen > state.depth + 1) return;
  const id = `__placeholder__${childId}__${role}`;
  const xMid = (xLeft + xRight) / 2;
  state.positions.set(id, {
    x: xMid,
    y: -gen * ROW_H,
    generation: gen,
    role,
    isPlaceholder: true,
    childId,
    placeholderId: id,
  });
};

const computeLayout = () => {
  state.positions.clear();
  const totalSlots = Math.pow(2, state.depth);
  const totalW = totalSlots * SLOT_W;
  placeAncestors(ROOT_ID, 0, 0, totalW);
  computeChainWeakness();
};

// For each placed individual, compute the weakest LINK confidence on the
// chain from root down to them. This is the primary anti-cascade signal:
// an A-band person whose chain to root passes through a C-band link is
// effectively only as well-anchored as that C-band link allows.
const BAND_RANK = { A: 4, B: 3, C: 2, D: 1 };
const bandMin = (a, b) =>
  (BAND_RANK[a] ?? 0) <= (BAND_RANK[b] ?? 0) ? a : b;

const computeChainWeakness = () => {
  state.chainWeakness = new Map(); // personId -> {band, weakestLinkId}
  const recur = (id, weakestBand, weakestLinkId) => {
    state.chainWeakness.set(id, { band: weakestBand, weakestLinkId });
    const ind = state.byId.get(id);
    const fam = ind?.famc ? state.famById.get(ind.famc) : null;
    if (!fam) return;
    for (const parentId of [fam.husband, fam.wife]) {
      if (!parentId) continue;
      if (!state.positions.has(parentId)) continue;
      const link = state.linkByChildParent.get(`${id}:${parentId}`);
      const linkBand = link?.confidence ?? "D";
      const newBand = bandMin(weakestBand, linkBand);
      const newLinkId =
        BAND_RANK[linkBand] < BAND_RANK[weakestBand] ? link?.id : weakestLinkId;
      recur(parentId, newBand, newLinkId);
    }
  };
  recur(ROOT_ID, "A", null);
};

const renderCards = () => {
  const cardsEl = $("#cards");
  cardsEl.innerHTML = "";

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const { x, y } of state.positions.values()) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  // Offset so all coordinates are positive
  const offsetX = -minX + PADDING;
  const offsetY = -minY + PADDING;
  const totalW = maxX - minX + PADDING * 2;
  const totalH = maxY - minY + PADDING * 2 + 40; // +40 for role tags below cards

  $("#tree-pan").style.width = `${totalW}px`;
  $("#tree-pan").style.height = `${totalH}px`;
  $("#connections").setAttribute("width", totalW);
  $("#connections").setAttribute("height", totalH);
  $("#connections").setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);

  for (const [id, pos] of state.positions) {
    const card = document.createElement("div");
    card.style.left = `${pos.x + offsetX}px`;
    card.style.top = `${pos.y + offsetY}px`;
    card.style.transform = "translate(-50%, -50%)";

    if (pos.isPlaceholder) {
      const child = state.byId.get(pos.childId);
      const childName = child?.name?.split(" ").slice(-1)[0] ?? "?";
      card.className = "card placeholder";
      card.dataset.placeholder = id;
      card.innerHTML = `
        <div class="placeholder-icon">?</div>
        <div class="name">${pos.role === "father" ? "Unknown father" : "Unknown mother"}</div>
        <div class="dates muted">of ${escapeHtml(childName)}</div>
      `;
      card.addEventListener("click", (e) => {
        e.stopPropagation();
        selectPlaceholder(pos);
      });
      cardsEl.appendChild(card);
      continue;
    }

    const ind = state.byId.get(id);
    if (!ind) continue;
    card.className = `card ${ind.confidence}`;
    if (state.researchedIds.has(id)) card.classList.add("researched");
    if (state.decisionsById[id]) {
      card.classList.add("decision-tag", `decision-${state.decisionsById[id]}`);
      card.dataset.decision = state.decisionsById[id];
    }
    if (state.reresearchById?.[id]) {
      card.classList.add("reresearch-recommended");
      card.title = `Re-research recommended: ${state.reresearchById[id].reason}`;
    }
    if (id === state.selectedId) card.classList.add("selected");
    card.dataset.id = id;
    const dates = `${ind.birth_year ?? "?"}${ind.death_date ? "–" + (ind.death_date.match(/\d{4}/)?.[0] ?? "") : ""}`;
    // Chain weakness: if the chain from root passes through a weaker link
    // than this person's own band, mark them visually so cascading-error
    // risk is surfaced.
    const chain = state.chainWeakness?.get(id);
    const cascadeRisk =
      chain && BAND_RANK[chain.band] < BAND_RANK[ind.confidence];
    if (cascadeRisk) card.classList.add("cascade-risk");
    if (state.highlightWeakLinks && chain?.weakestLinkId) {
      card.classList.add("on-weak-chain");
    }
    card.innerHTML = `
      <div class="name">${escapeHtml(ind.name || "Unknown")}</div>
      <div class="dates">${dates}</div>
      <div class="place">${escapeHtml(ind.birth_place || "")}</div>
      ${cascadeRisk ? `<div class="chain-warning" title="Chain weakness: ${chain.band} (own band ${ind.confidence})">⚠ chain ${chain.band}</div>` : ""}
      ${pos.role !== "self" && pos.generation <= 2 ? `<div class="role-tag">${roleLabel(pos)}</div>` : ""}
    `;
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      selectPerson(id);
    });
    cardsEl.appendChild(card);
  }

  drawConnections(offsetX, offsetY);
  centerOnRoot(totalW, totalH);
  renderStats();
};

const roleLabel = (pos) => {
  if (pos.generation === 1) return pos.role === "father" ? "Father" : "Mother";
  if (pos.generation === 2)
    return pos.role === "father" ? "Grandfather" : "Grandmother";
  return "";
};

const drawConnections = (offsetX, offsetY) => {
  const svg = $("#connections");
  svg.innerHTML = "";
  // For each placed real individual, draw a line up to each parent (real or
  // placeholder). Line colour comes from the parent's confidence band; for
  // placeholders, render as a faint dashed gray.
  for (const [id, pos] of state.positions) {
    if (pos.isPlaceholder) continue;
    const ind = state.byId.get(id);
    const fam = ind?.famc ? state.famById.get(ind.famc) : null;
    const parents = [
      { parentId: fam?.husband, role: "father" },
      { parentId: fam?.wife, role: "mother" },
    ];
    for (const { parentId, role } of parents) {
      let ppos, lineClass, link = null;
      if (parentId) {
        ppos = state.positions.get(parentId);
        const parent = state.byId.get(parentId);
        if (!ppos || !parent) continue;
        // LINK confidence drives line colour, not the parent's own confidence —
        // this is the central anti-cascade visualisation.
        link = state.linkByChildParent.get(`${id}:${parentId}`);
        lineClass = link?.confidence ?? parent.confidence;
      } else {
        const phId = `__placeholder__${id}__${role}`;
        ppos = state.positions.get(phId);
        if (!ppos) continue;
        lineClass = "placeholder";
      }
      const x1 = pos.x + offsetX;
      const y1 = pos.y + offsetY - CARD_H / 2;
      const x2 = ppos.x + offsetX;
      const y2 = ppos.y + offsetY + CARD_H / 2;
      const midY = (y1 + y2) / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
      );
      path.setAttribute("class", lineClass);
      if (link) {
        path.dataset.linkId = link.id;
        path.dataset.childId = id;
        path.dataset.parentId = parentId;
        path.style.pointerEvents = "stroke";
        path.style.cursor = "pointer";
        path.addEventListener("click", (e) => {
          e.stopPropagation();
          openLinkDialog(link);
        });
        // Mark the WEAKEST LINK in each chain — the single most important
        // verification target per ancestor line.
        if (state.highlightWeakLinks) {
          const isWeakestForSomeChain = Array.from(state.chainWeakness.values()).some(
            (cw) => cw.weakestLinkId === link.id,
          );
          if (isWeakestForSomeChain) path.classList.add("weakest");
        }
      }
      svg.appendChild(path);
    }
  }
};

const renderStats = () => {
  const counts = state.individuals.reduce(
    (acc, i) => ((acc[i.confidence] = (acc[i.confidence] ?? 0) + 1), acc),
    {},
  );
  const placed = state.positions.size;
  $("#stats").innerHTML = `
    Placed: <strong>${placed}</strong> of ${state.individuals.length} ·
    <span style="color:#1f6b3a">A: ${counts.A ?? 0}</span> ·
    <span style="color:#1f497d">B: ${counts.B ?? 0}</span> ·
    <span style="color:#bf6f00">C: ${counts.C ?? 0}</span> ·
    <span style="color:#c00000">D: ${counts.D ?? 0}</span>
  `;
};

const centerOnRoot = (totalW, totalH) => {
  const canvas = $("#canvas");
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  // Root is at bottom-center of the laid-out content
  const rootPos = state.positions.get(ROOT_ID);
  if (!rootPos) return;
  const cardsEl = $("#cards");
  // Root card has style.left/top in pixels relative to tree-pan; we want it to
  // sit at canvas center horizontally and ~80% down vertically.
  const rootCard = cardsEl.querySelector(`[data-id="${ROOT_ID}"]`);
  if (!rootCard) return;
  const targetX = cw / 2 - parseFloat(rootCard.style.left);
  const targetY = ch * 0.82 - parseFloat(rootCard.style.top);
  state.pan = { x: targetX, y: targetY };
  state.zoom = 1;
  applyTransform();
};

const applyTransform = () => {
  $("#tree-pan").style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
};

// ----- Pan & zoom ------------------------------------------------------------

const wirePanZoom = () => {
  const canvas = $("#canvas");
  let dragging = false;
  let lastX = 0,
    lastY = 0;

  canvas.addEventListener("mousedown", (e) => {
    if (e.target.closest(".card") || e.target.closest("#detail-panel")) return;
    dragging = true;
    canvas.classList.add("panning");
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    state.pan.x += e.clientX - lastX;
    state.pan.y += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyTransform();
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    canvas.classList.remove("panning");
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.001;
      const newZoom = Math.max(0.25, Math.min(2.0, state.zoom * (1 + delta)));
      // Zoom toward cursor
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const ratio = newZoom / state.zoom;
      state.pan.x = cx - (cx - state.pan.x) * ratio;
      state.pan.y = cy - (cy - state.pan.y) * ratio;
      state.zoom = newZoom;
      applyTransform();
    },
    { passive: false },
  );

  $("#zoom-in").addEventListener("click", () => {
    state.zoom = Math.min(2.0, state.zoom * 1.2);
    applyTransform();
  });
  $("#zoom-out").addEventListener("click", () => {
    state.zoom = Math.max(0.25, state.zoom / 1.2);
    applyTransform();
  });
  $("#reset-view").addEventListener("click", () => {
    const rootCard = $(`[data-id="${ROOT_ID}"]`);
    if (rootCard) {
      const cw = $("#canvas").clientWidth;
      const ch = $("#canvas").clientHeight;
      state.pan.x = cw / 2 - parseFloat(rootCard.style.left);
      state.pan.y = ch * 0.82 - parseFloat(rootCard.style.top);
      state.zoom = 1;
      applyTransform();
    }
  });
};

// ----- Detail panel + agent run ---------------------------------------------

const selectPlaceholder = (pos) => {
  if (state.streaming) cancelStream();
  state.selectedId = null;
  state.selectedPlaceholder = pos;
  $$(".card.selected").forEach((c) => c.classList.remove("selected"));
  $(`[data-placeholder="${pos.placeholderId}"]`)?.classList.add("selected");

  const child = state.byId.get(pos.childId);
  if (!child) return;

  $("#detail-panel").hidden = false;
  $("#status").hidden = true;
  $("#decision-bar").hidden = false;

  const role = pos.role === "father" ? "Father" : "Mother";
  const childYear = child.birth_year ?? "?";
  const childPlace = child.birth_place || "place unknown";

  $("#detail-header").innerHTML = `
    <h2>Unknown ${role}</h2>
    <div class="meta">
      Generation ${pos.generation} · ${role.toLowerCase()} of <strong>${escapeHtml(child.name)}</strong>
      (b.${childYear} · ${escapeHtml(childPlace)})
    </div>
    <div class="warnings">⚠ No parent record in GEDCOM. Ancestor Discovery agent will use the child's data as the only anchor.</div>
  `;

  const fam = child.famc ? state.famById.get(child.famc) : null;
  const otherParentId = fam ? (pos.role === "father" ? fam.wife : fam.husband) : null;
  const otherParent = otherParentId ? state.byId.get(otherParentId) : null;

  $("#result").innerHTML = `
    <h2>Anchors available for this search</h2>
    <ul style="margin:8px 0; padding-left:20px;">
      <li>Child <strong>${escapeHtml(child.name)}</strong>, b.${childYear}, ${escapeHtml(childPlace)}, confidence <strong>${child.confidence}</strong></li>
      ${otherParent ? `<li>Spouse <strong>${escapeHtml(otherParent.name)}</strong>, b.${otherParent.birth_year ?? "?"}, ${escapeHtml(otherParent.birth_place || "place unknown")}, confidence <strong>${otherParent.confidence}</strong></li>` : `<li class="muted">No spouse record (the other parent is also unknown)</li>`}
    </ul>
    <p class="muted">Clicking <strong>Find this Ancestor</strong> spawns the Ancestor Discovery agent. The agent will propose a candidate parent and quote the evidence linking them to ${escapeHtml(child.name)}. Acceptance creates a new individual and a new parent-child relationship in the tree.</p>
  `;

  // Reuse the run button — re-label and rewire to ancestor discovery
  $("#run-btn").hidden = false;
  $("#run-btn").textContent = `Find this ${role}`;
  $("#run-btn").disabled = false;
  $("#accept-btn").hidden = true;
  $("#reject-btn").hidden = true;
  $("#flag-btn").hidden = true;
};

const selectPerson = async (id) => {
  state.selectedId = id;
  state.selectedPlaceholder = null;
  $$(".card.selected").forEach((c) => c.classList.remove("selected"));
  $(`[data-id="${id}"]`)?.classList.add("selected");

  if (state.streaming) cancelStream();

  $("#detail-panel").hidden = false;
  $("#status").hidden = true;
  $("#decision-bar").hidden = false;

  const p = state.byId.get(id);
  const indSpend = state.spend?.by_individual?.[id];
  const spendLine = indSpend
    ? `<div class="muted" style="font-size:11px; margin-top:4px;">Spent on this person: <strong>${fmtUSD(indSpend.cost)}</strong> · ${indSpend.runs} run(s) · ${indSpend.input_tokens.toLocaleString()} in / ${indSpend.output_tokens.toLocaleString()} out</div>`
    : "";
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
    ${state.reresearchById?.[id] ? `<div class="reresearch-banner">↻ ${escapeHtml(state.reresearchById[id].reason)} — re-running this individual now will use the fresh KB context.</div>` : ""}
    ${spendLine}
  `;

  const evRes = await fetch(`/api/evidence/${encodeURIComponent(id)}`);
  const ev = await evRes.json();
  state.currentEvidence = ev;
  if (ev) {
    renderResult(ev.agent_result);
    renderExternalLookupsSection(ev);
    showDecisionButtons(true, state.decisionsById[id]);
  } else {
    $("#result").innerHTML =
      '<p class="muted">No research run yet. Click <strong>Run Agent</strong> to begin.</p>';
    showDecisionButtons(false, null);
  }
};

// Render the "External lookups" section after the agent result. Combines
// the agent's <<EXTERNAL_LOOKUPS>> suggestions with already-consulted
// paid_lookups so the user sees both at a glance.
const renderExternalLookupsSection = (ev) => {
  const proposed = parseExternalLookups(ev?.agent_result ?? "");
  const done = ev?.paid_lookups ?? [];
  // Suppress proposed lookups whose service name is already in done
  const doneServices = new Set(
    done.map((d) => (d.service ?? "").toLowerCase()),
  );
  const fresh = proposed.filter(
    (p) => !doneServices.has((p.service ?? "").toLowerCase()),
  );

  let html = `<h3 style="margin: 18px 0 8px; font-size:14px; color:#1f3864;">External lookups</h3>`;

  if (done.length > 0) {
    html += `<div class="muted" style="font-size:11px; margin-bottom:6px;">Already consulted for this individual:</div>`;
    html += `<ul style="margin:0 0 10px; padding-left:18px; font-size:12px;">`;
    for (const d of done) {
      const out = d.outcome === "found" ? "✓ found" : "✗ not found";
      html += `<li>${escapeHtml(d.service)} — <strong>${out}</strong> on ${(d.consulted_at ?? "").slice(0, 10)}${d.note ? ` — ${escapeHtml(d.note)}` : ""}</li>`;
    }
    html += `</ul>`;
  }

  if (fresh.length > 0) {
    html += `<div class="muted" style="font-size:11px; margin-bottom:6px;">Suggested lookups (open in your subscription, then record the outcome):</div>`;
    for (const lk of fresh) {
      html += `
        <div class="external-lookup">
          <div class="external-lookup-head">
            <strong>${escapeHtml(lk.service)}</strong>
            <span class="muted">${escapeHtml(lk.reason)}</span>
          </div>
          <div class="external-lookup-actions">
            <a href="${escapeHtml(lk.url)}" target="_blank" rel="noopener noreferrer" class="lookup-open-btn">Open</a>
            <button class="lookup-record-btn" data-service="${escapeHtml(lk.service)}" data-url="${escapeHtml(lk.url)}">Record outcome</button>
          </div>
        </div>`;
    }
  } else if (done.length === 0) {
    html += `<p class="muted" style="font-size:12px;">The agent didn't suggest any paywalled lookups for this run.</p>`;
  }

  // Always offer a generic "add manual evidence" button
  html += `<button id="add-manual-evidence-btn" class="add-manual" style="margin-top:10px;">Add evidence I found elsewhere</button>`;

  // Append/replace the section below #result
  let section = $("#external-lookups-section");
  if (!section) {
    section = document.createElement("section");
    section.id = "external-lookups-section";
    $("#result").after(section);
  }
  section.innerHTML = html;

  // Wire button handlers
  for (const btn of section.querySelectorAll(".lookup-record-btn")) {
    btn.addEventListener("click", () => {
      openManualEvidenceDialog({
        service: btn.dataset.service,
        url: btn.dataset.url,
      });
    });
  }
  $("#add-manual-evidence-btn").addEventListener("click", () => {
    openManualEvidenceDialog({ service: "manual", url: "" });
  });
};

const openManualEvidenceDialog = ({ service, url }) => {
  const dlg = $("#manual-evidence-dialog");
  const form = dlg.querySelector("form");
  form.reset();
  dlg.querySelector("[name='service']").value = service;
  dlg.querySelector("[name='url']").value = url;
  dlg.querySelector(".me-service-label").textContent = service;
  // Clear required-ness on found-fields until outcome=found
  toggleManualEvidenceFoundFields(dlg, false);
  dlg.showModal();
};

const toggleManualEvidenceFoundFields = (dlg, isFound) => {
  const fs = dlg.querySelector(".me-found-fields");
  fs.style.display = isFound ? "" : "none";
  for (const input of fs.querySelectorAll("input, select")) {
    if (isFound && (input.name === "title" || input.name === "repository" || input.name === "reference" || input.name === "new_confidence")) {
      input.required = true;
    } else {
      input.required = false;
    }
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

// Strip the machine-readable trailing blocks (NEGATIVE_SEARCHES, etc.) before
// rendering — they're for the parser, not the human reader.
const TRAILING_BLOCKS_RE = /<<[A-Z_]+>>[\s\S]*?<<\/[A-Z_]+>>/g;

// Parse the agent's <<EXTERNAL_LOOKUPS>> trailing block — paywalled databases
// the user could check directly. Each entry: { service, url, reason }.
const parseExternalLookups = (text) => {
  if (!text) return [];
  const m = text.match(/<<EXTERNAL_LOOKUPS>>\s*([\s\S]*?)\s*<<\/EXTERNAL_LOOKUPS>>/);
  if (!m) return [];
  return m[1]
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length && !/^NONE$/i.test(l))
    .map((l) => {
      const parts = l.split("||").map((p) => p.trim());
      if (parts.length < 3) return null;
      const [service, url, reason] = parts;
      if (!service || !url) return null;
      return { service, url, reason };
    })
    .filter(Boolean);
};

// Focused markdown renderer: headings, tables, lists, bold/italic, links,
// blockquotes, hr, paragraphs. Deliberately small — agent output has
// predictable structure, and a heavyweight library isn't justified.
const renderMarkdown = (text) => {
  if (!text) return "";

  let md = text.replace(TRAILING_BLOCKS_RE, "").trim();

  // 1. Escape raw HTML
  md = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // 2. Tables: blocks of consecutive lines starting/ending with |
  md = md.replace(
    /(?:^\|[^\n]*\|[\t ]*$\n?){2,}/gm,
    (match) => {
      const lines = match.trim().split("\n");
      const rows = lines.map((l) =>
        l
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim()),
      );
      const isSep = (row) => row.every((c) => /^[-:\s]*$/.test(c));
      const head = rows[0];
      const body = rows.slice(1).filter((r) => !isSep(r));
      const th = head.map((c) => `<th>${c}</th>`).join("");
      const tbody = body
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
        .join("");
      return `\n\n<table><thead><tr>${th}</tr></thead><tbody>${tbody}</tbody></table>\n\n`;
    },
  );

  // 3. Headings
  md = md.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  md = md.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  md = md.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  md = md.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  md = md.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // 4. Horizontal rules
  md = md.replace(/^[-*_]{3,}\s*$/gm, "<hr/>");

  // 5. Blockquotes
  md = md.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");

  // 6. Bold + italic. Bold first (two stars), then italic. Use lookarounds
  //    to avoid eating starts of lines or list markers.
  md = md.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  md = md.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "<em>$1</em>");
  md = md.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, "<em>$1</em>");

  // 7. Inline code
  md = md.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // 8. Links [text](url)
  md = md.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  // 9. Lists. Match leading `- ` or `* ` or `N. ` patterns.
  md = md.replace(/^[ \t]*(?:[-*]|\d+\.)\s+(.+)$/gm, "<li>$1</li>");
  // Wrap consecutive <li> blocks in <ul>
  md = md.replace(
    /(?:^[ \t]*<li>[\s\S]*?<\/li>(?:\n[ \t]*<li>[\s\S]*?<\/li>)*)/gm,
    (match) => `<ul>${match.replace(/\n/g, "")}</ul>`,
  );

  // 10. Paragraphs: split on blank lines; don't wrap block-level elements
  const blocks = md.split(/\n{2,}/);
  const out = blocks
    .map((b) => {
      const t = b.trim();
      if (!t) return "";
      if (/^<(h[1-6]|ul|ol|table|hr|blockquote|pre)/i.test(t)) return t;
      return `<p>${t.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");

  return out;
};

const renderResult = (text) => {
  $("#result").innerHTML = renderMarkdown(text);
};

const runAgent = () => {
  if (state.selectedPlaceholder) return runAncestorDiscovery();
  const id = state.selectedId;
  if (!id) return;
  if (!capCheck()) return;
  if (!cascadeCheck(id, "Record Discovery")) return;
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
      renderResult(accumulated.text);
    } else if (event.type === "done") {
      const u = event.result.usage;
      $("#status-meta").textContent = `Done. ${event.result.search_count} searches · ${u.input_tokens + u.output_tokens} tokens`;
      if (state.streaming) state.streaming.completed = true;
    } else if (event.type === "saved") {
      cleanupStream();
      // Show decision buttons immediately — don't wait for the data refresh.
      $("#status").hidden = true;
      showDecisionButtons(true, null);
      refreshAndReselect(id);
    } else if (event.type === "error") {
      $("#status-text").textContent = `Error: ${event.message}`;
      $("#status-query").textContent = "";
      cleanupStream();
    }
  };
  es.onerror = () => {
    // SSE fires onerror on every stream close — including clean completion
    // after we received a "done" event. Only treat as a real error if we
    // closed mid-stream without finishing.
    if (state.streaming && !state.streaming.completed) {
      $("#status-text").textContent = "Connection lost.";
      cleanupStream();
    }
  };
};

// Parse the Ancestor Discovery <<CANDIDATE_PARENTS>> block into structured
// candidates the user can accept. Format per line:
//   CANDIDATE_N||name||birth_year||birth_place||link_band||link_tier||link_citation
const parseCandidateParents = (text) => {
  if (!text) return [];
  const m = text.match(
    /<<CANDIDATE_PARENTS>>\s*([\s\S]*?)\s*<<\/CANDIDATE_PARENTS>>/,
  );
  if (!m) return [];
  const lines = m[1]
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length && !/^NONE$/i.test(l));
  return lines
    .map((line) => {
      const parts = line.split("||").map((p) => p.trim());
      if (parts.length < 7) return null;
      const [label, name, birth_year, birth_place, link_band, link_tier, link_citation] = parts;
      if (!name || !["A", "B", "C"].includes(link_band)) return null;
      return {
        label,
        name,
        birth_year: birth_year && birth_year !== "?" ? Number(birth_year) : null,
        birth_place,
        link_band,
        link_tier,
        link_citation,
      };
    })
    .filter(Boolean);
};

const renderCandidatePicker = (candidates, ph) => {
  const role = ph.role;
  const child = state.byId.get(ph.childId);
  if (!child) return;
  const list = candidates
    .map(
      (c, i) => `
    <div class="candidate-card" data-idx="${i}">
      <strong>${escapeHtml(c.name)}</strong>
      <span class="muted">${c.birth_year ?? "?"} · ${escapeHtml(c.birth_place || "place unknown")}</span>
      <div class="muted" style="margin-top:4px; font-size:11px;">
        Link confidence: <strong>${c.link_band}</strong> · ${escapeHtml(c.link_tier)} · ${escapeHtml(c.link_citation)}
      </div>
      <button class="primary accept-candidate-btn" data-idx="${i}" style="margin-top:8px;">
        Accept as ${role} of ${escapeHtml(child.name)}
      </button>
    </div>`,
    )
    .join("");
  const wrap = document.createElement("section");
  wrap.id = "candidate-picker";
  wrap.innerHTML = `
    <h3 style="margin: 18px 0 8px; font-size: 14px; color: #1f3864;">
      Proposed candidates (${candidates.length})
    </h3>
    <p class="muted" style="font-size: 12px;">
      Accepting a candidate creates a new individual, attaches them as the
      ${role} in a family record, and saves the parent-child link at the
      stated link confidence. The new individual starts at confidence C and
      will need its own Record Discovery run to be band-upgraded on its own
      merits.
    </p>
    ${list}
  `;
  // Append below the result text
  $("#result").appendChild(wrap);

  for (const btn of wrap.querySelectorAll(".accept-candidate-btn")) {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      acceptCandidate(candidates[idx], ph);
    });
  }
};

const acceptCandidate = async (candidate, ph) => {
  const child = state.byId.get(ph.childId);
  if (!child) return;
  const ok = confirm(
    `Accept "${candidate.name}" as ${ph.role} of ${child.name}?\n\n` +
      `This will:\n` +
      `  • Create a new individual record (confidence C)\n` +
      `  • Attach them as ${ph.role} in a family record with ${child.name} as child\n` +
      `  • Save the parent-child link at confidence ${candidate.link_band}\n\n` +
      `The new individual won't be band-upgraded until their own Record Discovery run.`,
  );
  if (!ok) return;

  const res = await fetch(
    `/api/ancestor/accept/${encodeURIComponent(ph.childId)}/${ph.role}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: candidate.name,
        birth_year: candidate.birth_year,
        birth_place: candidate.birth_place,
        link_confidence: candidate.link_band,
        link_evidence_type: candidate.link_tier,
        link_citation: candidate.link_citation,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.json();
    alert(`Could not accept candidate: ${err.error}`);
    return;
  }
  const { newIndividualId } = await res.json();
  await fetchData();
  computeLayout();
  renderCards();
  // Select the newly-created individual so the user can see it landed
  selectPerson(newIndividualId);
};

// Ancestor Discovery — uses /api/ancestor/run/:childId/:role
const runAncestorDiscovery = () => {
  const ph = state.selectedPlaceholder;
  if (!ph) return;
  if (!capCheck()) return;
  if (!cascadeCheck(ph.childId, "Ancestor Discovery")) return;
  $("#run-btn").disabled = true;
  $("#status").hidden = false;
  $("#status-text").textContent = "Searching for unknown ancestor…";
  $("#status-query").textContent = "";
  $("#status-meta").textContent = "";
  $("#result").innerHTML = "";

  const accumulated = { text: "", searches: 0 };
  const url = `/api/ancestor/run/${encodeURIComponent(ph.childId)}/${ph.role}`;
  const es = new EventSource(url);
  state.streaming = { es, accumulated };

  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === "start") {
      $("#status-text").textContent = "Ancestor Discovery agent running…";
    } else if (event.type === "search") {
      accumulated.searches += 1;
      $("#status-text").textContent = `Web search ${accumulated.searches} running…`;
      $("#status-query").textContent = event.query;
    } else if (event.type === "text") {
      accumulated.text += event.text;
      renderResult(accumulated.text);
    } else if (event.type === "done") {
      const u = event.result.usage;
      $("#status-meta").textContent = `Done. ${event.result.search_count} searches · ${u.input_tokens + u.output_tokens} tokens`;
      if (state.streaming) state.streaming.completed = true;
    } else if (event.type === "saved") {
      cleanupStream();
      $("#status").hidden = true;
      // Refresh spend so the topbar reflects the run's cost
      fetch("/api/spend")
        .then((r) => r.json())
        .then((s) => {
          state.spend = s;
          renderSpend();
        });
      // Parse candidate parents from the agent output and offer Accept buttons
      const candidates = parseCandidateParents(accumulated.text);
      if (candidates.length > 0) {
        renderCandidatePicker(candidates, ph);
      }
    } else if (event.type === "error") {
      $("#status-text").textContent = `Error: ${event.message}`;
      cleanupStream();
    }
  };
  es.onerror = () => {
    // SSE fires onerror on every stream close — including clean completion
    // after we received a "done" event. Only treat as a real error if we
    // closed mid-stream without finishing.
    if (state.streaming && !state.streaming.completed) {
      $("#status-text").textContent = "Connection lost.";
      cleanupStream();
    }
  };
};

const cancelStream = () => {
  if (!state.streaming) return;
  state.streaming.es.close();
  cleanupStream();
  $("#status-text").textContent = "Stopped by user.";
  $("#status-query").textContent = "";
};

const cleanupStream = () => {
  if (state.streaming) {
    state.streaming.es.close();
    state.streaming = null;
  }
  $("#run-btn").disabled = false;
};

const refreshAndReselect = async (id) => {
  await fetchData();
  computeLayout();
  renderCards();
  selectPerson(id);
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
  refreshAndReselect(id);
};

const wireDialogs = () => {
  $("#run-btn").addEventListener("click", runAgent);
  $("#stop-btn").addEventListener("click", cancelStream);
  $("#close-detail").addEventListener("click", () => {
    $("#detail-panel").hidden = true;
    if (state.streaming) cancelStream();
    state.selectedId = null;
    $$(".card.selected").forEach((c) => c.classList.remove("selected"));
  });
  $("#accept-btn").addEventListener("click", async () => {
    if (state.selectedId) await prefillAcceptDialog(state.selectedId);
    $("#accept-dialog").showModal();
  });
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

  // Manual evidence dialog: outcome dropdown toggles the found-fields
  $("#manual-evidence-dialog")?.addEventListener("change", (e) => {
    if (e.target.name === "outcome") {
      toggleManualEvidenceFoundFields($("#manual-evidence-dialog"), e.target.value === "found");
    }
  });
  $("#manual-evidence-dialog")?.addEventListener("close", async (e) => {
    const dlg = e.currentTarget;
    if (dlg.returnValue !== "confirm") return;
    const fd = new FormData(dlg.querySelector("form"));
    const outcome = fd.get("outcome");
    const id = state.selectedId;
    if (!id) return;
    const body = {
      service: fd.get("service"),
      url: fd.get("url"),
      outcome,
      note: fd.get("note") || null,
    };
    if (outcome === "found") {
      body.citation = {
        title: fd.get("title"),
        repository: fd.get("repository"),
        reference: fd.get("reference"),
        url: fd.get("url_field") || null,
      };
      body.new_confidence = fd.get("new_confidence");
    }
    const res = await fetch(`/api/manual-evidence/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(`Could not record evidence: ${err.error}`);
      return;
    }
    await fetchData();
    computeLayout();
    renderCards();
    selectPerson(id);
  });

  $("#link-dialog")?.addEventListener("close", (e) => {
    const dlg = e.currentTarget;
    if (dlg.returnValue !== "confirm") return;
    const fd = new FormData(dlg.querySelector("form"));
    submitLinkUpdate(fd);
  });
};

// Parse the agent's structured <<RECOMMENDED_CITATION>> block first; if
// that's not present (older results) fall back to parsing the free-form
// `## Recommendation` section.
const parseRecommendedCitation = (text) => {
  if (!text) return null;
  const m = text.match(
    /<<RECOMMENDED_CITATION>>\s*([\s\S]*?)\s*<<\/RECOMMENDED_CITATION>>/,
  );
  if (!m) return null;
  const body = m[1].trim();
  if (!body || /^NONE\s*$/i.test(body)) return null;
  // Take the first non-empty line
  const line = body.split(/\n/).map((l) => l.trim()).find((l) => l.length);
  if (!line || /^NONE\s*$/i.test(line)) return null;
  const parts = line.split("||").map((p) => p.trim());
  if (parts.length < 5) return null;
  const [title, repository, reference, url, new_confidence] = parts;
  if (!["A", "B", "C"].includes(new_confidence)) return null;
  return { title, repository, reference, url, new_confidence };
};

const parseRecommendationFreeForm = (text) => {
  if (!text) return null;
  const split = text.split(/^##\s+Recommendation\s*$/m);
  if (split.length < 2) return null;
  const stop = split[1].search(/^(##|<<)/m);
  const rec = stop > -1 ? split[1].slice(0, stop) : split[1];

  const stripBold = (s) => s?.replace(/\*\*/g, "").trim();
  const bandMatch = rec.match(/Recommended confidence band[:*\s]+\*?\*?\s*([ABC])\b/i);
  const citationMatch = rec.match(
    /Citation for GEDCOM write-back[:*\s]+\*?\*?\s*([\s\S]+?)(?:\n\s*\n|\n##|\n<<|$)/i,
  );

  const band = bandMatch?.[1]?.toUpperCase() ?? null;
  let citation = stripBold(citationMatch?.[1]) ?? "";
  if (!citation || /^none\b/i.test(citation) || /no match/i.test(citation)) {
    citation = "";
  }
  return { band, citation };
};

const prefillAcceptDialog = async (id) => {
  const dlg = $("#accept-dialog");
  dlg.querySelector("form").reset();
  try {
    const ev = await fetch(`/api/evidence/${encodeURIComponent(id)}`).then((r) =>
      r.json(),
    );
    if (!ev?.agent_result) return;

    // Prefer the structured RECOMMENDED_CITATION block — split into
    // title / repository / reference / url cleanly.
    const structured = parseRecommendedCitation(ev.agent_result);
    if (structured) {
      dlg.querySelector('[name="title"]').value = structured.title || "";
      dlg.querySelector('[name="repository"]').value = structured.repository || "";
      dlg.querySelector('[name="reference"]').value = structured.reference || "";
      dlg.querySelector('[name="url"]').value = structured.url || "";
      dlg.querySelector('[name="new_confidence"]').value = structured.new_confidence;
      dlg.querySelector('[name="note"]').value =
        "Pre-filled from agent's <<RECOMMENDED_CITATION>> block. Review before confirming.";
      return;
    }

    // Fallback: parse the free-form ## Recommendation section
    const free = parseRecommendationFreeForm(ev.agent_result);
    if (!free) return;
    if (free.band && ["A", "B", "C"].includes(free.band)) {
      dlg.querySelector('[name="new_confidence"]').value = free.band;
    }
    if (free.citation) {
      dlg.querySelector('[name="title"]').value = free.citation;
      dlg.querySelector('[name="note"]').value =
        "Pre-filled from agent's free-form recommendation. Re-run after the next deploy to get cleanly split repository/reference fields.";
    }
  } catch (e) {
    console.warn("Failed to prefill from agent result", e);
  }
};

// Spend cap pre-check. Server enforces this too (429), but a clear message
// before the request is much better UX than a "Connection lost" surprise.
const capCheck = () => {
  const s = state.spend?.session;
  if (!s || !s.cap || s.cap === 0) return true;
  if (!s.cap_hit) return true;
  alert(
    `Session spend cap of ${fmtUSD(s.cap)} reached (${fmtUSD(s.cost)} spent).\n\n` +
      `Restart the server to reset the session counter, or raise SESSION_CAP_USD in .env (then restart).`,
  );
  return false;
};

// Cascade pre-flight check. If the chain from root to this person passes
// through a link weaker than the user's threshold (default C), warn them.
// Refusing isn't possible — a "proceed anyway" path always exists — but the
// warning makes the cascade risk explicit before the API spend happens.
const CASCADE_THRESHOLD_BAND = "C";

const cascadeCheck = (anchorId, agentLabel) => {
  const chain = state.chainWeakness?.get(anchorId);
  if (!chain) return true;
  if (BAND_RANK[chain.band] >= BAND_RANK[CASCADE_THRESHOLD_BAND]) return true;
  if (BAND_RANK[chain.band] > BAND_RANK["D"] && state.cascadeAcknowledged?.has(anchorId)) {
    return true; // user already chose to proceed for this person this session
  }
  const weakLink = state.relationships.find((r) => r.id === chain.weakestLinkId);
  const parent = weakLink ? state.byId.get(weakLink.parent_id) : null;
  const child = weakLink ? state.byId.get(weakLink.child_id) : null;
  const detail = weakLink && parent && child
    ? `Weakest link: ${parent.name} → ${child.name} (band ${weakLink.confidence}, ${weakLink.kind}).`
    : "";
  const proceed = confirm(
    `Cascade risk warning\n\n` +
      `${agentLabel} on this individual will use the chain of relationships from root as anchors.\n\n` +
      `The chain to root passes through a band ${chain.band} link, below the threshold of ${CASCADE_THRESHOLD_BAND}.\n` +
      `${detail}\n\n` +
      `A false positive at the weak link would propagate: any candidate this run finds will inherit that uncertainty.\n\n` +
      `Recommended: verify the weakest link first by clicking the connection line and updating its confidence.\n\n` +
      `Proceed anyway?`,
  );
  if (proceed) {
    state.cascadeAcknowledged ??= new Set();
    state.cascadeAcknowledged.add(anchorId);
  }
  return proceed;
};

// ----- Link dialog (link-level confidence editor) ---------------------------

const openLinkDialog = (link) => {
  const child = state.byId.get(link.child_id);
  const parent = state.byId.get(link.parent_id);
  if (!child || !parent) return;
  const dlg = $("#link-dialog");
  dlg.querySelector(".child-name").textContent = `${child.name} (b.${child.birth_year ?? "?"})`;
  dlg.querySelector(".parent-name").textContent = `${parent.name} (b.${parent.birth_year ?? "?"})`;
  dlg.querySelector(".kind").textContent = link.kind;
  dlg.querySelector(".current-confidence").textContent = link.confidence;
  dlg.querySelector(".current-source").textContent = link.source;
  dlg.querySelector('[name="new_confidence"]').value = link.confidence;
  dlg.querySelector('[name="link_id"]').value = link.id;
  dlg.querySelector('[name="citation"]').value = "";
  dlg.querySelector('[name="evidence_type"]').value = "";
  dlg.showModal();
};

const submitLinkUpdate = async (formData) => {
  const linkId = formData.get("link_id");
  const res = await fetch(`/api/relationship/${encodeURIComponent(linkId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      confidence: formData.get("new_confidence"),
      evidence_type: formData.get("evidence_type") || null,
      citation: formData.get("citation") || null,
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(`Could not update link: ${err.error}`);
    return;
  }
  await fetchData();
  computeLayout();
  renderCards();
};

const wireDepth = () => {
  $("#depth").addEventListener("change", (e) => {
    state.depth = Number(e.target.value);
    computeLayout();
    renderCards();
  });
  $("#toggle-weak")?.addEventListener("click", () => {
    state.highlightWeakLinks = !state.highlightWeakLinks;
    $("#toggle-weak").classList.toggle("active", state.highlightWeakLinks);
    renderCards();
  });
  $("#export-gedcom")?.addEventListener("click", async () => {
    const btn = $("#export-gedcom");
    btn.disabled = true;
    btn.textContent = "Exporting…";
    try {
      const res = await fetch("/api/gedcom/export", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        alert(`Export failed: ${err.error}`);
        return;
      }
      const result = await res.json();
      const filename = result.path.split("/").pop();
      const summary =
        `Exported to outputs/${filename}\n\n` +
        `Existing INDI updated: ${result.counts.existing_indi_updated}\n` +
        `New INDI appended: ${result.counts.new_indi_appended}\n` +
        `Existing FAM updated: ${result.counts.existing_fam_updated}\n` +
        `New FAM appended: ${result.counts.new_fam_appended}\n` +
        `New SOUR records: ${result.counts.new_sources}\n\n` +
        `Download now?`;
      if (confirm(summary)) {
        window.location.href = `/api/gedcom/download/${encodeURIComponent(filename)}`;
      }
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Export .ged";
    }
  });
};

// ----- Bootstrap -------------------------------------------------------------

(async () => {
  await fetchData();
  computeLayout();
  renderCards();
  wirePanZoom();
  wireDialogs();
  wireDepth();
})();
