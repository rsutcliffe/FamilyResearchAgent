import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildStoryExtractionPrompt,
  parseStoryExtractionResponse,
  applyStoryEvidence,
} from "../../agent/ingestion.js";

const ourTreeSample = [
  { id: "@I1@", name: "Joseph Sutcliffe", birth_year: 1774, birth_place: "Heptonstall" },
  { id: "@I2@", name: "Mary Sutcliffe", birth_year: 1776, birth_place: "Heptonstall" },
  { id: "@I3@", name: "Ann Sweeting", birth_year: 1802, birth_place: "Monks Frystone" },
];

describe("buildStoryExtractionPrompt", () => {
  test("includes the story text and a compact tree list", () => {
    const prompt = buildStoryExtractionPrompt({
      storyText: "Joseph was a weaver who lived in Heptonstall all his life.",
      ourTree: ourTreeSample,
    });
    assert.match(prompt, /weaver who lived in Heptonstall/);
    assert.match(prompt, /@I1@.*Joseph Sutcliffe.*1774.*Heptonstall/);
    assert.match(prompt, /@I3@.*Ann Sweeting/);
  });

  test("instructs Claude to return JSON only", () => {
    const prompt = buildStoryExtractionPrompt({ storyText: "x", ourTree: [] });
    assert.match(prompt, /JSON/i);
  });

  test("explicitly asks for corroborating + contradicting facts", () => {
    const prompt = buildStoryExtractionPrompt({ storyText: "x", ourTree: ourTreeSample });
    assert.match(prompt, /corroborat/i);
    assert.match(prompt, /contradict/i);
  });
});

describe("parseStoryExtractionResponse", () => {
  test("extracts JSON from a fenced code block", () => {
    const responseText = `Here's the analysis:

\`\`\`json
{
  "individuals_mentioned": [
    { "tree_id": "@I1@", "tree_name": "Joseph Sutcliffe", "match_confidence": "strong",
      "corroborating_facts": ["weaver occupation matches family lore"],
      "contradicting_facts": [] }
  ],
  "summary": "This story focuses on Joseph."
}
\`\`\`
Some trailing prose.`;
    const out = parseStoryExtractionResponse(responseText);
    assert.equal(out.individuals_mentioned.length, 1);
    assert.equal(out.individuals_mentioned[0].tree_id, "@I1@");
    assert.equal(out.summary, "This story focuses on Joseph.");
  });

  test("extracts JSON when not in a code block (raw object)", () => {
    const responseText = `{"individuals_mentioned":[{"tree_id":"@I2@","tree_name":"Mary","match_confidence":"medium","corroborating_facts":[],"contradicting_facts":[]}],"summary":"x"}`;
    const out = parseStoryExtractionResponse(responseText);
    assert.equal(out.individuals_mentioned[0].tree_id, "@I2@");
  });

  test("returns null on malformed response", () => {
    assert.equal(parseStoryExtractionResponse(""), null);
    assert.equal(parseStoryExtractionResponse("not json"), null);
    assert.equal(parseStoryExtractionResponse("{ bad json"), null);
  });

  test("normalises missing arrays to empty arrays", () => {
    const out = parseStoryExtractionResponse(`{"individuals_mentioned": [{"tree_id":"@I1@","tree_name":"Joseph","match_confidence":"strong"}]}`);
    assert.deepEqual(out.individuals_mentioned[0].corroborating_facts, []);
    assert.deepEqual(out.individuals_mentioned[0].contradicting_facts, []);
  });
});

describe("applyStoryEvidence", () => {
  const baseKb = () => ({ confidence_evidence: {} });

  test("writes story_corroboration entries for strong matches with corroborating facts", () => {
    const kb = baseKb();
    const extraction = {
      individuals_mentioned: [
        {
          tree_id: "@I1@", tree_name: "Joseph Sutcliffe", match_confidence: "strong",
          corroborating_facts: ["weaver occupation", "Heptonstall residence"],
          contradicting_facts: [],
        },
      ],
      summary: "x",
    };
    const out = applyStoryEvidence({
      kb, extraction, filename: "joseph.md", fileHash: "abc123def456abcd",
    });
    const ev = out.kb.confidence_evidence["@I1@"].identity;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, "story_corroboration");
    assert.equal(ev[0].source, "joseph.md");
    assert.equal(ev[0].source_kind, "story");
    assert.match(ev[0].evidence_group, /^story_abc123def456abcd_/);
    assert.equal(out.summary.evidence_written, 1);
    assert.equal(out.summary.individuals_matched, 1);
  });

  test("does not write evidence for matches with no corroborating facts", () => {
    const kb = baseKb();
    const extraction = {
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "Joseph", match_confidence: "strong",
          corroborating_facts: [], contradicting_facts: [] },
      ],
      summary: "x",
    };
    const out = applyStoryEvidence({ kb, extraction, filename: "x.md", fileHash: "h" });
    assert.equal(out.summary.evidence_written, 0);
  });

  test("does not write evidence for weak matches (could be a different person)", () => {
    const kb = baseKb();
    const extraction = {
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "Joseph", match_confidence: "weak",
          corroborating_facts: ["maybe related"], contradicting_facts: [] },
      ],
      summary: "x",
    };
    const out = applyStoryEvidence({ kb, extraction, filename: "x.md", fileHash: "h" });
    assert.equal(out.summary.evidence_written, 0);
  });

  test("flags contradictions in the summary without auto-applying negative LR", () => {
    const kb = baseKb();
    const extraction = {
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "Joseph", match_confidence: "strong",
          corroborating_facts: ["lived in Heptonstall"],
          contradicting_facts: ["story says born 1780, tree says 1774"] },
      ],
      summary: "x",
    };
    const out = applyStoryEvidence({ kb, extraction, filename: "x.md", fileHash: "h" });
    assert.equal(out.summary.evidence_written, 1, "corroboration still written");
    assert.equal(out.summary.contradictions_flagged, 1);
    assert.ok(out.summary.contradictions[0].includes("Joseph"));
  });

  test("re-applying same file by hash collapses via evidence_group (no duplication)", () => {
    const kb = baseKb();
    const extraction = {
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "Joseph", match_confidence: "strong",
          corroborating_facts: ["fact"], contradicting_facts: [] },
      ],
      summary: "x",
    };
    let { kb: kb1 } = applyStoryEvidence({ kb, extraction, filename: "x.md", fileHash: "samehash" });
    const { kb: kb2 } = applyStoryEvidence({ kb: kb1, extraction, filename: "x.md", fileHash: "samehash" });
    // Both runs produce the same evidence_group; the accumulator collapses
    // them when computing posteriors. Storage may have 2 entries (we don't
    // dedup at write time) but the user-facing posterior is unchanged.
    const groups = new Set(kb2.confidence_evidence["@I1@"].identity.map((e) => e.evidence_group));
    assert.equal(groups.size, 1, "same file → same evidence_group");
  });

  test("multiple individuals in one story → multiple evidence entries", () => {
    const kb = baseKb();
    const extraction = {
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "Joseph", match_confidence: "strong",
          corroborating_facts: ["a"], contradicting_facts: [] },
        { tree_id: "@I2@", tree_name: "Mary", match_confidence: "strong",
          corroborating_facts: ["b"], contradicting_facts: [] },
      ],
      summary: "x",
    };
    const out = applyStoryEvidence({ kb, extraction, filename: "x.md", fileHash: "h" });
    assert.equal(out.summary.evidence_written, 2);
    assert.ok(out.kb.confidence_evidence["@I1@"]);
    assert.ok(out.kb.confidence_evidence["@I2@"]);
  });
});
