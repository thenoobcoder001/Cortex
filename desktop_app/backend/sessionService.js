const path = require("node:path");
const {
  DEFAULT_MODEL,
  PRESET_PROMPTS,
  BASE_ASSISTANT_SYSTEM_PROMPT,
} = require("./constants");
const { AppConfigStore } = require("./configStore");
const { ProjectChatStore } = require("./chatStore");
const { RepoFileService } = require("./fileService");
const { ToolExecutor } = require("./toolExecutor");
const { CodexProvider, GeminiCliProvider, GroqProvider, GeminiApiProvider } = require("./providers");
const { RequestRegistry } = require("./requestRegistry");
const { normalizeMessages, normalizeChanges } = require("./sessionShared");
const {
  buildSnapshot,
  modelFamily,
  providerNameForModel,
} = require("./sessionSnapshot");
const {
  initialRepoRoot,
  persistConfig,
  recoverInterruptedRuns,
  restoreActiveChat,
  trackActiveRun,
  clearActiveRun,
  saveCompletedChat,
} = require("./sessionPersistence");
const { sendMessageEvents } = require("./sessionSend");

class DesktopSessionService {
  constructor(overrides = {}) {
    this.config = overrides.config || AppConfigStore.load();
    this.repoRoot = path.resolve(overrides.repoRoot || initialRepoRoot(this.config));
    this.files = overrides.files || new RepoFileService(this.repoRoot);
    this.chatStore = overrides.chatStore || new ProjectChatStore(this.repoRoot);
    this.toolExecutor = overrides.toolExecutor || new ToolExecutor(this.files, this.repoRoot);
    this.groqProvider = overrides.groqProvider || new GroqProvider(this.config.apiKey || process.env.GROQ_API_KEY || "");
    this.geminiProvider = overrides.geminiProvider || new GeminiApiProvider(this.config.geminiApiKey || process.env.GEMINI_API_KEY || "");
    this.geminiCliProvider = overrides.geminiCliProvider || new GeminiCliProvider(this.repoRoot);
    this.codexProvider = overrides.codexProvider || new CodexProvider(this.repoRoot, this.config.openaiApiKey || process.env.OPENAI_API_KEY || "");
    this.geminiCliProvider.sessionId = this.config.geminiSessionId || "";
    this.geminiCliProvider.sessionMode = this.geminiCliProvider.sessionId ? "resume_id" : "fresh";
    this.codexProvider.sessionId = this.config.codexSessionId || "";
    this.codexProvider.sessionMode = this.codexProvider.sessionId ? "resume_id" : "fresh";
    this.model = this.config.model || DEFAULT_MODEL;
    this.promptPreset = this.config.promptPreset || "code";
    this.toolReadOnly = this.config.toolSafetyMode === "read";
    this.messages = [];
    this.changes = [];
    this.activeChatId = "";
    this.activeChatModel = "";
    this.interruptedRuns = new Map();
    this.requestRegistry = new RequestRegistry();
    recoverInterruptedRuns(this);
    restoreActiveChat(this);
  }

  modelFamily(model) {
    return modelFamily(model);
  }

  providerNameForModel(model) {
    return providerNameForModel(model);
  }

  persistConfig() {
    persistConfig(this);
  }

  trackActiveRun(payload) {
    trackActiveRun(this, payload);
  }

  clearActiveRun(chatId) {
    clearActiveRun(this, chatId);
  }

  saveCompletedChat(payload) {
    return saveCompletedChat(this, payload);
  }

  setRepoRoot(repoRoot) {
    const resolved = path.resolve(repoRoot);
    const [ok, message] = this.files.setRepoRoot(resolved);
    if (!ok) {
      throw new Error(message);
    }
    this.repoRoot = this.files.repoRoot;
    this.chatStore.setRepoRoot(this.repoRoot);
    this.toolExecutor.setRepoRoot(this.repoRoot);
    this.geminiCliProvider.setRepoRoot(this.repoRoot);
    this.codexProvider.setRepoRoot(this.repoRoot);
    this.activeChatId = "";
    this.activeChatModel = "";
    this.messages = [];
    this.changes = [];
    this.persistConfig();
  }

