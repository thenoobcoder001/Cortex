"use strict";

// Per-chat permission modes and how each provider maps onto them.
//
//   read-only          the agent may read and search, nothing else
//   supervised         ask before file edits and before commands
//   auto-accept-edits  edits run without asking, ask before commands
//   full-access        nothing asks (the pre-permission-modes behaviour)
//
// Chats saved before permission modes only had tool_safety_mode
// "read" | "write"; "read" becomes read-only and "write" becomes full-access
// so existing chats keep behaving exactly as they did.

const PERMISSION_MODES = ["read-only", "supervised", "auto-accept-edits", "full-access"];
const DEFAULT_PERMISSION_MODE = "full-access";

const PERMISSION_MODE_LABELS = {
  "read-only": "Read-only",
  supervised: "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
};

function isPermissionMode(value) {
  return PERMISSION_MODES.includes(String(value || ""));
}

function normalizePermissionMode(value, fallback = DEFAULT_PERMISSION_MODE) {
  const text = String(value || "").trim();
  if (isPermissionMode(text)) return text;
  // Accept the legacy read/write values anywhere a mode is expected.
  const lower = text.toLowerCase();
  if (lower === "read") return "read-only";
  if (lower === "write") return "full-access";
  return fallback;
}

// The legacy read/write value still stored next to the mode, for older
// clients (the phone app) that only know tool_safety_mode.
function legacyToolSafetyMode(mode) {
  return normalizePermissionMode(mode) === "read-only" ? "read" : "write";
}

// Mode stored on a chat payload or index item (snake_case on disk).
function chatPermissionMode(payload, fallback = DEFAULT_PERMISSION_MODE) {
  if (!payload || typeof payload !== "object") return fallback;
  const stored = payload.permission_mode ?? payload.permissionMode;
  if (isPermissionMode(stored)) return stored;
  const legacy = payload.tool_safety_mode ?? payload.toolSafetyMode;
  if (legacy) return String(legacy).toLowerCase() === "read" ? "read-only" : "full-access";
  return fallback;
}

// Picks the mode for one request. An explicit permissionMode wins. A legacy
// toolSafetyMode only says "read" or "write": "read" means read-only, and
// "write" keeps whatever write-capable mode the chat already has, so a client
// that predates permission modes cannot silently lift a Supervised chat to
// Full access.
function resolveRequestPermissionMode({ permissionMode = null, toolSafetyMode = null, stored = null, fallback = DEFAULT_PERMISSION_MODE } = {}) {
  if (isPermissionMode(permissionMode)) return permissionMode;
  const base = isPermissionMode(stored) ? stored : fallback;
  const legacy = String(toolSafetyMode || "").trim().toLowerCase();
  if (legacy === "read") return "read-only";
  if (legacy === "write") return base === "read-only" ? "full-access" : base;
  return base;
}

function providerFamily(model) {
  const value = String(model || "");
  if (value.startsWith("codex:")) return "codex";
  if (value.startsWith("claude:")) return "claude";
  if (value.startsWith("agy:")) return "agy";
  if (value.startsWith("hermes:")) return "hermes";
  return "api"; // Groq / Gemini API, which run through toolExecutor
}

// ── Codex app-server ─────────────────────────────────────────────────────
// approvalPolicy "untrusted" asks before anything outside the trusted
// read-only command set; with a read-only sandbox every file change asks
// too. With a workspace-write sandbox, edits inside the repo go through and
// commands still ask.
function codexPolicy(mode) {
  switch (normalizePermissionMode(mode)) {
    case "read-only":
      return { approvalPolicy: "never", sandbox: "read-only" };
    case "supervised":
      return { approvalPolicy: "untrusted", sandbox: "read-only" };
    case "auto-accept-edits":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
    default:
      return { approvalPolicy: "never", sandbox: "workspace-write" };
  }
}

// ── Claude CLI ───────────────────────────────────────────────────────────
const CLAUDE_READ_TOOLS = "Read,Glob,Grep,LS";
const CLAUDE_ALL_TOOLS = "Bash,Read,Write,Edit,Glob,Grep,LS,WebSearch,WebFetch";
const CLAUDE_APPROVAL_TOOL = "mcp__cortex_approvals__approve";

// `promptTool` is true when the approval bridge (a local MCP server that asks
// Cortex) is wired up for this turn. Without it nobody can answer a prompt,
// so anything that would ask is denied instead (--permission-prompts none).
function claudePermissionArgs(mode, { promptTool = false } = {}) {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "full-access") {
    return ["--dangerously-skip-permissions", "--allowedTools", CLAUDE_ALL_TOOLS];
  }
  if (normalized === "read-only") {
    // dontAsk: anything not pre-approved is refused without prompting.
    return ["--permission-mode", "dontAsk", "--allowedTools", CLAUDE_READ_TOOLS];
  }
  const args = [
    "--permission-mode", normalized === "supervised" ? "default" : "acceptEdits",
    // Only reads are pre-approved; Bash/Write/Edit must go through a prompt.
    "--allowedTools", CLAUDE_READ_TOOLS,
  ];
  if (promptTool) {
    args.push("--permission-prompt-tool", CLAUDE_APPROVAL_TOOL);
  } else {
    args.push("--permission-prompts", "none");
  }
  return args;
}

