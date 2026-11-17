"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RepoFileService, snapshotInfo, SNAPSHOT_FILE_LIMIT } = require("../fileService");

function repoWithFiles(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-snapshot-"));
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(root, `f${index}.txt`), `file ${index}\n`, "utf8");
  }
  return root;
}

test("the default snapshot limit is far above the old 2,000-file cap", () => {
  assert.ok(SNAPSHOT_FILE_LIMIT >= 50_000);
  const root = repoWithFiles(2500);
  const state = new RepoFileService(root).snapshotRepoState(root);
  assert.equal(Object.keys(state).length, 2500);
  assert.deepEqual(snapshotInfo(state), { truncated: false, limit: SNAPSHOT_FILE_LIMIT, fileCount: 2500 });
});

test("a snapshot that hits its limit reports truncated", () => {
  const root = repoWithFiles(12);
  const service = new RepoFileService(root);
  const capped = service.snapshotRepoState(root, { limit: 10 });
  assert.equal(Object.keys(capped).length, 10);
  assert.equal(snapshotInfo(capped).truncated, true);

  // Exactly at the limit is complete, not truncated.
  const exact = service.snapshotRepoState(root, { limit: 12 });
  assert.equal(snapshotInfo(exact).truncated, false);
});

test("snapshot metadata never shows up as a path or in JSON", () => {
  const root = repoWithFiles(1);
  const state = new RepoFileService(root).snapshotRepoState(root);
  assert.deepEqual(Object.keys(state), ["f0.txt"]);
  assert.equal(snapshotInfo(JSON.parse(JSON.stringify(state))), null);
});

test("past the text budget files are tracked by size and mtime and edits still show", () => {
  const root = repoWithFiles(5);
  const service = new RepoFileService(root);
  const before = service.snapshotRepoState(root, { maxTextBytes: 10 });
  assert.ok(Object.values(before).some((entry) => entry.text === null));

  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(root, `f${index}.txt`), `changed ${index} longer\n`, "utf8");
  }
  const after = service.snapshotRepoState(root, { maxTextBytes: 10 });
  const changes = service.diffRepoState(before, after);
  assert.equal(changes.length, 5);
  assert.ok(changes.every((change) => change.action === "edit"));
});
