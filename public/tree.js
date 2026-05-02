// Pedigree tree view: root at bottom, ancestors above (paternal left, maternal
// right), with confidence-coloured cards and connector lines. Click a card to
// open the detail panel and run the Record Discovery agent.

import {
  buildClaimsMatrix,
  interpretBand,
  renderDonut,
  renderBandScale,
} from "./claimsMatrix.js";

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

// Anthropic API is priced in USD; UI displays GBP per user preference.
// Rate is a static constant — fine for cost-discipline reporting; not
// worth wiring a live FX feed for sub-pound delta accuracy.
const USD_TO_GBP = 0.79;
const fmtGBP = (usd) => {
  const gbp = (usd ?? 0) * USD_TO_GBP;
  return gbp >= 1 ? `£${gbp.toFixed(2)}` : `${(gbp * 100).toFixed(1)}p`;
};

const renderSpend = () => {
  const s = state.spend;
  if (!s) return;
  const session = fmtGBP(s.session.cost);
  const lifetime = fmtGBP(s.lifetime.cost);
  const cap = s.session.cap > 0 ? ` / ${fmtGBP(s.session.cap)} cap` : "";
  const capWarn = s.session.cap_hit ? " ⛔" : "";
  $("#spend").innerHTML = `
    <span style="font-variant-numeric: tabular-nums;">
      Session <strong>${session}</strong>${cap}${capWarn} · Lifetime <strong>${lifetime}</strong>
    </span>
  `;
  const fmtRate = (perM) => fmtGBP(perM).replace(/^£/, "£");
  $("#spend").title =
    `Session tokens: in ${s.session.tokens.input.toLocaleString()}, out ${s.session.tokens.output.toLocaleString()}\n` +
    `Lifetime tokens: in ${s.lifetime.tokens.input.toLocaleString()}, out ${s.lifetime.tokens.output.toLocaleString()}\n` +
    `Pricing (per million tokens, GBP @ ${USD_TO_GBP} USD→GBP): in ${fmtRate(s.pricing.input_per_million)} · out ${fmtRate(s.pricing.output_per_million)} · cache-read ${fmtRate(s.pricing.cache_read_per_million)}`;
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

// How many descendant generations to render. Capped to keep the canvas
// manageable; descendants are rarely the research focus, just a way to
// see the tree as a whole.
const MAX_DESCENDANT_DEPTH = 3;

// Recursively place descendants below root. Each generation gets one row
// (y = descGen * ROW_H, positive = below). Each child's slot is an equal
// share of its parent's allocated width — naive but fine for the small
// numbers of descendants in a personal tree.
const placeDescendants = (personId, descGen, xLeft, xRight) => {
  if (descGen > MAX_DESCENDANT_DEPTH) return;
  const ind = state.byId.get(personId);
  if (!ind) return;
  const childIds = [];
  for (const famId of ind.fams ?? []) {
    const fam = state.famById.get(famId);
    if (!fam) continue;
    for (const cId of fam.children ?? []) {
      if (!childIds.includes(cId)) childIds.push(cId);
    }
  }
  if (childIds.length === 0) return;
  const span = (xRight - xLeft) / childIds.length;
  for (let i = 0; i < childIds.length; i += 1) {
    const cId = childIds[i];
    if (state.positions.has(cId)) continue;
    const cLeft = xLeft + i * span;
    const cRight = xLeft + (i + 1) * span;
    const cMid = (cLeft + cRight) / 2;
    state.positions.set(cId, {
      x: cMid,
      y: descGen * ROW_H,
      generation: -descGen,
      role: "descendant",
    });
    placeDescendants(cId, descGen + 1, cLeft, cRight);
  }
};

// Place the root's spouse(s) at the same row as root, offset to the right
// by one slot. The pedigree algorithm proper only walks ancestor links —
// spouses are sideways, not upward — so this is a one-shot placement
// rather than a recursive call.
const placeRootSpouses = (totalW) => {
  const root = state.byId.get(ROOT_ID);
  const rootFams = root?.fams ?? [];
  if (rootFams.length === 0) return;
  const rootMid = totalW / 2;
  let i = 0;
  for (const famId of rootFams) {
    const fam = state.famById.get(famId);
    if (!fam) continue;
    const spouseId = fam.husband === ROOT_ID ? fam.wife : fam.husband;
    if (!spouseId) continue;
    if (state.positions.has(spouseId)) continue; // already placed
    state.positions.set(spouseId, {
      x: rootMid + SLOT_W * (1 + i),
      y: 0,
      generation: 0,
      role: "spouse",
      spouseFamilyId: famId,
    });
    i += 1;
  }
};

const computeLayout = () => {
  state.positions.clear();
  const totalSlots = Math.pow(2, state.depth);
  const totalW = totalSlots * SLOT_W;
  placeAncestors(ROOT_ID, 0, 0, totalW);
  placeRootSpouses(totalW);
  // Descendants span a width proportional to the number of children at the
  // first descendant generation, so the bottom row doesn't crowd. Min span
  // keeps the layout sensible when there are 0–1 children.
  const root = state.byId.get(ROOT_ID);
  const firstGenChildren = new Set();
  for (const famId of root?.fams ?? []) {
    const fam = state.famById.get(famId);
    for (const cId of fam?.children ?? []) firstGenChildren.add(cId);
  }
  const descSpan = Math.max(SLOT_W * 4, firstGenChildren.size * SLOT_W * 2);
  const rootMid = totalW / 2;
  placeDescendants(ROOT_ID, 1, rootMid - descSpan / 2, rootMid + descSpan / 2);
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
    const pending = ind.pending_external_lookups ?? 0;
    card.innerHTML = `
      <div class="name">${escapeHtml(ind.name || "Unknown")}</div>
      <div class="dates">${dates}</div>
      <div class="place">${escapeHtml(ind.birth_place || "")}</div>
      ${pending > 0 ? `<div class="paid-lookup-hint" title="Agent suggested ${pending} paywalled lookup${pending === 1 ? "" : "s"} for this person. Click the card to see them and start there with your subscription.">£ ${pending}</div>` : ""}
      ${cascadeRisk ? `<div class="chain-warning" title="${escapeHtml(ind.name || "This person")} is ${CONF_LABEL[ind.confidence]?.toLowerCase()} on their own evidence, but the family link connecting them back to root is only ${CONF_LABEL[chain.band]?.toLowerCase()}. Click the connection line below the card to verify or upgrade that link.">⚠ link: ${(CONF_LABEL[chain.band] ?? chain.band).toLowerCase()}</div>` : ""}
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

  // Marriage lines: short horizontal connector between root and each spouse.
  const rootPos = state.positions.get(ROOT_ID);
  if (rootPos) {
    for (const [id, pos] of state.positions) {
      if (pos.role !== "spouse") continue;
      const x1 = rootPos.x + offsetX;
      const y1 = rootPos.y + offsetY;
      const x2 = pos.x + offsetX;
      const y2 = pos.y + offsetY;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1);
      line.setAttribute("y1", y1);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", y2);
      line.setAttribute("class", "marriage");
      svg.appendChild(line);
    }
  }

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
  const placed = state.positions.size;
  $("#stats").innerHTML = `Placed: <strong>${placed}</strong> of ${state.individuals.length}`;
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

  resetDetailPanelTransientState();
  $("#detail-panel").hidden = false;
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

  // Strategic considerations the user should weigh before spending. Most
  // important: if BOTH parents are unknown, a single record often names both
  // — running two separate searches typically pays for the same record twice.
  const strategyTips = [];
  const bothUnknown = !otherParent;
  const otherRoleLabel = pos.role === "father" ? "mother" : "father";

  if (bothUnknown) {
    const eraTip =
      child.birth_year && child.birth_year >= 1837
        ? `Post-1837: a GRO birth certificate for ${escapeHtml(child.name)} (~£11 from gro.gov.uk) names both parents directly — including mother's maiden name from 1911. That single document often resolves both parents at once.`
        : child.birth_year
          ? `Pre-1837: parish baptism registers usually name both parents on the same line. A marriage record (parish register or bishop's transcript) names both partners — equally good for resolving both at once.`
          : `Without a birth year on the child it's hard to pick a strategy; consider verifying the child's birth before researching parents.`;
    strategyTips.push({
      kind: "warn",
      title: "Both parents are unknown",
      body: `Records that identify ${escapeHtml(child.name)}'s ${role.toLowerCase()} (baptism, marriage cert, GRO cert) typically name the ${otherRoleLabel} too. Running this search may surface a candidate whose evidence ALSO identifies the ${otherRoleLabel} — saving a second run. ${eraTip} Check the agent's citation when results arrive: if it names both parents, you can accept the ${otherRoleLabel} via the manual evidence form rather than spawning another agent run.`,
    });
  } else if (otherParent && (otherParent.confidence === "C" || otherParent.confidence === "D")) {
    strategyTips.push({
      kind: "warn",
      title: `The known ${otherParent.sex === "M" ? "father" : "mother"} is weakly anchored`,
      body: `${escapeHtml(otherParent.name)} is band ${otherParent.confidence} (${(CONF_LABEL[otherParent.confidence] ?? "").toLowerCase()}). Triangulating against a weak anchor produces only weak link evidence. Consider verifying ${escapeHtml(otherParent.name)} to band B+ first — that strengthens the anchor for THIS search and any other search referencing them.`,
    });
  }

  // Sibling triangulation hint — when at least one A/B-band sibling exists
  const fsKids = (fam?.children ?? []).filter((cid) => cid !== child.id);
  const strongSiblings = fsKids
    .map((cid) => state.byId.get(cid))
    .filter((s) => s && (s.confidence === "A" || s.confidence === "B"));
  if (strongSiblings.length > 0) {
    strategyTips.push({
      kind: "info",
      title: `${strongSiblings.length} well-anchored sibling${strongSiblings.length === 1 ? "" : "s"} available for triangulation`,
      body: `${strongSiblings
        .slice(0, 3)
        .map((s) => `${escapeHtml(s.name)} (${s.birth_year ?? "?"})`)
        .join(", ")}${strongSiblings.length > 3 ? ", and others" : ""}. The agent will use these to triangulate. A baptism naming this missing ${role.toLowerCase()} as parent of any one of them is direct link evidence.`,
    });
  }

  const tipsHtml = strategyTips
    .map(
      (t) => `
    <div class="strategy-tip ${t.kind}">
      <strong>${escapeHtml(t.title)}</strong>
      <div>${t.body}</div>
    </div>`,
    )
    .join("");

  $("#result").innerHTML = `
    ${tipsHtml ? `<h2 style="margin-top:0;">Before you spend</h2>${tipsHtml}` : ""}
    <h2 style="${tipsHtml ? "" : "margin-top:0;"}">Anchors available for this search</h2>
    <ul style="margin:8px 0; padding-left:20px;">
      <li>Child <strong>${escapeHtml(child.name)}</strong>, b.${childYear}, ${escapeHtml(childPlace)}, confidence <strong>${child.confidence}</strong></li>
      ${otherParent ? `<li>Spouse <strong>${escapeHtml(otherParent.name)}</strong>, b.${otherParent.birth_year ?? "?"}, ${escapeHtml(otherParent.birth_place || "place unknown")}, confidence <strong>${otherParent.confidence}</strong></li>` : `<li class="muted">No spouse record (the other parent is also unknown)</li>`}
    </ul>
    <p class="muted">Clicking <strong>Find this ${role}</strong> spawns the Ancestor Discovery agent. Acceptance creates a new individual and a new parent-child relationship in the tree.</p>
  `;

  // Reuse the run button — re-label and rewire to ancestor discovery
  $("#run-btn").hidden = false;
  $("#run-btn").textContent = `Find this ${role}`;
  $("#run-btn").disabled = false;
  $("#accept-btn").hidden = true;
  $("#reject-btn").hidden = true;
  $("#flag-btn").hidden = true;

  // When both parents are unknown, offer the more cost-efficient
  // "Find both parents" button alongside the single-parent option.
  let bothBtn = $("#run-both-btn");
  if (bothUnknown) {
    if (!bothBtn) {
      bothBtn = document.createElement("button");
      bothBtn.id = "run-both-btn";
      bothBtn.className = "primary";
      bothBtn.style.marginLeft = "6px";
      $("#run-btn").after(bothBtn);
    }
    bothBtn.textContent = "Find both parents (recommended)";
    bothBtn.hidden = false;
    bothBtn.onclick = () => runAncestorDiscoveryBoth(pos);
  } else if (bothBtn) {
    bothBtn.hidden = true;
  }
};

