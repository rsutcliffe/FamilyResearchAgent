#!/usr/bin/env node
// Import an external GEDCOM (Ancestry export, etc.) into the running app.
// Usage: node scripts/import-gedcom.mjs path/to/your.ged
//
// Requires the dev server to be running (npm start).
// External data is treated as Tier 3 leads — never raises a confidence
// band on its own. The agent sees it as hypotheses to verify.

import { readFileSync } from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/import-gedcom.mjs path/to/your.ged");
  process.exit(2);
}

const text = readFileSync(file, "utf8");
const filename = path.basename(file);

const PORT = process.env.PORT || 3000;
const url = `http://localhost:${PORT}/api/external/import`;

console.log(`Importing ${filename} (${(text.length / 1024).toFixed(0)} KB) → ${url}`);

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ filename, text }),
});

if (!res.ok) {
  console.error(`Import failed: ${res.status} ${res.statusText}`);
  console.error(await res.text());
  process.exit(1);
}

const { summary } = await res.json();
console.log(`\nImport complete:`);
console.log(`  Filename:      ${summary.filename}`);
console.log(`  Imported at:   ${summary.imported_at}`);
console.log(`  Individuals:   ${summary.individual_count}`);
console.log(`  Families:      ${summary.family_count}`);
console.log(`  Sources:       ${summary.source_count}`);
console.log(`  Matched:       ${summary.matched_count} (linked to existing tree)`);
console.log(`  Unmatched:     ${summary.unmatched_count} (candidate ancestors)`);
console.log(``);
console.log(`Run agents on matched individuals — the new external_suggestions`);
console.log(`section will appear in their KB context as Tier 3 leads.`);
