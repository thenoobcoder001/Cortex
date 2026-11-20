const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { DesktopSessionService } = require("../sessionService");
const { startBackendServer } = require("../server");
const { CodexProvider, ClaudeCliProvider } = require("../providers");
const { claudeToolSummary, writeClaudeMcpConfig } = require("../approvalBridge");
const mcpServer = require("../approvalMcpServer");

const API_MODEL = "openai/gpt-oss-20b";

class MemoryConfig {
  constructor(repoRoot) {
    Object.assign(this, {
      repoRoot,
      path: "",
      activeChatId: "",
      model: API_MODEL,
      modelExplicit: true,
      apiKey: "x",
      geminiApiKey: "",
      openaiApiKey: "",
      promptPreset: "code",
      toolSafetyMode: "write",
      permissionMode: "",
      assistantMemory: "",
      contextCarryMessages: 5,
      geminiSessionId: "",
      codexSessionId: "",
      activeRuns: [],
      interruptedRuns: [],
      recentRepoRoots: [repoRoot],
    });
  }

  save() {}
  reset() {}
  deleteFile() {}
}

// An API provider that asks to write a file once, then answers.
class ToolCallingProvider {
  constructor(toolCall) {
    this.available = true;
    this.connected = true;
    this.toolCall = toolCall;
    this.calls = 0;
  }

  setApiKey() {}

  async chatCompletion() {
    return "done";
  }

  async chatWithTools(messages, _model, _tools, { signal = null } = {}) {
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      error.code = "INTERRUPTED";
      throw error;
    }
    this.calls += 1;
    if (this.calls === 1) {
      const call = { id: "call_1", type: "function", function: { name: this.toolCall.name, arguments: JSON.stringify(this.toolCall.args) } };
      return [null, { role: "assistant", content: "", tool_calls: [call] }, [call]];
    }
    const lastTool = [...messages].reverse().find((message) => message.role === "tool");
    return [`finished: ${String(lastTool?.content || "").slice(0, 40)}`, null, null];
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-approvals-"));
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

test("supervised API turn waits for approval, then writes the file and audits it", async () => {
  const repoRoot = makeTempRepo();
  const provider = new ToolCallingProvider({ name: "write_file", args: { path: "hello.txt", content: "hi\n" } });
  const service = createService(repoRoot, provider);

  const events = await collect(service, "create hello.txt", { model: API_MODEL, repoRoot, permissionMode: "supervised" }, (event) => {
    if (event.type === "approval_request") {
      assert.equal(fs.existsSync(path.join(repoRoot, "hello.txt")), false, "nothing written before approval");
      assert.equal(event.approval.kind, "file_change");
      assert.equal(event.approval.path, "hello.txt");
      assert.match(event.approval.diff, /\+hi/);
      assert.deepEqual(service.snapshot({ lite: true }).waitingChatIds, [event.chatId]);
      service.respondToApproval({ approvalId: event.approval.id, decision: "approve", by: "desktop" });
    }
  });

  assert.equal(events.at(-1).type, "completed");
  assert.ok(events.some((event) => event.type === "approval_resolved" && event.decision === "approve"));
  assert.equal(fs.readFileSync(path.join(repoRoot, "hello.txt"), "utf8"), "hi\n");

  const actions = auditActions(service).map((entry) => entry.action);
  assert.ok(actions.indexOf("approval_requested") < actions.indexOf("approved"));
  assert.ok(actions.includes("create"), "the write itself is audited too");
  const approved = auditActions(service).find((entry) => entry.action === "approved");
  assert.equal(approved.source, "user");
  assert.match(approved.detail, /by desktop/);
  assert.equal(service.listAuditEntries(repoRoot).chain.ok, true);
  assert.equal(service.listChats(repoRoot)[0].permissionMode, "supervised");
});

test("a declined edit never touches disk and the model is told", async () => {
  const repoRoot = makeTempRepo();
  const provider = new ToolCallingProvider({ name: "write_file", args: { path: "nope.txt", content: "x" } });
  const service = createService(repoRoot, provider);

  const events = await collect(service, "create nope.txt", { model: API_MODEL, repoRoot, permissionMode: "supervised" }, (event) => {
    if (event.type === "approval_request") {
      service.respondToApproval({ approvalId: event.approval.id, decision: "decline" });
    }
  });
  assert.equal(fs.existsSync(path.join(repoRoot, "nope.txt")), false);
  assert.match(events.at(-1).assistantMessage, /declined/);
  assert.ok(auditActions(service).some((entry) => entry.action === "declined"));
});

test("auto-accept edits writes without asking but asks before commands", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot, new ToolCallingProvider({ name: "write_file", args: { path: "a.txt", content: "a" } }));
  const events = await collect(service, "create a.txt", { model: API_MODEL, repoRoot, permissionMode: "auto-accept-edits" });
  assert.ok(!events.some((event) => event.type === "approval_request"));
  assert.ok(fs.existsSync(path.join(repoRoot, "a.txt")));

