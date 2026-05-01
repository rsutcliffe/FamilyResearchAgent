import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyAgentRunToKb,
  applyAcceptedMatchToKb,
  applyAcceptedCandidateToKb,
  clearReresearchFlag,
} from "../../agent/researchKb.js";

const emptyKb = () => ({
  known_parishes: {},
  naming_pattern_warnings: [],
  negative_searches: [],
  confirmed_relatives: {},
  migration_routes: [],
  alias_registry: {},
  reresearch_recommended: {},
  last_changed_at: null,
});

describe("applyAgentRunToKb", () => {
  test("appends parsed negative_searches with individual_id", () => {
    const text = `<<NEGATIVE_SEARCHES>>\nFreeBMD||a query\n<</NEGATIVE_SEARCHES>>`;
    const result = applyAgentRunToKb(emptyKb(), "@I123@", text);
    assert.equal(result.negative_searches.length, 1);
    assert.equal(result.negative_searches[0].individual_id, "@I123@");
    assert.equal(result.negative_searches[0].source, "FreeBMD");
  });

  test("dedupes negative_searches by source||query for same individual", () => {
    const text = `<<NEGATIVE_SEARCHES>>\nFreeBMD||a query\n<</NEGATIVE_SEARCHES>>`;
    let kb = applyAgentRunToKb(emptyKb(), "@I123@", text);
    kb = applyAgentRunToKb(kb, "@I123@", text); // run again with same query
    assert.equal(kb.negative_searches.length, 1);
  });

  test("merges new alias variants without duplicating existing ones", () => {
    const t1 = `<<ALIAS_OBSERVATIONS>>\nAnn Sweeting||Anne Sweeting||src1\n<</ALIAS_OBSERVATIONS>>`;
    const t2 = `<<ALIAS_OBSERVATIONS>>\nAnn Sweeting||Anne Sweeting||src2\nAnn Sweeting||Anne Sw||src3\n<</ALIAS_OBSERVATIONS>>`;
    let kb = applyAgentRunToKb(emptyKb(), "@I@", t1);
    kb = applyAgentRunToKb(kb, "@I@", t2);
    assert.deepEqual(kb.alias_registry["Ann Sweeting"], ["Anne Sweeting", "Anne Sw"]);
  });

  test("caps stored negative_searches at 50 per individual (FIFO)", () => {
    let kb = emptyKb();
    for (let i = 0; i < 60; i++) {
      const text = `<<NEGATIVE_SEARCHES>>\nFreeBMD||query ${i}\n<</NEGATIVE_SEARCHES>>`;
      kb = applyAgentRunToKb(kb, "@I@", text);
    }
    assert.equal(kb.negative_searches.length, 50);
    // The oldest should have been dropped — first kept query is index 10
    assert.equal(kb.negative_searches[0].query, "query 10");
  });

  test("updates last_changed_at timestamp", () => {
    const before = emptyKb();
    assert.equal(before.last_changed_at, null);
    const after = applyAgentRunToKb(before, "@I@", "<<NEGATIVE_SEARCHES>>\nNONE\n<</NEGATIVE_SEARCHES>>");
    assert.notEqual(after.last_changed_at, null);
  });
});

