const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

function which(command) {
  const checker = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(checker, [command], { encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) {
    return null;
  }
  const first = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first || null;
}

function quoteWindowsArg(value) {
  const text = String(value ?? "");
  if (text.length === 0) {
    return '""';
  }
  if (!/[\s"]/u.test(text)) {
    return text;
  }
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function spawnCommand(command, args, options = {}) {
  if (process.platform !== "win32") {
    return spawn(command, args, { ...options, shell: false });
  }
  const commandLine = [quoteWindowsArg(command), ...args.map(quoteWindowsArg)].join(" ");
  return spawn("cmd.exe", ["/d", "/s", "/c", commandLine], {
    ...options,
    shell: false,
    windowsHide: true,
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
      name: "gpt_tui_desktop",
      title: "GPT TUI Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
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

class CodexProvider {
  constructor(repoRoot, apiKey = "") {
    this.repoRoot = path.resolve(repoRoot);
    this.apiKey = String(apiKey || "").trim();
    this.sessionId = "";
    this.sessionMode = "fresh";
    this.toolReadOnly = false;
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
    return Boolean(this.apiKey || which("codex.cmd") || which("codex"));
  }

  get connected() {
    return this.available;
  }

  cliModelName(model) {
    return String(model || "").startsWith("codex:") ? String(model).split(":", 2)[1] : model;
  }

  setApiKey(apiKey) {
    this.apiKey = String(apiKey || "").trim();
  }

  killChild(child) {
    if (process.platform === "win32" && child.pid !== undefined) {
      try {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        return;
      } catch {
        // Fall through to direct kill.
      }
    }
    child.kill();
  }

  writeAppServerMessage(child, message) {
    if (!child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async chatCompletionAppServerStream(messages, model, { onOutput = null, signal = null } = {}) {
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
    const output = readline.createInterface({ input: child.stdout });
    let nextRequestId = 1;
    const pending = new Map();
    let stderr = "";
    let threadId = this.sessionId || "";
    let currentTurnId = "";
    let assistantText = "";
    let aborted = false;
    let abortListener = null;

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
        if (message.method === "turn/completed") {
          const status = String(message.params?.turn?.status || "completed");
          if (status !== "completed") {
            reject(new Error(`Codex turn failed with status: ${status}`));
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

      const threadStartParams = {
        approvalPolicy: "never",
        sandbox: this.toolReadOnly ? "read-only" : "workspace-write",
        cwd: this.repoRoot,
        model: this.cliModelName(model),
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
      });

      const result = await finishTurn;
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

class GeminiCliProvider {
  constructor(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
    this.sessionId = "";
    this.sessionMode = "fresh";
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
    return Boolean(which("gemini.cmd") || which("gemini.ps1") || which("gemini"));
  }

  get connected() {
    return this.available;
  }

  cliModelName(model) {
    if (!String(model || "").startsWith("gemini-cli:")) {
      return model;
    }
    const raw = String(model).split(":", 2)[1];
    return raw === "auto" ? "auto-gemini-2.5" : raw;
  }

  buildArgs(model) {
    const args = [
      "--prompt",
      "",
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo",
      "--accept-raw-output-risk",
      "--extensions",
      "none",
    ];
    if (this.sessionMode === "resume_id" && this.sessionId) {
      args.push("--resume", this.sessionId);
    }
    const cliModel = this.cliModelName(model);
    if (cliModel) {
      args.push("--model", cliModel);
    }
    return args;
  }

  async chatCompletionStreamRaw(messages, model, { onOutput = null, signal = null } = {}) {
    if (signal?.aborted) {
      throw new InterruptError("Request interrupted.");
    }
    const command = which("gemini.cmd") || which("gemini.ps1") || which("gemini");
    if (!command) {
      throw new Error("gemini CLI not found in PATH");
    }
    const prompt = buildCompactPrompt(messages, {
      head: [
        "You are running in non-interactive terminal stream-json mode.",
        "Return only the final answer to the user's request.",
        "Do not output planning or tool chatter.",
      ].join("\n"),
    });
    const child = spawnCommand(command, this.buildArgs(model), {
      cwd: this.repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(prompt);
    child.stdin.end();
    let stderr = "";
    let assistantText = "";
    let aborted = false;
    let abortListener = null;
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
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
    const stream = readline.createInterface({ input: child.stdout });
    try {
      for await (const line of stream) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "init" && event.session_id) {
          this.sessionId = String(event.session_id);
          this.sessionMode = "resume_id";
        }
        if (event.type === "message" && event.role === "assistant") {
          const content = String(event.content || "");
          const nextText = event.delta ? `${assistantText}${content}` : content;
          const delta = nextText.startsWith(assistantText) ? nextText.slice(assistantText.length) : content;
          assistantText = nextText;
          if (delta) {
            onOutput?.(delta);
          }
        }
      }
      const exitCode = await new Promise((resolve) => child.once("close", resolve));
      if (aborted) {
        throw new InterruptError("Request interrupted.", assistantText);
      }
      if (exitCode !== 0) {
        throw new Error(`gemini CLI failed: ${(stderr || `exit code ${exitCode}`).trim()}`);
      }
      return assistantText || "(No response from Gemini CLI.)";
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
  CodexProvider,
  GeminiCliProvider,
  GroqProvider,
  GeminiApiProvider,
  InterruptError,
  isInterruptError,
  buildCompactPrompt,
};
