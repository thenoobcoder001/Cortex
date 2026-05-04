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

module.exports = {
  isWin,
  isMac,
  isLinux,
  getShell,
  getAppDataDir,
  killProcessTree,
  quoteArg
};
