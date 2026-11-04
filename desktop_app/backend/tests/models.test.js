const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_MODEL,
  GEMINI_MODELS,
  GEMINI_CLI_MODELS,
  GROQ_MODELS,
  CLAUDE_MODELS,
  LEGACY_MODEL_IDS,
  resolveModelId,
} = require("../constants");
const { ProjectChatStore } = require("../chatStore");
const { GeminiCliProvider } = require("../providers");

const currentIds = new Set(
  [...GEMINI_MODELS, ...GEMINI_CLI_MODELS, ...GROQ_MODELS, ...CLAUDE_MODELS].map(([id]) => id),
);

test("default model is one of the offered models", () => {
  assert.ok(currentIds.has(DEFAULT_MODEL), DEFAULT_MODEL);
});

test("every retired model id maps to a model that is still offered", () => {
  for (const [oldId, newId] of Object.entries(LEGACY_MODEL_IDS)) {
    assert.ok(currentIds.has(newId), `${oldId} -> ${newId} is not offered`);
    assert.equal(resolveModelId(oldId), newId);
  }
});

test("resolveModelId maps retired ids and passes others through", () => {
  assert.equal(resolveModelId("gemini-cli:auto-gemini-2.5"), "gemini-cli:auto");
  assert.equal(resolveModelId("mixtral-8x7b-32768"), "openai/gpt-oss-120b");
  assert.equal(resolveModelId("gemini-1.5-pro"), "gemini-3.1-pro-preview");
  assert.equal(resolveModelId("gemini-cli:gemini-2.5-pro"), "gemini-cli:gemini-3.1-pro-preview");
  assert.equal(resolveModelId("  claude:sonnet  "), "claude:sonnet");
  assert.equal(resolveModelId("codex:gpt-5.5:high"), "codex:gpt-5.5:high");
  assert.equal(resolveModelId(""), "");
  assert.equal(resolveModelId(null), "");
});

test("a saved chat on a retired model loads with its replacement", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-models-"));
  try {
    const store = new ProjectChatStore(repo);
    const chatId = store.createChat([{ role: "user", content: "hi" }], { model: "llama-3.3-70b-versatile" });
    assert.equal(store.loadChat(chatId).model, "openai/gpt-oss-120b");
    assert.equal(store.listChats()[0].model, "openai/gpt-oss-120b");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Gemini CLI gets the CLI alias, with retired aliases mapped", () => {
  const provider = new GeminiCliProvider(os.tmpdir());
  assert.equal(provider.cliModelName("gemini-cli:auto"), "auto");
  assert.equal(provider.cliModelName("gemini-cli:auto-gemini-2.5"), "auto");
  assert.equal(provider.cliModelName("gemini-cli:gemini-3-flash-preview"), "gemini-3-flash-preview");
});
