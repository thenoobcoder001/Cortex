const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");
const { buildCleanEnv } = require("./androidEnv");
const platform = require("./platform");
const { codexPolicy, claudePermissionArgs, agyPermissionConfig, agyFallbackNote, normalizePermissionMode } = require("./permissionModes");
const { writeClaudeMcpConfig, writeAgyHookWorkspace } = require("./approvalBridge");
const { claudeRiskyAskSettings, claudeShellAskSettings } = require("./riskyCommands");

// Strip ANSI escape sequences from PTY output
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][A-Z0-9]/g, "").replace(/\x1b[=>]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

const CLI_ABORT_SETTLE_MS = 6000;
const CLI_TURN_TIMEOUT_MS = 15 * 60 * 1000;

function which(command) {
  // where.exe is a real executable, so no shell is needed (and `shell: true`
  // with an args array triggers DEP0190 on Node 24).
  const checker = platform.isWin ? "where.exe" : "which";
  const result = spawnSync(checker, [command], { encoding: "utf8", windowsHide: true, env: buildCleanEnv() });
  if (result.status !== 0) {
    return null;
  }
  const first = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first || null;
}

function spawnCommand(command, args, options = {}) {
  const effectiveOptions = {
    ...options,
    env: buildCleanEnv(options.env || {}),
  };

  if (!platform.isWin) {
    return spawn(command, args, { ...effectiveOptions, shell: false });
  }

  // .exe files are spawned directly; .cmd shims and bare names go through
  // cmd.exe with every argument escaped (see platform.windowsSpawnSpec).
  const spec = platform.windowsSpawnSpec(command, args);
  return spawn(spec.file, spec.args, {
    ...effectiveOptions,
    ...spec.options,
    shell: false,
  });
}

function buildCompactPrompt(messages, { head = "", keep = 8 } = {}) {
  const systemMessages = messages
    .filter((message) => String(message.role || "") === "system" && String(message.content || "").trim())
    .map((message) => String(message.content || "").trim());
  const turns = messages.filter((message) => ["user", "assistant"].includes(String(message.role || "")));
  const tail = turns.slice(-keep);
  let latestUser = "";
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    if (tail[index].role === "user") {
      latestUser = String(tail[index].content || "").trim();
      break;
    }
  }
  if (!latestUser) {
    latestUser = String(messages.at(-1)?.content || "").trim();
  }
  const context = tail.slice(0, -1)
    .map((entry) => `${entry.role}: ${String(entry.content || "").trim()}`)
    .filter(Boolean)
    .join("\n");
  let prompt = head || "";
  if (systemMessages.length) {
    prompt += `${prompt ? "\n" : ""}Instructions:\n${systemMessages.join("\n\n")}\n`;
  }
  if (context) {
    prompt += `${prompt ? "\n" : ""}Conversation context:\n${context}\n\nLatest request:\n${latestUser}`;
    return prompt.trim();
  }
  return `${prompt ? `${prompt}\n\n` : ""}${latestUser}`.trim();
}

function latestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role || "") === "user") {
      return String(messages[index]?.content || "").trim();
    }
  }
  return String(messages.at(-1)?.content || "").trim();
}

function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "cortex",
      title: "Cortex",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

// App-server errors arrive as { message } where message may itself be a JSON
// API error body; surface the human-readable part.
function codexErrorText(error) {
  const raw = String(error?.message || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.error?.message || parsed?.message || raw);
  } catch {
    return raw;
  }
}

// Asks the user through Cortex; with no handler (e.g. a connection test) the
// answer is always "decline", never a silent approve.
async function askOrDecline(askApproval, summary) {
  if (typeof askApproval !== "function") {
    return { decision: "decline", by: "no approval handler" };
  }
  try {
    return await askApproval(summary);
  } catch {
    return { decision: "decline", by: "approval error" };
  }
}

function codexFileChangeSummary(changes) {
  const list = Array.isArray(changes) ? changes : [];
  return {
    path: list.map((change) => String(change?.path || "")).filter(Boolean).join(", "),
    diff: list.map((change) => String(change?.diff || "")).filter(Boolean).join("\n"),
  };
}

class InterruptError extends Error {
  constructor(message = "Request interrupted.", partialText = "") {
    super(message);
    this.name = "InterruptError";
    this.code = "INTERRUPTED";
    this.partialText = String(partialText || "");
  }
}

function isInterruptError(error) {
  return error instanceof InterruptError || String(error?.name || "") === "InterruptError" || String(error?.code || "") === "INTERRUPTED";
}

function toInterruptError(error, partialText = "") {
  if (isInterruptError(error)) {
    return error;
  }
  if (String(error?.name || "") === "AbortError") {
    return new InterruptError("Request interrupted.", partialText);
  }
  return error;
}

function isApiLimitError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (!message) {
    return false;
  }
  const patterns = [
    /\brate limit\b/,
    /\btoo many requests\b/,
    /\b429\b/,
    /\bquota exceeded\b/,
    /\bquota\b/,
    /\busage limit\b/,
    /\blimit reached\b/,
    /\blimit will reset\b/,
    /\brequest limit\b/,
    /\bmonthly spend limit\b/,
    /\binsufficient credits?\b/,
    /\bcredit balance is too low\b/,
    /\bexceeded your current quota\b/,
  ];
  return patterns.some((pattern) => pattern.test(message));
}

function providerDisplayName(model) {
  const value = String(model || "");
  if (value.startsWith("codex:")) return "Codex";
  if (value.startsWith("claude:")) return "Claude";
  if (value.startsWith("hermes:")) return "Hermes";
  if (value.startsWith("agy:")) return "Antigravity";
  if (value.startsWith("gemini")) return "Gemini";
  return "API";
}

function toUserFacingProviderError(error, { model = "" } = {}) {
  if (isInterruptError(error)) {
    return error;
  }
  if (isApiLimitError(error)) {
    const providerName = providerDisplayName(model);
    const nextError = new Error(`API limits reached for ${providerName}.`);
    nextError.code = "API_LIMIT_REACHED";
    nextError.cause = error;
    return nextError;
  }
  return error;
}

