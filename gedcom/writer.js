// GEDCOM 5.5.1 write-back. Reads the original GEDCOM, applies updates from
// individuals.json + families.json + decisions.json, and emits a new versioned
// .ged file. Original is never modified.
//
// What gets written back:
//   - INDI records: confidence band updated in the NOTE field
//   - INDI records: SOUR cross-reference added when a decision was accepted
//                   with a citation
//   - Top-level SOUR records added per accepted citation
//   - New INDI records appended for agent-proposed individuals
//   - New FAM records appended for agent-created families
//   - Existing FAM records updated where HUSB / WIFE got assigned

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// ---------- Parser (same shape as scripts/parse-gedcom.mjs) ----------

const parseLine = (line) => {
  const m = line.match(/^(\d+)\s+(?:(@[^@]+@)\s+)?(\w+)(?:\s+(.*))?$/);
  if (!m) return null;
  return {
    level: Number(m[1]),
    xref: m[2] ?? null,
    tag: m[3],
    value: m[4] ?? "",
    children: [],
  };
};

const parseGedcom = (text) => {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const records = [];
  let current = null;
  const stack = [];
  for (const raw of lines) {
    const node = parseLine(raw);
    if (!node) continue;
    if (node.level === 0) {
      if (current) records.push(current);
      current = node;
      stack[0] = current;
      stack.length = 1;
    } else if (current) {
      const parent = stack[node.level - 1];
      if (!parent) continue;
      parent.children.push(node);
      stack[node.level] = node;
      stack.length = node.level + 1;
    }
  }
  if (current) records.push(current);
  return records;
};

// ---------- Serializer ----------

const serializeNode = (node, level, out) => {
  let line = String(level);
  if (node.xref) line += ` ${node.xref}`;
  line += ` ${node.tag}`;
  // GEDCOM spec recommends folding lines >255 chars with CONC continuations;
  // for genealogy software compatibility, simply truncating at 248 chars and
  // emitting CONC children handles long values robustly.
  if (node.value) {
    const v = String(node.value);
    if (v.length <= 248) {
      line += ` ${v}`;
      out.push(line);
    } else {
      out.push(`${line} ${v.slice(0, 248)}`);
      let rest = v.slice(248);
      while (rest.length > 0) {
        const chunk = rest.slice(0, 248);
        out.push(`${level + 1} CONC ${chunk}`);
        rest = rest.slice(248);
      }
    }
  } else {
    out.push(line);
  }
  for (const child of node.children ?? []) serializeNode(child, level + 1, out);
};

const serializeGedcom = (records) => {
  const out = [];
  for (const rec of records) serializeNode(rec, 0, out);
  return out.join("\n") + "\n";
};

// ---------- Transformations ----------

const findChild = (rec, tag) => rec.children.find((c) => c.tag === tag);
const findChildren = (rec, tag) => rec.children.filter((c) => c.tag === tag);

// Update the CONFIDENCE letter on the NOTE record while preserving everything
// else. The NOTE's value is "CONFIDENCE:X SCORE:Y/20". CONT children carry
// the human-readable description and warnings — left untouched.
const updateNoteConfidence = (indi, newBand) => {
  const note = findChild(indi, "NOTE");
  if (!note) {
    indi.children.push({
      level: 1,
      xref: null,
      tag: "NOTE",
      value: `CONFIDENCE:${newBand} SCORE:0/20`,
      children: [],
    });
    return;
  }
  if (/CONFIDENCE:[A-D]/.test(note.value)) {
    note.value = note.value.replace(/CONFIDENCE:[A-D]/, `CONFIDENCE:${newBand}`);
  } else {
    note.value = `CONFIDENCE:${newBand} ${note.value}`;
  }
  // Append a CONT timestamp marking when this band was last updated
  note.children.push({
    level: 2,
    xref: null,
    tag: "CONT",
    value: `Confidence updated to ${newBand} via Family Research Agent on ${new Date().toISOString().slice(0, 10)}`,
    children: [],
  });
};

