const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEFAULT_MODEL } = require("./constants");
const platform = require("./platform");

function normalizeRepoRootPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  const separatorsNormalized = platform.isWin
    ? trimmed.replaceAll("/", "\\")
    : trimmed.replaceAll("\\", "/");
  return path.normalize(separatorsNormalized);
}

function normalizeContextCarryMessages(value, fallback = 5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(Math.trunc(parsed), 20));
}

function normalizeRecentRepoRoots(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = [];
  for (const entry of value) {
    const normalized = normalizeRepoRootPath(entry);
    if (!normalized || unique.includes(normalized)) {
      continue;
    }
    unique.push(normalized);
  }
  return unique.slice(0, 20);
}

function configFile() {
  return path.join(platform.getAppDataDir(), "config.json");
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
    this.remoteAccessEnabled = false;
    this.recentRepoRoots = [];
    this.geminiSessionId = "";
    this.codexSessionId = "";
    this.activeRuns = [];
    this.interruptedRuns = [];
    // Cortex relay
    this.cortexToken = "";
    this.cortexDeviceId = "";
    this.cortexReconnectSecret = "";
    // Shared secret for direct mobile→desktop connections
    this.mobileToken = "";
    // Device IDs explicitly approved to send relay commands to this desktop
    this.approvedDeviceIds = [];
    // HMAC secret for relay message signing (P2-I)
    this.relayHmacSecret = "";
    // Time-bound relay pairing window (P2-L)
    this.relaySessionExpiresAt = "";
    // SMTP for email verification
    this.smtpHost = "";
    this.smtpPort = 587;
    this.smtpUser = "";
    this.smtpPass = "";
    this.smtpFrom = "";
  }

  static load() {
    const config = new AppConfigStore();
    try {
      if (fs.existsSync(config.path)) {
        const raw = JSON.parse(fs.readFileSync(config.path, "utf8"));
        config.repoRoot = normalizeRepoRootPath(raw.repo_root || raw.repoRoot || "");
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
        config.remoteAccessEnabled = Boolean(raw.remote_access_enabled ?? raw.remoteAccessEnabled);
        config.recentRepoRoots = normalizeRecentRepoRoots(raw.recent_repo_roots ?? raw.recentRepoRoots);
        config.geminiSessionId = String(raw.gemini_session_id || raw.geminiSessionId || "");
        config.codexSessionId = String(raw.codex_session_id || raw.codexSessionId || "");
        config.activeRuns = Array.isArray(raw.active_runs || raw.activeRuns) ? raw.active_runs || raw.activeRuns : [];
        config.interruptedRuns = Array.isArray(raw.interrupted_runs || raw.interruptedRuns)
          ? raw.interrupted_runs || raw.interruptedRuns
          : [];
        config.cortexToken           = String(raw.cortex_token           || raw.cortexToken           || "");
        config.cortexDeviceId        = String(raw.cortex_device_id       || raw.cortexDeviceId        || "");
        config.cortexReconnectSecret = String(raw.cortex_reconnect_secret || raw.cortexReconnectSecret || "");
        config.mobileToken           = String(raw.mobile_token           || raw.mobileToken           || "");
        config.approvedDeviceIds     = Array.isArray(raw.approved_device_ids || raw.approvedDeviceIds)
          ? (raw.approved_device_ids || raw.approvedDeviceIds).map(String).filter(Boolean)
          : [];
        config.relayHmacSecret       = String(raw.relay_hmac_secret || raw.relayHmacSecret || "");
        config.relaySessionExpiresAt = String(raw.relay_session_expires || raw.relaySessionExpiresAt || raw.relaySessionExpires || "");
        config.smtpHost = String(raw.smtp_host || raw.smtpHost || "");
        config.smtpPort = Number(raw.smtp_port || raw.smtpPort || 587);
        config.smtpUser = String(raw.smtp_user || raw.smtpUser || "");
        config.smtpPass = String(raw.smtp_pass || raw.smtpPass || "");
        config.smtpFrom = String(raw.smtp_from || raw.smtpFrom || "");
      }
    } catch {
      return config;
    }
    // Generate stable shared secrets on first launch
    let needSave = false;
    if (!config.mobileToken) {
      config.mobileToken = crypto.randomBytes(32).toString("hex");
      needSave = true;
    }
    if (!config.relayHmacSecret) {
      config.relayHmacSecret = crypto.randomBytes(32).toString("hex");
      needSave = true;
    }
    if (needSave) config.save();
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
          remote_access_enabled: this.remoteAccessEnabled,
          recent_repo_roots: normalizeRecentRepoRoots(this.recentRepoRoots),
          gemini_session_id: this.geminiSessionId,
          codex_session_id: this.codexSessionId,
          active_runs: this.activeRuns,
          interrupted_runs: this.interruptedRuns,
          cortex_token: this.cortexToken,
          cortex_device_id: this.cortexDeviceId,
          cortex_reconnect_secret: this.cortexReconnectSecret,
          mobile_token: this.mobileToken,
          approved_device_ids: this.approvedDeviceIds,
          relay_hmac_secret: this.relayHmacSecret,
          relay_session_expires: this.relaySessionExpiresAt,
          smtp_host: this.smtpHost,
          smtp_port: this.smtpPort,
          smtp_user: this.smtpUser,
          smtp_pass: this.smtpPass,
          smtp_from: this.smtpFrom,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  reset() {
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
    this.remoteAccessEnabled = false;
    this.recentRepoRoots = [];
    this.geminiSessionId = "";
    this.codexSessionId = "";
    this.activeRuns = [];
    this.interruptedRuns = [];
    this.relaySessionExpiresAt = "";
  }

  deleteFile() {
    try {
      if (fs.existsSync(this.path)) {
        fs.unlinkSync(this.path);
      }
    } catch {
      // Ignore cleanup failures; reset state is still applied in memory.
    }
  }
}

module.exports = {
  AppConfigStore,
  normalizeContextCarryMessages,
  normalizeRecentRepoRoots,
};
