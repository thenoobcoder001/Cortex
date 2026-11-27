const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { carryContext, labelReplies } = require("../contextCarry");
const { DesktopSessionService } = require("../sessionService");

function chat(count, size = 10) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `${index}:${"x".repeat(size)}`,
  }));
}

test("carry keeps recent messages up to the budget, never fewer than the setting", () => {
  const messages = chat(40, 1000);
  const carried = carryContext(messages, { minMessages: 5, charBudget: 24000 });
  // ~1005 chars each: 23 fit in 24k; plus the first message, labelled.
  assert.equal(carried.length, 24);
  assert.match(carried[0].content, /^\[First message in this chat; 16 later messages left out\]\n0:/);
  assert.equal(carried.at(-1).content, messages.at(-1).content);

  // A tiny budget still carries the minimum.
  const minimum = carryContext(messages, { minMessages: 5, charBudget: 10 });
  assert.equal(minimum.length, 6);
  assert.deepEqual(minimum.slice(1).map((m) => m.content), messages.slice(-5).map((m) => m.content));
});

test("carry: short chats go whole, 0 carries nothing, system and tool messages are skipped", () => {
  const short = [{ role: "system", content: "s" }, ...chat(4), { role: "tool", content: "t" }];
  assert.deepEqual(carryContext(short, { minMessages: 5 }).map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(carryContext(chat(10), { minMessages: 0 }), []);
  assert.deepEqual(carryContext([], { minMessages: 5 }), []);
  // A huge first message is clipped.
  const big = [{ role: "user", content: "y".repeat(10000) }, ...chat(30, 2000)];
  const carried = carryContext(big, { minMessages: 2, charBudget: 5000 });
  assert.ok(carried[0].content.length < 4200);
  assert.match(carried[0].content, /\(truncated\)$/);
});

test("replies by other models are labelled with their author", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "from codex", model: "codex:gpt-6-luna" },
    { role: "assistant", content: "from me", model: "claude:haiku" },
    { role: "assistant", content: "unknown" },
  ];
  const labelled = labelReplies(messages, { currentModel: "claude:haiku" });
  assert.equal(labelled[0].content, "hi");
  assert.equal(labelled[1].content, "[Earlier reply from codex:gpt-6-luna]\nfrom codex");
  assert.equal(labelled[2].content, "from me");
  assert.equal(labelled[3].content, "unknown");
  const withFallback = labelReplies(messages, { currentModel: "claude:haiku", fallbackModel: "codex:gpt-5.4" });
  assert.equal(withFallback[3].content, "[Earlier reply from codex:gpt-5.4]\nunknown");
  assert.equal(messages[1].content, "from codex", "input not mutated");
});

class MemoryConfig {
  constructor(repoRoot) {
    Object.assign(this, {
      repoRoot, path: "", activeChatId: "", model: "codex:gpt-5.4", modelExplicit: true,
      apiKey: "x", geminiApiKey: "", openaiApiKey: "", promptPreset: "code",
      toolSafetyMode: "write", permissionMode: "", assistantMemory: "", contextCarryMessages: 5,
      geminiSessionId: "", codexSessionId: "", activeRuns: [], interruptedRuns: [], recentRepoRoots: [repoRoot],
    });
  }

  save() {}
  reset() {}
  deleteFile() {}
}

// A CLI provider that records what it was handed and the options.
class RecordingCli {
  constructor(name) {
    this.name = name;
    this.available = true;
    this.connected = true;
    this.sessionId = "";
    this.sessionMode = "fresh";
    this.calls = [];
  }

  setRepoRoot() {}
  setApiKey() {}

  async chatCompletionStreamRaw(messages, _model, options) {
    this.calls.push({ messages, carriedContext: options.carriedContext });
    this.sessionId = `${this.name}-session`;
    return `reply from ${this.name}`;
  }
}

test("switching provider: the new one gets labelled context, the stored chat keeps everything", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-carry-"));
  const codex = new RecordingCli("codex");
  const claude = new RecordingCli("claude");
  const idle = new RecordingCli("idle");
  const service = new DesktopSessionService({
    config: new MemoryConfig(repoRoot),
    repoRoot,
    codexProvider: codex,
    claudeProvider: claude,
    geminiCliProvider: idle,
    hermesProvider: idle,
    groqProvider: idle,
    geminiProvider: idle,
  });

  let chatId = null;
  for (let index = 0; index < 4; index += 1) {
    const events = await Array.fromAsync(service.sendMessageEvents(`codex question ${index}`, { chatId, repoRoot, model: "codex:gpt-6-luna" }));
    chatId = events.find((event) => event.chatId)?.chatId || chatId;
  }
  const stored = service.chatStore.loadChat(chatId);
  assert.equal(stored.messages.length, 8);
  assert.equal(stored.messages[1].model, "codex:gpt-6-luna", "model saved on each reply");

  await Array.fromAsync(service.sendMessageEvents("now you, claude", { chatId, repoRoot, model: "claude:haiku" }));
  const handed = claude.calls[0];
  assert.equal(handed.carriedContext, true);
  const assistantTurns = handed.messages.filter((message) => message.role === "assistant");
  assert.equal(assistantTurns.length, 4, "all 8 earlier messages fit the budget");
  for (const message of assistantTurns) {
    assert.match(message.content, /^\[Earlier reply from codex:gpt-6-luna\]\nreply from codex/);
    assert.equal(message.model, undefined, "metadata stripped before the provider");
  }
  assert.equal(handed.messages.at(-1).content, "now you, claude");

  const after = service.chatStore.loadChat(chatId);
  assert.equal(after.messages.length, 10, "switching never trims the saved chat");
  assert.equal(after.messages.at(-1).model, "claude:haiku");
  assert.equal(after.messages[1].content, "reply from codex", "labels are not saved");

  // Resuming the same provider is not re-carried.
  await Array.fromAsync(service.sendMessageEvents("again", { chatId, repoRoot, model: "claude:haiku" }));
  assert.equal(claude.calls[1].carriedContext, false);
});
