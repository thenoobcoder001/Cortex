const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DesktopSessionService } = require("../sessionService");
const { startBackendServer } = require("../server");

class MemoryConfig {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.path = "";
    this.activeChatId = "";
    this.model = "claude:sonnet";
    this.modelExplicit = true;
    this.promptPreset = "code";
    this.toolSafetyMode = "write";
    this.assistantMemory = "";
    this.contextCarryMessages = 5;
    this.activeRuns = [];
    this.interruptedRuns = [];
    this.recentRepoRoots = [];
  }

  save() {}
}

// A CLI provider whose "agent" runs `edit(repoRoot)` mid-turn, the way
// Claude/Codex CLIs edit files internally.
class EditingCliProvider {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.available = true;
    this.connected = true;
    this.sessionId = "";
    this.sessionMode = "fresh";
    this.edit = () => {};
    this.lastMessages = null;
  }

  setRepoRoot() {}
  setApiKey() {}

  async chatCompletionStreamRaw(messages) {
    this.lastMessages = messages;
    this.edit(this.repoRoot);
    return "done";
  }

  async chatCompletion(messages) {
    return this.chatCompletionStreamRaw(messages);
  }
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-turns-"));
  fs.writeFileSync(path.join(root, "app.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");
  fs.writeFileSync(path.join(root, "old.txt"), "remove me\n", "utf8");
  return root;
}

function makeService(repoRoot) {
  const claude = new EditingCliProvider(repoRoot);
  const service = new DesktopSessionService({
    config: new MemoryConfig(repoRoot),
    repoRoot,
    claudeProvider: claude,
    codexProvider: new EditingCliProvider(repoRoot),
    geminiCliProvider: new EditingCliProvider(repoRoot),
  });
  return { service, claude };
}

async function runTurn(service, message, chatId = null) {
  let completed = null;
  for await (const event of service.sendMessageEvents(message, { model: "claude:sonnet", repoRoot: service.repoRoot, chatId })) {
    if (event.type === "completed") completed = event;
  }
  assert.ok(completed, "turn should complete");
  return completed;
}

function lastAssistant(service, chatId) {
  const payload = service.chatStore.loadChat(chatId);
  return payload.messages.filter((m) => m.role === "assistant").at(-1);
}

const standardEdit = (root) => {
  fs.writeFileSync(path.join(root, "app.js"), "const a = 1;\nconst b = 20;\nconst c = 3;\n", "utf8");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "new.js"), "export {};\n", "utf8");
  fs.rmSync(path.join(root, "old.txt"));
};

test("a turn that changes files stores a summary on the message and a full record in .cortex/chats", async () => {
  const repoRoot = makeRepo();
  const { service, claude } = makeService(repoRoot);
  claude.edit = standardEdit;
  const { chatId } = await runTurn(service, "edit things");

  const message = lastAssistant(service, chatId);
  assert.deepEqual(
    { ...message.turnChanges, id: "x" },
    { id: "x", files: 3, additions: 2, deletions: 2, reverted: "none" },
  );
  const turnDir = path.join(repoRoot, ".cortex", "chats", "turns", chatId);
  assert.ok(fs.existsSync(path.join(turnDir, `${message.turnChanges.id}.json`)));

  const view = service.getTurnDiff({ chatId, turnId: message.turnChanges.id });
  const byPath = Object.fromEntries(view.files.map((f) => [f.path, f]));
  assert.equal(byPath["app.js"].action, "modified");
  assert.match(byPath["app.js"].diff, /-const b = 2;\n\+const b = 20;/);
  assert.equal(byPath["src/new.js"].action, "added");
  assert.equal(byPath["old.txt"].action, "deleted");
  assert.ok(view.files.every((f) => f.revertable));
  assert.ok(!JSON.stringify(view).includes("restoreText"), "restore copies stay on disk");

  // Status polls carry the summary only, never the diff text.
  const snapshot = service.snapshot({ includeChanges: false });
  const polled = snapshot.messages.filter((m) => m.role === "assistant").at(-1);
  assert.equal(polled.turnChanges.files, 3);
  assert.ok(!JSON.stringify(snapshot.messages).includes("const b = 20"));
});

