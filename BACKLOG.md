# Backlog

Deferred features. Pull from the top of each section when you're ready.

## Confidence-uplift roadmap

The two highest-leverage uplift mechanics — sibling reconciliation and a
deterministic reviewer / contradiction-detector — landed in
[reviewer + sibling reconciliation slice]. Remaining items, ordered by
likely value:

- **Will / probate / burial-record pipeline.** TNA Discovery already
  surfaces will references for the user to check manually; what's
  missing is (a) a structured form to paste in the will text after
  ordering it from TNA, (b) an agent that parses the text and extracts
  named relatives, (c) automatic confirmed_relatives entries. Wills are
  the gold standard for relationships pre-1837. FindAGrave + BillionGraves
  headstone transcriptions plug into the same pipe.

- **Census triangulation prompt tightening.** Make the agent explicitly
  chain 1841→1851→1861→1871→1881→1891→1901→1911 for any post-1800
  individual; currently it does this opportunistically, not
  systematically. Probably a prompt change + a deterministic check that
  flags missing decades.

- **LLM-based reviewer (v2).** Layer on top of the deterministic
  reviewer: a separate, cheaper model call that reads each accepted
  match and evaluates it independently. Distinct prompt focused on
  critique. Catches over-eager Band A acceptances on Tier 2 sources.
  Adds ~10% to per-accept cost. Worth doing once you have 10+ accepts
  to review against.

- **Bayesian confidence accumulator.** Replace the categorical A/B/C/D
  bands with probabilistic reasoning that accumulates over evidence
  (each Tier 1 source bumps log-odds by N, each Tier 2 by M, etc.).
  Mathematically nicer; a big rewrite of how `confidence` propagates.
  Defer unless the categorical model starts failing.

- **Ancestry DNA match integration.** If the user has taken a test, the
  match list is concrete biological corroboration of relationships.
  No public API; export-and-import via a CSV would work. Plugs into the
  existing Tier-3-leads pipe, but the matches with shared cM > N% are
  effectively Tier 1 evidence for a relationship existing (just not
  *which* relationship).

## Self-improvement (longer-term loop)

- **Query-template library (Strategy 6).** Extract successful query patterns from accepted runs (e.g. `site:familysearch.org [name] [parish] [year]` → 3 Tier 1 matches). Surface the proven templates in the next run's KB context. Currently the model has to re-discover what works. Medium effort; needs careful curation to avoid surfacing flukes.

- **Prompt versioning + outcome tracking (Strategy 7).** Stamp each saved evidence entry with a prompt hash. Build a small dashboard: accept-rate by prompt version. Useful when iterating on prompts; low value if prompts are stable.

- **Adaptive search budget (Strategy 8).** Dynamic `WEB_SEARCH_MAX_USES` based on era / surname rarity / KB richness. A pre-1837 Sutcliffe in West Yorkshire might warrant 12 searches; a post-1837 Cooper in Cardiff might need 4. Currently every run gets the same flat budget.

## External API integrations — follow-ups

External API leads (FamilySearch, WikiTree, TNA Discovery) are now wired
in via [agent/externalApiOrchestrator.js](agent/externalApiOrchestrator.js)
as Tier 3 lead generators feeding `external_suggestions` in the KB context.

**Status (2026-05-01):** FamilySearch declined API access for personal-use
applications (ticket 2663032). The FS branch is permanently gated off via
`FAMILYSEARCH_DISABLE=1` unless a fresh business-framed application is made.
WikiTree and TNA Discovery remain live.

Outstanding items:

- **Promote to Anthropic function tools.** Pre-fetch is good for the target
  individual but the agent can't drill into related people mid-run. v2 would
  expose `familysearch_get_relatives`, `wikitree_get_ancestors`, etc. as
  custom tools alongside `web_search` so the agent can pivot when it finds
  a promising lead.
- **Authenticated WikiTree session.** Public-profile reads work without
  auth; private/Trusted-List profiles need a session. Worth wiring only if
  WikiTree turns out to have data the user wants behind auth.
- ~~**FamilySearch image collections + records search.**~~ Closed —
  no API path available following the 2026-05-01 decline. Records
  collections would need API access we don't have.
- **Paid-source ledger extension.** Spend tracking is currently single-bucket
  Anthropic. If a paid source (Findmypast, Ancestry, etc.) ever gets API
  access, the per-source cost should be surfaced in `/api/spend`.
- **MyHeritage / Findmypast.** No public APIs. Out of scope unless one
  appears.

## Production code investigation

- **Saved-event refresh race.** When the agent run completes, `done` shows decision buttons; `saved` then triggers `refreshAndReselect` → `selectPerson` → `GET /api/evidence/:id`. If that GET races the file write or returns null for any reason, `showDecisionButtons(false, null)` hides the buttons we just made visible. Surfaced by the Playwright test fixture which omits the `saved` event for this reason. Worth tracing in production logs to see if it ever fires; the symptom would be "I just ran the agent and now decision buttons are gone."

## Other paywalled options

- **Findmypast / TheGenealogist via browser automation.** Use Claude in Chrome / Playwright against the user's already-authenticated browser. Avoids credential handling. Brittle to UI changes; ToS implications for some services. With FamilySearch API permanently off the table (declined 2026-05-01), the manual evidence flow + WikiTree + TNA is the full free-source baseline — so paid sources via browser automation are the main remaining lever if that baseline proves insufficient.

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
