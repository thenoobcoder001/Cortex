// The chat's activity log: what the agent did during a turn (commands it ran,
// files it read or edited, searches, tools), in one shape for every provider.
//
// Providers report steps through onEvent("tool_call" | "tool_result", ...):
//   tool_call   { id, kind, label, command? }
//   tool_result { id, ok, exitCode?, status?, durationMs? }
// `kind` is one of ACTIVITY_KINDS. The describe* helpers below turn each
// provider's own events into that shape. ActivityLog keeps the turn's steps;
// the finished list is saved on the assistant message as `activity`.

const path = require("node:path");

const ACTIVITY_KINDS = ["command", "read", "list", "search", "edit", "web", "tool", "agent", "plan"];
const MAX_LABEL = 240;
const MAX_ENTRIES = 300;

function clip(text, max = MAX_LABEL) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Repo-relative path when the file is inside the repo, else the path as given.
function displayPath(filePath, repoRoot) {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  if (!repoRoot || !path.isAbsolute(raw)) return raw.replaceAll("\\", "/");
  const relative = path.relative(repoRoot, raw);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return raw;
  return relative.replaceAll("\\", "/");
}

function listPaths(paths, repoRoot, max = 3) {
  const shown = [...new Set(paths.map((p) => displayPath(p, repoRoot)).filter(Boolean))];
  if (shown.length <= max) return shown.join(", ");
  return `${shown.slice(0, max).join(", ")} and ${shown.length - max} more`;
}

// Codex on Windows wraps every command as
//   "C:\...\powershell.exe" -Command 'Get-Content a.js'
// and elsewhere as  /bin/bash -lc 'ls'. Show the inner command.
function unwrapShell(command) {
  const text = String(command || "").trim();
  const match = text.match(/^"?[^"\s]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+([\s\S]+)$/i)
    || text.match(/^"?[^"\s]*?(?:bash|sh|zsh)(?:\.exe)?"?\s+-l?c\s+([\s\S]+)$/i)
    || text.match(/^"?[^"\s]*?cmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/);
  if (!match) return text;
  const inner = match[1].trim();
  const quote = inner[0];
  if (quote === "'" && inner.endsWith("'") && inner.length >= 2) {
    return inner.slice(1, -1);
  }
  // Codex escapes the double-quoted form: -Command "node -e \"x\" .\\a.js"
  if (quote === '"' && inner.endsWith('"') && inner.length >= 2) {
    return inner.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return inner;
}

function commandStep(command, label) {
  const inner = unwrapShell(command);
  return { kind: "command", label: clip(label || inner), command: String(command || "") };
}

// ---------------------------------------------------------------- Codex ---

// One Codex app-server ThreadItem -> { kind, label, command? }, or null for
// items that aren't steps (messages, reasoning, plans...).
function describeCodexItem(item, repoRoot = "") {
  if (!item || typeof item !== "object") return null;
  switch (item.type) {
    case "commandExecution": {
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      const types = new Set(actions.map((action) => action?.type));
      const command = String(item.command || "");
      // Codex parses what a command does; a pure read / list / search reads
      // better as that than as the raw shell line. It still ran as a command,
      // so `command` stays set and it is audited like one.
      if (actions.length && types.size === 1 && !types.has("unknown")) {
        if (types.has("read")) {
          const names = actions.map((action) => action.path || action.name);
          return { kind: "read", label: clip(`Read ${listPaths(names, repoRoot)}`), command };
        }
        if (types.has("listFiles")) {
          const where = actions.map((action) => action.path).filter(Boolean);
          return { kind: "list", label: clip(where.length ? `Listed ${listPaths(where, repoRoot)}` : "Listed files"), command };
        }
        if (types.has("search")) {
          const first = actions[0] || {};
          const query = first.query ? `"${first.query}"` : "files";
          const where = first.path ? ` in ${displayPath(first.path, repoRoot)}` : "";
          return { kind: "search", label: clip(`Searched for ${query}${where}`), command };
        }
      }
      return commandStep(command);
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const kinds = new Set(changes.map((change) => change?.kind?.type));
      const verb = kinds.size === 1 && kinds.has("add") ? "Created" : kinds.size === 1 && kinds.has("delete") ? "Deleted" : "Edited";
      const paths = changes.map((change) => change?.path);
      return { kind: "edit", label: clip(paths.length ? `${verb} ${listPaths(paths, repoRoot)}` : "Edited files") };
    }
    case "mcpToolCall":
      return { kind: "tool", label: clip(`${item.server || "MCP"} · ${item.tool || "tool"}`) };
    case "dynamicToolCall":
      return { kind: "tool", label: clip(item.tool || item.name || "Tool") };
    case "webSearch":
      return { kind: "web", label: clip(item.query ? `Searched the web for "${item.query}"` : "Searched the web") };
    case "collabAgentToolCall":
    case "subAgentActivity":
      return { kind: "agent", label: clip(item.agentPath ? `Sub-agent ${item.agentPath}` : "Sub-agent") };
    case "imageView":
      return { kind: "read", label: clip(`Viewed ${displayPath(item.path, repoRoot)}`) };
    default:
      return null;
  }
}

