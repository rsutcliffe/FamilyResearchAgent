#!/usr/bin/env node
// Parse Sutcliffe_CleanTree_v1.ged into three JSON files:
//   data/individuals.json   — all individuals with confidence/score/warnings/alerts
//   data/families.json      — family records (husband, wife, children, marriage)
//   data/relationships.json — derived parent-child links with link-level confidence
//
// Run with: node scripts/parse-gedcom.mjs

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "research", "Sutcliffe_CleanTree_v1.ged");
const ROOT_INDIVIDUAL_ID = "@I1825902591@"; // Richard David Sutcliffe

const lines = readFileSync(SOURCE, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.length);

const parseLine = (line) => {
  const m = line.match(/^(\d+)\s+(?:(@[^@]+@)\s+)?(\w+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { level: Number(m[1]), xref: m[2] ?? null, tag: m[3], value: m[4] ?? "" };
};

// Split flat lines into nested record trees (level 0 = INDI/FAM block boundary).
const records = [];
let current = null;
for (const raw of lines) {
  const node = parseLine(raw);
  if (!node) continue;
  if (node.level === 0) {
    if (current) records.push(current);
    current = { ...node, children: [], _stack: [] };
    current._stack[0] = current;
  } else if (current) {
    const parent = current._stack[node.level - 1];
    if (!parent) continue;
    const child = { ...node, children: [] };
    parent.children.push(child);
    current._stack[node.level] = child;
  }
}
if (current) records.push(current);

const findChild = (rec, tag) => rec.children.find((c) => c.tag === tag);
const findChildren = (rec, tag) => rec.children.filter((c) => c.tag === tag);

// Concatenate the value plus any CONT/CONC continuation children. GEDCOM
// CONT = newline-separated continuation; CONC = concatenated (no newline).
const fullText = (rec) => {
  let text = rec.value;
  for (const child of rec.children) {
    if (child.tag === "CONT") text += "\n" + child.value;
    else if (child.tag === "CONC") text += child.value;
  }
  return text;
};

const parseEvent = (rec) => {
  if (!rec) return { date: "", place: "" };
  const date = findChild(rec, "DATE")?.value ?? "";
  const place = findChild(rec, "PLAC")?.value ?? "";
  return { date, place };
};

// Extract birth year from a date string. Handles "Abt. 1802", "1 Jan 1820",
// "January 1859", "Bef. 1730", etc. Returns null if no 4-digit year.
const extractYear = (dateStr) => {
  if (!dateStr) return null;
  const m = dateStr.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
};

const parseNote = (rec) => {
  const noteRec = findChild(rec, "NOTE");
  if (!noteRec) return { confidence: null, score: null, warnings: [], alerts: [] };
  const text = fullText(noteRec);
  const confidence = text.match(/CONFIDENCE:([A-D])/)?.[1] ?? null;
  const score = Number(text.match(/SCORE:(\d+)\/20/)?.[1] ?? "0") || null;
  const warnings = [];
  const alerts = [];
  for (const line of text.split("\n")) {
    const w = line.match(/^WARNING:\s*(.+)$/);
    const a = line.match(/^ALERT:\s*(.+)$/);
    if (w) warnings.push(w[1].trim());
    if (a) alerts.push(a[1].trim());
  }
  return { confidence, score, warnings, alerts };
};

const individuals = [];
const families = [];

for (const rec of records) {
  if (rec.tag === "INDI") {
    const nameRec = findChild(rec, "NAME");
    const rawName = nameRec?.value ?? "";
    const name = rawName.replace(/\//g, "").replace(/\s+/g, " ").trim();
    const sex = findChild(rec, "SEX")?.value ?? "";
    const birth = parseEvent(findChild(rec, "BIRT"));
    const death = parseEvent(findChild(rec, "DEAT"));
    const baptism = parseEvent(findChild(rec, "BAPM"));
    const famc = findChild(rec, "FAMC")?.value ?? null;
    const fams = findChildren(rec, "FAMS").map((f) => f.value);
    const note = parseNote(rec);

    individuals.push({
      id: rec.xref,
      name,
      sex,
      birth_year: extractYear(birth.date),
      birth_date: birth.date,
      birth_place: birth.place,
      death_date: death.date,
      death_place: death.place,
      baptism_date: baptism.date,
      baptism_place: baptism.place,
      famc,
      fams,
      confidence: note.confidence ?? "D",
      score: note.score ?? 0,
      warnings: note.warnings,
      alerts: note.alerts,
    });
  } else if (rec.tag === "FAM") {
    const husb = findChild(rec, "HUSB")?.value ?? null;
    const wife = findChild(rec, "WIFE")?.value ?? null;
    const children = findChildren(rec, "CHIL").map((c) => c.value);
    const marr = parseEvent(findChild(rec, "MARR"));
    families.push({
      id: rec.xref,
      husband: husb,
      wife,
      children,
      marriage_date: marr.date,
      marriage_place: marr.place,
    });
  }
}

// Compute generation depth from the root individual via BFS up the FAMC chain.
const indById = new Map(individuals.map((i) => [i.id, i]));
const famById = new Map(families.map((f) => [f.id, f]));

const generations = new Map();
const queue = [{ id: ROOT_INDIVIDUAL_ID, gen: 0 }];
const visited = new Set();
while (queue.length) {
  const { id, gen } = queue.shift();
  if (!id || visited.has(id)) continue;
  visited.add(id);
  generations.set(id, gen);
  const ind = indById.get(id);
  if (!ind?.famc) continue;
  const fam = famById.get(ind.famc);
  if (!fam) continue;
  if (fam.husband) queue.push({ id: fam.husband, gen: gen + 1 });
  if (fam.wife) queue.push({ id: fam.wife, gen: gen + 1 });
}

// Spouses inherit the same generation as their partner (genealogically the
// spouse of an ancestor sits at the same level for layout purposes).
for (const fam of families) {
  for (const child of fam.children) {
    const childGen = generations.get(child);
    if (childGen === undefined) continue;
    const parentGen = childGen + 1;
    if (fam.husband && !generations.has(fam.husband)) generations.set(fam.husband, parentGen);
    if (fam.wife && !generations.has(fam.wife)) generations.set(fam.wife, parentGen);
  }
}

for (const ind of individuals) {
  ind.generation = generations.get(ind.id) ?? null;
}

// Build parent-child relationship records with link-level confidence.
// Initial seed: link.confidence = child.confidence (heuristic — same source
// generally produced both the child's record and the parent assignment).
// The link.source field flags this as inherited rather than primary-verified.
const relationships = [];
for (const fam of families) {
  for (const childId of fam.children) {
    const child = indById.get(childId);
    if (!child) continue;
    if (fam.husband) {
      relationships.push({
        id: `${fam.id}-${fam.husband}-${childId}`,
        family_id: fam.id,
        parent_id: fam.husband,
        child_id: childId,
        kind: "father",
        confidence: child.confidence,
        source: "GEDCOM-asserted; inherited from child's confidence band; not directly link-verified",
        verified_at: null,
        evidence_id: null,
      });
    }
    if (fam.wife) {
      relationships.push({
        id: `${fam.id}-${fam.wife}-${childId}`,
        family_id: fam.id,
        parent_id: fam.wife,
        child_id: childId,
        kind: "mother",
        confidence: child.confidence,
        source: "GEDCOM-asserted; inherited from child's confidence band; not directly link-verified",
        verified_at: null,
        evidence_id: null,
      });
    }
  }
}

const writeJson = (file, data) => {
  writeFileSync(path.join(ROOT, "data", file), JSON.stringify(data, null, 2));
  console.log(`  ✔  data/${file}  (${Array.isArray(data) ? data.length : Object.keys(data).length} records)`);
};

console.log(`Parsed ${SOURCE.split("/").pop()}:`);
writeJson("individuals.json", individuals);
writeJson("families.json", families);
writeJson("relationships.json", relationships);

const bandCounts = individuals.reduce((acc, i) => {
  acc[i.confidence] = (acc[i.confidence] ?? 0) + 1;
  return acc;
}, {});
console.log(`\nBand counts: ${JSON.stringify(bandCounts)}`);
const placed = individuals.filter((i) => i.generation !== null).length;
console.log(`Generation placed: ${placed}/${individuals.length}`);
