// Shared chrome (sidebar + workbench topbar). Pages opt in by:
//   1. Adding `wb-chrome` to <body> classList
//   2. Calling renderChrome({ active, tabs, sectionLabel, actions })
//
// Kept tiny and dependency-free so it can be loaded on every page.

const NAV_ITEMS = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard.html" },
  { key: "tree", label: "Ancestors (Tree)", href: "/" },
  { key: "list", label: "Ancestors (List)", href: "/list.html" },
  { key: "sources", label: "Sources", href: "/sources.html" },
  { key: "evidence-matrix", label: "Evidence Matrix", href: "/evidence-matrix.html" },
  { key: "review-queue", label: "Review Queue", href: "/review.html" },
];

// Single dot icon used for every nav item — keeps the chrome dependency-
// free while giving the eye a consistent leading mark. Pages can swap to
// their own SVGs later without touching this file.
const navIconSvg = () =>
  '<svg class="wb-nav-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>';

const renderSidebar = (activeKey) => {
  const items = NAV_ITEMS.map((it) => {
    const cur = it.key === activeKey ? ' aria-current="page"' : "";
    return `<a href="${it.href}"${cur} data-nav-key="${it.key}">${navIconSvg()}<span>${it.label}</span></a>`;
  }).join("");
  return `
    <aside id="wb-sidebar" aria-label="Workbench navigation">
      <div class="wb-brand">
        <div class="wb-brand-title">Family Research</div>
        <div class="wb-brand-sub">Bayesian Workbench</div>
      </div>
      <nav>${items}</nav>
      <div class="wb-foot">Local Research</div>
    </aside>
  `;
};

const renderTopbar = ({ sectionLabel = "", tabs = [], activeTab = null, actions = "" } = {}) => {
  const tabHtml = tabs
    .map((t) => {
      const sel = t.key === activeTab ? ' aria-selected="true"' : ' aria-selected="false"';
      return `<button type="button" class="wb-tab" data-tab-key="${t.key}"${sel}>${t.label}</button>`;
    })
    .join("");
  const tabsBlock = tabs.length ? `<div class="wb-tabs" role="tablist">${tabHtml}</div>` : "";
  return `
    <header id="wb-topbar">
      ${sectionLabel ? `<div class="wb-section-label">${sectionLabel}</div>` : ""}
      ${tabsBlock}
      <div class="wb-actions">${actions}</div>
    </header>
  `;
};

// Mounts chrome at the very top of <body>. Idempotent: removes any prior
// chrome before re-rendering so pages can call this on tab change.
export const renderChrome = (opts = {}) => {
  const { active, tabs, sectionLabel, activeTab, actions, onTabChange } = opts;
  document.querySelectorAll("#wb-sidebar, #wb-topbar").forEach((el) => el.remove());
  const html = renderSidebar(active) + renderTopbar({ sectionLabel, tabs, activeTab, actions });
  document.body.insertAdjacentHTML("afterbegin", html);
  if (onTabChange && tabs?.length) {
    document.querySelectorAll("#wb-topbar .wb-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-tab-key");
        document.querySelectorAll("#wb-topbar .wb-tab").forEach((b) =>
          b.setAttribute("aria-selected", b === btn ? "true" : "false"),
        );
        onTabChange(key);
      });
    });
  }
};

// Convenience: pages that just want the sidebar (no topbar slots) can
// call this from inline script without an import roundtrip.
window.__renderChrome = renderChrome;
