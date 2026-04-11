const {
  APP_NAME,
  VERSION,
  GEMINI_MODELS,
  GEMINI_CLI_MODELS,
  CLAUDE_MODELS,
  GROQ_MODELS,
  CODEX_MODELS,
} = require("./constants");

function modelFamily(model) {
  if (String(model).startsWith("claude:")) return "claude";
  if (String(model).startsWith("gemini-cli:")) return "gemini-cli";
  if (String(model).startsWith("gemini")) return "gemini";
  if (String(model).startsWith("codex:")) return "codex";
  return "groq";
}

function providerNameForModel(model) {
  if (String(model).startsWith("claude:")) return "Claude";
  if (String(model).startsWith("gemini-cli:")) return "Gemini CLI";
  if (String(model).startsWith("gemini")) return "Gemini";
  if (String(model).startsWith("codex:")) return "Codex";
  return "Groq";
}

function models() {
  return [
    ...GEMINI_MODELS.map(([id, label]) => ({ id, label, group: "Gemini" })),
    ...GEMINI_CLI_MODELS.map(([id, label]) => ({ id, label, group: "Gemini CLI" })),
    ...CLAUDE_MODELS.map(([id, label]) => ({ id, label, group: "Claude" })),
    ...GROQ_MODELS.map(([id, label]) => ({ id, label, group: "Groq" })),
    ...CODEX_MODELS.map(([id, label]) => ({ id, label, group: "Codex" })),
  ];
}

function providersSnapshot(service) {
  return {
    groq: { available: service.groqProvider.available, connected: service.groqProvider.connected },
    gemini: { available: service.geminiProvider.available, connected: service.geminiProvider.connected },
    geminiCli: { available: service.geminiCliProvider.available, connected: service.geminiCliProvider.connected },
    claude: { available: service.claudeProvider.available, connected: service.claudeProvider.connected },
    codex: { available: service.codexProvider.available, connected: service.codexProvider.connected },
  };
}

function buildSnapshot(service) {
  const workspaceChanges = service.workspaceChanges(service.repoRoot, {
    initialize: !service.suppressWorkspaceBaselineInit,
  });
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
    },
    providers: providersSnapshot(service),
    models: models(),
    chats: service.chatItems(),
    messages: service.messages,
    changes: workspaceChanges,
    activeChatChanges: service.changes,
    activePlan: service.activePlan,
    files: service.files.listFiles(service.repoRoot, 200),
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
