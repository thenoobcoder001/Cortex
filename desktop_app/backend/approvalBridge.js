"use strict";

// Backend side of the approval bridges that let CLI agents ask the Cortex
// user before acting:
//   - Claude CLI: a per-turn MCP config starting approvalMcpServer.js as its
//     --permission-prompt-tool;
//   - Antigravity CLI (agy): a per-turn workspace whose PreToolUse hook runs
//     agyApprovalHook.js.
// Both POST to /api/approvals/bridge; this file also turns their tool calls
// into what the approval card shows.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildUnifiedDiff } = require("./fileService");

// In a packaged build the backend sits inside app.asar; the bridge scripts
// are unpacked next to it (build.asarUnpack) so a plain Node process can run them.
function resolveUnpackedScript(name) {
  const script = path.join(__dirname, name);
  const marker = `app.asar${path.sep}`;
  if (script.includes(marker)) {
    const unpacked = script.replace(marker, `app.asar.unpacked${path.sep}`);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return script;
}

const MCP_SERVER_SCRIPT = resolveUnpackedScript("approvalMcpServer.js");
const AGY_HOOK_SCRIPT = resolveUnpackedScript("agyApprovalHook.js");

function claudeToolSummary(toolName, input) {
  const name = String(toolName || "");
  const args = input && typeof input === "object" ? input : {};
  if (name === "Bash" || name === "PowerShell") {
    return {
      kind: "command",
      toolName: name,
      command: String(args.command || ""),
      reason: String(args.description || ""),
    };
  }
  if (name === "Write") {
    const filePath = String(args.file_path || "");
    return { kind: "file_change", toolName: name, path: filePath, diff: buildUnifiedDiff(filePath, "", String(args.content || "")) };
  }
  if (name === "Edit") {
    const filePath = String(args.file_path || "");
    return { kind: "file_change", toolName: name, path: filePath, diff: buildUnifiedDiff(filePath, String(args.old_string || ""), String(args.new_string || "")) };
  }
  if (name === "MultiEdit") {
    const filePath = String(args.file_path || "");
    const edits = Array.isArray(args.edits) ? args.edits : [];
    const diff = edits
      .map((edit) => buildUnifiedDiff(filePath, String(edit?.old_string || ""), String(edit?.new_string || "")))
      .join("\n");
    return { kind: "file_change", toolName: name, path: filePath, diff };
  }
  if (name === "NotebookEdit") {
    return { kind: "file_change", toolName: name, path: String(args.notebook_path || ""), diff: String(args.new_source || "") };
  }
  let detail = "";
  try {
    detail = JSON.stringify(args).slice(0, 2000);
  } catch {
    detail = "";
  }
  return { kind: "tool", toolName: name, reason: detail };
}

// The node binary that runs the bridge. Inside Electron, process.execPath is
// the Electron binary, which acts as plain Node with ELECTRON_RUN_AS_NODE=1.
function bridgeCommand() {
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

// Writes a one-turn --mcp-config file. Returns { configPath, cleanup }.
function writeClaudeMcpConfig({ url, token }) {
  const { command, env } = bridgeCommand();
  const config = {
    mcpServers: {
      cortex_approvals: {
        type: "stdio",
        command,
        args: [MCP_SERVER_SCRIPT],
        env: { ...env, CORTEX_APPROVAL_URL: url, CORTEX_APPROVAL_TOKEN: token },
      },
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-approvals-"));
  const configPath = path.join(dir, `mcp-${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
  return {
    configPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp file only holds a token that is already revoked.
      }
    },
  };
}

// ── Antigravity CLI (agy) ────────────────────────────────────────────────
// Tool names as agy's PreToolUse hook reports them (agy 1.4.12). Reads and
// bookkeeping pass without a card; edits and commands ask; anything else
// (browser, MCP, image generation, subagents...) asks as a plain tool.
const AGY_PASS_TOOLS = new Set([
  "read_file", "view_file", "view_file_outline", "view_code_item", "view_content_chunk",
  "list_dir", "list_directory", "find", "find_by_name", "grep_search", "code_search",
  "find_all_references", "read_url_content", "read_url", "search_web", "command_status",
  "read_terminal", "read_resource", "list_resources", "read_notebook", "list_permissions",
  "ask_question", "ask_permission", "ask_custom_permission", "notify_user", "finish",
  "wait", "wait_5_seconds", "task_boundary", "manage_task", "tool_search",
]);
const AGY_EDIT_TOOLS = new Set([
  "write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content",
  "sed_file", "notebook_edit", "edit_notebook", "delete_file", "delete_directory", "move",
  "move_file", "rename_file", "file_change", "write_blob",
]);
const AGY_COMMAND_TOOLS = new Set(["run_command", "send_command_input", "shell_exec"]);
const AGY_PATH_KEYS = ["Path", "TargetFile", "AbsolutePath", "File", "FilePath", "path", "file_path", "SourcePath", "DestinationPath", "Directory", "DirectoryPath"];
const MAX_DIFF_SOURCE_BYTES = 256 * 1024;

function samePathOrInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function agyToolPaths(args) {
  return AGY_PATH_KEYS
    .map((key) => args[key])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => path.resolve(value));
}

// Whether any string argument points into `dir` (the per-turn hook folder).
function mentionsDir(args, dir) {
  if (!dir) return false;
  const needle = path.resolve(dir).replace(/\\/g, "/").toLowerCase();
  const strings = [];
  const walk = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(args);
  return strings.some((text) => text.replace(/\\/g, "/").toLowerCase().includes(needle));
}

function readForDiff(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_DIFF_SOURCE_BYTES) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * What Cortex does with one agy tool call in Supervised / Auto-accept edits:
 *   { pass: true, by }          let it through without a card (reads)
 *   { block: reason }           refuse without asking
 *   approval summary            ask (kind command / file_change / tool),
 *                               with autoApprove for repo edits in
 *                               Auto-accept edits
 */
function agyToolSummary(toolName, input, { repoRoot = "", permissionMode = "supervised", controlDir = "" } = {}) {
  const name = String(toolName || "");
  const args = input && typeof input === "object" ? input : {};
  if (controlDir && mentionsDir(args, controlDir)) {
    return { block: "Cortex's approval folder is off limits to the agent." };
  }
  if (AGY_PASS_TOOLS.has(name)) {
    return { pass: true, by: "read-only tool" };
  }
  if (AGY_COMMAND_TOOLS.has(name)) {
    return {
      kind: "command",
      toolName: name,
      command: String(args.CommandLine || args.Command || args.Input || ""),
      cwd: String(args.Cwd || repoRoot || ""),
      reason: String(args.toolSummary || ""),
    };
  }
  if (AGY_EDIT_TOOLS.has(name)) {
    const paths = agyToolPaths(args);
    const filePath = paths[0] || "";
    const shown = filePath && repoRoot && samePathOrInside(repoRoot, filePath) ? path.relative(repoRoot, filePath) : filePath;
    let diff = "";
    if (typeof args.Content === "string" || typeof args.CodeContent === "string") {
      diff = buildUnifiedDiff(shown, readForDiff(filePath), String(args.Content ?? args.CodeContent));
    } else if (typeof args.Target === "string" || typeof args.TargetContent === "string") {
      diff = buildUnifiedDiff(shown, String(args.Target ?? args.TargetContent), String(args.Replacement ?? args.ReplacementContent ?? ""));
    }
    let detail = "";
    if (!diff) {
      try {
        detail = JSON.stringify(args).slice(0, 2000);
      } catch {
        detail = "";
      }
    }
    const insideRepo = Boolean(repoRoot) && paths.length > 0 && paths.every((candidate) => samePathOrInside(repoRoot, candidate));
    return {
      kind: "file_change",
      toolName: name,
      path: paths.map((candidate) => (repoRoot && samePathOrInside(repoRoot, candidate) ? path.relative(repoRoot, candidate) : candidate)).join(", "),
      diff,
      reason: detail,
      autoApprove: permissionMode === "auto-accept-edits" && insideRepo ? "auto-accept edits mode" : false,
    };
  }
  let detail = "";
  try {
    detail = JSON.stringify(args).slice(0, 2000);
  } catch {
    detail = "";
  }
  return { kind: "tool", toolName: name, reason: detail };
}

const AGY_HOOK_ROOT = path.join(".cortex", "agy-approvals");
const AGY_HOOK_TIMEOUT_SECONDS = 15 * 60;
const STALE_HOOK_DIR_MS = 60 * 60 * 1000;

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function removeStaleHookDirs(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > STALE_HOOK_DIR_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Another turn may be using or removing it.
    }
  }
}

/**
 * Writes the per-turn folder that agy loads as an extra workspace
 * (--add-dir). Its .agents/hooks.json runs a wrapper before every tool; the
 * wrapper starts agyApprovalHook.js with the bridge URL and token.
 *
 * It sits in <repo>/.cortex (skipped by the repo snapshot, so it never shows
 * up as a change) so agy lists the repo as the first workspace. agy runs hook
 * commands through `cmd /c` on Windows and escapes quotes in them, so the
 * command is an environment variable holding the quoted wrapper path
 * (CORTEX_AGY_HOOK, set on the agy process); that also copes with spaces.
 *
 * Returns { dir, env, cleanup }.
 */
function writeAgyHookWorkspace({ url, token, repoRoot }) {
  const { command, env } = bridgeCommand();
  let root = path.join(path.resolve(repoRoot || os.tmpdir()), AGY_HOOK_ROOT);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    root = path.join(os.tmpdir(), "cortex-agy-approvals");
    fs.mkdirSync(root, { recursive: true });
  }
  removeStaleHookDirs(root);
  const dir = fs.mkdtempSync(path.join(root, "turn-"));
  const agentsDir = path.join(dir, ".agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const isWin = process.platform === "win32";
  const wrapper = path.join(agentsDir, isWin ? "cortex-approval.cmd" : "cortex-approval.sh");
  const vars = { ...env, CORTEX_APPROVAL_URL: url, CORTEX_APPROVAL_TOKEN: token };
  const body = isWin
    ? [
      "@echo off",
      ...Object.entries(vars).map(([key, value]) => `set "${key}=${value}"`),
      `"${command}" "${AGY_HOOK_SCRIPT}"`,
      "",
    ].join("\r\n")
    : [
      "#!/bin/sh",
      `${Object.entries(vars).map(([key, value]) => `${key}=${shellSingleQuote(value)}`).join(" ")} exec ${shellSingleQuote(command)} ${shellSingleQuote(AGY_HOOK_SCRIPT)}`,
      "",
    ].join("\n");
  fs.writeFileSync(wrapper, body, { encoding: "utf8", mode: 0o700 });
  const hooks = {
    "cortex-approvals": {
      PreToolUse: [{
        matcher: "*",
        hooks: [{ type: "command", command: isWin ? "%CORTEX_AGY_HOOK%" : "\"$CORTEX_AGY_HOOK\"", timeout: AGY_HOOK_TIMEOUT_SECONDS }],
      }],
    },
  };
  fs.writeFileSync(path.join(agentsDir, "hooks.json"), JSON.stringify(hooks, null, 2), { encoding: "utf8", mode: 0o600 });
  return {
    dir,
    env: { CORTEX_AGY_HOOK: isWin ? `"${wrapper}"` : wrapper },
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover folder only holds a token that is already revoked; the
        // next turn removes folders older than an hour.
      }
    },
  };
}

module.exports = {
  MCP_SERVER_SCRIPT,
  AGY_HOOK_SCRIPT,
  claudeToolSummary,
  writeClaudeMcpConfig,
  agyToolSummary,
  writeAgyHookWorkspace,
};