// ── Antigravity CLI (agy) ────────────────────────────────────────────────
// Headless `agy -p` never prompts. Measured on agy 1.4.12:
//   - edits inside the workspace run without asking (default
//     "request-review" policy only reviews in the interactive UI);
//   - shell commands are soft-denied unless a permissions.allow rule
//     matches (reported as denied_actions);
//   - permissions.deny rules ("write_file(*)", "command(*)") block the tool;
//   - a PreToolUse hook (hooks.json in a workspace's .agents folder) runs
//     before every tool and can deny it; a failing or timed-out hook also
//     blocks the tool.
// Cortex passes rules with --settings (session-only, never saved) and, for
// the modes that ask, adds a per-turn workspace whose hook asks Cortex
// (agyApprovalHook.js). The hook is the gate; "command(*)" only stops
// headless agy refusing what the user approved.
const AGY_DENY_WRITES = "write_file(*)";
const AGY_DENY_COMMANDS = "command(*)";
const AGY_DENY_MCP = "mcp(*)";

// { args, settings, hook, effectiveMode } for one turn. `hook` says whether
// the approval hook is wired up; without it nobody can answer, so whatever
// would ask is denied instead.
function agyPermissionConfig(mode, { hook = false } = {}) {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "full-access") {
    return { args: ["--dangerously-skip-permissions"], settings: null, hook: false, effectiveMode: "full-access" };
  }
  const readOnly = { permissions: { deny: [AGY_DENY_WRITES, AGY_DENY_COMMANDS, AGY_DENY_MCP] } };
  if (normalized === "read-only") {
    return { args: [], settings: readOnly, hook: false, effectiveMode: "read-only" };
  }
  if (hook) {
    return { args: [], settings: { permissions: { allow: [AGY_DENY_COMMANDS] } }, hook: true, effectiveMode: normalized };
  }
  if (normalized === "supervised") {
    return { args: [], settings: readOnly, hook: false, effectiveMode: "read-only" };
  }
  // Auto-accept edits without the hook: edits run, commands are refused.
  return { args: [], settings: { permissions: { deny: [AGY_DENY_COMMANDS, AGY_DENY_MCP] } }, hook: false, effectiveMode: "auto-accept-edits" };
}

// What the composer says when the approval hook can't be used.
function agyFallbackNote(mode) {
  return normalizePermissionMode(mode) === "supervised"
    ? "Antigravity can't reach Cortex for approvals right now, so edits and commands are declined (runs as Read-only)."
    : "Antigravity can't reach Cortex for approvals right now, so commands are declined; edits inside the project run.";
}

// ── API providers (toolExecutor) ─────────────────────────────────────────
const EDIT_TOOLS = ["write_file", "edit_file", "delete_path", "rename_file", "create_directory"];
const COMMAND_TOOLS = ["run_terminal_command"];

// "allow" | "ask" | "block" for one toolExecutor tool call.
function apiToolGate(mode, toolName) {
  const normalized = normalizePermissionMode(mode);
  const isEdit = EDIT_TOOLS.includes(toolName);
  const isCommand = COMMAND_TOOLS.includes(toolName);
  if (!isEdit && !isCommand) return "allow";
  if (normalized === "read-only") return "block";
  if (normalized === "full-access") return "allow";
  if (normalized === "auto-accept-edits") return isCommand ? "ask" : "allow";
  return "ask";
}

// How a mode actually runs on a provider. `effectiveMode` is what the
// provider enforces; `interactive` is true when Cortex will show approval
// cards; `note` explains any fallback in plain words for the UI. `bridge` is
// false when the backend has no approval callback URL (Claude's MCP server
// and Antigravity's hook both need it).
function describePermissionMode(model, mode, { bridge = true } = {}) {
  const requested = normalizePermissionMode(mode);
  const family = providerFamily(model);
  const base = { requested, effectiveMode: requested, interactive: false, note: "" };
  const asks = requested === "supervised" || requested === "auto-accept-edits";

  if (family === "codex" || family === "api") {
    return { ...base, interactive: asks };
  }
  if (family === "claude") {
    if (asks && !bridge) {
      return {
        ...base,
        note: "Approvals are unavailable for Claude right now; anything that would ask is declined.",
      };
    }
    return { ...base, interactive: asks };
  }
  if (family === "agy") {
    if (asks && !bridge) {
      return { ...base, effectiveMode: agyPermissionConfig(requested).effectiveMode, note: agyFallbackNote(requested) };
    }
    return { ...base, interactive: asks };
  }
  // Hermes has no permission flags Cortex can set.
  if (family === "hermes") {
    return {
      ...base,
      effectiveMode: "full-access",
      note: "Hermes has no permission controls Cortex can set; it runs with its own settings regardless of the mode.",
    };
  }
  return base;
}

module.exports = {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  DEFAULT_PERMISSION_MODE,
  CLAUDE_APPROVAL_TOOL,
  isPermissionMode,
  normalizePermissionMode,
  legacyToolSafetyMode,
  chatPermissionMode,
  resolveRequestPermissionMode,
  providerFamily,
  codexPolicy,
  claudePermissionArgs,
  agyPermissionConfig,
  agyFallbackNote,
  apiToolGate,
  describePermissionMode,
};
