const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DesktopSessionService } = require("./sessionService");
const { startBackendServer } = require("./server");
const { InterruptError } = require("./providers");

class MemoryConfig {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
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

  save() {}
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
  }

  setApiKey() {}

  async chatCompletion() {
    return "ok";
  }

  async chatWithTools() {
    return ["ok", null, null];
  }
}

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-tui-node-"));
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n", "utf8");
  return root;
}

function createService(repoRoot, overrides = {}) {
  return new DesktopSessionService({
    config: new MemoryConfig(repoRoot),
    repoRoot,
    codexProvider: overrides.codexProvider || new FakeCliProvider(),
    geminiCliProvider: overrides.geminiCliProvider || new FakeCliProvider(),
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
