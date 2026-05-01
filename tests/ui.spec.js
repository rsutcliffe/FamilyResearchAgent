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
