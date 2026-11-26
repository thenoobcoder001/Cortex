const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildUnifiedDiff } = require("./fileService");
const { resolveAndroidEnv } = require("./androidEnv");
const platform = require("./platform");
const { assessCommand } = require("./riskyCommands");

const MUTATING_TOOLS = ["write_file", "edit_file", "delete_path", "rename_file", "create_directory", "run_terminal_command"];

// Audit action names for each mutating tool, matching the actions the repo
// diff pass and the terminal paths already write.
const TOOL_AUDIT_ACTIONS = {
  write_file: "write",
  edit_file: "edit",
  delete_path: "delete",
  rename_file: "rename",
  create_directory: "create_directory",
  run_terminal_command: "run_command",
  read_file: "read",
};

class ToolExecutor {
  constructor(fileService, repoRoot) {
    this.fileService = fileService;
    this.repoRoot = path.resolve(repoRoot);
    this.readOnly = false;
    this.onAudit = null; // (entry) => void, set by DesktopSessionService
    this.auditMeta = {}; // { provider, model, chatId } — merged into every onAudit call
  }

  _audit(entry) {
    this.onAudit?.({ ...this.auditMeta, ...entry });
  }

  setRepoRoot(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
  }

  changeRecord({ action, relativePath, before = "", after = "", oldPath = "", newPath = "" }) {
    return {
      action,
      path: relativePath,
      oldPath: oldPath || "",
      newPath: newPath || "",
      diff: buildUnifiedDiff(relativePath || newPath || oldPath, before, after),
    };
  }

  resolveAnyPath(rawPath) {
    if (!rawPath) {
      return [null, "Path is required."];
    }
    const target = path.isAbsolute(rawPath) ? rawPath : path.join(this.repoRoot, rawPath);
    const resolved = path.resolve(target);
    const relative = path.relative(this.repoRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return [null, "Path rejected: outside repo root."];
    }
    return [resolved, ""];
  }

  // Records a mutating tool call that was refused before it touched disk,
  // so denials show up in the trail alongside successes.
  _auditBlocked(name, args, detail) {
    const safeArgs = args && typeof args === "object" ? args : {};
    this._audit({
      source: "agent",
      action: TOOL_AUDIT_ACTIONS[name] || name,
      path: String(safeArgs.path || ""),
      oldPath: String(safeArgs.old_path || ""),
      newPath: String(safeArgs.new_path || ""),
      command: name === "run_terminal_command" ? String(safeArgs.command || "") : "",
      success: false,
      detail,
    });
  }

  // What an approval card shows for a tool call, before it runs: the command,
  // or the target path with a diff of the proposed change.
  approvalSummary(name, args = {}) {
    const safeArgs = args && typeof args === "object" ? args : {};
    if (name === "run_terminal_command") {
      return { kind: "command", toolName: name, command: String(safeArgs.command || ""), cwd: this.repoRoot };
    }
    const rawPath = String(safeArgs.path || safeArgs.new_path || "");
    const relativePath = rawPath.replaceAll("\\", "/");
    let diff = "";
    try {
      const [filePath] = this.resolveAnyPath(rawPath);
      const before = filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? fs.readFileSync(filePath, "utf8")
        : "";
      if (name === "write_file") {
        diff = buildUnifiedDiff(relativePath, before, String(safeArgs.content || ""));
      } else if (name === "edit_file") {
        diff = buildUnifiedDiff(relativePath, before, before.replace(String(safeArgs.old_str || ""), String(safeArgs.new_str || "")));
      } else if (name === "delete_path") {
        diff = buildUnifiedDiff(relativePath, before, "");
      }
    } catch {
      diff = "";
    }
    return {
      kind: "file_change",
      toolName: name,
      path: name === "rename_file" ? `${safeArgs.old_path || ""} -> ${safeArgs.new_path || ""}` : relativePath,
      diff,
    };
  }

