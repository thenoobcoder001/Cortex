const { TOOLS } = require("./tools");

const APP_NAME = "Cortex";
const VERSION = "0.0.3";

const DEFAULT_MODEL = "gemini-cli:auto-gemini-2.5";
const MAX_TOOL_ROUNDS = 8;

const PRESET_PROMPTS = {
  chat: "",
  code: "Focus on implementation quality and concise code changes.",
  debug: "Prioritize root-cause analysis, reproduction, and minimal-risk fixes.",
  refactor: "Prioritize maintainability, readability, and behavior-preserving changes.",
  explain: "Prioritize clear explanation, tradeoffs, and short examples.",
  plan: "Return a concrete markdown implementation plan. Use short sections: Goal, Assumptions, Plan, Risks, Validation. Do not execute changes. Do not use tools unless explicitly requested.",
};

const BASE_ASSISTANT_SYSTEM_PROMPT = [
  "You are a local desktop coding assistant working inside the user's current workspace.",
  "Answer casual greetings and generic questions naturally and directly.",
  "Do not volunteer statements about lacking file access, tool access, or terminal access unless the current request truly requires an action you cannot perform.",
  "Do not turn simple chat into a discussion of safety restrictions.",
  "When the user asks about the project or codebase, help clearly and pragmatically.",
  "If the user asks questions about Cortex (this app), read E:\\codex\\gpt-tui\\CLAUDE.md for full project context before answering.",
].join(" ");

const ANDROID_EMULATOR_SYSTEM_PROMPT = [
  "For Android emulator tasks on Windows, prefer deterministic orchestration over retries.",
  "Use absolute SDK tool paths when available. Check ANDROID_HOME or ANDROID_SDK_ROOT env vars first, then common locations like %LOCALAPPDATA%\\Android\\Sdk on Windows or ~/Android/Sdk on Linux/Mac.",
  "Before launching an emulator, check adb devices first. If an emulator already exists, reuse it.",
  "If adb reports an emulator as offline, wait for it to finish booting instead of launching another emulator.",
  "Wait for adb shell getprop sys.boot_completed to return 1 before install or app launch steps.",
  "Do not relaunch or kill/restart an emulator while boot is still in progress unless the user explicitly asks for that recovery action.",
].join(" ");

const GEMINI_MODELS = [
  ["gemini-2.0-flash", "Gemini 2.0 Flash [fast]"],
  ["gemini-2.0-flash-lite-preview", "Gemini 2.0 Flash Lite [preview]"],
  ["gemini-1.5-flash", "Gemini 1.5 Flash [fast]"],
  ["gemini-1.5-pro", "Gemini 1.5 Pro [smart]"],
  ["gemini-2.0-flash-thinking-exp", "Gemini 2.0 Thinking [reasoning]"],
];

const GEMINI_CLI_MODELS = [
  ["gemini-cli:auto-gemini-2.5", "Auto (Gemini 2.5)"],
  ["gemini-cli:auto-gemini-3", "Auto (Gemini 3)"],
  ["gemini-cli:gemini-3-flash-preview", "Gemini 3.0 Flash Preview"],
  ["gemini-cli:manual", "Manual [Gemini CLI]"],
];

const CLAUDE_MODELS = [
  ["claude:sonnet", "Claude Sonnet"],
  ["claude:opus", "Claude Opus"],
  ["claude:haiku", "Claude Haiku"],
];

const GROQ_MODELS = [
  ["llama-3.3-70b-versatile", "Llama 3.3 70B"],
  ["llama-3.1-8b-instant", "Llama 3.1 8B"],
  ["deepseek-r1-distill-llama-70b", "DeepSeek R1 70B"],
  ["mixtral-8x7b-32768", "Mixtral 8x7B"],
];

const CODEX_MODELS = [
  ["codex:gpt-5.4", "gpt-5.4"],
  ["codex:gpt-5.3-codex", "gpt-5.3-codex"],
  ["codex:gpt-5.2-codex", "gpt-5.2-codex"],
  ["codex:gpt-5.1-codex-max", "gpt-5.1-codex-max"],
  ["codex:gpt-5.2", "gpt-5.2"],
  ["codex:gpt-5.1-codex-mini", "gpt-5.1-codex-mini"],
];

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
  GROQ_MODELS,
  CODEX_MODELS,
  TOOLS,
};
