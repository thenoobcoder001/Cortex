const { ProjectChatStore } = require("./chatStore");
const path = require("node:path");
const { DEFAULT_MODEL, MAX_TOOL_ROUNDS, TOOLS } = require("./constants");
const { normalizeMessages, normalizeChanges, nowIso } = require("./sessionShared");
const { isInterruptError } = require("./providers");

function buildPlanMeta(chatStore, chatId, userPrompt, assistantText) {
  const titleSource = String(userPrompt || "").split(/\r?\n/, 1)[0].trim() || "Implementation Plan";
  const title = titleSource.length > 64 ? `${titleSource.slice(0, 64).trimEnd()}...` : titleSource;
  return chatStore.savePlan(chatId, title, userPrompt, assistantText);
}

async function *drainQueuedEvents(worker, queue, takeWaiter) {
  let queueWaiter = null;
  const notify = () => {
    if (queueWaiter) {
      queueWaiter();
      queueWaiter = null;
    }
  };
  takeWaiter.current = notify;
  try {
    while (!worker.done || queue.length) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      await new Promise((resolve) => {
        queueWaiter = resolve;
      });
    }
  } finally {
    takeWaiter.current = null;
  }
}

async function *runCliRequest(provider, messages, model, service, chatId) {
  const queue = [];
  const waiter = { current: null };
  let cliError = null;
  let finalText = "";
  const worker = {
    done: false,
  };

  const job = (async () => {
    try {
      finalText = await provider.chatCompletionStreamRaw(messages, model, {
        signal: service.requestRegistry.get(chatId)?.controller.signal || null,
        onOutput: (chunk) => {
          if (!chunk) {
            return;
          }
          queue.push(service.event("cli_output", { stream: "stdout", text: chunk, chatId }));
          waiter.current?.();
        },
      });
    } catch (error) {
      cliError = error;
    } finally {
      worker.done = true;
      waiter.current?.();
    }
  })();

  for await (const event of drainQueuedEvents(worker, queue, waiter)) {
    yield event;
  }

  await job;
  if (cliError) {
    throw cliError;
  }
  return finalText;
}

