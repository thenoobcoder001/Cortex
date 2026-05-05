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
const platform = require("./platform");

const chatRoutes     = require("./routes/chat");
const chatsRoutes    = require("./routes/chats");
const configRoutes   = require("./routes/config");
const terminalRoutes = require("./routes/terminal");
const cortexRoutes   = require("./routes/cortex");
const fileRoutes     = require("./routes/file");
const androidRoutes  = require("./routes/android");

// ── Audit log ─────────────────────────────────────────────────────────────
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;

function auditLogPath() {
  return path.join(platform.getAppDataDir(), "relay-audit.log");
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
  "/api/workspace/accept": 10,
  _default:                60,
};
const RATE_WINDOW_MS = 60_000;

function isLoopbackRemote(remote) {
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function rateLimitIdentity(request) {
  const relayDeviceId = String(request.headers["x-pocketai-relay-device"] || "").trim();
  if (relayDeviceId) return `relay:${relayDeviceId}`;
  const remote = request.socket?.remoteAddress || "local";
  if (isLoopbackRemote(remote)) return null;
  return `ip:${remote}`;
}

function checkRateLimit(request, pathname) {
  const identity = rateLimitIdentity(request);
  if (!identity) return null;
  const limit = RATE_LIMITS[pathname] ?? RATE_LIMITS._default;
  const key   = `${identity}::${pathname}`;
  const now   = Date.now();
  const entry = _rateCounts.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    _rateCounts.set(key, { count: 1, windowStart: now });
    return null;
  }
  entry.count += 1;
  if (entry.count <= limit) return null;
  const retryAfter = Math.max(1, Math.ceil((entry.windowStart + RATE_WINDOW_MS - now) / 1000));
  return { retryAfter };
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

function sendJson(response, statusCode, payload, origin, extraHeaders = null) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-PocketAI-Token",
    ...(extraHeaders || {}),
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(payload));
}

function sendError(response, error, origin, request) {
  const remote  = request?.socket?.remoteAddress || "";
  const isLocal = isLoopbackRemote(remote);
  const detail  = isLocal ? String(error?.message || error) : "Request failed.";
  sendJson(response, 400, { detail }, origin);
}

// ── Auth ──────────────────────────────────────────────────────────────────
function isAuthorized(request, cfg) {
  const remote  = request.socket?.remoteAddress || "";
  const isLocal = isLoopbackRemote(remote);
  if (isLocal) return true;
  return request.headers["x-pocketai-token"] === cfg.mobileToken;
}

function assertRepoRoot(repoRoot, service) {
  if (!repoRoot) return;
  const normalizeRepoRoot = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      return "";
    }
    const separatorsNormalized = platform.isWin
      ? trimmed.replaceAll("/", "\\")
      : trimmed.replaceAll("\\", "/");
    return path.resolve(separatorsNormalized);
  };
  const saved = service.config?.recentRepoRoots || [];
  const target = normalizeRepoRoot(repoRoot);
  const ok = saved.some((p) => normalizeRepoRoot(p) === target);
  if (!ok) throw new Error("repoRoot not in allowed projects list");
}

function clearStoredRelaySession(cfg = AppConfigStore.load()) {
  cfg.approvedDeviceIds = [];
  cfg.relaySessionExpiresAt = "";
  cfg.save();
  return cfg;
}

function normalizeStoredRelaySession(cfg = AppConfigStore.load()) {
  if (isRelaySessionExpired(cfg.relaySessionExpiresAt)) {
    return clearStoredRelaySession(cfg);
  }
  if (cfg.approvedDeviceIds.length && !cfg.relaySessionExpiresAt) {
    cfg.relaySessionExpiresAt = computeRelaySessionExpiresAt();
    cfg.save();
  }
  return cfg;
}

// ── Relay singleton ───────────────────────────────────────────────────────
let _relayClient       = null;
const _pendingPairing  = new Set();

