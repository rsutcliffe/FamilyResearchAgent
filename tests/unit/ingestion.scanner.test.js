import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanIngestFolder, attachIngestionStatus } from "../../agent/ingestion.js";

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-test-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeFile = (name, content) => {
  fs.writeFileSync(path.join(tmpDir, name), content);
};

describe("scanIngestFolder", () => {
  test("returns empty list when folder doesn't exist", () => {
    const out = scanIngestFolder({ folderPath: path.join(tmpDir, "nope"), kind: "story" });
    assert.deepEqual(out, []);
  });

  test("lists files with name, hash, kind, size", () => {
    writeFile("story_one.md", "Story content here");
    writeFile("story_two.txt", "Another story");
    const out = scanIngestFolder({ folderPath: tmpDir, kind: "story" });
    const names = out.map((f) => f.name).sort();
    assert.ok(names.includes("story_one.md"));
    assert.ok(names.includes("story_two.txt"));
    for (const f of out) {
      assert.equal(f.kind, "story");
      assert.match(f.hash, /^[0-9a-f]{16}$/, "16-char hex hash prefix");
      assert.ok(typeof f.size_bytes === "number" && f.size_bytes > 0);
    }
  });

  test("skips hidden files (.DS_Store, .gitkeep)", () => {
    writeFile(".DS_Store", "macOS junk");
    writeFile(".gitkeep", "");
    const out = scanIngestFolder({ folderPath: tmpDir, kind: "story" });
    for (const f of out) {
      assert.ok(!f.name.startsWith("."), `hidden file leaked: ${f.name}`);
    }
  });

  test("skips subdirectories (v1 — flat folders only)", () => {
    fs.mkdirSync(path.join(tmpDir, "subfolder"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "subfolder", "nested.md"), "x");
    const out = scanIngestFolder({ folderPath: tmpDir, kind: "story" });
    for (const f of out) assert.ok(f.name !== "subfolder");
  });

  test("filters by allowed extensions when provided", () => {
    writeFile("photo.jpg", "JPEG bytes");
    writeFile("doc.pdf", "PDF bytes");
    writeFile("readme.txt", "ignored");
    const out = scanIngestFolder({
      folderPath: tmpDir,
      kind: "document",
      allowedExtensions: [".pdf", ".jpg", ".jpeg", ".png"],
    });
    const names = out.map((f) => f.name);
    assert.ok(names.includes("photo.jpg"));
    assert.ok(names.includes("doc.pdf"));
    assert.ok(!names.includes("readme.txt"));
  });

  test("identical content produces identical hash (idempotent re-scan)", () => {
    writeFile("a.md", "deterministic content");
    writeFile("b.md", "deterministic content");
    const out = scanIngestFolder({ folderPath: tmpDir, kind: "story" });
    const a = out.find((f) => f.name === "a.md");
    const b = out.find((f) => f.name === "b.md");
    assert.equal(a.hash, b.hash);
  });
});

describe("attachIngestionStatus", () => {
  test("decorates files with status='unprocessed' when no log entry exists", () => {
    const files = [
      { name: "x.md", hash: "abcd1234abcd1234", kind: "story" },
    ];
    const out = attachIngestionStatus(files, { files: {} });
    assert.equal(out[0].status, "unprocessed");
    assert.equal(out[0].last_processed_at, null);
  });

  test("decorates files with status='processed' when hash matches log", () => {
    const files = [{ name: "x.md", hash: "abcd1234abcd1234", kind: "story" }];
    const log = {
      files: {
        "x.md": {
          hash: "abcd1234abcd1234",
          last_processed_at: "2026-05-02T10:00:00Z",
          status: "ok",
          individuals_matched: 2,
          evidence_written: 2,
        },
      },
    };
    const out = attachIngestionStatus(files, log);
    assert.equal(out[0].status, "processed");
    assert.equal(out[0].individuals_matched, 2);
  });

  test("status='changed' when filename matches but hash differs (file edited)", () => {
    const files = [{ name: "x.md", hash: "newhashnewhash00", kind: "story" }];
    const log = {
      files: { "x.md": { hash: "oldhashOLDhash00", last_processed_at: "2026-05-02T10:00:00Z", status: "ok" } },
    };
    const out = attachIngestionStatus(files, log);
    assert.equal(out[0].status, "changed");
  });

  test("status='failed' surfaces last error so user can see why", () => {
    const files = [{ name: "x.md", hash: "h00", kind: "story" }];
    const log = {
      files: { "x.md": { hash: "h00", status: "failed", error: "Claude returned malformed JSON" } },
    };
    const out = attachIngestionStatus(files, log);
    assert.equal(out[0].status, "failed");
    assert.equal(out[0].error, "Claude returned malformed JSON");
  });
});
