"use strict";
/**
 * CortexRelayClient — desktop side of the Cortex relay.
 *
 * Connects to ws://103.180.236.74:8087/cortex/ws/desktop
 * Listens for relay messages from mobile, forwards them to the local
 * backend HTTP server, and relays the responses back.
 *
 * Relay payload protocol:
 *
 *   Mobile → Desktop (inside relay.payload):
 *     { type:"api_request", request_id, method, path, query, body, stream }
 *     { type:"api_abort",   request_id }
 *
 *   Desktop → Mobile (inside relay.payload):
 *     { type:"api_response",     request_id, status, body }        ← non-stream
 *     { type:"api_stream_chunk", request_id, data }                ← stream chunk
 *     { type:"api_stream_end",   request_id }                      ← stream done
 *     { type:"api_stream_error", request_id, message }             ← stream error
 */

const http   = require("node:http");
const crypto = require("node:crypto");

const CORTEX_WS_URL          = "wss://cortex.cbproforge.com/cortex/ws/desktop";
const CORTEX_WS_URL_FALLBACK = "ws://103.180.236.74:8087/cortex/ws/desktop";
const HEARTBEAT_MS           = 5_000;
const RELAY_HMAC_MAX_SKEW_MS  = 5 * 60 * 1000;
const RELAY_STREAM_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max per streaming request
const MAX_PENDING_ABORTS      = 500;            // cap Set to prevent unbounded growth

class CortexRelayClient {
  /**
   * @param {object}   opts
   * @param {string}   opts.token               JWT from /cortex/api/auth/login
   * @param {string}  [opts.deviceId]
   * @param {string}  [opts.deviceName]
   * @param {string}  [opts.reconnectSecret]
   * @param {string}  [opts.localUrl]           e.g. http://192.168.1.100:8765
   * @param {string}  [opts.tailscaleUrl]       e.g. http://100.69.155.85:8765
   * @param {string}  [opts.appVersion]
   * @param {number}  [opts.localBackendPort=8765]
   * @param {(s:string)=>void} [opts.onStateChange]
   */
  constructor(opts) {
    this.token            = opts.token;
    this.deviceId         = opts.deviceId     || `desktop-${Date.now().toString(36)}`;
    this.deviceName       = opts.deviceName   || "Cortex Desktop";
    this.reconnectSecret  = opts.reconnectSecret || null;
    this.localUrl         = opts.localUrl     || "";
    this.tailscaleUrl     = opts.tailscaleUrl || "";
    this.appVersion       = opts.appVersion   || "0.0.3";
    this.localBackendPort = opts.localBackendPort || 8765;
    this.onStateChange    = opts.onStateChange || (() => {});
    // Called with deviceId when an unknown device sends a relay message.
    this.onPairingRequest = opts.onPairingRequest || null;
    // Called with a log entry object for every inbound relay request.
    this.onAuditLog       = opts.onAuditLog   || null;
    // Set of device IDs approved to send commands. null = allow all (legacy).
    this.approvedDeviceIds = opts.approvedDeviceIds || null;
    // HMAC secret for relay message signing (P2-I). null = accept unsigned (backward compat).
    this.hmacSecret       = opts.hmacSecret   || null;
    // Time-bound relay approval window (P2-L).
    this.sessionExpiresAt = opts.sessionExpiresAt || "";
    this.onSessionExpired = opts.onSessionExpired || null;

    this._ws             = null;
    this._heartbeatTimer = null;
    this._state          = "disconnected";
    this.socketId        = null;
    this._pendingAborts  = new Set();
    this._probePending   = null;
    this._connectResolve = null;
    this._connectReject  = null;
  }

  get state() {
    return this._state;
  }

  // ── public ──────────────────────────────────────────────────────────────

