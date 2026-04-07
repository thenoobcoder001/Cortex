const fs = require("node:fs");
const path = require("node:path");
const {
  APP_NAME,
  VERSION,
  DEFAULT_MODEL,
  MAX_TOOL_ROUNDS,
  PRESET_PROMPTS,
  BASE_ASSISTANT_SYSTEM_PROMPT,
  GEMINI_MODELS,
  GEMINI_CLI_MODELS,
  GROQ_MODELS,
  CODEX_MODELS,
  TOOLS,
} = require("./constants");
const { AppConfigStore } = require("./configStore");
const { ProjectChatStore } = require("./chatStore");
const { RepoFileService } = require("./fileService");
const { ToolExecutor } = require("./toolExecutor");
const { CodexProvider, GeminiCliProvider, GroqProvider, GeminiApiProvider } = require("./providers");

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function normalizeMessages(messages) {
  return Array.isArray(messages) ? messages.filter((message) => message && message.role).map((message) => ({ ...message })) : [];
}

function normalizeChanges(changes) {
  return Array.isArray(changes)
    ? changes
        .filter((change) => change && change.action && change.path)
        .map((change) => ({
          action: String(change.action),
          path: String(change.path),
          oldPath: String(change.oldPath || ""),
          newPath: String(change.newPath || ""),
          diff: String(change.diff || ""),
        }))
    : [];
}

class DesktopSessionService {
  constructor() {
    this.config = AppConfigStore.load();
    this.repoRoot = this.initialRepoRoot();
    this.files = new RepoFileService(this.repoRoot);
    this.chatStore = new ProjectChatStore(this.repoRoot);
    this.toolExecutor = new ToolExecutor(this.files, this.repoRoot);
    this.groqProvider = new GroqProvider(this.config.apiKey || process.env.GROQ_API_KEY || "");
    this.geminiProvider = new GeminiApiProvider(this.config.geminiApiKey || process.env.GEMINI_API_KEY || "");
    this.geminiCliProvider = new GeminiCliProvider(this.repoRoot);
    this.geminiCliProvider.sessionId = this.config.geminiSessionId || "";
    this.geminiCliProvider.sessionMode = this.geminiCliProvider.sessionId ? "resume_id" : "fresh";
    this.codexProvider = new CodexProvider(this.repoRoot, this.config.openaiApiKey || process.env.OPENAI_API_KEY || "");
    this.codexProvider.sessionId = this.config.codexSessionId || "";
    this.codexProvider.sessionMode = this.codexProvider.sessionId ? "resume_id" : "fresh";
    this.model = this.config.model || DEFAULT_MODEL;
    this.promptPreset = this.config.promptPreset || "code";
    this.toolReadOnly = this.config.toolSafetyMode === "read";
    this.messages = [];
    this.changes = [];
    this.activeChatId = "";
    this.activeChatModel = "";
    this.runningChatIds = new Set();
    this.interruptedRuns = new Map();
    this.recoverInterruptedRuns();
    this.restoreActiveChat();
  }

  initialRepoRoot() {
    if (this.config.repoRoot && fs.existsSync(this.config.repoRoot) && fs.statSync(this.config.repoRoot).isDirectory()) {
      return path.resolve(this.config.repoRoot);
    }
    return process.cwd();
  }

  modelFamily(model) {
    if (String(model).startsWith("gemini-cli:")) return "gemini-cli";
    if (String(model).startsWith("gemini")) return "gemini";
    if (String(model).startsWith("codex:")) return "codex";
    return "groq";
  }

  providerNameForModel(model) {
    if (String(model).startsWith("gemini-cli:")) return "Gemini CLI";
    if (String(model).startsWith("gemini")) return "Gemini";
    if (String(model).startsWith("codex:")) return "Codex";
    return "Groq";
  }

  models() {
    return [
      ...GEMINI_MODELS.map(([id, label]) => ({ id, label, group: "Gemini" })),
      ...GEMINI_CLI_MODELS.map(([id, label]) => ({ id, label, group: "Gemini CLI" })),
      ...GROQ_MODELS.map(([id, label]) => ({ id, label, group: "Groq" })),
      ...CODEX_MODELS.map(([id, label]) => ({ id, label, group: "Codex" })),
    ];
  }

