const fs = require("node:fs");
const path = require("node:path");
const { nowIso, normalizeMessages, normalizeChanges } = require("./sessionShared");

function initialRepoRoot(config) {
  if (config.repoRoot && fs.existsSync(config.repoRoot) && fs.statSync(config.repoRoot).isDirectory()) {
    return path.resolve(config.repoRoot);
  }
  return process.cwd();
}

function persistConfig(service) {
  service.config.repoRoot = service.repoRoot;
  service.config.activeChatId = service.activeChatId;
  service.config.model = service.model;
  service.config.promptPreset = service.promptPreset;
  service.config.toolSafetyMode = service.toolReadOnly ? "read" : "write";
  service.config.geminiSessionId = service.geminiCliProvider.sessionId || "";
  service.config.codexSessionId = service.codexProvider.sessionId || "";
  service.config.interruptedRuns = [...service.interruptedRuns.values()];
  service.config.save();
}

function recoverInterruptedRuns(service) {
  const activeRuns = Array.isArray(service.config.activeRuns) ? service.config.activeRuns : [];
  const interrupted = Array.isArray(service.config.interruptedRuns) ? service.config.interruptedRuns : [];
  for (const entry of interrupted) {
    if (entry?.chat_id) {
      service.interruptedRuns.set(entry.chat_id, { ...entry });
    }
  }
  for (const entry of activeRuns) {
    if (!entry?.chat_id) continue;
    service.interruptedRuns.set(entry.chat_id, { ...entry, recovered_at: nowIso() });
  }
  service.config.activeRuns = [];
  persistConfig(service);
}

function restoreActiveChat(service) {
  if (!service.config.activeChatId) {
    return;
  }
  const payload = service.chatStore.loadChat(service.config.activeChatId);
  if (!payload) {
    service.config.activeChatId = "";
    persistConfig(service);
    return;
  }
  service.activeChatId = service.config.activeChatId;
  service.activeChatModel = String(payload.model || "");
  service.messages = normalizeMessages(payload.messages);
  service.changes = normalizeChanges(payload.changes);
  service.toolReadOnly = String(payload.tool_safety_mode || "write") === "read";
  service.toolExecutor.readOnly = service.toolReadOnly;
}

function trackActiveRun(service, { chatId, repoRoot, model, lastUserMessage }) {
  service.config.activeRuns = [
    ...service.config.activeRuns.filter((entry) => entry.chat_id !== chatId),
    {
      chat_id: chatId,
      repo_root: repoRoot,
      model,
      last_user_message: lastUserMessage,
      started_at: nowIso(),
    },
  ];
  persistConfig(service);
}

function clearActiveRun(service, chatId) {
  service.config.activeRuns = service.config.activeRuns.filter((entry) => entry.chat_id !== chatId);
  persistConfig(service);
}

function saveCompletedChat(service, { chatStore, chatId, messages, model, providerState, toolSafetyMode, repoRoot, changes }) {
  chatStore.saveChat(chatId, messages, {
    model,
    providerState,
    changes,
    toolSafetyMode,
  });
  if (service.activeChatId === chatId && service.repoRoot === repoRoot) {
    service.messages = normalizeMessages(messages);
    service.changes = normalizeChanges(changes);
    service.activeChatModel = model;
  }
  service.requestRegistry.finish(chatId);
  clearActiveRun(service, chatId);
  service.interruptedRuns.delete(chatId);
  return service.snapshot();
}

module.exports = {
  initialRepoRoot,
  persistConfig,
  recoverInterruptedRuns,
  restoreActiveChat,
  trackActiveRun,
  clearActiveRun,
  saveCompletedChat,
};
