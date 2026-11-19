const test = require("node:test");
const assert = require("node:assert/strict");
const { ApprovalRegistry } = require("../approvalRegistry");

function makeRegistry(options = {}) {
  const audit = [];
  const registry = new ApprovalRegistry({ onAudit: (entry, repoRoot) => audit.push({ ...entry, repoRoot }), ...options });
  return { registry, audit };
}

test("request emits an event, respond settles the promise and audits both", async () => {
  const { registry, audit } = makeRegistry();
  const events = [];
  registry.subscribe("chat-1", (event) => events.push(event));

  const { approval, promise } = registry.request("chat-1", {
    kind: "command",
    command: "npm test",
    provider: "Codex",
    model: "codex:gpt-5.4",
    repoRoot: "/repo",
  });
  assert.equal(events[0].type, "approval_request");
  assert.equal(events[0].approval.id, approval.id);
  assert.deepEqual(registry.pending("chat-1").map((a) => a.id), [approval.id]);
  assert.deepEqual(registry.waitingChatIds(), ["chat-1"]);

  registry.respond(approval.id, { decision: "approve", by: "desktop" });
  const result = await promise;
  assert.equal(result.decision, "approve");
  assert.equal(result.by, "desktop");
  assert.equal(registry.pending().length, 0);
  assert.equal(events[1].type, "approval_resolved");

  assert.deepEqual(audit.map((e) => e.action), ["approval_requested", "approved"]);
  assert.equal(audit[0].command, "npm test");
  assert.equal(audit[0].repoRoot, "/repo");
  assert.equal(audit[1].source, "user");
  assert.match(audit[1].detail, /by desktop/);
  assert.match(audit[1].detail, new RegExp(approval.id));
});

test("decline, unknown ids and wrong chats", async () => {
  const { registry, audit } = makeRegistry();
  const { approval, promise } = registry.request("chat-1", { kind: "file_change", path: "a.txt" });
  assert.throws(() => registry.respond("nope", { decision: "approve" }), /not found/);
  assert.throws(() => registry.respond(approval.id, { decision: "maybe" }), /approve or decline/);
  assert.throws(() => registry.respond(approval.id, { decision: "approve", chatId: "other" }), /different chat/);
  registry.respond(approval.id, { decision: "decline", by: "relay:phone-1" });
  assert.equal((await promise).decision, "decline");
  assert.throws(() => registry.respond(approval.id, { decision: "approve" }), /already answered/);
  assert.equal(audit.at(-1).action, "declined");
  assert.match(audit.at(-1).detail, /relay:phone-1/);
});

test("timeouts decline", async () => {
  const { registry, audit } = makeRegistry({ timeoutMs: 20 });
  const { promise } = registry.request("chat-1", { kind: "command", command: "ls" });
  const result = await promise;
  assert.equal(result.decision, "decline");
  assert.equal(result.by, "timeout");
  assert.equal(audit.at(-1).action, "declined");
  assert.equal(audit.at(-1).source, "cortex");
  assert.equal(registry.pending().length, 0);
});

test("cancelChat declines only that chat's requests", async () => {
  const { registry } = makeRegistry();
  const a = registry.request("chat-1", { kind: "command", command: "a" });
  const b = registry.request("chat-1", { kind: "command", command: "b" });
  const c = registry.request("chat-2", { kind: "command", command: "c" });
  assert.equal(registry.cancelChat("chat-1", "interrupted"), 2);
  assert.equal((await a.promise).by, "interrupted");
  assert.equal((await b.promise).decision, "decline");
  assert.deepEqual(registry.pending().map((x) => x.id), [c.approval.id]);
  registry.cancelChat("chat-2");
});

test("always allow skips the prompt for the same command in the same chat only", async () => {
  const { registry, audit } = makeRegistry();
  const first = registry.request("chat-1", { kind: "command", command: "npm test" });
  assert.equal(first.approval.canAlwaysAllow, true);
  registry.respond(first.approval.id, { decision: "approve", alwaysAllow: true });
  await first.promise;

  const events = [];
  registry.subscribe("chat-1", (event) => events.push(event));
  const second = registry.request("chat-1", { kind: "command", command: "npm test" });
  assert.equal((await second.promise).decision, "approve");
  assert.equal(events.length, 0, "no card for an always-allowed command");
  assert.equal(audit.at(-1).action, "approved");
  assert.match(audit.at(-1).detail, /always-allow/);

  const otherCommand = registry.request("chat-1", { kind: "command", command: "npm publish" });
  assert.equal(registry.pending().length, 1);
  const otherChat = registry.request("chat-2", { kind: "command", command: "npm test" });
  assert.equal(registry.pending().length, 2);
  registry.cancelChat("chat-1");
  registry.cancelChat("chat-2");
  await Promise.all([otherCommand.promise, otherChat.promise]);

  // File changes never get an always-allow rule.
  const file = registry.request("chat-1", { kind: "file_change", path: "x" });
  assert.equal(file.approval.canAlwaysAllow, false);
  registry.respond(file.approval.id, { decision: "approve", alwaysAllow: true });
  await file.promise;
  assert.equal(registry.isAlwaysAllowed("chat-1", ""), false);
});
