"use strict";

const https = require("node:https");
const { AppConfigStore } = require("../configStore");

const CORTEX_HOST = "cortex.cbproforge.com";

function cortexPost(path, bodyObj) {
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

async function handle(ctx) {
  const { method, pathname, body, reply, fail, relay, port } = ctx;

  if (method === "POST" && pathname === "/api/cortex/send-verification") {
    const { email, password } = body;
    if (!email || !password) { fail(new Error("email and password required")); return true; }
    try {
      const regResult = await cortexPost("/cortex/api/auth/register", { email, password });
      if (regResult.status === 200) {
        reply(200, { message: regResult.body?.message || `Verification code sent to ${email}` });
        return true;
      }
      const loginResult = await cortexPost("/cortex/api/auth/login", { email, password });
      if (loginResult.status !== 200) {
        reply(400, { detail: loginResult.body?.detail || "Invalid credentials" });
        return true;
      }
      const token = loginResult.body?.token;
      if (!token) { reply(400, { detail: "No token received from relay" }); return true; }
      const result = await relay.connect({ token, localBackendPort: port });
      const cfg = AppConfigStore.load();
      cfg.cortexToken = token; cfg.cortexDeviceId = result.deviceId; cfg.cortexReconnectSecret = result.reconnectSecret;
      cfg.save();
      reply(200, { connected: true, ...result });
    } catch (err) {
      reply(400, { detail: String(err.message || err) });
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/cortex/verify") {
    const { email, code } = body;
    if (!email || !code) { fail(new Error("email and code required")); return true; }
    try {
      const verifyResult = await cortexPost("/cortex/api/auth/verify-otp", { email, otp: code });
      if (verifyResult.status !== 200) {
        reply(400, { detail: verifyResult.body?.detail || "Verification failed" });
        return true;
      }
      const token = verifyResult.body?.token;
      if (!token) { reply(400, { detail: "No token received after verification" }); return true; }
      const result = await relay.connect({ token, localBackendPort: port });
      const cfg = AppConfigStore.load();
      cfg.cortexToken = token; cfg.cortexDeviceId = result.deviceId; cfg.cortexReconnectSecret = result.reconnectSecret;
      cfg.save();
      reply(200, result);
    } catch (err) {
      reply(400, { detail: String(err.message || err) });
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/cortex/status") {
    const cfg = AppConfigStore.load();
    reply(200, { ...relay.status(), hasSavedSession: Boolean(cfg.cortexToken), mobileToken: cfg.mobileToken, relayHmacSecret: cfg.relayHmacSecret });
    return true;
  }

  if (method === "POST" && pathname === "/api/cortex/reconnect") {
    const cfg = AppConfigStore.load();
    if (!cfg.cortexToken) { reply(400, { detail: "No saved session" }); return true; }
    try {
      const result = await relay.connect({ token: cfg.cortexToken, deviceId: cfg.cortexDeviceId, reconnectSecret: cfg.cortexReconnectSecret, localBackendPort: port });
      cfg.cortexReconnectSecret = result.reconnectSecret; cfg.save();
      reply(200, { connected: true, ...result });
    } catch (err) {
      reply(400, { detail: String(err.message || err) });
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/cortex/probe") {
    try {
      const result = await relay.probe();
      reply(200, { verified: true, lastProbeAt: new Date().toISOString(), probe: result, state: "connected", deviceId: result.deviceId });
    } catch (err) {
      reply(400, { detail: String(err.message || err) });
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/cortex/connect") {
    const { token, deviceId, reconnectSecret, localUrl, tailscaleUrl } = body;
    if (!token) { fail(new Error("token is required")); return true; }
    try {
      const result = await relay.connect({ token, deviceId, reconnectSecret, localUrl, tailscaleUrl, localBackendPort: port });
      reply(200, result);
    } catch (err) {
      reply(400, { detail: String(err.message || err) });
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/cortex/pairing-requests") {
    const cfg = AppConfigStore.load();
    reply(200, { pending: relay.pendingDevices(), approved: cfg.approvedDeviceIds });
    return true;
  }

  if (method === "POST" && pathname === "/api/cortex/approve-device") {
    const { deviceId } = body;
    if (!deviceId) { fail(new Error("deviceId required")); return true; }
    const cfg = AppConfigStore.load();
    if (!cfg.approvedDeviceIds.includes(deviceId)) {
      cfg.approvedDeviceIds.push(deviceId);
      cfg.save();
    }
    // approveDevice pushes mobileToken + relayHmacSecret to the device via relay
    relay.approveDevice(deviceId, { mobileToken: cfg.mobileToken, relayHmacSecret: cfg.relayHmacSecret });
    reply(200, { ok: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/cortex/reject-device") {
    const { deviceId } = body;
    if (!deviceId) { fail(new Error("deviceId required")); return true; }
    relay.rejectDevice(deviceId);
    reply(200, { ok: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/cortex/remove-device") {
    const { deviceId } = body;
    if (!deviceId) { fail(new Error("deviceId required")); return true; }
    const cfg = AppConfigStore.load();
    cfg.approvedDeviceIds = cfg.approvedDeviceIds.filter(id => id !== deviceId);
    cfg.save();
    relay.removeDevice(deviceId);
    reply(200, { ok: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/cortex/disconnect") {
    relay.disconnect();
    const cfg = AppConfigStore.load();
    cfg.cortexToken = ""; cfg.cortexDeviceId = ""; cfg.cortexReconnectSecret = "";
    cfg.approvedDeviceIds = [];
    cfg.save();
    reply(200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handle };
