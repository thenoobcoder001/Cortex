"use strict";

const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

let isWin = process.platform === "win32";
let isMac = process.platform === "darwin";
let isLinux = process.platform === "linux";

/**
 * Returns the default shell for the current platform.
 */
function getShell() {
  if (module.exports.isWin) {
    return {
      command: process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c"],
      useVerbatim: true,
      banner: "Cortex Windows Terminal\r\n"
    };
  }
  
  const shell = process.env.SHELL || (module.exports.isMac ? "/bin/zsh" : "/bin/bash");
  return {
    command: shell,
    args: ["-lc"],
    useVerbatim: false,
    banner: `Cortex ${module.exports.isMac ? "macOS" : "Linux"} Terminal (${path.basename(shell)})\r\n`
  };
}

/**
 * Returns the path to the app data directory for the current platform.
 */
function getAppDataDir() {
  if (module.exports.isWin) {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "cortex");
  }
  if (module.exports.isMac) {
    return path.join(os.homedir(), "Library", "Application Support", "cortex");
  }
  return path.join(os.homedir(), ".config", "cortex");
}

/**
 * Safely kills a process and its children.
 */
function killProcessTree(child) {
  if (!child || !child.pid) return;

  if (module.exports.isWin) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch (err) {
      console.warn(`platform: taskkill failed for PID ${child.pid}:`, err.message);
    }
  }

  try {
    // On Unix, we can try to kill the group if we spawned with detached: true,
    // but default to standard kill for now.
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000);
  } catch (err) {
    console.warn(`platform: kill failed for PID ${child.pid}:`, err.message);
  }
}

/**
 * Platform-aware argument quoting for shells.
 */
function quoteArg(arg) {
  const text = String(arg ?? "");
  if (!module.exports.isWin) {
    // Simple bourne shell quoting
    if (!text || /[^\w./-]/u.test(text)) {
      return `'${text.replace(/'/g, "'\\''")}'`;
    }
    return text;
  }

  // Windows cmd.exe quoting
  if (text.length === 0) return '""';
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

// ── Windows command lines for cmd.exe ────────────────────────────────────
//
// Node refuses to spawn .cmd/.bat files without a shell (CVE-2024-27980), and
// `shell: true` with an args array is deprecated (DEP0190) because Node just
// joins the args unescaped. So for batch shims (npm installs `claude.cmd`,
// `codex.cmd`, `gemini.cmd`) we run `cmd.exe /d /s /c "<line>"` ourselves and
// build <line> with the same escaping cross-spawn uses:
//   1. quote each arg MSVCRT-style (so the final program's argv parser gets it
//      back intact), then
//   2. caret-escape every cmd metacharacter, including the quotes we just
//      added, so cmd.exe never treats & | < > ( ) % ! etc. as syntax, and
//   3. for .cmd/.bat targets, caret-escape a second time, because the shim
//      re-parses its arguments when it expands %*.
// Real executables (.exe/.com) skip all of this and are spawned directly.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArg(arg, { doubleEscape = false } = {}) {
  let text = String(arg ?? "");
  // A run of backslashes before a quote: double them, then escape the quote.
  text = text.replace(/(\\*)"/g, '$1$1\\"');
  // Trailing backslashes would escape our closing quote: double them.
  text = text.replace(/(\\*)$/, "$1$1");
  text = `"${text}"`;
  text = text.replace(CMD_META_CHARS, "^$1");
  if (doubleEscape) text = text.replace(CMD_META_CHARS, "^$1");
  return text;
}

function escapeCmdCommand(command) {
  // Quote the program path too (it may contain spaces, e.g. Program Files),
  // then caret-escape. cmd.exe strips the quotes when resolving the program.
  return `"${String(command)}"`.replace(CMD_META_CHARS, "^$1");
}

function isBatchFile(command) {
  return /\.(cmd|bat)$/i.test(String(command || ""));
}

function isWindowsExecutable(command) {
  return /\.(exe|com)$/i.test(String(command || ""));
}

/**
 * Returns `{ file, args, options }` needed to run `command args`
 * on Windows without `shell: true`. Executables are spawned directly; anything
 * else (batch shims, bare names) goes through `cmd.exe /d /s /c` with every
 * argument escaped for cmd.exe. Arguments must not contain newlines: cmd.exe
 * ends the command at the first one, so callers pass long text via stdin.
 */
function windowsSpawnSpec(command, args = []) {
  const list = Array.isArray(args) ? args.map((a) => String(a ?? "")) : [];
  if (isWindowsExecutable(command)) {
    return { file: command, args: list, options: { windowsHide: true } };
  }
  if (list.some((a) => /[\r\n]/.test(a))) {
    throw new Error("Arguments passed through cmd.exe cannot contain newlines.");
  }
  const doubleEscape = isBatchFile(command);
  const line = [escapeCmdCommand(command), ...list.map((a) => escapeCmdArg(a, { doubleEscape }))].join(" ");
  return {
    file: process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsHide: true, windowsVerbatimArguments: true },
  };
}

module.exports = {
  isWin,
  isMac,
  isLinux,
  getShell,
  getAppDataDir,
  killProcessTree,
  quoteArg,
  escapeCmdArg,
  escapeCmdCommand,
  windowsSpawnSpec,
};
