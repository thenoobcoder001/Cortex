const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { fork } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AppConfigStore } = require("../backend/configStore");
const { autoUpdater } = require("electron-updater");

// ── auto-updater setup ────────────────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let _updateStatus = { state: "idle", version: null, error: null };

function _setUpdateStatus(state, version = null, error = null) {
  _updateStatus = { state, version, error };
  mainWindow?.webContents?.send("update:status", _updateStatus);
}

autoUpdater.on("checking-for-update",    () => _setUpdateStatus("checking"));
autoUpdater.on("update-not-available",   () => _setUpdateStatus("up-to-date"));
autoUpdater.on("update-available",       (info) => _setUpdateStatus("available", info.version));
autoUpdater.on("download-progress",      (p) => _setUpdateStatus("downloading", String(Math.round(p.percent)) + "%"));
autoUpdater.on("update-downloaded",      (info) => _setUpdateStatus("ready", info.version));
autoUpdater.on("error",                  (err) => _setUpdateStatus("error", null, String(err.message || err)));

// ── Backend worker (utilityProcess) ──────────────────────────────────────────
// The HTTP backend runs in its own process so its event loop never competes
// with Electron's main-process Win32 message pump ("Not Responding").
let _worker = null;
let _msgId = 0;
const _pending = new Map();

function workerSend(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!_worker) {
      reject(new Error("Backend worker is not running"));
      return;
    }
    const id = ++_msgId;
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`Worker request "${type}" timed out`));
    }, 15_000);
    _pending.set(id, { resolve, reject, timer });
    _worker.send({ id, type, payload });
  });
}

function spawnWorker() {
  if (_worker) {
    _worker.kill();
    _worker = null;
  }
  _worker = fork(path.join(__dirname, "backend-worker.js"), [], {
    stdio: "inherit",
  });
  _worker.on("message", (msg) => {
    const pending = _pending.get(msg.id);
    if (pending) {
      clearTimeout(pending.timer);
      _pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error));
    }
  });
  _worker.on("exit", (code) => {
    logDesktopLaunch("backend.worker.exit", { code });
    _worker = null;
    // Clear all pending requests
    for (const [id, { reject, timer }] of _pending) {
      clearTimeout(timer);
      reject(new Error("Backend worker exited unexpectedly"));
      _pending.delete(id);
    }
  });
}

let backendUrl = null;
let mainWindow = null;
let backendPort = 8765;
let remoteAccessEnabled = false;
const desktopLogDir = path.join(os.homedir(), ".cortex", "logs");
const desktopLaunchLogPath = path.join(desktopLogDir, "desktop-launch.log");
const EXTERNAL_EDITORS = {
  vscode:         { command: "code",       label: "VS Code" },
  visualstudio:   { command: "devenv",     label: "Visual Studio" },
  cursor:         { command: "cursor",     label: "Cursor" },
  fileexplorer: {
    label: "File Explorer",
    command: process.platform === "win32" ? "explorer"
           : process.platform === "darwin" ? "open"
           : "xdg-open",
  },
  terminal: {
    label: "Terminal",
    command: process.platform === "win32" ? "wt"
           : process.platform === "darwin" ? "open"
           : "x-terminal-emulator",
    terminalArgs: process.platform === "darwin" ? ["-a", "Terminal"] : [],
  },
};

function resolveRendererEntry() {
  if (process.env.ELECTRON_RENDERER_URL) {
    return { kind: "url", value: process.env.ELECTRON_RENDERER_URL };
  }
  return {
    kind: "file",
    value: path.join(__dirname, "..", "web", "dist", "index.html"),
  };
}

function loadRemoteAccessPreference() {
  return Boolean(AppConfigStore.load().remoteAccessEnabled);
}

function listRemoteAccessUrls() {
  if (!remoteAccessEnabled || !backendPort) {
    return [];
  }
  const interfaces = os.networkInterfaces();
  const urls = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.internal || address.family !== "IPv4") {
        continue;
      }
      urls.push({
        label: /^tailscale/i.test(name) || String(address.address).startsWith("100.")
          ? `Tailscale (${address.address})`
          : `${name} (${address.address})`,
        url: `http://${address.address}:${backendPort}`,
      });
    }
  }
  return urls;
}

function desktopConfigPayload() {
  return {
    backendUrl,
    remoteAccessEnabled,
    remoteAccessUrls: listRemoteAccessUrls(),
  };
}

function getNetworkUrl(port, tailscale = false) {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces || {})) {
    for (const addr of addrs || []) {
      if (addr.internal || addr.family !== "IPv4") continue;
      const isTailscale = addr.address.startsWith("100.");
      if (tailscale === isTailscale) return `http://${addr.address}:${port}`;
    }
  }
  return "";
}

