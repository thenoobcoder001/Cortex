"use strict";
const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const os     = require("node:os");
const path   = require("node:path");
const http   = require("node:http");
const crypto = require("node:crypto");

const { startBackendServer } = require("../server");
const { CortexRelayClient }  = require("../cortexRelay");
const { computeRelaySessionExpiresAt, isRelaySessionExpired } = require("../relaySession");

// ── helpers ───────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p2-test-"));
}

function req(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        ...headers,
      },
    };
    const r = http.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// Minimal in-memory service stub
class MemoryService {
  constructor(repoRoot = "") {
    this.repoRoot = repoRoot;
    this.config = {
      model: "claude-opus-4-5",
      toolSafetyMode: "write",
      promptPreset: "code",
      contextCarryMessages: 5,
      recentRepoRoots: repoRoot ? [repoRoot] : [],
    };
    this.toolReadOnly = false;
  }
  snapshot()        { return { activeChatId: "", chats: [] }; }
  listChats()       { return []; }
  updateConfig(u)   { Object.assign(this.config, u); }
  readFile(f)       { return { content: fs.readFileSync(f, "utf8") }; }
}

// ── P2-K: /api/file path traversal ────────────────────────────────────────

test("P2-K: /api/file returns 403 when no project is selected", async () => {
  const service = new MemoryService(""); // no repoRoot
  const { close } = await startBackendServer({ port: 0, host: "127.0.0.1", service });
  const port = close._port || (await new Promise((res) => {
    // port is embedded in returned server — extract via close wrapper trick
    res(close.__port);
  }));
  // We need the actual port — re-open to get it
  await close();

  // Use a fresh server and capture port correctly
  const instance = await startBackendServer({ port: 0, host: "127.0.0.1", service: new MemoryService("") });
  const actualPort = instance.server.address().port;
  try {
    const r = await req(actualPort, "GET", "/api/file?path=" + encodeURIComponent(os.homedir() + "/secret.txt"));
    assert.equal(r.status, 403);
    assert.ok(r.body.detail.includes("No project selected"), `Expected 'No project selected' in detail, got: ${r.body.detail}`);
  } finally {
    await instance.close();
  }
});

