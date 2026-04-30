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

// Origins allowed to make cross-origin requests (browser CORS).
// React Native fetch and the relay client send no Origin header — they are
// always allowed regardless of this list.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",  // Vite dev renderer
  "http://localhost:8081",  // React Native Metro
  "http://localhost:19006", // Expo web
]);

function corsOrigin(request) {
  const origin = request?.headers?.origin || "";
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function sendJson(response, statusCode, payload, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-PocketAI-Token",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(payload));
}

function sendError(response, error, origin, request) {
  // Expose real error details only to local callers (desktop UI / dev)
  const remote = request?.socket?.remoteAddress || "";
  const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const detail = isLocal ? String(error?.message || error) : "Request failed.";
  sendJson(response, 400, { detail }, origin);
}

// Returns true if the request is authorised to call the backend.
// - Loopback connections (desktop UI, relay client) are always allowed.
// - Network connections must supply the correct X-PocketAI-Token header.
function isAuthorized(request, cfg) {
  const remote = request.socket?.remoteAddress || "";
  const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (isLocal) return true;
  return request.headers["x-pocketai-token"] === cfg.mobileToken;
}

// Throws if repoRoot is not in the user's saved projects list.
function assertRepoRoot(repoRoot, service) {
  if (!repoRoot) return;
  const saved = service.config?.recentRepoRoots || [];
  const ok = saved.some((p) => path.resolve(p) === path.resolve(repoRoot));
  if (!ok) throw new Error("repoRoot not in allowed projects list");
}

function startBackendServer({ host = "127.0.0.1", port = 8765, service = null, terminalService = null } = {}) {
  const effectiveService = service || new DesktopSessionService();
  const effectiveTerminalService = terminalService || new TerminalService();
  const server = http.createServer(async (request, response) => {
    const _origin = corsOrigin(request);

    if (request.method === "OPTIONS") {
      const h = {
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-PocketAI-Token",
      };
      if (_origin) h["Access-Control-Allow-Origin"] = _origin;
      response.writeHead(204, h);
      response.end();
      return;
    }

    // Local helper so every route automatically gets the right CORS header
    const reply = (code, body) => sendJson(response, code, body, _origin);
    const fail  = (err)        => sendError(response, err, _origin, request);

    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        reply(200, { status: "ok" });
        return;
      }

      // Auth check — loopback always passes; network callers need the token
      const cfg = AppConfigStore.load();
      if (!isAuthorized(request, cfg)) {
        reply(401, { detail: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        reply(200, effectiveService.snapshot());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/chats") {
        reply(200, { chats: effectiveService.listChats(url.searchParams.get("repoRoot")) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/chats/messages") {
        reply(200, effectiveService.getChatMessages(
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
        // Guard against path traversal
        const filePath = url.searchParams.get("path") || "";
        const resolved = path.resolve(filePath);
        const root = path.resolve(effectiveService.repoRoot || "");
        if (root && !resolved.startsWith(root + path.sep) && resolved !== root) {
          reply(403, { detail: "Path outside project root." });
          return;
        }
        reply(200, effectiveService.readFile(filePath));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/workspace/git-status") {
        const repoRoot = url.searchParams.get("repoRoot") || effectiveService.repoRoot || "";
        reply(200, await gitChanges(repoRoot));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/android/avds") {
        exec("emulator -list-avds", { encoding: "utf8", timeout: 8000 }, (error, stdout) => {
          const avds = (stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          reply(200, { avds });
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/terminal") {
        reply(200, effectiveTerminalService.snapshot(url.searchParams.get("chatId") || ""));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/terminal/stream") {
        const chatId = url.searchParams.get("chatId") || "";
        const sseHeaders = {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        };
        if (_origin) sseHeaders["Access-Control-Allow-Origin"] = _origin;
        response.writeHead(200, sseHeaders);
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
        // Remote callers cannot change toolSafetyMode — strip it before passing on
        const { toolSafetyMode: _ignored, ...safeBody } = body;
        reply(200, effectiveService.updateConfig(safeBody));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/new") {
        assertRepoRoot(body.repoRoot || null, effectiveService);
        reply(200, effectiveService.newChat(body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/activate") {
        assertRepoRoot(body.repoRoot || null, effectiveService);
        reply(200, effectiveService.activateChat(body.chatId, body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/delete") {
        assertRepoRoot(body.repoRoot || null, effectiveService);
        reply(200, effectiveService.deleteChat(body.chatId, body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/rename") {
        assertRepoRoot(body.repoRoot || null, effectiveService);
        reply(200, effectiveService.renameChat(body.chatId, body.title, body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/interrupt") {
        reply(200, effectiveService.interruptChat(body.chatId || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/preferences") {
        assertRepoRoot(body.repoRoot || null, effectiveService);
        reply(200, effectiveService.updateChatPreferences({
          toolSafetyMode: body.toolSafetyMode,
          chatId: body.chatId || null,
          repoRoot: body.repoRoot || null,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cache/clear") {
        reply(200, effectiveService.clearLocalData(Array.isArray(body.repoRoots) ? body.repoRoots : []));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/config/delete") {
        reply(200, effectiveService.deleteSettingsFile());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/providers/test") {
        reply(200, await effectiveService.testProviderConnection(body));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/terminal/open") {
        reply(200, effectiveTerminalService.open({
          chatId: body.chatId,
          repoRoot: body.repoRoot || effectiveService.repoRoot,
          cols: body.cols,
          rows: body.rows,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/terminal/write") {
        reply(200, effectiveTerminalService.write({
          chatId: body.chatId,
          command: body.command,
          repoRoot: body.repoRoot || effectiveService.repoRoot,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/terminal/input") {
        reply(200, effectiveTerminalService.input({
          chatId: body.chatId,
          data: body.data,
          repoRoot: body.repoRoot || effectiveService.repoRoot,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/terminal/resize") {
        reply(200, effectiveTerminalService.resize({
          chatId: body.chatId,
          cols: body.cols,
          rows: body.rows,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/terminal/close") {
        reply(200, effectiveTerminalService.close(body.chatId));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chat/send") {
        assertRepoRoot(body.repoRoot || null, effectiveService);
        reply(200, await effectiveService.sendMessage(body.message, {
          chatId: body.chatId || null,
          repoRoot: body.repoRoot || null,
          model: body.model || null,
          promptPreset: body.promptPreset || null,
          toolSafetyMode: body.toolSafetyMode || null,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chat/send-stream") {
        assertRepoRoot(body.repoRoot || null, effectiveService);
        const streamHeaders = {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        };
        if (_origin) streamHeaders["Access-Control-Allow-Origin"] = _origin;
        response.writeHead(200, streamHeaders);
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
        if (!email || !password) { fail(new Error("email and password required")); return; }
        try {
          // Try register — relay server sends OTP email on success
          const regResult = await _cortexPost("/cortex/api/auth/register", { email, password });
          if (regResult.status === 200) {
            reply(200, { message: regResult.body?.message || `Verification code sent to ${email}` });
            return;
          }
          // Already registered — try login directly (no OTP needed)
          const loginResult = await _cortexPost("/cortex/api/auth/login", { email, password });
          if (loginResult.status !== 200) {
            reply(400, { detail: loginResult.body?.detail || "Invalid credentials" }); return;
          }
          const token = loginResult.body?.token;
          if (!token) { reply(400, { detail: "No token received from relay" }); return; }
          const result = await _relayConnect({ token, localBackendPort: port });
          const relayConfig = AppConfigStore.load();
          relayConfig.cortexToken = token; relayConfig.cortexDeviceId = result.deviceId; relayConfig.cortexReconnectSecret = result.reconnectSecret;
          relayConfig.save();
          reply(200, { connected: true, ...result });
        } catch (err) {
          reply(400, { detail: String(err.message || err) });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/cortex/verify") {
        const { email, code } = body;
        if (!email || !code) { fail(new Error("email and code required")); return; }
        try {
          // Verify OTP with relay server — returns {user_id, token}
          const verifyResult = await _cortexPost("/cortex/api/auth/verify-otp", { email, otp: code });
          if (verifyResult.status !== 200) {
            reply(400, { detail: verifyResult.body?.detail || "Verification failed" }); return;
          }
          const token = verifyResult.body?.token;
          if (!token) { reply(400, { detail: "No token received after verification" }); return; }
          const result = await _relayConnect({ token, localBackendPort: port });
          const verifyConfig = AppConfigStore.load();
          verifyConfig.cortexToken = token; verifyConfig.cortexDeviceId = result.deviceId; verifyConfig.cortexReconnectSecret = result.reconnectSecret;
          verifyConfig.save();
          reply(200, result);
        } catch (err) {
          reply(400, { detail: String(err.message || err) });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/cortex/status") {
        const statusConfig = AppConfigStore.load();
        reply(200, { ..._relayStatus(), hasSavedSession: Boolean(statusConfig.cortexToken), mobileToken: statusConfig.mobileToken });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cortex/reconnect") {
        const reconnectConfig = AppConfigStore.load();
        if (!reconnectConfig.cortexToken) { reply(400, { detail: "No saved session" }); return; }
        try {
          const result = await _relayConnect({ token: reconnectConfig.cortexToken, deviceId: reconnectConfig.cortexDeviceId, reconnectSecret: reconnectConfig.cortexReconnectSecret, localBackendPort: port });
          reconnectConfig.cortexReconnectSecret = result.reconnectSecret; reconnectConfig.save();
          reply(200, { connected: true, ...result });
        } catch (err) {
          reply(400, { detail: String(err.message || err) });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cortex/connect") {
        const { token, deviceId, reconnectSecret, localUrl, tailscaleUrl } = body;
        if (!token) { fail(new Error("token is required")); return; }
        try {
          const result = await _relayConnect({ token, deviceId, reconnectSecret, localUrl, tailscaleUrl, localBackendPort: port });
          reply(200, result);
        } catch (err) {
          reply(400, { detail: String(err.message || err) });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cortex/disconnect") {
        _relayDisconnect();
        const disconnectConfig = AppConfigStore.load();
        disconnectConfig.cortexToken = ""; disconnectConfig.cortexDeviceId = ""; disconnectConfig.cortexReconnectSecret = "";
        disconnectConfig.save();
        reply(200, { ok: true });
        return;
      }

      reply(404, { detail: "Not found" });
    } catch (error) {
      fail(error);
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
