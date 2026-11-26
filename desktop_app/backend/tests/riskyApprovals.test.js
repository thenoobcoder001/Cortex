const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DesktopSessionService } = require("../sessionService");
const { startBackendServer } = require("../server");
const { ClaudeCliProvider } = require("../providers");
const { writeClaudeMcpConfig } = require("../approvalBridge");
const { ApprovalRegistry } = require("../approvalRegistry");
const { riskyGate, declineMessage, assessCommand } = require("../riskyCommands");
const { LEGACY_DENY_RULES, ensureClaudeSettings, migrateLegacySettings } = require("../claudeSettings");
const mcpServer = require("../approvalMcpServer");

const API_MODEL = "openai/gpt-oss-20b";

class MemoryConfig {
  constructor(repoRoot) {
    Object.assign(this, {
      repoRoot, path: "", activeChatId: "", model: API_MODEL, modelExplicit: true,
      apiKey: "x", geminiApiKey: "", openaiApiKey: "", promptPreset: "code",
      toolSafetyMode: "write", permissionMode: "", assistantMemory: "", contextCarryMessages: 5,
      geminiSessionId: "", codexSessionId: "", activeRuns: [], interruptedRuns: [], recentRepoRoots: [repoRoot],
    });
  }

  save() {}
  reset() {}
  deleteFile() {}
}

// An API provider that runs one terminal command, then reports what it got.
class CommandProvider {
  constructor(command) {
    this.available = true;
    this.connected = true;
    this.command = command;
    this.calls = 0;
  }

  setApiKey() {}

  async chatCompletion() {
    return "done";
  }

  async chatWithTools(messages) {
    this.calls += 1;
    if (this.calls === 1) {
      const call = { id: "call_1", type: "function", function: { name: "run_terminal_command", arguments: JSON.stringify({ command: this.command }) } };
      return [null, { role: "assistant", content: "", tool_calls: [call] }, [call]];
    }
    const lastTool = [...messages].reverse().find((message) => message.role === "tool");
    return [`finished: ${String(lastTool?.content || "")}`, null, null];
  }
}

// A CLI provider standing in for Codex: asks Cortex about each summary.
class AskingCli {
  constructor(summaries) {
    this.available = true;
    this.connected = true;
    this.sessionId = "";
    this.sessionMode = "fresh";
    this.summaries = summaries;
    this.answers = [];
  }

  setRepoRoot() {}
  setApiKey() {}

  async chatCompletionStreamRaw(_messages, _model, { askApproval }) {
    for (const summary of this.summaries) {
      this.answers.push(await askApproval(summary));
    }
    return "codex done";
  }
}

class IdleCli {
  constructor() {
    this.available = true;
    this.connected = true;
    this.sessionId = "";
    this.sessionMode = "fresh";
  }

  setRepoRoot() {}
  setApiKey() {}
}

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-risky-"));
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n", "utf8");
  return root;
}

function createService(repoRoot, provider, overrides = {}) {
  return new DesktopSessionService({
    config: new MemoryConfig(repoRoot),
    repoRoot,
    codexProvider: new IdleCli(),
    geminiCliProvider: new IdleCli(),
    claudeProvider: new IdleCli(),
    hermesProvider: new IdleCli(),
    groqProvider: provider,
    geminiProvider: provider,
    ...overrides,
  });
}

function auditActions(service) {
  return service.listAuditEntries(service.repoRoot, { limit: 100 }).entries.reverse();
}

async function collect(service, text, options, onEvent) {
  const events = [];
  for await (const event of service.sendMessageEvents(text, options)) {
    events.push(event);
    await onEvent?.(event);
  }
  return events;
}

test("riskyGate: full access allows the ordinary, asks the risky, blocks the disk wipe", () => {
  const opts = { repoRoot: "/r", platform: "linux" };
  assert.equal(riskyGate("full-access", { kind: "command", command: "npm test" }, opts).gate, "allow");
  assert.equal(riskyGate("full-access", { kind: "file_change", path: "a" }, opts).gate, "allow");
  assert.equal(riskyGate("full-access", { kind: "permissions" }, opts).gate, "ask");
  const risky = riskyGate("full-access", { kind: "command", command: "rm -rf tmp" }, opts);
  assert.equal(risky.gate, "ask");
  assert.equal(risky.risk.id, "recursive-delete");
  assert.equal(riskyGate("full-access", { kind: "command", command: "rm -rf /" }, opts).gate, "block");
  // Other modes always show the card, with the risk when there is one.
  assert.equal(riskyGate("supervised", { kind: "command", command: "ls" }, opts).gate, "ask");
  assert.equal(riskyGate("supervised", { kind: "command", command: "rm -rf x" }, opts).risk.id, "recursive-delete");
  assert.equal(riskyGate("supervised", { kind: "command", command: "rm -rf /" }, opts).gate, "block");

  assert.match(declineMessage(assessCommand("rm -rf x"), "desktop"), /declined.*\(desktop\).*deletes files recursively.*continue/);
  assert.match(declineMessage(assessCommand("rm -rf /")), /blocks this command/);
});