// Reset every transient UI element of the detail panel so leftover state
// from a previous individual (Stop button text, "Done. N searches", spinner
// visibility, candidate picker, external lookups) doesn't bleed across
// navigations. Called from selectPerson and selectPlaceholder.
const resetDetailPanelTransientState = () => {
  $("#status").hidden = true;
  $("#status-text").textContent = "Searching public records…";
  $("#status-query").textContent = "";
  $("#status-meta").textContent = "";
  $("#run-btn").disabled = false;
  // Drop any candidate picker / external lookups section from a prior selection
  document.querySelector("#candidate-picker")?.remove();
  document.querySelector("#external-lookups-section")?.remove();
  // Clear the external API leads section between selections.
  $("#external-leads").hidden = true;
  $("#external-leads-list").innerHTML = "";
  $("#external-leads-summary").textContent = "";
  // Clear the sibling-reconciliation section.
  $("#sibling-reconciliation").hidden = true;
  $("#sibling-reconciliation-list").innerHTML = "";
  $("#sibling-reconciliation-summary").textContent = "";
  // Clear the confidence-breakdown section.
  $("#confidence-breakdown").hidden = true;
  $("#confidence-breakdown-summary").textContent = "";
  $("#confidence-breakdown-body").innerHTML = "";
};

// Render the external API leads list for the currently selected individual.
// Source kinds: tna (catalogue ref) | wikitree | familysearch | gedcom.
const renderExternalLeads = (leads) => {
  const list = $("#external-leads-list");
  list.innerHTML = "";
  if (!leads?.length) {
    $("#external-leads").hidden = true;
    return;
  }
  $("#external-leads").hidden = false;
  // Group by source kind for clarity.
  const groups = { tna: [], wikitree: [], familysearch: [], gedcom: [] };
  for (const lead of leads) {
    const kind = lead.source_kind ?? "gedcom";
    (groups[kind] ?? (groups[kind] = [])).push(lead);
  }
  const labels = { tna: "TNA Discovery", wikitree: "WikiTree", familysearch: "FamilySearch", gedcom: "GEDCOM import" };
  for (const kind of ["tna", "wikitree", "familysearch", "gedcom"]) {
    const items = groups[kind];
    if (!items?.length) continue;
    const header = document.createElement("div");
    header.className = `external-leads-group external-leads-${kind}`;
    header.innerHTML = `<div class="external-leads-group-title">${labels[kind]} <span class="muted">(${items.length})</span></div>`;
    for (const lead of items) {
      const row = document.createElement("div");
      row.className = "external-leads-row";
      if (kind === "tna") {
        row.innerHTML = `
          <div><strong>${escapeHtml(lead.catalogue_ref ?? "(no ref)")}</strong> <span class="muted">${escapeHtml(lead.covering_dates ?? "")}</span></div>
          <div>${escapeHtml(lead.title ?? "")}</div>
          <div class="muted" style="font-size:11px;">${escapeHtml(lead.held_by ?? "")} · <a href="${escapeHtml(lead.catalogue_url ?? "#")}" target="_blank" rel="noopener">View catalogue</a></div>
        `;
      } else {
        const d = lead.external_data ?? {};
        const conf = lead.confidence ? `<span class="badge ${lead.confidence}">${escapeHtml(lead.confidence)}</span>` : "";
        const profile = d.profile_url ? ` · <a href="${escapeHtml(d.profile_url)}" target="_blank" rel="noopener">View profile</a>` : "";
        const reasons = lead.reasons?.length ? `<div class="muted" style="font-size:11px;">${lead.reasons.map(escapeHtml).join(" · ")}</div>` : "";
        row.innerHTML = `
          <div><strong>${escapeHtml(d.name ?? lead.external_id)}</strong> ${conf}</div>
          <div class="muted">b.${d.birth_year ?? "?"}${d.birth_place ? " · " + escapeHtml(d.birth_place) : ""}${profile}</div>
          ${reasons}
        `;
      }
      header.appendChild(row);
    }
    list.appendChild(header);
  }
};

