const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_MODEL,
  GEMINI_MODELS,
  AGY_MODELS,
  GROQ_MODELS,
  CLAUDE_MODELS,
  LEGACY_MODEL_IDS,
  resolveModelId,
} = require("../constants");
const { ProjectChatStore } = require("../chatStore");
const { AgyCliProvider } = require("../providers");

const currentIds = new Set(
  [...GEMINI_MODELS, ...AGY_MODELS, ...GROQ_MODELS, ...CLAUDE_MODELS].map(([id]) => id),
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
  assert.equal(resolveModelId("gemini-cli:auto-gemini-2.5"), "agy:default");
  assert.equal(resolveModelId("mixtral-8x7b-32768"), "openai/gpt-oss-120b");
  assert.equal(resolveModelId("gemini-1.5-pro"), "gemini-3.1-pro-preview");
  assert.equal(resolveModelId("gemini-cli:gemini-2.5-pro"), "agy:gemini-3.8-flash-high");
  assert.equal(resolveModelId("agy:gemini-3.8-flash-low"), "agy:gemini-3.8-flash-low");
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

test("every Gemini CLI id, listed or not, maps to an Antigravity model", () => {
  for (const id of ["gemini-cli:auto", "gemini-cli:manual", "gemini-cli:gemini-3-flash-preview", "gemini-cli:some-future-model"]) {
    assert.ok(resolveModelId(id).startsWith("agy:"), id);
    assert.ok(currentIds.has(resolveModelId(id)), id);
  }
  assert.equal(resolveModelId("gemini-cli:gemini-3-flash-preview"), "agy:gemini-3.8-flash-medium");
  assert.equal(resolveModelId("gemini-cli:some-future-model"), DEFAULT_MODEL);
});

test("a saved Gemini CLI chat loads on Antigravity", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-models-"));
  try {
    const store = new ProjectChatStore(repo);
    const chatId = store.createChat([{ role: "user", content: "hi" }], { model: "gemini-cli:auto" });
    assert.equal(store.loadChat(chatId).model, "agy:default");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Antigravity passes --model only for a model agy still lists", () => {
  const provider = new AgyCliProvider(os.tmpdir());
  assert.equal(provider.cliModelName("agy:default"), "");
  assert.equal(provider.cliModelName("agy:gemini-3.8-flash-low"), "gemini-3.8-flash-low");
  provider.models = [{ model: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash", base: "gemini-3.8-flash", effort: "high" }];
  assert.equal(provider.cliModelName("agy:gemini-3.8-flash-high"), "gemini-3.8-flash-high");
  // Retired since the chat was saved: let agy use its default.
  assert.equal(provider.cliModelName("agy:gemini-3.8-flash-low"), "");
});