async function *sendMessageEvents(service, text, { chatId = null, repoRoot = null, model = null, promptPreset = null, toolSafetyMode = null } = {}) {
  const message = String(text || "").trim();
  if (!message) {
    throw new Error("Message is required.");
  }

  const requestModel = String(model || service.model).trim() || DEFAULT_MODEL;
  const requestRepoRoot = repoRoot ? path.resolve(repoRoot) : service.repoRoot;
  const requestPromptPreset = String(promptPreset || service.promptPreset).trim() || "code";
  const effectivePromptPreset = service.effectivePromptPreset(message, requestPromptPreset);
  const requestChatStore = new ProjectChatStore(requestRepoRoot);
  const existingPayload = chatId ? requestChatStore.loadChat(chatId) : null;
  const existingProviderState = existingPayload?.provider_state && typeof existingPayload.provider_state === "object"
    ? { ...existingPayload.provider_state }
    : {};
  const existingPlan = existingPayload?.plan && typeof existingPayload.plan === "object"
    ? { ...existingPayload.plan }
    : null;
  const requestToolSafetyMode = String(toolSafetyMode || existingPayload?.tool_safety_mode || (service.toolReadOnly ? "read" : "write")).trim().toLowerCase() === "read" ? "read" : "write";
  const requestToolReadOnly = requestToolSafetyMode === "read";
  const provider = service.providerForRequest(requestModel);
  if (!provider.connected) {
    throw new Error(`${service.providerNameForModel(requestModel)} is not ready for requests.`);
  }

  let baseMessages = existingPayload ? normalizeMessages(existingPayload.messages) : [];
  let storedChanges = existingPayload ? normalizeChanges(existingPayload.changes) : [];
  const existingModel = existingPayload ? String(existingPayload.model || "") : "";
  service.codexProvider.sessionId = String(existingProviderState.codex_session_id || "");
  service.codexProvider.sessionMode = service.codexProvider.sessionId ? "resume_id" : "fresh";
  service.geminiCliProvider.sessionId = String(existingProviderState.gemini_cli_session_id || "");
  service.geminiCliProvider.sessionMode = service.geminiCliProvider.sessionId ? "resume_id" : "fresh";
  service.claudeProvider.sessionId = String(existingProviderState.claude_session_id || "");
  service.claudeProvider.sessionMode = service.claudeProvider.sessionId ? "resume_id" : "fresh";
  if (
    service.codexProvider.sessionId
    && String(existingProviderState.codex_tool_safety_mode || "") !== requestToolSafetyMode
  ) {
    service.codexProvider.sessionId = "";
    service.codexProvider.sessionMode = "fresh";
  }
  if (
    existingModel
    && service.modelFamily(existingModel) !== service.modelFamily(requestModel)
    && (requestModel.startsWith("codex:") || requestModel.startsWith("gemini-cli:") || requestModel.startsWith("claude:"))
  ) {
    baseMessages = service.recentChatContext(baseMessages, service.config.contextCarryMessages ?? 5);
    if (requestModel.startsWith("codex:")) {
      service.codexProvider.sessionId = "";
      service.codexProvider.sessionMode = "fresh";
    }
    if (requestModel.startsWith("gemini-cli:")) {
      service.geminiCliProvider.sessionId = "";
      service.geminiCliProvider.sessionMode = "fresh";
    }
    if (requestModel.startsWith("claude:")) {
      service.claudeProvider.sessionId = "";
      service.claudeProvider.sessionMode = "fresh";
    }
  }

  baseMessages = [...baseMessages, { role: "user", content: message }];
  const repoStateBefore = service.captureRepoState(requestRepoRoot);
  const shouldCreatePlan = effectivePromptPreset === "plan";

  if (chatId && service.requestRegistry.has(chatId)) {
    throw new Error("This chat is already running a request.");
  }
  if (!chatId) {
    chatId = requestChatStore.createChat(baseMessages, {
      model: requestModel,
      providerState: {},
      changes: storedChanges,
      toolSafetyMode: requestToolSafetyMode,
    });
    if (service.repoRoot === requestRepoRoot && !service.activeChatId) {
      service.activeChatId = chatId;
    }
  } else {
    requestChatStore.saveChat(chatId, baseMessages, {
      model: requestModel,
      providerState: existingProviderState,
      changes: storedChanges,
      toolSafetyMode: requestToolSafetyMode,
      plan: existingPlan,
    });
  }

  if (service.repoRoot === requestRepoRoot && service.activeChatId === chatId) {
    service.messages = normalizeMessages(baseMessages);
    service.changes = normalizeChanges(storedChanges);
    service.toolReadOnly = requestToolReadOnly;
    service.toolExecutor.readOnly = requestToolReadOnly;
    service.activeChatModel = requestModel;
  }

  service.requestRegistry.start(chatId, {
    repoRoot: requestRepoRoot,
    model: requestModel,
  });
  service.trackActiveRun({ chatId, repoRoot: requestRepoRoot, model: requestModel, lastUserMessage: message });
  const startSnapshot = service.snapshot();

  yield service.event("user_message", { message, chatId, snapshot: startSnapshot });
  yield service.event("status", { phase: "started", message: `Running ${service.providerNameForModel(requestModel)}...`, chatId });

  try {
    const providerState = {};
    const baseForProvider = service.messagesWithContext([...baseMessages], effectivePromptPreset);
    const requestOptions = {
      signal: service.requestRegistry.get(chatId)?.controller.signal || null,
    };

    if (requestModel.startsWith("claude:")) {
      service.claudeProvider.toolReadOnly = requestToolReadOnly;
    }
    if (requestModel.startsWith("codex:")) {
      service.codexProvider.toolReadOnly = requestToolReadOnly;
      let finalText = "";
      const codexStream = runCliRequest(service.codexProvider, baseForProvider, requestModel, service, chatId);
      while (true) {
        const next = await codexStream.next();
        if (next.done) {
          finalText = String(next.value || "");
          break;
        }
        yield next.value;
      }
      providerState.codex_session_id = service.codexProvider.sessionId || "";
      providerState.codex_tool_safety_mode = requestToolSafetyMode;
      const finalChanges = service.finalRepoChanges(requestRepoRoot, repoStateBefore);
      const plan = shouldCreatePlan ? buildPlanMeta(requestChatStore, chatId, message, finalText) : existingPlan;
      const snapshot = service.saveCompletedChat({
        chatStore: requestChatStore,
        chatId,
        messages: [...baseMessages, { role: "assistant", content: finalText }],
        model: requestModel,
        providerState,
        toolSafetyMode: requestToolSafetyMode,
        repoRoot: requestRepoRoot,
        changes: finalChanges,
        plan,
      });
      yield service.event("assistant", { text: finalText, chatId });
      yield service.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools: 0, snapshot, chatId });
      return;
    }

    if (requestModel.startsWith("gemini-cli:")) {
      let finalText = "";
      const geminiStream = runCliRequest(service.geminiCliProvider, baseForProvider, requestModel, service, chatId);
      while (true) {
        const next = await geminiStream.next();
        if (next.done) {
          finalText = String(next.value || "");
          break;
        }
        yield next.value;
      }
      providerState.gemini_cli_session_id = service.geminiCliProvider.sessionId || "";
      const finalChanges = service.finalRepoChanges(requestRepoRoot, repoStateBefore);
      const plan = shouldCreatePlan ? buildPlanMeta(requestChatStore, chatId, message, finalText) : existingPlan;
      const snapshot = service.saveCompletedChat({
        chatStore: requestChatStore,
        chatId,
        messages: [...baseMessages, { role: "assistant", content: finalText }],
        model: requestModel,
        providerState,
        toolSafetyMode: requestToolSafetyMode,
        repoRoot: requestRepoRoot,
        changes: finalChanges,
        plan,
      });
      yield service.event("assistant", { text: finalText, chatId });
      yield service.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools: 0, snapshot, chatId });
      return;
    }

    if (requestModel.startsWith("claude:")) {
      let finalText = "";
      const claudeStream = runCliRequest(service.claudeProvider, baseForProvider, requestModel, service, chatId);
      while (true) {
        const next = await claudeStream.next();
        if (next.done) {
          finalText = String(next.value || "");
          break;
        }
        yield next.value;
      }
      providerState.claude_session_id = service.claudeProvider.sessionId || "";
      const finalChanges = service.finalRepoChanges(requestRepoRoot, repoStateBefore);
      const plan = shouldCreatePlan ? buildPlanMeta(requestChatStore, chatId, message, finalText) : existingPlan;
      const snapshot = service.saveCompletedChat({
        chatStore: requestChatStore,
        chatId,
        messages: [...baseMessages, { role: "assistant", content: finalText }],
        model: requestModel,
        providerState,
        toolSafetyMode: requestToolSafetyMode,
        repoRoot: requestRepoRoot,
        changes: finalChanges,
        plan,
      });
      yield service.event("assistant", { text: finalText, chatId });
      yield service.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools: 0, snapshot, chatId });
      return;
    }

    if (!service.requestUsesTools(requestModel, message, effectivePromptPreset)) {
      const finalText = await provider.chatCompletion(baseForProvider, requestModel, requestOptions);
      const finalChanges = service.finalRepoChanges(requestRepoRoot, repoStateBefore);
      const plan = shouldCreatePlan ? buildPlanMeta(requestChatStore, chatId, message, finalText) : existingPlan;
      const snapshot = service.saveCompletedChat({
        chatStore: requestChatStore,
        chatId,
        messages: [...baseMessages, { role: "assistant", content: finalText }],
        model: requestModel,
        providerState,
        toolSafetyMode: requestToolSafetyMode,
        repoRoot: requestRepoRoot,
        changes: finalChanges,
        plan,
      });
      yield service.event("assistant", { text: finalText, chatId });
      yield service.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools: 0, snapshot, chatId });
      return;
    }

    let workingMessages = [...baseForProvider];
    let usedTools = 0;
    for (let roundIndex = 0; roundIndex < MAX_TOOL_ROUNDS; roundIndex += 1) {
      yield service.event("status", { phase: "thinking", message: `Thinking... round ${roundIndex + 1}`, chatId });
      const [finalText, assistantMessage, toolCalls] = await provider.chatWithTools(workingMessages, requestModel, TOOLS, requestOptions);
      if (finalText != null) {
        const finalChanges = service.finalRepoChanges(requestRepoRoot, repoStateBefore);
        const plan = shouldCreatePlan ? buildPlanMeta(requestChatStore, chatId, message, finalText) : existingPlan;
        const snapshot = service.saveCompletedChat({
          chatStore: requestChatStore,
          chatId,
          messages: [...baseMessages, { role: "assistant", content: finalText }],
          model: requestModel,
          providerState,
          toolSafetyMode: requestToolSafetyMode,
          repoRoot: requestRepoRoot,
          changes: finalChanges,
          plan,
        });
        yield service.event("assistant", { text: finalText, chatId });
        yield service.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools, snapshot, chatId });
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
        yield service.event("tool_call", { name: toolCall.function.name, args, chatId });
        service.toolExecutor.readOnly = requestToolReadOnly;
        const [result, change] = await service.toolExecutor.executeWithMetadata(toolCall.function.name, args);
        if (change) {
          storedChanges = [...storedChanges, change];
        }
        yield service.event("tool_result", { name: toolCall.function.name, result, change, chatId });
        workingMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: result,
        });
      }
    }

    const fallbackText = await provider.chatCompletion(workingMessages, requestModel, requestOptions);
    const finalChanges = service.finalRepoChanges(requestRepoRoot, repoStateBefore);
    const plan = shouldCreatePlan ? buildPlanMeta(requestChatStore, chatId, message, fallbackText) : existingPlan;
    const snapshot = service.saveCompletedChat({
      chatStore: requestChatStore,
      chatId,
      messages: [...baseMessages, { role: "assistant", content: fallbackText }],
      model: requestModel,
      providerState,
      toolSafetyMode: requestToolSafetyMode,
      repoRoot: requestRepoRoot,
      changes: finalChanges,
      plan,
    });
    yield service.event("assistant", { text: fallbackText, chatId });
    yield service.event("completed", { assistantMessage: fallbackText, elapsedSeconds: 0, usedTools: 0, snapshot, chatId });
  } catch (error) {
    service.requestRegistry.finish(chatId);
    service.clearActiveRun(chatId);
    if (isInterruptError(error)) {
      yield service.event("interrupted", {
        chatId,
        partialText: String(error.partialText || ""),
        snapshot: service.snapshot(),
      });
      return;
    }
    service.interruptedRuns.set(chatId, {
      chat_id: chatId,
      repo_root: requestRepoRoot,
      model: requestModel,
      last_user_message: message,
      started_at: nowIso(),
      recovered_at: "",
    });
    service.persistConfig();
    yield service.event("error", { message: String(error?.message || error), chatId });
    return;
  }
}

module.exports = {
  sendMessageEvents,
};
