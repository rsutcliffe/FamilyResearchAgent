import { test, expect } from "./fixtures.js";

// UI regression suite — covers the bugs we've shipped fixes for, plus the
// load-bearing happy paths. Add a test here every time we fix a UI issue
// so it doesn't reappear silently.

// Helper: cards live inside the pan/zoom transformed container. Most are
// outside the visible canvas viewport at default zoom, so a normal .click()
// fails geometry checks even with force:true. dispatchEvent fires the
// synthetic click directly on the DOM node — the user's click handler still
// runs (selecting the card, opening the detail panel) without geometry
// validation. This is correct for tests because we're verifying behaviour,
// not user reachability.
const clickCard = async (locator) => {
  await locator.dispatchEvent("click");
};

// Helper: agent runs go through cascadeCheck() which shows a native
// confirm() dialog when the chain to root passes through a band C/D link.
// D-band cards always trigger this. In tests we auto-accept so the run
// proceeds — the cascade-warning UI flow itself is tested separately
// (TODO: add explicit cascade-dialog test).
const autoAcceptDialogs = (page) => {
  page.on("dialog", (dialog) => dialog.accept());
};

test.describe("Workbench chrome (Slice 0)", () => {
  test("sidebar renders all 5 nav items on tree page", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#wb-sidebar")).toBeVisible();
    const keys = await page.locator("#wb-sidebar nav a").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-nav-key")),
    );
    expect(keys).toEqual(["dashboard", "tree", "list", "sources", "evidence-matrix"]);
  });

  test("active sidebar item carries aria-current on its own page", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('#wb-sidebar nav a[data-nav-key="tree"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.goto("/list.html");
    await expect(page.locator('#wb-sidebar nav a[data-nav-key="list"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("workbench topbar shows the section label", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#wb-topbar .wb-section-label")).toHaveText("Research Workbench");
  });
});

test.describe("Evidence Matrix (Slice 4)", () => {
  test("filters narrow the table", async ({ page }) => {
    await page.route("**/api/dashboard/all-claims", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              individual_id: "@1@",
              individual_name: "Alice",
              band: "B",
              decision: null,
              contributions: [
                { kind: "parish_baptism", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept" },
                { kind: "story_contradiction", lr: 0.4, log_lr: -0.4, source_tier: 3, source_kind: "external_suggestion" },
              ],
            },
            {
              individual_id: "@2@",
              individual_name: "Bob",
              band: "D",
              decision: null,
              contributions: [
                { kind: "census_record", lr: 8, log_lr: 0.9, source_tier: 2, source_kind: "decision_accept" },
              ],
            },
          ],
        }),
      }),
    );
    await page.goto("/evidence-matrix.html");
    await expect(page.locator("#wb-sidebar nav a[data-nav-key='evidence-matrix']")).toHaveAttribute("aria-current", "page");
    // Initial load: 3 rows (Alice has 2, Bob has 1)
    await expect(page.locator("#matrix-table tbody tr")).toHaveCount(3);
    // Filter by status=conflicting → only Alice's contradicted row
    await page.locator("#filter-status").selectOption("conflicting");
    await expect(page.locator("#matrix-table tbody tr")).toHaveCount(1);
    // Search for Bob → only Bob's census row
    await page.locator("#filter-status").selectOption("");
    await page.locator("#filter-search").fill("bob");
    await expect(page.locator("#matrix-table tbody tr")).toHaveCount(1);
    await expect(page.locator("#matrix-table tbody tr td:first-child")).toContainText("Bob");
  });

  test("clicking a sortable column header toggles sort", async ({ page }) => {
    await page.route("**/api/dashboard/all-claims", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            { individual_id: "@2@", individual_name: "Zara", band: "B", decision: null, contributions: [{ kind: "parish_baptism", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept" }] },
            { individual_id: "@1@", individual_name: "Alice", band: "B", decision: null, contributions: [{ kind: "parish_baptism", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept" }] },
          ],
        }),
      }),
    );
    await page.goto("/evidence-matrix.html");
    // Default sort = individual_name asc → Alice first
    await expect(page.locator("#matrix-table tbody tr td:first-child").first()).toContainText("Alice");
    await page.locator("th[data-sort-key='individual_name']").click(); // toggle to desc
    await expect(page.locator("#matrix-table tbody tr td:first-child").first()).toContainText("Zara");
  });
});