class CodexProvider {
  constructor(repoRoot, apiKey = "") {
    this.repoRoot = path.resolve(repoRoot);
    this.apiKey = String(apiKey || "").trim();
    this.sessionId = "";
    this.sessionMode = "fresh";
    this._cliAvailable = null;
  }

  setRepoRoot(repoRoot) {
    const resolved = path.resolve(repoRoot);
    if (resolved !== this.repoRoot) {
      this.sessionId = "";
      this.sessionMode = "fresh";
    }
    this.repoRoot = resolved;
  }

  get available() {
    if (this._cliAvailable === null) {
      this._cliAvailable = Boolean(which("codex.cmd") || which("codex"));
    }
    return Boolean(this.apiKey || this._cliAvailable);
  }

  get connected() {
    return this.available;
  }

  cliModelName(model) {
    const parts = String(model || "").startsWith("codex:") ? String(model).split(":") : null;
    return parts ? parts[1] : String(model || "");
  }

  cliReasoningEffort(model) {
    const parts = String(model || "").startsWith("codex:") ? String(model).split(":") : null;
    return parts && parts[2] ? parts[2] : null;
  }

  setApiKey(apiKey) {
    this.apiKey = String(apiKey || "").trim();
  }

  /**
   * Asks `codex app-server` which models this account can use. Returns
   * [{ model, displayName, efforts: [..], defaultEffort, isDefault }] or
   * null when the CLI is missing or doesn't answer in time.
   */
  async listModels({ timeoutMs = 20000 } = {}) {
    const command = which("codex.cmd") || which("codex");
    if (!command) return null;
    const child = spawnCommand(command, ["app-server"], {
      cwd: this.repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = readline.createInterface({ input: child.stdout });
    try {
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        const done = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        child.once("error", () => done(null));
        child.once("exit", () => done(null));
        output.on("line", (line) => {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          if (message.id === 1) {
            this.writeAppServerMessage(child, { method: "initialized" });
            this.writeAppServerMessage(child, { id: 2, method: "model/list", params: {} });
            return;
          }
          if (message.id === 2) {
            const data = Array.isArray(message.result?.data) ? message.result.data : null;
            done(
              data
                ?.filter((entry) => entry?.model && !entry.hidden)
                .map((entry) => ({
                  model: String(entry.model),
                  displayName: String(entry.displayName || entry.model),
                  efforts: (entry.supportedReasoningEfforts || [])
                    .map((effort) => String(effort?.reasoningEffort || ""))
                    .filter(Boolean),
                  defaultEffort: entry.defaultReasoningEffort ? String(entry.defaultReasoningEffort) : null,
                  isDefault: Boolean(entry.isDefault),
                })) || null,
            );
          }
        });
        this.writeAppServerMessage(child, { id: 1, method: "initialize", params: buildCodexInitializeParams() });
      });
    } catch {
      return null;
    } finally {
      output.close();
      this.killChild(child);
    }
  }

  killChild(child) {
    platform.killProcessTree(child);
  }

