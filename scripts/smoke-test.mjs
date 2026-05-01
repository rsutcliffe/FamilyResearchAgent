#!/usr/bin/env node
// Smoke-test the Record Discovery Agent prompt against one hard-coded individual.
// Run: ANTHROPIC_API_KEY=sk-ant-... node scripts/smoke-test.mjs
// Optional: INDIVIDUAL=john_sutcliffe_1560 to test the West Riding hotspot rule.

import { SYSTEM_PROMPT } from "../agent/systemPrompt.js";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-4-6";
const INDIVIDUAL_KEY = process.env.INDIVIDUAL || "ann_sweeting";
const KB_KEY = process.env.KB || "empty";

if (!API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is not set in the environment.");
  process.exit(2);
}

// Profiles taken verbatim from docs/agent_1.jsx INDIVIDUALS[].
const PROFILES = {
  ann_sweeting: {
    id: "@I1825902698@",
    name: "Ann Sweeting",
    sex: "F",
    birth_year: 1802,
    birth_place: "Monks Frystone, Yorkshire",
    generation: 5,
    confidence: "D",
    confidence_label: "UNVERIFIED",
    score: 6,
    warnings: ["Birth date is estimated", "Sources are family tree entries only"],
    alerts: ["PRE-GRO: Birth 1802. No GRO certificate available. Verify against parish records."],
  },
  john_sutcliffe_1560: {
    id: "@I_test_john_1560@",
    name: "John Sutcliffe",
    sex: "M",
    birth_year: 1560,
    birth_place: "Burnley, Lancashire",
    generation: 11,
    confidence: "D",
    confidence_label: "UNVERIFIED",
    score: 4,
    warnings: ["Sources are family tree entries only"],
    alerts: ["EARLY-ERA: Birth 1560. Pre-civil registration. Verify against surviving parish records."],
  },
};

const profile = PROFILES[INDIVIDUAL_KEY];
if (!profile) {
  console.error(`ERROR: Unknown INDIVIDUAL '${INDIVIDUAL_KEY}'. Choices: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(2);
}

// KB context profiles. The empty profile is the baseline (cold start).
// Other profiles simulate the state of research_kb.json after prior accepted
// matches — used to test whether populated context tightens the agent's
// search and changes the candidate evidence it surfaces.
const KB_PROFILES = {
  empty: `known_parishes: {}
naming_pattern_warnings: []
negative_searches: []
confirmed_relatives: []
migration_routes: []
alias_registry: {}`,

  // Simulates: prior research has accepted Ann Sweeting's mother (Ann Wainwright)
  // at St Wilfrid's, Monk Fryston via the Borthwick register. Father (Richard
  // Sweeting) remains GEDCOM-asserted only. Tests whether the agent uses the
  // mother's confirmed parish as the primary geographic anchor for Ann's baptism
  // search, and whether it correctly emits a CROSS_REFERENCE_FLAGS entry for
  // the still-unverified father once Ann's own match is found.
  ann_sweeting_anchors: `known_parishes:
  Sweeting: [Monk Fryston]
  Wainwright: [Hillam (parish of Monk Fryston)]

naming_pattern_warnings:
  - Ann (appears in 4+ generations of this family — apply stricter convergence)

negative_searches:
  - FreeREG||Sweeting baptism Monk Fryston 1800 1805 Ann christening
  - Web general||Ann Sweeting baptism Monks Frystone Yorkshire 1802 parish register

confirmed_relatives:
  - gedcom_id: "@I1825902700@"
    name: Ann Wainwright
    relationship: mother
    birth_year: 1766
    birth_place: Hillam, parish of Monk Fryston, Yorkshire
    confidence: B (PROBABLE — accepted in prior run)
    citation: "St Wilfrid's, Monk Fryston, christening register, Borthwick Institute MF 739"
  - gedcom_id: "@I1825902699@"
    name: Richard Sweeting
    relationship: father
    birth_year: 1759
    birth_place: Brayton, Yorkshire
    confidence: C (UNCERTAIN — GEDCOM-asserted, not yet primary-sourced)
    note: A Tier 1 match for Ann that names this father would unlock a Band B for him.

migration_routes:
  - Brayton -> Monk Fryston (Richard Sweeting + Ann Wainwright marriage, c.1790s)

alias_registry:
  Monk Fryston: [Monks Frystone, Monk Friston]`,
};

const kbBody = KB_PROFILES[KB_KEY];
if (kbBody === undefined) {
  console.error(`ERROR: Unknown KB profile '${KB_KEY}'. Choices: ${Object.keys(KB_PROFILES).join(", ")}`);
  process.exit(2);
}

const sexLabel = profile.sex === "M" ? "Male" : profile.sex === "F" ? "Female" : "Unknown";

const userMessage = `Please research this individual from the Sutcliffe family tree:

Name: ${profile.name}
GEDCOM ID: ${profile.id}
Sex: ${sexLabel}
Approximate birth year: ${profile.birth_year}
Birth place: ${profile.birth_place}
Generation from root (Richard David Sutcliffe b.1972): ${profile.generation}
Current confidence band: ${profile.confidence} (${profile.confidence_label})
Current evidence score: ${profile.score}/20
Known warnings: ${profile.warnings.join("; ") || "None"}
Known alerts: ${profile.alerts.join("; ") || "None"}

<<RESEARCH_KB_CONTEXT>>
${kbBody}
<</RESEARCH_KB_CONTEXT>>

Please search public records to find primary source evidence for this individual. If you find a match, provide the source citation in full and recommend a new confidence band. If you cannot find a match, explain what you searched and why it returned no results.`;

console.error(`# Smoke test: ${profile.name} (${profile.id})`);
console.error(`# Model: ${MODEL}`);
console.error(`# KB profile: ${KB_KEY}`);
console.error(`# Calling Anthropic Messages API with web_search tool enabled...`);
console.error("");

const startedAt = Date.now();

let response;
try {
  response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: userMessage }],
    }),
  });
} catch (e) {
  console.error(`ERROR: network failure calling Anthropic API: ${e.message}`);
  process.exit(1);
}

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