async function startBackend() {
  remoteAccessEnabled = loadRemoteAccessPreference();
  const host = remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";

  spawnWorker();
  const result = await workerSend("start", { host, port: 8765 });
  backendPort = Number(new URL(result.url).port || 8765);
  backendUrl = `http://127.0.0.1:${backendPort}`;

  // Auto-connect Cortex relay if credentials are saved
  const config = AppConfigStore.load();
  if (config.cortexToken) {
    setImmediate(async () => {
      try {
        const relayResult = await workerSend("relay:connect", {
          token:            config.cortexToken,
          deviceId:         config.cortexDeviceId         || undefined,
          reconnectSecret:  config.cortexReconnectSecret  || undefined,
          localUrl:         getNetworkUrl(backendPort, false),
          tailscaleUrl:     getNetworkUrl(backendPort, true),
          localBackendPort: backendPort,
        });
        const cfg = AppConfigStore.load();
        cfg.cortexDeviceId        = relayResult.deviceId;
        cfg.cortexReconnectSecret = relayResult.reconnectSecret;
        cfg.save();
        logDesktopLaunch("cortex.relay.connected", { deviceId: relayResult.deviceId, socketId: relayResult.socketId });
      } catch (err) {
        logDesktopLaunch("cortex.relay.connect_failed", { message: String(err.message || err) });
      }
    });
  }
}

async function stopBackend() {
  if (_worker) {
    _worker.kill();
    _worker = null;
  }
  backendUrl = null;
  backendPort = 0;
}

async function restartBackend() {
  remoteAccessEnabled = loadRemoteAccessPreference();
  const host = remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";
  const result = await workerSend("restart", { host, port: 8765 });
  backendPort = Number(new URL(result.url).port || 8765);
  backendUrl = `http://127.0.0.1:${backendPort}`;
  return desktopConfigPayload();
}

function saveRemoteAccessPreference(enabled) {
  const config = AppConfigStore.load();
  config.remoteAccessEnabled = Boolean(enabled);
  config.save();
}

function logDesktopLaunch(event, payload = {}) {
  try {
    fs.mkdirSync(desktopLogDir, { recursive: true });
    const line = JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...payload,
    });
    fs.appendFileSync(desktopLaunchLogPath, `${line}\n`, "utf8");
  } catch {
    // Ignore logging failures.
  }
}

function serializeError(error) {
  if (!error) {
    return null;
  }
  return {
    name: String(error.name || ""),
    message: String(error.message || error),
    stack: String(error.stack || ""),
  };
}

function attachWindowDiagnostics(window) {
  if (!window?.webContents) {
    return;
  }
  window.webContents.on("render-process-gone", (_event, details) => {
    logDesktopLaunch("webcontents.render-process-gone", details || {});
  });
  window.webContents.on("unresponsive", () => {
    logDesktopLaunch("webcontents.unresponsive", {});
  });
  window.webContents.on("responsive", () => {
    logDesktopLaunch("webcontents.responsive", {});
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logDesktopLaunch("webcontents.did-fail-load", {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    });
  });
}

function launchDetached(command, args, cwd) {
  logDesktopLaunch("detached.spawn.requested", { command, args, cwd });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      shell: process.platform === "win32",
      stdio: "ignore",
    });

    let settled = false;
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      logDesktopLaunch("detached.spawn.error", {
        command,
        args,
        cwd,
        message: String(error?.message || error),
      });
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) {
        return;
      }
      settled = true;
      logDesktopLaunch("detached.spawn.started", {
        command,
        args,
        cwd,
        pid: child.pid || null,
      });
      child.unref();
      resolve();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0b1016",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const entry = resolveRendererEntry();
  if (entry.kind === "url") {
    mainWindow.loadURL(entry.value);
  } else {
    mainWindow.loadFile(entry.value);
  }

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    dialog.showErrorBox("Cortex — Load Error", `Renderer failed to load (${errorCode}):\n${errorDescription}`);
  });
  attachWindowDiagnostics(mainWindow);
}