  connect(useFallback = false) {
    return new Promise((resolve, reject) => {
      this._teardown();
      this._connectResolve = resolve;
      this._connectReject  = reject;

      const WS = globalThis.WebSocket;
      if (!WS) {
        const err = new Error("Native WebSocket unavailable (Node 21+ required)");
        this._settle(null, err);
        return;
      }

      const url = useFallback ? CORTEX_WS_URL_FALLBACK : CORTEX_WS_URL;
      console.log(`CortexRelayClient: connecting to ${url}${useFallback ? " (fallback)" : ""}...`);

      const ws = new WS(url);
      this._ws = ws;
      this._setState("connecting");

      const authTimeout = setTimeout(() => {
        this._teardown();
        this._settle(null, new Error(`Cortex relay auth timed out (${useFallback ? "fallback" : "primary"})`));
      }, 60_000);

      ws.addEventListener("open", () => {
        this._setState("authenticating");
        const msg = {
          type:          "auth",
          token:         this.token,
          device_id:     this.deviceId,
          name:          this.deviceName,
          platform:      "windows",
          local_url:     this.localUrl,
          tailscale_url: this.tailscaleUrl,
          app_version:   this.appVersion,
        };
        if (this.reconnectSecret) msg.reconnect_secret = this.reconnectSecret;
        this._send(msg);
      });

      ws.addEventListener("message", (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); } catch { return; }

        if (msg.type === "auth_ok") {
          clearTimeout(authTimeout);
          this.deviceId        = msg.device_id;
          this.reconnectSecret = msg.reconnect_secret;
          this.socketId        = msg.socket_id;
          this._setState("connected");
          this._startHeartbeat();
          this._settle({ deviceId: msg.device_id, reconnectSecret: msg.reconnect_secret, socketId: msg.socket_id }, null);

        } else if (msg.type === "auth_error") {
          clearTimeout(authTimeout);
          this._teardown();
          this._settle(null, new Error(msg.message || "Cortex auth rejected"));

        } else if (msg.type === "relay") {
          this._handleRelay(msg.from_device_id, msg.payload).catch(() => {});
        } else if (msg.type === "heartbeat_ack") {
          this._resolveProbe();
        }
      });

      ws.addEventListener("close", (ev) => {
        clearTimeout(authTimeout);
        const wasConnecting = this._state === "connecting" || this._state === "authenticating";
        this._stopHeartbeat();
        this._setState("disconnected");
        this._ws = null;
        if (wasConnecting && !useFallback) {
          console.warn(`CortexRelayClient: primary connection closed (code=${ev.code}), trying fallback...`);
          this.connect(true).then(resolve).catch(reject);
        } else {
          const suffix = useFallback ? " (fallback failed)" : "";
          this._settle(null, new Error(`WebSocket closed before auth (code=${ev.code})${suffix}`));
        }
      });

      ws.addEventListener("error", (err) => {
        console.warn("CortexRelayClient WebSocket error:", err);
        if (this.onAuditLog) {
          this.onAuditLog({ source: "relay", event: "relay_error", message: String(err?.message || "connection error"), fallback: useFallback });
        }
        clearTimeout(authTimeout);
        const wasConnecting = this._state === "connecting" || this._state === "authenticating";
        this._stopHeartbeat();
        this._setState("disconnected");
        if (wasConnecting && !useFallback) {
          console.warn("CortexRelayClient: primary connection error, trying fallback...");
          this.connect(true).then(resolve).catch(reject);
        } else {
          const suffix = useFallback ? " (fallback failed)" : "";
          this._settle(null, new Error(`WebSocket connection error${suffix}`));
        }
      });
    });
  }

  disconnect() {
    if (this.isConnected()) {
      try {
        this._send({ type: "terminate" });
      } catch { /* ignore */ }
    }
    this._teardown();
  }

  isConnected() {
    return this._ws !== null && this._ws.readyState === 1; // OPEN
  }

  // ── internals ────────────────────────────────────────────────────────────

  _settle(value, err) {
    const resolve = this._connectResolve;
    const reject  = this._connectReject;
    this._connectResolve = null;
    this._connectReject  = null;
    if (!resolve && !reject) return;
    if (err) reject && reject(err);
    else     resolve && resolve(value);
  }

  _setState(state) {
    this._state = state;
    this.onStateChange(state);
  }

  _teardown() {
    this._stopHeartbeat();
    this._rejectProbe(new Error("Cortex relay disconnected"));
    const ws = this._ws;
    this._ws = null;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) ws.close();
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => this._send({ type: "heartbeat" }), HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  _send(msg) {
    if (this.isConnected()) this._ws.send(JSON.stringify(msg));
  }

  _resolveProbe() {
    if (!this._probePending) return;
    const pending = this._probePending;
    this._probePending = null;
    clearTimeout(pending.timer);
    pending.resolve({
      ok: true,
      deviceId: this.deviceId,
      socketId: this.socketId,
      state: this._state,
    });
  }

  _rejectProbe(error) {
    if (!this._probePending) return;
    const pending = this._probePending;
    this._probePending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  probeConnection(timeoutMs = 15000) {
    if (!this.isConnected()) {
      return Promise.reject(new Error("Cortex relay is not connected"));
    }
    if (this._probePending) {
      console.warn("CortexRelayClient: probe already in flight, rejecting new request.");
      this._rejectProbe(new Error("Cortex relay probe already in flight"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._probePending = null;
        console.warn(`CortexRelayClient: probe timed out after ${timeoutMs}ms`);
        reject(new Error("Cortex relay probe timed out"));
      }, timeoutMs);
      this._probePending = { resolve, reject, timer };
      this._send({ type: "heartbeat" });
    });
  }

  _relayTo(targetDeviceId, payload) {
    if (this.onAuditLog) {
      this.onAuditLog({
        source: "relay",
        direction: "outbound",
        device_id: targetDeviceId,
        type: payload.type,
        request_id: payload.request_id,
        status: payload.status
      });
    }
    this._send({ type: "relay", target_device_id: targetDeviceId, payload });
  }

  // ── relay dispatcher ─────────────────────────────────────────────────────

  approveDevice(deviceId) {
    if (this.approvedDeviceIds && !this.approvedDeviceIds.includes(deviceId)) {
      this.approvedDeviceIds.push(deviceId);
    }
  }

  setHmacSecret(secret) {
    this.hmacSecret = secret || null;
  }

  setSessionExpiresAt(expiresAt) {
    this.sessionExpiresAt = String(expiresAt || "").trim();
  }

  rejectDevice(_deviceId) {
    // No-op — unapproved devices are already silently dropped
  }

  removeDevice(deviceId) {
    if (Array.isArray(this.approvedDeviceIds)) {
      this.approvedDeviceIds = this.approvedDeviceIds.filter(id => id !== deviceId);
    }
  }

  _relaySessionExpired() {
    if (!this.sessionExpiresAt) return false;
    const parsed = Date.parse(this.sessionExpiresAt);
    if (!Number.isFinite(parsed)) return true;
    return Date.now() >= parsed;
  }

  _expireRelaySession() {
    this.approvedDeviceIds = [];
    this.sessionExpiresAt = "";
    if (this.onSessionExpired) {
      this.onSessionExpired();
    }
  }

  // Push a message to a specific remote device through the relay.
  sendToDevice(deviceId, payload) {
    this._relayTo(deviceId, payload);
  }

  // P2-I: Verify HMAC signature on relay payload.
  // Returns false only when an HMAC is present and invalid (tampered).
  // Absent HMAC is allowed during the mobile→desktop rollout transition.
  _verifyRelayHmac(payload) {
    if (!this.hmacSecret || !payload.hmac) return true; // skip if not configured or unsigned
    const { hmac, request_id, path: urlPath = "", ts = 0 } = payload;
    // P2-I: Reject replayed relay payloads outside a short skew window.
    if (Math.abs(Date.now() - ts) > RELAY_HMAC_MAX_SKEW_MS) {
        if (this.onAuditLog) {
            this.onAuditLog({ source: "relay", event: "hmac_skew_error", ts_received: ts, ts_now: Date.now() });
        }
        return false;
    }
    // Decode the hex secret to binary so both sides use the same key bytes.
    // Mobile's hmacSha256() calls hexToBytes() on the secret; we must match that.
    const keyBuf = Buffer.from(this.hmacSecret, "hex");
    const expected = crypto
      .createHmac("sha256", keyBuf)
      .update(`${request_id}:${urlPath}:${ts}`)
      .digest("hex");
    
    const isValid = crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expected, "hex"));
    if (!isValid && this.onAuditLog) {
      this.onAuditLog({
        source: "relay",
        event: "hmac_mismatch_debug",
        path: urlPath,
        received: hmac,
        expected: expected,
        secret_used: this.hmacSecret ? (this.hmacSecret.slice(0, 4) + "...") : "null",
        ts: ts
      });
    }
    return isValid;
  }

  // P2-J: Return a sanitized error body safe to send to an untrusted remote caller.
  // Strips stack trace lines and caps the detail field at 300 chars.
  _sanitizeErrorBody(body) {
    if (body && typeof body === "object" && typeof body.detail === "string") {
      const clean = body.detail
        .replace(/\n\s+at\s+\S+.*/g, "")  // strip "    at Object.method ..." lines
        .trim();
      return { detail: clean.slice(0, 300) };
    }
    return { detail: "Request failed." };
  }

  async _handleRelay(fromDeviceId, payload) {
    if (!payload || typeof payload !== "object") return;
    const { type, request_id } = payload;
    if (!request_id) return;
    if (this._relaySessionExpired()) {
      if (this.onAuditLog) {
        this.onAuditLog({
          source: "relay",
          device_id: fromDeviceId,
          event: "session_expired",
          expired_at: this.sessionExpiresAt,
        });
      }
      this._expireRelaySession();
    }

    // Pairing guard — check if approved
    const isApproved = this.approvedDeviceIds === null
      || (Array.isArray(this.approvedDeviceIds) && this.approvedDeviceIds.includes(fromDeviceId));

    if (!isApproved) {
      if (this.onPairingRequest) {
        this.onPairingRequest(fromDeviceId);
      }
      return; // drop request until approved
    }

    // P2-I: HMAC signature verification — drop tampered messages
    if (!this._verifyRelayHmac(payload)) {
      if (this.onAuditLog) this.onAuditLog({ source: "relay", device_id: fromDeviceId, event: "hmac_rejected", path: payload.path || "" });
      return;
    }

    // Audit log — record metadata only, never log request bodies
    if (this.onAuditLog) {
      this.onAuditLog({
        source:    "relay",
        device_id: fromDeviceId,
        method:    payload.method || "POST",
        path:      payload.path   || "",
        stream:    Boolean(payload.stream),
      });
    }

    if (type === "api_request") {
      try {
        if (payload.stream) {
          this._handleStream(fromDeviceId, payload);
        } else {
          await this._handleRequest(fromDeviceId, payload);
        }
        if (this.onAuditLog) {
          this.onAuditLog({ source: "relay", event: "request_handled", request_id: payload.request_id });
        }
      } catch (err) {
        console.error(`CortexRelayClient: error handling relay request ${payload.request_id}:`, err);
        if (this.onAuditLog) {
          this.onAuditLog({ source: "relay", event: "request_failed", request_id: payload.request_id, error: err.message });
        }
      }
    } else if (type === "api_abort") {
      // P2-L: bound the abort set to prevent unbounded memory growth
      if (this._pendingAborts.size >= MAX_PENDING_ABORTS) this._pendingAborts.clear();
      this._pendingAborts.add(request_id);
    }
  }

  async _handleRequest(fromDeviceId, payload) {
    const { request_id, method, path: urlPath, query, body } = payload;
    try {
      const result = await this._callLocal(method || "GET", urlPath, query, body, fromDeviceId);
      // P2-J: strip stack traces — only forward sanitized detail on errors
      const safeBody = result.status >= 400 ? this._sanitizeErrorBody(result.body) : result.body;
      this._relayTo(fromDeviceId, { type: "api_response", request_id, status: result.status, body: safeBody });
    } catch (err) {
      this._relayTo(fromDeviceId, { type: "api_response", request_id, status: 500, body: { detail: "Request failed." } });
    }
  }

  _handleStream(fromDeviceId, payload) {
    const { request_id, method, path: urlPath, query, body } = payload;
    const fullPath = query ? `${urlPath}?${query}` : urlPath;
    const bodyStr  = body ? JSON.stringify(body) : null;

    const options = {
      hostname: "127.0.0.1",
      port: this.localBackendPort,
      path: fullPath,
      method: method || "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PocketAI-Relay-Device": fromDeviceId,
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };

    // P2-L: hard timeout — kill the stream if it runs longer than RELAY_STREAM_TIMEOUT_MS
    let timeoutHandle = null;
    const clearStreamTimeout = () => { if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; } };

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = "";
        res.on("data", (c) => { errBody += c; });
        res.on("end", () => {
          clearStreamTimeout();
          // P2-J: never forward raw backend error body to remote caller
          this._relayTo(fromDeviceId, { type: "api_stream_error", request_id, message: "Request failed." });
        });
        return;
      }

      timeoutHandle = setTimeout(() => {
        req.destroy();
        this._relayTo(fromDeviceId, { type: "api_stream_error", request_id, message: "Stream timed out." });
      }, RELAY_STREAM_TIMEOUT_MS);

      res.on("data", (chunk) => {
        if (this._pendingAborts.has(request_id)) return;
        this._relayTo(fromDeviceId, { type: "api_stream_chunk", request_id, data: chunk.toString("utf8") });
      });

      res.on("end", () => {
        clearStreamTimeout();
        this._pendingAborts.delete(request_id);
        this._relayTo(fromDeviceId, { type: "api_stream_end", request_id });
      });

      res.on("error", () => {
        clearStreamTimeout();
        this._relayTo(fromDeviceId, { type: "api_stream_error", request_id, message: "Stream error." });
      });
    });

    req.on("error", () => {
      clearTimeout(timeoutHandle);
      this._relayTo(fromDeviceId, { type: "api_stream_error", request_id, message: "Request failed." });
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  }

  _callLocal(method, urlPath, query, body, relayDeviceId = "") {
    console.log(`CortexRelayClient: proxying ${method} ${urlPath} to localhost:${this.localBackendPort}`);
    return new Promise((resolve, reject) => {
      const fullPath = query ? `${urlPath}?${query}` : urlPath;
      const bodyStr  = body ? JSON.stringify(body) : null;
      const options  = {
        hostname: "127.0.0.1",
        port: this.localBackendPort,
        path: fullPath,
        method: method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(relayDeviceId ? { "X-PocketAI-Relay-Device": relayDeviceId } : {}),
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          console.log(`CortexRelayClient: localhost responded with ${res.statusCode}`);
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.setTimeout(60_000, () => {
        req.destroy();
        reject(new Error("Localhost request timed out after 60s"));
      });
      req.on("error", (err) => {
        console.error(`CortexRelayClient: localhost request error: ${err.message}`);
        reject(err);
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

module.exports = { CortexRelayClient };
