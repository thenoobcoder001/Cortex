const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_MODEL, CODEX_MODELS, GEMINI_MODELS } = require("../constants");
const { firstInstalledModel, isExplicitModelChoice } = require("../defaultModel");
const { DesktopSessionService } = require("../sessionService");

function cli(available) {
  return {
    available,
    connected: available,
    sessionId: "",
    sessionMode: "fresh",
    setRepoRoot() {},
    setApiKey() {},
  };
}

function api(key = "") {
  return {
    available: true,
    apiKey: key,
    get connected() { return Boolean(this.apiKey); },
    setApiKey(value) { this.apiKey = String(value || ""); },
  };
}

function providers({ claude = false, codex = false, agy = false, hermes = false, geminiKey = "", groqKey = "" } = {}) {
  return {
    claudeProvider: cli(claude),
    codexProvider: cli(codex),
    agyProvider: cli(agy),
    hermesProvider: cli(hermes),
    geminiProvider: api(geminiKey),
    groqProvider: api(groqKey),
  };
}

class MemoryConfig {
  constructor(repoRoot, { model = "", modelExplicit = null } = {}) {
    this.repoRoot = repoRoot;
    this.path = "";
    this.activeChatId = "";
    this.model = model;
    this.modelExplicit = modelExplicit;
    this.apiKey = "";
    this.geminiApiKey = "";
    this.openaiApiKey = "";
    this.promptPreset = "code";
    this.toolSafetyMode = "write";
    this.assistantMemory = "";
    this.contextCarryMessages = 5;
    this.activeRuns = [];
    this.interruptedRuns = [];
    this.saves = 0;
  }

  save() { this.saves += 1; }
  reset() { this.model = ""; this.modelExplicit = false; }
  deleteFile() {}
}

function makeService(config, installed) {
  return new DesktopSessionService({
    config,
    repoRoot: config.repoRoot,
    ...providers(installed),
  });
}

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-default-model-"));
}

test("first installed provider follows Claude, Codex, Antigravity, Hermes, API keys", () => {
  const codexDefault = CODEX_MODELS[0][0];
  assert.equal(firstInstalledModel(providers({ claude: true, codex: true, agy: true })), "claude:sonnet");
  assert.equal(firstInstalledModel(providers({ codex: true, agy: true })), codexDefault);
  assert.equal(firstInstalledModel(providers({ agy: true, hermes: true })), "agy:default");
  assert.equal(firstInstalledModel(providers({ hermes: true, geminiKey: "k" })), "hermes:default");
  assert.equal(firstInstalledModel(providers({ geminiKey: "k", groqKey: "k" })), GEMINI_MODELS[0][0]);
  assert.equal(firstInstalledModel(providers({ groqKey: "k" })), "openai/gpt-oss-120b");
  assert.equal(firstInstalledModel(providers()), DEFAULT_MODEL);
});

test("codex default comes from the service's live model list when it has one", () => {
  const service = { ...providers({ codex: true }), defaultCodexModelId: () => "codex:gpt-5.5:medium" };
  assert.equal(firstInstalledModel(service), "codex:gpt-5.5:medium");
});

test("explicit-choice detection keeps picked models and drops the old unpicked default", () => {
  const noAgy = providers({ claude: true });
  const withAgy = providers({ agy: true });
  assert.equal(isExplicitModelChoice({ model: "" }, noAgy), false);
  assert.equal(isExplicitModelChoice({ model: "claude:opus", modelExplicit: true }, noAgy), true);
  assert.equal(isExplicitModelChoice({ model: "claude:opus", modelExplicit: false }, noAgy), false);
  // Configs saved before the flag existed.
  assert.equal(isExplicitModelChoice({ model: "codex:gpt-5.4:high", modelExplicit: null }, noAgy), true);
  assert.equal(isExplicitModelChoice({ model: DEFAULT_MODEL, modelExplicit: null }, noAgy), false);
  assert.equal(isExplicitModelChoice({ model: DEFAULT_MODEL, modelExplicit: null }, withAgy), true);
  // The default saved before Gemini CLI was replaced by Antigravity.
  assert.equal(isExplicitModelChoice({ model: "gemini-cli:auto", modelExplicit: null }, noAgy), false);
  assert.equal(isExplicitModelChoice({ model: "gemini-cli:auto", modelExplicit: null }, withAgy), true);
});

test("fresh config with only Claude and Codex installed defaults to Claude, not Antigravity", () => {
  const repo = tempRepo();
  const config = new MemoryConfig(repo);
  const service = makeService(config, { claude: true, codex: true });
  assert.equal(service.snapshot({ lite: true }).config.model, "claude:sonnet");
  // New chats pick it up too.
  service.newChat(null, { lite: true });
  assert.equal(service.chatStore.loadChat(service.activeChatId).model, "claude:sonnet");
  // Saved as an automatic pick, not a user choice.
  assert.equal(config.modelExplicit, false);
});

test("a config holding the old Gemini CLI default is moved when Antigravity is missing", () => {
  const repo = tempRepo();
  const service = makeService(new MemoryConfig(repo, { model: "gemini-cli:auto" }), { codex: true });
  assert.equal(service.model, CODEX_MODELS[0][0]);
});

test("a config holding the old Gemini CLI default moves to Antigravity when agy is installed", () => {
  const repo = tempRepo();
  const service = makeService(new MemoryConfig(repo, { model: "gemini-cli:auto" }), { codex: true, agy: true });
  assert.equal(service.model, "agy:default");
});

test("a picked Gemini CLI model loads as its Antigravity replacement", () => {
  const repo = tempRepo();
  const service = makeService(new MemoryConfig(repo, { model: "gemini-cli:gemini-3.1-pro-preview", modelExplicit: true }), { agy: true });
  assert.equal(service.model, "agy:gemini-3.8-flash-high");
});

test("a model the user picked is kept even when a preferred provider is installed", () => {
  const repo = tempRepo();
  const config = new MemoryConfig(repo);
  const first = makeService(config, { claude: true, codex: true });
  first.updateConfig({ model: "codex:gpt-5.4:high" }, { lite: true });
  assert.equal(config.model, "codex:gpt-5.4:high");
  assert.equal(config.modelExplicit, true);

  // Next launch: Claude is still preferred, but the pick stays.
  const second = makeService(config, { claude: true, codex: true });
  assert.equal(second.model, "codex:gpt-5.4:high");

  // Picking Antigravity explicitly sticks too, installed or not.
  second.updateConfig({ model: "agy:gemini-3.8-flash-low" }, { lite: true });
  const third = makeService(config, { claude: true });
  assert.equal(third.model, "agy:gemini-3.8-flash-low");
});

test("an automatic default follows setup changes such as a newly added API key", () => {
  const repo = tempRepo();
  const service = makeService(new MemoryConfig(repo), {});
  assert.equal(service.model, DEFAULT_MODEL);
  service.updateConfig({ geminiApiKey: "key" }, { lite: true });
  assert.equal(service.model, GEMINI_MODELS[0][0]);
});

test("clearing settings returns to the first installed provider", () => {
  const repo = tempRepo();
  const config = new MemoryConfig(repo, { model: "claude:opus", modelExplicit: true });
  const service = makeService(config, { codex: true });
  assert.equal(service.model, "claude:opus");
  service.deleteSettingsFile();
  assert.equal(service.model, CODEX_MODELS[0][0]);
  assert.equal(service.modelExplicit, false);
});