test.describe("Sources page (Slice 3)", () => {
  const stubSources = (page) =>
    page.route("**/api/sources", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            { source: "https://archive.org/parish/wilfrid", tier: 1, citation_count: 5, individuals: [{ id: "@1@", name: "Alice" }, { id: "@2@", name: "Bob" }], last_cited: new Date().toISOString() },
            { source: "https://findmypast.co.uk/idx", tier: 2, citation_count: 2, individuals: [{ id: "@1@", name: "Alice" }], last_cited: new Date().toISOString() },
            { source: "https://wikitree.com/X-1", tier: 3, citation_count: 1, individuals: [{ id: "@3@", name: "Carol" }], last_cited: new Date().toISOString() },
          ],
        }),
      }),
    );

  test("default view groups by individual with accordions", async ({ page }) => {
    await stubSources(page);
    await page.goto("/sources.html");
    await expect(page.locator("#wb-sidebar nav a[data-nav-key='sources']")).toHaveAttribute("aria-current", "page");
    // 3 individuals (Alice, Bob, Carol) -> 3 accordions
    const accs = page.locator(".wb-individual-acc");
    await expect(accs).toHaveCount(3);
    // Click Alice's accordion to reveal her sources
    const alice = page.locator('.wb-individual-acc:has(.wb-individual-acc-name:has-text("Alice"))');
    await alice.locator("summary").click();
    await expect(alice.locator("table")).toBeVisible();
    await expect(alice.locator("tbody tr")).toHaveCount(2);
  });

  test("toggle to By tier view shows tiered sections", async ({ page }) => {
    await stubSources(page);
    await page.goto("/sources.html");
    await page.locator("#group-tier").click();
    await expect(page.locator("#sources-by-tier")).toBeVisible();
    await expect(page.locator("#sources-by-individual")).toBeHidden();
    await expect(page.locator("#sources-by-tier .wb-card")).toHaveCount(3);
  });

  test("sort by source count reorders accordions", async ({ page }) => {
    await stubSources(page);
    await page.goto("/sources.html");
    await page.locator("#sort-by").selectOption("count-desc");
    // Alice has 2 sources, Bob and Carol have 1 each — so Alice should be first.
    const firstName = await page.locator(".wb-individual-acc").first().locator(".wb-individual-acc-name").textContent();
    expect(firstName?.trim()).toBe("Alice");
  });
});

test.describe("Dashboard (Slice 2)", () => {
  const stubDashboardEndpoints = async (page) => {
    await page.route("**/api/dashboard/distribution", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ bands: { A: 2, B: 5, C: 1, D: 3 }, total: 11 }),
      }),
    );
    await page.route("**/api/dashboard/recent-runs*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{ individual_id: "@1@", individual_name: "Alice", searched_at: new Date().toISOString(), search_count: 5 }],
        }),
      }),
    );
    await page.route("**/api/dashboard/recent-evidence*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            { individual_id: "@1@", individual_name: "Alice", kind: "parish_baptism", source: "St Wilfrid", source_tier: 1, added_at: new Date().toISOString() },
          ],
        }),
      }),
    );
    await page.route("**/api/dashboard/queue", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            { individual_id: "@5@", individual_name: "Eve", kind: "flagged", severity: "high", summary: "Needs follow-up" },
          ],
        }),
      }),
    );
    await page.route("**/api/runs/active", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [] }) }),
    );
  };

  test("renders distribution + threads + evidence cards", async ({ page }) => {
    await stubDashboardEndpoints(page);
    await page.goto("/dashboard.html");
    await expect(page.locator("#wb-sidebar nav a[data-nav-key='dashboard']")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#distribution-total")).toHaveText("N = 11 individuals");
    const bars = page.locator(".wb-bar");
    await expect(bars).toHaveCount(4);
    await expect(page.locator("#recent-evidence .wb-feed-row")).toHaveCount(1);
    await expect(page.locator("#recent-runs .wb-thread")).toHaveCount(1);
  });

  test("Evidence Queue tab swaps the view and lists queue items", async ({ page }) => {
    await stubDashboardEndpoints(page);
    await page.goto("/dashboard.html");
    await page.locator(".wb-tab[data-tab-key='evidence-queue']").click();
    await expect(page.locator("#active-projects-view")).toBeHidden();
    await expect(page.locator("#evidence-queue-view")).toBeVisible();
    await expect(page.locator("#queue-table tbody tr")).toHaveCount(1);
    await expect(page.locator("#queue-table tbody tr td:nth-child(2)")).toContainText("Eve");
  });
});