describe("applyAcceptedMatchToKb", () => {
  const individual = {
    id: "@I_ann@",
    name: "Ann Sweeting",
    sex: "F",
    birth_year: 1802,
    birth_place: "Monks Frystone, Yorkshire",
    famc: "@F1@",
    fams: [],
  };
  const families = [
    {
      id: "@F1@",
      husband: "@I_richard@",
      wife: "@I_annW@",
      children: ["@I_ann@", "@I_joseph@"],
    },
  ];
  const individuals = [
    individual,
    { id: "@I_richard@", name: "Richard Sweeting", sex: "M", birth_place: "Brayton" },
    { id: "@I_annW@", name: "Ann Wainwright", sex: "F", birth_place: "Hillam" },
    { id: "@I_joseph@", name: "Joseph Sweeting", sex: "M", birth_place: "Monks Frystone" },
  ];
  const citation = {
    title: "Yorkshire Baptisms 1813-1910",
    repository: "WYAS",
    reference: "WDP149/1/1/3 p.47",
  };

  test("adds the individual's birth_place to known_parishes for their surname", () => {
    const kb = applyAcceptedMatchToKb(emptyKb(), {
      individual,
      citation,
      newConfidence: "B",
      families,
      individuals,
      evidenceLog: {},
    });
    assert.deepEqual(kb.known_parishes["Sweeting"], ["Monks Frystone, Yorkshire"]);
  });

  test("adds this individual as a confirmed relative for father, mother, and siblings", () => {
    const kb = applyAcceptedMatchToKb(emptyKb(), {
      individual,
      citation,
      newConfidence: "B",
      families,
      individuals,
      evidenceLog: {},
    });
    assert.ok(kb.confirmed_relatives["@I_richard@"]?.length, "father should have ann as confirmed");
    assert.ok(kb.confirmed_relatives["@I_annW@"]?.length, "mother should have ann as confirmed");
    assert.ok(kb.confirmed_relatives["@I_joseph@"]?.length, "sibling should have ann as confirmed");
    assert.equal(kb.confirmed_relatives["@I_joseph@"][0].relationship, "sibling");
  });

  test("flags related individuals for re-research only if they have a prior research entry", () => {
    const evidenceLog = {
      "@I_joseph@": { runs: [{ agent_result: "previous run" }] },
      // Richard has no prior research; should NOT be flagged
    };
    const kb = applyAcceptedMatchToKb(emptyKb(), {
      individual,
      citation,
      newConfidence: "B",
      families,
      individuals,
      evidenceLog,
    });
    assert.ok(kb.reresearch_recommended["@I_joseph@"], "Joseph (researched) should be flagged");
    assert.equal(kb.reresearch_recommended["@I_richard@"], undefined, "Richard (not researched) should NOT be flagged");
  });

  test("derives a migration route when the individual's birth place differs from a confirmed parent's", () => {
    // Mother is at confidence A and has a different birth place
    const indWithGoodParents = [...individuals];
    indWithGoodParents.find((p) => p.id === "@I_annW@").confidence = "A";
    indWithGoodParents.find((p) => p.id === "@I_richard@").confidence = "A";
    const kb = applyAcceptedMatchToKb(emptyKb(), {
      individual,
      citation,
      newConfidence: "B",
      families,
      individuals: indWithGoodParents,
      evidenceLog: {},
    });
    // Should include "Brayton -> Monks Frystone, Yorkshire" or similar
    assert.ok(
      kb.migration_routes.some((r) => r.includes("Brayton") && r.includes("Monks Frystone")),
      `expected route Brayton -> Monks Frystone in: ${JSON.stringify(kb.migration_routes)}`,
    );
  });

  test("records source efficacy from the citation repository", () => {
    const kb = applyAcceptedMatchToKb(emptyKb(), {
      individual,
      citation: { ...citation, repository: "FamilySearch parish register transcript" },
      newConfidence: "B",
      families,
      individuals,
      evidenceLog: {},
    });
    assert.equal(kb.source_efficacy["FamilySearch"]?.accepted_count, 1);
  });
});

describe("applyAcceptedCandidateToKb", () => {
  test("registers the new individual as a confirmed relative of the child", () => {
    const newIndividual = {
      id: "@AGENT_1@",
      name: "Richard Sweeting",
      birth_place: "Brayton",
      birth_year: 1759,
      confidence: "C",
    };
    const child = { id: "@I_ann@", name: "Ann Sweeting", famc: "@F1@" };
    const kb = applyAcceptedCandidateToKb(emptyKb(), {
      newIndividual,
      child,
      role: "father",
      linkCitation: "St Wilfrid's Monk Fryston baptism register",
      families: [{ id: "@F1@", children: ["@I_ann@"] }],
      individuals: [child, newIndividual],
      evidenceLog: {},
    });
    assert.ok(kb.confirmed_relatives["@I_ann@"]);
    assert.equal(kb.confirmed_relatives["@I_ann@"][0].relative_id, "@AGENT_1@");
    assert.equal(kb.confirmed_relatives["@I_ann@"][0].relationship, "father");
  });
});

describe("clearReresearchFlag", () => {
  test("removes the entry for the given individual id", () => {
    const kb = emptyKb();
    kb.reresearch_recommended = { "@I@": { reason: "x" }, "@J@": { reason: "y" } };
    const next = clearReresearchFlag(kb, "@I@");
    assert.equal(next.reresearch_recommended["@I@"], undefined);
    assert.ok(next.reresearch_recommended["@J@"]);
  });

  test("is a no-op for individuals with no flag", () => {
    const kb = emptyKb();
    const next = clearReresearchFlag(kb, "@anywhere@");
    assert.deepEqual(next.reresearch_recommended, {});
  });
});
