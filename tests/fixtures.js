import { test as base } from "@playwright/test";

// A fake SSE response that mimics what the real agent endpoint emits.
// Used to test UI flows without burning Anthropic API spend.
const buildFakeSseResponse = ({ searches = 5, fakeText = "## What We Know\n\nFake test response.\n\n## Recommendation\n\nRecommended confidence band: Unchanged\n\n<<RECOMMENDED_CITATION>>\nNONE\n<</RECOMMENDED_CITATION>>" } = {}) => {
  const events = [];
  events.push(`data: ${JSON.stringify({ type: "start", profile: { name: "Fake" } })}\n\n`);
  for (let i = 1; i <= searches; i++) {
    events.push(`data: ${JSON.stringify({ type: "search", query: `fake query ${i}` })}\n\n`);
  }
  // Stream the text in two chunks
  events.push(`data: ${JSON.stringify({ type: "text", text: fakeText.slice(0, fakeText.length / 2) })}\n\n`);
  events.push(`data: ${JSON.stringify({ type: "text", text: fakeText.slice(fakeText.length / 2) })}\n\n`);
  events.push(
    `data: ${JSON.stringify({
      type: "done",
      result: {
        text: fakeText,
        stop_reason: "end_turn",
        searches: Array.from({ length: searches }, (_, i) => `fake query ${i + 1}`),
        search_count: searches,
        usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        model: "fake",
        completed_at: new Date().toISOString(),
      },
    })}\n\n`,
  );
  events.push(`data: ${JSON.stringify({ type: "saved" })}\n\n`);
  return events.join("");
};

// A minimal in-memory dataset the UI tests can rely on without depending on
// the user's real data files. Must include the actual ROOT_ID the tree
// renders from (@I1825902591@ — Richard David Sutcliffe in production code)
// so the layout has somewhere to start. Test fathers/mothers are D-band
// with no decisions, no prior runs, no flags.
const ROOT_ID = "@I1825902591@";

const baseInd = {
  warnings: [],
  alerts: [],
  fams: [],
  famc: null,
  researched: false,
  run_count: 0,
  decision: null,
  pending_external_lookups: 0,
};

export const FIXTURE_INDIVIDUALS = [
  { ...baseInd, id: ROOT_ID, name: "Test Root", sex: "M", birth_year: 1972, birth_place: "Leeds", confidence: "A", generation: 0, famc: "@TF1@" },
  { ...baseInd, id: "@TF_DAD@", name: "Test Father", sex: "M", birth_year: 1940, birth_place: "Leeds", confidence: "D", generation: 1, fams: ["@TF1@"] },
  { ...baseInd, id: "@TF_MUM@", name: "Test Mother", sex: "F", birth_year: 1942, birth_place: "York", confidence: "D", generation: 1, fams: ["@TF1@"] },
];

export const FIXTURE_FAMILIES = [
  { id: "@TF1@", husband: "@TF_DAD@", wife: "@TF_MUM@", children: [ROOT_ID], marriage_date: "", marriage_place: "" },
];

// Mock the read-side state-bearing endpoints so tests don't depend on whatever
// happens to be in the user's data/ files. Apply this in tests that need
// predictable card state (decision buttons appearing, etc.).
const mockReadEndpoints = async (page) => {
  await page.route("**/api/individuals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE_INDIVIDUALS) }),
  );
  await page.route("**/api/families", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE_FAMILIES) }),
  );
  await page.route("**/api/relationships", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/kb", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reresearch_recommended: {} }) }),
  );
  await page.route("**/api/spend", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: { started_at: new Date().toISOString(), tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost: 0, cap: 0, cap_hit: false },
        lifetime: { tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost: 0 },
        by_individual: {},
        pricing: { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3, cache_write_per_million: 3.75 },
      }),
    }),
  );
  await page.route("**/api/evidence/*", (route) => {
    // For most lifecycle tests the individual has no prior evidence
    if (!route.request().url().includes("/runs")) {
      route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
  });
};

// Extends the base Playwright test with helpers that mock the agent SSE
// endpoints so UI tests don't make any real API calls.
//
// EventSource handling note: Playwright's page.route() can't reliably deliver
// an SSE response (the browser sees the response complete and the EventSource
// reconnects in a loop). Instead we monkey-patch window.EventSource via
// addInitScript so the constructor returns a fake that dispatches our scripted
// events synchronously after a microtask. This gives total control of the
// stream lifecycle without any real network round-trips.
export const test = base.extend({
  isolatedReads: async ({ page }, use) => {
    await mockReadEndpoints(page);
    await use(page);
  },
  mockAgentRun: async ({ page }, use) => {
    const fn = async ({ searches = 5, fakeText } = {}) => {
      const defaultText =
        "## What We Know\n\nFake test response.\n\n## Recommendation\n\nRecommended confidence band: Unchanged\n\n<<RECOMMENDED_CITATION>>\nNONE\n<</RECOMMENDED_CITATION>>";
      const text = fakeText ?? defaultText;
      const events = [];
      events.push({ type: "start", profile: { name: "Fake" } });
      for (let i = 1; i <= searches; i++) {
        events.push({ type: "search", query: `fake query ${i}` });
      }
      events.push({ type: "text", text: text.slice(0, Math.floor(text.length / 2)) });
      events.push({ type: "text", text: text.slice(Math.floor(text.length / 2)) });
      events.push({
        type: "done",
        result: {
          text,
          stop_reason: "end_turn",
          searches: Array.from({ length: searches }, (_, i) => `fake query ${i + 1}`),
          search_count: searches,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          model: "fake",
          completed_at: new Date().toISOString(),
        },
      });
      // NOTE: deliberately NOT emitting "saved" — that event triggers
      // refreshAndReselect, which re-fetches /api/evidence/:id and (in the
      // test fixture, where nothing was actually persisted) gets null,
      // causing showDecisionButtons(false, null) to hide the buttons we
      // just made visible. The post-done state is what these tests check;
      // the saved-event refresh is a separate side-effect tested via the
      // researched-tick / decision-tag flow when needed.
      // TODO: investigate whether the same race could happen in production
      // if /api/evidence GET runs before the file write commits.

      await page.addInitScript((scriptedEvents) => {
        const Original = window.EventSource;
        window.EventSource = function MockEventSource(url) {
          // Pass-through for non-agent URLs
          if (!url.includes("/api/agent/run/") && !url.includes("/api/ancestor/run/")) {
            return new Original(url);
          }
          const es = {
            url,
            readyState: 0,
            onmessage: null,
            onerror: null,
            onopen: null,
            close() {
              this.readyState = 2;
            },
            addEventListener() {},
            removeEventListener() {},
          };
          // Fire events on next microtask so the caller has time to wire onmessage
          queueMicrotask(() => {
            for (const ev of scriptedEvents) {
              if (es.readyState === 2) return;
              try {
                es.onmessage?.({ data: JSON.stringify(ev) });
              } catch (e) {
                console.error("MockEventSource onmessage threw:", e);
              }
            }
          });
          return es;
        };
      }, events);
    };
    await use(fn);
  },
});

export { expect } from "@playwright/test";