test.describe("Detail panel — Claims Matrix + Confidence Donut (Slice 1)", () => {
  test("clicking a card reveals the new detail sections", async ({ page, isolatedReads }) => {
    // Stub /api/confidence/:id with a payload that yields one row per category.
    await page.route("**/api/confidence/*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          legacy_band: "B",
          evidence: { identity: [], relationship: [] },
          result: {
            band: "B",
            posterior: 0.854,
            prior: 0.5,
            contributions: [
              { kind: "parish_baptism", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept", note: "St Wilfrid 1842" },
              { kind: "census_record", lr: 8, log_lr: 0.9, source_tier: 2, source_kind: "decision_accept", note: "1851 Brooklyn" },
              { kind: "wikitree_profile", lr: 1.8, log_lr: 0.26, source_tier: 3, source_kind: "external_suggestion", note: "from wikitree" },
            ],
          },
        }),
      }),
    );
    await page.route("**/api/review", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ findings: [] }) }),
    );
    await page.route("**/api/external/leads/*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ leads: [] }) }),
    );
    await page.route("**/api/siblings/reconcile/*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ siblings: [], strength: "none" }) }),
    );

    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator(`.card[data-id="@TF_DAD@"]`).dispatchEvent("click");
    await expect(page.locator("#claims-matrix-section")).toBeVisible();
    await expect(page.locator("#confidence-donut-slot svg")).toBeVisible();
    // Donut centre shows the band letter
    await expect(page.locator("#confidence-donut-slot svg text").first()).toHaveText("B");
    // Matrix has the 3 expected rows
    const claimRows = page.locator("#claims-matrix tbody tr");
    await expect(claimRows).toHaveCount(3);
    await expect(page.locator("#confidence-band-scale-slot .wb-band-scale-cell.active")).toHaveText("B");
  });

  test("Run Bayesian Update button refetches /api/confidence", async ({ page, isolatedReads }) => {
    let callCount = 0;
    await page.route("**/api/confidence/*", (route) => {
      callCount++;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          legacy_band: "D",
          evidence: { identity: [], relationship: [] },
          result: { band: "D", posterior: 0.1, prior: 0.5, contributions: [] },
        }),
      });
    });
    await page.route("**/api/review", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ findings: [] }) }),
    );
    await page.route("**/api/external/leads/*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ leads: [] }) }),
    );
    await page.route("**/api/siblings/reconcile/*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ siblings: [], strength: "none" }) }),
    );

    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator(`.card[data-id="@TF_DAD@"]`).dispatchEvent("click");
    await expect(page.locator("#rerun-bayesian-btn")).toBeVisible();
    const beforeClicks = callCount;
    await page.locator("#rerun-bayesian-btn").click();
    await expect.poll(() => callCount).toBeGreaterThan(beforeClicks);
  });
});

test.describe("Tree view", () => {
  test("loads and renders cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#topbar")).toBeVisible();
    // Wait for tree to populate
    await page.waitForSelector(".card", { timeout: 5000 });
    const cards = page.locator(".card").filter({ hasNot: page.locator(".placeholder") });
    expect(await cards.count()).toBeGreaterThan(20);
  });

  test("topbar shows expected controls", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#depth")).toBeVisible();
    await expect(page.locator("#toggle-weak")).toBeVisible();
    await expect(page.locator("#zoom-in")).toBeVisible();
    await expect(page.locator("#export-gedcom")).toBeVisible();
  });

  test("renders the root's spouse next to root with a marriage line", async ({ page, isolatedReads }) => {
    await page.goto("/");
    await page.waitForSelector(".card");
    // Test fixture seeds @TF_SPOUSE@ as Richard's wife in @TF_MARR@.
    const spouseCard = page.locator(`.card[data-id="@TF_SPOUSE@"]`);
    await expect(spouseCard).toBeAttached();
    // Marriage line is a distinct SVG element, not a parent-child path.
    const marriageLine = page.locator("#connections line.marriage");
    await expect(marriageLine).toHaveCount(1);
  });

  test("renders descendants below root", async ({ page, isolatedReads }) => {
    await page.goto("/");
    await page.waitForSelector(".card");
    // Fixture: @TF_KID@ is a child of root via @TF_MARR@, so should render below root.
    const childCard = page.locator(`.card[data-id="@TF_KID@"]`);
    await expect(childCard).toBeAttached();
    // y-coordinate of the descendant card should be greater than root's
    // (down on screen). Read the inline style.top from the rendered DOM.
    const yByCard = async (id) => {
      const top = await page.locator(`.card[data-id="${id}"]`).evaluate((el) => el.style.top);
      return parseFloat(top);
    };
    const rootY = await yByCard("@I1825902591@");
    const kidY = await yByCard("@TF_KID@");
    expect(kidY).toBeGreaterThan(rootY);
  });
});

test.describe("Detail panel — clean state on selection", () => {
  // Regression for the "spinner spinning on never-visited node" bug.
  test("opening an unvisited node shows clean state, no spinner", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".card");
    // Pick an UNRESEARCHED card so we can assert the empty-state hint shows.
    // Filter out .researched cards which would display prior agent output.
    const dCard = page.locator(".card.D:not(.researched)").first();
    await expect(dCard).toBeAttached(); // tree must contain at least one
    await clickCard(dCard);
    await expect(page.locator("#detail-panel")).toBeVisible();
    // Status section MUST be hidden (no spinner) — the actual bug being guarded
    await expect(page.locator("#detail-panel #status")).toBeHidden();
    // Result area should show the empty-state hint, not stale text
    await expect(page.locator("#result")).toContainText("No research run yet");
  });

  test("status section stays hidden when navigating between nodes", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".card");
    const cards = page.locator(".card");
    await clickCard(cards.nth(0));
    await expect(page.locator("#detail-panel #status")).toBeHidden();
    await clickCard(cards.nth(1));
    await expect(page.locator("#detail-panel #status")).toBeHidden();
    await clickCard(cards.nth(2));
    await expect(page.locator("#detail-panel #status")).toBeHidden();
  });
});