  chatItems(chatStore = this.chatStore) {
    return chatStore.listChats().map((chat) => ({
      ...chat,
      interrupted: this.interruptedRuns.has(chat.chatId),
    }));
  }

  snapshot() {
    return buildSnapshot(this);
  }

  listChats(repoRoot = null) {
    const store = repoRoot ? new ProjectChatStore(path.resolve(repoRoot)) : this.chatStore;
    return this.chatItems(store);
  }

  newChat(repoRoot = null) {
    if (repoRoot) {
      this.setRepoRoot(repoRoot);
    }
    this.messages = [];
    this.changes = [];
    this.activeChatId = "";
    this.activeChatModel = "";
    this.geminiCliProvider.sessionId = "";
    this.geminiCliProvider.sessionMode = "fresh";
    this.codexProvider.sessionId = "";
    this.codexProvider.sessionMode = "fresh";
    this.persistConfig();
    return this.snapshot();
  }

  activateChat(chatId, repoRoot = null) {
    if (repoRoot && path.resolve(repoRoot) !== this.repoRoot) {
      this.setRepoRoot(repoRoot);
    }
    const payload = this.chatStore.loadChat(chatId);
    if (!payload) {
      throw new Error(`Chat not found: ${chatId}`);
    }
    this.activeChatId = chatId;
    this.activeChatModel = String(payload.model || "");
    this.messages = normalizeMessages(payload.messages);
    this.changes = normalizeChanges(payload.changes);
    this.toolReadOnly = String(payload.tool_safety_mode || "write") === "read";
    this.toolExecutor.readOnly = this.toolReadOnly;
    this.persistConfig();
    return this.snapshot();
  }

  deleteChat(chatId, repoRoot = null) {
    if (this.requestRegistry.has(chatId)) {
      throw new Error("Cannot delete a chat while it is still running.");
    }
    const store = repoRoot ? new ProjectChatStore(path.resolve(repoRoot)) : this.chatStore;
    if (!store.deleteChat(chatId)) {
      throw new Error(`Chat could not be deleted: ${chatId}`);
    }
    if (this.activeChatId === chatId && (!repoRoot || path.resolve(repoRoot) === this.repoRoot)) {
      this.activeChatId = "";
      this.activeChatModel = "";
      this.messages = [];
      this.changes = [];
    }
    this.interruptedRuns.delete(chatId);
    this.persistConfig();
    return this.snapshot();
  }

  interruptChat(chatId) {
    if (!chatId) {
      throw new Error("Chat id is required.");
    }
    if (!this.requestRegistry.interrupt(chatId)) {
      throw new Error("Chat is not currently running.");
    }
    return this.snapshot();
  }

  updateConfig({ model = null, repoRoot = null, apiKey = null, geminiApiKey = null, openaiApiKey = null, promptPreset = null, assistantMemory = null, contextCarryMessages = null } = {}) {
    if (repoRoot) {
      this.setRepoRoot(repoRoot);
    }
    if (model != null) {
      this.model = String(model || "").trim() || DEFAULT_MODEL;
    }
    if (apiKey != null) {
      this.config.apiKey = String(apiKey || "").trim();
      this.groqProvider.setApiKey(this.config.apiKey);
    }
    if (geminiApiKey != null) {
      this.config.geminiApiKey = String(geminiApiKey || "").trim();
      this.geminiProvider.setApiKey(this.config.geminiApiKey);
    }
    if (openaiApiKey != null) {
      this.config.openaiApiKey = String(openaiApiKey || "").trim();
      this.codexProvider.setApiKey(this.config.openaiApiKey);
    }
    if (promptPreset != null) {
      this.promptPreset = String(promptPreset || "code").trim() || "code";
    }
    if (assistantMemory != null) {
      this.config.assistantMemory = String(assistantMemory || "");
    }
    if (contextCarryMessages != null) {
      this.config.contextCarryMessages = Math.max(0, Math.min(Number(contextCarryMessages) || 0, 20));
    }
    this.persistConfig();
    return this.snapshot();
  }

