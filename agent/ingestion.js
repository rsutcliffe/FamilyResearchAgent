// Document and story ingestion pipeline.
//
// Phase 1: folder scanning (this file). No API calls.
// Phase 2: story extraction via Claude text API.
// Phase 3: document extraction via Claude vision API.
//
// Architecture: each file is identified by a content hash. The ingestion
// log (data/ingestion_log.json) records what's been processed, so re-scanning
// a folder reports per-file status (unprocessed / processed / changed /
// failed). Re-processing the same file is idempotent — confidence_evidence
// entries are keyed off the hash via evidence_group, so repeats collapse.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 16 hex chars = 64 bits of hash. Plenty for collision avoidance in a
// personal genealogy folder; short enough to render in a UI tooltip.
const HASH_LENGTH = 16;

const hashContent = (filePath) => {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, HASH_LENGTH);
};

const STORY_EXTENSIONS = [".md", ".txt"];
const DOCUMENT_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];

// List files in a folder with hash + size. Skips hidden files and
// subdirectories (flat-folder model in v1). Returns [] if the folder
// doesn't exist — the user may simply not have set up that side yet.
export const scanIngestFolder = ({ folderPath, kind, allowedExtensions } = {}) => {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  const exts = allowedExtensions ?? (kind === "story" ? STORY_EXTENSIONS : DOCUMENT_EXTENSIONS);
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!exts.includes(ext)) continue;
    const fullPath = path.join(folderPath, entry.name);
    const stat = fs.statSync(fullPath);
    out.push({
      name: entry.name,
      hash: hashContent(fullPath),
      kind,
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    });
  }
  return out;
};

// Decorate scan results with processed-status from the ingestion log.
//   unprocessed: never seen this file
//   processed:   filename + hash both match a successful prior run
//   changed:     filename matches but content has changed since last run
//   failed:      last run errored — surfaces the error message for diagnosis
export const attachIngestionStatus = (files, log = { files: {} }) => {
  const logFiles = log?.files ?? {};
  return files.map((f) => {
    const prior = logFiles[f.name];
    if (!prior) {
      return { ...f, status: "unprocessed", last_processed_at: null };
    }
    if (prior.status === "failed") {
      return {
        ...f,
        status: "failed",
        last_processed_at: prior.last_processed_at ?? null,
        error: prior.error ?? null,
      };
    }
    if (prior.hash !== f.hash) {
      return { ...f, status: "changed", last_processed_at: prior.last_processed_at ?? null };
    }
    return {
      ...f,
      status: "processed",
      last_processed_at: prior.last_processed_at ?? null,
      individuals_matched: prior.individuals_matched ?? 0,
      evidence_written: prior.evidence_written ?? 0,
    };
  });
};