  providers() {
    return {
      groq: { available: this.groqProvider.available, connected: this.groqProvider.connected },
      gemini: { available: this.geminiProvider.available, connected: this.geminiProvider.connected },
      geminiCli: { available: this.geminiCliProvider.available, connected: this.geminiCliProvider.connected },
      codex: { available: this.codexProvider.available, connected: this.codexProvider.connected },
    };
  }

  persistConfig() {
    this.config.repoRoot = this.repoRoot;
    this.config.activeChatId = this.activeChatId;
    this.config.model = this.model;
    this.config.promptPreset = this.promptPreset;
    this.config.toolSafetyMode = this.toolReadOnly ? "read" : "write";
    this.config.geminiSessionId = this.geminiCliProvider.sessionId || "";
    this.config.codexSessionId = this.codexProvider.sessionId || "";
    this.config.interruptedRuns = [...this.interruptedRuns.values()];
    this.config.save();
  }

  recoverInterruptedRuns() {
    const activeRuns = Array.isArray(this.config.activeRuns) ? this.config.activeRuns : [];
    const interrupted = Array.isArray(this.config.interruptedRuns) ? this.config.interruptedRuns : [];
    for (const entry of interrupted) {
      if (entry?.chat_id) {
        this.interruptedRuns.set(entry.chat_id, { ...entry });
      }
    }
    for (const entry of activeRuns) {
      if (!entry?.chat_id) continue;
      this.interruptedRuns.set(entry.chat_id, { ...entry, recovered_at: nowIso() });
    }
    this.config.activeRuns = [];
    this.persistConfig();
  }

