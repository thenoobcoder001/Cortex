const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DesktopSessionService } = require("./sessionService");
const { AppConfigStore } = require("./configStore");
const { startBackendServer } = require("./server");
const { InterruptError } = require("./providers");

class MemoryConfig {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.path = "";
    this.activeChatId = "";
    this.model = "codex:gpt-5.4";
    this.apiKey = "";
    this.geminiApiKey = "";
    this.openaiApiKey = "";
    this.promptPreset = "code";
    this.toolSafetyMode = "write";
    this.assistantMemory = "";
    this.contextCarryMessages = 5;
    this.geminiSessionId = "";
    this.codexSessionId = "";
    this.activeRuns = [];
    this.interruptedRuns = [];
  }

  save() {
    if (!this.path) {
      return;
    }
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify({ api_key: this.apiKey }), "utf8");
  }

  reset() {
    this.repoRoot = "";
    this.activeChatId = "";
    this.model = "codex:gpt-5.4";
    this.apiKey = "";
    this.geminiApiKey = "";
    this.openaiApiKey = "";
    this.promptPreset = "code";
    this.toolSafetyMode = "write";
    this.assistantMemory = "";
    this.contextCarryMessages = 5;
    this.geminiSessionId = "";
    this.codexSessionId = "";
    this.activeRuns = [];
    this.interruptedRuns = [];
  }

  deleteFile() {
    if (this.path && fs.existsSync(this.path)) {
      fs.unlinkSync(this.path);
    }
  }
}

class FakeCliProvider {
  constructor({ chunks = ["A", "B", "C"], delayMs = 10 } = {}) {
    this.available = true;
    this.connected = true;
    this.sessionId = "";
    this.sessionMode = "fresh";
    this.toolReadOnly = false;
    this.chunks = chunks;
    this.delayMs = delayMs;
  }

  setRepoRoot() {}
  setApiKey() {}

  async chatCompletionStreamRaw(_messages, _model, { onOutput = null, signal = null } = {}) {
    let text = "";
    for (const chunk of this.chunks) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (signal?.aborted) {
        throw new InterruptError("Request interrupted.", text);
      }
      text += chunk;
      onOutput?.(chunk);
    }
    this.sessionId = "cli-session";
    this.sessionMode = "resume_id";
    return text;
  }

  async chatCompletion(messages, model, options = {}) {
    return this.chatCompletionStreamRaw(messages, model, options);
  }

  async chatWithTools(messages, model, _tools, options = {}) {
    return [await this.chatCompletion(messages, model, options), null, null];
  }
}

class FakeApiProvider {
  constructor() {
    this.available = true;
    this.connected = true;
    this.apiKey = "";
  }

  setApiKey(value) {
    this.apiKey = String(value || "");
  }

  async chatCompletion() {
    return "ok";
  }

  async chatWithTools() {
    return ["ok", null, null];
  }
}

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-node-"));
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n", "utf8");
  return root;
}

function createService(repoRoot, overrides = {}) {
  return new DesktopSessionService({
    config: overrides.config || new MemoryConfig(repoRoot),
    repoRoot,
    codexProvider: overrides.codexProvider || new FakeCliProvider(),
    geminiCliProvider: overrides.geminiCliProvider || new FakeCliProvider(),
    claudeProvider: overrides.claudeProvider || new FakeCliProvider(),
    groqProvider: new FakeApiProvider(),
    geminiProvider: new FakeApiProvider(),
  });
}

test("codex streaming send completes and clears request state", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot, {
    codexProvider: new FakeCliProvider({ chunks: ["he", "llo"], delayMs: 5 }),
  });

  const events = [];
  for await (const event of service.sendMessageEvents("say hello", {
    model: "codex:gpt-5.4",
    repoRoot,
    toolSafetyMode: "read",
  })) {
    events.push(event);
  }

  assert.equal(events.filter((event) => event.type === "cli_output").length, 2);
  assert.equal(events.at(-1)?.type, "completed");
  assert.equal(events.at(-1)?.assistantMessage, "hello");
  assert.deepEqual(service.requestRegistry.ids(), []);

  const chats = service.listChats(repoRoot);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].toolSafetyMode, "read");
});