  const commandService = createService(repoRoot, new ToolCallingProvider({ name: "run_terminal_command", args: { command: "echo hi" } }));
  const commandEvents = await collect(commandService, "run echo", { model: API_MODEL, repoRoot, permissionMode: "auto-accept-edits" }, (event) => {
    if (event.type === "approval_request") {
      assert.equal(event.approval.kind, "command");
      assert.equal(event.approval.command, "echo hi");
      assert.equal(event.approval.canAlwaysAllow, true);
      commandService.respondToApproval({ approvalId: event.approval.id, decision: "decline" });
    }
  });
  assert.ok(commandEvents.some((event) => event.type === "approval_request"));
});

test("interrupt declines the pending approval and ends the turn", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot, new ToolCallingProvider({ name: "write_file", args: { path: "late.txt", content: "x" } }));
  const events = await collect(service, "create late.txt", { model: API_MODEL, repoRoot, permissionMode: "supervised" }, (event) => {
    if (event.type === "approval_request") {
      service.interruptChat(event.chatId);
    }
  });
  assert.equal(fs.existsSync(path.join(repoRoot, "late.txt")), false);
  assert.ok(events.some((event) => event.type === "interrupted"));
  assert.equal(service.approvalRegistry.pending().length, 0);
  const declined = auditActions(service).find((entry) => entry.action === "declined");
  assert.match(declined.detail, /interrupted/);
  assert.equal(declined.source, "cortex");
});

test("approval routes: list, respond (desktop and relay), bridge needs a token", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot, new ToolCallingProvider({ name: "run_terminal_command", args: { command: "echo routed" } }));
  const backend = await startBackendServer({ host: "127.0.0.1", port: 0, service });
  const base = backend.url;
  try {
    assert.match(service.approvalBridgeUrl, /\/api\/approvals\/bridge$/);
    const bridge = await fetch(`${base}/api/approvals/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "made-up", toolName: "Bash", input: { command: "ls" } }),
    });
    assert.equal(bridge.status, 403);

    const response = await fetch(`${base}/api/chat/send-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "run the command", model: API_MODEL, repoRoot, permissionMode: "supervised" }),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events = [];
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "approval_request") {
          const listed = await (await fetch(`${base}/api/approvals?chatId=${event.chatId}`)).json();
          assert.equal(listed.approvals[0].id, event.approval.id);
          // The phone answers through the relay, which adds this header.
          const answer = await fetch(`${base}/api/approvals/respond`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-PocketAI-Relay-Device": "phone-1" },
            body: JSON.stringify({ approvalId: event.approval.id, decision: "approve", chatId: event.chatId }),
          });
          assert.equal(answer.status, 200);
          const again = await fetch(`${base}/api/approvals/respond`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ approvalId: event.approval.id, decision: "approve" }),
          });
          assert.equal(again.status, 400);
        }
        if (event.type === "completed" || event.type === "error") done = true;
      }
    }
    assert.equal(events.at(-1).type, "completed");
    assert.match(events.at(-1).assistantMessage, /routed/);
    const approved = auditActions(service).find((entry) => entry.action === "approved");
    assert.match(approved.detail, /by relay:phone-1/);
    assert.ok(auditActions(service).some((entry) => entry.action === "run_command" && entry.command === "echo routed"));
  } finally {
    await backend.close();
  }
});

test("chat preferences switch modes, migrate legacy values and audit the change", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot, new ToolCallingProvider({ name: "list_files", args: {} }));
  const chatId = service.chatStore.createChat([], { model: API_MODEL, toolSafetyMode: "read" });
  assert.equal(service.listChats(repoRoot)[0].permissionMode, "read-only");

  service.updateChatPreferences({ chatId, permissionMode: "supervised", repoRoot });
  assert.equal(service.chatStore.loadChat(chatId).permission_mode, "supervised");
  assert.equal(service.chatStore.loadChat(chatId).tool_safety_mode, "write");
  // An old client sending "write" keeps the chat supervised.
  service.updateChatPreferences({ chatId, toolSafetyMode: "write", repoRoot });
  assert.equal(service.chatStore.loadChat(chatId).permission_mode, "supervised");
  const changed = auditActions(service).filter((entry) => entry.action === "permission_mode_changed");
  assert.equal(changed.length, 1);
  assert.match(changed[0].detail, /read-only -> supervised/);
});