test("turn metadata is not sent to the provider on the next turn", async () => {
  const repoRoot = makeRepo();
  const { service, claude } = makeService(repoRoot);
  claude.edit = standardEdit;
  const { chatId } = await runTurn(service, "first");
  claude.edit = () => {};
  await runTurn(service, "second", chatId);
  assert.ok(claude.lastMessages.length > 1);
  assert.ok(claude.lastMessages.every((m) => !("turnChanges" in m)));
});

test("a turn that changes nothing gets no summary and no record", async () => {
  const repoRoot = makeRepo();
  const { service } = makeService(repoRoot);
  const { chatId } = await runTurn(service, "just talk");
  assert.equal(lastAssistant(service, chatId).turnChanges, undefined);
  assert.ok(!fs.existsSync(path.join(repoRoot, ".cortex", "chats", "turns", chatId)));
});

test("revert restores every file to its pre-turn state and audits each one", async () => {
  const repoRoot = makeRepo();
  const { service, claude } = makeService(repoRoot);
  claude.edit = standardEdit;
  const { chatId } = await runTurn(service, "edit things");
  const turnId = lastAssistant(service, chatId).turnChanges.id;

  const result = service.revertTurn({ chatId, turnId });
  assert.deepEqual(result.reverted.sort(), ["app.js", "old.txt", "src/new.js"]);
  assert.equal(fs.readFileSync(path.join(repoRoot, "app.js"), "utf8"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  assert.equal(fs.readFileSync(path.join(repoRoot, "old.txt"), "utf8"), "remove me\n");
  assert.ok(!fs.existsSync(path.join(repoRoot, "src", "new.js")));
  assert.equal(lastAssistant(service, chatId).turnChanges.reverted, "all");
  assert.equal(result.turn.files.every((f) => f.status === "reverted"), true);

  const { entries, chain } = service.listAuditEntries(repoRoot, { action: "revert" });
  assert.equal(chain.ok, true);
  assert.deepEqual(entries.map((e) => e.path).sort(), ["app.js", "old.txt", "src/new.js"]);
  assert.ok(entries.every((e) => e.source === "cortex" && e.chat_id === chatId && e.success));

  assert.throws(() => service.revertTurn({ chatId, turnId }), /already reverted/);
});

test("revert refuses, writing nothing, when a file changed again after the turn", async () => {
  const repoRoot = makeRepo();
  const { service, claude } = makeService(repoRoot);
  claude.edit = standardEdit;
  const { chatId } = await runTurn(service, "edit things");
  const turnId = lastAssistant(service, chatId).turnChanges.id;

  // The user (or a later turn) edits app.js again.
  fs.writeFileSync(path.join(repoRoot, "app.js"), "user edit\n", "utf8");

  const view = service.getTurnDiff({ chatId, turnId });
  const app = view.files.find((f) => f.path === "app.js");
  assert.equal(app.revertable, false);
  assert.match(app.blockedReason, /changed again after this turn/);

  assert.throws(
    () => service.revertTurn({ chatId, turnId }),
    (error) => error.name === "RevertConflictError" && /Nothing was reverted/.test(error.message) && /app\.js/.test(error.message),
  );
  // All-or-nothing: the other files were not touched either.
  assert.equal(fs.readFileSync(path.join(repoRoot, "app.js"), "utf8"), "user edit\n");
  assert.ok(fs.existsSync(path.join(repoRoot, "src", "new.js")));
  assert.ok(!fs.existsSync(path.join(repoRoot, "old.txt")));

  const refused = service.listAuditEntries(repoRoot, { action: "revert_refused" }).entries;
  assert.equal(refused.length, 1);
  assert.equal(refused[0].success, false);

  // A single untouched file can still be reverted on its own.
  const single = service.revertTurn({ chatId, turnId, path: "src/new.js" });
  assert.deepEqual(single.reverted, ["src/new.js"]);
  assert.ok(!fs.existsSync(path.join(repoRoot, "src", "new.js")));
  assert.equal(lastAssistant(service, chatId).turnChanges.reverted, "partial");
});

test("revert refuses when a deleted file was created again", async () => {
  const repoRoot = makeRepo();
  const { service, claude } = makeService(repoRoot);
  claude.edit = (root) => fs.rmSync(path.join(root, "old.txt"));
  const { chatId } = await runTurn(service, "delete");
  const turnId = lastAssistant(service, chatId).turnChanges.id;
  fs.writeFileSync(path.join(repoRoot, "old.txt"), "brand new\n", "utf8");
  assert.throws(() => service.revertTurn({ chatId, turnId }), /created again/);
  assert.equal(fs.readFileSync(path.join(repoRoot, "old.txt"), "utf8"), "brand new\n");
});

test("binary and non-UTF-8 files are flagged and cannot be reverted", async () => {
  const repoRoot = makeRepo();
  fs.writeFileSync(path.join(repoRoot, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  fs.writeFileSync(path.join(repoRoot, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  const { service, claude } = makeService(repoRoot);
  claude.edit = (root) => {
    fs.writeFileSync(path.join(root, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x02, 0x03]));
    fs.writeFileSync(path.join(root, "latin1.txt"), "cafe\n", "utf8");
  };
  const { chatId } = await runTurn(service, "touch binaries");
  const turnId = lastAssistant(service, chatId).turnChanges.id;
  const view = service.getTurnDiff({ chatId, turnId });
  const logo = view.files.find((f) => f.path === "logo.bin");
  assert.equal(logo.binary, true);
  assert.equal(logo.revertable, false);
  assert.match(logo.blockedReason, /Binary/);
  assert.match(view.files.find((f) => f.path === "latin1.txt").blockedReason, /not UTF-8/);
  assert.throws(() => service.revertTurn({ chatId, turnId }), /Nothing was reverted/);
});

test("deleting a chat removes its turn records", async () => {
  const repoRoot = makeRepo();
  const { service, claude } = makeService(repoRoot);
  claude.edit = standardEdit;
  const { chatId } = await runTurn(service, "edit things");
  const dir = path.join(repoRoot, ".cortex", "chats", "turns", chatId);
  assert.ok(fs.existsSync(dir));
  service.deleteChat(chatId);
  assert.ok(!fs.existsSync(dir));
});

test("turn ids are validated so they cannot escape the turns folder", () => {
  const repoRoot = makeRepo();
  const { service } = makeService(repoRoot);
  assert.throws(() => service.getTurnDiff({ chatId: "..", turnId: "x" }), /Invalid chat id/);
  assert.throws(() => service.getTurnDiff({ chatId: "abc", turnId: "../../etc" }), /Invalid turn id/);
});

test("routes: diff loads on demand, revert works, and a refusal is a 409 with the reason", async () => {
  const repoRoot = makeRepo();
  const { service, claude } = makeService(repoRoot);
  claude.edit = standardEdit;
  const { chatId } = await runTurn(service, "edit things");
  const turnId = lastAssistant(service, chatId).turnChanges.id;
  const backend = await startBackendServer({ host: "127.0.0.1", port: 0, service });
  try {
    const query = new URLSearchParams({ chatId, turnId, repoRoot }).toString();
    const diffResponse = await fetch(`${backend.url}/api/turns/diff?${query}`);
    assert.equal(diffResponse.status, 200);
    const diff = await diffResponse.json();
    assert.equal(diff.files.length, 3);
    assert.match(diff.files.find((f) => f.path === "app.js").diff, /\+const b = 20;/);

    const status = await (await fetch(`${backend.url}/api/status`)).json();
    assert.ok(!JSON.stringify(status).includes("+const b = 20;"), "/api/status never carries turn diffs");

    fs.writeFileSync(path.join(repoRoot, "app.js"), "changed later\n", "utf8");
    const post = (payload) => fetch(`${backend.url}/api/turns/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const refused = await post({ chatId, turnId, repoRoot });
    assert.equal(refused.status, 409);
    const refusedBody = await refused.json();
    assert.match(refusedBody.detail, /app\.js \(it was changed again after this turn\)/);
    assert.equal(refusedBody.conflicts[0].path, "app.js");

    const okResponse = await post({ chatId, turnId, repoRoot, path: "old.txt" });
    assert.equal(okResponse.status, 200);
    const ok = await okResponse.json();
    assert.deepEqual(ok.reverted, ["old.txt"]);
    assert.equal(ok.snapshot.messages.at(-1).turnChanges.reverted, "partial");
    assert.equal(fs.readFileSync(path.join(repoRoot, "old.txt"), "utf8"), "remove me\n");

    const missing = await fetch(`${backend.url}/api/turns/diff?${new URLSearchParams({ chatId, turnId: "turn-nope", repoRoot })}`);
    assert.equal(missing.status, 400);
  } finally {
    await backend.close();
  }
});