// A finished Codex item -> { ok, status, exitCode, durationMs }.
function codexItemResult(item) {
  const status = String(item?.status || "completed");
  const exitCode = Number.isInteger(item?.exitCode) ? item.exitCode : null;
  const ok = status === "completed" && (exitCode === null || exitCode === 0);
  const durationMs = Number.isFinite(item?.durationMs) ? item.durationMs : null;
  return { ok, status, exitCode, durationMs };
}

// --------------------------------------------------------------- Claude ---

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// One Claude Code tool_use block -> { kind, label, command? }.
function describeClaudeTool(name, input = {}, repoRoot = "") {
  const args = input && typeof input === "object" ? input : {};
  const tool = String(name || "");
  if (tool === "Bash" || tool === "PowerShell") {
    return commandStep(args.command, args.description ? `${args.description}: ${unwrapShell(args.command)}` : "");
  }
  if (tool === "Read") return { kind: "read", label: clip(`Read ${displayPath(args.file_path, repoRoot)}`) };
  if (CLAUDE_EDIT_TOOLS.has(tool)) {
    const verb = tool === "Write" ? "Wrote" : "Edited";
    return { kind: "edit", label: clip(`${verb} ${displayPath(args.file_path || args.notebook_path, repoRoot)}`) };
  }
  if (tool === "Glob") return { kind: "search", label: clip(`Found files matching ${args.pattern || ""}`) };
  if (tool === "Grep") return { kind: "search", label: clip(`Searched for "${args.pattern || ""}"${args.path ? ` in ${displayPath(args.path, repoRoot)}` : ""}`) };
  if (tool === "LS") return { kind: "list", label: clip(`Listed ${displayPath(args.path, repoRoot) || "files"}`) };
  if (tool === "WebFetch") return { kind: "web", label: clip(`Fetched ${args.url || "a page"}`) };
  if (tool === "WebSearch") return { kind: "web", label: clip(`Searched the web for "${args.query || ""}"`) };
  if (tool === "TodoWrite") return { kind: "plan", label: "Updated the to-do list" };
  if (tool === "Task" || tool === "Agent") return { kind: "agent", label: clip(`Sub-agent: ${args.description || args.subagent_type || "task"}`) };
  if (tool.startsWith("mcp__")) {
    const [, server, ...rest] = tool.split("__");
    return { kind: "tool", label: clip(`${server} · ${rest.join("__")}`) };
  }
  return { kind: "tool", label: clip(tool || "Tool") };
}

// ---------------------------------------------------------- Antigravity ---