  updateChatPreferences({ toolSafetyMode, chatId = null, repoRoot = null }) {
    const normalizedMode = String(toolSafetyMode || "write").trim().toLowerCase() === "read" ? "read" : "write";
    if (chatId) {
      const store = repoRoot ? new ProjectChatStore(path.resolve(repoRoot)) : this.chatStore;
      const payload = store.loadChat(chatId);
      if (!payload) {
        throw new Error(`Chat not found: ${chatId}`);
      }
      store.saveChat(chatId, normalizeMessages(payload.messages), {
        model: String(payload.model || DEFAULT_MODEL),
        providerState: payload.provider_state || {},
        changes: normalizeChanges(payload.changes),
        toolSafetyMode: normalizedMode,
      });
      if (this.activeChatId === chatId) {
        this.toolReadOnly = normalizedMode === "read";
        this.toolExecutor.readOnly = this.toolReadOnly;
      }
    } else {
      this.toolReadOnly = normalizedMode === "read";
      this.toolExecutor.readOnly = this.toolReadOnly;
    }
    this.persistConfig();
    return this.snapshot();
  }

  readFile(rawPath) {
    const [filePath, error] = this.files.resolveRepoPath(rawPath);
    if (!filePath) {
      throw new Error(error);
    }
    const [content, truncated] = this.files.readUtf8(filePath);
    return { path: filePath, content, truncated };
  }

  event(type, payload = {}) {
    return { type, ...payload };
  }

  providerForRequest(model) {
    if (String(model).startsWith("gemini-cli:")) return this.geminiCliProvider;
    if (String(model).startsWith("gemini")) return this.geminiProvider;
    if (String(model).startsWith("codex:")) return this.codexProvider;
    return this.groqProvider;
  }

  requestUsesTools(model, message, preset) {
    if (String(model).startsWith("gemini-cli:") || String(model).startsWith("codex:")) {
      return false;
    }
    if (preset === "chat") {
      return false;
    }
    return /\b(file|repo|folder|directory|edit|change|create|delete|rename|fix|implement|run|terminal|command|diff|read)\b/i.test(message);
  }

  effectivePromptPreset(message, preset) {
    if (/^(hi|hello|hey|yo|sup)\b/i.test(String(message || "").trim())) {
      return "chat";
    }
    return preset;
  }

  messagesWithContext(messages, promptPreset) {
    const systemParts = [BASE_ASSISTANT_SYSTEM_PROMPT];
    const presetPrompt = PRESET_PROMPTS[promptPreset] || "";
    if (presetPrompt) {
      systemParts.push(presetPrompt);
    }
    if (this.config.assistantMemory) {
      systemParts.push(`Assistant memory:\n${this.config.assistantMemory}`);
    }
    return [{ role: "system", content: systemParts.join("\n\n") }, ...messages];
  }

  recentChatContext(messages, limit = 5) {
    return messages.filter((message) => ["user", "assistant"].includes(String(message.role || ""))).slice(-limit);
  }

  captureRepoState(repoRoot) {
    return new RepoFileService(repoRoot).snapshotRepoState(repoRoot);
  }

  finalRepoChanges(repoRoot, beforeState) {
    const fileService = new RepoFileService(repoRoot);
    return normalizeChanges(fileService.diffRepoState(beforeState, fileService.snapshotRepoState(repoRoot)));
  }

  async *sendMessageEvents(text, options = {}) {
    yield* sendMessageEvents(this, text, options);
  }

  async sendMessage(text, options = {}) {
    let completed = null;
    for await (const event of this.sendMessageEvents(text, options)) {
      if (event.type === "completed") {
        completed = event;
      }
    }
    if (!completed) {
      throw new Error("Send completed without a final completion event.");
    }
    return {
      assistantMessage: completed.assistantMessage,
      elapsedSeconds: completed.elapsedSeconds,
      usedTools: completed.usedTools,
      snapshot: completed.snapshot,
    };
  }
}

module.exports = {
  DesktopSessionService,
};
