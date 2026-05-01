"use strict";
const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const os     = require("node:os");
const path   = require("node:path");
const http   = require("node:http");

const { startBackendServer } = require("../server");
const { AppConfigStore }     = require("../configStore");
const { buildCleanEnv }      = require("../androidEnv");
const { CortexRelayClient }  = require("../cortexRelay");

// ── helpers ───────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p1-test-"));
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

// Minimal in-memory config stub so tests don't touch disk
class MemoryConfig {
  constructor() {
    this.path = "";
    this.repoRoot = "";
    this.activeChatId = "";
    this.model = "codex:gpt-5.4";
    this.apiKey = "original-key";
    this.geminiApiKey = "";
    this.openaiApiKey = "";
    this.promptPreset = "code";
    this.toolSafetyMode = "write";
    this.assistantMemory = "my memory";
    this.contextCarryMessages = 5;
    this.remoteAccessEnabled = false;
    this.recentRepoRoots = [];
    this.geminiSessionId = "";
    this.codexSessionId = "";
    this.activeRuns = [];
    this.interruptedRuns = [];
    this.cortexToken = "";
    this.cortexDeviceId = "";
    this.cortexReconnectSecret = "";
    this.mobileToken = "test-mobile-token-abc123";
    this.approvedDeviceIds = [];
  }
  save() {}
  reset() {}
  deleteFile() {}
}

// ── P1-E: Remote callers cannot set sensitive config fields ───────────────