const AGY_COMMAND_TOOLS = new Set(["run_command", "send_command_input", "shell_exec"]);
const AGY_EDIT_TOOLS = new Set(["write_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "edit_file", "create_file", "delete_file"]);

function describeAgyTool(name, params = {}, repoRoot = "") {
  const args = params && typeof params === "object" ? params : {};
  const tool = String(name || "");
  const filePath = args.Path || args.path || args.TargetFile || args.AbsolutePath || args.file_path || "";
  if (AGY_COMMAND_TOOLS.has(tool)) return commandStep(args.CommandLine || args.command || args.Command || "");
  if (AGY_EDIT_TOOLS.has(tool)) {
    const verb = tool === "delete_file" ? "Deleted" : tool === "create_file" ? "Created" : "Edited";
    return { kind: "edit", label: clip(`${verb} ${displayPath(filePath, repoRoot)}`) };
  }
  if (tool === "read_file" || tool === "view_file") return { kind: "read", label: clip(`Read ${displayPath(filePath, repoRoot)}`) };
  if (tool === "list_dir" || tool === "list_directory") return { kind: "list", label: clip(`Listed ${displayPath(args.DirectoryPath || filePath, repoRoot) || "files"}`) };
  if (tool === "grep_search" || tool === "find_by_name" || tool === "codebase_search") {
    const query = args.Query || args.Pattern || args.query || "";
    return { kind: "search", label: clip(query ? `Searched for "${query}"` : "Searched files") };
  }
  if (tool === "search_web" || tool === "read_url_content") return { kind: "web", label: clip(args.query || args.Url || "Web") };
  return { kind: "tool", label: clip(tool.replaceAll("_", " ") || "Tool") };
}

// ------------------------------------------------------------ API tools ---

// Cortex's own tools, used by the API-key providers (Groq, Gemini API).
function describeApiTool(name, args = {}, repoRoot = "") {
  const input = args && typeof args === "object" ? args : {};
  switch (name) {
    case "run_terminal_command": return commandStep(input.command);
    case "read_file": return { kind: "read", label: clip(`Read ${displayPath(input.path, repoRoot)}`) };
    case "list_files": return { kind: "list", label: clip(`Listed ${displayPath(input.directory, repoRoot) || "files"}`) };
    case "write_file": return { kind: "edit", label: clip(`Wrote ${displayPath(input.path, repoRoot)}`) };
    case "edit_file": return { kind: "edit", label: clip(`Edited ${displayPath(input.path, repoRoot)}`) };
    case "delete_path": return { kind: "edit", label: clip(`Deleted ${displayPath(input.path, repoRoot)}`) };
    case "rename_file": return { kind: "edit", label: clip(`Renamed ${displayPath(input.old_path, repoRoot)} to ${displayPath(input.new_path, repoRoot)}`) };
    case "create_directory": return { kind: "edit", label: clip(`Created folder ${displayPath(input.path, repoRoot)}`) };
    default: return { kind: "tool", label: clip(String(name || "Tool").replaceAll("_", " ")) };
  }
}

// ---------------------------------------------------------- the turn log ---

class ActivityLog {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.startedAt = now();
    this.endedAt = null;
    this.entries = [];
    this.byId = new Map();
    this.nextId = 1;
  }

  // Adds a step; returns the stored entry (or null when the log is full).
  start({ id, kind, label, command } = {}) {
    const key = String(id || `step-${this.nextId++}`);
    const existing = this.byId.get(key);
    if (existing) return existing;
    if (this.entries.length >= MAX_ENTRIES) return null;
    const entry = {
      id: key,
      kind: ACTIVITY_KINDS.includes(kind) ? kind : "tool",
      label: clip(label || "Step"),
      status: "running",
      startedAt: this.now(),
    };
    if (command) entry.command = String(command);
    this.entries.push(entry);
    this.byId.set(key, entry);
    return entry;
  }

  // Marks a step done; returns the entry (or null for an unknown id).
  finish({ id, ok = true, status = "", exitCode = null, durationMs = null, auditSeq = null } = {}) {
    const entry = this.byId.get(String(id || ""));
    if (!entry) return null;
    entry.status = status === "declined" ? "declined" : ok ? "done" : "failed";
    if (Number.isInteger(exitCode)) entry.exitCode = exitCode;
    entry.durationMs = Number.isFinite(durationMs) ? durationMs : Math.max(0, this.now() - entry.startedAt);
    if (Number.isInteger(auditSeq)) entry.auditSeq = auditSeq;
    return entry;
  }

  get size() {
    return this.entries.length;
  }

  // Saved on the assistant message. Steps still "running" when the turn
  // ends (a CLI that never reported the result) are kept as they are.
  toJSON() {
    const endedAt = this.endedAt ?? this.now();
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: Math.max(0, endedAt - this.startedAt),
      steps: this.entries.map(({ startedAt: _startedAt, ...rest }) => rest),
    };
  }

  end() {
    this.endedAt = this.now();
    return this;
  }
}

module.exports = {
  ACTIVITY_KINDS,
  ActivityLog,
  codexItemResult,
  describeAgyTool,
  describeApiTool,
  describeClaudeTool,
  describeCodexItem,
  displayPath,
  unwrapShell,
};
