"use strict";
const test   = require("node:test");
const assert = require("node:assert/strict");

// Stub the Tailscale probe before the route module captures it, so the test
// never shells out to the real `tailscale` CLI.
const tailscalePath = require.resolve("../tailscale");
require.cache[tailscalePath] = {
  id: tailscalePath,
  filename: tailscalePath,
  loaded: true,
  exports: {
    getTailscaleInfo: async () => ({ available: true, cliAvailable: true, online: true, ip: "100.64.0.1", magicDNS: "pc.tail.ts.net" }),
    tailscaleUrl: (_info, port) => `http://100.64.0.1:${port}`,
  },
};

const { AppConfigStore } = require("../configStore");
const cortexRoutes    = require("../routes/cortex");
const tailscaleRoutes = require("../routes/tailscale");

const SECRET_TOKEN = "tok-0123456789abcdef";
const SECRET_HMAC  = "hmac-fedcba9876543210";

// Never touch the user's real config file.
function withFakeConfig(fn) {
  const originalLoad = AppConfigStore.load;
  const saves = [];
  AppConfigStore.load = () => ({
    mobileToken: SECRET_TOKEN,
    relayHmacSecret: SECRET_HMAC,
    cortexToken: "jwt",
    approvedDeviceIds: ["phone-1"],
    relaySessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    save() { saves.push(true); },
  });
  return Promise.resolve(fn(saves)).finally(() => { AppConfigStore.load = originalLoad; });
}

function makeCtx({ method = "GET", pathname, isLocal, body = {} }) {
  const out = { status: null, body: null };
  const relayCalls = [];
  const relay = new Proxy({}, {
    get: (_t, name) => () => {
      relayCalls.push(name);
      if (name === "status") return { state: "connected", deviceId: "desk", socketId: "s" };
      if (name === "pendingDevices") return [];
      return Promise.resolve({});
    },
  });
  const ctx = {
    method, pathname, body, isLocal, relay, port: 8765,
    reply: (status, payload) => { out.status = status; out.body = payload; },
    fail: (err) => { out.status = 400; out.body = { detail: String(err.message || err) }; },
  };
  return { ctx, out, relayCalls };
}

test("cortex status returns pairing secrets to the local desktop UI", () => withFakeConfig(async () => {
  const { ctx, out } = makeCtx({ pathname: "/api/cortex/status", isLocal: true });
  assert.equal(await cortexRoutes.handle(ctx), true);
  assert.equal(out.status, 200);
  assert.equal(out.body.mobileToken, SECRET_TOKEN);
  assert.equal(out.body.relayHmacSecret, SECRET_HMAC);
  assert.equal(out.body.state, "connected");
}));

test("cortex status hides pairing secrets from relay and network callers", () => withFakeConfig(async () => {
  for (const isLocal of [false, undefined]) {
    const { ctx, out } = makeCtx({ pathname: "/api/cortex/status", isLocal });
    assert.equal(await cortexRoutes.handle(ctx), true);
    assert.equal(out.status, 200);
    assert.equal(out.body.state, "connected");
    assert.equal("mobileToken" in out.body, false);
    assert.equal("relayHmacSecret" in out.body, false);
    assert.doesNotMatch(JSON.stringify(out.body), new RegExp(`${SECRET_TOKEN}|${SECRET_HMAC}`));
  }
}));

