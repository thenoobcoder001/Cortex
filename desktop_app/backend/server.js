"use strict";

const http = require("node:http");
const fs   = require("node:fs");
const os   = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

const { DesktopSessionService } = require("./sessionService");
const { TerminalService }       = require("./terminalService");
const { CortexRelayClient }     = require("./cortexRelay");
const { AppConfigStore }        = require("./configStore");

const chatRoutes     = require("./routes/chat");
const chatsRoutes    = require("./routes/chats");
const configRoutes   = require("./routes/config");
const terminalRoutes = require("./routes/terminal");
const cortexRoutes   = require("./routes/cortex");
const fileRoutes     = require("./routes/file");

// ── Audit log ─────────────────────────────────────────────────────────────
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;

function auditLogPath() {
  const dir = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "cortex")
    : path.join(os.homedir(), ".config", "cortex");
  return path.join(dir, "relay-audit.log");
}

function writeAuditLog(entry) {
  try {
    const logPath = auditLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > AUDIT_LOG_MAX_BYTES) fs.renameSync(logPath, `${logPath}.1`);
    } catch { /* file may not exist yet */ }
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch { /* never crash on audit failure */ }
}

// ── Rate limiter ──────────────────────────────────────────────────────────
const _rateCounts = new Map();
const RATE_LIMITS = {
  "/api/chat/send-stream": 30,
  "/api/chat/send":        30,
  "/api/config":           10,
  _default:                60,
};
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(request, pathname) {
  const remote = request.socket?.remoteAddress || "local";
  if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") return false;
  const limit = RATE_LIMITS[pathname] ?? RATE_LIMITS._default;
  const key   = `${remote}::${pathname}`;
  const now   = Date.now();
  const entry = _rateCounts.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    _rateCounts.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

// ── CORS ──────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8081",
  "http://localhost:19006",
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
  const remote  = request?.socket?.remoteAddress || "";
  const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const detail  = isLocal ? String(error?.message || error) : "Request failed.";
  sendJson(response, 400, { detail }, origin);
}

// ── Auth ──────────────────────────────────────────────────────────────────
function isAuthorized(request, cfg) {
  const remote  = request.socket?.remoteAddress || "";
  const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (isLocal) return true;
  return request.headers["x-pocketai-token"] === cfg.mobileToken;
}

function assertRepoRoot(repoRoot, service) {
  if (!repoRoot) return;
  const saved = service.config?.recentRepoRoots || [];
  const ok = saved.some((p) => path.resolve(p) === path.resolve(repoRoot));
  if (!ok) throw new Error("repoRoot not in allowed projects list");
}

// ── Relay singleton ───────────────────────────────────────────────────────
let _relayClient       = null;
const _pendingPairing  = new Set();

const relay = {
  connect({ token, deviceId, reconnectSecret, localUrl, tailscaleUrl, localBackendPort }) {
    if (_relayClient) _relayClient.disconnect();
    const cfg = AppConfigStore.load();
    _relayClient = new CortexRelayClient({
      token, deviceId, reconnectSecret, localUrl, tailscaleUrl, localBackendPort,
      deviceName:       "Cortex Desktop",
      appVersion:       "0.0.1",
      approvedDeviceIds: cfg.approvedDeviceIds.length > 0 ? [...cfg.approvedDeviceIds] : null,
      onStateChange:    () => {},
      onPairingRequest: (id) => _pendingPairing.add(id),
      onAuditLog:       (entry) => writeAuditLog(entry),
    });
    return _relayClient.connect();
  },
  disconnect() {
    if (_relayClient) { _relayClient.disconnect(); _relayClient = null; }
  },
  status() {
    if (!_relayClient) return { state: "not_configured", deviceId: null, socketId: null };
    return { state: _relayClient.state, deviceId: _relayClient.deviceId, socketId: _relayClient.socketId };
  },
  pendingDevices() { return [..._pendingPairing]; },
  approveDevice(id) {
    _pendingPairing.delete(id);
    if (_relayClient) _relayClient.approveDevice(id);
  },
  rejectDevice(id) {
    _pendingPairing.delete(id);
    if (_relayClient) _relayClient.rejectDevice(id);
  },
};

// ── Body parser ───────────────────────────────────────────────────────────
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

// ── Route handlers (in match order) ──────────────────────────────────────
const ROUTE_HANDLERS = [
  fileRoutes,
  configRoutes,
  chatsRoutes,
  chatRoutes,
  terminalRoutes,
  cortexRoutes,
];

// ── Server ────────────────────────────────────────────────────────────────
function startBackendServer({ host = "127.0.0.1", port = 8765, service = null, terminalService = null } = {}) {
  const effectiveService         = service         || new DesktopSessionService();
  const effectiveTerminalService = terminalService || new TerminalService();

  const server = http.createServer(async (request, response) => {
    const origin  = corsOrigin(request);
    const remote  = request.socket?.remoteAddress || "";
    const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";

    // Preflight
    if (request.method === "OPTIONS") {
      const h = {
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-PocketAI-Token",
      };
      if (origin) h["Access-Control-Allow-Origin"] = origin;
      response.writeHead(204, h);
      response.end();
      return;
    }

    const reply = (code, body) => sendJson(response, code, body, origin);
    const fail  = (err)        => sendError(response, err, origin, request);
    const url   = new URL(request.url, `http://${request.headers.host}`);

    try {
      // Health — no auth required
      if (request.method === "GET" && url.pathname === "/health") {
        reply(200, { status: "ok" });
        return;
      }

      // Auth
      const cfg = AppConfigStore.load();
      if (!isAuthorized(request, cfg)) {
        reply(401, { detail: "Unauthorized" });
        return;
      }

      // Rate limiting
      if (checkRateLimit(request, url.pathname)) {
        reply(429, { detail: "Too many requests. Please slow down." });
        return;
      }

      const body = request.method === "POST" ? await readJsonBody(request) : {};

      // Build shared context passed to every route handler
      const ctx = {
        method:          request.method,
        pathname:        url.pathname,
        url,
        body,
        request,
        response,
        origin,
        isLocal,
        reply,
        fail,
        service:         effectiveService,
        terminalService: effectiveTerminalService,
        relay,
        port,
        assertRepoRoot,
      };

      for (const handler of ROUTE_HANDLERS) {
        if (await handler.handle(ctx)) return;
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
        service:         effectiveService,
        terminalService: effectiveTerminalService,
        url:             `http://${host}:${port}`,
        close: () => new Promise((res, rej) => {
          effectiveTerminalService.closeAll();
          server.close((err) => err ? rej(err) : res());
        }),
      });
    });
  });
}

module.exports = {
  startBackendServer,
  relayConnect:    (...args) => relay.connect(...args),
  relayDisconnect: ()        => relay.disconnect(),
  relayStatus:     ()        => relay.status(),
};
