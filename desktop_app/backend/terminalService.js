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

// Each session gets a new epoch so clients can tell a reopened terminal
// (offsets restart at 0) from more output on the same one.
let nextEpoch = 1;

function normalizeSize(cols, rows) {
  const c = Math.trunc(Number(cols));
  const r = Math.trunc(Number(rows));
  if (!Number.isFinite(c) || !Number.isFinite(r) || c < 1 || r < 1) return null;
  return { cols: Math.min(c, 1000), rows: Math.min(r, 500) };
}

// Drops size entries from before the kept history, keeping the one in effect
// where it now starts.
function pruneSizes(session) {
  const start = session.total - session.history.length;
  let current = session.sizes[0];
  const later = [];
  for (const entry of session.sizes) {
    if (entry.at <= start) current = entry;
    else later.push(entry);
  }
  session.sizes = [{ ...current, at: start }, ...later];
}

function shellCommand() {
  const shell = platform.getShell();
  // Windows inherits PATH from the process env so no extra args needed.
  // On Linux/macOS spawn as a login shell (-l) so ~/.profile / ~/.bash_profile
  // are sourced and tools like `claude` added there are on PATH.
  const args = platform.isWin ? [] : ["-l"];
  return { command: shell.command, args, banner: shell.banner };
}

function killProcessTree(child) {
  platform.killProcessTree(child);
}

class TerminalService extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.onAudit = null;
  }

  key(chatId) {
    return String(chatId || "").trim();
  }

  // `session.total` counts every char ever appended, so `history` always ends
  // at offset `total` and starts at `total - history.length`. Clients use
  // these offsets to write each chunk once, whether it came from the stream,
  // a poll, or a replay after remounting.
  append(session, chunk) {
    const text = String(chunk || "");
    if (!text) return;
    session.history += text;
    session.total += text.length;
    if (session.history.length > MAX_HISTORY_CHARS) {
      session.history = session.history.slice(-MAX_HISTORY_CHARS);
      pruneSizes(session);
    }
    session.updatedAt = new Date().toISOString();
    this.emit(`data:${session.chatId}`, text, { epoch: session.epoch, end: session.total });
  }

  snapshot(chatId) {
    const session = this.sessions.get(this.key(chatId));
    if (!session) {
      return {
        chatId: this.key(chatId), status: "closed", cwd: "", pid: null, history: "", startedAt: "", updatedAt: "", exitCode: null,
        epoch: 0, total: 0, cols: 0, rows: 0, sizes: [],
      };
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
      epoch: session.epoch,
      total: session.total,
      cols: session.cols,
      rows: session.rows,
      // Size changes within `history` as { at, cols, rows } (`at` is an
      // absolute offset). ConPTY output is cursor-addressed for the size the
      // terminal had at the time, so a replay has to follow these.
      sizes: (session.sizes || []).map((entry) => ({ ...entry })),
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
    const size = normalizeSize(cols, rows) || { cols: 120, rows: 30 };

    let child;
    let isPty = false;

    if (pty) {
      try {
        child = pty.spawn(shell.command, shell.args, { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd, env });
        isPty = true;
      } catch {}
    }

    if (!isPty) {
      const { spawn } = require("node:child_process");
      child = spawn(shell.command, shell.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    }

    const history = `${shell.banner}Working directory: ${cwd}\r\n`;
    const session = {
      chatId: id, cwd, child, isPty, status: "running", history, startedAt: now, updatedAt: now, exitCode: null,
      epoch: nextEpoch++, total: history.length, cols: size.cols, rows: size.rows,
      sizes: [{ at: 0, ...size }],
    };
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
      this.onAudit?.({
        source: "terminal",
        action: "run_command",
        command: text,
        chatId: id,
        success: true,
        detail: "submitted to interactive terminal",
      });
    } catch (error) {
      this.onAudit?.({
        source: "terminal",
        action: "run_command",
        command: text,
        chatId: id,
        success: false,
        detail: String(error?.message || error),
      });
    }
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
    const size = normalizeSize(cols, rows);
    // Skip same-size resizes: ConPTY repaints the whole screen on every
    // resize call, which only adds another copy of it to the history.
    if (size && session?.isPty && session.status === "running"
      && (size.cols !== session.cols || size.rows !== session.rows)) {
      try {
        session.child.resize(size.cols, size.rows);
        session.cols = size.cols;
        session.rows = size.rows;
        session.sizes.push({ at: session.total, ...size });
      } catch {}
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
