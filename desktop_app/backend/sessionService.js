const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_MODEL,
  PRESET_PROMPTS,
  BASE_ASSISTANT_SYSTEM_PROMPT,
  GROQ_MODELS,
  GEMINI_MODELS,
  GEMINI_CLI_MODELS,
  CODEX_MODELS,
} = require("./constants");
const { AppConfigStore, normalizeContextCarryMessages, normalizeRecentRepoRoots } = require("./configStore");
const { ProjectChatStore } = require("./chatStore");
const { RepoFileService } = require("./fileService");
const { ToolExecutor } = require("./toolExecutor");
const { CodexProvider, GeminiCliProvider, ClaudeCliProvider, GroqProvider, GeminiApiProvider } = require("./providers");
const { RequestRegistry } = require("./requestRegistry");
const { normalizeMessages, normalizeChanges, normalizePlan } = require("./sessionShared");
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
    this.claudeProvider = overrides.claudeProvider || new ClaudeCliProvider(this.repoRoot);
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
    this.activePlan = null;
    this.activeChatId = "";
    this.activeChatModel = "";
    this.interruptedRuns = new Map();
    this.requestRegistry = new RequestRegistry();
    this.snapshotCacheTtlMs = 1500;
    this.snapshotCache = {
      workspaceChanges: new Map(),
      fileLists: new Map(),
    };
    this.rememberRepoRoot(this.repoRoot);
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

  snapshotCacheKey(repoRoot, extra = "") {
    return `${path.resolve(repoRoot)}::${extra}`;
  }

  getCachedValue(cache, key) {
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.timestamp > this.snapshotCacheTtlMs) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  setCachedValue(cache, key, value) {
    cache.set(key, {
      timestamp: Date.now(),
      value,
    });
    return value;
  }

  rememberRepoRoot(repoRoot) {
    const normalized = path.resolve(repoRoot);
    this.config.recentRepoRoots = normalizeRecentRepoRoots([
      normalized,
      ...(Array.isArray(this.config.recentRepoRoots) ? this.config.recentRepoRoots : []),
    ]);
  }

  invalidateSnapshotCaches(repoRoot = null) {
    if (!repoRoot) {
      this.snapshotCache.workspaceChanges.clear();
      this.snapshotCache.fileLists.clear();
      return;
    }
    const prefix = `${path.resolve(repoRoot)}::`;
    for (const key of [...this.snapshotCache.workspaceChanges.keys()]) {
      if (key.startsWith(prefix)) {
        this.snapshotCache.workspaceChanges.delete(key);
      }
    }
    for (const key of [...this.snapshotCache.fileLists.keys()]) {
      if (key.startsWith(prefix)) {
        this.snapshotCache.fileLists.delete(key);
      }
    }
  }

  listFilesCached(repoRoot = this.repoRoot, limit = 200) {
    const targetRoot = path.resolve(repoRoot);
    const cacheKey = this.snapshotCacheKey(targetRoot, `files:${limit}`);
    const cached = this.getCachedValue(this.snapshotCache.fileLists, cacheKey);
    if (cached) {
      return cached;
    }
    return this.setCachedValue(
      this.snapshotCache.fileLists,
      cacheKey,
      this.files.listFiles(targetRoot, limit),
    );
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
    this.claudeProvider.setRepoRoot(this.repoRoot);
    this.codexProvider.setRepoRoot(this.repoRoot);
    this.activeChatId = "";
    this.activeChatModel = "";
    this.messages = [];
    this.changes = [];
    this.activePlan = null;
    this.invalidateSnapshotCaches();
    this.rememberRepoRoot(this.repoRoot);
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

  getChatMessages(chatId, repoRoot = null, { before = null, limit = 40 } = {}) {
    if (!chatId) {
      throw new Error("Chat id is required.");
    }
    const store = repoRoot ? new ProjectChatStore(path.resolve(repoRoot)) : this.chatStore;
    const payload = store.loadChat(chatId);
    if (!payload) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    const messages = normalizeMessages(payload.messages);
    const total = messages.length;
    const normalizedLimit = Math.min(Math.max(Number(limit) || 40, 1), 200);
    const normalizedBefore = before == null ? total : Math.min(Math.max(Number(before) || 0, 0), total);
    const start = Math.max(0, normalizedBefore - normalizedLimit);
    const page = messages.slice(start, normalizedBefore);

    return {
      chatId,
      messages: page,
      total,
      hasMore: start > 0,
      nextBefore: start > 0 ? start : null,
    };
  }

  newChat(repoRoot = null) {
    if (repoRoot) {
      this.setRepoRoot(repoRoot);
    }
    this.messages = [];
    this.changes = [];
    this.activePlan = null;
    this.activeChatId = "";
    this.activeChatModel = "";
    this.geminiCliProvider.sessionId = "";
    this.geminiCliProvider.sessionMode = "fresh";
    this.claudeProvider.sessionId = "";
    this.claudeProvider.sessionMode = "fresh";
    this.codexProvider.sessionId = "";
    this.codexProvider.sessionMode = "fresh";
    this.invalidateSnapshotCaches(this.repoRoot);
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
    this.activePlan = normalizePlan(payload.plan);
    this.toolReadOnly = String(payload.tool_safety_mode || "write") === "read";
    this.toolExecutor.readOnly = this.toolReadOnly;
    this.persistConfig();
    return this.snapshot();
  }

  deleteChat(chatId, repoRoot = null) {
    if (this.requestRegistry.has(chatId)) {
      // Interrupt the running request and force-remove it from the registry so
      // the delete can proceed immediately. On Windows, taskkill is async and the
      // child.close event can take several seconds — waiting for the request
      // handler to call finish() would make every delete of a live chat fail.
      // The request handler's catch block will still run but all its cleanup
      // calls (registry.finish, clearActiveRun, interruptedRuns) are idempotent.
      this.requestRegistry.interrupt(chatId);
      this.requestRegistry.finish(chatId);
      this.config.activeRuns = (this.config.activeRuns || []).filter((r) => r.chat_id !== chatId);
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
      this.activePlan = null;
    }
    this.invalidateSnapshotCaches(repoRoot ? path.resolve(repoRoot) : this.repoRoot);
    this.interruptedRuns.delete(chatId);
    this.persistConfig();
    return this.snapshot();
  }

  renameChat(chatId, title, repoRoot = null) {
    const store = repoRoot ? new ProjectChatStore(path.resolve(repoRoot)) : this.chatStore;
    const renamedTitle = store.renameChat(chatId, title);
    if (!renamedTitle) {
      throw new Error(`Chat not found: ${chatId}`);
    }
    this.invalidateSnapshotCaches(repoRoot ? path.resolve(repoRoot) : this.repoRoot);
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

  clearLocalData(repoRoots = []) {
    if (this.requestRegistry.ids().length > 0) {
      throw new Error("Stop running chats before clearing local data.");
    }

    const uniqueRoots = [...new Set(
      [this.repoRoot, ...repoRoots]
        .map((repoRoot) => String(repoRoot || "").trim())
        .filter(Boolean)
        .map((repoRoot) => path.resolve(repoRoot)),
    )];

    for (const repoRoot of uniqueRoots) {
      const target = path.join(repoRoot, ".cortex");
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      } catch {
        // Ignore individual project cleanup failures and continue.
      }
    }

    this.config.reset();
    this.config.deleteFile();
    this.repoRoot = uniqueRoots[0] || process.cwd();
    this.files.setRepoRoot(this.repoRoot);
    this.chatStore.setRepoRoot(this.repoRoot);
    this.toolExecutor.setRepoRoot(this.repoRoot);
    this.geminiCliProvider.setRepoRoot(this.repoRoot);
    this.claudeProvider.setRepoRoot(this.repoRoot);
    this.codexProvider.setRepoRoot(this.repoRoot);
    this.geminiCliProvider.sessionId = "";
    this.geminiCliProvider.sessionMode = "fresh";
    this.claudeProvider.sessionId = "";
    this.claudeProvider.sessionMode = "fresh";
    this.codexProvider.sessionId = "";
    this.codexProvider.sessionMode = "fresh";
    this.groqProvider.setApiKey("");
    this.geminiProvider.setApiKey("");
    this.codexProvider.setApiKey("");
    this.model = DEFAULT_MODEL;
    this.promptPreset = "code";
    this.toolReadOnly = false;
    this.messages = [];
    this.changes = [];
    this.activePlan = null;
    this.activeChatId = "";
    this.activeChatModel = "";
    this.interruptedRuns.clear();
    this.invalidateSnapshotCaches();
    this.suppressWorkspaceBaselineInit = true;
    try {
      const snapshot = this.snapshot();
      for (const repoRoot of uniqueRoots) {
        const target = path.join(repoRoot, ".cortex");
        try {
          if (fs.existsSync(target)) {
            fs.rmSync(target, { recursive: true, force: true });
          }
        } catch {
          // Ignore cleanup failures after snapshot generation.
        }
      }
      return snapshot;
    } finally {
      this.suppressWorkspaceBaselineInit = false;
    }
  }

  deleteSettingsFile() {
    if (this.requestRegistry.ids().length > 0) {
      throw new Error("Stop running chats before deleting the settings file.");
    }

    this.config.reset();
    this.config.deleteFile();
    this.groqProvider.setApiKey("");
    this.geminiProvider.setApiKey("");
    this.codexProvider.setApiKey("");
    this.geminiCliProvider.sessionId = "";
    this.geminiCliProvider.sessionMode = "fresh";
    this.claudeProvider.sessionId = "";
    this.claudeProvider.sessionMode = "fresh";
    this.codexProvider.sessionId = "";
    this.codexProvider.sessionMode = "fresh";
    this.model = DEFAULT_MODEL;
    this.promptPreset = "code";
    this.toolReadOnly = false;
    this.activeChatId = "";
    this.activeChatModel = "";
    this.messages = [];
    this.changes = [];
    this.activePlan = null;
    this.interruptedRuns.clear();
    this.invalidateSnapshotCaches();

    return this.snapshot();
  }

  updateConfig({ model = null, repoRoot = null, apiKey = null, geminiApiKey = null, openaiApiKey = null, promptPreset = null, assistantMemory = null, contextCarryMessages = null, remoteAccessEnabled = null } = {}) {
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
      this.config.contextCarryMessages = normalizeContextCarryMessages(contextCarryMessages, 0);
    }
    if (remoteAccessEnabled != null) {
      this.config.remoteAccessEnabled = Boolean(remoteAccessEnabled);
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
    if (String(model).startsWith("claude:")) return this.claudeProvider;
    if (String(model).startsWith("gemini-cli:")) return this.geminiCliProvider;
    if (String(model).startsWith("gemini")) return this.geminiProvider;
    if (String(model).startsWith("codex:")) return this.codexProvider;
    return this.groqProvider;
  }

  requestUsesTools(model, message, preset) {
    if (String(model).startsWith("gemini-cli:") || String(model).startsWith("codex:") || String(model).startsWith("claude:")) {
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

  workspaceChanges(repoRoot = this.repoRoot, { initialize = true } = {}) {
    const targetRoot = path.resolve(repoRoot);
    const store = targetRoot === this.repoRoot
      ? this.chatStore
      : new ProjectChatStore(targetRoot);
    let acceptedState = store.loadAcceptedRepoState();
    if (!acceptedState) {
      if (!initialize) {
        return [];
      }
      acceptedState = this.captureRepoState(targetRoot);
      store.saveAcceptedRepoState(acceptedState);
      return [];
    }
    return normalizeChanges(new RepoFileService(targetRoot).diffRepoState(
        acceptedState,
        this.captureRepoState(targetRoot),
      ));
  }

  acceptWorkspaceChanges(repoRoot = null) {
    const targetRoot = path.resolve(repoRoot || this.repoRoot);
    const store = targetRoot === this.repoRoot ? this.chatStore : new ProjectChatStore(targetRoot);
    store.saveAcceptedRepoState(this.captureRepoState(targetRoot));
    this.invalidateSnapshotCaches(targetRoot);
    return this.snapshot();
  }

  revertWorkspaceChanges(repoRoot = null) {
    const targetRoot = path.resolve(repoRoot || this.repoRoot);
    const store = targetRoot === this.repoRoot ? this.chatStore : new ProjectChatStore(targetRoot);
    const acceptedState = store.loadAcceptedRepoState();
    if (!acceptedState) {
      throw new Error("No accepted workspace baseline exists for this project.");
    }

    const currentState = this.captureRepoState(targetRoot);
    const allPaths = new Set([...Object.keys(currentState), ...Object.keys(acceptedState)]);
    for (const relativePath of [...allPaths].sort()) {
      const baseline = acceptedState[relativePath];
      const current = currentState[relativePath];
      const fullPath = path.join(targetRoot, relativePath);

      if (!baseline && current) {
        if (fs.existsSync(fullPath)) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
        continue;
      }

      if (!baseline) {
        continue;
      }

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      if (baseline.text == null) {
        continue;
      }
      fs.writeFileSync(fullPath, baseline.text, "utf8");
    }

    this.invalidateSnapshotCaches(targetRoot);
    return this.snapshot();
  }

  async testProviderConnection({
    providerId,
    apiKey = null,
    geminiApiKey = null,
    openaiApiKey = null,
  } = {}) {
    const normalized = String(providerId || "").trim();
    const messages = [{ role: "user", content: "Reply with exactly: OK" }];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      if (normalized === "groq") {
        const previous = this.groqProvider.apiKey;
        if (apiKey != null) {
          this.groqProvider.setApiKey(apiKey);
        }
        try {
          if (!this.groqProvider.connected) {
            throw new Error("Groq API key is missing.");
          }
          const reply = await this.groqProvider.chatCompletion(messages, GROQ_MODELS[0][0], {
            signal: controller.signal,
          });
          return {
            ok: true,
            providerId: normalized,
            message: String(reply || "OK").trim().slice(0, 120),
          };
        } finally {
          this.groqProvider.setApiKey(previous);
        }
      }

      if (normalized === "gemini") {
        const previous = this.geminiProvider.apiKey;
        if (geminiApiKey != null) {
          this.geminiProvider.setApiKey(geminiApiKey);
        }
        try {
          if (!this.geminiProvider.connected) {
            throw new Error("Gemini API key is missing.");
          }
          const reply = await this.geminiProvider.chatCompletion(messages, GEMINI_MODELS[0][0], {
            signal: controller.signal,
          });
          return {
            ok: true,
            providerId: normalized,
            message: String(reply || "OK").trim().slice(0, 120),
          };
        } finally {
          this.geminiProvider.setApiKey(previous);
        }
      }

      if (normalized === "geminiCli") {
        if (!this.geminiCliProvider.available) {
          throw new Error("Gemini CLI is not available in PATH.");
        }
        const reply = await this.geminiCliProvider.chatCompletion(messages, GEMINI_CLI_MODELS[0][0], {
          signal: controller.signal,
        });
        return {
          ok: true,
          providerId: normalized,
          message: String(reply || "OK").trim().slice(0, 120),
        };
      }

      if (normalized === "claude") {
        if (!this.claudeProvider.available) {
          throw new Error("Claude CLI is not available in PATH.");
        }
        const reply = await this.claudeProvider.chatCompletion(messages, "claude:sonnet", {
          signal: controller.signal,
        });
        return {
          ok: true,
          providerId: normalized,
          message: String(reply || "OK").trim().slice(0, 120),
        };
      }

      if (normalized === "codex") {
        const previous = this.codexProvider.apiKey;
        if (openaiApiKey != null) {
          this.codexProvider.setApiKey(openaiApiKey);
        }
        try {
          if (!this.codexProvider.available) {
            throw new Error("Codex is not available. Install the CLI or configure access.");
          }
          const reply = await this.codexProvider.chatCompletion(messages, CODEX_MODELS[0][0], {
            signal: controller.signal,
          });
          return {
            ok: true,
            providerId: normalized,
            message: String(reply || "OK").trim().slice(0, 120),
          };
        } finally {
          this.codexProvider.setApiKey(previous);
        }
      }

      throw new Error("Unsupported provider.");
    } finally {
      clearTimeout(timeout);
    }
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
