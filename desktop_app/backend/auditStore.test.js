const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AuditStore } = require("./auditStore");

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-audit-"));
}

test("record() appends a hash-chained entry and list() returns newest-first", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);

  store.record({ action: "create", path: "a.txt", provider: "codex", chatId: "c1" });
  store.record({ action: "edit", path: "a.txt", provider: "codex", chatId: "c1" });

  const entries = store.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, "edit"); // newest first
  assert.equal(entries[1].action, "create");
  assert.equal(entries[1].prev_hash, "0".repeat(64));
  assert.equal(entries[0].prev_hash, entries[1].hash);
});

test("verify() detects a tampered entry", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);
  store.record({ action: "create", path: "a.txt" });
  store.record({ action: "edit", path: "a.txt" });

  assert.equal(store.verify().ok, true);

  const logPath = path.join(repoRoot, ".cortex", "audit", "audit.jsonl");
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[0]);
  tampered.path = "b.txt"; // mutate without recomputing hash
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

  const fresh = new AuditStore(repoRoot);
  const result = fresh.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAtSeq, 0);
});

test("recordChanges() writes one entry per change with shared meta", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);
  store.recordChanges(
    [
      { action: "create", path: "a.txt" },
      { action: "delete", path: "b.txt" },
    ],
    { provider: "claude", model: "claude:sonnet", chatId: "c9" },
  );
  const entries = store.list();
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.provider === "claude" && e.chat_id === "c9"));
});

test("list() filters by action and provider", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);
  store.record({ action: "run_command", command: "npm test", provider: "groq" });
  store.record({ action: "edit", path: "a.txt", provider: "codex" });

  assert.equal(store.list({ action: "edit" }).length, 1);
  assert.equal(store.list({ provider: "groq" }).length, 1);
  assert.equal(store.list({ action: "delete" }).length, 0);
});

test("rotation resets the chain but keeps the archive readable", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);
  store.record({ action: "create", path: "a.txt" });

  // Force rotation on next record by shrinking MAX_BYTES via a huge existing file.
  const logPath = path.join(repoRoot, ".cortex", "audit", "audit.jsonl");
  fs.appendFileSync(logPath, "x".repeat(11 * 1024 * 1024));

  store.record({ action: "edit", path: "a.txt" });

  assert.ok(fs.existsSync(`${logPath}.1`));
  const fresh = new AuditStore(repoRoot);
  assert.equal(fresh.verify().ok, true);
});
