const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startBackendServer } = require("../backend/server");

let backendHandle = null;
let backendUrl = null;
let mainWindow = null;
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

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
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

async function startBackend() {
  // Try to use the default port 8765 first so browser access works consistently.
  try {
    backendHandle = await startBackendServer({ host: "127.0.0.1", port: 8765 });
  } catch (err) {
    // If 8765 is taken, fall back to a dynamic free port.
    const port = await findFreePort();
    backendHandle = await startBackendServer({ host: "127.0.0.1", port });
  }
  backendUrl = backendHandle.url;
}

function stopBackend() {
  if (!backendHandle) {
    return;
  }
  void backendHandle.close();
  backendHandle = null;
}

function launchDetached(command, args, cwd) {
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
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) {
        return;
      }
      settled = true;
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
}

if (ipcMain) {
  ipcMain.handle("desktop:get-config", () => ({
    backendUrl,
  }));

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

    const error = await shell.openPath(resolved);
    if (error) {
      throw new Error(error);
    }
    return { ok: true };
  });
}

if (app) {
  app.disableHardwareAcceleration();

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
    stopBackend();
  });
} else {
  // Fallback testing local backend if electron fails to load
  console.log("Starting backend without electron...");
  startBackend();
}

