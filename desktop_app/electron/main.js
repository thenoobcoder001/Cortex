const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const http = require("node:http");

let backendProcess = null;
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

function waitForBackend(url, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const request = http.get(`${url}/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Backend healthcheck failed with ${response.statusCode}.`));
          return;
        }
        setTimeout(tryOnce, 250);
      });

      request.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error("Timed out waiting for backend startup."));
          return;
        }
        setTimeout(tryOnce, 250);
      });
    };

    tryOnce();
  });
}

function resolveBackendLaunch(port) {
  const packagedBackend = path.join(process.resourcesPath, "backend", "gpt-tui-backend.exe");
  if (app.isPackaged && fs.existsSync(packagedBackend)) {
    return {
      command: packagedBackend,
      args: ["--port", String(port)],
      cwd: process.resourcesPath,
      shell: false,
    };
  }

  if (process.env.GPT_TUI_BACKEND_CMD) {
    return {
      command: process.env.GPT_TUI_BACKEND_CMD,
      args: ["--port", String(port)],
      cwd: repoRoot(),
      shell: true,
    };
  }

  return {
    command: process.env.GPT_TUI_BACKEND_PYTHON || "python",
    args: ["-m", "gpt_tui.desktop_api.server", "--port", String(port)],
    cwd: repoRoot(),
    shell: process.platform === "win32",
  };
}

async function startBackend() {
  const port = await findFreePort();
  backendUrl = `http://127.0.0.1:${port}`;
  const launch = resolveBackendLaunch(port);
  backendProcess = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    shell: launch.shell,
    env: {
      ...process.env,
      GPT_TUI_BACKEND_PORT: String(port),
    },
    stdio: "ignore",
  });
  backendProcess.on("exit", () => {
    backendProcess = null;
  });
  await waitForBackend(backendUrl);
}

function stopBackend() {
  if (!backendProcess) {
    return;
  }
  backendProcess.kill();
  backendProcess = null;
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
}

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

app.whenReady().then(async () => {
  await startBackend();
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
