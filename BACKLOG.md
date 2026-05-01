# Backlog

Deferred features. Pull from the top of each section when you're ready.

## Self-improvement (longer-term loop)

- **Reviewer agent (Strategy 5).** A separate, cheaper model call that reads each *accepted* match and evaluates it independently. Distinct prompt focused on critique. Catches over-eager Band A acceptances on Tier 2 sources. Adds ~10% to per-accept cost. Worth doing once you have 10+ accepts to review against.

- **Query-template library (Strategy 6).** Extract successful query patterns from accepted runs (e.g. `site:familysearch.org [name] [parish] [year]` → 3 Tier 1 matches). Surface the proven templates in the next run's KB context. Currently the model has to re-discover what works. Medium effort; needs careful curation to avoid surfacing flukes.

- **Prompt versioning + outcome tracking (Strategy 7).** Stamp each saved evidence entry with a prompt hash. Build a small dashboard: accept-rate by prompt version. Useful when iterating on prompts; low value if prompts are stable.

- **Adaptive search budget (Strategy 8).** Dynamic `WEB_SEARCH_MAX_USES` based on era / surname rarity / KB richness. A pre-1837 Sutcliffe in West Yorkshire might warrant 12 searches; a post-1837 Cooper in Cardiff might need 4. Currently every run gets the same flat budget.

## Paywalled access — FamilySearch API (Phase B, deferred)

**Why deferred.** Anthropic's `web_search` tool already finds FamilySearch
public pages reasonably well. The marginal value of full API integration is
structured response shape + image-collection access, not new data. Worth
revisiting only if web_search turns out to be insufficient in practice.

**What's required when we do this:**

- User registers an app at developer.familysearch.org → gets `client_id`,
  `client_secret`. Manual one-time step.
- OAuth 2.0 implementation. Recommended flow for a local single-user tool:
  Authorization Code with PKCE via the user's browser (cleanest for tokens
  that map to the user's own subscription level). Alternative: Client
  Credentials (app-level access, no user login, but limited scope).
- Token refresh logic — tokens expire after ~1 hour. Need a refresh loop or
  re-prompt on expiry.
- New `agent/familysearchApi.js` module wrapping the Search API endpoints
  (`/platform/search/persons`, `/platform/records/search`).
- Anthropic SDK does NOT support custom server tools — would need to expose
  the FS calls as a *client* tool the agent invokes via the standard tool
  use loop. That's a different streaming pattern from `web_search_20250305`.
- Track API call count + remaining rate-limit headroom; surface in spend
  display alongside Anthropic costs.
- Budget category extension: paid-service ledger (currently spend tracking
  is single-bucket Anthropic only).

Estimated effort: 4–6 hours including OAuth, agent tool-loop changes,
testing, and rate-limit handling. Probably worth doing as one focused
session rather than slotting in piecemeal.

## Production code investigation

- **Saved-event refresh race.** When the agent run completes, `done` shows decision buttons; `saved` then triggers `refreshAndReselect` → `selectPerson` → `GET /api/evidence/:id`. If that GET races the file write or returns null for any reason, `showDecisionButtons(false, null)` hides the buttons we just made visible. Surfaced by the Playwright test fixture which omits the `saved` event for this reason. Worth tracing in production logs to see if it ever fires; the symptom would be "I just ran the agent and now decision buttons are gone."

## Other paywalled options

- **Findmypast / TheGenealogist via browser automation.** Use Claude in Chrome / Playwright against the user's already-authenticated browser. Avoids credential handling. Brittle to UI changes; ToS implications for some services. Worth considering only if FamilySearch API + manual evidence flow leave a meaningful gap.

- **GRO online indexes.** GRO's own search is free but unauth'd; could screen-scrape the index for verification of post-1837 matches. Low priority while FreeBMD covers the same ground.

## UI / UX polish

- **Decision overrides UI.** The data model already keeps `override_log`; just needs an "Edit decision" button. Defer until you actually need to revise a decision.

- **Search / jump-to-person.** With 146 people the tree is annoying for finding a specific Hannah. A keyboard-shortcut search box would help.

- **KB editor.** Manual entry of migration routes, parish corrections, naming-pattern overrides without going through an agent run.

- **Per-individual cost ceiling.** Beyond session and per-service caps, also "stop spending on this person — I've put $5 in already and it's not converging."

## Data model

- **Trim duplicate negative_searches.** The KB will accumulate these without bound. Add an occasional dedup or per-individual cap.

- **Confidence calibration tracking.** When a B-band match is later upgraded to A or downgraded to C, capture the delta as a calibration signal. Over time, learn whether the prompt is systematically over- or under-confident.

- **Multi-spouse handling for descendants view.** Families with multiple marriages (remarriages, etc.) need careful FAM-record handling in the visual tree.

## Infrastructure

- **Periodic data backup.** Currently `data/*.json` deletion is unrecoverable. A simple cron-like timestamped snapshot would help. Or `git init` the project.

- **Test coverage gaps.** Initial unit + Playwright suite is in place (see `TESTING.md`). Still missing:
  - `buildKbContextBody` — large branchy string assembler; cover with snapshot tests once a bug surfaces in it
  - Server endpoints — would need a supertest-style harness, useful for `/api/decision`, `/api/ancestor/accept-pair`, `/api/manual-evidence`
  - GEDCOM writer round-trip — parse `Sutcliffe_CleanTree_v1.ged` → write → parse again → assert equivalence
  - Visual baseline snapshots — run `npm run test:ui -- --update-snapshots` once the look is stable to lock in baselines

- **Concurrent agent runs.** Currently one user, one run at a time. If two cards are clicked in quick succession, the second clobbers the first's UI state. Cheap to fix with a per-individual lock.

- **Bump GitHub Actions to Node.js 24.** `.github/workflows/test.yml` uses `actions/checkout@v4` and `actions/setup-node@v4`, both pinned to Node.js 20. GitHub will force Node.js 24 by default from 2026-06-02 and remove Node.js 20 from runners on 2026-09-16. Bump to `@v5` (or whichever release supports Node 24) before then to avoid CI breakage. Non-urgent — workflow is just a deprecation warning today.