const relay = {
  connect({ token, deviceId, reconnectSecret, localUrl, tailscaleUrl, localBackendPort }) {
    if (_relayClient) _relayClient.disconnect();
    const cfg = normalizeStoredRelaySession(AppConfigStore.load());
    _relayClient = new CortexRelayClient({
      token, deviceId, reconnectSecret, localUrl, tailscaleUrl, localBackendPort,
      deviceName:       "Cortex Desktop",
      appVersion:       require("../package.json").version,
      approvedDeviceIds: [...cfg.approvedDeviceIds],
      hmacSecret:       cfg.relayHmacSecret || null,
      sessionExpiresAt: cfg.relaySessionExpiresAt || "",
      onSessionExpired: () => { clearStoredRelaySession(AppConfigStore.load()); },
      onStateChange:    () => {},
      onPairingRequest: (id) => {
        console.log(`Cortex relay: pairing request from ${id}`);
        _pendingPairing.add(id);
      },
      onAuditLog:       (entry) => writeAuditLog(entry),
    });
    return _relayClient.connect();
  },
  disconnect() {
    if (_relayClient) { _relayClient.disconnect(); _relayClient = null; }
  },
  status() {
    const cfg = normalizeStoredRelaySession(AppConfigStore.load());
    if (!_relayClient) return { state: "not_configured", deviceId: null, socketId: null };
    // If the WebSocket is no longer open, report disconnected regardless of cached state.
    const state = _relayClient.isConnected() ? _relayClient.state : "disconnected";
    return {
      state,
      deviceId: _relayClient.deviceId,
      socketId: _relayClient.socketId,
      relaySessionExpiresAt: cfg.relaySessionExpiresAt || "",
    };
  },
  probe() {
    if (!_relayClient) {
      return Promise.reject(new Error("Cortex relay is not configured"));
    }
    return _relayClient.probeConnection();
  },
  pendingDevices() { return [..._pendingPairing]; },
  approveDevice(id, secrets) {
    _pendingPairing.delete(id);
    if (_relayClient) {
      _relayClient.approveDevice(id);
      if (secrets?.relaySessionExpiresAt) {
        _relayClient.setSessionExpiresAt(secrets.relaySessionExpiresAt);
      }
      if (secrets?.relayHmacSecret) {
        _relayClient.setHmacSecret(secrets.relayHmacSecret);
      }
      // Push auth secrets to the mobile device so it can start signing immediately
      _relayClient.sendToDevice(id, {
        type: "pairing_approved",
        mobileToken: secrets?.mobileToken || "",
        relayHmacSecret: secrets?.relayHmacSecret || "",
      });
    }
  },
  rejectDevice(id) {
    _pendingPairing.delete(id);
    if (_relayClient) _relayClient.rejectDevice(id);
  },
  removeDevice(id) {
    _pendingPairing.delete(id);
    if (_relayClient) _relayClient.removeDevice(id);
  },
  clearSession() {
    _pendingPairing.clear();
    if (_relayClient) {
      _relayClient.approvedDeviceIds = [];
      _relayClient.setSessionExpiresAt("");
    }
    clearStoredRelaySession(AppConfigStore.load());
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
  androidRoutes,
];

// ── Server ────────────────────────────────────────────────────────────────
function startBackendServer({ host = "127.0.0.1", port = 8765, service = null, terminalService = null } = {}) {
  const effectiveService         = service         || new DesktopSessionService();
  const effectiveTerminalService = terminalService || new TerminalService();

  const server = http.createServer(async (request, response) => {
    const origin  = corsOrigin(request);
    const remote  = request.socket?.remoteAddress || "";
    const isLocal = isLoopbackRemote(remote);

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
    const rateLimit = checkRateLimit(request, url.pathname);
    if (rateLimit) {
      sendJson(
        response,
        429,
        { detail: "Too many requests. Please slow down." },
        origin,
        { "Retry-After": String(rateLimit.retryAfter) },
      );
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
  relayProbe:      ()        => relay.probe(),
};