test("registry autoDecline answers at once and audits it", async () => {
  const entries = [];
  const registry = new ApprovalRegistry({ onAudit: (entry) => entries.push(entry) });
  const { approval, promise } = registry.request("c", { kind: "command", command: "rm -rf /", risk: "Risky command: wipes", autoDecline: "safety policy" });
  assert.equal(approval.autoResolved, true);
  assert.deepEqual(await promise, { decision: "decline", by: "safety policy", always: false });
  assert.deepEqual(entries.map((entry) => entry.action), ["approval_requested", "declined"]);
  assert.match(entries[0].detail, /Risky command: wipes/);
  assert.equal(registry.pending().length, 0);
});

test("API model in Full access: a risky command shows a card; approve runs it", async () => {
  const repoRoot = makeTempRepo();
  fs.mkdirSync(path.join(repoRoot, "tmpdir"));
  const service = createService(repoRoot, new CommandProvider("rm -rf tmpdir"));
  const events = await collect(service, "run rm", { model: API_MODEL, repoRoot, permissionMode: "full-access" }, (event) => {
    if (event.type === "approval_request") {
      assert.equal(event.approval.risk, "Risky command: deletes files recursively");
      assert.equal(event.approval.command, "rm -rf tmpdir");
      assert.ok(fs.existsSync(path.join(repoRoot, "tmpdir")), "nothing runs before the answer");
      service.respondToApproval({ approvalId: event.approval.id, decision: "approve", alwaysAllow: true });
    }
  });
  assert.ok(events.some((event) => event.type === "approval_request"));
  assert.equal(events.at(-1).type, "completed");
  assert.equal(fs.existsSync(path.join(repoRoot, "tmpdir")), false);
  const actions = auditActions(service).map((entry) => entry.action);
  assert.ok(actions.includes("approval_requested") && actions.includes("approved") && actions.includes("run_command"));
});

test("API model in Full access: declining tells the model why, and ordinary commands never ask", async () => {
  const repoRoot = makeTempRepo();
  fs.mkdirSync(path.join(repoRoot, "keep"));
  const service = createService(repoRoot, new CommandProvider("rm -rf keep"));
  const events = await collect(service, "run rm", { model: API_MODEL, repoRoot, permissionMode: "full-access" }, (event) => {
    if (event.type === "approval_request") service.respondToApproval({ approvalId: event.approval.id, decision: "decline" });
  });
  assert.ok(fs.existsSync(path.join(repoRoot, "keep")));
  assert.match(events.at(-1).assistantMessage, /declined.*deletes files recursively.*continue/);
  assert.ok(auditActions(service).some((entry) => entry.action === "declined" && entry.source === "user"));

  const quiet = createService(repoRoot, new CommandProvider("echo hi"));
  const quietEvents = await collect(quiet, "run echo", { model: API_MODEL, repoRoot, permissionMode: "full-access" });
  assert.ok(!quietEvents.some((event) => event.type === "approval_request"));
  assert.match(quietEvents.at(-1).assistantMessage, /hi/);
});

test("Codex in Full access: only risky commands reach the user; disk wipes are refused", async () => {
  const repoRoot = makeTempRepo();
  const codex = new AskingCli([
    { kind: "command", toolName: "shell", command: "npm test" },
    { kind: "file_change", toolName: "apply_patch", path: "a.txt", diff: "+a" },
    { kind: "command", toolName: "shell", command: "mkdir tmpdir && rm -rf tmpdir" },
    { kind: "command", toolName: "shell", command: "rm -rf /" },
  ]);
  const service = createService(repoRoot, new CommandProvider("echo"), { codexProvider: codex });
  const cards = [];
  const events = await collect(service, "go", { model: "codex:gpt-5.4", repoRoot, permissionMode: "full-access" }, (event) => {
    if (event.type === "approval_request") {
      cards.push(event.approval);
      service.respondToApproval({ approvalId: event.approval.id, decision: "decline" });
    }
  });
  assert.equal(events.at(-1).type, "completed");
  assert.deepEqual(cards.map((card) => card.command), ["mkdir tmpdir && rm -rf tmpdir"]);
  assert.equal(cards[0].risk, "Risky command: deletes files recursively");
  assert.deepEqual(codex.answers.map((answer) => answer.decision), ["approve", "approve", "decline", "decline"]);
  assert.equal(codex.answers[3].by, "safety policy");
  assert.match(codex.answers[3].message, /blocks this command/);
  // Only the risky and the refused command are in the audit trail.
  const approvals = auditActions(service).filter((entry) => entry.action === "approval_requested");
  assert.equal(approvals.length, 2);
});

