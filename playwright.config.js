import { defineConfig, devices } from "@playwright/test";

// Local-only Playwright config. Auto-starts the Express server before tests
// and tears it down afterwards. Tests run against http://localhost:3000.
//
// IMPORTANT: tests must NOT call the live Anthropic API. Any test that
// triggers an agent run must intercept the SSE endpoint via page.route().
// See tests/ui.spec.js for the mock fixture.

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false, // single-user app; serialise to keep state predictable
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: "http://localhost:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1400, height: 900 },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Auto-start the server. PORT=3001 keeps it isolated from any dev server
  // you have running on 3000. Tests use baseURL -> 3001 via the env override.
  webServer: {
    command: "PORT=3001 node --env-file=.env server.js",
    // Shared CI sets ANTHROPIC_API_KEY="" at job level when the repo has no
    // such secret. `node --env-file` will not override an env var already
    // present, so the empty value shadows .env. Force a non-empty value here
    // to satisfy server.js's boot check. Tests mock all Anthropic traffic.
    env: {
      ANTHROPIC_API_KEY:
        process.env.ANTHROPIC_API_KEY || "ci-fake-key-not-used-by-tests",
    },
    url: "http://localhost:3001/api/individuals",
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