test.describe("External API leads panel", () => {
  test("renders TNA + WikiTree leads from /api/external/leads/:id when a card is selected", async ({ page, isolatedReads }) => {
    await page.route("**/api/external/leads/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          leads: [
            {
              source_kind: "tna",
              external_id: "C12345",
              catalogue_ref: "PROB 11/1058/411",
              title: "Will of Anne Sweeting, Widow of Stogumber, Somerset",
              held_by: "The National Archives, Kew",
              covering_dates: "1780",
              catalogue_url: "https://discovery.nationalarchives.gov.uk/details/r/C12345",
            },
            {
              source_kind: "wikitree",
              external_id: "Sweeting-12",
              confidence: "strong",
              reasons: ["surname match"],
              external_data: {
                name: "Ann Sweeting",
                birth_year: 1802,
                birth_place: "Monks Frystone",
                profile_url: "https://www.wikitree.com/wiki/Sweeting-12",
              },
            },
          ],
        }),
      }),
    );

    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator(".card").first().dispatchEvent("click");
    await expect(page.locator("#detail-panel")).toBeVisible();
    await expect(page.locator("#external-leads")).toBeVisible();
    await expect(page.locator("#external-leads-list")).toContainText("PROB 11/1058/411");
    await expect(page.locator("#external-leads-list")).toContainText("The National Archives, Kew");
    // WikiTree section + a row showing the matched person's name
    await expect(page.locator("#external-leads-list")).toContainText("WikiTree");
    await expect(page.locator("#external-leads-list")).toContainText("Ann Sweeting");
    // Two outbound links — one to the TNA catalogue, one to the WikiTree profile
    await expect(page.locator("#external-leads-list a")).toHaveCount(2);
    await expect(page.locator(`#external-leads-list a[href*="Sweeting-12"]`)).toBeVisible();
  });

  test("hidden when there are no leads for the selected individual", async ({ page, isolatedReads }) => {
    await page.route("**/api/external/leads/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ leads: [] }) }),
    );
    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator(".card").first().dispatchEvent("click");
    await expect(page.locator("#detail-panel")).toBeVisible();
    await expect(page.locator("#external-leads")).toBeHidden();
  });

  test("Refresh button POSTs to /api/external/refresh/:id and re-renders", async ({ page, isolatedReads }) => {
    let leadsCalls = 0;
    await page.route("**/api/external/leads/**", (route) => {
      leadsCalls += 1;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          leads: [
            { source_kind: "tna", external_id: "X1", catalogue_ref: "REF/1", title: "First", held_by: "TNA", catalogue_url: "https://x" },
          ],
        }),
      });
    });
    let refreshPostBody = null;
    await page.route("**/api/external/refresh/**", async (route) => {
      refreshPostBody = route.request().postData() ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          leads: [
            { source_kind: "tna", external_id: "X1", catalogue_ref: "REF/1", title: "First", held_by: "TNA", catalogue_url: "https://x" },
            { source_kind: "tna", external_id: "X2", catalogue_ref: "REF/2", title: "Second (after refresh)", held_by: "TNA", catalogue_url: "https://y" },
          ],
          summary: { wikitree_count: 0, familysearch_count: 0, tna_count: 2, errors: [] },
        }),
      });
    });

    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator(".card").first().dispatchEvent("click");
    await expect(page.locator("#external-leads-list")).toContainText("First");
    await page.locator("#refresh-leads-btn").click();
    await expect(page.locator("#external-leads-list")).toContainText("Second (after refresh)");
    expect(refreshPostBody).not.toBeNull();
  });
});

test.describe("Agent run — UI lifecycle", () => {
  test("status section appears, completes, then hides on done", async ({
    page,
    mockAgentRun,
    isolatedReads,
  }) => {
    autoAcceptDialogs(page);
    await mockAgentRun({ searches: 3 });
    await page.goto("/");
    await page.waitForSelector(".card");
    const card = page.locator(".card.D:not(.researched)").first();
    await clickCard(card);
    await expect(page.locator("#detail-panel")).toBeVisible();
    await page.locator("#run-btn").click();
    // After the mocked SSE finishes, status hides on `done`.
    // (Skipping the "appears briefly" intermediate assertion — the mocked
    // stream completes faster than Playwright can race-test the visible state.)
    await expect(page.locator("#detail-panel #status")).toBeHidden({ timeout: 5000 });
    // Decision buttons appear after a successful run
    await expect(page.locator("#accept-btn")).toBeVisible();
    await expect(page.locator("#reject-btn")).toBeVisible();
    await expect(page.locator("#flag-btn")).toBeVisible();
  });

  test("displayed search counter never exceeds server's count", async ({
    page,
    mockAgentRun,
    isolatedReads,
  }) => {
    autoAcceptDialogs(page);
    await mockAgentRun({ searches: 4 });
    await page.goto("/");
    await page.waitForSelector(".card");
    const card = page.locator(".card.D:not(.researched)").first();
    await clickCard(card);
    await page.locator("#run-btn").click();
    await expect(page.locator("#detail-panel #status")).toBeHidden({ timeout: 5000 });
    // Status meta records the server's count, not whatever the client
    // accumulator drifted to during the stream.
    await expect(page.locator("#status-meta")).toHaveText(/Done\. 4 searches/);
  });
});

