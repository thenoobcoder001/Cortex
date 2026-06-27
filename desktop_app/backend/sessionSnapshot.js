const {
  APP_NAME,
  VERSION,
  GEMINI_CLI_MODELS,
  CLAUDE_MODELS,
  HERMES_MODELS,
  CODEX_MODELS,
} = require("./constants");
const { buildResourceSnapshot } = require("./resourceMonitor");

function modelFamily(model) {
  if (String(model).startsWith("claude:")) return "claude";
  if (String(model).startsWith("hermes:")) return "hermes";
  if (String(model).startsWith("gemini-cli:")) return "gemini-cli";
  if (String(model).startsWith("gemini")) return "gemini";
  if (String(model).startsWith("codex:")) return "codex";
  return "groq";
}

function providerNameForModel(model) {
  if (String(model).startsWith("claude:")) return "Claude";
  if (String(model).startsWith("hermes:")) return "Hermes";
  if (String(model).startsWith("gemini-cli:")) return "Gemini CLI";
  if (String(model).startsWith("gemini")) return "Gemini";
  if (String(model).startsWith("codex:")) return "Codex";
  return "Groq";
}

function models() {
  return [
    ...CODEX_MODELS.map(([id, label]) => {
      const parts = id.split(":");
      const subGroup = parts.length >= 3 ? parts[1] : null;
      return { id, label, group: "Codex", ...(subGroup ? { subGroup } : {}) };
    }),
    ...CLAUDE_MODELS.map(([id, label]) => ({ id, label, group: "Claude" })),
    ...HERMES_MODELS.map(([id, label]) => ({ id, label, group: "Hermes" })),
    ...GEMINI_CLI_MODELS.map(([id, label]) => ({ id, label, group: "Gemini CLI (Legacy)" })),
  ];
}

function providersSnapshot(service) {
  return {
    claude: { available: service.claudeProvider.available, connected: service.claudeProvider.connected },
    hermes: { available: service.hermesProvider?.available || false, connected: service.hermesProvider?.connected || false },
    codex: { available: service.codexProvider.available, connected: service.codexProvider.connected },
    geminiCli: { available: service.geminiCliProvider.available, connected: service.geminiCliProvider.connected },
  };
}

function buildSnapshot(service, { lite = false } = {}) {
  return {
    app: { name: APP_NAME, version: VERSION },
    config: {
      model: service.model,
      repoRoot: service.repoRoot,
      activeChatId: service.activeChatId,
      configPath: service.config.path,
      apiKey: service.config.apiKey,
      geminiApiKey: service.config.geminiApiKey,
      openaiApiKey: service.config.openaiApiKey,
      promptPreset: service.promptPreset,
      toolSafetyMode: service.toolReadOnly ? "read" : "write",
      assistantMemory: service.config.assistantMemory || "",
      contextCarryMessages: service.config.contextCarryMessages ?? 5,
      remoteAccessEnabled: Boolean(service.config.remoteAccessEnabled),
      recentRepoRoots: Array.isArray(service.config.recentRepoRoots) ? service.config.recentRepoRoots : [],
    },
    providers: providersSnapshot(service),
    models: models(),
    chats: service.chatItems(),
    messages: lite ? [] : service.messages,
    changes: lite ? [] : service.workspaceChanges(service.repoRoot, {
      initialize: !service.suppressWorkspaceBaselineInit,
    }),
    activeChatChanges: lite ? [] : service.changes,
    activePlan: service.activePlan,
    files: lite ? [] : (typeof service.listFilesCached === "function"
      ? service.listFilesCached(service.repoRoot, 200)
      : service.files.listFiles(service.repoRoot, 200)),
    liveTerminalCommand: typeof service.liveTerminalCommand === "function"
      ? service.liveTerminalCommand()
      : "",
    providerName: providerNameForModel(service.model),
    runningChatIds: service.requestRegistry.ids(),
    resources: buildResourceSnapshot(service.requestRegistry),
    interruptedChatIds: [...service.interruptedRuns.keys()].sort(),
    interruptedRuns: [...service.interruptedRuns.values()].map((entry) => ({
      chatId: entry.chat_id,
      repoRoot: entry.repo_root,
      model: entry.model,
      lastUserMessage: entry.last_user_message,
      startedAt: entry.started_at,
      recoveredAt: entry.recovered_at || "",
    })),
  };
}

module.exports = {
  buildSnapshot,
  modelFamily,
  providerNameForModel,
  models,
};