test("Claude in Full access: per-turn settings ask for shell calls; the bridge declines with a reason", async () => {
  const provider = new ClaudeCliProvider(os.tmpdir());
  const files = writeClaudeMcpConfig({ url: "http://127.0.0.1:1/api/approvals/bridge", token: "t", settings: { permissions: { ask: ["Bash"] } } });
  try {
    assert.deepEqual(JSON.parse(fs.readFileSync(files.settingsPath, "utf8")), { permissions: { ask: ["Bash"] } });
    const args = provider.buildArgs("claude:haiku", { permissionMode: "full-access", mcpConfigPath: files.configPath, settingsPath: files.settingsPath });
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.equal(args[args.indexOf("--settings") + 1], files.settingsPath);
    assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "mcp__cortex_approvals__approve");
    assert.equal(args[args.indexOf("--mcp-config") + 1], files.configPath);
  } finally {
    files.cleanup();
  }
  const settingsOnly = writeClaudeMcpConfig({ settings: { permissions: {} } });
  assert.equal(settingsOnly.configPath, "");
  settingsOnly.cleanup();

  const repoRoot = makeTempRepo();
  const service = createService(repoRoot, new CommandProvider("echo"));
  const backend = await startBackendServer({ host: "127.0.0.1", port: 0, service });
  const previous = { url: process.env.CORTEX_APPROVAL_URL, token: process.env.CORTEX_APPROVAL_TOKEN };
  try {
    service.approvalBridges.set("tok", {
      chatId: "chat-y",
      ask: async () => ({ decision: "decline", by: "desktop", message: "custom reason for the agent" }),
    });
    process.env.CORTEX_APPROVAL_URL = service.approvalBridgeUrl;
    process.env.CORTEX_APPROVAL_TOKEN = "tok";
    const result = JSON.parse((await mcpServer.callApprove({ tool_name: "Bash", input: { command: "rm -rf x" } })).content[0].text);
    assert.deepEqual(result, { behavior: "deny", message: "custom reason for the agent" });
  } finally {
    process.env.CORTEX_APPROVAL_URL = previous.url || "";
    process.env.CORTEX_APPROVAL_TOKEN = previous.token || "";
    await backend.close();
  }
});

test(".claude/settings.json: new repos ask for risky commands; Cortex's old deny list moves to ask; a person's file is left alone", () => {
  const fresh = makeTempRepo();
  assert.equal(ensureClaudeSettings(fresh), "created");
  const created = JSON.parse(fs.readFileSync(path.join(fresh, ".claude", "settings.json"), "utf8"));
  assert.ok(created.permissions.ask.includes("Bash(rm -rf *)"));
  assert.ok(!created.permissions.deny.includes("Bash(rm -rf *)"));
  assert.ok(created.permissions.allow.includes("Bash(git *)"));
  assert.equal(ensureClaudeSettings(fresh), "kept", "already current");

  const legacy = makeTempRepo();
  fs.mkdirSync(path.join(legacy, ".claude"));
  const legacyFile = { permissions: { allow: ["Read", "Bash(make *)"], deny: [...LEGACY_DENY_RULES, "Bash(docker *)"] }, model: "sonnet" };
  fs.writeFileSync(path.join(legacy, ".claude", "settings.json"), JSON.stringify(legacyFile), "utf8");
  assert.equal(ensureClaudeSettings(legacy), "migrated");
  const migrated = JSON.parse(fs.readFileSync(path.join(legacy, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(migrated.permissions.allow, ["Read", "Bash(make *)"], "allow list untouched");
  assert.equal(migrated.model, "sonnet", "other keys untouched");
  assert.ok(migrated.permissions.deny.includes("Bash(docker *)"), "the person's own deny stays");
  assert.ok(!migrated.permissions.deny.includes("Bash(rm -rf *)"));
  assert.ok(migrated.permissions.ask.includes("Bash(rm -rf *)"));
  assert.equal(ensureClaudeSettings(legacy), "kept", "runs once");

  // Someone trimmed the list themselves: not recognisably Cortex's, untouched.
  const custom = { permissions: { deny: ["Bash(rm -rf *)"] } };
  assert.equal(migrateLegacySettings(custom), null);
  const broken = makeTempRepo();
  fs.mkdirSync(path.join(broken, ".claude"));
  fs.writeFileSync(path.join(broken, ".claude", "settings.json"), "{ not json", "utf8");
  assert.equal(ensureClaudeSettings(broken), "kept");
  assert.equal(fs.readFileSync(path.join(broken, ".claude", "settings.json"), "utf8"), "{ not json");
});