test.describe("Accept dialog", () => {
  test("Cancel button closes the dialog without validation errors", async ({
    page,
    mockAgentRun,
    isolatedReads,
  }) => {
    autoAcceptDialogs(page);
    await mockAgentRun({ searches: 2 });
    await page.goto("/");
    await page.waitForSelector(".card");
    const card = page.locator(".card.D:not(.researched)").first();
    await clickCard(card);
    await page.locator("#run-btn").click();
    await expect(page.locator("#detail-panel #status")).toBeHidden({ timeout: 5000 });
    await page.locator("#accept-btn").click();
    await expect(page.locator("#accept-dialog")).toBeVisible();
    await page.locator("#accept-dialog button[value='cancel']").click();
    await expect(page.locator("#accept-dialog")).toBeHidden();
  });

  test("opens with hint banner when no recommendation to auto-fill", async ({
    page,
    mockAgentRun,
    isolatedReads,
  }) => {
    autoAcceptDialogs(page);
    await mockAgentRun({
      searches: 2,
      fakeText: "## Recommendation\n\nRecommended confidence band: Unchanged\n\n<<RECOMMENDED_CITATION>>\nNONE\n<</RECOMMENDED_CITATION>>",
    });
    await page.goto("/");
    await page.waitForSelector(".card");
    const card = page.locator(".card.D:not(.researched)").first();
    await clickCard(card);
    await page.locator("#run-btn").click();
    await expect(page.locator("#detail-panel #status")).toBeHidden({ timeout: 5000 });
    await page.locator("#accept-btn").click();
    await expect(page.locator(".prefill-hint")).toBeVisible();
    await expect(page.locator(".prefill-hint")).toContainText(/didn't recommend an upgrade|no agent run yet|Fill manually/i);
  });
});

test.describe("Import GEDCOM", () => {
  test("topbar exposes an Import button", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#import-gedcom")).toBeVisible();
  });

  test("clicking Import opens a dialog with file input", async ({ page }) => {
    await page.goto("/");
    await page.locator("#import-gedcom").click();
    await expect(page.locator("#import-dialog")).toBeVisible();
    await expect(page.locator("#import-dialog input[type='file']")).toBeAttached();
  });

  test("uploading a valid GEDCOM posts to /api/external/import and shows summary", async ({ page }) => {
    // Mock the server endpoint so the test doesn't need a real GEDCOM round-trip
    await page.route("**/api/external/import", async (route) => {
      const body = JSON.parse(route.request().postData());
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          summary: {
            filename: body.filename,
            imported_at: new Date().toISOString(),
            individual_count: 893,
            family_count: 317,
            source_count: 284,
            matched_count: 128,
            unmatched_count: 50,
          },
        }),
      });
    });

    await page.goto("/");
    await page.locator("#import-gedcom").click();
    // Set the file via Playwright's setInputFiles which simulates user selection
    const fileInput = page.locator("#import-dialog input[type='file']");
    await fileInput.setInputFiles({
      name: "test.ged",
      mimeType: "text/plain",
      buffer: Buffer.from("0 HEAD\n0 @I1@ INDI\n1 NAME Test /Person/\n0 TRLR"),
    });
    await page.locator("#import-submit").click();

    // Summary should appear
    await expect(page.locator("#import-summary")).toBeVisible();
    await expect(page.locator("#import-summary")).toContainText("128");
    await expect(page.locator("#import-summary")).toContainText("50");
    await expect(page.locator("#import-summary")).toContainText("test.ged");
  });

  test("after successful import, Import button is hidden and Close replaces Cancel", async ({ page }) => {
    await page.route("**/api/external/import", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          summary: {
            filename: "x.ged",
            imported_at: new Date().toISOString(),
            individual_count: 10,
            family_count: 5,
            source_count: 2,
            matched_count: 3,
            unmatched_count: 7,
          },
        }),
      });
    });
    await page.goto("/");
    await page.locator("#import-gedcom").click();
    await page.locator("#import-dialog input[type='file']").setInputFiles({
      name: "x.ged",
      mimeType: "text/plain",
      buffer: Buffer.from("0 HEAD\n0 TRLR"),
    });
    await page.locator("#import-submit").click();
    await expect(page.locator("#import-summary")).toBeVisible();
    // Post-success: Import button hidden, Cancel becomes Close
    await expect(page.locator("#import-submit")).toBeHidden();
    await expect(
      page.locator("#import-dialog button[value='cancel']"),
    ).toContainText(/close/i);
  });

  test("Cancel button closes the dialog without importing", async ({ page }) => {
    let postCalled = false;
    await page.route("**/api/external/import", async (route) => {
      postCalled = true;
      await route.fulfill({ status: 200, body: "{}" });
    });
    await page.goto("/");
    await page.locator("#import-gedcom").click();
    await page.locator("#import-dialog button[value='cancel']").click();
    await expect(page.locator("#import-dialog")).toBeHidden();
    expect(postCalled).toBe(false);
  });
});