if (!response.ok) {
  const body = await response.text();
  console.error(`ERROR: API returned ${response.status} ${response.statusText} after ${elapsedSec}s`);
  console.error(body);
  process.exit(1);
}

const data = await response.json();

const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
const toolUses = (data.content || []).filter((b) => b.type === "server_tool_use" || b.type === "web_search_tool_result");

console.error(`# Response received in ${elapsedSec}s`);
console.error(`# Stop reason: ${data.stop_reason}`);
console.error(`# Tool uses: ${toolUses.length}`);
if (data.usage) {
  console.error(`# Tokens — input: ${data.usage.input_tokens}, output: ${data.usage.output_tokens}`);
}
console.error("");
console.error("# ----- AGENT OUTPUT (stdout) -----");

process.stdout.write(textBlocks.join("\n\n"));
process.stdout.write("\n");

console.error("");
console.error("# ----- VALIDATION -----");
const fullText = textBlocks.join("\n");
const checks = [
  ["## What We Know heading", /^## What We Know$/m.test(fullText)],
  ["## Search Strategy heading", /^## Search Strategy$/m.test(fullText)],
  ["## Candidate Records heading", /^## Candidate Records$/m.test(fullText)],
  ["## Match Evaluation heading", /^## Match Evaluation$/m.test(fullText)],
  ["## Recommendation heading", /^## Recommendation$/m.test(fullText)],
  ["<<NEGATIVE_SEARCHES>> block", /<<NEGATIVE_SEARCHES>>[\s\S]*<<\/NEGATIVE_SEARCHES>>/.test(fullText)],
  ["<<CROSS_REFERENCE_FLAGS>> block", /<<CROSS_REFERENCE_FLAGS>>[\s\S]*<<\/CROSS_REFERENCE_FLAGS>>/.test(fullText)],
  ["<<ALIAS_OBSERVATIONS>> block", /<<ALIAS_OBSERVATIONS>>[\s\S]*<<\/ALIAS_OBSERVATIONS>>/.test(fullText)],
  ["Cross-references step in Match Evaluation", /[Cc]ross-references? used/.test(fullText)],
  ["At least one web search performed", toolUses.length > 0],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.error(`  ${ok ? "OK  " : "FAIL"}  ${name}`);
  if (!ok) failed++;
}
console.error("");
if (failed === 0) {
  console.error(`# All ${checks.length} checks passed. Prompt structure is sound.`);
  process.exit(0);
} else {
  console.error(`# ${failed} of ${checks.length} checks FAILED. Review the agent output above.`);
  process.exit(3);
}