test("interrupt endpoint aborts a running codex chat and emits interrupted event", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot, {
    codexProvider: new FakeCliProvider({ chunks: ["one ", "two ", "three"], delayMs: 25 }),
  });
  const backend = await startBackendServer({ host: "127.0.0.1", port: 8892, service });

  try {
    const response = await fetch("http://127.0.0.1:8892/api/chat/send-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "stream then stop",
        model: "codex:gpt-5.4",
        repoRoot,
        toolSafetyMode: "write",
      }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events = [];
    let targetChatId = "";
    let interrupted = false;

    while (!interrupted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "user_message") {
          targetChatId = event.chatId;
        }
        if (event.type === "cli_output" && targetChatId) {
          const interruptResponse = await fetch("http://127.0.0.1:8892/api/chats/interrupt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId: targetChatId }),
          });
          assert.equal(interruptResponse.status, 200);
        }
        if (event.type === "interrupted") {
          interrupted = true;
          break;
        }
      }
    }

    assert.ok(targetChatId);
    assert.ok(events.some((event) => event.type === "cli_output"));
    assert.ok(events.some((event) => event.type === "interrupted"));
    assert.ok(!events.some((event) => event.type === "completed"));
    assert.deepEqual(service.requestRegistry.ids(), []);
  } finally {
    await backend.close();
  }
});

test("workspace diff persists across chats until accepted", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot);

  const initialSnapshot = service.snapshot();
  assert.equal(initialSnapshot.changes.length, 0);

  fs.writeFileSync(path.join(repoRoot, "seed.txt"), "seed changed\n", "utf8");

  const changedSnapshot = service.snapshot();
  assert.equal(changedSnapshot.changes.length, 1);
  assert.equal(changedSnapshot.changes[0].action, "edit");

  service.newChat(repoRoot);
  const newChatSnapshot = service.snapshot();
  assert.equal(newChatSnapshot.changes.length, 1);

  const acceptedSnapshot = service.acceptWorkspaceChanges(repoRoot);
  assert.equal(acceptedSnapshot.changes.length, 0);
});

test("revert workspace changes restores accepted baseline", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot);

  service.acceptWorkspaceChanges(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "seed.txt"), "changed\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "new-file.txt"), "new\n", "utf8");

  const changedSnapshot = service.snapshot();
  assert.equal(changedSnapshot.changes.length, 2);

  const revertedSnapshot = service.revertWorkspaceChanges(repoRoot);
  assert.equal(revertedSnapshot.changes.length, 0);
  assert.equal(fs.readFileSync(path.join(repoRoot, "seed.txt"), "utf8"), "seed\n");
  assert.ok(!fs.existsSync(path.join(repoRoot, "new-file.txt")));
});

test("clear local data removes project metadata and resets service state", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot);

  service.newChat(repoRoot);
  service.updateConfig({
    apiKey: "gsk_test",
    geminiApiKey: "gem_test",
    openaiApiKey: "sk_test",
    assistantMemory: "remember this",
    contextCarryMessages: 9,
  });
  service.acceptWorkspaceChanges(repoRoot);

  const metadataDir = path.join(repoRoot, ".cortex");
  assert.ok(fs.existsSync(metadataDir));

  const snapshot = service.clearLocalData([repoRoot]);
  assert.equal(snapshot.config.activeChatId, "");
  assert.equal(snapshot.config.apiKey, "");
  assert.equal(snapshot.config.geminiApiKey, "");
  assert.equal(snapshot.config.openaiApiKey, "");
  assert.equal(snapshot.config.assistantMemory, "");
  assert.equal(snapshot.chats.length, 0);
  assert.ok(!fs.existsSync(metadataDir));
});

test("delete settings file clears saved keys without deleting project metadata", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot);
  const configPath = path.join(repoRoot, "fake-config.json");
  service.config.path = configPath;

  service.updateConfig({
    apiKey: "gsk_test",
    geminiApiKey: "gem_test",
    openaiApiKey: "sk_test",
    assistantMemory: "remember this",
    contextCarryMessages: 9,
  });
  service.newChat(repoRoot);

  assert.ok(fs.existsSync(configPath));

  const snapshot = service.deleteSettingsFile();
  assert.equal(snapshot.config.apiKey, "");
  assert.equal(snapshot.config.geminiApiKey, "");
  assert.equal(snapshot.config.openaiApiKey, "");
  assert.equal(snapshot.config.assistantMemory, "");
  assert.equal(snapshot.config.activeChatId, "");
  assert.equal(snapshot.config.configPath, configPath);
  assert.ok(!fs.existsSync(configPath));
  assert.ok(fs.existsSync(path.join(repoRoot, ".cortex")));
});