test.describe("Claim from import", () => {
  test("topbar exposes a Claim button", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#claim-descendants")).toBeVisible();
  });

  test("dialog lists unmatched externals and posts to claim endpoint", async ({ page }) => {
    await page.route("**/api/external/unmatched", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          unmatched: [
            {
              id: "@EXT_KID@",
              name: "Imaginary Child",
              sex: "F",
              birth_year: 2010,
              birth_place: "Leeds",
              external_source_file: "ancestry.ged",
            },
          ],
        }),
      }),
    );
    let posted = null;
    await page.route("**/api/external/claim-as-descendant", async (route) => {
      posted = JSON.parse(route.request().postData());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, claimed: { id: "@CLAIMED_NEW@", name: "Imaginary Child" } }),
      });
    });

    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator("#claim-descendants").click();
    await expect(page.locator("#claim-dialog")).toBeVisible();
    await expect(page.locator("#claim-list")).toContainText("Imaginary Child");

    // Pick the first available family in the dropdown and claim
    const select = page.locator("#claim-list select.claim-fam").first();
    const familyOption = await select.locator("option").nth(1).getAttribute("value");
    await select.selectOption(familyOption);
    await page.locator("#claim-list button.claim-btn").first().click();
    await expect.poll(() => posted).not.toBeNull();
    expect(posted.external_id).toBe("@EXT_KID@");
    expect(posted.target_family_id).toBe(familyOption);
  });
});

test.describe("Confidence breakdown panel (Phase 2)", () => {
  test("renders legacy + Bayesian bands and contributions list", async ({ page, isolatedReads }) => {
    await page.route("**/api/confidence/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          legacy_band: "B",
          evidence: {
            identity: [
              { kind: "parish_baptism", lr: 50, source_tier: 1, source_kind: "decision_accept", note: "Heptonstall PR 1774" },
              { kind: "member_family_tree", lr: 1.5, source_tier: 3, source_kind: "external_suggestion", note: "from gedcom: @G1@" },
            ],
            relationship: [],
          },
          result: {
            prior: 0.15,
            posterior: 0.93,
            posterior_odds: 13.3,
            posterior_log_odds: 2.59,
            band: "B",
            contributions: [
              { kind: "parish_baptism", source_tier: 1, lr: 50, log_lr: 3.91, note: "Heptonstall PR 1774" },
              { kind: "member_family_tree", source_tier: 3, lr: 1.5, log_lr: 0.41, note: "from gedcom: @G1@" },
            ],
            thresholds: { A: 0.95, B: 0.80, C: 0.50 },
          },
        }),
      }),
    );
    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator(".card").first().dispatchEvent("click");
    await expect(page.locator("#confidence-breakdown")).toBeVisible();
    await expect(page.locator("#confidence-breakdown-summary")).toContainText("Legacy");
    await expect(page.locator("#confidence-breakdown-summary")).toContainText("Bayesian");
    await expect(page.locator("#confidence-breakdown-summary")).toContainText("93.0%");
    // Expand to see contributions
    await page.locator("#confidence-breakdown summary").click();
    await expect(page.locator("#confidence-breakdown-body")).toContainText("parish_baptism");
    await expect(page.locator("#confidence-breakdown-body")).toContainText("member_family_tree");
    // Strongest contribution should be listed first
    const firstRow = page.locator("#confidence-breakdown-body strong").first();
    await expect(firstRow).toHaveText("parish_baptism");
  });
});

test.describe("Sibling reconciliation panel", () => {
  test("renders corroboration when the selected individual has researched siblings", async ({ page, isolatedReads }) => {
    await page.route("**/api/siblings/reconcile/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          report: {
            family_id: "@TF1@",
            total_siblings: 3,
            researched: ["@SIB1@", "@SIB2@"],
            unresearched: ["@SIB3@"],
            accepted_count: 2,
            corroboration_strength: "strong",
            siblings: [
              { id: "@I1825902591@", name: "Test Root", birth_year: 1972, researched: false, run_count: 0, decision: null },
              { id: "@SIB1@", name: "Sibling One", birth_year: 1970, researched: true, run_count: 1, decision: "accepted" },
              { id: "@SIB2@", name: "Sibling Two", birth_year: 1968, researched: true, run_count: 1, decision: "accepted" },
            ],
          },
        }),
      }),
    );
    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator(`.card[data-id="@I1825902591@"]`).dispatchEvent("click");
    await expect(page.locator("#sibling-reconciliation")).toBeVisible();
    await expect(page.locator("#sibling-reconciliation-summary")).toContainText("2 of 2 sibling");
    await expect(page.locator("#sibling-strength-badge")).toContainText("Strong");
    await expect(page.locator("#sibling-reconciliation-list")).toContainText("Sibling One");
    await expect(page.locator("#sibling-reconciliation-list")).toContainText("Sibling Two");
    // Self should not appear in the list
    await expect(page.locator("#sibling-reconciliation-list")).not.toContainText("Test Root");
  });

  test("hidden when individual has fewer than 2 siblings", async ({ page, isolatedReads }) => {
    await page.route("**/api/siblings/reconcile/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          report: {
            family_id: "@TF1@",
            total_siblings: 1,
            researched: [],
            unresearched: ["@I1825902591@"],
            accepted_count: 0,
            corroboration_strength: "none",
            siblings: [{ id: "@I1825902591@", name: "Test Root", birth_year: 1972, researched: false, decision: null }],
          },
        }),
      }),
    );
    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator(`.card[data-id="@I1825902591@"]`).dispatchEvent("click");
    await expect(page.locator("#sibling-reconciliation")).toBeHidden();
  });
});

