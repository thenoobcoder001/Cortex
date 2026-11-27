const { ProjectChatStore } = require("./chatStore");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEFAULT_MODEL, MAX_TOOL_ROUNDS, TOOLS, resolveModelId } = require("./constants");
const { normalizeMessages, normalizeChanges, nowIso } = require("./sessionShared");
const { isInterruptError, toUserFacingProviderError } = require("./providers");
const {
  apiToolGate,
  chatPermissionMode,
  describePermissionMode,
  providerFamily,
  resolveRequestPermissionMode,
} = require("./permissionModes");
const { agyToolSummary } = require("./approvalBridge");
const { assessCommand, declineMessage, riskLabel, riskyGate } = require("./riskyCommands");
const { ensureClaudeSettings } = require("./claudeSettings");
const { labelReplies } = require("./contextCarry");

function buildPlanMeta(chatStore, chatId, userPrompt, assistantText) {
  const titleSource = String(userPrompt || "").split(/\r?\n/, 1)[0].trim() || "Implementation Plan";
  const title = titleSource.length > 64 ? `${titleSource.slice(0, 64).trimEnd()}...` : titleSource;
  return chatStore.savePlan(chatId, title, userPrompt, assistantText);
}

// The assistant reply, plus a small summary of the files this turn changed
// (full diffs live in the turn record and load on demand).
// `model` records who wrote it, so a later provider can be told.
function assistantReply(content, turn, model) {
  const reply = { role: "assistant", content, model: String(model || "") };
  return turn ? { ...reply, turnChanges: turn } : reply;
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

async function *runCliRequest(provider, messages, model, service, chatId, extraOptions = {}) {
  const queue = [];
  const waiter = { current: null };
  let cliError = null;
  let finalText = "";
  const worker = { done: false };
  // Approval requests raised while the CLI runs go out on the same stream.
  const unsubscribe = service.approvalRegistry.subscribe(chatId, (event) => {
    queue.push(service.event(event.type, event));
    waiter.current?.();
  });

  const push = (type, payload) => {
    queue.push(service.event(type, { ...payload, chatId }));
    waiter.current?.();
  };
  const job = (async () => {
    try {
      finalText = await provider.chatCompletionStreamRaw(messages, model, {
        ...extraOptions,
        signal: service.requestRegistry.get(chatId)?.controller.signal || null,
        onProcessStart: (pid) => service.requestRegistry.attachProcess(chatId, pid),
        onOutput: (chunk) => {
          if (!chunk) return;
          push("cli_output", { stream: "stdout", text: chunk });
        },
        // Tool steps, for providers that report them (Antigravity).
        onEvent: (type, payload) => push(type, payload),
        // A permission fallback decided at run time (e.g. no approval hook).
        onNotice: (message) => push("status", { phase: "permissions", message }),
      });
    } catch (error) {
      cliError = error;
    } finally {
      worker.done = true;
      waiter.current?.();
    }
  })();

  try {
    for await (const event of drainQueuedEvents(worker, queue, waiter)) {
      yield event;
    }
  } finally {
    unsubscribe();
  }

  await job;
  if (cliError) throw cliError;
  return finalText;
}

// Answers one tool call from Antigravity's approval hook: reads pass, the
// hook's own folder is refused, everything else goes to an approval card
// (or is auto-approved and audited for repo edits in Auto-accept edits).
async function answerAgyTool(service, bridge, toolName, input, { chatId, repoRoot, permissionMode, auditMeta }) {
  const summary = agyToolSummary(toolName, input, { repoRoot, permissionMode, controlDir: bridge.controlDir });
  if (summary.pass) {
    return { decision: "approve", by: summary.by };
  }
  if (summary.block) {
    service.recordAuditEntry({
      ...auditMeta,
      source: "cortex",
      chatId,
      action: "declined",
      success: true,
      detail: `tool ${String(toolName || "")}; ${summary.block}`,
    }, repoRoot);
    return { decision: "decline", by: "cortex" };
  }
  return bridge.ask(summary);
}

function restoreCliSession(provider, storedId) {
  provider.sessionId = String(storedId || "");
  provider.sessionMode = provider.sessionId ? "resume_id" : "fresh";
}

function clearCliSession(provider) {
  provider.sessionId = "";
  provider.sessionMode = "fresh";
}

function cliProviderEntry(model, service) {
  if (model.startsWith("codex:"))      return { provider: service.codexProvider,    sessionKey: "codex_session_id" };
  if (model.startsWith("agy:"))        return { provider: service.agyProvider,       sessionKey: "agy_conversation_id" };
  if (model.startsWith("claude:"))     return { provider: service.claudeProvider,    sessionKey: "claude_session_id" };
  if (model.startsWith("hermes:"))     return { provider: service.hermesProvider,    sessionKey: "hermes_session_id" };
  return null;
}

async function *sendMessageEvents(service, text, { chatId = null, repoRoot = null, model = null, promptPreset = null, toolSafetyMode = null, permissionMode = null } = {}) {
  const message = String(text || "").trim();
  if (!message) {
    throw new Error("Message is required.");
  }

  const requestModel = resolveModelId(model || service.model) || DEFAULT_MODEL;
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
  const requestPermissionMode = resolveRequestPermissionMode({
    permissionMode,
    toolSafetyMode,
    stored: existingPayload ? chatPermissionMode(existingPayload) : null,
    fallback: service.permissionMode,
  });
  const requestToolReadOnly = requestPermissionMode === "read-only";
  const provider = service.providerForRequest(requestModel);
  if (!provider.connected) {
    throw new Error(`${service.providerNameForModel(requestModel)} is not ready for requests.`);
  }

  let baseMessages = existingPayload ? normalizeMessages(existingPayload.messages) : [];
  let storedChanges = existingPayload ? normalizeChanges(existingPayload.changes) : [];
  const existingModel = existingPayload ? resolveModelId(existingPayload.model) : "";

  // Restore per-provider CLI session IDs from the chat's persisted state.
  restoreCliSession(service.codexProvider,    existingProviderState.codex_session_id);
  restoreCliSession(service.agyProvider,      existingProviderState.agy_conversation_id);
  restoreCliSession(service.claudeProvider,   existingProviderState.claude_session_id);
  restoreCliSession(service.hermesProvider,    existingProviderState.hermes_session_id);

  // Codex threads keep the sandbox they started with; start a fresh thread
  // when the permission mode changes so the new mode really applies.
  const storedCodexMode = existingProviderState.codex_permission_mode
    || (existingProviderState.codex_tool_safety_mode
      ? chatPermissionMode({ tool_safety_mode: existingProviderState.codex_tool_safety_mode })
      : "");
  if (service.codexProvider.sessionId && storedCodexMode !== requestPermissionMode) {
    clearCliSession(service.codexProvider);
  }

  // When the user switches provider families, start the new provider fresh.
  const switchedFamily = Boolean(existingModel) && service.modelFamily(existingModel) !== service.modelFamily(requestModel);
  const requestCliEntry = cliProviderEntry(requestModel, service);
  if (switchedFamily && requestCliEntry) clearCliSession(requestCliEntry.provider);

  // A CLI provider with no session to resume only knows what we hand it:
  // the recent conversation within a budget (the stored chat keeps
  // everything). Replies by other models are labelled with their author.
  const carried = requestCliEntry && !requestCliEntry.provider.sessionId && baseMessages.length
    ? service.recentChatContext(baseMessages, service.config.contextCarryMessages ?? 5)
    : null;
  const userMessage = { role: "user", content: message };
  const contextForProvider = labelReplies(carried ? [...carried, userMessage] : [...baseMessages, userMessage], {
    currentModel: requestModel,
    fallbackModel: switchedFamily ? existingModel : "",
  });

  baseMessages = [...baseMessages, userMessage];
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
      permissionMode: requestPermissionMode,
    });
    if (service.repoRoot === requestRepoRoot && !service.activeChatId) {
      service.activeChatId = chatId;
    }
  } else {
    requestChatStore.saveChat(chatId, baseMessages, {
      model: requestModel,
      providerState: existingProviderState,
      changes: storedChanges,
      permissionMode: requestPermissionMode,
      plan: existingPlan,
    });
  }

  if (service.repoRoot === requestRepoRoot && service.activeChatId === chatId) {
    service.messages = normalizeMessages(baseMessages);
    service.changes = normalizeChanges(storedChanges);
    service.permissionMode = requestPermissionMode;
    service.toolExecutor.readOnly = requestToolReadOnly;
    service.activeChatModel = requestModel;
  }

  service.requestRegistry.start(chatId, { repoRoot: requestRepoRoot, model: requestModel });
  service.trackActiveRun({ chatId, repoRoot: requestRepoRoot, model: requestModel, lastUserMessage: message });
  const startSnapshot = service.snapshot();

  yield service.event("user_message", { message, chatId, snapshot: startSnapshot });
  yield service.event("status", { phase: "started", message: `Running ${service.providerNameForModel(requestModel)}...`, chatId });

  const auditMeta = { provider: service.providerNameForModel(requestModel), model: requestModel, chatId };
  const modeInfo = describePermissionMode(requestModel, requestPermissionMode, { bridge: Boolean(service.approvalBridgeUrl) });
  if (modeInfo.note) {
    yield service.event("status", { phase: "permissions", message: modeInfo.note, permissionMode: modeInfo, chatId });
  }
  const approvalContext = { provider: auditMeta.provider, model: requestModel, repoRoot: requestRepoRoot };
  // Providers call this to ask the user; it resolves to { decision, by,
  // message? }. Risky commands ask in every mode (Full access included),
  // the rest of Full access is answered here without a card.
  const askApproval = async (summary) => {
    const verdict = riskyGate(requestPermissionMode, summary, { repoRoot: requestRepoRoot });
    if (verdict.gate === "allow") return { decision: "approve", by: "full access" };
    const request = { ...summary, ...approvalContext, risk: riskLabel(verdict.risk) };
    if (verdict.gate === "block") request.autoDecline = "safety policy";
    const answer = await service.approvalRegistry.request(chatId, request).promise;
    return answer.decision === "approve" ? answer : { ...answer, message: declineMessage(verdict.risk, answer.by) };
  };
  let bridgeToken = "";

  const finishTurn = (finalText, changes) => {
    const plan = shouldCreatePlan ? buildPlanMeta(requestChatStore, chatId, message, finalText) : existingPlan;
    return service.saveCompletedChat({
      chatStore: requestChatStore,
      chatId,
      messages: [...baseMessages, assistantReply(finalText, changes.turn, requestModel)],
      model: requestModel,
      providerState: changes.providerState,
      permissionMode: requestPermissionMode,
      repoRoot: requestRepoRoot,
      changes: changes.finalChanges,
      plan,
    });
  };

  try {
    const providerState = {};
    const baseForProvider = service.messagesWithContext(contextForProvider, effectivePromptPreset);
    const requestOptions = { signal: service.requestRegistry.get(chatId)?.controller.signal || null };

    const cliEntry = cliProviderEntry(requestModel, service);
    if (cliEntry) {
      // carriedContext: the messages are already trimmed to the carry budget;
      // providers pass them on whole instead of their own last-8 cut.
      const cliOptions = { permissionMode: requestPermissionMode, askApproval, carriedContext: Boolean(carried) };
      // Claude asks through a local MCP server, Antigravity through a
      // PreToolUse hook; both call back into Cortex with a per-turn token
      // that ties those calls to this chat.
      const family = providerFamily(requestModel);
      // A repo opened by an older Cortex still denies risky commands in its
      // .claude/settings.json (deny beats ask); move those rules to ask.
      if (family === "claude") ensureClaudeSettings(requestRepoRoot);
      // Claude also asks in Full access, but only about risky commands.
      const usesBridge = modeInfo.interactive || (family === "claude" && modeInfo.asksForRiskyCommands);
      if ((family === "claude" || family === "agy") && usesBridge && service.approvalBridgeUrl) {
        bridgeToken = crypto.randomBytes(24).toString("hex");
        const bridge = { chatId, ask: askApproval };
        if (family === "agy") {
          bridge.controlDir = "";
          bridge.handle = (toolName, input) => answerAgyTool(service, bridge, toolName, input, {
            chatId,
            repoRoot: requestRepoRoot,
            permissionMode: requestPermissionMode,
            auditMeta,
          });
        }
        service.approvalBridges.set(bridgeToken, bridge);
        cliOptions.approvalBridge = {
          url: service.approvalBridgeUrl,
          token: bridgeToken,
          // The provider says which folder holds this turn's hook.
          onWorkspace: (dir) => { bridge.controlDir = dir; },
        };
      }
      let finalText = "";
      const cliStream = runCliRequest(cliEntry.provider, baseForProvider, requestModel, service, chatId, cliOptions);
      while (true) {
        const next = await cliStream.next();
        if (next.done) { finalText = String(next.value || ""); break; }
        yield next.value;
      }
      providerState[cliEntry.sessionKey] = cliEntry.provider.sessionId || "";
      if (requestModel.startsWith("codex:")) providerState.codex_permission_mode = requestPermissionMode;
      const { changes: finalChanges, turn } = service.finishTurnChanges(requestRepoRoot, repoStateBefore, auditMeta, { chatId });
      const snapshot = finishTurn(finalText, { providerState, finalChanges, turn });
      yield service.event("assistant", { text: finalText, chatId });
      yield service.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools: 0, snapshot, chatId });
      return;
    }

    if (!service.requestUsesTools(requestModel, message, effectivePromptPreset)) {
      const finalText = await provider.chatCompletion(baseForProvider, requestModel, requestOptions);
      const { changes: finalChanges, turn } = service.finishTurnChanges(requestRepoRoot, repoStateBefore, auditMeta, { chatId });
      const snapshot = finishTurn(finalText, { providerState, finalChanges, turn });
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
        const { changes: finalChanges, turn } = service.finishTurnChanges(requestRepoRoot, repoStateBefore, auditMeta, { chatId });
        const snapshot = finishTurn(finalText, { providerState, finalChanges, turn });
        yield service.event("assistant", { text: finalText, chatId });
        yield service.event("completed", { assistantMessage: finalText, elapsedSeconds: 0, usedTools, snapshot, chatId });
        return;
      }
      if (assistantMessage) workingMessages.push(assistantMessage);
      if (!Array.isArray(toolCalls) || !toolCalls.length) break;
      for (const toolCall of toolCalls) {
        usedTools += 1;
        const toolName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || "{}");
        yield service.event("tool_call", { name: toolName, args, chatId });
        service.toolExecutor.readOnly = requestToolReadOnly;
        service.toolExecutor.auditMeta = auditMeta;
        // Supervised / auto-accept-edits: ask before the tool touches anything.
        // Risky commands ask in Full access too; never-allowed ones are
        // refused by the executor (and audited there).
        const toolGate = apiToolGate(requestPermissionMode, toolName);
        const risk = toolName === "run_terminal_command" ? assessCommand(args.command, { repoRoot: requestRepoRoot }) : null;
        const mustAsk = risk?.level !== "block" && (toolGate === "ask" || (toolGate === "allow" && risk?.level === "ask"));
        if (mustAsk) {
          const summary = { ...service.toolExecutor.approvalSummary(toolName, args), risk: riskLabel(risk) };
          const { approval, promise } = service.approvalRegistry.request(chatId, { ...summary, ...approvalContext });
          if (!approval.autoResolved) {
            yield service.event("approval_request", { chatId, approval });
          }
          const answer = await promise;
          if (!approval.autoResolved) {
            yield service.event("approval_resolved", { chatId, approvalId: approval.id, decision: answer.decision, by: answer.by });
          }
          if (answer.decision !== "approve") {
            const declined = `ERROR: ${declineMessage(risk, answer.by)}`;
            yield service.event("tool_result", { name: toolName, result: declined, change: null, chatId });
            workingMessages.push({ role: "tool", tool_call_id: toolCall.id, name: toolName, content: declined });
            continue;
          }
        }
        const [result, change] = await service.toolExecutor.executeWithMetadata(toolName, args, { approved: mustAsk });
        if (change) storedChanges = [...storedChanges, change];
        yield service.event("tool_result", { name: toolName, result, change, chatId });
        workingMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: result,
        });
      }
    }

    const fallbackText = await provider.chatCompletion(workingMessages, requestModel, requestOptions);
    const { changes: finalChanges, turn } = service.finishTurnChanges(requestRepoRoot, repoStateBefore, auditMeta, { chatId });
    const snapshot = finishTurn(fallbackText, { providerState, finalChanges, turn });
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
    const userError = toUserFacingProviderError(error, { model: requestModel });
    service.interruptedRuns.set(chatId, {
      chat_id: chatId,
      repo_root: requestRepoRoot,
      model: requestModel,
      last_user_message: message,
      started_at: nowIso(),
      recovered_at: "",
    });
    service.persistConfig();
    yield service.event("error", { message: String(userError?.message || userError), chatId });
  } finally {
    if (bridgeToken) service.approvalBridges.delete(bridgeToken);
    // Nothing may stay pending once the turn is over.
    service.approvalRegistry.cancelChat(chatId, "turn ended");
  }
}

module.exports = {
  sendMessageEvents,
};