  restoreActiveChat() {
    if (!this.config.activeChatId) {
      return;
    }
    const payload = this.chatStore.loadChat(this.config.activeChatId);
    if (!payload) {
      this.config.activeChatId = "";
      this.persistConfig();
      return;
    }
    this.activeChatId = this.config.activeChatId;
    this.activeChatModel = String(payload.model || "");
    this.messages = normalizeMessages(payload.messages);
    this.changes = normalizeChanges(payload.changes);
    this.toolReadOnly = String(payload.tool_safety_mode || "write") === "read";
    this.toolExecutor.readOnly = this.toolReadOnly;
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
    return {
      app: { name: APP_NAME, version: VERSION },
      config: {
        model: this.model,
        repoRoot: this.repoRoot,
        activeChatId: this.activeChatId,
        apiKey: this.config.apiKey,
        geminiApiKey: this.config.geminiApiKey,
        openaiApiKey: this.config.openaiApiKey,
        promptPreset: this.promptPreset,
        toolSafetyMode: this.toolReadOnly ? "read" : "write",
        assistantMemory: this.config.assistantMemory || "",
        contextCarryMessages: this.config.contextCarryMessages || 5,
      },
      providers: this.providers(),
      models: this.models(),
      chats: this.chatItems(),
      messages: this.messages,
      changes: this.changes,
      files: this.files.listFiles(this.repoRoot, 200),
      providerName: this.providerNameForModel(this.model),
      runningChatIds: [...this.runningChatIds].sort(),
      interruptedChatIds: [...this.interruptedRuns.keys()].sort(),
      interruptedRuns: [...this.interruptedRuns.values()].map((entry) => ({
        chatId: entry.chat_id,
        repoRoot: entry.repo_root,
        model: entry.model,
        lastUserMessage: entry.last_user_message,
        startedAt: entry.started_at,
        recoveredAt: entry.recovered_at || "",
      })),
    };
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
    if (this.runningChatIds.has(chatId)) {
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

  trackActiveRun({ chatId, repoRoot, model, lastUserMessage }) {
    this.config.activeRuns = [
      ...this.config.activeRuns.filter((entry) => entry.chat_id !== chatId),
      {
        chat_id: chatId,
        repo_root: repoRoot,
        model,
        last_user_message: lastUserMessage,
        started_at: nowIso(),
      },
    ];
    this.persistConfig();
  }

  clearActiveRun(chatId) {
    this.config.activeRuns = this.config.activeRuns.filter((entry) => entry.chat_id !== chatId);
    this.persistConfig();
  }

  captureRepoState(repoRoot) {
    return new RepoFileService(repoRoot).snapshotRepoState(repoRoot);
  }

  finalRepoChanges(repoRoot, beforeState) {
    const fileService = new RepoFileService(repoRoot);
    return normalizeChanges(fileService.diffRepoState(beforeState, fileService.snapshotRepoState(repoRoot)));
  }

  saveCompletedChat({ chatStore, chatId, messages, model, providerState, toolSafetyMode, repoRoot, changes }) {
    chatStore.saveChat(chatId, messages, {
      model,
      providerState,
      changes,
      toolSafetyMode,
    });
    if (this.activeChatId === chatId && this.repoRoot === repoRoot) {
      this.messages = normalizeMessages(messages);
      this.changes = normalizeChanges(changes);
      this.activeChatModel = model;
    }
    this.runningChatIds.delete(chatId);
    this.clearActiveRun(chatId);
    this.interruptedRuns.delete(chatId);
    return this.snapshot();
  }

  async *sendMessageEvents(text, { chatId = null, repoRoot = null, model = null, promptPreset = null, toolSafetyMode = null } = {}) {
    const message = String(text || "").trim();
    if (!message) {
      throw new Error("Message is required.");
    }

    const requestModel = String(model || this.model).trim() || DEFAULT_MODEL;
    const requestRepoRoot = repoRoot ? path.resolve(repoRoot) : this.repoRoot;
    const requestPromptPreset = String(promptPreset || this.promptPreset).trim() || "code";
    const effectivePromptPreset = this.effectivePromptPreset(message, requestPromptPreset);
    const requestChatStore = new ProjectChatStore(requestRepoRoot);
    const existingPayload = chatId ? requestChatStore.loadChat(chatId) : null;
    const existingProviderState = existingPayload?.provider_state && typeof existingPayload.provider_state === "object"
      ? { ...existingPayload.provider_state }
      : {};
    const requestToolSafetyMode = String(toolSafetyMode || existingPayload?.tool_safety_mode || (this.toolReadOnly ? "read" : "write")).trim().toLowerCase() === "read" ? "read" : "write";
    const requestToolReadOnly = requestToolSafetyMode === "read";
    const provider = this.providerForRequest(requestModel);
    if (!provider.connected) {
      throw new Error(`${this.providerNameForModel(requestModel)} is not ready for requests.`);
    }

    let baseMessages = existingPayload ? normalizeMessages(existingPayload.messages) : [];
    let storedChanges = existingPayload ? normalizeChanges(existingPayload.changes) : [];
    const existingModel = existingPayload ? String(existingPayload.model || "") : "";
    this.codexProvider.sessionId = String(existingProviderState.codex_session_id || "");
    this.codexProvider.sessionMode = this.codexProvider.sessionId ? "resume_id" : "fresh";
    this.geminiCliProvider.sessionId = String(existingProviderState.gemini_cli_session_id || "");
    this.geminiCliProvider.sessionMode = this.geminiCliProvider.sessionId ? "resume_id" : "fresh";
    if (
      this.codexProvider.sessionId
      && String(existingProviderState.codex_tool_safety_mode || "") !== requestToolSafetyMode
    ) {
      this.codexProvider.sessionId = "";
      this.codexProvider.sessionMode = "fresh";
    }
    if (
      existingModel
      && this.modelFamily(existingModel) !== this.modelFamily(requestModel)
      && (requestModel.startsWith("codex:") || requestModel.startsWith("gemini-cli:"))
    ) {
      baseMessages = this.recentChatContext(baseMessages, this.config.contextCarryMessages || 5);
      if (requestModel.startsWith("codex:")) {
        this.codexProvider.sessionId = "";
        this.codexProvider.sessionMode = "fresh";
      }
      if (requestModel.startsWith("gemini-cli:")) {
        this.geminiCliProvider.sessionId = "";
        this.geminiCliProvider.sessionMode = "fresh";
      }
    }

    baseMessages = [...baseMessages, { role: "user", content: message }];
    const repoStateBefore = this.captureRepoState(requestRepoRoot);

    if (chatId && this.runningChatIds.has(chatId)) {
      throw new Error("This chat is already running a request.");
    }
    if (!chatId) {
      chatId = requestChatStore.createChat(baseMessages, {
        model: requestModel,
        providerState: {},
        changes: storedChanges,
        toolSafetyMode: requestToolSafetyMode,
      });
      if (this.repoRoot === requestRepoRoot && !this.activeChatId) {
        this.activeChatId = chatId;
      }
    } else {
      requestChatStore.saveChat(chatId, baseMessages, {
        model: requestModel,
        providerState: existingProviderState,
        changes: storedChanges,
        toolSafetyMode: requestToolSafetyMode,
      });
    }

    if (this.repoRoot === requestRepoRoot && this.activeChatId === chatId) {
      this.messages = normalizeMessages(baseMessages);
      this.changes = normalizeChanges(storedChanges);
      this.toolReadOnly = requestToolReadOnly;
      this.toolExecutor.readOnly = requestToolReadOnly;
      this.activeChatModel = requestModel;
    }

    this.runningChatIds.add(chatId);
    this.trackActiveRun({ chatId, repoRoot: requestRepoRoot, model: requestModel, lastUserMessage: message });
    const startSnapshot = this.snapshot();

    yield this.event("user_message", { message, chatId, snapshot: startSnapshot });
    yield this.event("status", { phase: "started", message: `Running ${this.providerNameForModel(requestModel)}...`, chatId });

    try {
      const providerState = {};
      const baseForProvider = this.messagesWithContext([...baseMessages], effectivePromptPreset);

      if (requestModel.startsWith("codex:")) {
        this.codexProvider.toolReadOnly = requestToolReadOnly;
        const cliEvents = [];
        let cliWaiter = null;
        let cliDone = false;
        let cliError = null;
        let finalText = "";
        const notifyCli = () => {
          if (cliWaiter) {
            cliWaiter();
            cliWaiter = null;
          }
        };
        const worker = (async () => {
          try {
            finalText = await this.codexProvider.chatCompletionStreamRaw(baseForProvider, requestModel, (chunk) => {
              if (!chunk) {
                return;
              }
              cliEvents.push(this.event("cli_output", { stream: "stdout", text: chunk, chatId }));
              notifyCli();
            });
          } catch (error) {
            cliError = error;
          } finally {
            cliDone = true;
            notifyCli();
          }
        })();
        while (!cliDone || cliEvents.length) {
          if (cliEvents.length) {
            yield cliEvents.shift();
            continue;
          }
          await new Promise((resolve) => {
            cliWaiter = resolve;
          });
        }
        await worker;
        if (cliError) {
          throw cliError;
        }
        const finalMessages = [...baseMessages, { role: "assistant", content: finalText }];
        providerState.codex_session_id = this.codexProvider.sessionId || "";
        providerState.codex_tool_safety_mode = requestToolSafetyMode;
        const finalChanges = this.finalRepoChanges(requestRepoRoot, repoStateBefore);
        const snapshot = this.saveCompletedChat({
          chatStore: requestChatStore,
          chatId,
          messages: finalMessages,
          model: requestModel,
          providerState,
          toolSafetyMode: requestToolSafetyMode,
          repoRoot: requestRepoRoot,
          changes: finalChanges,
        });
        yield this.event("assistant", { text: finalText, chatId });
        yield this.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools: 0, snapshot, chatId });
        return;
      }

      if (requestModel.startsWith("gemini-cli:")) {
        const cliEvents = [];
        let cliWaiter = null;
        let cliDone = false;
        let cliError = null;
        let finalText = "";
        const notifyCli = () => {
          if (cliWaiter) {
            cliWaiter();
            cliWaiter = null;
          }
        };
        const worker = (async () => {
          try {
            finalText = await this.geminiCliProvider.chatCompletionStreamRaw(baseForProvider, requestModel, (chunk) => {
              if (!chunk) {
                return;
              }
              cliEvents.push(this.event("cli_output", { stream: "stdout", text: chunk, chatId }));
              notifyCli();
            });
          } catch (error) {
            cliError = error;
          } finally {
            cliDone = true;
            notifyCli();
          }
        })();
        while (!cliDone || cliEvents.length) {
          if (cliEvents.length) {
            yield cliEvents.shift();
            continue;
          }
          await new Promise((resolve) => {
            cliWaiter = resolve;
          });
        }
        await worker;
        if (cliError) {
          throw cliError;
        }
        const finalMessages = [...baseMessages, { role: "assistant", content: finalText }];
        providerState.gemini_cli_session_id = this.geminiCliProvider.sessionId || "";
        const finalChanges = this.finalRepoChanges(requestRepoRoot, repoStateBefore);
        const snapshot = this.saveCompletedChat({
          chatStore: requestChatStore,
          chatId,
          messages: finalMessages,
          model: requestModel,
          providerState,
          toolSafetyMode: requestToolSafetyMode,
          repoRoot: requestRepoRoot,
          changes: finalChanges,
        });
        yield this.event("assistant", { text: finalText, chatId });
        yield this.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools: 0, snapshot, chatId });
        return;
      }