test("relay management routes are refused for non-local callers", () => withFakeConfig(async (saves) => {
  const routes = [
    ["POST", "/api/cortex/approve-device", { deviceId: "attacker" }],
    ["POST", "/api/cortex/reject-device", { deviceId: "x" }],
    ["POST", "/api/cortex/remove-device", { deviceId: "phone-1" }],
    ["POST", "/api/cortex/connect", { token: "t" }],
    ["POST", "/api/cortex/reconnect", {}],
    ["POST", "/api/cortex/disconnect", {}],
    ["POST", "/api/cortex/probe", {}],
    ["POST", "/api/cortex/send-verification", { email: "a@b.c", password: "p" }],
    ["POST", "/api/cortex/verify", { email: "a@b.c", code: "1" }],
    ["GET",  "/api/cortex/pairing-requests", {}],
  ];
  for (const [method, pathname, body] of routes) {
    const { ctx, out, relayCalls } = makeCtx({ method, pathname, body, isLocal: false });
    assert.equal(await cortexRoutes.handle(ctx), true, pathname);
    assert.equal(out.status, 403, pathname);
    assert.deepEqual(relayCalls, [], `${pathname} must not touch the relay`);
  }
  assert.equal(saves.length, 0, "config must not change");
}));

test("local desktop can still approve a device (pushes secrets via relay)", () => withFakeConfig(async () => {
  const { ctx, out, relayCalls } = makeCtx({ method: "POST", pathname: "/api/cortex/approve-device", body: { deviceId: "phone-2" }, isLocal: true });
  assert.equal(await cortexRoutes.handle(ctx), true);
  assert.equal(out.status, 200);
  assert.deepEqual(relayCalls, ["approveDevice"]);
}));

test("cortex routes ignore unrelated paths", async () => {
  const { ctx } = makeCtx({ pathname: "/api/config", isLocal: false });
  assert.equal(await cortexRoutes.handle(ctx), false);
});

test("tailscale pairUrl carries the token only for the local desktop UI", () => withFakeConfig(async () => {
  const local = makeCtx({ pathname: "/api/tailscale/status", isLocal: true });
  await tailscaleRoutes.handle(local.ctx);
  assert.equal(local.out.status, 200);
  assert.equal(local.out.body.pairUrl, `http://100.64.0.1:8765/?t=${SECRET_TOKEN}`);

  const remote = makeCtx({ pathname: "/api/tailscale/status", isLocal: false });
  await tailscaleRoutes.handle(remote.ctx);
  assert.equal(remote.out.status, 200);
  assert.equal(remote.out.body.url, "http://100.64.0.1:8765");
  assert.equal(remote.out.body.pairUrl, "http://100.64.0.1:8765");
  assert.doesNotMatch(JSON.stringify(remote.out.body), new RegExp(SECRET_TOKEN));
}));

// End-to-end through the real server: a relay-proxied request arrives on
// loopback but carries X-PocketAI-Relay-Device, so it must not be "local".
test("server treats relay-proxied loopback requests as non-local", () => withFakeConfig(async () => {
  const http = require("node:http");
  const { startBackendServer } = require("../server");
  const { server, close } = await startBackendServer({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  const get = (headers) => new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: "/api/cortex/pairing-requests", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
  try {
    assert.equal(await get({}), 200);
    assert.equal(await get({ "X-PocketAI-Relay-Device": "phone-1" }), 403);
  } finally {
    await close();
  }
}));

test("git-status only accepts saved projects from phones, and still runs git locally", async () => {
  const fileRoutes = require("../routes/file");
  const repo = require("node:path").resolve(__dirname, "..", "..", "..");
  const service = { repoRoot: "", config: { recentRepoRoots: [] } };
  const assertRepoRoot = () => { throw new Error("repoRoot not in allowed projects list"); };
  const url = new URL(`http://x/api/workspace/git-status?repoRoot=${encodeURIComponent(repo)}`);

  const remote = makeCtx({ pathname: "/api/workspace/git-status", isLocal: false });
  await assert.rejects(fileRoutes.handle({ ...remote.ctx, url, service, assertRepoRoot }), /allowed projects/);
  assert.equal(remote.out.status, null);

  const local = makeCtx({ pathname: "/api/workspace/git-status", isLocal: true });
  await fileRoutes.handle({ ...local.ctx, url, service, assertRepoRoot });
  assert.equal(local.out.status, 200);
  assert.equal(local.out.body.error, null, `git failed: ${local.out.body.error}`);
  assert.ok(Array.isArray(local.out.body.changes));
});
