const fs = require("node:fs");
const path = require("node:path");
const { TOOLS } = require("./tools");

const APP_NAME = "Cortex";
const VERSION = require("../../package.json").version;

const DEFAULT_MODEL = "gemini-cli:auto";
const MAX_TOOL_ROUNDS = 8;

const PRESET_PROMPTS = {
  chat: "",
  code: "Focus on implementation quality and concise code changes.",
  debug: "Prioritize root-cause analysis, reproduction, and minimal-risk fixes.",
  refactor: "Prioritize maintainability, readability, and behavior-preserving changes.",
  explain: "Prioritize clear explanation, tradeoffs, and short examples.",
  plan: "Return a concrete markdown implementation plan. Use short sections: Goal, Assumptions, Plan, Risks, Validation. Do not execute changes. Do not use tools unless explicitly requested.",
};

// Points the assistant at Cortex's own README when it's on disk (a source
// checkout). Packaged builds don't ship it, so the hint is left out there.
function cortexDocsHint() {
  const readme = path.resolve(__dirname, "..", "..", "..", "README.md");
  return fs.existsSync(readme)
    ? [`If the user asks questions about Cortex (this app), read ${readme} for project context before answering.`]
    : [];
}

const BASE_ASSISTANT_SYSTEM_PROMPT = [
  "You are a local desktop coding assistant working inside the user's current workspace.",
  "Answer casual greetings and generic questions naturally and directly.",
  "Do not volunteer statements about lacking file access, tool access, or terminal access unless the current request truly requires an action you cannot perform.",
  "Do not turn simple chat into a discussion of safety restrictions.",
  "When the user asks about the project or codebase, help clearly and pragmatically.",
  ...cortexDocsHint(),
].join(" ");

const ANDROID_EMULATOR_SYSTEM_PROMPT = [
  "For Android emulator tasks on Windows, prefer deterministic orchestration over retries.",
  "Use absolute SDK tool paths when available. Check ANDROID_HOME or ANDROID_SDK_ROOT env vars first, then common locations like %LOCALAPPDATA%\\Android\\Sdk on Windows or ~/Android/Sdk on Linux/Mac.",
  "Before launching an emulator, check adb devices first. If an emulator already exists, reuse it.",
  "If adb reports an emulator as offline, wait for it to finish booting instead of launching another emulator.",
  "Wait for adb shell getprop sys.boot_completed to return 1 before install or app launch steps.",
  "Do not relaunch or kill/restart an emulator while boot is still in progress unless the user explicitly asks for that recovery action.",
].join(" ");

// Gemini API model ids, checked against https://aistudio.google.com/docs/models
// (2026-11). The 1.5 and 2.0 families are shut down.
const GEMINI_MODELS = [
  ["gemini-3.6-flash", "Gemini 3.6 Flash [fast]"],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite [fast]"],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro [smart, preview]"],
  ["gemini-3-flash-preview", "Gemini 3 Flash [preview]"],
];

// Gemini CLI --model values. "auto" is the CLI's own default alias: it picks
// (and falls back between) the CLI's current Pro and Flash models.
const GEMINI_CLI_MODELS = [
  ["gemini-cli:auto", "Auto [Gemini CLI]"],
  ["gemini-cli:gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"],
  ["gemini-cli:gemini-3-flash-preview", "Gemini 3 Flash Preview"],
];

const CLAUDE_MODELS = [
  ["claude:sonnet", "Claude Sonnet"],
  ["claude:opus", "Claude Opus"],
  ["claude:haiku", "Claude Haiku"],
];

const HERMES_MODELS = [
  ["hermes:default", "Hermes Agent"],
];

// Groq production models, checked against https://console.groq.com/docs/models
// (2026-11). Mixtral and DeepSeek R1 distill are shut down; Llama 3.x was
// retired for free and developer tiers on 2026-08-16.
const GROQ_MODELS = [
  ["openai/gpt-oss-120b", "GPT-OSS 120B"],
  ["openai/gpt-oss-20b", "GPT-OSS 20B [fast]"],
];

