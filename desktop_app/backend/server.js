const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");
const { URL } = require("node:url");
const { DesktopSessionService } = require("./sessionService");
const { TerminalService } = require("./terminalService");
const { CortexRelayClient } = require("./cortexRelay");
const { AppConfigStore } = require("./configStore");

// ── Cortex relay server helpers ───────────────────────────────────────────────
const CORTEX_HOST = "cortex.cbproforge.com";

function _cortexPost(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(bodyObj);
    const req = https.request({
      hostname: CORTEX_HOST,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
    }, (r) => {
      let data = "";
      r.on("data", (c) => { data += c; });
      r.on("end", () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error("Invalid JSON from Cortex relay")); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// ── module-level relay singleton ──────────────────────────────────────────
let _relay = null;

function _relayStatus() {
  if (!_relay) return { state: "not_configured", deviceId: null, socketId: null };
  return { state: _relay.state, deviceId: _relay.deviceId, socketId: _relay.socketId };
}

async function _relayConnect({ token, deviceId, reconnectSecret, localUrl, tailscaleUrl, localBackendPort }) {
  if (_relay) _relay.disconnect();
  _relay = new CortexRelayClient({
    token, deviceId, reconnectSecret, localUrl, tailscaleUrl, localBackendPort,
    deviceName: "Cortex Desktop",
    appVersion: "0.0.1",
    onStateChange: (s) => { /* could emit events here */ },
  });
  const result = await _relay.connect();
  return result;
}

function _relayDisconnect() {
  if (_relay) { _relay.disconnect(); _relay = null; }
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    // -c safe.directory=* bypasses the dubious-ownership check that fires when
    // files were created by a different OS user (e.g. the Codex sandbox account).
    exec(`git -c safe.directory=* ${args}`, { cwd, encoding: "utf8", timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message || String(error)));
      } else {
        resolve(stdout || "");
      }
    });
  });
}

function parseDiffByFile(diffText) {
  const files = {};
  if (!diffText) return files;
  const chunks = diffText.split(/^(?=diff --git )/m).filter(Boolean);
  for (const chunk of chunks) {
    const match = chunk.match(/^diff --git a\/.+ b\/(.+)\n/);
    if (match) files[match[1]] = chunk.trimEnd();
  }
  return files;
}