test.describe("Ingest modal (Phase 1 — list only)", () => {
  test("topbar exposes an Ingest button", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#ingest-documents")).toBeVisible();
  });

  test("modal renders both folders' contents with status badges", async ({ page, isolatedReads }) => {
    await page.route("**/api/ingest/scan", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          paths: { documents: "/abs/ingest/documents", stories: "/abs/ingest/stories" },
          stories: [
            { name: "grandfather.md", hash: "abcd1234abcd1234", kind: "story", size_bytes: 2048,
              modified_at: "2026-05-02T10:00:00Z", status: "unprocessed", last_processed_at: null },
            { name: "essay.txt", hash: "ffff2222ffff2222", kind: "story", size_bytes: 5120,
              modified_at: "2026-05-02T10:00:00Z", status: "processed", individuals_matched: 3,
              evidence_written: 3, last_processed_at: "2026-05-02T11:00:00Z" },
          ],
          documents: [
            { name: "1841_census.jpg", hash: "11112222aaaabbbb", kind: "document", size_bytes: 102400,
              modified_at: "2026-05-02T10:00:00Z", status: "changed", last_processed_at: "2026-05-01T10:00:00Z" },
            { name: "broken.pdf", hash: "deadbeef", kind: "document", size_bytes: 4096,
              modified_at: "2026-05-02T10:00:00Z", status: "failed", error: "OCR failed: corrupt PDF" },
          ],
        }),
      }),
    );
    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator("#ingest-documents").click();
    await expect(page.locator("#ingest-dialog")).toBeVisible();
    await expect(page.locator("#ingest-stories-list")).toContainText("grandfather.md");
    await expect(page.locator("#ingest-stories-list")).toContainText("essay.txt");
    await expect(page.locator("#ingest-documents-list")).toContainText("1841_census.jpg");
    await expect(page.locator("#ingest-documents-list")).toContainText("broken.pdf");
    // Status badges visible
    await expect(page.locator("#ingest-stories-list")).toContainText("unprocessed");
    await expect(page.locator("#ingest-stories-list")).toContainText("processed");
    await expect(page.locator("#ingest-documents-list")).toContainText("changed");
    await expect(page.locator("#ingest-documents-list")).toContainText("failed");
    // Processed entry shows match info
    await expect(page.locator("#ingest-stories-list")).toContainText("3 matched");
    // Failed entry shows error
    await expect(page.locator("#ingest-documents-list")).toContainText("OCR failed");
    // Process buttons enabled for both stories (Phase 2) and documents (Phase 3)
    const storyButtons = page.locator("#ingest-stories-list .ingest-process-btn");
    await expect(storyButtons.first()).toBeEnabled();
    const docButtons = page.locator("#ingest-documents-list .ingest-process-btn");
    await expect(docButtons.first()).toBeEnabled();
  });

  test("clicking Process on a document confirms cost then posts to /api/ingest/document/:filename", async ({ page, isolatedReads }) => {
    await page.route("**/api/ingest/scan", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          paths: { documents: "/d", stories: "/s" },
          stories: [],
          documents: [
            { name: "1841_census.jpg", hash: "11112222aaaabbbb", kind: "document",
              size_bytes: 102400, modified_at: "2026-05-02T10:00:00Z",
              status: "unprocessed", last_processed_at: null },
          ],
        }),
      }),
    );
    let postCalled = false;
    await page.route("**/api/ingest/document/**", async (route) => {
      postCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          filename: "1841_census.jpg",
          summary: {
            document_kind: "census_record", individuals_matched: 3, evidence_written: 3,
            contradictions_flagged: 0, contradictions: [],
          },
          transcript_summary: "1841 census, Heptonstall township",
        }),
      });
    });
    // Auto-confirm the cost dialog
    page.on("dialog", (d) => d.accept());

    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator("#ingest-documents").click();
    await page.locator("#ingest-documents-list .ingest-process-btn").click();
    await expect.poll(() => postCalled).toBe(true);
    await expect(page.locator("#ingest-status")).toContainText("census_record");
    await expect(page.locator("#ingest-status")).toContainText("3 matched");
  });

  test("clicking Process on a story posts to /api/ingest/story/:filename and reports summary", async ({ page, isolatedReads }) => {
    let scanCalls = 0;
    await page.route("**/api/ingest/scan", (route) => {
      scanCalls += 1;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          paths: { documents: "/d", stories: "/s" },
          stories: [
            { name: "tale.md", hash: "11112222aaaabbbb", kind: "story", size_bytes: 1024,
              modified_at: "2026-05-02T10:00:00Z", status: "unprocessed", last_processed_at: null },
          ],
          documents: [],
        }),
      });
    });
    let postCalled = false;
    await page.route("**/api/ingest/story/**", async (route) => {
      postCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          filename: "tale.md",
          summary: { individuals_matched: 2, evidence_written: 2, contradictions_flagged: 0, contradictions: [] },
          story_summary: "Family origins narrative",
        }),
      });
    });

    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator("#ingest-documents").click();
    await page.locator("#ingest-stories-list .ingest-process-btn").click();
    await expect.poll(() => postCalled).toBe(true);
    await expect(page.locator("#ingest-status")).toContainText("2 matched, 2 evidence written");
  });

  test("shows empty hint when no files in folder", async ({ page, isolatedReads }) => {
    await page.route("**/api/ingest/scan", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          paths: { documents: "/abs/docs", stories: "/abs/stories" },
          stories: [],
          documents: [],
        }),
      }),
    );
    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator("#ingest-documents").click();
    await expect(page.locator("#ingest-stories-empty")).toBeVisible();
    await expect(page.locator("#ingest-documents-empty")).toBeVisible();
  });
});