// Render the sibling-corroboration report for the selected individual's
// famc family. Hidden when the individual has no famc, no siblings, or
// fewer than 2 children (corroboration only meaningful for sibling sets).
const STRENGTH_LABEL = { strong: "Strong", weak: "Weak", none: "None yet" };
const STRENGTH_BAND = { strong: "A", weak: "C", none: "D" };
const renderSiblingReconciliation = (report, selectedId) => {
  if (!report || report.total_siblings < 2) {
    $("#sibling-reconciliation").hidden = true;
    return;
  }
  $("#sibling-reconciliation").hidden = false;
  const badge = $("#sibling-strength-badge");
  badge.textContent = STRENGTH_LABEL[report.corroboration_strength];
  badge.className = `badge ${STRENGTH_BAND[report.corroboration_strength]}`;

  const others = report.siblings.filter((s) => s.id !== selectedId);
  $("#sibling-reconciliation-summary").textContent =
    `${report.accepted_count} of ${report.total_siblings - 1} sibling${report.total_siblings - 1 === 1 ? "" : "s"} have an accepted match — independent corroboration of the parental link.`;

  const list = $("#sibling-reconciliation-list");
  list.innerHTML = "";
  for (const s of others) {
    const row = document.createElement("div");
    row.style.cssText = "padding:6px 0;border-top:1px dashed var(--border);font-size:13px;display:flex;gap:8px;align-items:center;";
    const decisionBadge = s.decision
      ? `<span class="badge ${s.decision === "accepted" ? "A" : s.decision === "rejected" ? "D" : "C"}" style="font-size:10px;padding:2px 6px;">${escapeHtml(s.decision)}</span>`
      : `<span class="muted" style="font-size:11px;">unresearched</span>`;
    row.innerHTML = `
      <div style="flex:1;">
        <strong>${escapeHtml(s.name)}</strong>
        <span class="muted" style="margin-left:6px;">b.${s.birth_year ?? "?"}</span>
      </div>
      ${decisionBadge}
      <button type="button" class="ghost sibling-jump" data-id="${escapeHtml(s.id)}" style="font-size:11px;padding:4px 8px;">Open</button>
    `;
    row.querySelector(".sibling-jump").addEventListener("click", () => selectPerson(s.id));
    list.appendChild(row);
  }
};

const fetchAndRenderSiblingReconciliation = async (id) => {
  const ind = state.byId.get(id);
  if (!ind?.famc) {
    $("#sibling-reconciliation").hidden = true;
    return;
  }
  try {
    const res = await fetch(`/api/siblings/reconcile/${encodeURIComponent(ind.famc)}`);
    if (!res.ok) return;
    const { report } = await res.json();
    if (state.selectedId !== id) return; // stale
    renderSiblingReconciliation(report, id);
  } catch {
    /* swallow */
  }
};

// Phase 2 Bayesian breakdown — informational, doesn't override the legacy
// band. Always visible (no collapse) — confidence is the project's
// centrepiece, hiding it under a click defeats the point. Summary line
// gives the gist; rows below give the audit trail.
const renderConfidenceBreakdown = (payload) => {
  const section = $("#confidence-breakdown");
  if (!payload?.result) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const { result, evidence, legacy_band } = payload;
  const posteriorPct = (result.posterior * 100).toFixed(1) + "%";
  const bayesianBand = result.band;
  const summary = $("#confidence-breakdown-summary");
  summary.innerHTML =
    `Legacy <span class="badge ${legacy_band ?? "D"}">${legacy_band ?? "?"}</span>` +
    ` · Bayesian <span class="badge ${bayesianBand}">${bayesianBand}</span> ${posteriorPct}` +
    ` <span class="muted">(${result.contributions.length} contribution${result.contributions.length === 1 ? "" : "s"})</span>`;

  const body = $("#confidence-breakdown-body");
  const contribsByImpact = [...result.contributions].sort((a, b) => Math.abs(b.log_lr) - Math.abs(a.log_lr));
  if (contribsByImpact.length === 0) {
    body.innerHTML = `<div class="muted">No evidence accumulated yet — posterior equals the prior (${(result.prior * 100).toFixed(0)}%).</div>`;
    return;
  }
  let rows = "";
  for (const c of contribsByImpact) {
    const direction = c.lr > 1 ? "↑" : c.lr < 1 ? "↓" : "·";
    const impact = c.log_lr > 0 ? "supports" : c.log_lr < 0 ? "against" : "neutral";
    rows += `
      <div style="padding:6px 0;border-top:1px dashed var(--border);display:flex;gap:8px;align-items:flex-start;">
        <span style="min-width:22px;font-weight:700;color:${c.lr > 1 ? "#1f6b3a" : c.lr < 1 ? "#c00000" : "#5a6170"};">${direction}</span>
        <div style="flex:1;">
          <div><strong>${escapeHtml(c.kind)}</strong> <span class="muted">LR ${c.lr} · ${escapeHtml(impact)}${c.source_tier ? ` · Tier ${c.source_tier}` : ""}</span></div>
          ${c.note ? `<div class="muted" style="font-size:11px;">${escapeHtml(c.note)}</div>` : ""}
        </div>
      </div>
    `;
  }
  body.innerHTML = `
    <div class="muted" style="margin-bottom:6px;">
      Prior ${(result.prior * 100).toFixed(0)}% → posterior ${posteriorPct}.
      Stored evidence: ${(evidence.identity ?? []).filter((e) => e.source_kind === "decision_accept").length}.
      Reviewer findings: ${(evidence.identity ?? []).filter((e) => e.source_kind === "reviewer").length + (evidence.relationship ?? []).filter((e) => e.source_kind === "reviewer").length}.
      External: ${(evidence.identity ?? []).filter((e) => e.source_kind === "external_suggestion").length}.
    </div>
    ${rows}
  `;
};

const fetchAndRenderConfidenceBreakdown = async (id) => {
  try {
    const res = await fetch(`/api/confidence/${encodeURIComponent(id)}`);
    if (!res.ok) {
      $("#confidence-breakdown").hidden = true;
      return;
    }
    const payload = await res.json();
    if (state.selectedId !== id) return; // stale
    renderConfidenceBreakdown(payload);
    renderClaimsAndConfidence(id, payload);
  } catch {
    /* swallow */
  }
};

