const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { resolveAndroidEnv } = require("./androidEnv");
const platform = require("./platform");

let pty;
try {
  pty = require("node-pty");
} catch {
  pty = null;
}

const MAX_HISTORY_CHARS = 80_000;

function shellCommand() {
  const shell = platform.getShell();
  return {
    command: shell.command,
    // For interactive terminals, we don't want the "/c" or "-lc" args
    // we want just the interactive shell.
    args: [],
    banner: shell.banner
  };
}

function killProcessTree(child) {
  platform.killProcessTree(child);
}

class TerminalService extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  key(chatId) {
    return String(chatId || "").trim();
  }

  append(session, chunk) {
    const text = String(chunk || "");
    session.history += text;
    if (session.history.length > MAX_HISTORY_CHARS) {
      session.history = session.history.slice(-MAX_HISTORY_CHARS);
    }
    session.updatedAt = new Date().toISOString();
    this.emit(`data:${session.chatId}`, text);
  }

  snapshot(chatId) {
    const session = this.sessions.get(this.key(chatId));
    if (!session) {
      return { chatId: this.key(chatId), status: "closed", cwd: "", pid: null, history: "", startedAt: "", updatedAt: "", exitCode: null };
    }
    return {
      chatId: session.chatId,
      status: session.status,
      cwd: session.cwd,
      pid: session.child?.pid || null,
      history: session.history,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      exitCode: session.exitCode,
    };
  }

  open({ chatId, repoRoot, cols = 120, rows = 30 }) {
    const id = this.key(chatId);
    if (!id) throw new Error("Chat id is required.");
    const cwd = path.resolve(String(repoRoot || process.cwd()));
    const existing = this.sessions.get(id);
    if (existing && existing.status === "running") return this.snapshot(id);

    const shell = shellCommand();
    const env = resolveAndroidEnv({ ...process.env, CORTEX_CHAT_ID: id, FORCE_COLOR: "1", TERM: "xterm-256color", COLORTERM: "truecolor" });
    const now = new Date().toISOString();

    let child;
    let isPty = false;

    if (pty) {
      try {
        child = pty.spawn(shell.command, shell.args, { name: "xterm-256color", cols, rows, cwd, env });
        isPty = true;
      } catch {}
    }

    if (!isPty) {
      const { spawn } = require("node:child_process");
      child = spawn(shell.command, shell.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    }

    const session = { chatId: id, cwd, child, isPty, status: "running", history: `${shell.banner}Working directory: ${cwd}\r\n`, startedAt: now, updatedAt: now, exitCode: null };
    this.sessions.set(id, session);

    if (isPty) {
      child.onData((data) => this.append(session, data));
      child.onExit(({ exitCode, signal }) => {
        session.status = "exited";
        session.exitCode = typeof exitCode === "number" ? exitCode : null;
        this.append(session, `\r\n[terminal exited code=${exitCode ?? "null"} signal=${signal ?? "null"}]\r\n`);
      });
    } else {
      child.stdout.on("data", (chunk) => this.append(session, chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => this.append(session, chunk.toString("utf8")));
      child.on("close", (exitCode, signal) => {
        session.status = "exited";
        session.exitCode = typeof exitCode === "number" ? exitCode : null;
        this.append(session, `\r\n[terminal exited code=${exitCode ?? "null"} signal=${signal ?? "null"}]\r\n`);
      });
      child.on("error", (error) => {
        session.status = "error";
        this.append(session, `\r\n[terminal error] ${error.message}\r\n`);
      });
    }

    return this.snapshot(id);
  }

  write({ chatId, command, repoRoot }) {
    const id = this.key(chatId);
    const text = String(command || "");
    if (!text.trim()) return this.snapshot(id);
    let session = this.sessions.get(id);
    if (!session || session.status !== "running") {
      this.open({ chatId: id, repoRoot });
      session = this.sessions.get(id);
    }
    try {
      if (session.isPty) {
        session.child.write(`${text}\r`);
      } else {
        session.child.stdin.write(`${text}${os.EOL}`);
      }
    } catch {}
    return this.snapshot(id);
  }

  input({ chatId, data, repoRoot }) {
    const id = this.key(chatId);
    let session = this.sessions.get(id);
    if (!session || session.status !== "running") {
      this.open({ chatId: id, repoRoot });
      session = this.sessions.get(id);
    }
    try {
      if (session.isPty) {
        session.child.write(String(data || ""));
      } else {
        session.child.stdin.write(String(data || ""));
      }
    } catch {}
    return this.snapshot(id);
  }

  resize({ chatId, cols, rows }) {
    const id = this.key(chatId);
    const session = this.sessions.get(id);
    if (session?.isPty && session.status === "running") {
      try { session.child.resize(cols, rows); } catch {}
    }
    return this.snapshot(id);
  }

  close(chatId) {
    const id = this.key(chatId);
    const session = this.sessions.get(id);
    if (!session) return this.snapshot(id);
    killProcessTree(session.child);
    session.status = "closed";
    session.exitCode = null;
    this.append(session, "\r\n[terminal closed]\r\n");
    return this.snapshot(id);
  }

  closeAll() {
    for (const chatId of this.sessions.keys()) this.close(chatId);
  }
}

module.exports = { TerminalService };