test("provider connection test uses current draft keys and reports success", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot);

  let groqSignalSeen = false;
  service.groqProvider.chatCompletion = async (_messages, _model, options = {}) => {
    groqSignalSeen = Boolean(options.signal);
    return "OK";
  };

  const result = await service.testProviderConnection({
    providerId: "groq",
    apiKey: "gsk_test",
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, "groq");
  assert.equal(result.message, "OK");
  assert.equal(groqSignalSeen, true);
  assert.equal(service.groqProvider.apiKey, "");
});

test("context carry can be set to zero and survives snapshot/config reload", () => {
  const repoRoot = makeTempRepo();
  const localAppDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-config-"));
  const configPath = path.join(localAppDataDir, "cortex", "config.json");
  const config = new AppConfigStore();
  config.path = configPath;
  const service = createService(repoRoot, { config });

  const snapshot = service.updateConfig({ contextCarryMessages: 0 });
  assert.equal(snapshot.config.contextCarryMessages, 0);

  const savedRaw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(savedRaw.context_carry_messages, 0);

  const originalLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localAppDataDir;
  try {
    const reloaded = AppConfigStore.load();
    assert.equal(reloaded.contextCarryMessages, 0);
  } finally {
    if (originalLocalAppData == null) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = originalLocalAppData;
    }
  }
});

test("chat messages page returns most recent history with pagination", () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot);
  const chatId = service.chatStore.createChat([
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
    { role: "assistant", content: "four" },
    { role: "user", content: "five" },
  ], { model: "codex:gpt-5.4" });

  const latestPage = service.getChatMessages(chatId, repoRoot, { limit: 2 });
  assert.equal(latestPage.chatId, chatId);
  assert.equal(latestPage.total, 5);
  assert.equal(latestPage.hasMore, true);
  assert.equal(latestPage.nextBefore, 3);
  assert.deepEqual(latestPage.messages.map((message) => message.content), ["four", "five"]);

  const olderPage = service.getChatMessages(chatId, repoRoot, { before: latestPage.nextBefore, limit: 3 });
  assert.equal(olderPage.hasMore, false);
  assert.equal(olderPage.nextBefore, null);
  assert.deepEqual(olderPage.messages.map((message) => message.content), ["one", "two", "three"]);
});

test("chat messages endpoint returns paginated chat history", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot);
  const chatId = service.chatStore.createChat([
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
    { role: "user", content: "again" },
  ], { model: "codex:gpt-5.4" });
  const backend = await startBackendServer({ host: "127.0.0.1", port: 8893, service });

  try {
    const response = await fetch(`http://127.0.0.1:8893/api/chats/messages?chatId=${encodeURIComponent(chatId)}&repoRoot=${encodeURIComponent(repoRoot)}&limit=2`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.chatId, chatId);
    assert.equal(payload.total, 3);
    assert.equal(payload.hasMore, true);
    assert.equal(payload.nextBefore, 1);
    assert.deepEqual(payload.messages.map((message) => message.content), ["world", "again"]);
  } finally {
    await backend.close();
  }
});

test("claude provider connection test reports success", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot, {
    claudeProvider: new FakeCliProvider({ chunks: ["OK"], delayMs: 1 }),
  });

  const result = await service.testProviderConnection({
    providerId: "claude",
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, "claude");
  assert.equal(result.message, "OK");
});

test("plan mode saves a markdown plan file and exposes it on the active snapshot", async () => {
  const repoRoot = makeTempRepo();
  const service = createService(repoRoot);
  service.groqProvider.chatCompletion = async () => "## Goal\n\nShip the feature.\n";

  let finalSnapshot = null;
  for await (const event of service.sendMessageEvents("Plan the implementation", {
    repoRoot,
    model: "llama-3.3-70b-versatile",
    promptPreset: "plan",
  })) {
    if (event.type === "completed") {
      finalSnapshot = event.snapshot;
    }
  }

  assert.ok(finalSnapshot);
  assert.ok(finalSnapshot.activePlan);
  assert.match(finalSnapshot.activePlan.path, /\\.cortex[\\/]plans[\\/].+\.md$/i);
  assert.ok(fs.existsSync(finalSnapshot.activePlan.path));
  assert.match(fs.readFileSync(finalSnapshot.activePlan.path, "utf8"), /## Plan/i);
});
