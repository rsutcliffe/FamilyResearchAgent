import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildDocumentExtractionPrompt,
  parseDocumentExtractionResponse,
  applyDocumentEvidence,
  estimateDocumentCost,
} from "../../agent/ingestion.js";

const ourTreeSample = [
  { id: "@I1@", name: "Joseph Sutcliffe", birth_year: 1774, birth_place: "Heptonstall" },
  { id: "@I3@", name: "Ann Sweeting", birth_year: 1802, birth_place: "Monks Frystone" },
];

describe("buildDocumentExtractionPrompt", () => {
  test("asks Claude to identify document type from a closed list of kinds", () => {
    const prompt = buildDocumentExtractionPrompt({ ourTree: ourTreeSample });
    assert.match(prompt, /document_kind/);
    // Document kinds the LR table knows about
    assert.match(prompt, /civil_bmd_certificate/);
    assert.match(prompt, /parish_baptism/);
    assert.match(prompt, /census_record/);
    assert.match(prompt, /will_or_probate/);
  });

  test("asks for individuals_mentioned + corroborating/contradicting facts (same shape as stories)", () => {
    const prompt = buildDocumentExtractionPrompt({ ourTree: ourTreeSample });
    assert.match(prompt, /individuals_mentioned/);
    assert.match(prompt, /corroborating_facts/);
    assert.match(prompt, /contradicting_facts/);
  });

  test("includes the tree summary so Claude can match individuals", () => {
    const prompt = buildDocumentExtractionPrompt({ ourTree: ourTreeSample });
    assert.match(prompt, /@I1@.*Joseph Sutcliffe/);
  });

  test("instructs Claude to return JSON only", () => {
    const prompt = buildDocumentExtractionPrompt({ ourTree: [] });
    assert.match(prompt, /JSON/i);
  });
});

describe("parseDocumentExtractionResponse", () => {
  test("returns parsed shape with document_kind + individuals_mentioned", () => {
    const text = `\`\`\`json
{
  "document_kind": "parish_baptism",
  "transcript_summary": "Baptism of Joseph Sutcliffe son of William, Heptonstall 1774",
  "individuals_mentioned": [
    { "tree_id": "@I1@", "tree_name": "Joseph Sutcliffe", "match_confidence": "strong",
      "corroborating_facts": ["birth year 1774 matches", "place Heptonstall matches"],
      "contradicting_facts": [] }
  ]
}
\`\`\``;
    const out = parseDocumentExtractionResponse(text);
    assert.equal(out.document_kind, "parish_baptism");
    assert.equal(out.individuals_mentioned.length, 1);
    assert.equal(out.individuals_mentioned[0].tree_id, "@I1@");
  });

  test("normalises unknown document_kind to 'unknown_document'", () => {
    const out = parseDocumentExtractionResponse(`{"document_kind":"some_random_thing","individuals_mentioned":[]}`);
    assert.equal(out.document_kind, "unknown_document");
  });

  test("missing individuals_mentioned defaults to []", () => {
    const out = parseDocumentExtractionResponse(`{"document_kind":"census_record"}`);
    assert.deepEqual(out.individuals_mentioned, []);
  });

  test("returns null on malformed input", () => {
    assert.equal(parseDocumentExtractionResponse(""), null);
    assert.equal(parseDocumentExtractionResponse("not json"), null);
  });
});