  // options.approved: the person already said yes to this call (risky
  // commands only run then).
  async executeWithMetadata(name, args = {}, options = {}) {
    if (this.readOnly && MUTATING_TOOLS.includes(name)) {
      this._auditBlocked(name, args, `blocked: read-only mode (${name})`);
      return ["ERROR: tool safety mode is read-only; mutating tools are blocked.", null];
    }

    switch (name) {
      case "write_file":
        return this.writeFile(args);
      case "edit_file":
        return this.editFile(args);
      case "read_file":
        return [this.readFile(args), null];
      case "delete_path":
        return this.deletePath(args);
      case "rename_file":
        return this.renameFile(args);
      case "create_directory":
        return this.createDirectory(args);
      case "list_files":
        return [this.listFiles(args), null];
      case "run_terminal_command":
        return [await this.runTerminalCommand(args, options), null];
      default:
        return [`ERROR: unknown tool '${name}'`, null];
    }
  }

  writeFile(args) {
    const [filePath, error] = this.resolveAnyPath(String(args.path || ""));
    if (!filePath) {
      this._auditBlocked("write_file", args, `rejected: ${error}`);
      return [`ERROR: ${error}`, null];
    }
    const content = String(args.content || "");
    const before = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const action = fs.existsSync(filePath) ? "edit" : "create";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    return [
      `OK: written ${filePath}`,
      this.changeRecord({
        action,
        relativePath: path.relative(this.repoRoot, filePath).replaceAll("\\", "/"),
        before,
        after: content,
      }),
    ];
  }

  editFile(args) {
    const [filePath, error] = this.resolveAnyPath(String(args.path || ""));
    if (!filePath) {
      this._auditBlocked("edit_file", args, `rejected: ${error}`);
      return [`ERROR: ${error}`, null];
    }
    if (!fs.existsSync(filePath)) {
      return [`ERROR: file not found: ${filePath}`, null];
    }
    const original = fs.readFileSync(filePath, "utf8");
    const oldStr = String(args.old_str || "");
    const newStr = String(args.new_str || "");
    if (!original.includes(oldStr)) {
      return [`ERROR: string not found in ${path.basename(filePath)}`, null];
    }
    const updated = original.replace(oldStr, newStr);
    fs.writeFileSync(filePath, updated, "utf8");
    return [
      `OK: edited ${filePath}`,
      this.changeRecord({
        action: "edit",
        relativePath: path.relative(this.repoRoot, filePath).replaceAll("\\", "/"),
        before: original,
        after: updated,
      }),
    ];
  }

  readFile(args) {
    const [filePath, error] = this.fileService.resolveRepoPath(String(args.path || ""));
    if (!filePath) {
      // Reads are not audited normally, but an attempt to read outside the
      // repo (e.g. ~/.ssh) is a confinement event worth keeping.
      this._auditBlocked("read_file", args, `rejected: ${error}`);
      return `ERROR: ${error}`;
    }
    const [content, truncated] = this.fileService.readUtf8(filePath);
    return `${content}${truncated ? "\n...(truncated)" : ""}`;
  }

  deletePath(args) {
    const [targetPath, error] = this.resolveAnyPath(String(args.path || ""));
    if (!targetPath) {
      this._auditBlocked("delete_path", args, `rejected: ${error}`);
      return [`ERROR: ${error}`, null];
    }
    if (!fs.existsSync(targetPath)) {
      return [`ERROR: path not found: ${targetPath}`, null];
    }
    const before = fs.statSync(targetPath).isFile() ? fs.readFileSync(targetPath, "utf8") : "";
    const relativePath = path.relative(this.repoRoot, targetPath).replaceAll("\\", "/");
    fs.rmSync(targetPath, { recursive: true, force: true });
    return [
      `OK: deleted ${targetPath}`,
      this.changeRecord({
        action: "delete",
        relativePath,
        before,
        after: "",
      }),
    ];
  }

