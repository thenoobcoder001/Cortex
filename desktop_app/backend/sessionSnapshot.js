const {
  APP_NAME,
  VERSION,
  GEMINI_CLI_MODELS,
  AGY_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
} = require("./constants");

function modelFamily(model) {
  if (String(model).startsWith("claude:")) return "claude";
  if (String(model).startsWith("gemini-cli:")) return "gemini-cli";
  if (String(model).startsWith("agy:")) return "agy";
  if (String(model).startsWith("gemini")) return "gemini";
  if (String(model).startsWith("codex:")) return "codex";
  return "groq";
}

function providerNameForModel(model) {
  if (String(model).startsWith("claude:")) return "Claude";
  if (String(model).startsWith("gemini-cli:")) return "Gemini CLI";
  if (String(model).startsWith("agy:")) return "Agy";
  if (String(model).startsWith("gemini")) return "Gemini";
  if (String(model).startsWith("codex:")) return "Codex";
  return "Groq";
}

function models({ includeAgy = true } = {}) {
  return [
    ...CODEX_MODELS.map(([id, label]) => {
      // id format: codex:gpt-5.5:xhigh → subGroup = "gpt-5.5"
      const parts = id.split(":");
      const subGroup = parts.length >= 3 ? parts[1] : null;
      return { id, label, group: "Codex", ...(subGroup ? { subGroup } : {}) };
    }),
    ...CLAUDE_MODELS.map(([id, label]) => ({ id, label, group: "Claude" })),
    ...GEMINI_CLI_MODELS.map(([id, label]) => ({ id, label, group: "Gemini CLI (Legacy)" })),
    // AGY is desktop-only — excluded from mobile snapshot
    ...(includeAgy ? AGY_MODELS.map(([id, label]) => ({ id, label, group: "Antigravity" })) : []),
  ];
}

function providersSnapshot(service, { includeAgy = true } = {}) {
  return {
    claude: { available: service.claudeProvider.available, connected: service.claudeProvider.connected },
    codex: { available: service.codexProvider.available, connected: service.codexProvider.connected },
    geminiCli: { available: service.geminiCliProvider.available, connected: service.geminiCliProvider.connected },
    agy: includeAgy
      ? { available: service.agyProvider.available, connected: service.agyProvider.connected }
      : { available: false, connected: false },
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
    providers: providersSnapshot(service, { includeAgy: !lite }),
    models: models({ includeAgy: !lite }),
    chats: service.chatItems(),
    messages: lite ? [] : service.messages,
    // Skip expensive file diff and file tree when lite — saves 3-4 seconds per call.
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