describe("applyDocumentEvidence", () => {
  const baseKb = () => ({ confidence_evidence: {} });

  test("looks up the LR for the identified document_kind from the table", () => {
    const kb = baseKb();
    const extraction = {
      document_kind: "parish_baptism",
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "Joseph", match_confidence: "strong",
          corroborating_facts: ["year matches"], contradicting_facts: [] },
      ],
    };
    const out = applyDocumentEvidence({ kb, extraction, filename: "j_baptism.jpg", fileHash: "abc" });
    const ev = out.kb.confidence_evidence["@I1@"].identity[0];
    assert.equal(ev.kind, "parish_baptism");
    assert.equal(ev.lr, 50, "LR matches the table value for parish_baptism");
    assert.equal(ev.source_tier, 1);
    assert.equal(ev.source_kind, "document");
    assert.equal(ev.source, "j_baptism.jpg");
    assert.match(ev.evidence_group, /^doc_abc_/);
  });

  test("Tier 1 civil_bmd_certificate gets LR 80", () => {
    const kb = baseKb();
    const extraction = {
      document_kind: "civil_bmd_certificate",
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "X", match_confidence: "strong",
          corroborating_facts: ["dates match"], contradicting_facts: [] },
      ],
    };
    const out = applyDocumentEvidence({ kb, extraction, filename: "cert.pdf", fileHash: "h" });
    assert.equal(out.kb.confidence_evidence["@I1@"].identity[0].lr, 80);
  });

  test("unknown document_kind falls back to a neutral LR (still records the find)", () => {
    const kb = baseKb();
    const extraction = {
      document_kind: "unknown_document",
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "X", match_confidence: "strong",
          corroborating_facts: ["facts"], contradicting_facts: [] },
      ],
    };
    const out = applyDocumentEvidence({ kb, extraction, filename: "x.jpg", fileHash: "h" });
    const ev = out.kb.confidence_evidence["@I1@"].identity[0];
    assert.ok(ev.lr >= 1 && ev.lr <= 5, "fallback LR is conservative");
  });

  test("multiple individuals in one document each get an evidence entry", () => {
    const kb = baseKb();
    const extraction = {
      document_kind: "census_record",
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "Joseph", match_confidence: "strong",
          corroborating_facts: ["age matches"], contradicting_facts: [] },
        { tree_id: "@I3@", tree_name: "Ann", match_confidence: "strong",
          corroborating_facts: ["place matches"], contradicting_facts: [] },
      ],
    };
    const out = applyDocumentEvidence({ kb, extraction, filename: "1841_census.jpg", fileHash: "h" });
    assert.equal(out.summary.evidence_written, 2);
    assert.equal(out.kb.confidence_evidence["@I1@"].identity[0].kind, "census_record");
    assert.equal(out.kb.confidence_evidence["@I3@"].identity[0].kind, "census_record");
  });

  test("contradictions surface in summary, do not auto-write negative LR", () => {
    const kb = baseKb();
    const extraction = {
      document_kind: "parish_baptism",
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "Joseph", match_confidence: "strong",
          corroborating_facts: ["place matches"],
          contradicting_facts: ["doc says born 1780, tree says 1774"] },
      ],
    };
    const out = applyDocumentEvidence({ kb, extraction, filename: "x.jpg", fileHash: "h" });
    assert.equal(out.summary.contradictions_flagged, 1);
    assert.equal(out.summary.evidence_written, 1, "still writes corroboration");
  });

  test("re-applying same file (same hash) groups identically (no double-counting)", () => {
    const kb = baseKb();
    const extraction = {
      document_kind: "parish_baptism",
      individuals_mentioned: [
        { tree_id: "@I1@", tree_name: "x", match_confidence: "strong",
          corroborating_facts: ["a"], contradicting_facts: [] },
      ],
    };
    const r1 = applyDocumentEvidence({ kb, extraction, filename: "x.jpg", fileHash: "samehash" });
    const r2 = applyDocumentEvidence({ kb: r1.kb, extraction, filename: "x.jpg", fileHash: "samehash" });
    const groups = new Set(r2.kb.confidence_evidence["@I1@"].identity.map((e) => e.evidence_group));
    assert.equal(groups.size, 1);
  });
});

describe("estimateDocumentCost", () => {
  test("returns USD estimate by file count and average size", () => {
    // Assumption: ~$0.05/document at typical census image resolution.
    // The estimate is an upper bound for the user's cost preview.
    const cost = estimateDocumentCost({ fileCount: 10 });
    assert.ok(cost > 0);
    assert.ok(cost <= 1.00, "10 documents should be well under $1");
  });

  test("zero files = zero cost", () => {
    assert.equal(estimateDocumentCost({ fileCount: 0 }), 0);
  });

  test("handles unspecified count gracefully", () => {
    assert.equal(estimateDocumentCost({}), 0);
  });
});