const fetchAndRenderExternalLeads = async (id) => {
  try {
    const res = await fetch(`/api/external/leads/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const { leads } = await res.json();
    // Only render if this is still the selected individual (race-safety).
    if (state.selectedId !== id) return;
    renderExternalLeads(leads);
  } catch {
    /* network failure — leave section hidden */
  }
};

const selectPerson = async (id) => {
  state.selectedId = id;
  state.selectedPlaceholder = null;
  $$(".card.selected").forEach((c) => c.classList.remove("selected"));
  $(`[data-id="${id}"]`)?.classList.add("selected");

  if (state.streaming) cancelStream();
  resetDetailPanelTransientState();

  $("#detail-panel").hidden = false;
  $("#status").hidden = true;
  $("#decision-bar").hidden = false;

  const p = state.byId.get(id);
  const indSpend = state.spend?.by_individual?.[id];
  const spendLine = indSpend
    ? `<div class="muted" style="font-size:11px; margin-top:4px;">Spent on this person: <strong>${fmtGBP(indSpend.cost)}</strong> · ${indSpend.runs} run(s) · ${indSpend.input_tokens.toLocaleString()} in / ${indSpend.output_tokens.toLocaleString()} out</div>`
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
    ${(p.pending_external_lookups ?? 0) > 0 ? `<div class="reresearch-banner" style="background:#fff8e1; border-left-color:#f5c66a; color:#8b6c00;">£ ${p.pending_external_lookups} paywalled lookup${p.pending_external_lookups === 1 ? "" : "s"} suggested for this person — see the External lookups section below.</div>` : ""}
    ${spendLine}
  `;

  // Kick off the external-leads fetch in parallel — it's independent of
  // the main evidence load and can settle whenever it returns.
  fetchAndRenderExternalLeads(id);
  fetchAndRenderSiblingReconciliation(id);
  fetchAndRenderConfidenceBreakdown(id);

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
  // Result lives inside the collapsible "Full agent narrative" section in
  // the redesigned panel. Reveal it whenever there's text to show.
  const wrapper = $("#full-narrative");
  if (wrapper) wrapper.hidden = !text;
};

// --- Slice 1: Claims & Evidence Matrix + Confidence Donut + Next Steps ---
//
// Driven by the same /api/confidence/:id payload as the legacy breakdown.
// Renders into the new sections in the detail panel; gracefully no-ops if
// those sections aren't in the DOM (e.g. on list.html until Slice 1 wires
// it there too).

const tierBarSegments = (weights) =>
  weights
    .map(
      (s) =>
        `<span class="seg t${s.tier}" style="width:${(s.fraction * 100).toFixed(1)}%"></span>`,
    )
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
    <thead>
      <tr>
        <th>Fact / claim</th>
        <th>Details</th>
        <th>Sources</th>
        <th>Status</th>
      </tr>
    </thead>`;
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
  if (reresearch?.reason) {
    items.push({
      title: "Re-research recommended",
      hint: reresearch.reason,
    });
  }
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

let _reviewCache = null;
const fetchReviewOnce = async () => {
  if (_reviewCache) return _reviewCache;
  try {
    const r = await fetch("/api/review");
    if (!r.ok) return [];
    const j = await r.json();
    _reviewCache = j.findings ?? [];
    return _reviewCache;
  } catch {
    return [];
  }
};

const renderClaimsAndConfidence = async (id, payload) => {
  const section = $("#claims-matrix-section");
  if (!section) return;
  if (!payload?.result) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const decision = state.decisionsById?.[id] ?? null;
  const contributions = payload.result.contributions ?? [];
  const rows = buildClaimsMatrix({ contributions, decision });
  renderClaimsMatrixInto($("#claims-matrix"), rows);

  // Legacy band is the canonical headline (Phase 2 design — Bayesian is
  // informational, not authoritative). The donut shows the imported/
  // accepted band; we annotate with the Bayesian posterior when there's
  // genuinely independent evidence to report.
  const legacyBand = payload.legacy_band ?? "D";
  const bayesianBand = payload.result.band;
  const posterior = payload.result.posterior;
  const hasIndependentEvidence = contributions.some(
    (c) => c.source_kind === "decision_accept" || (c.source_tier && c.source_tier <= 2),
  );
  const showBayesian = hasIndependentEvidence;

  const donutSlot = $("#confidence-donut-slot");
  if (donutSlot)
    donutSlot.innerHTML = renderDonut({
      band: legacyBand,
      posterior: showBayesian ? posterior : null,
    });
  const scaleSlot = $("#confidence-band-scale-slot");
  if (scaleSlot) scaleSlot.innerHTML = renderBandScale({ band: legacyBand });
  const interp = $("#confidence-interpretation");
  if (interp) {
    const supports = contributions.filter((c) => c.lr > 1).length;
    const conflicts = contributions.filter(
      (c) => c.lr < 1 || c.source_kind === "reviewer",
    ).length;
    let text;
    if (!hasIndependentEvidence) {
      text = `Band ${legacyBand} from imported records. Run the agent to gather Bayesian-grade evidence (parish, civil BMD, census).`;
    } else {
      const tail = conflicts > 0 ? ` ${conflicts} conflict${conflicts === 1 ? "" : "s"} flagged.` : "";
      text = `Band ${legacyBand} · Bayesian posterior ${(posterior * 100).toFixed(1)}% · ${supports} supporting source${supports === 1 ? "" : "s"}.${tail}`;
      if (showBayesian && bayesianBand && bayesianBand !== legacyBand) {
        text += ` (Bayesian band would be ${bayesianBand} — surface for review.)`;
      }
    }
    interp.textContent = text;
  }

  const [allFindings, kbResp] = await Promise.all([
    fetchReviewOnce(),
    fetch("/api/kb").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (state.selectedId !== id) return;
  const myFindings = allFindings.filter((f) => f.individual_id === id);
  const reresearch = kbResp?.reresearch_recommended?.[id] ?? null;
  const contradictions = contributions.filter((c) => c.lr < 1).length;
  renderNextStepsInto($("#next-steps-list"), { reviewerFindings: myFindings, reresearch, contradictions });
};

const runAgent = () => {
  if (state.selectedPlaceholder) return runAncestorDiscovery();
  const id = state.selectedId;
  if (!id) return;
  if (!capCheck()) return;
  if (!rerunCheck(id, "Record Discovery")) return;
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
    // Drop stale events from a stream that's no longer the active one
    // (user navigated, ran on someone else, hit Stop). Old closures shouldn't
    // be updating the shared DOM elements.
    if (state.streaming?.es !== es) return;
    const event = JSON.parse(e.data);
    // After "done" the run is logically complete. Any straggler search/text
    // events are ignored so the counter doesn't drift past the server's count.
    if (state.streaming?.completed && (event.type === "search" || event.type === "text")) {
      return;
    }
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
      accumulated.searches = event.result.search_count;
      $("#status-text").textContent = `Web search ${accumulated.searches} complete.`;
      if (state.streaming) state.streaming.completed = true;
      $("#status").hidden = true;
      $("#run-btn").disabled = false;
      showDecisionButtons(true, null);
      // CRITICAL: hard timer to force-close the EventSource if `saved`
      // never arrives. Without this, the server's res.end() triggers the
      // browser's default EventSource auto-reconnect, which in turn
      // re-fires a fresh agent run — exactly the bug that produced 51
      // back-to-back runs on a single individual on 2026-05-01.
      if (state.streaming) {
        state.streaming.doneTimer = setTimeout(() => {
          if (state.streaming?.es === es) cleanupStream();
        }, 5000);
      }
    } else if (event.type === "saved") {
      if (state.streaming?.doneTimer) clearTimeout(state.streaming.doneTimer);
      cleanupStream();
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
    // Always close the local EventSource — preventing the auto-reconnect
    // that would otherwise fire a fresh agent run.
    es.close();
    if (state.streaming && !state.streaming.completed) {
      $("#status-text").textContent = "Connection lost.";
      cleanupStream();
    }
  };
};

// Parse the Ancestor Discovery <<CANDIDATE_PARENTS>> block for PAIR candidates.
// Format per line:
//   CANDIDATE_PAIR_N_FATHER||name||birth_year||birth_place||link_band||link_tier||link_citation
//   CANDIDATE_PAIR_N_MOTHER||name||birth_year||birth_place||link_band||link_tier||link_citation
// Returns an array of { pairId, father, mother } where father/mother have the
// same shape as single-parent candidates.
const parseCandidatePairs = (text) => {
  if (!text) return [];
  const m = text.match(/<<CANDIDATE_PARENTS>>\s*([\s\S]*?)\s*<<\/CANDIDATE_PARENTS>>/);
  if (!m) return [];
  const pairs = new Map();
  const lines = m[1]
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length && !/^NONE$/i.test(l));
  for (const line of lines) {
    const labelMatch = line.match(/^(CANDIDATE_PAIR_(\d+)_(FATHER|MOTHER))\|\|/i);
    if (!labelMatch) continue;
    const [, , idx, role] = labelMatch;
    const parts = line.split("||").map((p) => p.trim());
    if (parts.length < 7) continue;
    const [, name, birth_year, birth_place, link_band, link_tier, link_citation] = parts;
    if (!name || !["A", "B", "C"].includes(link_band)) continue;
    const pair = pairs.get(idx) ?? { pairId: idx, father: null, mother: null };
    pair[role.toLowerCase()] = {
      name,
      birth_year: birth_year && birth_year !== "?" ? Number(birth_year) : null,
      birth_place,
      link_band,
      link_tier,
      link_citation,
    };
    pairs.set(idx, pair);
  }
  return Array.from(pairs.values()).filter((p) => p.father && p.mother);
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

const renderPairPicker = (pairs, ph) => {
  const child = state.byId.get(ph.childId);
  if (!child) return;
  const html = pairs
    .map(
      (p, i) => `
    <div class="candidate-card" data-idx="${i}">
      <strong>Pair ${p.pairId}</strong>
      <div style="margin-top:6px;">
        <div><span class="muted">Father:</span> <strong>${escapeHtml(p.father.name)}</strong> (${p.father.birth_year ?? "?"} · ${escapeHtml(p.father.birth_place || "place unknown")}) · link <strong>${p.father.link_band}</strong></div>
        <div><span class="muted">Mother:</span> <strong>${escapeHtml(p.mother.name)}</strong> (${p.mother.birth_year ?? "?"} · ${escapeHtml(p.mother.birth_place || "place unknown")}) · link <strong>${p.mother.link_band}</strong></div>
      </div>
      <div class="muted" style="margin-top:6px; font-size:11px;">
        Citation: ${escapeHtml(p.father.link_citation)}${p.mother.link_citation !== p.father.link_citation ? " / " + escapeHtml(p.mother.link_citation) : ""}
      </div>
      <button class="primary accept-pair-btn" data-idx="${i}" style="margin-top:8px;">
        Accept both as parents of ${escapeHtml(child.name)}
      </button>
    </div>`,
    )
    .join("");

  const wrap = document.createElement("section");
  wrap.id = "candidate-picker";
  wrap.innerHTML = `
    <h3 style="margin: 18px 0 8px; font-size: 14px; color: #1f3864;">
      Proposed parent pairs (${pairs.length})
    </h3>
    <p class="muted" style="font-size: 12px;">
      Each pair shares a single source citation that names both parents.
      Accepting creates two new individuals (confidence C until further
      Record Discovery), the family record, and both parent-child links
      at the stated link confidences in one transaction.
    </p>
    ${html}
  `;
  $("#result").appendChild(wrap);

  for (const btn of wrap.querySelectorAll(".accept-pair-btn")) {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      acceptPair(pairs[idx], ph);
    });
  }
};

const acceptPair = async (pair, ph) => {
  const child = state.byId.get(ph.childId);
  if (!child) return;
  const ok = confirm(
    `Accept both parents for ${child.name}?\n\n` +
      `Father: ${pair.father.name} (${pair.father.birth_year ?? "?"})\n` +
      `Mother: ${pair.mother.name} (${pair.mother.birth_year ?? "?"})\n\n` +
      `Both at link confidence ${pair.father.link_band}/${pair.mother.link_band}.\n` +
      `Two new individuals will be created (confidence C until separately verified).`,
  );
  if (!ok) return;

  const body = {
    father: {
      name: pair.father.name,
      birth_year: pair.father.birth_year,
      birth_place: pair.father.birth_place,
      link_confidence: pair.father.link_band,
      link_evidence_type: pair.father.link_tier,
      link_citation: pair.father.link_citation,
    },
    mother: {
      name: pair.mother.name,
      birth_year: pair.mother.birth_year,
      birth_place: pair.mother.birth_place,
      link_confidence: pair.mother.link_band,
      link_evidence_type: pair.mother.link_tier,
      link_citation: pair.mother.link_citation,
    },
  };
  const res = await fetch(
    `/api/ancestor/accept-pair/${encodeURIComponent(ph.childId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const err = await res.json();
    alert(`Could not accept pair: ${err.error}`);
    return;
  }
  const { fatherId } = await res.json();
  await fetchData();
  computeLayout();
  renderCards();
  selectPerson(fatherId);
};

// Ancestor Discovery (both parents) — uses role=both
const runAncestorDiscoveryBoth = (pos) => {
  if (!capCheck()) return;
  if (!cascadeCheck(pos.childId, "Ancestor Discovery (both parents)")) return;
  state.selectedPlaceholder = { ...pos, role: "both" };
  $("#run-btn").disabled = true;
  $("#run-both-btn").disabled = true;
  $("#status").hidden = false;
  $("#status-text").textContent = "Searching for both parents…";
  $("#status-query").textContent = "";
  $("#status-meta").textContent = "";
  $("#result").innerHTML = "";

  const accumulated = { text: "", searches: 0 };
  const url = `/api/ancestor/run/${encodeURIComponent(pos.childId)}/both`;
  const es = new EventSource(url);
  state.streaming = { es, accumulated };

  es.onmessage = (e) => {
    if (state.streaming?.es !== es) return;
    const event = JSON.parse(e.data);
    if (state.streaming?.completed && (event.type === "search" || event.type === "text")) {
      return;
    }
    if (event.type === "start") {
      $("#status-text").textContent = "Ancestor Discovery (both parents) running…";
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
      accumulated.searches = event.result.search_count;
      $("#status-text").textContent = `Web search ${accumulated.searches} complete.`;
      if (state.streaming) state.streaming.completed = true;
      $("#status").hidden = true;
      $("#run-btn").disabled = false;
      // Hard timer to force-close ES if `saved` never arrives — see runAgent.
      if (state.streaming) {
        state.streaming.doneTimer = setTimeout(() => {
          if (state.streaming?.es === es) cleanupStream();
        }, 5000);
      }
    } else if (event.type === "saved") {
      if (state.streaming?.doneTimer) clearTimeout(state.streaming.doneTimer);
      cleanupStream();
      $("#status").hidden = true;
      fetch("/api/spend").then((r) => r.json()).then((s) => {
        state.spend = s;
        renderSpend();
      });
      const pairs = parseCandidatePairs(accumulated.text);
      if (pairs.length > 0) {
        renderPairPicker(pairs, pos);
      } else {
        const singles = parseCandidateParents(accumulated.text);
        if (singles.length > 0) {
          renderCandidatePicker(singles, pos);
        }
      }
    } else if (event.type === "error") {
      $("#status-text").textContent = `Error: ${event.message}`;
      cleanupStream();
    }
  };
  es.onerror = () => {
    es.close();
    if (state.streaming && !state.streaming.completed) {
      $("#status-text").textContent = "Connection lost.";
      cleanupStream();
    }
  };
};

// Ancestor Discovery — uses /api/ancestor/run/:childId/:role
const runAncestorDiscovery = () => {
  const ph = state.selectedPlaceholder;
  if (!ph) return;
  if (!capCheck()) return;
  if (!rerunCheck(ph.childId, "Ancestor Discovery")) return;
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
    if (state.streaming?.es !== es) return; // ignore stale closures
    const event = JSON.parse(e.data);
    if (state.streaming?.completed && (event.type === "search" || event.type === "text")) {
      return;
    }
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
      accumulated.searches = event.result.search_count;
      $("#status-text").textContent = `Web search ${accumulated.searches} complete.`;
      if (state.streaming) state.streaming.completed = true;
      $("#status").hidden = true;
      $("#run-btn").disabled = false;
      // Hard timer to force-close ES if `saved` never arrives — see runAgent.
      if (state.streaming) {
        state.streaming.doneTimer = setTimeout(() => {
          if (state.streaming?.es === es) cleanupStream();
        }, 5000);
      }
    } else if (event.type === "saved") {
      if (state.streaming?.doneTimer) clearTimeout(state.streaming.doneTimer);
      cleanupStream();
      $("#status").hidden = true;
      fetch("/api/spend")
        .then((r) => r.json())
        .then((s) => {
          state.spend = s;
          renderSpend();
        });
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
    es.close();
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
  // Clear any previous status hint at the top of the dialog
  let hintEl = dlg.querySelector(".prefill-hint");
  if (hintEl) hintEl.remove();
  const setHint = (text, kind = "muted") => {
    const el = document.createElement("p");
    el.className = `prefill-hint ${kind}`;
    el.textContent = text;
    el.style.cssText = "font-size:12px; margin:6px 0 12px; padding:6px 10px; border-radius:4px;";
    if (kind === "warn") {
      el.style.background = "#fff8e1";
      el.style.borderLeft = "3px solid #f5c66a";
    } else if (kind === "ok") {
      el.style.background = "#e2efda";
      el.style.borderLeft = "3px solid #1f6b3a";
    } else {
      el.style.background = "#f0f5fb";
      el.style.borderLeft = "3px solid var(--accent)";
    }
    dlg.querySelector("h3").after(el);
  };

  try {
    const ev = await fetch(`/api/evidence/${encodeURIComponent(id)}`).then((r) => r.json());
    if (!ev?.agent_result) {
      setHint("No agent run yet for this individual — fill in the citation manually.", "warn");
      return;
    }

    // Prefer the structured RECOMMENDED_CITATION block
    const structured = parseRecommendedCitation(ev.agent_result);
    if (structured) {
      dlg.querySelector('[name="title"]').value = structured.title || "";
      dlg.querySelector('[name="repository"]').value = structured.repository || "";
      dlg.querySelector('[name="reference"]').value = structured.reference || "";
      dlg.querySelector('[name="url"]').value = structured.url || "";
      dlg.querySelector('[name="new_confidence"]').value = structured.new_confidence;
      setHint(
        `Auto-filled from the agent's structured citation (recommended band ${structured.new_confidence}). Review before confirming.`,
        "ok",
      );
      console.log("[accept dialog] prefill from structured block:", structured);
      return;
    }

    // Fallback: free-form
    const free = parseRecommendationFreeForm(ev.agent_result);
    console.log("[accept dialog] structured block not found; free-form parse:", free);
    if (!free || (!free.band && !free.citation)) {
      setHint(
        "The agent's last run didn't recommend an upgrade (band: Unchanged or no match found). " +
          "If you have evidence of your own, fill the citation manually.",
        "warn",
      );
      return;
    }
    if (free.band && ["A", "B", "C"].includes(free.band)) {
      dlg.querySelector('[name="new_confidence"]').value = free.band;
    }
    if (free.citation) {
      dlg.querySelector('[name="title"]').value = free.citation;
      setHint(
        "Auto-filled from the agent's free-form recommendation. Repository and reference need manual splitting from the title. " +
          "(Re-running the agent will produce a structured citation that auto-fills cleanly.)",
        "warn",
      );
    } else {
      setHint(
        `The agent recommended band ${free.band} but didn't include a parseable citation. Fill manually.`,
        "warn",
      );
    }
  } catch (e) {
    console.warn("Failed to prefill from agent result", e);
    setHint("Could not auto-fill (see console for error). Fill manually.", "warn");
  }
};

// Spend cap pre-check. Server enforces this too (429), but a clear message
// before the request is much better UX than a "Connection lost" surprise.
const capCheck = () => {
  const s = state.spend?.session;
  if (!s || !s.cap || s.cap === 0) return true;
  if (!s.cap_hit) return true;
  alert(
    `Session spend cap of ${fmtGBP(s.cap)} reached (${fmtGBP(s.cost)} spent).\n\n` +
      `Restart the server to reset the session counter, or raise SESSION_CAP_USD in .env (then restart).`,
  );
  return false;
};

// Per-individual re-run guard. After the threshold (default 3 prior runs),
// every subsequent click on Run Agent prompts confirmation showing the
// cumulative spend, so accidental re-runs in testing don't bleed cost.
const RERUN_WARN_THRESHOLD = 3;

const rerunCheck = (id, agentLabel) => {
  const ind = state.spend?.by_individual?.[id];
  const runs = ind?.runs ?? 0;
  if (runs < RERUN_WARN_THRESHOLD) return true;
  const cost = ind?.cost ?? 0;
  const person = state.byId.get(id);
  const name = person?.name ?? id;
  const proceed = confirm(
    `Re-run guard\n\n` +
      `${agentLabel} on ${name} would be run #${runs + 1}.\n\n` +
      `Cumulative spend on this person so far: ${fmtGBP(cost)} across ${runs} prior run${runs === 1 ? "" : "s"}.\n\n` +
      `Re-running only adds value if the KB has new context since the last run. ` +
      `If you're testing, override anyway. If not, cancel and consider whether ` +
      `you'd be paying for similar searches.\n\n` +
      `Proceed with run #${runs + 1}?`,
  );
  return proceed;
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
  // GEDCOM import: read file as text on the client, POST as JSON to keep the
  // server free of multipart deps. The dialog stays open after submit so the
  // user sees the summary before dismissing.
  $("#import-gedcom")?.addEventListener("click", () => {
    // Reset to the "ready to import" state every time the dialog opens.
    $("#import-summary").hidden = true;
    $("#import-summary").innerHTML = "";
    $("#import-progress").hidden = true;
    $("#import-submit").hidden = false;
    $("#import-submit").disabled = false;
    const cancelBtn = $("#import-dialog button[value='cancel']");
    if (cancelBtn) cancelBtn.textContent = "Cancel";
    $("#import-dialog").querySelector("form").reset();
    $("#import-dialog").showModal();
  });

  $("#import-submit")?.addEventListener("click", async () => {
    const fileInput = $("#import-dialog input[type='file']");
    const file = fileInput?.files?.[0];
    if (!file) {
      alert("Please pick a GEDCOM file first.");
      return;
    }
    $("#import-submit").disabled = true;
    $("#import-progress").hidden = false;
    $("#import-summary").hidden = true;
    try {
      const text = await file.text();
      const res = await fetch("/api/external/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? "Import failed");
      }
      const { summary } = await res.json();
      $("#import-progress").hidden = true;
      $("#import-summary").hidden = false;
      $("#import-summary").innerHTML = `
        <h4 style="margin:0 0 6px; color:#1f6b3a;">✓ Import complete</h4>
        <ul style="margin:0; padding-left:20px; font-size:13px; line-height:1.6;">
          <li><strong>${escapeHtml(summary.filename)}</strong></li>
          <li>${summary.individual_count} individuals · ${summary.family_count} families · ${summary.source_count} sources parsed</li>
          <li><strong>${summary.matched_count}</strong> matched to existing tree (Tier 3 leads now in KB context)</li>
          <li><strong>${summary.unmatched_count}</strong> unmatched (candidate ancestors for unknown-parent searches)</li>
        </ul>
        <p class="muted" style="margin-top:8px; font-size:12px;">
          Re-running the agent on a matched individual will surface the new
          <code>external_suggestions</code> section with their citations.
        </p>
      `;
      // Switch dialog into "done" state so the user knows the work is finished.
      // Hide the Import button (no second submission), relabel Cancel → Close.
      $("#import-submit").hidden = true;
      const cancelBtn = $("#import-dialog button[value='cancel']");
      if (cancelBtn) cancelBtn.textContent = "Close";
      // Refresh data so the topbar / cards update
      await fetchData();
      computeLayout();
      renderCards();
    } catch (e) {
      $("#import-progress").hidden = true;
      alert(`Import failed: ${e.message}`);
    } finally {
      $("#import-submit").disabled = false;
    }
  });

  // Claim-from-import: surface unmatched externals so the user can promote
  // direct descendants into the tree.
  const familyDisplay = (fam) => {
    const husband = state.byId.get(fam.husband);
    const wife = state.byId.get(fam.wife);
    const parts = [];
    if (husband) parts.push(`${husband.name} (b.${husband.birth_year ?? "?"})`);
    if (wife) parts.push(`${wife.name} (b.${wife.birth_year ?? "?"})`);
    return parts.join(" + ") || `Family ${fam.id}`;
  };

  const renderClaimList = (unmatched, filterText) => {
    const list = $("#claim-list");
    const empty = $("#claim-empty");
    list.innerHTML = "";
    const f = (filterText ?? "").toLowerCase().trim();
    const filtered = unmatched.filter((u) => {
      if (!f) return true;
      const hay = `${u.name ?? ""} ${u.birth_year ?? ""}`.toLowerCase();
      return hay.includes(f);
    });
    if (filtered.length === 0) {
      empty.hidden = false;
      empty.textContent = unmatched.length === 0
        ? "No unmatched externals to claim. Import a GEDCOM first."
        : "No matches for that filter.";
      return;
    }
    empty.hidden = true;
    const familyOptions = state.families
      .map((fam) => `<option value="${escapeHtml(fam.id)}">${escapeHtml(familyDisplay(fam))}</option>`)
      .join("");
    for (const u of filtered) {
      const row = document.createElement("div");
      row.style.cssText = "padding:8px;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
      row.innerHTML = `
        <div style="flex:1;min-width:200px;">
          <strong>${escapeHtml(u.name ?? "(unknown)")}</strong>
          <span class="muted" style="margin-left:6px;">b.${u.birth_year ?? "?"}${u.birth_place ? ", " + escapeHtml(u.birth_place) : ""}</span>
          <div class="muted" style="font-size:11px;">from ${escapeHtml(u.external_source_file ?? "(unknown)")}</div>
        </div>
        <select class="claim-fam" style="min-width:160px;max-width:260px;">
          <option value="">— add as child of —</option>
          ${familyOptions}
        </select>
        <button type="button" class="claim-btn primary">Claim</button>
      `;
      const select = row.querySelector(".claim-fam");
      const btn = row.querySelector(".claim-btn");
      btn.addEventListener("click", async () => {
        if (!select.value) {
          alert("Pick a family to attach this person to first.");
          return;
        }
        btn.disabled = true;
        btn.textContent = "Claiming…";
        try {
          const res = await fetch("/api/external/claim-as-descendant", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ external_id: u.id, target_family_id: select.value }),
          });
          const body = await res.json();
          if (!res.ok) {
            alert(`Claim failed: ${body.error}`);
            btn.disabled = false;
            btn.textContent = "Claim";
            return;
          }
          row.remove();
          await refreshAndReselect(body.claimed.id);
        } catch (e) {
          alert(`Claim failed: ${e.message}`);
          btn.disabled = false;
          btn.textContent = "Claim";
        }
      });
      list.appendChild(row);
    }
  };

  // Tree review modal — deterministic checks (chronology, age gaps,
  // band/evidence mismatches, dangling refs).
  const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };
  let reviewFindings = [];
  const renderReviewList = () => {
    const list = $("#review-list");
    const empty = $("#review-empty");
    list.innerHTML = "";
    const showErrors = $("#review-filter-errors").checked;
    const showWarnings = $("#review-filter-warnings").checked;
    const showInfo = $("#review-filter-info").checked;
    const filtered = reviewFindings
      .filter((f) =>
        (f.severity === "error" && showErrors) ||
        (f.severity === "warning" && showWarnings) ||
        (f.severity === "info" && showInfo),
      )
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
    if (filtered.length === 0) {
      empty.hidden = false;
      empty.textContent = reviewFindings.length === 0
        ? "Nothing to flag — the tree is internally consistent."
        : "No findings at the selected severity levels.";
      return;
    }
    empty.hidden = true;
    for (const f of filtered) {
      const row = document.createElement("div");
      row.style.cssText = "padding:8px 12px;border-bottom:1px solid #eee;display:flex;gap:10px;align-items:flex-start;";
      const sevColours = { error: "#c00000", warning: "#bf6f00", info: "#5a6170" };
      row.innerHTML = `
        <span style="display:inline-block;min-width:60px;font-size:11px;font-weight:700;color:${sevColours[f.severity]};text-transform:uppercase;">${f.severity}</span>
        <div style="flex:1;font-size:13px;">
          <div>${escapeHtml(f.message)}</div>
          <div class="muted" style="font-size:11px;margin-top:2px;">${escapeHtml(f.kind)}${f.individual_id ? " · " + escapeHtml(f.individual_id) : ""}${f.family_id ? " · " + escapeHtml(f.family_id) : ""}</div>
        </div>
        ${f.individual_id ? `<button type="button" class="ghost review-jump" data-id="${escapeHtml(f.individual_id)}">Open</button>` : ""}
      `;
      const jump = row.querySelector(".review-jump");
      if (jump) {
        jump.addEventListener("click", () => {
          $("#review-dialog").close();
          selectPerson(jump.dataset.id);
        });
      }
      list.appendChild(row);
    }
  };

  $("#review-tree")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/review");
      if (!res.ok) {
        alert(`Review failed: ${(await res.json()).error}`);
        return;
      }
      const { findings } = await res.json();
      reviewFindings = findings;
      renderReviewList();
      $("#review-dialog").showModal();
    } catch (e) {
      alert(`Review failed: ${e.message}`);
    }
  });
  $("#review-filter-errors")?.addEventListener("change", renderReviewList);
  $("#review-filter-warnings")?.addEventListener("change", renderReviewList);
  $("#review-filter-info")?.addEventListener("change", renderReviewList);

  $("#claim-descendants")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/external/unmatched");
      const { unmatched } = await res.json();
      $("#claim-filter").value = "";
      renderClaimList(unmatched, "");
      $("#claim-filter").oninput = (e) => renderClaimList(unmatched, e.target.value);
      $("#claim-dialog").showModal();
    } catch (e) {
      alert(`Failed to load unmatched: ${e.message}`);
    }
  });

  // Ingest modal — Phase 1: list-only. Phase 2/3 wire up the Process
  // buttons to story / document extraction endpoints.
  const STATUS_BADGE = {
    unprocessed: { label: "unprocessed", colour: "#5a6170" },
    processed:   { label: "processed",   colour: "#1f6b3a" },
    changed:     { label: "changed",     colour: "#bf6f00" },
    failed:      { label: "failed",      colour: "#c00000" },
  };
  const fmtKB = (bytes) => bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(0)}KB`;

  const renderIngestList = (files, kind, listSelector, emptySelector) => {
    const list = $(listSelector);
    const empty = $(emptySelector);
    list.innerHTML = "";
    if (!files || files.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const f of files) {
      const sb = STATUS_BADGE[f.status] ?? STATUS_BADGE.unprocessed;
      const row = document.createElement("div");
      row.style.cssText = "padding:8px 10px;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center;font-size:13px;";
      const matchInfo = f.status === "processed" && f.individuals_matched != null
        ? ` · ${f.individuals_matched} matched, ${f.evidence_written} evidence`
        : "";
      const errorInfo = f.status === "failed" && f.error
        ? `<div class="muted" style="font-size:11px;color:#c00000;">${escapeHtml(f.error)}</div>`
        : "";
      const buttonLabel = f.status === "processed" ? "Re-process" : "Process";
      const titleHint = kind === "story"
        ? "Process this story via Claude (~$0.01)."
        : "Process this document via Claude vision (~$0.05). Confirms cost before firing.";
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><strong>${escapeHtml(f.name)}</strong></div>
          <div class="muted" style="font-size:11px;">${fmtKB(f.size_bytes)} · hash ${escapeHtml(f.hash.slice(0, 8))}…${matchInfo}</div>
          ${errorInfo}
        </div>
        <span style="font-size:10px;font-weight:700;color:${sb.colour};text-transform:uppercase;min-width:80px;text-align:right;">${sb.label}</span>
        <button type="button" class="ghost ingest-process-btn" data-name="${escapeHtml(f.name)}" data-kind="${kind}" title="${titleHint}">
          ${buttonLabel}
        </button>
      `;
      const btn = row.querySelector(".ingest-process-btn");
      btn.addEventListener("click", async () => {
        // Cost confirmation for documents only — stories are negligibly cheap.
        if (kind === "document") {
          const ok = confirm(
            `Process "${f.name}" via Claude vision?\n\n` +
            `Estimated cost: ~$0.05 (upper bound).\n` +
            `Re-processing the same file is idempotent and won't double-write evidence.`,
          );
          if (!ok) return;
        }
        btn.disabled = true;
        btn.textContent = "Processing…";
        const endpoint = kind === "story"
          ? `/api/ingest/story/${encodeURIComponent(f.name)}`
          : `/api/ingest/document/${encodeURIComponent(f.name)}`;
        try {
          const res = await fetch(endpoint, { method: "POST" });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          await refreshIngestModal();
          const docKind = body.summary.document_kind ? ` [${body.summary.document_kind}]` : "";
          $("#ingest-status").textContent =
            `${f.name}${docKind}: ${body.summary.individuals_matched} matched, ${body.summary.evidence_written} evidence written` +
            (body.summary.contradictions_flagged > 0
              ? `, ${body.summary.contradictions_flagged} contradiction(s) flagged`
              : "");
        } catch (e) {
          $("#ingest-status").textContent = `${f.name}: ${e.message}`;
          btn.disabled = false;
          btn.textContent = buttonLabel;
        }
      });
      list.appendChild(row);
    }
  };

  const refreshIngestModal = async () => {
    const status = $("#ingest-status");
    status.textContent = "Scanning…";
    try {
      const res = await fetch("/api/ingest/scan");
      if (!res.ok) {
        status.textContent = `Scan failed: ${(await res.json()).error}`;
        return;
      }
      const { documents, stories, paths } = await res.json();
      $("#ingest-paths").innerHTML =
        `Stories folder: <code>${escapeHtml(paths.stories)}</code><br>` +
        `Documents folder: <code>${escapeHtml(paths.documents)}</code>`;
      renderIngestList(stories, "story", "#ingest-stories-list", "#ingest-stories-empty");
      renderIngestList(documents, "document", "#ingest-documents-list", "#ingest-documents-empty");
      status.textContent = `Found ${stories.length} stories, ${documents.length} documents.`;
    } catch (e) {
      status.textContent = `Scan failed: ${e.message}`;
    }
  };

  $("#ingest-documents")?.addEventListener("click", async () => {
    await refreshIngestModal();
    $("#ingest-dialog").showModal();
  });
  $("#ingest-rescan")?.addEventListener("click", async () => {
    await refreshIngestModal();
  });

  // Active-runs indicator: poll every 5 seconds while the page is open.
  // Updates the topbar dot + count, and re-renders the modal if it's open.
  let activeRunsModalOpen = false;
  const fmtElapsed = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  const renderActiveRunsList = (runs) => {
    const list = $("#active-runs-list");
    const empty = $("#active-runs-empty");
    list.innerHTML = "";
    if (runs.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const r of runs) {
      const row = document.createElement("div");
      row.style.cssText = "padding:10px;border-bottom:1px solid #eee;display:flex;gap:10px;align-items:center;";
      row.innerHTML = `
        <div style="flex:1;">
          <div><strong>${escapeHtml(r.label || r.id)}</strong></div>
          <div class="muted" style="font-size:11px;">id: ${escapeHtml(r.id)} · running for ${fmtElapsed(r.elapsed_ms)}</div>
        </div>
        <button type="button" class="abort-run-btn" data-id="${escapeHtml(r.id)}" style="background:#c00000;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px;">Cancel</button>
      `;
      row.querySelector(".abort-run-btn").addEventListener("click", async () => {
        const btn = row.querySelector(".abort-run-btn");
        btn.disabled = true;
        btn.textContent = "Cancelling…";
        try {
          await fetch(`/api/runs/abort/${encodeURIComponent(r.id)}`, { method: "POST" });
        } catch (e) {
          alert(`Cancel failed: ${e.message}`);
        }
        await pollActiveRuns();
      });
      list.appendChild(row);
    }
  };
  const pollActiveRuns = async () => {
    try {
      const res = await fetch("/api/runs/active");
      if (!res.ok) return;
      const { runs } = await res.json();
      const count = runs.length;
      const countEl = $("#active-runs-count");
      const dotEl = $("#active-runs-dot");
      if (countEl && dotEl) {
        countEl.textContent = `${count} running`;
        dotEl.style.background = count === 0 ? "#5a6170" : "#1f6b3a";
        if (count > 0) {
          dotEl.style.boxShadow = "0 0 6px rgba(31,107,58,0.7)";
        } else {
          dotEl.style.boxShadow = "none";
        }
      }
      if (activeRunsModalOpen) renderActiveRunsList(runs);
    } catch {
      /* swallow — the indicator just won't update */
    }
  };
  pollActiveRuns();
  setInterval(pollActiveRuns, 5000);

  $("#active-runs")?.addEventListener("click", async () => {
    activeRunsModalOpen = true;
    await pollActiveRuns();
    $("#active-runs-dialog").showModal();
  });
  $("#active-runs-dialog")?.addEventListener("close", () => {
    activeRunsModalOpen = false;
  });

  $("#refresh-leads-btn")?.addEventListener("click", async () => {
    const id = state.selectedId;
    if (!id) return;
    const btn = $("#refresh-leads-btn");
    const summaryEl = $("#external-leads-summary");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Refreshing…";
    summaryEl.textContent = "";
    try {
      const res = await fetch(`/api/external/refresh/${encodeURIComponent(id)}`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        summaryEl.textContent = `Refresh failed: ${err.error ?? res.status}`;
        return;
      }
      const { leads, summary } = await res.json();
      // Race-safety: only render if still on this individual.
      if (state.selectedId !== id) return;
      renderExternalLeads(leads);
      if (summary) {
        const parts = [
          `WikiTree=${summary.wikitree_count ?? 0}`,
          `FamilySearch=${summary.familysearch_count ?? 0}`,
          `TNA=${summary.tna_count ?? 0}`,
        ];
        if (summary.errors?.length) {
          parts.push(`errors: ${summary.errors.map((e) => e.source).join(", ")}`);
        }
        summaryEl.textContent = parts.join(" · ");
      }
    } catch (e) {
      summaryEl.textContent = `Refresh failed: ${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
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
