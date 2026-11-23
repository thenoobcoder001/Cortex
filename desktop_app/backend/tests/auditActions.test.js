const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The label mapping lives in the web app (an ES module); load it from there.
const modulePath = path.join(__dirname, "..", "..", "web", "src", "app", "auditActions.js");
const load = () => import(pathToFileURL(modulePath).href);

// Every literal `action: "..."` the backend can hand to the audit store.
function backendAuditActions() {
  const backendDir = path.join(__dirname, "..");
  const found = new Set();
  for (const name of fs.readdirSync(backendDir)) {
    if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
    const text = fs.readFileSync(path.join(backendDir, name), "utf8");
    for (const match of text.matchAll(/\baction:\s*"([a-z_]+)"/g)) found.add(match[1]);
  }
  // Blocked tool calls use the TOOL_AUDIT_ACTIONS map in toolExecutor.js.
  const executor = fs.readFileSync(path.join(backendDir, "toolExecutor.js"), "utf8");
  const map = executor.match(/TOOL_AUDIT_ACTIONS = \{([^}]*)\}/);
  for (const match of (map?.[1] || "").matchAll(/:\s*"([a-z_]+)"/g)) found.add(match[1]);
  return [...found];
}

test("every backend audit action has a label, icon and filter", async () => {
  const { auditActionInfo } = await load();
  const actions = backendAuditActions();
  assert.ok(actions.includes("run_command") && actions.includes("write"), `scan found ${actions}`);
  for (const action of actions) {
    const info = auditActionInfo(action);
    assert.ok(info, `no audit label for "${action}"`);
    assert.ok(info.label && info.attempt && info.filter && info.icon, `incomplete entry for "${action}"`);
  }
});

test("blocked, failed and incomplete entries are told apart", async () => {
  const { auditEntryStatus } = await load();
  assert.equal(auditEntryStatus({ action: "edit", success: true }), "ok");
  assert.equal(auditEntryStatus({ action: "edit" }), "ok");
  assert.equal(auditEntryStatus({ action: "write", success: false, detail: "blocked: read-only mode (write_file)" }), "blocked");
  assert.equal(auditEntryStatus({ action: "read", success: false, detail: "rejected: Path rejected: outside repo root." }), "blocked");
  assert.equal(auditEntryStatus({ action: "run_command", success: false, detail: "blocked by safety policy" }), "blocked");
  assert.equal(auditEntryStatus({ action: "run_command", success: false, exit_code: 2 }), "failed");
  assert.equal(auditEntryStatus({ action: "audit_incomplete", success: false, detail: "Repo scan stopped" }), "incomplete");
});

test("labels read as attempts when the action did not happen", async () => {
  const { auditEntryLabel } = await load();
  assert.equal(auditEntryLabel({ action: "edit", success: true }), "Edited file");
  assert.equal(auditEntryLabel({ action: "edit", success: false, detail: "blocked: read-only mode (edit_file)" }), "Edit file");
  assert.equal(auditEntryLabel({ action: "some_new_thing" }), "Some new thing");
  assert.equal(auditEntryLabel({}), "Agent action");
});

test("middleTruncate keeps the start and the file name", async () => {
  const { middleTruncate } = await load();
  assert.equal(middleTruncate("src/a.js", 20), "src/a.js");
  const long = `C:/Users/someone/projects/${"deep/".repeat(20)}component.test.jsx`;
  const short = middleTruncate(long, 40);
  assert.equal(short.length, 40);
  assert.ok(short.startsWith("C:/Users/"));
  assert.ok(short.endsWith("component.test.jsx"));
  assert.ok(short.includes("…"));
  assert.equal(middleTruncate(null, 10), "");
});
