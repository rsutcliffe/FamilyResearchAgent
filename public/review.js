const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

$$(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab-btn").forEach((b) => b.classList.remove("active"));
    $$(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const badge = (band) =>
  band ? `<span class="badge ${band}">${band}</span>` : `<span class="badge D">?</span>`;

const personDates = (p) => {
  const parts = [];
  if (p.birth_year) parts.push(`b.${p.birth_year}`);
  if (p.death_date) {
    const m = String(p.death_date).match(/(\d{4})/);
    if (m) parts.push(`d.${m[1]}`);
  }
  return parts.length ? `<span class="person-dates">${parts.join(" ")}</span>` : "";
};

// ---------------------------------------------------------------------------
// Confirmation Queue
// ---------------------------------------------------------------------------

let pendingConfirmId = null;
let pendingConfirmBand = null;

const loadConfirmQueue = async () => {
  const res = await fetch("/api/review/unconfirmed");
  const { items } = await res.json();

  $("#confirm-loading").hidden = true;
  $("#confirm-count").textContent = items.length;

  if (!items.length) {
    $("#confirm-empty").hidden = false;
    return;
  }

  const tbody = $("#confirm-body");
  tbody.innerHTML = items
    .map(
      (p) => `
    <tr data-id="${p.id}" data-band="${p.confidence}">
      <td>
        <div class="person-name">${p.name}</div>
        ${personDates(p)}
      </td>
      <td>${p.generation ?? "—"}</td>
      <td>${badge(p.confidence)}</td>
      <td class="muted" style="font-size:12px">${p.birth_place ?? ""}</td>
      <td class="action-cell">
        <button class="ghost confirm-btn">Confirm…</button>
      </td>
    </tr>`,
    )
    .join("");

  tbody.querySelectorAll(".confirm-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("tr");
      pendingConfirmId = row.dataset.id;
      pendingConfirmBand = row.dataset.band;
      openConfirmDialog(pendingConfirmBand);
    });
  });

  $("#confirm-table").hidden = false;
};

const openConfirmDialog = (band) => {
  const dlg = $("#confirm-dialog");
  dlg.querySelector("[name=title]").value = "";
  dlg.querySelector("[name=repository]").value = "";
  dlg.querySelector("[name=reference]").value = "";
  dlg.querySelector("[name=url]").value = "";
  dlg.querySelector("[name=note]").value = "";
  const sel = dlg.querySelector("[name=new_confidence]");
  sel.value = band === "A" || band === "B" || band === "C" ? band : "";
  dlg.showModal();
};

$("#confirm-dialog").addEventListener("close", async () => {
  if ($("#confirm-dialog").returnValue !== "confirm") return;
  if (!pendingConfirmId) return;

  const form = $("#confirm-dialog").querySelector("form");
  const data = new FormData(form);
  const body = {
    decision: "accepted",
    new_confidence: data.get("new_confidence"),
    citation: {
      title: data.get("title"),
      repository: data.get("repository"),
      reference: data.get("reference"),
      url: data.get("url") || undefined,
    },
    note: data.get("note") || undefined,
  };

  try {
    const res = await fetch(
      `/api/decision/${encodeURIComponent(pendingConfirmId)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Error: ${err.error ?? res.statusText}`);
      return;
    }
    // Remove confirmed row from table
    const row = $("#confirm-body").querySelector(`tr[data-id="${pendingConfirmId}"]`);
    row?.remove();
    const remaining = $("#confirm-body").querySelectorAll("tr").length;
    $("#confirm-count").textContent = remaining;
    if (!remaining) {
      $("#confirm-table").hidden = true;
      $("#confirm-empty").hidden = false;
    }
  } catch (e) {
    alert(`Network error: ${e.message}`);
  } finally {
    pendingConfirmId = null;
    pendingConfirmBand = null;
  }
});

// ---------------------------------------------------------------------------
// Weak Links
// ---------------------------------------------------------------------------

let pendingDisputeId = null;

const loadWeakLinks = async () => {
  const res = await fetch("/api/review/weak-links");
  const { items } = await res.json();

  $("#weak-loading").hidden = true;
  $("#weak-count").textContent = items.length;

  if (!items.length) {
    $("#weak-empty").hidden = false;
    return;
  }

  const tbody = $("#weak-body");
  tbody.innerHTML = items
    .map((link) => {
      const findingHtml = link.findings
        .map(
          (f) =>
            `<div class="finding-${f.severity}">${f.severity === "error" ? "✖" : "⚠"} ${f.message}</div>`,
        )
        .join("");
      const disputedTag = link.is_disputed
        ? `<span class="disputed-tag">Disputed</span>`
        : "";
      const dispBtn = link.is_disputed
        ? ""
        : `<button class="ghost dispute-btn">Dispute…</button>`;
      return `<tr class="${link.is_disputed ? "disputed" : ""}" data-rel-id="${link.relationship_id}">
        <td><span class="person-name">${link.parent_name}</span></td>
        <td><span class="person-name">${link.child_name}</span></td>
        <td class="muted" style="font-size:12px">${link.kind ?? "—"}</td>
        <td>${badge(link.confidence)}</td>
        <td>${findingHtml || '<span class="muted" style="font-size:12px">D-band, no evidence</span>'}${disputedTag}</td>
        <td class="action-cell">${dispBtn}</td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".dispute-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("tr");
      pendingDisputeId = row.dataset.relId;
      const link = items.find((l) => l.relationship_id === pendingDisputeId);
      openDisputeDialog(link);
    });
  });

  $("#weak-table").hidden = false;
};

const openDisputeDialog = (link) => {
  const dlg = $("#dispute-dialog");
  const issues = link.findings.map((f) => f.message).join(" | ");
  $("#dispute-summary").textContent =
    `${link.parent_name} → ${link.child_name} (${link.kind ?? "link"}).${issues ? " Issues: " + issues : ""}`;
  dlg.querySelector("[name=reason]").value = "";
  dlg.showModal();
};

$("#dispute-dialog").addEventListener("close", async () => {
  if ($("#dispute-dialog").returnValue !== "confirm") return;
  if (!pendingDisputeId) return;

  const reason = $("#dispute-dialog").querySelector("[name=reason]").value.trim();
  if (!reason) return;

  try {
    const res = await fetch(
      `/api/review/dispute-link/${encodeURIComponent(pendingDisputeId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Error: ${err.error ?? res.statusText}`);
      return;
    }
    // Mark row as disputed in the UI
    const row = $("#weak-body").querySelector(`tr[data-rel-id="${pendingDisputeId}"]`);
    if (row) {
      row.classList.add("disputed");
      const actionCell = row.querySelector(".action-cell");
      if (actionCell) actionCell.innerHTML = '<span class="disputed-tag">Disputed</span>';
      const findingsCell = row.querySelector("td:nth-child(5)");
      if (findingsCell) {
        const existing = findingsCell.querySelector(".disputed-tag");
        if (!existing) findingsCell.insertAdjacentHTML("beforeend", '<span class="disputed-tag">Disputed</span>');
      }
    }
  } catch (e) {
    alert(`Network error: ${e.message}`);
  } finally {
    pendingDisputeId = null;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadConfirmQueue();
loadWeakLinks();
