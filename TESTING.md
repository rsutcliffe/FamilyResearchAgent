# Testing

## The rule: TDD

Every change starts with a failing test.

- **Bug report** → write a regression test that reproduces it (red) → fix (green) → refactor → commit both test and fix together.
- **Feature** → write a test that describes the desired behaviour (red) → implement the simplest thing that passes (green) → refactor.
- No exceptions for "trivial" changes. Small changes are exactly where regressions hide silently.

## Layout

| Path | Tool | What lives here |
|---|---|---|
| `tests/unit/*.test.js` | `node:test` (built-in) | Pure-function unit tests. No I/O, no network, no DOM. |
| `tests/*.spec.js` | Playwright | UI flows, end-to-end scenarios. SSE endpoint mocked. |
| `scripts/smoke-test.mjs` | Standalone | Single live agent run against the real Anthropic API. Costs ~$0.50/run — **NOT** part of `npm test`. |

## Commands

```bash
npm test                  # unit + Playwright
npm run test:unit         # node --test, fast (<1s)
npm run test:unit:watch   # re-runs on file change
npm run test:ui           # Playwright headless
npm run test:ui:headed    # Playwright with browser visible
npm run test:ui:ui        # Playwright UI mode (interactive timeline + DOM)
npm run debug:ui          # Playwright codegen — record clicks → script
```

## Mocking the agent

Playwright tests **must not** call the live Anthropic API. The fixture in
`tests/fixtures.js` provides a `mockAgentRun` helper that intercepts both
`/api/agent/run/**` and `/api/ancestor/run/**` with a fake SSE stream:

```js
import { test } from "./fixtures.js";

test("…", async ({ page, mockAgentRun }) => {
  await mockAgentRun({ searches: 5, fakeText: "## What We Know\n\n…" });
  // … rest of the test runs without making API calls
});
```

## Coverage as of this writing

### ✅ Covered

| Module | What's tested |
|---|---|
| `agent/apiClients/*` | WikiTree / FamilySearch / TNA Discovery — pure parsers + fetch wrappers (with injected `fetch`), idempotent re-fetch, OAuth token cache, error handling |
| `agent/externalApiOrchestrator.js` | `gatherApiLeads` (3 sources via DI, source_kind tagging, cache freshness, idempotent re-runs, partial-failure tolerance) |
| `agent/researchKb.js` parsers | `parseNegativeSearchesBlock`, `parseAliasObservationsBlock`, `parseExternalLookups`, `parseNextTimeBlock`, `computeNamingPatterns` (inc. surname-as-middle-name filtering, lowercase rejection) |
| `agent/researchKb.js` KB writes | `applyAgentRunToKb` (negative-search dedup + FIFO cap), `applyAcceptedMatchToKb` (parishes, confirmed_relatives, migration routes, source efficacy, re-research flags), `applyAcceptedCandidateToKb`, `clearReresearchFlag` |
| Tree UI | Page load, topbar controls, card render |
| Detail panel | Clean state on selection, no spinner on unvisited node, status hidden when navigating between cards |
| Agent run lifecycle | Status appears → completes → hides on done; search counter reconciles to server's count |
| Accept dialog | Cancel button closes (formnovalidate), hint banner appears when no recommendation to auto-fill |

### ❌ Not yet covered (listed in BACKLOG.md)

| Module | Why deferred |
|---|---|
| `buildKbContextBody` | Large branchy function; defer until specific bugs surface that warrant per-branch unit coverage |
| Server endpoints | Would need a supertest-style harness; useful but not yet bitten by a bug |
| GEDCOM writer | Round-trip test (parse → write → re-parse) would be valuable; defer until the writer changes |
| Visual snapshots | Two stub tests in `tests/ui.spec.js` need baselines (`npm run test:ui -- --update-snapshots` once the look is stable) |

## Conventions

- **Test file naming:** `*.test.js` for unit, `*.spec.js` for Playwright. Don't mix.
- **One assertion concept per test.** Multiple `assert` calls per test are fine if they all probe the same behaviour; if they're testing distinct things, split.
- **No shared mutable state between tests.** Each test should set up its own fixtures.
- **Test names describe behaviour, not implementation.** Good: `"dedupes negative_searches by source||query for same individual"`. Bad: `"calls Set.has and pushes if false"`.
- **When fixing a bug, write the failing test first.** Commit message body should reference the failing assertion.

## Automation

Tests run automatically at two points so you can't forget to run them.

### Pre-commit (local, ~200ms)

A husky hook in `.husky/pre-commit` runs `npm run test:unit` before every `git commit`. If any unit test fails, the commit is blocked and the failing assertion is printed in the terminal.

- Activated automatically by the `prepare` script in `package.json` — `npm install` is enough
- Only unit tests run here (UI tests would slow every commit by ~8s; they run in CI instead)
- **Emergency bypass:** `git commit --no-verify` skips the hook. Use sparingly — push will still trigger CI.

### CI on push (GitHub Actions, ~3 min)

`.github/workflows/test.yml` runs the FULL test suite on every push to `main` and every pull request:

1. Install dependencies
2. Install Playwright Chromium binary
3. Run unit tests
4. Run Playwright UI tests
5. On failure: upload the Playwright HTML report as a build artifact (downloadable from the Actions tab for 14 days)

You'll get an email from GitHub if any push to `main` fails.

To re-run a workflow manually: GitHub repo → Actions tab → Test → Run workflow.

### Updating visual snapshots

Visual regression tests fail whenever the rendered UI differs from the committed baseline. When you make an *intentional* visual change:

```bash
npm run test:ui -- --update-snapshots
git add tests/ui.spec.js-snapshots/
git commit -m "Update visual baselines after [reason]"
```

Without this, the next CI run will fail with pixel diffs.

## When something breaks

1. Run `npm test` — see what fails.
2. If a snapshot test fails, look at `playwright-report/` (run `npx playwright show-report`) — visual diffs are obvious.
3. If a unit test fails, the line + assertion is enough.
4. If a Playwright test fails mid-flow, the trace is at `test-results/{test-name}/trace.zip` — open with `npx playwright show-trace`. Includes timeline, DOM snapshots, console logs, network.
5. **Don't delete the test to make CI green.** Either fix the regression or, if the test was wrong, fix the test (and explain why in the commit).