  writeAppServerMessage(child, message) {
    if (!child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  // Answers an app-server request for approval (or anything else the server
  // asks the client). Unknown requests get a JSON-RPC error so the turn
  // never hangs waiting for us.
  changesInsideRepo(changes) {
    const list = Array.isArray(changes) ? changes : [];
    return list.length > 0 && list.every((change) => {
      const target = path.resolve(this.repoRoot, String(change?.path || ""));
      const moved = change?.kind?.move_path ? path.resolve(this.repoRoot, String(change.kind.move_path)) : null;
      return [target, moved].filter(Boolean).every((candidate) => {
        const relative = path.relative(this.repoRoot, candidate);
        return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
      });
    });
  }

  async answerServerRequest(child, message, { askApproval, items, permissionMode = "full-access" }) {
    const params = message.params || {};
    const send = (payload) => {
      try {
        this.writeAppServerMessage(child, { id: message.id, ...payload });
      } catch {
        // The process may already be gone (interrupt); nothing to answer.
      }
    };
    const approved = (answer) => answer.decision === "approve";

    switch (message.method) {
      case "item/commandExecution/requestApproval": {
        const item = items.get(String(params.itemId || "")) || {};
        const answer = await askOrDecline(askApproval, {
          kind: "command",
          toolName: "shell",
          command: String(params.command || item.command || ""),
          cwd: String(params.cwd || item.cwd || ""),
          reason: String(params.reason || ""),
        });
        send({ result: { decision: approved(answer) ? "accept" : "decline" } });
        return;
      }
      case "item/fileChange/requestApproval": {
        const item = items.get(String(params.itemId || "")) || {};
        // Codex's "untrusted" policy asks for every patch. In Auto-accept
        // edits, Cortex answers patches inside the repo itself (still
        // audited) and only asks the user about commands and outside paths.
        const autoApprove = permissionMode === "auto-accept-edits" && !params.grantRoot && this.changesInsideRepo(item.changes)
          ? "auto-accept edits mode"
          : false;
        const answer = await askOrDecline(askApproval, {
          kind: "file_change",
          toolName: "apply_patch",
          ...codexFileChangeSummary(item.changes),
          reason: String(params.reason || ""),
          autoApprove,
        });
        send({ result: { decision: approved(answer) ? "accept" : "decline" } });
        return;
      }
      case "execCommandApproval": {
        const answer = await askOrDecline(askApproval, {
          kind: "command",
          toolName: "shell",
          command: Array.isArray(params.command) ? params.command.join(" ") : String(params.command || ""),
          cwd: String(params.cwd || ""),
          reason: String(params.reason || ""),
        });
        send({ result: { decision: approved(answer) ? "approved" : "denied" } });
        return;
      }
      case "applyPatchApproval": {
        const files = params.fileChanges && typeof params.fileChanges === "object" ? params.fileChanges : {};
        const answer = await askOrDecline(askApproval, {
          kind: "file_change",
          toolName: "apply_patch",
          path: Object.keys(files).join(", "),
          diff: Object.values(files).map((change) => String(change?.unified_diff || change?.content || "")).join("\n"),
          reason: String(params.reason || ""),
        });
        send({ result: { decision: approved(answer) ? "approved" : "denied" } });
        return;
      }
      case "item/permissions/requestApproval": {
        const answer = await askOrDecline(askApproval, {
          kind: "permissions",
          toolName: "permissions",
          path: String(params.cwd || ""),
          reason: [params.reason, JSON.stringify(params.permissions || {})].filter(Boolean).join(" "),
        });
        send({ result: approved(answer) ? { permissions: params.permissions || {}, scope: "turn" } : { permissions: {} } });
        return;
      }
      default:
        send({ error: { code: -32601, message: `Cortex does not handle ${message.method}.` } });
    }
  }

  async chatCompletionAppServerStream(messages, model, { onOutput = null, signal = null, onProcessStart = null, permissionMode = "full-access", askApproval = null } = {}) {
    if (signal?.aborted) {
      throw new InterruptError("Request interrupted.");
    }
    const command = which("codex.cmd") || which("codex");
    if (!command) {
      throw new Error("codex CLI not found in PATH");
    }
    const child = spawnCommand(command, ["app-server"], {
      cwd: this.repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    onProcessStart?.(child.pid);
    const output = readline.createInterface({ input: child.stdout });
    let nextRequestId = 1;
    const pending = new Map();
    let stderr = "";
    let threadId = this.sessionId || "";
    let currentTurnId = "";
    let assistantText = "";
    let lastErrorMessage = "";
    let aborted = false;
    let abortListener = null;
    // Command and file-change items by id: approval requests only carry the
    // item id, the command / diff arrive on item/started.
    const items = new Map();
    const policy = codexPolicy(permissionMode);

    const sendRequest = (method, params, timeoutMs = 20000) =>
      new Promise((resolve, reject) => {
        const id = nextRequestId;
        nextRequestId += 1;
        const timeout = setTimeout(() => {
          pending.delete(String(id));
          reject(new Error(`Timed out waiting for ${method}.`));
        }, timeoutMs);
        pending.set(String(id), { resolve, reject, timeout, method });
        this.writeAppServerMessage(child, { id, method, params });
      });

    const settlePendingWithError = (error) => {
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      pending.clear();
    };

    const finishTurn = new Promise((resolve, reject) => {
      output.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }

        // Server -> client request (has both an id and a method).
        if (message.id !== undefined && message.method) {
          void this.answerServerRequest(child, message, { askApproval, items, permissionMode: normalizePermissionMode(permissionMode) });
          return;
        }

        if (message.id !== undefined) {
          const request = pending.get(String(message.id));
          if (!request) {
            return;
          }
          clearTimeout(request.timeout);
          pending.delete(String(message.id));
          if (message.error?.message) {
            request.reject(new Error(String(message.error.message)));
            return;
          }
          request.resolve(message.result);
          return;
        }

        if (message.method === "thread/started") {
          threadId = String(message.params?.thread?.id || threadId || "");
          return;
        }
        if (message.method === "turn/started") {
          currentTurnId = String(message.params?.turn?.id || currentTurnId || "");
          return;
        }
        if (message.method === "item/started" || message.method === "item/updated") {
          const item = message.params?.item;
          if (item?.id && (item.type === "commandExecution" || item.type === "fileChange")) {
            items.set(String(item.id), item);
          }
          return;
        }
        if (message.method === "item/agentMessage/delta") {
          const delta = String(message.params?.delta || "");
          if (delta) {
            assistantText += delta;
            onOutput?.(delta);
          }
          return;
        }
        if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
          const finalText = String(message.params?.item?.text || "");
          if (finalText && !assistantText) {
            assistantText = finalText;
          }
          return;
        }
        if (message.method === "error") {
          lastErrorMessage = codexErrorText(message.params?.error) || lastErrorMessage;
          return;
        }
        if (message.method === "turn/completed") {
          const status = String(message.params?.turn?.status || "completed");
          if (status !== "completed") {
            const detail = codexErrorText(message.params?.turn?.error) || lastErrorMessage;
            reject(new Error(detail ? `Codex: ${detail}` : `Codex turn failed with status: ${status}`));
            return;
          }
          resolve({
            threadId,
            turnId: currentTurnId || String(message.params?.turn?.id || ""),
            assistantText,
          });
        }
      });

      child.once("error", (error) => {
        settlePendingWithError(error);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (pending.size > 0 || !assistantText) {
          const error = aborted
            ? new InterruptError("Request interrupted.", assistantText)
            : new Error(stderr.trim() || `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
          settlePendingWithError(error);
          reject(error);
        }
      });
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    if (signal) {
      abortListener = () => {
        aborted = true;
        if (!child.killed) {
          this.killChild(child);
        }
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      await sendRequest("initialize", buildCodexInitializeParams());
      this.writeAppServerMessage(child, { method: "initialized" });

      const reasoningEffort = this.cliReasoningEffort(model);
      const threadStartParams = {
        approvalPolicy: policy.approvalPolicy,
        // Approval requests come to this client, never to Codex's own reviewer.
        approvalsReviewer: "user",
        sandbox: policy.sandbox,
        cwd: this.repoRoot,
        model: this.cliModelName(model),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        experimentalRawEvents: false,
      };

      let threadResponse;
      if (this.sessionMode === "resume_id" && this.sessionId) {
        try {
          threadResponse = await sendRequest("thread/resume", {
            ...threadStartParams,
            threadId: this.sessionId,
          });
        } catch {
          this.sessionId = "";
          this.sessionMode = "fresh";
          threadResponse = await sendRequest("thread/start", threadStartParams);
        }
      } else {
        threadResponse = await sendRequest("thread/start", threadStartParams);
      }

      threadId =
        String(threadResponse?.thread?.id || threadResponse?.threadId || threadId || "").trim();
      if (!threadId) {
        throw new Error("Codex thread start did not return a thread id.");
      }

      await sendRequest("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text:
              this.sessionMode === "resume_id" && this.sessionId
                ? latestUserMessage(messages)
                : buildCompactPrompt(messages, {}),
            text_elements: [],
          },
        ],
        model: this.cliModelName(model),
        approvalPolicy: policy.approvalPolicy,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });

      const result = await Promise.race([
        finishTurn,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new InterruptError(aborted ? "Request timed out after abort." : "Request timed out.", assistantText)),
            aborted ? CLI_ABORT_SETTLE_MS : CLI_TURN_TIMEOUT_MS,
          )
        ),
      ]);
      this.sessionId = String(result.threadId || threadId || "").trim();
      this.sessionMode = this.sessionId ? "resume_id" : "fresh";
      return String(result.assistantText || "(No response from codex.)");
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      output.removeAllListeners();
      output.close();
      child.removeAllListeners();
      if (!child.killed) {
        this.killChild(child);
      }
    }
  }

  async chatCompletionStreamRaw(messages, model, options = {}) {
    return this.chatCompletionAppServerStream(messages, model, options);
  }

  async chatCompletion(messages, model, options = {}) {
    return this.chatCompletionStreamRaw(messages, model, options);
  }

  async chatWithTools(messages, model, _tools, options = {}) {
    return [await this.chatCompletion(messages, model, options), null, null];
  }
}

// ── Antigravity CLI (agy) ────────────────────────────────────────────────
// Replaced Gemini CLI. Runs `agy -p` in print mode with NDJSON in and out:
//   stdin   {"event":"user","message":{"role":"user","content":"..."}}
//   stdout  {"event":"init","conversation_id":...,"init":{model,cwd,tools,permission_mode}}
//           {"event":"step_update","step_update":{conversation_id,step_index,state,step_type,...}}
//             step_type "agent_response": text_delta (state ACTIVE/DONE)
//             step_type "tool": tool_name, tool_info {name, parameters, output | error}
//                               (state ACTIVE, then DONE or ERROR)
//           {"event":"result","result":{conversation_id,status,response,error?,denied_actions?,finished_reason?}}
// Samples: tests/fixtures/agy. Resume is --conversation <id>; an unknown id
// makes agy warn on stderr and start a new conversation.

const AGY_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const AGY_EFFORT_LABEL = /^(.*?)\s*\((minimal|low|medium|high|extra high|xhigh|max)\)$/i;

/**
 * Parses `agy models` output ("<id>\t<label>" per line). Effort variants
 * ("gemini-3.8-flash-high" / "Gemini 3.8 Flash (High)") share a `base` so the
 * picker can group them like Codex. Returns
 * [{ model, displayName, base, effort }].
 */
function parseAgyModels(text) {
  const entries = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const [rawId, ...rest] = line.split("\t");
    const model = String(rawId || "").trim();
    if (!model || !rest.length || /\s/.test(model)) continue;
    const label = rest.join(" ").trim() || model;
    const idMatch = model.match(new RegExp(`^(.+)-(${AGY_EFFORTS.join("|")})$`));
    const labelMatch = label.match(AGY_EFFORT_LABEL);
    if (idMatch && labelMatch) {
      entries.push({ model, displayName: labelMatch[1].trim(), base: idMatch[1], effort: idMatch[2] });
    } else {
      entries.push({ model, displayName: label, base: model, effort: null });
    }
  }
  return entries;
}

/**
 * Follows one agy stream-json run. Calls onText(delta) for reply text (with a
 * paragraph break between separate agent responses), onToolCall / onToolResult
 * for tool steps, and keeps the conversation id and the final result.
 */
class AgyStreamParser {
  constructor({ onText = null, onToolCall = null, onToolResult = null } = {}) {
    this.onText = onText;
    this.onToolCall = onToolCall;
    this.onToolResult = onToolResult;
    this.conversationId = "";
    this.text = "";
    this.result = null;
    this.lastTextStep = null;
    this.startedTools = new Set();
  }

  emitText(delta) {
    if (!delta) return;
    this.text += delta;
    this.onText?.(delta);
  }

  push(event) {
    if (!event || typeof event !== "object") return;
    if (event.event === "init") {
      this.conversationId = String(event.conversation_id || this.conversationId || "");
      return;
    }
    if (event.event === "result") {
      this.result = event.result && typeof event.result === "object" ? event.result : {};
      this.conversationId = String(this.result.conversation_id || this.conversationId || "");
      return;
    }
    if (event.event !== "step_update") return;
    const step = event.step_update || {};
    if (!this.conversationId && step.conversation_id) this.conversationId = String(step.conversation_id);
    if (step.step_type === "agent_response") {
      const delta = String(step.text_delta || "");
      if (!delta) return;
      if (this.lastTextStep !== step.step_index && this.text.trim()) {
        // A new response after a tool call: start a new paragraph.
        const trimmed = this.text.replace(/[ \t]+$/, "");
        const gap = trimmed.endsWith("\n\n") ? "" : trimmed.endsWith("\n") ? "\n" : "\n\n";
        this.emitText(gap);
      }
      this.lastTextStep = step.step_index;
      this.emitText(delta);
      return;
    }
    if (step.step_type === "tool") {
      const info = step.tool_info || {};
      const id = String(step.step_index ?? "");
      const name = String(step.tool_name || info.name || "tool");
      const args = info.parameters && typeof info.parameters === "object" ? info.parameters : {};
      if (!this.startedTools.has(id)) {
        this.startedTools.add(id);
        this.onToolCall?.({ id, name, args });
      }
      if (step.state === "DONE") {
        this.onToolResult?.({ id, name, ok: true, result: String(info.output || "done") });
      } else if (step.state === "ERROR") {
        this.onToolResult?.({ id, name, ok: false, result: `ERROR: ${String(info.error?.message || "tool failed")}` });
      }
    }
  }

  // The reply: streamed text, or the result's response if nothing streamed.
  finalText() {
    const streamed = this.text.trim();
    return streamed || String(this.result?.response || "").trim();
  }

  deniedActions() {
    const list = Array.isArray(this.result?.denied_actions) ? this.result.denied_actions : [];
    return list.map((item) => String(item?.display_name || item?.action || "")).filter(Boolean);
  }
}

// One `agy -p` error line: the structured AGY_ERROR JSON, an "error:" line,
// or the last non-empty stderr line.
function agyErrorText(stderr) {
  const lines = String(stderr || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const structured = lines.find((line) => line.startsWith("AGY_ERROR:"));
  if (structured) {
    try {
      const parsed = JSON.parse(structured.slice("AGY_ERROR:".length));
      return String(parsed?.message || parsed?.error || structured);
    } catch {
      return structured;
    }
  }
  const marked = lines.find((line) => /^error:/i.test(line));
  return (marked || lines.at(-1) || "").replace(/^error:\s*/i, "");
}

class AgyCliProvider {
  constructor(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
    this.sessionId = "";
    this.sessionMode = "fresh";
    this._available = null;
    // Live `agy models` list ([{ model, displayName, base, effort }]) once known.
    this.models = null;
    // Whether agy has been seen loading Cortex's hook from an added workspace.
    this._hookVerified = false;
  }

  setRepoRoot(repoRoot) {
    const resolved = path.resolve(repoRoot);
    if (resolved !== this.repoRoot) {
      this.sessionId = "";
      this.sessionMode = "fresh";
    }
    this.repoRoot = resolved;
  }

  resolveCli() {
    return which("agy.exe") || which("agy.cmd") || which("agy");
  }

  get available() {
    if (this._available === null) {
      this._available = Boolean(this.resolveCli());
    }
    return this._available;
  }

  get connected() {
    return this.available;
  }

  // The --model value for a Cortex id, or "" to let agy pick its default
  // (agy:default, or a model agy no longer lists).
  cliModelName(model) {
    const value = String(model || "");
    const id = value.startsWith("agy:") ? value.slice("agy:".length) : value;
    if (!id || id === "default") return "";
    if (Array.isArray(this.models) && this.models.length && !this.models.some((entry) => entry.model === id)) {
      return "";
    }
    return id;
  }

  // Runs agy to completion and returns { code, stdout, stderr } (code null on
  // timeout). For short subcommands such as `agy models`.
  _runQuick(args, { timeoutMs = 30000, env = {} } = {}) {
    const cli = this.resolveCli();
    if (!cli) return Promise.resolve(null);
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let child;
      try {
        child = spawnCommand(cli, args, { cwd: this.repoRoot, stdio: ["ignore", "pipe", "pipe"], env });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        platform.killProcessTree(child);
        resolve({ code: null, stdout, stderr });
      }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  /**
   * Asks `agy models` which models this account can use. Returns the parsed
   * list (see parseAgyModels) or null when agy is missing, signed out or
   * slow. Keeps the list for cliModelName.
   */
  async listModels({ timeoutMs = 30000 } = {}) {
    const result = await this._runQuick(["models"], { timeoutMs });
    if (!result || result.code !== 0) return null;
    const models = parseAgyModels(result.stdout);
    if (!models.length) return null;
    this.models = models;
    return models;
  }

  // Checks once that agy loads hooks from an added workspace (asking `/hooks`
  // costs no model turn). Without that check a Supervised turn would run
  // approved-by-rule commands with nobody asking.
  async verifyHook(hook) {
    if (this._hookVerified) return true;
    const result = await this._runQuick(
      ["-p", "/hooks", "--output-format", "json", "--add-dir", hook.dir],
      { timeoutMs: 30000, env: hook.env },
    );
    let hooks = [];
    try {
      hooks = JSON.parse(String(result?.stdout || "").trim())?.command?.data?.hooks || [];
    } catch {
      hooks = [];
    }
    const hookDir = path.resolve(hook.dir).toLowerCase();
    this._hookVerified = hooks.some((entry) => entry?.enabled !== false
      && path.resolve(String(entry?.source || "")).toLowerCase().startsWith(hookDir));
    return this._hookVerified;
  }

  buildArgs(model, { permission = agyPermissionConfig("full-access"), hookDir = "" } = {}) {
    const args = [
      "-p", "",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      // A message starting with "/" is the user's text, not an agy command.
      "--disable-slash-commands",
      ...permission.args,
    ];
    if (permission.settings) {
      // Session-only settings; never written to the user's agy config.
      args.push("--settings", JSON.stringify(permission.settings));
    }
    if (hookDir) {
      args.push("--add-dir", hookDir);
    }
    if (this.sessionMode === "resume_id" && this.sessionId) {
      args.push("--conversation", this.sessionId);
    }
    const cliModel = this.cliModelName(model);
    if (cliModel) {
      args.push("--model", cliModel);
    }
    return args;
  }

  async chatCompletionStreamRaw(messages, model, options = {}) {
    const { signal = null, permissionMode = "full-access", approvalBridge = null, onNotice = null } = options;
    if (signal?.aborted) {
      throw new InterruptError("Request interrupted.");
    }
    const cli = this.resolveCli();
    if (!cli) {
      throw new Error("agy CLI not found in PATH");
    }
    const mode = normalizePermissionMode(permissionMode);
    const wantsHook = (mode === "supervised" || mode === "auto-accept-edits")
      && Boolean(approvalBridge?.url && approvalBridge?.token);
    let hook = null;
    if (wantsHook) {
      try {
        hook = writeAgyHookWorkspace({ url: approvalBridge.url, token: approvalBridge.token, repoRoot: this.repoRoot });
        if (!(await this.verifyHook(hook))) {
          hook.cleanup();
          hook = null;
        }
      } catch {
        hook?.cleanup();
        hook = null;
      }
      if (!hook) onNotice?.(agyFallbackNote(mode));
    }
    try {
      approvalBridge?.onWorkspace?.(hook?.dir || "");
      const permission = agyPermissionConfig(mode, { hook: Boolean(hook) });
      return await this._runAgy(cli, messages, model, options, { permission, hook });
    } finally {
      hook?.cleanup();
    }
  }

  async _runAgy(cli, messages, model, options, { permission, hook, retried = false }) {
    const { onOutput = null, onEvent = null, signal = null, onProcessStart = null } = options;
    const resuming = this.sessionMode === "resume_id" && Boolean(this.sessionId);
    const prompt = resuming
      ? latestUserMessage(messages)
      : buildCompactPrompt(messages, {
        head: [
          "You are running inside Cortex in non-interactive print mode.",
          `Work in ${this.repoRoot}.`,
          "Return the final answer to the user's request.",
        ].join("\n"),
      });
    const child = spawnCommand(cli, this.buildArgs(model, { permission, hookDir: hook?.dir || "" }), {
      cwd: this.repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: hook ? hook.env : {},
    });
    onProcessStart?.(child.pid);
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`);

    let stderr = "";
    let aborted = false;
    let staleResume = false;
    let abortListener = null;
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    if (signal) {
      abortListener = () => {
        aborted = true;
        platform.killProcessTree(child);
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    const parser = new AgyStreamParser({
      onText: (delta) => onOutput?.(delta),
      onToolCall: ({ id, name, args }) => onEvent?.("tool_call", { id, name, args }),
      onToolResult: ({ id, name, ok, result }) => onEvent?.("tool_result", { id, name, ok, result, change: null }),
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    const stream = readline.createInterface({ input: child.stdout });
    try {
      for await (const line of stream) {
        const trimmed = String(line || "").trim();
        if (!trimmed) continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        parser.push(event);
        // A stale --conversation id: agy starts a new conversation instead.
        // Stop before the model runs and retry with the full context.
        if (event.event === "init" && resuming && parser.conversationId && parser.conversationId !== this.sessionId) {
          staleResume = true;
          platform.killProcessTree(child);
          break;
        }
      }
      let settleTimer = null;
      const exitCode = await Promise.race([
        closed,
        new Promise((resolve) => {
          settleTimer = setTimeout(() => resolve(null), aborted || staleResume ? CLI_ABORT_SETTLE_MS : CLI_TURN_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(settleTimer);
      if (aborted) {
        throw new InterruptError("Request interrupted.", parser.text);
      }
      if (staleResume && !retried) {
        this.sessionId = "";
        this.sessionMode = "fresh";
        return this._runAgy(cli, messages, model, options, { permission, hook, retried: true });
      }
      if (parser.conversationId) {
        this.sessionId = parser.conversationId;
        this.sessionMode = "resume_id";
      }
      const status = String(parser.result?.status || "");
      if (exitCode !== 0 || status === "ERROR") {
        const detail = String(parser.result?.error || "").trim() || agyErrorText(stderr) || `exit code ${exitCode}`;
        throw new Error(`agy CLI failed: ${detail}`);
      }
      let text = parser.finalText();
      const denied = parser.deniedActions();
      if (denied.length) {
        const note = `Antigravity was not allowed to: ${[...new Set(denied)].join(", ")} (blocked by this chat's permission mode).`;
        const addition = text ? `\n\n_${note}_` : note;
        onOutput?.(addition);
        text = `${text}${addition}`;
      }
      return text || "(No response from Antigravity.)";
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      stream.removeAllListeners();
      stream.close();
    }
  }

  async chatCompletion(messages, model, options = {}) {
    return this.chatCompletionStreamRaw(messages, model, options);
  }

  async chatWithTools(messages, model, _tools, options = {}) {
    return [await this.chatCompletion(messages, model, options), null, null];
  }
}

class ClaudeCliProvider {
  constructor(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
    this.sessionId = "";
    this.sessionMode = "fresh";
    this._available = null;
  }

  setRepoRoot(repoRoot) {
    const resolved = path.resolve(repoRoot);
    if (resolved !== this.repoRoot) {
      this.sessionId = "";
      this.sessionMode = "fresh";
    }
    this.repoRoot = resolved;
  }

  resolveCli() {
    const shim =
      which("claude.cmd")
      || which("claude.ps1")
      || which("claude");
    if (!shim) {
      return null;
    }
    const basedir = path.dirname(shim);
    const cliJs = path.join(basedir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    const node = which("node");
    if (node && require("node:fs").existsSync(cliJs)) {
      // Full path (node.exe on Windows) so it is spawned directly, not via cmd.exe.
      return { command: node, argsPrefix: [cliJs] };
    }
    return { command: shim, argsPrefix: [] };
  }

  get available() {
    if (this._available === null) {
      this._available = Boolean(this.resolveCli());
    }
    return this._available;
  }

  get connected() {
    return this.available;
  }

  cliModelName(model) {
    if (!String(model || "").startsWith("claude:")) {
      return model;
    }
    const raw = String(model).split(":", 2)[1];
    if (raw === "sonnet") return "sonnet";
    if (raw === "opus") return "opus";
    if (raw === "haiku") return "haiku";
    return raw;
  }

  extractEventText(event) {
    const assistantParts = Array.isArray(event?.message?.content)
      ? event.message.content
      : Array.isArray(event?.content)
        ? event.content
        : [];
    const assistantText = assistantParts
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && part.type === "text") return String(part.text || "");
        return "";
      })
      .join("");
    if (assistantText) return assistantText;
    return String(event?.delta?.text ?? event?.text ?? event?.completion ?? event?.result ?? "");
  }

  // `mcpConfigPath` is the per-turn approval bridge config; when it is set,
  // permission prompts go to Cortex, otherwise they are refused.
  buildArgs(model, { permissionMode = "full-access", mcpConfigPath = "", settingsPath = "" } = {}) {
    const args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
    ];

    // Restrict Claude Code's native tools to the active repo directory only.
    // --add-dir tells Claude Code that this is the only filesystem path its
    // Read/Write/Edit/Bash tools are permitted to access. Without this flag,
    // Bash can `cd` anywhere and Read can open any file on the system.
    args.push("--add-dir", this.repoRoot);

    // Full access: skip permissions except risky shell commands, which ask
    // (Bash still confined to repoRoot via --add-dir). Read-only: reads and
    // searches only. Supervised / auto-accept edits: everything else goes
    // through the approval prompt tool.
    args.push(...claudePermissionArgs(permissionMode, { promptTool: Boolean(mcpConfigPath), settingsPath }));
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }
    if (this.sessionMode === "resume_id" && this.sessionId) {
      args.push("--resume", this.sessionId);
    }
    const cliModel = this.cliModelName(model);
    if (cliModel) {
      args.push("--model", cliModel);
    }
    return args;
  }

  async chatCompletionStreamRaw(messages, model, options = {}) {
    const { signal = null, permissionMode = "full-access", approvalBridge = null } = options;
    if (signal?.aborted) {
      throw new InterruptError("Request interrupted.");
    }
    const entry = this.resolveCli();
    if (!entry) {
      throw new Error("claude CLI not found in PATH");
    }
    const prompt = buildCompactPrompt(messages, {
      head: [
        "You are running in non-interactive print mode.",
        "Return only the final answer to the user's request.",
        "Do not output planning or tool chatter.",
      ].join("\n"),
    });
    const mode = normalizePermissionMode(permissionMode);
    const useBridge = Boolean(approvalBridge?.url && approvalBridge?.token) && mode !== "read-only";
    // Full access: with the bridge every shell call asks Cortex, which only
    // shows risky ones; without it Claude's own risky-pattern rules decline.
    const settings = mode === "full-access" ? (useBridge ? claudeShellAskSettings() : claudeRiskyAskSettings()) : null;
    const bridge = useBridge || settings
      ? writeClaudeMcpConfig({ ...(useBridge ? approvalBridge : {}), settings })
      : null;
    let child;
    try {
      const turnArgs = { permissionMode: mode, mcpConfigPath: bridge?.configPath || "", settingsPath: bridge?.settingsPath || "" };
      child = spawnCommand(entry.command, [...entry.argsPrefix, ...this.buildArgs(model, turnArgs)], {
        cwd: this.repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        // An approval can wait on the user for minutes; don't let Claude's MCP
        // call timeout decline it first.
        env: bridge?.configPath ? { MCP_TOOL_TIMEOUT: String(CLI_TURN_TIMEOUT_MS) } : {},
      });
    } catch (error) {
      bridge?.cleanup();
      throw error;
    }
    try {
      return await this._runClaudeChild(child, prompt, messages, model, options);
    } finally {
      bridge?.cleanup();
    }
  }

  async _runClaudeChild(child, prompt, messages, model, options) {
    const { onOutput = null, signal = null, onProcessStart = null } = options;
    onProcessStart?.(child.pid);
    child.stdin.write(prompt);
    child.stdin.end();
    let stderr = "";
    let fullText = "";
    let aborted = false;
    let abortListener = null;
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    if (signal) {
      abortListener = () => {
        aborted = true;
        if (process.platform === "win32" && child.pid !== undefined) {
          try {
            spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          } catch {
            child.kill();
          }
          return;
        }
        child.kill();
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    let cliErrorMessage = "";
    const stream = readline.createInterface({ input: child.stdout });
    try {
      for await (const line of stream) {
        const trimmed = String(line || "").trim();
        if (!trimmed) continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          fullText += trimmed;
          continue;
        }
        if (event.session_id) {
          this.sessionId = String(event.session_id);
          this.sessionMode = "resume_id";
        }
        // Capture CLI-level errors reported in the result event (e.g. bad --resume ID)
        if (event?.type === "result" && event?.is_error === true) {
          const errDetail = Array.isArray(event.errors) && event.errors.length > 0
            ? String(event.errors[0])
            : "";
          if (errDetail) cliErrorMessage = errDetail;
        }
        const content = (event?.type === "result" && fullText) ? "" : this.extractEventText(event);
        // Each assistant event is a whole message (text before a tool call,
        // then text after it), so start a new paragraph between them.
        if (content) fullText += (fullText && event?.type === "assistant" ? "\n\n" : "") + content;
      }
      const exitCode = await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(() => resolve(null), aborted ? CLI_ABORT_SETTLE_MS : CLI_TURN_TIMEOUT_MS)),
      ]);
      if (aborted) {
        throw new InterruptError("Request interrupted.", fullText);
      }
      if (exitCode !== 0) {
        // If resume failed with a bad session ID, clear the session and retry fresh.
        if (
          this.sessionMode === "resume_id"
          && (cliErrorMessage.includes("--resume") || cliErrorMessage.includes("session"))
        ) {
          this.sessionId = "";
          this.sessionMode = "fresh";
          return this.chatCompletionStreamRaw(messages, model, options);
        }
        throw new Error(`claude CLI failed: ${(cliErrorMessage || stderr || `exit code ${exitCode}`).trim()}`);
      }
      // Simulate streaming: emit word-by-word so the UI doesn't flash the full
      // response at once. Claude CLI buffers on Windows so we can't get real tokens.
      if (onOutput && fullText) {
        const tokens = fullText.match(/\S+\s*/g) || [fullText];
        for (const token of tokens) {
          if (signal?.aborted) break;
          onOutput(token);
          await new Promise((r) => setTimeout(r, 18));
        }
      }
      return fullText || "(No response from Claude.)";
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      stream.removeAllListeners();
      stream.close();
    }
  }

  async chatCompletion(messages, model, options = {}) {
    return this.chatCompletionStreamRaw(messages, model, options);
  }

  async chatWithTools(messages, model, _tools, options = {}) {
    return [await this.chatCompletion(messages, model, options), null, null];
  }
}

class HermesCliProvider {
  constructor(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
    this.sessionId = "";
    this.sessionMode = "fresh";
    this._available = null;
  }

  setRepoRoot(repoRoot) {
    const resolved = path.resolve(repoRoot);
    if (resolved !== this.repoRoot) {
      this.sessionId = "";
      this.sessionMode = "fresh";
    }
    this.repoRoot = resolved;
  }

  resolveCli() {
    return which("hermes.exe") || which("hermes.cmd") || which("hermes");
  }

  get available() {
    if (this._available === null) {
      this._available = Boolean(this.resolveCli());
    }
    return this._available;
  }

  get connected() {
    return this.available;
  }

  buildArgs(prompt) {
    const args = ["chat", "-Q", "-q", prompt];
    if (this.sessionMode === "resume_id" && this.sessionId) {
      args.push("--resume", this.sessionId);
    }
    return args;
  }

  async chatCompletionStreamRaw(messages, model, { onOutput = null, signal = null, onProcessStart = null } = {}) {
    if (signal?.aborted) {
      throw new InterruptError("Request interrupted.");
    }
    const cli = this.resolveCli();
    if (!cli) {
      throw new Error("hermes CLI not found in PATH");
    }
    const prompt = buildCompactPrompt(messages, {
      head: [
        "You are running in non-interactive single-query mode.",
        "Return only the final answer to the user's request.",
      ].join("\n"),
    });
    // Spawn the hermes executable directly (not through cmd.exe) so the
    // multi-line prompt survives as a single -q argument; cmd.exe would
    // truncate the command line at the first newline.
    const child = spawn(cli, this.buildArgs(prompt), {
      cwd: this.repoRoot,
      env: buildCleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    onProcessStart?.(child.pid);
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let abortListener = null;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    if (signal) {
      abortListener = () => {
        aborted = true;
        platform.killProcessTree(child);
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    try {
      const exitCode = await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(() => resolve(null), aborted ? CLI_ABORT_SETTLE_MS : CLI_TURN_TIMEOUT_MS)),
      ]);
      // Quiet mode prints the answer to stdout and a "session_id: <id>"
      // line to stderr. Resumed turns prepend an ANSI-colored
      // "↻ Resumed session <id> (...)" banner line — drop it.
      let fullText = stripAnsi(String(stdout || ""))
        .replace(/^\s*↻?\s*Resumed session \S+[^\n]*\n?/, "")
        .trim();
      const sessionMatch = String(stderr || "").match(/session_id:\s*(\S+)/);
      if (sessionMatch) {
        this.sessionId = sessionMatch[1];
        this.sessionMode = "resume_id";
      }
      if (aborted) {
        throw new InterruptError("Request interrupted.", fullText);
      }
      if (exitCode !== 0) {
        // A stale --resume ID can fail the run; clear the session and retry fresh.
        if (this.sessionMode === "resume_id" && this.sessionId) {
          this.sessionId = "";
          this.sessionMode = "fresh";
          return this.chatCompletionStreamRaw(messages, model, { onOutput, signal, onProcessStart });
        }
        throw new Error(`hermes CLI failed: ${(stderr || `exit code ${exitCode}`).trim()}`);
      }
      // Simulate streaming: hermes -Q buffers the full answer, so emit
      // word-by-word like the Claude CLI provider does.
      if (onOutput && fullText) {
        const tokens = fullText.match(/\S+\s*/g) || [fullText];
        for (const token of tokens) {
          if (signal?.aborted) break;
          onOutput(token);
          await new Promise((r) => setTimeout(r, 18));
        }
      }
      return fullText || "(No response from Hermes.)";
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  async chatCompletion(messages, model, options = {}) {
    return this.chatCompletionStreamRaw(messages, model, options);
  }

  async chatWithTools(messages, model, _tools, options = {}) {
    return [await this.chatCompletion(messages, model, options), null, null];
  }
}

class GroqProvider {
  constructor(apiKey = "") {
    this.apiKey = String(apiKey || "").trim();
  }

  setApiKey(apiKey) {
    this.apiKey = String(apiKey || "").trim();
  }

  get available() {
    return true;
  }

  get connected() {
    return Boolean(this.apiKey);
  }

  async request(body, { signal = null } = {}) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error?.message || `Groq error ${response.status}`);
      }
      return data;
    } catch (error) {
      throw toInterruptError(error);
    }
  }

  async chatCompletion(messages, model, options = {}) {
    const data = await this.request({
      model,
      messages,
      temperature: 0.2,
    }, options);
    return data?.choices?.[0]?.message?.content || "(No content returned.)";
  }

  async chatWithTools(messages, model, tools, options = {}) {
    const data = await this.request({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 8192,
    }, options);
    const message = data?.choices?.[0]?.message || {};
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      return [
        null,
        {
          role: "assistant",
          content: message.content || "",
          tool_calls: message.tool_calls,
        },
        message.tool_calls,
      ];
    }
    return [message.content || "(No response.)", null, null];
  }
}

class GeminiApiProvider {
  constructor(apiKey = "") {
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = "https://generativelanguage.googleapis.com/v1beta";
  }

  setApiKey(apiKey) {
    this.apiKey = String(apiKey || "").trim();
  }

  get available() {
    return true;
  }

  get connected() {
    return Boolean(this.apiKey);
  }

  toGeminiMessages(messages) {
    let systemInstruction = null;
    const contents = [];
    for (const message of messages) {
      const role = String(message.role || "");
      if (role === "system") {
        systemInstruction = String(message.content || "");
        continue;
      }
      if (role === "user") {
        contents.push({ role: "user", parts: [{ text: String(message.content || "") }] });
        continue;
      }
      if (role === "assistant") {
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        const parts = [];
        if (message.content) {
          parts.push({ text: String(message.content) });
        }
        for (const toolCall of toolCalls) {
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments || "{}"),
            },
          });
        }
        contents.push({ role: "model", parts });
        continue;
      }
      if (role === "tool") {
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: String(message.name || "unknown"),
                response: { result: String(message.content || "") },
              },
            },
          ],
        });
      }
    }
    return { systemInstruction, contents };
  }

  async post(model, body, { signal = null } = {}) {
    try {
      const response = await fetch(`${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error?.message || `Gemini error ${response.status}`);
      }
      return data;
    } catch (error) {
      throw toInterruptError(error);
    }
  }

  parseResponse(result) {
    const candidate = result?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter((part) => part.functionCall).map((part, index) => ({
      id: `call_${index}`,
      type: "function",
      function: {
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args || {}),
      },
    }));
    if (functionCalls.length) {
      return [
        null,
        { role: "assistant", content: parts.filter((part) => part.text).map((part) => part.text).join(""), tool_calls: functionCalls },
        functionCalls,
      ];
    }
    return [parts.filter((part) => part.text).map((part) => part.text).join("").trim() || "(No response.)", null, null];
  }

  async chatCompletion(messages, model, options = {}) {
    const { systemInstruction, contents } = this.toGeminiMessages(messages);
    const body = {
      contents,
      generation_config: { temperature: 0.2, maxOutputTokens: 8192 },
    };
    if (systemInstruction) {
      body.system_instruction = { parts: [{ text: systemInstruction }] };
    }
    const result = await this.post(model, body, options);
    return this.parseResponse(result)[0] || "(No response.)";
  }

  async chatWithTools(messages, model, tools, options = {}) {
    const { systemInstruction, contents } = this.toGeminiMessages(messages);
    const body = {
      contents,
      tools: [
        {
          function_declarations: tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          })),
        },
      ],
      tool_config: { function_calling_config: { mode: "AUTO" } },
      generation_config: { temperature: 0.2, maxOutputTokens: 8192 },
    };
    if (systemInstruction) {
      body.system_instruction = { parts: [{ text: systemInstruction }] };
    }
    const result = await this.post(model, body, options);
    return this.parseResponse(result);
  }
}

module.exports = {
  spawnCommand,
  which,
  CodexProvider,
  AgyCliProvider,
  AgyStreamParser,
  parseAgyModels,
  ClaudeCliProvider,
  HermesCliProvider,
  GroqProvider,
  GeminiApiProvider,
  InterruptError,
  isInterruptError,
  isApiLimitError,
  toUserFacingProviderError,
  buildCompactPrompt,
};