  renameFile(args) {
    const [oldPath, oldError] = this.resolveAnyPath(String(args.old_path || ""));
    if (!oldPath) {
      this._auditBlocked("rename_file", args, `rejected: ${oldError}`);
      return [`ERROR: ${oldError}`, null];
    }
    const [newPath, newError] = this.resolveAnyPath(String(args.new_path || ""));
    if (!newPath) {
      this._auditBlocked("rename_file", args, `rejected: ${newError}`);
      return [`ERROR: ${newError}`, null];
    }
    if (!fs.existsSync(oldPath)) {
      return [`ERROR: source not found: ${oldPath}`, null];
    }
    const before = fs.statSync(oldPath).isFile() ? fs.readFileSync(oldPath, "utf8") : "";
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);
    return [
      `OK: renamed to ${newPath}`,
      this.changeRecord({
        action: "rename",
        relativePath: path.relative(this.repoRoot, newPath).replaceAll("\\", "/"),
        before,
        after: before,
        oldPath: path.relative(this.repoRoot, oldPath).replaceAll("\\", "/"),
        newPath: path.relative(this.repoRoot, newPath).replaceAll("\\", "/"),
      }),
    ];
  }

  createDirectory(args) {
    const [directoryPath, error] = this.resolveAnyPath(String(args.path || ""));
    if (!directoryPath) {
      this._auditBlocked("create_directory", args, `rejected: ${error}`);
      return [`ERROR: ${error}`, null];
    }
    fs.mkdirSync(directoryPath, { recursive: true });
    return [
      `OK: directory created ${directoryPath}`,
      {
        action: "create_directory",
        path: path.relative(this.repoRoot, directoryPath).replaceAll("\\", "/"),
        oldPath: "",
        newPath: "",
        diff: "",
      },
    ];
  }

  listFiles(args) {
    const directory = String(args.directory || "").trim();
    const target = directory ? this.resolveAnyPath(directory)[0] : this.repoRoot;
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return `ERROR: directory not found: ${target || directory}`;
    }
    const files = this.fileService.listFiles(target, 200);
    return files.length ? files.join("\n") : "(no files)";
  }

  runTerminalCommand(args, { approved = false } = {}) {
    const command = String(args.command || "").trim();
    if (!command) {
      return Promise.resolve("ERROR: no command provided");
    }

    // The shared risky-command list (riskyCommands.js): never-allowed
    // commands are refused; risky ones (recursive deletes, leaving the repo,
    // downloads, force pushes...) run only once the person approved them,
    // which sessionSend asks for before calling here.
    const risk = assessCommand(command, { repoRoot: this.repoRoot });
    if (risk && (risk.level === "block" || !approved)) {
      const detail = risk.level === "block"
        ? `blocked by safety policy: ${risk.reason}`
        : `blocked by safety policy: not approved (${risk.reason})`;
      this._audit({ source: "agent", action: "run_command", command, success: false, detail });
      return Promise.resolve(
        risk.level === "block"
          ? `ERROR: command blocked by safety policy: it ${risk.reason}. Do not retry it; continue another way.`
          : `ERROR: this command ${risk.reason} and needs the user's approval first.`,
      );
    }

    return new Promise((resolve) => {
      const shell = platform.getShell();
      const child = spawn(shell.command, [...shell.args, command], {
        cwd: this.repoRoot,
        env: resolveAndroidEnv(process.env),
        windowsHide: true,
        windowsVerbatimArguments: shell.useVerbatim,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        this._audit({ source: "agent", action: "run_command", command, exitCode: 1, success: false, detail: String(error?.message || error) });
        resolve(`STDOUT:\n${stdout}\nSTDERR:\n${stderr}${stderr ? "\n" : ""}${String(error?.message || error)}\n(Exit 1)`);
      });
      child.on("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        const code = typeof exitCode === "number" ? exitCode : 0;
        this._audit({ source: "agent", action: "run_command", command, exitCode: code, success: code === 0 });
        resolve(`STDOUT:\n${stdout || ""}\nSTDERR:\n${stderr || ""}\n(Exit ${code})`);
      });
    });
  }
}

module.exports = {
  ToolExecutor,
};
