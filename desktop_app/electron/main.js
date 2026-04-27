const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AppConfigStore } = require("../backend/configStore");
const { startBackendServer } = require("../backend/server");

let backendHandle = null;
let backendUrl = null;
let mainWindow = null;
let backendPort = 8765;
let remoteAccessEnabled = false;
const desktopLogDir = path.join(os.homedir(), ".cortex", "logs");
const desktopLaunchLogPath = path.join(desktopLogDir, "desktop-launch.log");
const EXTERNAL_EDITORS = {
  vscode: { command: "code", label: "VS Code" },
  antigravity: { command: "antigravity", label: "Antigravity" },
  cursor: { command: "cursor", label: "Cursor" },
};

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function resolveRendererEntry() {
  if (process.env.ELECTRON_RENDERER_URL) {
    return { kind: "url", value: process.env.ELECTRON_RENDERER_URL };
  }
  return {
    kind: "file",
    value: path.join(__dirname, "..", "web", "dist", "index.html"),
  };
}

function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine an open port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
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

async function startBackend() {
  remoteAccessEnabled = loadRemoteAccessPreference();
  const host = remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";
  // Try to use the default port 8765 first so browser access works consistently.
  try {
    backendHandle = await startBackendServer({ host, port: 8765 });
  } catch (err) {
    // If 8765 is taken, fall back to a dynamic free port.
    const port = await findFreePort(host);
    backendHandle = await startBackendServer({ host, port });
  }
  backendPort = Number(new URL(backendHandle.url).port || 8765);
  backendUrl = `http://127.0.0.1:${backendPort}`;
}

async function stopBackend() {
  if (!backendHandle) {
    return;
  }
  await backendHandle.close();
  backendHandle = null;
  backendUrl = null;
  backendPort = 0;
}

async function restartBackend() {
  await stopBackend();
  await startBackend();
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
      await launchDetached(editor.command, [targetPath], targetPath);
      return { ok: true };
    } catch {
      throw new Error(`${editor.label} is not available. Install its CLI launcher or add it to PATH.`);
    }
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
  // Fallback testing local backend if electron fails to load
  console.log("Starting backend without electron...");
  startBackend();
}

