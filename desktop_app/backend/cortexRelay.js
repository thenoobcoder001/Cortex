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

const http = require("node:http");

const CORTEX_WS_URL = "wss://cortex.cbproforge.com/cortex/ws/desktop";
const HEARTBEAT_MS  = 25_000;

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
    this.appVersion       = opts.appVersion   || "0.0.1";
    this.localBackendPort = opts.localBackendPort || 8765;
    this.onStateChange    = opts.onStateChange || (() => {});

    this._ws             = null;
    this._heartbeatTimer = null;
    this._state          = "disconnected";
    this.socketId        = null;
    this._pendingAborts  = new Set();
    this._connectResolve = null;
    this._connectReject  = null;
  }

  get state() { return this._state; }

  // ── public ──────────────────────────────────────────────────────────────

  connect() {
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

      const ws = new WS(CORTEX_WS_URL);
      this._ws = ws;
      this._setState("connecting");

      const authTimeout = setTimeout(() => {
        this._teardown();
        this._settle(null, new Error("Cortex relay auth timed out"));
      }, 15_000);

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
        }
      });

      ws.addEventListener("close", () => {
        clearTimeout(authTimeout);
        this._stopHeartbeat();
        this._setState("disconnected");
        this._ws = null;
        this._settle(null, new Error("WebSocket closed before auth"));
      });

      ws.addEventListener("error", () => {
        clearTimeout(authTimeout);
        this._stopHeartbeat();
        this._setState("disconnected");
        this._settle(null, new Error("WebSocket connection error"));
      });
    });
  }

  disconnect() { this._teardown(); }

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

  _relayTo(targetDeviceId, payload) {
    this._send({ type: "relay", target_device_id: targetDeviceId, payload });
  }

  // ── relay dispatcher ─────────────────────────────────────────────────────

  async _handleRelay(fromDeviceId, payload) {
    if (!payload || typeof payload !== "object") return;
    const { type, request_id } = payload;
    if (!request_id) return;

    if (type === "api_request") {
      if (payload.stream) {
        this._handleStream(fromDeviceId, payload);
      } else {
        await this._handleRequest(fromDeviceId, payload);
      }
    } else if (type === "api_abort") {
      this._pendingAborts.add(request_id);
    }
  }

  async _handleRequest(fromDeviceId, payload) {
    const { request_id, method, path: urlPath, query, body } = payload;
    try {
      const result = await this._callLocal(method || "GET", urlPath, query, body);
      this._relayTo(fromDeviceId, { type: "api_response", request_id, status: result.status, body: result.body });
    } catch (err) {
      this._relayTo(fromDeviceId, { type: "api_response", request_id, status: 500, body: { detail: String(err.message || err) } });
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
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = "";
        res.on("data", (c) => { errBody += c; });
        res.on("end", () => {
          this._relayTo(fromDeviceId, { type: "api_stream_error", request_id, message: `Backend ${res.statusCode}: ${errBody.slice(0, 200)}` });
        });
        return;
      }

      res.on("data", (chunk) => {
        if (this._pendingAborts.has(request_id)) return;
        this._relayTo(fromDeviceId, { type: "api_stream_chunk", request_id, data: chunk.toString("utf8") });
      });

      res.on("end", () => {
        this._pendingAborts.delete(request_id);
        this._relayTo(fromDeviceId, { type: "api_stream_end", request_id });
      });
    });

    req.on("error", (err) => {
      this._relayTo(fromDeviceId, { type: "api_stream_error", request_id, message: String(err.message || err) });
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  }

  _callLocal(method, urlPath, query, body) {
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
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

module.exports = { CortexRelayClient };