test("codex approval requests are answered from the user's decision", async () => {
  const provider = new CodexProvider(os.tmpdir());
  const stdin = new PassThrough();
  const written = [];
  stdin.on("data", (chunk) => written.push(...String(chunk).split("\n").filter(Boolean).map((line) => JSON.parse(line))));
  const child = { stdin };
  const items = new Map([["item-2", { id: "item-2", type: "fileChange", changes: [{ path: "a.txt", diff: "+a", kind: { type: "add" } }] }]]);
  const asked = [];
  const askApproval = async (summary) => {
    asked.push(summary);
    return { decision: summary.kind === "command" ? "approve" : "decline" };
  };

  await provider.answerServerRequest(child, { id: 7, method: "item/commandExecution/requestApproval", params: { itemId: "item-1", command: "npm test", cwd: "/r" } }, { askApproval, items });
  await provider.answerServerRequest(child, { id: 8, method: "item/fileChange/requestApproval", params: { itemId: "item-2" } }, { askApproval, items });
  await provider.answerServerRequest(child, { id: 9, method: "execCommandApproval", params: { command: ["git", "status"] } }, { askApproval, items });
  await provider.answerServerRequest(child, { id: 10, method: "item/tool/requestUserInput", params: {} }, { askApproval, items });
  // No handler: never a silent approve.
  await provider.answerServerRequest(child, { id: 11, method: "item/commandExecution/requestApproval", params: { command: "rm x" } }, { askApproval: null, items });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(asked.map((s) => [s.kind, s.command || s.path]), [["command", "npm test"], ["file_change", "a.txt"], ["command", "git status"]]);
  assert.match(asked[1].diff, /\+a/);
  const byId = new Map(written.map((message) => [message.id, message]));
  assert.equal(byId.get(7).result.decision, "accept");
  assert.equal(byId.get(8).result.decision, "decline");
  assert.equal(byId.get(9).result.decision, "approved");
  assert.equal(byId.get(10).error.code, -32601);
  assert.equal(byId.get(11).result.decision, "decline");
});

test("claude: bridge args, tool summaries and the MCP approval round trip", async () => {
  const provider = new ClaudeCliProvider(os.tmpdir());
  const { configPath, cleanup } = writeClaudeMcpConfig({ url: "http://127.0.0.1:1/api/approvals/bridge", token: "t" });
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(config.mcpServers.cortex_approvals.env.CORTEX_APPROVAL_TOKEN, "t");
    const args = provider.buildArgs("claude:haiku", { permissionMode: "supervised", mcpConfigPath: configPath });
    assert.equal(args[args.indexOf("--mcp-config") + 1], configPath);
    assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "mcp__cortex_approvals__approve");
    assert.ok(!args.includes("--dangerously-skip-permissions"));
    assert.ok(provider.buildArgs("claude:haiku", { permissionMode: "full-access" }).includes("--dangerously-skip-permissions"));
  } finally {
    cleanup();
  }
  assert.equal(fs.existsSync(configPath), false);

  assert.deepEqual(claudeToolSummary("Bash", { command: "ls", description: "list" }), { kind: "command", toolName: "Bash", command: "ls", reason: "list" });
  const edit = claudeToolSummary("Edit", { file_path: "a.js", old_string: "x", new_string: "y" });
  assert.equal(edit.kind, "file_change");
  assert.match(edit.diff, /-x/);
  assert.match(edit.diff, /\+y/);

  // Real round trip: MCP tool call -> backend bridge route -> registry -> user.
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot, new ToolCallingProvider({ name: "list_files", args: {} }));
  const backend = await startBackendServer({ host: "127.0.0.1", port: 0, service });
  const previous = { url: process.env.CORTEX_APPROVAL_URL, token: process.env.CORTEX_APPROVAL_TOKEN };
  try {
    service.approvalBridges.set("tok", {
      chatId: "chat-x",
      ask: (summary) => service.approvalRegistry.request("chat-x", { ...summary, repoRoot }).promise,
    });
    process.env.CORTEX_APPROVAL_URL = service.approvalBridgeUrl;
    process.env.CORTEX_APPROVAL_TOKEN = "tok";
    const pendingCall = mcpServer.callApprove({ tool_name: "Write", input: { file_path: "x.txt", content: "x" } });
    while (!service.approvalRegistry.pending("chat-x").length) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const approval = service.approvalRegistry.pending("chat-x")[0];
    assert.equal(approval.toolName, "Write");
    service.respondToApproval({ approvalId: approval.id, decision: "approve" });
    const result = JSON.parse((await pendingCall).content[0].text);
    assert.deepEqual(result, { behavior: "allow", updatedInput: { file_path: "x.txt", content: "x" } });

    process.env.CORTEX_APPROVAL_TOKEN = "wrong";
    const denied = JSON.parse((await mcpServer.callApprove({ tool_name: "Bash", input: { command: "ls" } })).content[0].text);
    assert.equal(denied.behavior, "deny");
  } finally {
    process.env.CORTEX_APPROVAL_URL = previous.url || "";
    process.env.CORTEX_APPROVAL_TOKEN = previous.token || "";
    await backend.close();
  }
});