async function gitChanges(repoRoot) {
  if (!repoRoot) return { changes: [], error: "No repo root provided" };
  try {
    // -uall lists every individual untracked file (not just directories)
    let statusOut;
    try {
      statusOut = await runGit("status --porcelain=v1 -uall", repoRoot);
    } catch (gitError) {
      return { changes: [], error: `git status failed: ${gitError.message}` };
    }
    if (!statusOut.trim()) return { changes: [], error: null };

    const [diffTracked, diffStaged] = await Promise.all([
      runGit("diff HEAD", repoRoot).catch(() => ""),
      runGit("diff --cached", repoRoot).catch(() => ""),
    ]);
    // Merge both diffs; prefer the HEAD diff when both exist for a file
    const diffByFile = { ...parseDiffByFile(diffStaged), ...parseDiffByFile(diffTracked) };
    const changes = [];
    for (const line of statusOut.split("\n").filter(Boolean)) {
      const xy = line.slice(0, 2);
      const rest = line.slice(3).trim();
      let filePath = rest;
      let oldPath = null;
      let newPath = null;
      if ((xy[0] === "R" || xy[1] === "R") && rest.includes(" -> ")) {
        [oldPath, newPath] = rest.split(" -> ").map((s) => s.trim());
        filePath = newPath;
      }
      let action = "edit";
      if (xy[0] === "?" && xy[1] === "?") action = "add";
      else if (xy[0] === "D" || xy[1] === "D") action = "delete";
      else if (xy[0] === "A" || xy[1] === "A") action = "add";
      else if (xy[0] === "R" || xy[1] === "R") action = "rename";
      let diff = diffByFile[filePath] || (oldPath ? diffByFile[oldPath] : "") || "";
      // For untracked files git diff won't have them — read content directly
      if (!diff) {
        try {
          const fullPath = path.join(repoRoot, filePath);
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            const content = fs.readFileSync(fullPath, "utf8");
            diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${content.split("\n").length} @@\n` +
              content.split("\n").map((l) => `+${l}`).join("\n");
          }
        } catch { diff = ""; }
      }
      changes.push({ action, path: filePath, diff, oldPath: oldPath || undefined, newPath: newPath || undefined });
    }
    return { changes, error: null };
  } catch (err) {
    return { changes: [], error: String(err.message || err) };
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  sendJson(response, 400, { detail: String(error?.message || error) });
}

function startBackendServer({ host = "127.0.0.1", port = 8765, service = null, terminalService = null } = {}) {
  const effectiveService = service || new DesktopSessionService();
  const effectiveTerminalService = terminalService || new TerminalService();
  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJson(response, 200, effectiveService.snapshot());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/chats") {
        sendJson(response, 200, { chats: effectiveService.listChats(url.searchParams.get("repoRoot")) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/chats/messages") {
        sendJson(response, 200, effectiveService.getChatMessages(
          url.searchParams.get("chatId") || "",
          url.searchParams.get("repoRoot"),
          {
            before: url.searchParams.get("before"),
            limit: url.searchParams.get("limit"),
          },
        ));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/file") {
        sendJson(response, 200, effectiveService.readFile(url.searchParams.get("path") || ""));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/workspace/git-status") {
        const repoRoot = url.searchParams.get("repoRoot") || effectiveService.repoRoot || "";
        sendJson(response, 200, await gitChanges(repoRoot));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/android/avds") {
        exec("emulator -list-avds", { encoding: "utf8", timeout: 8000 }, (error, stdout) => {
          const avds = (stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          sendJson(response, 200, { avds });
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/terminal") {
        sendJson(response, 200, effectiveTerminalService.snapshot(url.searchParams.get("chatId") || ""));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/terminal/stream") {
        const chatId = url.searchParams.get("chatId") || "";
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        // Send full history first
        const snap = effectiveTerminalService.snapshot(chatId);
        if (snap.history) {
          response.write(`data: ${JSON.stringify({ type: "history", data: snap.history })}\n\n`);
        }
        const onData = (data) => {
          response.write(`data: ${JSON.stringify({ type: "data", data })}\n\n`);
        };
        effectiveTerminalService.on(`data:${chatId}`, onData);
        request.on("close", () => {
          effectiveTerminalService.off(`data:${chatId}`, onData);
        });
        return;
      }

      const body = request.method === "POST" ? await readJsonBody(request) : {};

      if (request.method === "POST" && url.pathname === "/api/config") {
        sendJson(response, 200, effectiveService.updateConfig(body));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/new") {
        sendJson(response, 200, effectiveService.newChat(body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/activate") {
        sendJson(response, 200, effectiveService.activateChat(body.chatId, body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/delete") {
        sendJson(response, 200, effectiveService.deleteChat(body.chatId, body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/rename") {
        sendJson(response, 200, effectiveService.renameChat(body.chatId, body.title, body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/interrupt") {
        sendJson(response, 200, effectiveService.interruptChat(body.chatId || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/preferences") {
        sendJson(response, 200, effectiveService.updateChatPreferences({
          toolSafetyMode: body.toolSafetyMode,
          chatId: body.chatId || null,
          repoRoot: body.repoRoot || null,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cache/clear") {
        sendJson(response, 200, effectiveService.clearLocalData(Array.isArray(body.repoRoots) ? body.repoRoots : []));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/config/delete") {
        sendJson(response, 200, effectiveService.deleteSettingsFile());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/providers/test") {
        sendJson(response, 200, await effectiveService.testProviderConnection(body));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/terminal/open") {
        sendJson(response, 200, effectiveTerminalService.open({
          chatId: body.chatId,
          repoRoot: body.repoRoot || effectiveService.repoRoot,
          cols: body.cols,
          rows: body.rows,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/terminal/write") {
        sendJson(response, 200, effectiveTerminalService.write({
          chatId: body.chatId,
          command: body.command,
          repoRoot: body.repoRoot || effectiveService.repoRoot,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/terminal/input") {
        sendJson(response, 200, effectiveTerminalService.input({
          chatId: body.chatId,
          data: body.data,
          repoRoot: body.repoRoot || effectiveService.repoRoot,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/terminal/resize") {
        sendJson(response, 200, effectiveTerminalService.resize({
          chatId: body.chatId,
          cols: body.cols,
          rows: body.rows,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/terminal/close") {
        sendJson(response, 200, effectiveTerminalService.close(body.chatId));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chat/send") {
        sendJson(
          response,
          200,
          await effectiveService.sendMessage(body.message, {
            chatId: body.chatId || null,
            repoRoot: body.repoRoot || null,
            model: body.model || null,
            promptPreset: body.promptPreset || null,
            toolSafetyMode: body.toolSafetyMode || null,
          }),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chat/send-stream") {
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        try {
          for await (const event of effectiveService.sendMessageEvents(body.message, {
            chatId: body.chatId || null,
            repoRoot: body.repoRoot || null,
            model: body.model || null,
            promptPreset: body.promptPreset || null,
            toolSafetyMode: body.toolSafetyMode || null,
          })) {
            response.write(`${JSON.stringify(event)}\n`);
          }
        } catch (error) {
          response.write(`${JSON.stringify({ type: "error", message: String(error?.message || error) })}\n`);
        }
        response.end();
        return;
      }

      // ── Cortex relay management ────────────────────────────────────────
      if (request.method === "POST" && url.pathname === "/api/cortex/send-verification") {
        const { email, password } = body;
        if (!email || !password) { sendError(response, new Error("email and password required")); return; }
        try {
          // Try register — relay server sends OTP email on success
          const regResult = await _cortexPost("/cortex/api/auth/register", { email, password });
          if (regResult.status === 200) {
            sendJson(response, 200, { message: regResult.body?.message || `Verification code sent to ${email}` });
            return;
          }
          // Already registered — try login directly (no OTP needed)
          const loginResult = await _cortexPost("/cortex/api/auth/login", { email, password });
          if (loginResult.status !== 200) {
            sendJson(response, 400, { detail: loginResult.body?.detail || "Invalid credentials" }); return;
          }
          const token = loginResult.body?.token;
          if (!token) { sendJson(response, 400, { detail: "No token received from relay" }); return; }
          const result = await _relayConnect({ token, localBackendPort: port });
          const cfg = AppConfigStore.load();
          cfg.cortexToken = token; cfg.cortexDeviceId = result.deviceId; cfg.cortexReconnectSecret = result.reconnectSecret;
          cfg.save();
          sendJson(response, 200, { connected: true, ...result });
        } catch (err) {
          sendJson(response, 400, { detail: String(err.message || err) });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/cortex/verify") {
        const { email, code } = body;
        if (!email || !code) { sendError(response, new Error("email and code required")); return; }
        try {
          // Verify OTP with relay server — returns {user_id, token}
          const verifyResult = await _cortexPost("/cortex/api/auth/verify-otp", { email, otp: code });
          if (verifyResult.status !== 200) {
            sendJson(response, 400, { detail: verifyResult.body?.detail || "Verification failed" }); return;
          }
          const token = verifyResult.body?.token;
          if (!token) { sendJson(response, 400, { detail: "No token received after verification" }); return; }
          const result = await _relayConnect({ token, localBackendPort: port });
          const cfg = AppConfigStore.load();
          cfg.cortexToken = token; cfg.cortexDeviceId = result.deviceId; cfg.cortexReconnectSecret = result.reconnectSecret;
          cfg.save();
          sendJson(response, 200, result);
        } catch (err) {
          sendJson(response, 400, { detail: String(err.message || err) });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/cortex/status") {
        const cfg = AppConfigStore.load();
        sendJson(response, 200, { ..._relayStatus(), hasSavedSession: Boolean(cfg.cortexToken) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cortex/reconnect") {
        const cfg = AppConfigStore.load();
        if (!cfg.cortexToken) { sendJson(response, 400, { detail: "No saved session" }); return; }
        try {
          const result = await _relayConnect({ token: cfg.cortexToken, deviceId: cfg.cortexDeviceId, reconnectSecret: cfg.cortexReconnectSecret, localBackendPort: port });
          cfg.cortexReconnectSecret = result.reconnectSecret; cfg.save();
          sendJson(response, 200, { connected: true, ...result });
        } catch (err) {
          sendJson(response, 400, { detail: String(err.message || err) });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cortex/connect") {
        const { token, deviceId, reconnectSecret, localUrl, tailscaleUrl } = body;
        if (!token) { sendError(response, new Error("token is required")); return; }
        try {
          const result = await _relayConnect({ token, deviceId, reconnectSecret, localUrl, tailscaleUrl, localBackendPort: port });
          sendJson(response, 200, result);
        } catch (err) {
          sendJson(response, 400, { detail: String(err.message || err) });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cortex/disconnect") {
        _relayDisconnect();
        const cfg = AppConfigStore.load();
        cfg.cortexToken = ""; cfg.cortexDeviceId = ""; cfg.cortexReconnectSecret = "";
        cfg.save();
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { detail: "Not found" });
    } catch (error) {
      sendError(response, error);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve({
        server,
        service: effectiveService,
        terminalService: effectiveTerminalService,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            effectiveTerminalService.closeAll();
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}

module.exports = {
  startBackendServer,
  relayConnect: _relayConnect,
  relayDisconnect: _relayDisconnect,
  relayStatus: _relayStatus,
};