      if (!this.requestUsesTools(requestModel, message, effectivePromptPreset)) {
        const finalText = await provider.chatCompletion(baseForProvider, requestModel);
        const finalMessages = [...baseMessages, { role: "assistant", content: finalText }];
        const finalChanges = this.finalRepoChanges(requestRepoRoot, repoStateBefore);
        const snapshot = this.saveCompletedChat({
          chatStore: requestChatStore,
          chatId,
          messages: finalMessages,
          model: requestModel,
          providerState,
          toolSafetyMode: requestToolSafetyMode,
          repoRoot: requestRepoRoot,
          changes: finalChanges,
        });
        yield this.event("assistant", { text: finalText, chatId });
        yield this.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools: 0, snapshot, chatId });
        return;
      }

      let workingMessages = [...baseForProvider];
      let usedTools = 0;
      for (let roundIndex = 0; roundIndex < MAX_TOOL_ROUNDS; roundIndex += 1) {
        yield this.event("status", { phase: "thinking", message: `Thinking... round ${roundIndex + 1}`, chatId });
        const [finalText, assistantMessage, toolCalls] = await provider.chatWithTools(workingMessages, requestModel, TOOLS);
        if (finalText != null) {
          const finalMessages = [...baseMessages, { role: "assistant", content: finalText }];
          const finalChanges = this.finalRepoChanges(requestRepoRoot, repoStateBefore);
          const snapshot = this.saveCompletedChat({
            chatStore: requestChatStore,
            chatId,
            messages: finalMessages,
            model: requestModel,
            providerState,
            toolSafetyMode: requestToolSafetyMode,
            repoRoot: requestRepoRoot,
            changes: finalChanges,
          });
          yield this.event("assistant", { text: finalText, chatId });
          yield this.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools, snapshot, chatId });
          return;
        }
        if (assistantMessage) {
          workingMessages.push(assistantMessage);
        }
        if (!Array.isArray(toolCalls) || !toolCalls.length) {
          break;
        }
        for (const toolCall of toolCalls) {
          usedTools += 1;
          const args = JSON.parse(toolCall.function.arguments || "{}");
          yield this.event("tool_call", { name: toolCall.function.name, args, chatId });
          this.toolExecutor.readOnly = requestToolReadOnly;
          const [result, change] = await this.toolExecutor.executeWithMetadata(toolCall.function.name, args);
          if (change) {
            storedChanges = [...storedChanges, change];
          }
          yield this.event("tool_result", { name: toolCall.function.name, result, change, chatId });
          workingMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: result,
          });
        }
      }

      const fallbackText = await provider.chatCompletion(workingMessages, requestModel);
      const finalMessages = [...baseMessages, { role: "assistant", content: fallbackText }];
      const finalChanges = this.finalRepoChanges(requestRepoRoot, repoStateBefore);
      const snapshot = this.saveCompletedChat({
        chatStore: requestChatStore,
        chatId,
        messages: finalMessages,
        model: requestModel,
        providerState,
        toolSafetyMode: requestToolSafetyMode,
        repoRoot: requestRepoRoot,
        changes: finalChanges,
      });
      yield this.event("assistant", { text: fallbackText, chatId });
      yield this.event("completed", { assistantMessage: fallbackText, elapsedSeconds: 0, usedTools: 0, snapshot, chatId });
    } catch (error) {
      this.runningChatIds.delete(chatId);
      this.clearActiveRun(chatId);
      this.interruptedRuns.set(chatId, {
        chat_id: chatId,
        repo_root: requestRepoRoot,
        model: requestModel,
        last_user_message: message,
        started_at: nowIso(),
        recovered_at: "",
      });
      this.persistConfig();
      throw error;
    }
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