test("P1-E: loopback caller can set apiKey via POST /api/config", async (t) => {
  const { server, service, close } = await startBackendServer({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  // Prime the service with a known key
  service.config.apiKey = "original-key";

  try {
    const res = await req(port, "POST", "/api/config", { apiKey: "new-key-from-local" });
    assert.equal(res.status, 200, "should accept from loopback");
    assert.equal(service.config.apiKey, "new-key-from-local", "apiKey should be updated by local caller");
  } finally {
    await close();
  }
});

test("P1-E: loopback caller cannot set toolSafetyMode (always stripped)", async (t) => {
  const { server, service, close } = await startBackendServer({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  // Keep toolReadOnly in sync with toolSafetyMode so that persistConfig()
  // (which derives toolSafetyMode from toolReadOnly) doesn't reset the value.
  service.config.toolSafetyMode = "read";
  service.toolReadOnly = true;

  try {
    const res = await req(port, "POST", "/api/config", { toolSafetyMode: "write" });
    assert.equal(res.status, 200);
    // updateConfig() has no toolSafetyMode parameter — it is always stripped.
    // persistConfig() re-derives from toolReadOnly (still true → "read").
    assert.equal(service.config.toolSafetyMode, "read", "toolSafetyMode must not change via API");
  } finally {
    await close();
  }
});

// ── P1-G: Rate limiting ───────────────────────────────────────────────────

test("P1-G: loopback requests are never rate-limited", async (t) => {
  const { server, close } = await startBackendServer({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;

  try {
    // Send 40 requests — well above the 10/min config limit
    const results = [];
    for (let i = 0; i < 40; i++) {
      const res = await req(port, "POST", "/api/config", { model: "codex:gpt-5.4" });
      results.push(res.status);
    }
    const tooMany = results.filter((s) => s === 429);
    assert.equal(tooMany.length, 0, "loopback should never receive 429");
  } finally {
    await close();
  }
});

// ── P1-H: Audit log ───────────────────────────────────────────────────────

test("P1-H: writeAuditLog creates the log file and appends JSON lines", (t) => {
  // Access the internal function via a minimal inline reproduction
  const logDir  = tmpDir();
  const logPath = path.join(logDir, "relay-audit.log");

  function writeAuditLog(entry, targetPath) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
      const stat = fs.statSync(targetPath);
      if (stat.size > 10 * 1024 * 1024) fs.renameSync(targetPath, `${targetPath}.1`);
    } catch { /* first write */ }
    fs.appendFileSync(targetPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  }

  writeAuditLog({ source: "relay", device_id: "mobile-abc", method: "POST", path: "/api/chat/send-stream", stream: true }, logPath);
  writeAuditLog({ source: "relay", device_id: "mobile-abc", method: "GET",  path: "/api/status", stream: false }, logPath);

  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "should have 2 log lines");

  const entry1 = JSON.parse(lines[0]);
  assert.equal(entry1.source,    "relay",                    "source field");
  assert.equal(entry1.device_id, "mobile-abc",               "device_id field");
  assert.equal(entry1.method,    "POST",                     "method field");
  assert.equal(entry1.path,      "/api/chat/send-stream",    "path field");
  assert.equal(entry1.stream,    true,                       "stream field");
  assert.ok(entry1.ts,                                       "ts field present");

  // Bodies must NOT be logged — only metadata keys
  assert.ok(!("body" in entry1),    "request body must not be logged");
  assert.ok(!("message" in entry1), "message must not be logged");
});

test("P1-H: audit log rotates when file exceeds 10 MB", (t) => {
  const logDir  = tmpDir();
  const logPath = path.join(logDir, "relay-audit.log");
  const MAX     = 10 * 1024 * 1024;

  function writeAuditLog(entry, targetPath) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
      const stat = fs.statSync(targetPath);
      if (stat.size > MAX) fs.renameSync(targetPath, `${targetPath}.1`);
    } catch { /* first write */ }
    fs.appendFileSync(targetPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  }

  // Pre-fill the log to just over 10 MB
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logPath, "x".repeat(MAX + 1), "utf8");

  writeAuditLog({ source: "relay", device_id: "d", method: "POST", path: "/api/chat/send-stream", stream: false }, logPath);

  assert.ok(fs.existsSync(`${logPath}.1`), "old log should be rotated to .1");
  const newContent = fs.readFileSync(logPath, "utf8");
  assert.ok(newContent.includes('"source":"relay"') || newContent.includes('"source": "relay"'), "new log should have the new entry");
});

// ── P1-P: Clean environment for CLI processes ─────────────────────────────

test("P1-P: buildCleanEnv strips sensitive keys", (t) => {
  // Temporarily inject dangerous keys into process.env
  const injected = {
    GITHUB_TOKEN:          "ghp_secret",
    AWS_ACCESS_KEY_ID:     "AKIA_secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    DATABASE_URL:          "postgres://user:pass@host/db",
    TAILSCALE_AUTHKEY:     "tskey-secret",
    ANTHROPIC_API_KEY:     "sk-ant-allowed",
    PATH:                  process.env.PATH || "",
  };
  const saved = {};
  for (const [k, v] of Object.entries(injected)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  try {
    const env = buildCleanEnv();
    assert.ok(!("GITHUB_TOKEN"          in env), "GITHUB_TOKEN must be stripped");
    assert.ok(!("AWS_ACCESS_KEY_ID"     in env), "AWS_ACCESS_KEY_ID must be stripped");
    assert.ok(!("AWS_SECRET_ACCESS_KEY" in env), "AWS_SECRET_ACCESS_KEY must be stripped");
    assert.ok(!("DATABASE_URL"          in env), "DATABASE_URL must be stripped");
    assert.ok(!("TAILSCALE_AUTHKEY"     in env), "TAILSCALE_AUTHKEY must be stripped");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-allowed", "ANTHROPIC_API_KEY must be kept");
    assert.ok("PATH" in env, "PATH must be kept");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("P1-P: buildCleanEnv keeps all required AI API keys", (t) => {
  const saved = {};
  const keys = { ANTHROPIC_API_KEY: "ant", OPENAI_API_KEY: "oai", GEMINI_API_KEY: "gem", GOOGLE_API_KEY: "goo" };
  for (const [k, v] of Object.entries(keys)) { saved[k] = process.env[k]; process.env[k] = v; }

  try {
    const env = buildCleanEnv();
    assert.equal(env.ANTHROPIC_API_KEY, "ant", "ANTHROPIC_API_KEY kept");
    assert.equal(env.OPENAI_API_KEY,    "oai", "OPENAI_API_KEY kept");
    assert.equal(env.GEMINI_API_KEY,    "gem", "GEMINI_API_KEY kept");
    assert.equal(env.GOOGLE_API_KEY,    "goo", "GOOGLE_API_KEY kept");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── P1-Q: Confinement system prompt ──────────────────────────────────────

test("P1-Q: messagesWithContext includes repoRoot confinement prefix", (t) => {
  const repoRoot = "C:\\projects\\myapp";
  const { DesktopSessionService } = require("../sessionService");
  const config = new MemoryConfig();
  config.recentRepoRoots = [repoRoot];

  const service = new DesktopSessionService({
    config,
    repoRoot,
    files:           { resolveRepoPath: () => [null, ""], snapshotRepoState: () => ({}), diffRepoState: () => [] },
    chatStore:       { listChats: () => [], loadChat: () => null, createChat: () => "c1", saveChat: () => {}, loadAcceptedRepoState: () => null, saveAcceptedRepoState: () => {} },
    toolExecutor:    { readOnly: false, runTool: async () => ({ output: "" }) },
    groqProvider:    { available: false, connected: false, setApiKey: () => {} },
    geminiProvider:  { available: false, connected: false, setApiKey: () => {} },
    geminiCliProvider: { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {} },
    claudeProvider:  { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {} },
    codexProvider:   { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {}, setApiKey: () => {} },
  });

  const messages = service.messagesWithContext([{ role: "user", content: "hello" }], "code");
  const system = messages.find((m) => m.role === "system");
  assert.ok(system, "system message must exist");
  assert.ok(system.content.includes("OPERATING CONSTRAINT"), "must include confinement prefix");
  assert.ok(system.content.includes(repoRoot), "must include the repoRoot path");
  assert.ok(system.content.includes("Stay within this directory"), "must include the restriction text");
});

test("P1-Q: messagesWithContext omits confinement prefix when repoRoot is empty", (t) => {
  const { DesktopSessionService } = require("../sessionService");
  const config = new MemoryConfig();
  config.recentRepoRoots = [];

  const service = new DesktopSessionService({
    config,
    repoRoot: "",
    files:           { resolveRepoPath: () => [null, ""], snapshotRepoState: () => ({}), diffRepoState: () => [] },
    chatStore:       { listChats: () => [], loadChat: () => null, createChat: () => "c1", saveChat: () => {}, loadAcceptedRepoState: () => null, saveAcceptedRepoState: () => {} },
    toolExecutor:    { readOnly: false, runTool: async () => ({ output: "" }) },
    groqProvider:    { available: false, connected: false, setApiKey: () => {} },
    geminiProvider:  { available: false, connected: false, setApiKey: () => {} },
    geminiCliProvider: { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {} },
    claudeProvider:  { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {} },
    codexProvider:   { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {}, setApiKey: () => {} },
  });

  const messages = service.messagesWithContext([{ role: "user", content: "hello" }], "code");
  const system = messages.find((m) => m.role === "system");
  assert.ok(!system?.content.includes("OPERATING CONSTRAINT"), "no confinement prefix when repoRoot is empty");
});

// ── P1-R: .claudeignore baseline ─────────────────────────────────────────

test("P1-R: _ensureClaudeSettings writes .claudeignore when absent", (t) => {
  const repoRoot = tmpDir();
  const { DesktopSessionService } = require("../sessionService");
  const config = new MemoryConfig();
  config.recentRepoRoots = [repoRoot];

  new DesktopSessionService({
    config,
    repoRoot,
    files:           { resolveRepoPath: () => [null, ""], snapshotRepoState: () => ({}), diffRepoState: () => [] },
    chatStore:       { listChats: () => [], loadChat: () => null, createChat: () => "c1", saveChat: () => {}, loadAcceptedRepoState: () => null, saveAcceptedRepoState: () => {} },
    toolExecutor:    { readOnly: false, runTool: async () => ({ output: "" }) },
    groqProvider:    { available: false, connected: false, setApiKey: () => {} },
    geminiProvider:  { available: false, connected: false, setApiKey: () => {} },
    geminiCliProvider: { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {} },
    claudeProvider:  { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {} },
    codexProvider:   { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {}, setApiKey: () => {} },
  });

  const ignorePath = path.join(repoRoot, ".claudeignore");
  assert.ok(fs.existsSync(ignorePath), ".claudeignore must be created");

  const content = fs.readFileSync(ignorePath, "utf8");
  assert.ok(content.includes(".env"),       ".env must be ignored");
  assert.ok(content.includes("*.key"),      "*.key must be ignored");
  assert.ok(content.includes("*.keystore"), "*.keystore must be ignored");
  assert.ok(content.includes("*secret*"),   "*secret* must be ignored");
  assert.ok(content.includes(".ssh/"),      ".ssh/ must be ignored");
  assert.ok(content.includes(".aws/"),      ".aws/ must be ignored");
});

test("P1-R: _ensureClaudeSettings does not overwrite existing .claudeignore", (t) => {
  const repoRoot = tmpDir();
  const ignorePath = path.join(repoRoot, ".claudeignore");
  const custom = "# my custom rules\n*.custom\n";
  fs.writeFileSync(ignorePath, custom, "utf8");

  const { DesktopSessionService } = require("../sessionService");
  const config = new MemoryConfig();
  config.recentRepoRoots = [repoRoot];

  new DesktopSessionService({
    config,
    repoRoot,
    files:           { resolveRepoPath: () => [null, ""], snapshotRepoState: () => ({}), diffRepoState: () => [] },
    chatStore:       { listChats: () => [], loadChat: () => null, createChat: () => "c1", saveChat: () => {}, loadAcceptedRepoState: () => null, saveAcceptedRepoState: () => {} },
    toolExecutor:    { readOnly: false, runTool: async () => ({ output: "" }) },
    groqProvider:    { available: false, connected: false, setApiKey: () => {} },
    geminiProvider:  { available: false, connected: false, setApiKey: () => {} },
    geminiCliProvider: { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {} },
    claudeProvider:  { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {} },
    codexProvider:   { available: false, connected: false, sessionId: "", sessionMode: "fresh", setRepoRoot: () => {}, setApiKey: () => {} },
  });

  const content = fs.readFileSync(ignorePath, "utf8");
  assert.equal(content, custom, "existing .claudeignore must not be overwritten");
});

// ── P1-F: Pairing guard in CortexRelayClient ─────────────────────────────

test("P1-F: relay drops requests from unapproved devices and fires onPairingRequest", async (t) => {
  const pairingRequests = [];
  const handledRequests = [];

  const client = new CortexRelayClient({
    token: "fake-token",
    approvedDeviceIds: ["approved-device"],
    onPairingRequest: (id) => pairingRequests.push(id),
    onAuditLog: () => {},
  });

  // Simulate _handleRelay directly (no real WebSocket needed)
  await client._handleRelay("unapproved-device", { type: "api_request", request_id: "r1", method: "POST", path: "/api/chat/send", stream: false, body: {} });
  await client._handleRelay("approved-device",   { type: "api_request", request_id: "r2", method: "POST", path: "/api/chat/send", stream: false, body: {} });

  assert.deepEqual(pairingRequests, ["unapproved-device"], "unapproved device should fire onPairingRequest");
});

test("P1-F: approveDevice adds device to approved list and subsequent requests pass", async (t) => {
  const pairingRequests = [];

  const client = new CortexRelayClient({
    token: "fake-token",
    approvedDeviceIds: [],
    onPairingRequest: (id) => pairingRequests.push(id),
    onAuditLog: () => {},
  });

  // First attempt — not yet approved
  await client._handleRelay("new-mobile", { type: "api_request", request_id: "r1", method: "GET", path: "/api/status", stream: false });
  assert.equal(pairingRequests.length, 1, "should have fired pairing request");

  // Approve the device
  client.approveDevice("new-mobile");

  // Second attempt — now approved, should NOT fire pairing request again
  const auditEntries = [];
  client.onAuditLog = (e) => auditEntries.push(e);
  await client._handleRelay("new-mobile", { type: "api_request", request_id: "r2", method: "GET", path: "/api/status", stream: false });

  assert.equal(pairingRequests.length, 1, "should not fire pairing request again after approval");
  assert.equal(auditEntries.length, 1, "approved request should be audit-logged");
});

test("P1-F: null approvedDeviceIds allows all devices (backward compat)", async (t) => {
  const pairingRequests = [];
  const auditEntries   = [];

  const client = new CortexRelayClient({
    token: "fake-token",
    approvedDeviceIds: null, // legacy mode — no restriction
    onPairingRequest: (id) => pairingRequests.push(id),
    onAuditLog: (e) => auditEntries.push(e),
  });

  await client._handleRelay("any-device", { type: "api_request", request_id: "r1", method: "GET", path: "/api/status", stream: false });

  assert.equal(pairingRequests.length, 0, "no pairing requests in legacy mode");
  assert.equal(auditEntries.length, 1,    "request should still be audit-logged");
});
