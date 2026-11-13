"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ToolExecutor } = require("../toolExecutor");
const { RepoFileService } = require("../fileService");
const { AuditStore } = require("../auditStore");

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-audit-exec-"));
}

function executorWithStore(repoRoot) {
  const executor = new ToolExecutor(new RepoFileService(repoRoot), repoRoot);
  const store = new AuditStore(repoRoot);
  executor.onAudit = (entry) => store.record(entry);
  executor.auditMeta = { provider: "Groq", model: "openai/gpt-oss-120b", chatId: "c1" };
  return { executor, store };
}

test("read-only mode audits every blocked mutating tool call", async () => {
  const repoRoot = tempRepo();
  const { executor, store } = executorWithStore(repoRoot);
  executor.readOnly = true;

  const calls = [
    ["write_file", { path: "a.txt", content: "x" }],
    ["edit_file", { path: "a.txt", old_str: "x", new_str: "y" }],
    ["delete_path", { path: "a.txt" }],
    ["rename_file", { old_path: "a.txt", new_path: "b.txt" }],
    ["create_directory", { path: "dir" }],
    ["run_terminal_command", { command: "npm test" }],
  ];
  for (const [name, args] of calls) {
    const [result, change] = await executor.executeWithMetadata(name, args);
    assert.match(result, /read-only/);
    assert.equal(change, null);
  }

  assert.equal(fs.existsSync(path.join(repoRoot, "a.txt")), false);
  const entries = store.list().reverse();
  assert.equal(entries.length, calls.length);
  assert.deepEqual(
    entries.map((e) => e.action),
    ["write", "edit", "delete", "rename", "create_directory", "run_command"],
  );
  assert.ok(entries.every((e) => e.success === false && /read-only/.test(e.detail)));
  assert.ok(entries.every((e) => e.provider === "Groq" && e.chat_id === "c1"));
  assert.equal(entries[0].path, "a.txt");
  assert.equal(entries[3].old_path, "a.txt");
  assert.equal(entries[3].new_path, "b.txt");
  assert.equal(entries[5].command, "npm test");
  assert.equal(store.verify().ok, true);
});

test("read-only mode does not audit read-only tools", async () => {
  const repoRoot = tempRepo();
  fs.writeFileSync(path.join(repoRoot, "a.txt"), "hi", "utf8");
  const { executor, store } = executorWithStore(repoRoot);
  executor.readOnly = true;

  await executor.executeWithMetadata("read_file", { path: "a.txt" });
  await executor.executeWithMetadata("list_files", {});
  assert.equal(store.list().length, 0);
});
