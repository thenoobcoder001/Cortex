const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildUnifiedDiff } = require("./fileService");
const { resolveAndroidEnv } = require("./androidEnv");

class ToolExecutor {
  constructor(fileService, repoRoot) {
    this.fileService = fileService;
    this.repoRoot = path.resolve(repoRoot);
    this.readOnly = false;
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

  async executeWithMetadata(name, args = {}) {
    if (
      this.readOnly
      && ["write_file", "edit_file", "delete_path", "rename_file", "create_directory", "run_terminal_command"].includes(name)
    ) {
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
        return [await this.runTerminalCommand(args), null];
      default:
        return [`ERROR: unknown tool '${name}'`, null];
    }
  }

  writeFile(args) {
    const [filePath, error] = this.resolveAnyPath(String(args.path || ""));
    if (!filePath) {
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
      return `ERROR: ${error}`;
    }
    const [content, truncated] = this.fileService.readUtf8(filePath);
    return `${content}${truncated ? "\n...(truncated)" : ""}`;
  }

  deletePath(args) {
    const [targetPath, error] = this.resolveAnyPath(String(args.path || ""));
    if (!targetPath) {
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
      return [`ERROR: ${oldError}`, null];
    }
    const [newPath, newError] = this.resolveAnyPath(String(args.new_path || ""));
    if (!newPath) {
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

  runTerminalCommand(args) {
    const command = String(args.command || "").trim();
    if (!command) {
      return Promise.resolve("ERROR: no command provided");
    }

    return new Promise((resolve) => {
      const child = process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
            cwd: this.repoRoot,
            env: resolveAndroidEnv(process.env),
            windowsHide: true,
            shell: false,
          })
        : spawn(process.env.SHELL || "/bin/bash", ["-lc", command], {
            cwd: this.repoRoot,
            env: resolveAndroidEnv(process.env),
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
        resolve(`STDOUT:\n${stdout}\nSTDERR:\n${stderr}${stderr ? "\n" : ""}${String(error?.message || error)}\n(Exit 1)`);
      });
      child.on("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(`STDOUT:\n${stdout || ""}\nSTDERR:\n${stderr || ""}\n(Exit ${typeof exitCode === "number" ? exitCode : 0})`);
      });
    });
  }
}

module.exports = {
  ToolExecutor,
};
