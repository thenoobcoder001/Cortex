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

function providers({ claude = false, codex = false, geminiCli = false, hermes = false, geminiKey = "", groqKey = "" } = {}) {
  return {
    claudeProvider: cli(claude),
    codexProvider: cli(codex),
    geminiCliProvider: cli(geminiCli),
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

test("first installed provider follows Claude, Codex, Gemini CLI, Hermes, API keys", () => {
  const codexDefault = CODEX_MODELS[0][0];
  assert.equal(firstInstalledModel(providers({ claude: true, codex: true, geminiCli: true })), "claude:sonnet");
  assert.equal(firstInstalledModel(providers({ codex: true, geminiCli: true })), codexDefault);
  assert.equal(firstInstalledModel(providers({ geminiCli: true, hermes: true })), "gemini-cli:auto");
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
  const noGemini = providers({ claude: true });
  const withGemini = providers({ geminiCli: true });
  assert.equal(isExplicitModelChoice({ model: "" }, noGemini), false);
  assert.equal(isExplicitModelChoice({ model: "claude:opus", modelExplicit: true }, noGemini), true);
  assert.equal(isExplicitModelChoice({ model: "claude:opus", modelExplicit: false }, noGemini), false);
  // Configs saved before the flag existed.
  assert.equal(isExplicitModelChoice({ model: "codex:gpt-5.4:high", modelExplicit: null }, noGemini), true);
  assert.equal(isExplicitModelChoice({ model: DEFAULT_MODEL, modelExplicit: null }, noGemini), false);
  assert.equal(isExplicitModelChoice({ model: DEFAULT_MODEL, modelExplicit: null }, withGemini), true);
});

test("fresh config with only Claude and Codex installed defaults to Claude, not Gemini CLI", () => {
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

test("a config holding the old Gemini CLI default is moved when Gemini CLI is missing", () => {
  const repo = tempRepo();
  const service = makeService(new MemoryConfig(repo, { model: DEFAULT_MODEL }), { codex: true });
  assert.equal(service.model, CODEX_MODELS[0][0]);
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

  // Picking Gemini CLI explicitly sticks too, installed or not.
  second.updateConfig({ model: "gemini-cli:auto" }, { lite: true });
  const third = makeService(config, { claude: true });
  assert.equal(third.model, "gemini-cli:auto");
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