test.describe("Active runs indicator", () => {
  test("topbar shows '0 running' when nothing is in flight", async ({ page, isolatedReads }) => {
    await page.route("**/api/runs/active", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [] }) }),
    );
    await page.goto("/");
    await expect(page.locator("#active-runs-count")).toHaveText("0 running");
  });

  test("indicator updates and modal renders runs with cancel buttons", async ({ page, isolatedReads }) => {
    let runs = [
      { id: "@A@", label: "Ann Sweeting — record discovery", started_at: new Date().toISOString(), elapsed_ms: 12_000 },
      { id: "@B@:father", label: "Joseph Sutcliffe — find father", started_at: new Date().toISOString(), elapsed_ms: 65_000 },
    ];
    await page.route("**/api/runs/active", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs }) }),
    );
    let aborted = null;
    await page.route("**/api/runs/abort/**", async (route) => {
      const url = route.request().url();
      const decoded = decodeURIComponent(url);
      const m = decoded.match(/abort\/([^?]+)/);
      aborted = m ? m[1] : null;
      runs = runs.filter((r) => r.id !== aborted);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await page.goto("/");
    await expect(page.locator("#active-runs-count")).toHaveText("2 running");
    await page.locator("#active-runs").click();
    await expect(page.locator("#active-runs-dialog")).toBeVisible();
    await expect(page.locator("#active-runs-list")).toContainText("Ann Sweeting");
    await expect(page.locator("#active-runs-list")).toContainText("Joseph Sutcliffe");
    await page.locator(`button.abort-run-btn[data-id="@A@"]`).click();
    await expect.poll(() => aborted).toBe("@A@");
  });
});

test.describe("Tree review", () => {
  test("topbar exposes a Review button", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#review-tree")).toBeVisible();
  });

  test("dialog renders findings filtered by severity", async ({ page, isolatedReads }) => {
    await page.route("**/api/review", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          findings: [
            { severity: "error", kind: "death_before_birth", individual_id: "@A@", message: "Time-traveller A" },
            { severity: "warning", kind: "siblings_too_close", family_id: "@F1@", message: "Two same-year siblings" },
            { severity: "info", kind: "high_band_no_evidence", individual_id: "@B@", message: "Band B with no run" },
          ],
        }),
      }),
    );
    await page.goto("/");
    await page.waitForSelector(".card");
    await page.locator("#review-tree").click();
    await expect(page.locator("#review-dialog")).toBeVisible();
    // Default filter: errors + warnings on, info off
    await expect(page.locator("#review-list")).toContainText("Time-traveller A");
    await expect(page.locator("#review-list")).toContainText("Two same-year siblings");
    await expect(page.locator("#review-list")).not.toContainText("Band B with no run");
    // Toggle info on — band-B finding should now show
    await page.locator("#review-filter-info").check();
    await expect(page.locator("#review-list")).toContainText("Band B with no run");
  });
});

test.describe("Visual snapshots", () => {
  // Visual snapshots are platform-specific (font rendering, anti-aliasing
  // differ across macOS / Linux / Windows). The baselines are committed
  // for darwin-chromium only — the local Mac dev environment. CI runs on
  // Linux and would need separate Linux baselines, which we don't generate.
  // Skip in CI; run locally to catch regressions on the platform that
  // matters for development.
  test.skip(!!process.env.CI, "Visual snapshots are local-only (platform-specific)");
  // Pure capture tests — regression-safe since they just produce screenshots
  // for human review. Run with --update-snapshots to refresh baselines.
  test("home view", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".card");
    await page.waitForTimeout(500); // allow layout to settle
    await expect(page).toHaveScreenshot("home.png", { maxDiffPixels: 1000, fullPage: false });
  });

  test("detail panel with no prior runs", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".card");
    await clickCard(page.locator(".card.D:not(.researched)").first());
    await page.waitForTimeout(300);
    await expect(page.locator("#detail-panel")).toHaveScreenshot("detail-panel-fresh.png", {
      maxDiffPixels: 500,
    });
  });
});