const CODEX_MODELS = [
  ["codex:gpt-5.5:xhigh",      "gpt-5.5 · Extra High"],
  ["codex:gpt-5.5:high",       "gpt-5.5 · High"],
  ["codex:gpt-5.5:medium",     "gpt-5.5 · Medium"],
  ["codex:gpt-5.5:low",        "gpt-5.5 · Low"],
  ["codex:gpt-5.4:xhigh",      "gpt-5.4 · Extra High"],
  ["codex:gpt-5.4:high",       "gpt-5.4 · High"],
  ["codex:gpt-5.4:medium",     "gpt-5.4 · Medium"],
  ["codex:gpt-5.4:low",        "gpt-5.4 · Low"],
  ["codex:gpt-5.4-mini:xhigh", "gpt-5.4-mini · Extra High"],
  ["codex:gpt-5.4-mini:high",  "gpt-5.4-mini · High"],
  ["codex:gpt-5.4-mini:medium","gpt-5.4-mini · Medium"],
  ["codex:gpt-5.4-mini:low",   "gpt-5.4-mini · Low"],
  ["codex:gpt-5.3-codex:xhigh","gpt-5.3-codex · Extra High"],
  ["codex:gpt-5.3-codex:high", "gpt-5.3-codex · High"],
  ["codex:gpt-5.3-codex:medium","gpt-5.3-codex · Medium"],
  ["codex:gpt-5.3-codex:low",  "gpt-5.3-codex · Low"],
];

// Model ids offered by earlier versions, mapped to the closest current one so
// saved settings and chats keep working after a model is retired.
const LEGACY_MODEL_IDS = {
  "gemini-cli:auto-gemini-2.5": "gemini-cli:auto",
  "gemini-cli:auto-gemini-3": "gemini-cli:auto",
  "gemini-cli:manual": "gemini-cli:auto",
  "gemini-2.0-flash": "gemini-3.6-flash",
  "gemini-2.0-flash-lite": "gemini-3.5-flash-lite",
  "gemini-2.0-flash-lite-preview": "gemini-3.5-flash-lite",
  "gemini-2.0-flash-thinking-exp": "gemini-3.1-pro-preview",
  "gemini-1.5-flash": "gemini-3.6-flash",
  "gemini-1.5-pro": "gemini-3.1-pro-preview",
  "gemini-2.5-flash": "gemini-3.6-flash",
  "gemini-2.5-pro": "gemini-3.1-pro-preview",
  "gemini-3-pro-preview": "gemini-3.1-pro-preview",
  "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
  "llama-3.1-8b-instant": "openai/gpt-oss-20b",
  "deepseek-r1-distill-llama-70b": "openai/gpt-oss-120b",
  "mixtral-8x7b-32768": "openai/gpt-oss-120b",
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Returns the current id for `model`, mapping retired ids to their
// replacement. Unknown ids pass through unchanged; empty input stays empty.
function resolveModelId(model) {
  const value = String(model || "").trim();
  if (!value) return "";
  if (hasOwn(LEGACY_MODEL_IDS, value)) return LEGACY_MODEL_IDS[value];
  // Gemini CLI ids carry an API model id after the prefix; map those too.
  const prefix = "gemini-cli:";
  if (value.startsWith(prefix) && hasOwn(LEGACY_MODEL_IDS, value.slice(prefix.length))) {
    return prefix + LEGACY_MODEL_IDS[value.slice(prefix.length)];
  }
  return value;
}

module.exports = {
  APP_NAME,
  VERSION,
  DEFAULT_MODEL,
  MAX_TOOL_ROUNDS,
  PRESET_PROMPTS,
  BASE_ASSISTANT_SYSTEM_PROMPT,
  ANDROID_EMULATOR_SYSTEM_PROMPT,
  GEMINI_MODELS,
  GEMINI_CLI_MODELS,
  CLAUDE_MODELS,
  HERMES_MODELS,
  GROQ_MODELS,
  CODEX_MODELS,
  LEGACY_MODEL_IDS,
  resolveModelId,
  TOOLS,
};