if (ipcMain) {
  ipcMain.handle("desktop:get-config", () => desktopConfigPayload());

  ipcMain.handle("desktop:set-remote-access", async (_event, payload) => {
    const enabled = Boolean(payload?.enabled);
    saveRemoteAccessPreference(enabled);
    try {
      return await restartBackend();
    } catch (error) {
      saveRemoteAccessPreference(!enabled);
      await restartBackend();
      throw error;
    }
  });

  ipcMain.handle("desktop:pick-repo", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("desktop:open-in-editor", async (_event, payload) => {
    const repoRoot = String(payload?.repoRoot || "").trim();
    const editorId = String(payload?.editor || "").trim().toLowerCase();
    const editor = EXTERNAL_EDITORS[editorId];

    if (!editor) {
      throw new Error("Unsupported editor.");
    }
    if (!repoRoot) {
      throw new Error("No project folder is selected.");
    }

    const targetPath = path.resolve(repoRoot);
    if (!fs.existsSync(targetPath)) {
      throw new Error("Selected project folder does not exist.");
    }

    try {
      const args = editorId === "terminal"
        ? (editor.terminalArgs?.length ? [...editor.terminalArgs] : [targetPath])
        : editorId === "fileexplorer" && process.platform === "win32"
          ? [targetPath]
          : [targetPath];
      await launchDetached(editor.command, args, targetPath);
      return { ok: true };
    } catch {
      throw new Error(`${editor.label} is not available. Install its CLI launcher or add it to PATH.`);
    }
  });

  ipcMain.handle("cortex:status",         () => workerSend("relay:status"));
  ipcMain.handle("cortex:refresh-status", async () => {
    const status = await workerSend("relay:status");
    if (status.state !== "connected") {
      return { ...status, verified: false };
    }
    const result = await workerSend("relay:probe");
    return { ...status, verified: true, lastProbeAt: new Date().toISOString(), probe: result };
  });

  ipcMain.handle("cortex:connect", async (_event, payload) => {
    const { token, deviceId, reconnectSecret } = payload || {};
    if (!token) throw new Error("token is required");
    const result = await workerSend("relay:connect", {
      token, deviceId, reconnectSecret,
      localUrl:         getNetworkUrl(backendPort, false),
      tailscaleUrl:     getNetworkUrl(backendPort, true),
      localBackendPort: backendPort,
    });
    const config = AppConfigStore.load();
    config.cortexToken           = token;
    config.cortexDeviceId        = result.deviceId;
    config.cortexReconnectSecret = result.reconnectSecret;
    config.save();
    return result;
  });

  ipcMain.handle("cortex:disconnect", async () => {
    await workerSend("relay:disconnect");
    const config = AppConfigStore.load();
    config.cortexToken = "";
    config.cortexDeviceId = "";
    config.cortexReconnectSecret = "";
    config.save();
    return { ok: true };
  });

  ipcMain.handle("desktop:open-file", async (_event, payload) => {
    const filePath = String(payload?.path || "").trim();
    if (!filePath) {
      throw new Error("No file path was provided.");
    }
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error("Selected file does not exist.");
    }

    logDesktopLaunch("shell.openPath.requested", { path: resolved });
    const error = await shell.openPath(resolved);
    if (error) {
      logDesktopLaunch("shell.openPath.error", { path: resolved, message: error });
      throw new Error(error);
    }
    logDesktopLaunch("shell.openPath.started", { path: resolved });
    return { ok: true };
  });

  ipcMain.handle("updater:get-status",    () => ({ ..._updateStatus, currentVersion: app.getVersion() }));
  ipcMain.handle("updater:check",         async () => { try { await autoUpdater.checkForUpdates(); } catch (err) { _setUpdateStatus("error", null, String(err.message || err)); } return { ..._updateStatus, currentVersion: app.getVersion() }; });
  ipcMain.handle("updater:download",      () => autoUpdater.downloadUpdate());
  ipcMain.handle("updater:install",       () => { autoUpdater.quitAndInstall(); });
  ipcMain.handle("updater:set-feed-url",  (_event, url) => { if (url) autoUpdater.setFeedURL({ url }); return { ok: true }; });
}

if (app) {
  app.disableHardwareAcceleration();
  process.on("uncaughtException", (error) => {
    logDesktopLaunch("process.uncaughtException", { error: serializeError(error) });
  });
  process.on("unhandledRejection", (reason) => {
    logDesktopLaunch("process.unhandledRejection", {
      error: serializeError(reason instanceof Error ? reason : new Error(String(reason))),
    });
  });
  app.on("render-process-gone", (_event, webContents, details) => {
    logDesktopLaunch("app.render-process-gone", {
      details: details || {},
      url: webContents?.getURL?.() || "",
    });
  });
  app.on("child-process-gone", (_event, details) => {
    logDesktopLaunch("app.child-process-gone", details || {});
  });
  app.on("gpu-process-crashed", (_event, killed) => {
    logDesktopLaunch("app.gpu-process-crashed", { killed: Boolean(killed) });
  });

  app.whenReady().then(async () => {
    try {
      await startBackend();
    } catch (err) {
      dialog.showErrorBox("Cortex — Startup Error", `Backend failed to start:\n\n${err?.message || err}`);
      app.quit();
      return;
    }
    createWindow();

    // Check for updates 10s after launch, then every 4 hours
    setTimeout(() => {
      try { autoUpdater.checkForUpdates().catch(() => {}); } catch {}
    }, 10_000);
    setInterval(() => {
      try { autoUpdater.checkForUpdates().catch(() => {}); } catch {}
    }, 4 * 60 * 60 * 1000);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    void stopBackend();
  });
} else {
  // Fallback: start backend standalone without Electron (for local testing)
  const { startBackendServer } = require("../backend/server");
  console.log("Starting backend without electron...");
  startBackendServer({ host: "127.0.0.1", port: 8765 }).then((h) => {
    console.log("Backend running at", h.url);
  });
}
