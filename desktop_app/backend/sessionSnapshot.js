const {
  APP_NAME,
  VERSION,
  AGY_MODELS,
  CLAUDE_MODELS,
  HERMES_MODELS,
  CODEX_MODELS,
} = require("./constants");
const { buildResourceSnapshot } = require("./resourceMonitor");
const { DEFAULT_PERMISSION_MODE, describePermissionMode } = require("./permissionModes");

function modelFamily(model) {
  if (String(model).startsWith("claude:")) return "claude";
  if (String(model).startsWith("hermes:")) return "hermes";
  if (String(model).startsWith("agy:")) return "agy";
  if (String(model).startsWith("gemini")) return "gemini";
  if (String(model).startsWith("codex:")) return "codex";
  return "groq";
}

function providerNameForModel(model) {
  if (String(model).startsWith("claude:")) return "Claude";
  if (String(model).startsWith("hermes:")) return "Hermes";
  if (String(model).startsWith("agy:")) return "Antigravity";
  if (String(model).startsWith("gemini")) return "Gemini";
  if (String(model).startsWith("codex:")) return "Codex";
  return "Groq";
}

const EFFORT_LABELS = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

// Prefer the live list from `codex app-server`; the constant is only a fallback
// for when the CLI hasn't answered yet.
function codexModels(service) {
  const live = service?.codexModels;
  if (Array.isArray(live) && live.length) {
    return live.flatMap((entry) =>
      (entry.efforts.length ? entry.efforts : [null]).map((effort) => ({
        id: effort ? `codex:${entry.model}:${effort}` : `codex:${entry.model}`,
        label: effort ? `${entry.displayName} · ${EFFORT_LABELS[effort] || effort}` : entry.displayName,
        group: "Codex",
        ...(effort ? { subGroup: entry.model } : {}),
      })),
    );
  }
  return CODEX_MODELS.map(([id, label]) => {
    const parts = id.split(":");
    const subGroup = parts.length >= 3 ? parts[1] : null;
    return { id, label, group: "Codex", ...(subGroup ? { subGroup } : {}) };
  });
}

// Antigravity: agy's default first, then the live `agy models` list (the
// constant until agy answers). Every entry has a subGroup (its base model) so
// the picker shows effort variants like Codex's.
function agyModels(service) {
  const live = service?.agyModels;
  if (!Array.isArray(live) || !live.length) {
    return AGY_MODELS.map(([id, label]) => {
      const name = id.slice("agy:".length);
      const effort = name.match(/-(minimal|low|medium|high|xhigh|max)$/);
      return { id, label, group: "Antigravity", subGroup: effort ? name.slice(0, -effort[0].length) : name };
    });
  }
  const [defaultId, defaultLabel] = AGY_MODELS[0];
  return [
    { id: defaultId, label: defaultLabel, group: "Antigravity", subGroup: "default" },
    ...live.map((entry) => ({
      id: `agy:${entry.model}`,
      label: entry.effort ? `${entry.displayName} · ${EFFORT_LABELS[entry.effort] || entry.effort}` : entry.displayName,
      group: "Antigravity",
      subGroup: entry.base || entry.model,
    })),
  ];
}

function models(service) {
  return [
    ...codexModels(service),
    ...CLAUDE_MODELS.map(([id, label]) => ({ id, label, group: "Claude" })),
    ...agyModels(service),
    ...HERMES_MODELS.map(([id, label]) => ({ id, label, group: "Hermes" })),
  ];
}

function providersSnapshot(service) {
  return {
    claude: { available: service.claudeProvider.available, connected: service.claudeProvider.connected },
    hermes: { available: service.hermesProvider?.available || false, connected: service.hermesProvider?.connected || false },
    codex: { available: service.codexProvider.available, connected: service.codexProvider.connected },
    antigravity: { available: service.agyProvider?.available || false, connected: service.agyProvider?.connected || false },
  };
}

// `includeChanges: false` returns empty `changes`/`activeChatChanges`; the
// workspace diff can be hundreds of KB and most pollers never show it.
function buildSnapshot(service, { lite = false, includeChanges = true } = {}) {
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
      permissionMode: service.permissionMode || DEFAULT_PERMISSION_MODE,
      // How the active chat's mode runs on the selected model (fallbacks
      // and their explanation for the composer).
      permissionModeInfo: describePermissionMode(
        service.model,
        service.permissionMode || DEFAULT_PERMISSION_MODE,
        { bridge: Boolean(service.approvalBridgeUrl) },
      ),
      assistantMemory: service.config.assistantMemory || "",
      contextCarryMessages: service.config.contextCarryMessages ?? 5,
      remoteAccessEnabled: Boolean(service.config.remoteAccessEnabled),
      recentRepoRoots: Array.isArray(service.config.recentRepoRoots) ? service.config.recentRepoRoots : [],
    },
    providers: providersSnapshot(service),
    models: models(service),
    chats: service.chatItems(),
    messages: lite ? [] : service.messages,
    changes: lite ? [] : service.workspaceChanges(service.repoRoot, {
      initialize: !service.suppressWorkspaceBaselineInit,
      diff: includeChanges,
    }),
    activeChatChanges: lite || !includeChanges ? [] : service.changes,
    activePlan: service.activePlan,
    files: lite ? [] : (typeof service.listFilesCached === "function"
      ? service.listFilesCached(service.repoRoot, 200)
      : service.files.listFiles(service.repoRoot, 200)),
    liveTerminalCommand: typeof service.liveTerminalCommand === "function"
      ? service.liveTerminalCommand()
      : "",
    providerName: providerNameForModel(service.model),
    runningChatIds: service.requestRegistry.ids(),
    pendingApprovals: service.approvalRegistry ? service.approvalRegistry.pending() : [],
    waitingChatIds: service.approvalRegistry ? service.approvalRegistry.waitingChatIds() : [],
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
