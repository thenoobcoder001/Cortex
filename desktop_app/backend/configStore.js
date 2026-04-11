const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_MODEL } = require("./constants");

function normalizeContextCarryMessages(value, fallback = 5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(Math.trunc(parsed), 20));
}

function configDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "gpt-tui");
  }
  return path.join(os.homedir(), ".config", "gpt-tui");
}

function configFile() {
  return path.join(configDir(), "config.json");
}

class AppConfigStore {
  constructor() {
    this.path = configFile();
    this.repoRoot = "";
    this.activeChatId = "";
    this.model = DEFAULT_MODEL;
    this.apiKey = "";
    this.geminiApiKey = "";
    this.openaiApiKey = "";
    this.promptPreset = "code";
    this.toolSafetyMode = "write";
    this.assistantMemory = "";
    this.contextCarryMessages = 5;
    this.geminiSessionId = "";
    this.codexSessionId = "";
    this.activeRuns = [];
    this.interruptedRuns = [];
  }

  static load() {
    const config = new AppConfigStore();
    try {
      if (fs.existsSync(config.path)) {
        const raw = JSON.parse(fs.readFileSync(config.path, "utf8"));
        config.repoRoot = String(raw.repo_root || raw.repoRoot || "");
        config.activeChatId = String(raw.active_chat_id || raw.activeChatId || "");
        config.model = String(raw.model || DEFAULT_MODEL) || DEFAULT_MODEL;
        config.apiKey = String(raw.api_key || raw.apiKey || "");
        config.geminiApiKey = String(raw.gemini_api_key || raw.geminiApiKey || "");
        config.openaiApiKey = String(raw.openai_api_key || raw.openaiApiKey || "");
        config.promptPreset = String(raw.prompt_preset || raw.promptPreset || "code") || "code";
        config.toolSafetyMode = String(raw.tool_safety_mode || raw.toolSafetyMode || "write") || "write";
        config.assistantMemory = String(raw.assistant_memory || raw.assistantMemory || "");
        config.contextCarryMessages = normalizeContextCarryMessages(
          raw.context_carry_messages ?? raw.contextCarryMessages,
          5,
        );
        config.geminiSessionId = String(raw.gemini_session_id || raw.geminiSessionId || "");
        config.codexSessionId = String(raw.codex_session_id || raw.codexSessionId || "");
        config.activeRuns = Array.isArray(raw.active_runs || raw.activeRuns) ? raw.active_runs || raw.activeRuns : [];
        config.interruptedRuns = Array.isArray(raw.interrupted_runs || raw.interruptedRuns)
          ? raw.interrupted_runs || raw.interruptedRuns
          : [];
      }
    } catch {
      return config;
    }
    return config;
  }

  save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(
      this.path,
      JSON.stringify(
        {
          repo_root: this.repoRoot,
          active_chat_id: this.activeChatId,
          model: this.model,
          api_key: this.apiKey,
          gemini_api_key: this.geminiApiKey,
          openai_api_key: this.openaiApiKey,
          prompt_preset: this.promptPreset,
          tool_safety_mode: this.toolSafetyMode,
          assistant_memory: this.assistantMemory,
          context_carry_messages: this.contextCarryMessages,
          gemini_session_id: this.geminiSessionId,
          codex_session_id: this.codexSessionId,
          active_runs: this.activeRuns,
          interrupted_runs: this.interruptedRuns,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}

module.exports = {
  AppConfigStore,
  normalizeContextCarryMessages,
};
