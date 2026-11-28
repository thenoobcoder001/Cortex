const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ActivityLog,
  codexItemResult,
  describeAgyTool,
  describeApiTool,
  describeClaudeTool,
  describeCodexItem,
  unwrapShell,
} = require("../activity");
const { DesktopSessionService } = require("../sessionService");

const ROOT = path.resolve(os.tmpdir(), "repo");

test("unwrapShell shows the command inside PowerShell, bash and cmd wrappers", () => {
  assert.equal(unwrapShell(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-Content math.js'`), "Get-Content math.js");
  assert.equal(unwrapShell(`pwsh -NoProfile -Command "npm test"`), "npm test");
  // As Codex reports it on Windows: escaped inside the double quotes.
  assert.equal(
    unwrapShell(String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "node -e \"console.log(1)\"; Get-Content -LiteralPath .\\math.js"`),
    String.raw`node -e "console.log(1)"; Get-Content -LiteralPath .\math.js`,
  );
  assert.equal(unwrapShell(`/bin/bash -lc 'ls -la'`), "ls -la");
  assert.equal(unwrapShell(`cmd.exe /c dir`), "dir");
  assert.equal(unwrapShell("git status"), "git status");
});

test("Codex items: parsed reads, lists and searches read as such; other commands as commands", () => {
  const read = describeCodexItem({
    type: "commandExecution", id: "1", command: "powershell.exe -Command 'Get-Content math.js'",
    commandActions: [{ type: "read", command: "Get-Content math.js", name: "math.js", path: path.join(ROOT, "math.js") }],
  }, ROOT);
  assert.deepEqual([read.kind, read.label], ["read", "Read math.js"]);
  assert.ok(read.command, "a read that ran as a command is still a command for the audit");

  const search = describeCodexItem({
    type: "commandExecution", id: "2", command: "rg average",
    commandActions: [{ type: "search", command: "rg average", query: "average", path: path.join(ROOT, "src") }],
  }, ROOT);
  assert.equal(search.label, 'Searched for "average" in src');

  const mixed = describeCodexItem({
    type: "commandExecution", id: "3", command: `/bin/bash -lc 'cat a && npm test'`,
    commandActions: [{ type: "read", command: "cat a", name: "a", path: "a" }, { type: "unknown", command: "npm test" }],
  }, ROOT);
  assert.deepEqual([mixed.kind, mixed.label], ["command", "cat a && npm test"]);

  const edit = describeCodexItem({
    type: "fileChange", id: "4",
    changes: [{ path: path.join(ROOT, "a.js"), kind: { type: "update", move_path: null } }, { path: path.join(ROOT, "README.md"), kind: { type: "update" } }],
  }, ROOT);
  assert.deepEqual([edit.kind, edit.label], ["edit", "Edited a.js, README.md"]);
  assert.equal(describeCodexItem({ type: "fileChange", id: "5", changes: [{ path: "new.js", kind: { type: "add" } }] }).label, "Created new.js");

  assert.equal(describeCodexItem({ type: "agentMessage", id: "6", text: "hi" }), null);
  assert.equal(describeCodexItem({ type: "reasoning", id: "7" }), null);
  assert.equal(describeCodexItem({ type: "mcpToolCall", id: "8", server: "github", tool: "list_prs" }).label, "github · list_prs");
});

test("Codex results: exit code and status decide ok", () => {
  assert.deepEqual(codexItemResult({ status: "completed", exitCode: 0, durationMs: 12 }), { ok: true, status: "completed", exitCode: 0, durationMs: 12 });
  assert.equal(codexItemResult({ status: "completed", exitCode: 2 }).ok, false);
  assert.equal(codexItemResult({ status: "declined", exitCode: null }).ok, false);
  assert.equal(codexItemResult({ status: "completed" }).ok, true, "file changes have no exit code");
});

test("Claude, Antigravity and API tools map to the same kinds", () => {
  assert.deepEqual(describeClaudeTool("Bash", { command: "npm test" }), { kind: "command", label: "npm test", command: "npm test" });
  assert.equal(describeClaudeTool("Bash", { command: "npm test", description: "Run tests" }).label, "Run tests: npm test");
  assert.equal(describeClaudeTool("Read", { file_path: path.join(ROOT, "src", "a.js") }, ROOT).label, "Read src/a.js");
  assert.equal(describeClaudeTool("Edit", { file_path: path.join(ROOT, "a.js") }, ROOT).kind, "edit");
  assert.equal(describeClaudeTool("Grep", { pattern: "TODO" }).label, 'Searched for "TODO"');
  assert.equal(describeClaudeTool("mcp__cortex__approve", {}).label, "cortex · approve");
  assert.equal(describeClaudeTool("Read", { file_path: path.join(os.tmpdir(), "elsewhere", "x.txt") }, ROOT).label.includes("elsewhere"), true, "outside the repo keeps the full path");

  assert.deepEqual(describeAgyTool("run_command", { CommandLine: "git status --short" }), { kind: "command", label: "git status --short", command: "git status --short" });
  assert.equal(describeAgyTool("write_file", { Path: path.join(ROOT, "d.txt") }, ROOT).label, "Edited d.txt");
  assert.equal(describeAgyTool("read_file", { Path: "b.txt" }).kind, "read");

  assert.equal(describeApiTool("run_terminal_command", { command: "ls" }).kind, "command");
  assert.equal(describeApiTool("list_files", { directory: "src" }).label, "Listed src");
  assert.equal(describeApiTool("rename_file", { old_path: "a", new_path: "b" }).label, "Renamed a to b");
});

test("ActivityLog keeps steps in order, ignores repeats and unknown results", () => {
  let clock = 1000;
  const log = new ActivityLog({ now: () => clock });
  log.start({ id: "a", kind: "command", label: "npm test", command: "npm test" });
  log.start({ id: "a", kind: "command", label: "again" });
  clock = 1500;
  assert.equal(log.finish({ id: "a", ok: false, exitCode: 1 }).status, "failed");
  assert.equal(log.finish({ id: "nope" }), null);
  log.start({ id: "b", kind: "weird", label: "x" });
  log.finish({ id: "b", status: "declined", ok: false });
  clock = 3000;
  const saved = log.end().toJSON();
  assert.equal(saved.durationMs, 2000);
  assert.deepEqual(saved.steps.map((s) => [s.id, s.kind, s.status]), [["a", "command", "failed"], ["b", "tool", "declined"]]);
  assert.equal(saved.steps[0].exitCode, 1);
  assert.equal(saved.steps[0].durationMs, 500);
  assert.equal(saved.steps[0].startedAt, undefined);
});

// ------------------------------------------------- whole turn, fake CLI ---

class MemoryConfig {
  constructor(repoRoot) {
    Object.assign(this, {
      repoRoot, path: "", activeChatId: "", model: "codex:gpt-5.4", modelExplicit: true,
      apiKey: "x", geminiApiKey: "", openaiApiKey: "", promptPreset: "code",
      toolSafetyMode: "write", permissionMode: "full-access", assistantMemory: "", contextCarryMessages: 5,
      geminiSessionId: "", codexSessionId: "", activeRuns: [], interruptedRuns: [], recentRepoRoots: [repoRoot],
    });
  }

  save() {}
  reset() {}
  deleteFile() {}
}

// Reports the steps a real CLI would, then replies.
class StepsCli {
  constructor(steps) {
    this.steps = steps;
    this.available = true;
    this.connected = true;
    this.sessionId = "";
    this.sessionMode = "fresh";
    this.calls = [];
  }

  setRepoRoot() {}
  setApiKey() {}

  async chatCompletionStreamRaw(messages, _model, options) {
    this.calls.push(messages);
    for (const [type, payload] of this.steps) options.onEvent?.(type, payload);
    this.sessionId = "s1";
    return "done";
  }
}

test("a Full access turn: every command that ran is audited and linked from the saved activity log", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-activity-"));
  const codex = new StepsCli([
    ["tool_call", { id: "c1", kind: "command", label: "npm test", command: "npm test" }],
    ["tool_result", { id: "c1", ok: true, status: "completed", exitCode: 0, durationMs: 40 }],
    ["tool_call", { id: "c2", kind: "command", label: "git push origin HEAD", command: "git push origin HEAD" }],
    ["tool_result", { id: "c2", ok: false, status: "failed", exitCode: 128 }],
    ["tool_call", { id: "c3", kind: "command", label: "rm -rf build", command: "rm -rf build" }],
    ["tool_result", { id: "c3", ok: false, status: "declined" }],
    ["tool_call", { id: "e1", kind: "edit", label: "Edited math.js" }],
    ["tool_result", { id: "e1", ok: true, status: "completed" }],
    ["tool_call", { id: "c4", kind: "command", label: "npm run dev", command: "npm run dev" }],
  ]);
  const idle = new StepsCli([]);
  const service = new DesktopSessionService({
    config: new MemoryConfig(repoRoot),
    repoRoot,
    codexProvider: codex,
    claudeProvider: idle,
    agyProvider: idle,
    hermesProvider: idle,
    groqProvider: idle,
    geminiProvider: idle,
  });

  const events = await Array.fromAsync(service.sendMessageEvents("run the tests", { repoRoot, model: "codex:gpt-6-luna", permissionMode: "full-access" }));
  const chatId = events.find((event) => event.chatId)?.chatId;

  const commands = service.auditStore.list({ action: "run_command" }).reverse();
  assert.deepEqual(commands.map((e) => [e.command, e.exit_code, e.success]), [
    ["npm test", 0, true],
    ["git push origin HEAD", 128, false],
    ["npm run dev", null, true],
  ], "declined command not logged as run; unfinished one logged");
  assert.match(commands[2].detail, /outcome not reported/);
  assert.equal(commands[0].provider, "Codex");
  assert.equal(commands[0].chat_id, chatId);

  const results = events.filter((event) => event.type === "tool_result");
  assert.equal(results[0].auditSeq, commands[0].seq);
  assert.equal(results[0].label, "npm test");
  assert.equal(results[2].auditSeq, null);

  const reply = service.chatStore.loadChat(chatId).messages.at(-1);
  assert.deepEqual(reply.activity.steps.map((s) => [s.label, s.status, s.auditSeq ?? null]), [
    ["npm test", "done", commands[0].seq],
    ["git push origin HEAD", "failed", commands[1].seq],
    ["rm -rf build", "declined", null],
    ["Edited math.js", "done", null],
    ["npm run dev", "unknown", commands[2].seq],
  ]);
  assert.equal(typeof reply.activity.durationMs, "number");

  // The next turn must not hand the log to the provider.
  await Array.fromAsync(service.sendMessageEvents("again", { chatId, repoRoot, model: "codex:gpt-6-luna" }));
  const handed = codex.calls[1];
  assert.ok(handed.every((message) => message.activity === undefined));
});

test("a turn without steps saves no activity field", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-activity-"));
  const quiet = new StepsCli([]);
  const service = new DesktopSessionService({
    config: new MemoryConfig(repoRoot),
    repoRoot,
    codexProvider: quiet,
    claudeProvider: quiet,
    agyProvider: quiet,
    hermesProvider: quiet,
    groqProvider: quiet,
    geminiProvider: quiet,
  });
  const events = await Array.fromAsync(service.sendMessageEvents("hi", { repoRoot, model: "codex:gpt-6-luna" }));
  const chatId = events.find((event) => event.chatId)?.chatId;
  assert.equal(service.chatStore.loadChat(chatId).messages.at(-1).activity, undefined);
  assert.equal(service.auditStore.list({ action: "run_command" }).reverse().length, 0);
});