const buildSourRecord = (sourId, citation, acceptedAt) => {
  const children = [];
  if (citation.title) {
    children.push({ level: 1, xref: null, tag: "TITL", value: citation.title, children: [] });
  }
  if (citation.repository) {
    children.push({ level: 1, xref: null, tag: "AUTH", value: citation.repository, children: [] });
  }
  if (citation.reference) {
    children.push({ level: 1, xref: null, tag: "PAGE", value: citation.reference, children: [] });
  }
  if (citation.url) {
    children.push({ level: 1, xref: null, tag: "WWW", value: citation.url, children: [] });
  }
  children.push({
    level: 1,
    xref: null,
    tag: "NOTE",
    value: `Accepted via Family Research Agent on ${acceptedAt}`,
    children: [],
  });
  return { level: 0, xref: sourId, tag: "SOUR", value: "", children };
};

const addSourReferenceToIndi = (indi, sourId) => {
  // Avoid duplicate SOUR refs for the same source
  const existing = indi.children.find(
    (c) => c.tag === "SOUR" && c.value === sourId,
  );
  if (existing) return;
  indi.children.push({ level: 1, xref: null, tag: "SOUR", value: sourId, children: [] });
};

const buildAgentIndi = (ind) => {
  const givens = ind.name?.replace(/\/.*\//g, "").trim() ?? "";
  const surname = (ind.name?.split(/\s+/).pop() ?? "").trim();
  const nameValue = surname ? `${givens.replace(surname, "").trim()} /${surname}/` : givens;
  const children = [];
  children.push({ level: 1, xref: null, tag: "NAME", value: nameValue, children: [] });
  if (ind.sex) children.push({ level: 1, xref: null, tag: "SEX", value: ind.sex, children: [] });
  if (ind.birth_year || ind.birth_place) {
    const birt = { level: 1, xref: null, tag: "BIRT", value: "", children: [] };
    if (ind.birth_year) {
      birt.children.push({
        level: 2,
        xref: null,
        tag: "DATE",
        value: ind.birth_date || `Abt. ${ind.birth_year}`,
        children: [],
      });
    }
    if (ind.birth_place) {
      birt.children.push({
        level: 2,
        xref: null,
        tag: "PLAC",
        value: ind.birth_place,
        children: [],
      });
    }
    children.push(birt);
  }
  if (ind.famc) {
    children.push({ level: 1, xref: null, tag: "FAMC", value: ind.famc, children: [] });
  }
  for (const fs of ind.fams ?? []) {
    children.push({ level: 1, xref: null, tag: "FAMS", value: fs, children: [] });
  }
  const noteContents = [
    {
      level: 2,
      xref: null,
      tag: "CONT",
      value: `Proposed by Ancestor Discovery agent on ${(ind.proposed_at ?? new Date().toISOString()).slice(0, 10)}`,
      children: [],
    },
  ];
  for (const w of ind.warnings ?? []) {
    noteContents.push({ level: 2, xref: null, tag: "CONT", value: `WARNING: ${w}`, children: [] });
  }
  children.push({
    level: 1,
    xref: null,
    tag: "NOTE",
    value: `CONFIDENCE:${ind.confidence ?? "C"} SCORE:${ind.score ?? 0}/20`,
    children: noteContents,
  });
  return { level: 0, xref: ind.id, tag: "INDI", value: "", children };
};

const buildAgentFam = (fam) => {
  const children = [];
  if (fam.husband) children.push({ level: 1, xref: null, tag: "HUSB", value: fam.husband, children: [] });
  if (fam.wife) children.push({ level: 1, xref: null, tag: "WIFE", value: fam.wife, children: [] });
  for (const c of fam.children ?? []) {
    children.push({ level: 1, xref: null, tag: "CHIL", value: c, children: [] });
  }
  if (fam.marriage_date || fam.marriage_place) {
    const marr = { level: 1, xref: null, tag: "MARR", value: "", children: [] };
    if (fam.marriage_date) {
      marr.children.push({ level: 2, xref: null, tag: "DATE", value: fam.marriage_date, children: [] });
    }
    if (fam.marriage_place) {
      marr.children.push({ level: 2, xref: null, tag: "PLAC", value: fam.marriage_place, children: [] });
    }
    children.push(marr);
  }
  return { level: 0, xref: fam.id, tag: "FAM", value: "", children };
};

// Update an existing FAM record's HUSB/WIFE/CHIL to match the data file. Adds
// new HUSB/WIFE if missing; leaves existing values alone if they match.
const updateExistingFam = (famRec, famData) => {
  const setOrUpdate = (tag, value) => {
    if (!value) return;
    const existing = famRec.children.find((c) => c.tag === tag);
    if (existing) {
      if (existing.value !== value) existing.value = value;
    } else {
      famRec.children.push({ level: 1, xref: null, tag, value, children: [] });
    }
  };
  setOrUpdate("HUSB", famData.husband);
  setOrUpdate("WIFE", famData.wife);
  // For children, add any in famData not already present
  const existingChildren = new Set(
    famRec.children.filter((c) => c.tag === "CHIL").map((c) => c.value),
  );
  for (const cId of famData.children ?? []) {
    if (!existingChildren.has(cId)) {
      famRec.children.push({ level: 1, xref: null, tag: "CHIL", value: cId, children: [] });
    }
  }
};

// ---------- Public exporter ----------

export const exportGedcom = ({
  sourceGedcomPath,
  outputDir,
  individuals,
  families,
  decisions,
}) => {
  const text = readFileSync(sourceGedcomPath, "utf8");
  const records = parseGedcom(text);

  const indById = new Map(individuals.map((i) => [i.id, i]));
  const famById = new Map(families.map((f) => [f.id, f]));
  const seenIds = new Set();

  // Track which existing INDI/FAM xrefs we've touched so we know what to append
  const seenIndi = new Set();
  const seenFam = new Set();

  // SOUR records to append, plus mapping of individual id -> [sourId,...]
  const newSourRecords = [];
  const indiToSour = new Map();
  let sourCounter = 1;

  for (const [id, dec] of Object.entries(decisions)) {
    if (dec.decision !== "accepted" || !dec.citation) continue;
    const sourId = `@SOUR_FRA_${Date.now()}_${sourCounter++}@`;
    newSourRecords.push(
      buildSourRecord(sourId, dec.citation, dec.decided_at ?? new Date().toISOString()),
    );
    if (!indiToSour.has(id)) indiToSour.set(id, []);
    indiToSour.get(id).push(sourId);
  }

  for (const rec of records) {
    if (rec.tag === "INDI" && rec.xref) {
      seenIndi.add(rec.xref);
      const updated = indById.get(rec.xref);
      if (updated) {
        // Update confidence band in NOTE if it differs from what's encoded
        const note = findChild(rec, "NOTE");
        const currentBand = note?.value?.match(/CONFIDENCE:([A-D])/)?.[1];
        if (currentBand !== updated.confidence) {
          updateNoteConfidence(rec, updated.confidence);
        }
        // Add SOUR cross-references for accepted decisions
        for (const sourId of indiToSour.get(rec.xref) ?? []) {
          addSourReferenceToIndi(rec, sourId);
        }
      }
    } else if (rec.tag === "FAM" && rec.xref) {
      seenFam.add(rec.xref);
      const famData = famById.get(rec.xref);
      if (famData) updateExistingFam(rec, famData);
    }
  }

  // Append new INDI records (agent-proposed)
  const newIndiRecords = [];
  for (const ind of individuals) {
    if (seenIndi.has(ind.id)) continue;
    newIndiRecords.push(buildAgentIndi(ind));
  }

  // Append new FAM records (agent-created)
  const newFamRecords = [];
  for (const fam of families) {
    if (seenFam.has(fam.id)) continue;
    newFamRecords.push(buildAgentFam(fam));
  }

  // Insert new SOUR records before the trailer (last record is typically TRLR)
  const trailerIdx = records.findIndex((r) => r.tag === "TRLR");
  const insertAt = trailerIdx > -1 ? trailerIdx : records.length;
  records.splice(insertAt, 0, ...newIndiRecords, ...newFamRecords, ...newSourRecords);

  // Determine output filename — versioned, never overwrite
  const baseName = path.basename(sourceGedcomPath, ".ged").replace(/_v\d+$/, "");
  let v = 2;
  let outPath;
  while (true) {
    outPath = path.join(outputDir, `${baseName}_v${v}.ged`);
    if (!existsSync(outPath)) break;
    v++;
  }

  const output = serializeGedcom(records);
  writeFileSync(outPath, output, "utf8");

  return {
    path: outPath,
    counts: {
      total_individuals: individuals.length,
      existing_indi_updated: seenIndi.size,
      new_indi_appended: newIndiRecords.length,
      total_families: families.length,
      existing_fam_updated: seenFam.size,
      new_fam_appended: newFamRecords.length,
      new_sources: newSourRecords.length,
    },
  };
};