test("P2-K: /api/file returns 403 for path outside project root", async () => {
  const repoRoot = tmpDir();
  const service  = new MemoryService(repoRoot);
  const instance = await startBackendServer({ port: 0, host: "127.0.0.1", service });
  const port     = instance.server.address().port;
  try {
    const escapedPath = path.join(repoRoot, "..", "etc", "passwd");
    const r = await req(port, "GET", "/api/file?path=" + encodeURIComponent(escapedPath));
    assert.equal(r.status, 403);
    assert.ok(r.body.detail.includes("outside"), `Expected 'outside' in detail, got: ${r.body.detail}`);
  } finally {
    await instance.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("P2-K: /api/file returns 400 when path param is missing", async () => {
  const repoRoot = tmpDir();
  const service  = new MemoryService(repoRoot);
  const instance = await startBackendServer({ port: 0, host: "127.0.0.1", service });
  const port     = instance.server.address().port;
  try {
    const r = await req(port, "GET", "/api/file");
    assert.equal(r.status, 400);
  } finally {
    await instance.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("P2-K: /api/file serves file inside project root", async () => {
  const repoRoot = tmpDir();
  const testFile = path.join(repoRoot, "hello.txt");
  fs.writeFileSync(testFile, "hello world");
  const service  = new MemoryService(repoRoot);
  const instance = await startBackendServer({ port: 0, host: "127.0.0.1", service });
  const port     = instance.server.address().port;
  try {
    const r = await req(port, "GET", "/api/file?path=" + encodeURIComponent(testFile));
    assert.equal(r.status, 200);
  } finally {
    await instance.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── P2-I: HMAC relay signing ───────────────────────────────────────────────

test("P2-I: relay drops payload with invalid HMAC", async () => {
  const secret = crypto.randomBytes(32).toString("hex");
  let audited  = null;

  const client = new CortexRelayClient({
    token:            "test",
    hmacSecret:       secret,
    localBackendPort: 9999, // unused in this test
    onAuditLog:       (e) => { audited = e; },
  });

  // Inject a relay message with wrong HMAC directly
  const payload = {
    type:       "api_request",
    request_id: "req-1",
    method:     "GET",
    path:       "/api/status",
    ts:         Date.now(),
    hmac:       "deadbeef".repeat(8), // obviously wrong
  };

  // approvedDeviceIds = null (allow all devices) so pairing guard passes
  client.approvedDeviceIds = null;
  await client._handleRelay("mobile-1", payload);

  // Should have logged an hmac_rejected event, not a normal audit entry
  assert.ok(audited, "Expected onAuditLog to be called");
  assert.equal(audited.event, "hmac_rejected", `Expected hmac_rejected event, got: ${JSON.stringify(audited)}`);
});

test("P2-I: relay accepts payload with correct HMAC", async () => {
  const secret   = crypto.randomBytes(32).toString("hex");
  let processed  = false;

  // Start a tiny local server to catch the forwarded request
  const localServer = http.createServer((req, res) => {
    processed = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => localServer.listen(0, "127.0.0.1", r));
  const localPort = localServer.address().port;

  const ts         = Date.now();
  const request_id = "req-signed";
  const urlPath    = "/api/status";
  const hmac       = crypto.createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`${request_id}:${urlPath}:${ts}`)
    .digest("hex");

  const client = new CortexRelayClient({
    token:            "test",
    hmacSecret:       secret,
    localBackendPort: localPort,
  });
  client.approvedDeviceIds = null;

  // Stub _relayTo so it doesn't crash without a WS connection
  client._relayTo = () => {};

  const payload = { type: "api_request", request_id, method: "GET", path: urlPath, ts, hmac };
  await client._handleRelay("mobile-1", payload);

  // Give the local HTTP call time to complete
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(processed, "Expected request to reach local server when HMAC is valid");
  await new Promise((r) => localServer.close(r));
});

test("P2-I: relay accepts payload with no HMAC (backward compat)", async () => {
  const secret = crypto.randomBytes(32).toString("hex");
  let processed = false;

  const localServer = http.createServer((req, res) => {
    processed = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => localServer.listen(0, "127.0.0.1", r));
  const localPort = localServer.address().port;

  const client = new CortexRelayClient({
    token:            "test",
    hmacSecret:       secret, // secret configured but mobile hasn't upgraded yet
    localBackendPort: localPort,
  });
  client.approvedDeviceIds = null;
  client._relayTo = () => {};

  // No hmac field in payload — should still pass (transition period)
  const payload = { type: "api_request", request_id: "req-unsigned", method: "GET", path: "/api/status" };
  await client._handleRelay("mobile-1", payload);

  await new Promise((r) => setTimeout(r, 500));
  assert.ok(processed, "Expected unsigned request to pass when hmacSecret is set (backward compat)");
  await new Promise((r) => localServer.close(r));
});

test("P2-I: relay drops stale HMAC (replay attack)", async () => {
  const secret = crypto.randomBytes(32).toString("hex");
  let audited  = null;

  const client = new CortexRelayClient({
    token:      "test",
    hmacSecret: secret,
    onAuditLog: (e) => { audited = e; },
  });
  client.approvedDeviceIds = null;

  const ts         = Date.now() - 10 * 60 * 1000; // 10 min ago — stale
  const request_id = "req-old";
  const urlPath    = "/api/status";
  const hmac       = crypto.createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`${request_id}:${urlPath}:${ts}`)
    .digest("hex");

  await client._handleRelay("mobile-1", { type: "api_request", request_id, method: "GET", path: urlPath, ts, hmac });
  assert.ok(audited && audited.event === "hmac_rejected", "Expected hmac_rejected for stale timestamp");
});

// ── P2-J: Error body sanitization ─────────────────────────────────────────

test("P2-J: _sanitizeErrorBody strips stack traces and caps length", () => {
  const client = new CortexRelayClient({ token: "test" });

  const withStack = { detail: "Error: ENOENT\n    at Object.openSync (node:fs:585:3)\n    at Object.readFileSync..." };
  const result    = client._sanitizeErrorBody(withStack);
  assert.ok(!result.detail.includes("at Object."), "Expected stack trace to be stripped");
  assert.ok(result.detail.length <= 300, "Expected detail to be capped at 300 chars");

  // Long string
  const longDetail = { detail: "x".repeat(500) };
  const capped     = client._sanitizeErrorBody(longDetail);
  assert.ok(capped.detail.length <= 300, "Expected detail capped at 300 chars");

  // Unknown shape → safe fallback
  const unknown = client._sanitizeErrorBody(null);
  assert.equal(unknown.detail, "Request failed.");
});

// ── P2-L: Bounded pendingAborts (unbounded session leak) ──────────────────

test("P2-L: relay session helper defaults to a 24 hour window", () => {
  const expiresAt = computeRelaySessionExpiresAt(0);
  assert.equal(Date.parse(expiresAt), 24 * 60 * 60 * 1000, "expected default relay session window to be 24 hours");
  assert.equal(isRelaySessionExpired(expiresAt, 24 * 60 * 60 * 1000 - 1), false, "session should still be valid before expiry");
  assert.equal(isRelaySessionExpired(expiresAt, 24 * 60 * 60 * 1000), true, "session should expire at the deadline");
});

test("P2-L: expired relay session clears approvals and falls back to pairing", async () => {
  const pairingRequests = [];
  const auditEntries = [];
  let sessionExpiredCalls = 0;
  let processed = false;

  const client = new CortexRelayClient({
    token: "test",
    approvedDeviceIds: ["mobile-1"],
    sessionExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    onPairingRequest: (id) => pairingRequests.push(id),
    onAuditLog: (entry) => auditEntries.push(entry),
    onSessionExpired: () => { sessionExpiredCalls += 1; },
  });

  client._callLocal = async () => {
    processed = true;
    return { status: 200, body: { ok: true } };
  };
  client._relayTo = () => {};

  await client._handleRelay("mobile-1", {
    type: "api_request",
    request_id: "expired-req",
    method: "GET",
    path: "/api/status",
  });

  assert.equal(processed, false, "expired sessions must not reach the local backend");
  assert.equal(sessionExpiredCalls, 1, "expired session callback should fire once");
  assert.deepEqual(client.approvedDeviceIds, [], "approved relay devices must be cleared after expiry");
  assert.equal(client.sessionExpiresAt, "", "relay session expiry should be cleared after expiry handling");
  assert.deepEqual(pairingRequests, ["mobile-1"], "request should fall back to the pairing flow");
  assert.ok(auditEntries.some((entry) => entry.event === "session_expired"), "session expiry should be audit logged");
});

test("P2-L: _pendingAborts is cleared when it exceeds MAX_PENDING_ABORTS", async () => {
  const client = new CortexRelayClient({ token: "test" });
  client.approvedDeviceIds = null;
  client._relayTo = () => {}; // stub — no WS connection

  // Fill past the cap (500) by sending api_abort messages
  for (let i = 0; i < 510; i++) {
    await client._handleRelay("mobile-1", { type: "api_abort", request_id: `abort-${i}` });
  }

  // After clear the set should be small (the last batch after the reset)
  assert.ok(client._pendingAborts.size < 510, `Expected pendingAborts to be bounded, got ${client._pendingAborts.size}`);
});
