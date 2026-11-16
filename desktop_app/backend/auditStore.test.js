const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AuditStore } = require("./auditStore");

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-audit-"));
}

test("record() appends a hash-chained entry and list() returns newest-first", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);

  store.record({ action: "create", path: "a.txt", provider: "codex", chatId: "c1" });
  store.record({ action: "edit", path: "a.txt", provider: "codex", chatId: "c1" });

  const entries = store.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, "edit"); // newest first
  assert.equal(entries[1].action, "create");
  assert.equal(entries[1].prev_hash, "0".repeat(64));
  assert.equal(entries[0].prev_hash, entries[1].hash);
});

test("verify() detects a tampered entry", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);
  store.record({ action: "create", path: "a.txt" });
  store.record({ action: "edit", path: "a.txt" });

  assert.equal(store.verify().ok, true);

  const logPath = path.join(repoRoot, ".cortex", "audit", "audit.jsonl");
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[0]);
  tampered.path = "b.txt"; // mutate without recomputing hash
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

  const fresh = new AuditStore(repoRoot);
  const result = fresh.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAtSeq, 0);
});

test("recordChanges() writes one entry per change with shared meta", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);
  store.recordChanges(
    [
      { action: "create", path: "a.txt" },
      { action: "delete", path: "b.txt" },
    ],
    { provider: "claude", model: "claude:sonnet", chatId: "c9" },
  );
  const entries = store.list();
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.provider === "claude" && e.chat_id === "c9"));
});

test("list() filters by action and provider", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);
  store.record({ action: "run_command", command: "npm test", provider: "groq" });
  store.record({ action: "edit", path: "a.txt", provider: "codex" });

  assert.equal(store.list({ action: "edit" }).length, 1);
  assert.equal(store.list({ provider: "groq" }).length, 1);
  assert.equal(store.list({ action: "delete" }).length, 0);
});

test("exportJsonl() returns the original append-only records", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);
  store.record({ action: "create", path: "a.txt" });
  store.record({ action: "run_command", command: "npm test" });

  const lines = store.exportJsonl().trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((entry) => entry.action), ["create", "run_command"]);
  assert.equal(lines[1].prev_hash, lines[0].hash);
});

test("rotation archives an oversized log and the chain still verifies", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);
  store.record({ action: "create", path: "a.txt" });

  // Force rotation on next record by shrinking MAX_BYTES via a huge existing file.
  const logPath = path.join(repoRoot, ".cortex", "audit", "audit.jsonl");
  fs.appendFileSync(logPath, "x".repeat(11 * 1024 * 1024));

  store.record({ action: "edit", path: "a.txt" });

  assert.ok(fs.existsSync(`${logPath}.1`));
  const fresh = new AuditStore(repoRoot);
  assert.equal(fresh.verify().ok, true);
});

function auditFiles(repoRoot) {
  return fs.readdirSync(path.join(repoRoot, ".cortex", "audit")).filter((name) => name.startsWith("audit.jsonl")).sort();
}

test("repeated rotations keep every archive and one continuous chain", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot, { maxBytes: 2000 });
  const total = 60;
  for (let index = 0; index < total; index += 1) {
    store.record({ action: "run_command", command: `step ${index}` });
  }

  const files = auditFiles(repoRoot);
  assert.ok(files.length >= 5, `expected several archives, got ${files.join(", ")}`);
  assert.ok(files.includes("audit.jsonl.1") && files.includes("audit.jsonl.2") && files.includes("audit.jsonl.3"));

  // The very first entry is still on disk and the export is the full history.
  const exported = store.exportJsonl().trim().split("\n").map(JSON.parse);
  assert.equal(exported.length, total);
  assert.equal(exported[0].command, "step 0");
  assert.deepEqual(exported.map((e) => e.seq), exported.map((_, index) => index));
  for (let index = 1; index < exported.length; index += 1) {
    assert.equal(exported[index].prev_hash, exported[index - 1].hash);
  }

  // list() reaches back into archives, newest first.
  const listed = store.list({ limit: total });
  assert.equal(listed.length, total);
  assert.equal(listed[0].command, `step ${total - 1}`);
  assert.equal(listed[total - 1].command, "step 0");
  assert.equal(store.list({ limit: 3 }).length, 3);

  const result = new AuditStore(repoRoot).verify();
  assert.equal(result.ok, true);
  assert.equal(result.entries, total);
  assert.equal(result.segments, files.length);
});

test("verify() catches tampering inside an archive and a deleted archive", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot, { maxBytes: 1500 });
  for (let index = 0; index < 40; index += 1) store.record({ action: "edit", path: `f${index}.txt` });
  assert.equal(store.verify().ok, true);

  const dir = path.join(repoRoot, ".cortex", "audit");
  const archive = path.join(dir, "audit.jsonl.2");
  const original = fs.readFileSync(archive, "utf8");
  const lines = original.trim().split("\n");
  const tampered = JSON.parse(lines[0]);
  tampered.path = "innocent.txt";
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(archive, `${lines.join("\n")}\n`, "utf8");
  const broken = store.verify();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAtSeq, tampered.seq);

  fs.writeFileSync(archive, original, "utf8");
  assert.equal(store.verify().ok, true);

  // Removing the oldest archive leaves the next one pointing at a missing parent.
  const firstOfSecond = JSON.parse(fs.readFileSync(archive, "utf8").split("\n")[0]);
  fs.unlinkSync(path.join(dir, "audit.jsonl.1"));
  fs.unlinkSync(archive);
  const gap = store.verify();
  assert.equal(gap.ok, false);
  assert.ok(gap.brokenAtSeq > firstOfSecond.seq);
});

test("logs rotated by older versions (chain restarted at genesis) still verify", () => {
  const repoRoot = tempRepo();
  const dir = path.join(repoRoot, ".cortex", "audit");
  const legacy = new AuditStore(repoRoot);
  legacy.record({ action: "create", path: "old.txt" });
  legacy.record({ action: "edit", path: "old.txt" });
  fs.renameSync(path.join(dir, "audit.jsonl"), path.join(dir, "audit.jsonl.1"));
  // Old rotation started the next file from scratch at seq 0 / genesis.
  const restarted = new AuditStore(tempRepo());
  restarted.record({ action: "delete", path: "old.txt" });
  fs.copyFileSync(restarted.logPath, path.join(dir, "audit.jsonl"));

  const store = new AuditStore(repoRoot, { maxBytes: 10 });
  assert.equal(store.verify().ok, true);
  store.record({ action: "create", path: "new.txt" }); // rotates the restarted file to .2
  assert.deepEqual(auditFiles(repoRoot), ["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"]);
  assert.equal(store.verify().ok, true);
  assert.equal(store.list({ limit: 10 }).length, 4);
});

async function runWriters(repoRoot, writers, perWriter, options = {}) {
  const { spawn } = require("node:child_process");
  const storePath = path.join(__dirname, "auditStore.js");
  const script = `
    const { AuditStore } = require(${JSON.stringify(storePath)});
    const store = new AuditStore(${JSON.stringify(repoRoot)}, ${JSON.stringify(options)});
    for (let i = 0; i < ${perWriter}; i += 1) {
      store.record({ action: "run_command", command: "w" + process.argv[1] + "-" + i });
    }
  `;
  await Promise.all(Array.from({ length: writers }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, String(index)], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
  })));
}

test("separate processes rotating one log never lose or fork entries", async () => {
  const repoRoot = tempRepo();
  await runWriters(repoRoot, 4, 30, { maxBytes: 3000 });
  const store = new AuditStore(repoRoot);
  const history = store.exportJsonl().trim().split("\n").map(JSON.parse);
  assert.equal(history.length, 120);
  assert.deepEqual(history.map((e) => e.seq), history.map((_, index) => index));
  assert.ok(auditFiles(repoRoot).length > 3);
  assert.equal(store.verify().ok, true);
});

test("separate processes appending to one log keep a single valid chain", async () => {
  const repoRoot = tempRepo();
  const writers = 6;
  const perWriter = 40;
  await runWriters(repoRoot, writers, perWriter);

  const store = new AuditStore(repoRoot);
  const entries = store.list({ limit: 100000 }).reverse();
  assert.equal(entries.length, writers * perWriter);
  assert.deepEqual(entries.map((e) => e.seq), entries.map((_, index) => index));
  assert.deepEqual(store.verify(), { ok: true, brokenAtSeq: null, segments: 1, entries: writers * perWriter });
  assert.equal(fs.existsSync(path.join(repoRoot, ".cortex", "audit", "audit.jsonl.lock")), false);
});

test("a second store instance continues the chain another instance wrote", () => {
  const repoRoot = tempRepo();
  const first = new AuditStore(repoRoot);
  const second = new AuditStore(repoRoot);
  first.record({ action: "create", path: "a.txt" });
  second.record({ action: "edit", path: "a.txt" });
  first.record({ action: "delete", path: "a.txt" });

  const entries = first.list().reverse();
  assert.deepEqual(entries.map((e) => e.seq), [0, 1, 2]);
  assert.equal(first.verify().ok, true);
});

test("a lock left by a crashed writer is recovered", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot);
  store.record({ action: "create", path: "a.txt" });
  const lockPath = path.join(repoRoot, ".cortex", "audit", "audit.jsonl.lock");

  // Owner on this host whose pid is gone.
  fs.writeFileSync(lockPath, JSON.stringify({ token: "dead", host: os.hostname(), pid: 2 ** 30, ts: Date.now() }));
  assert.ok(store.record({ action: "edit", path: "a.txt" }));
  assert.equal(fs.existsSync(lockPath), false);

  // Owner on another machine: only age can prove it stale.
  fs.writeFileSync(lockPath, JSON.stringify({ token: "remote", host: "other-host", pid: 1234, ts: Date.now() }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  assert.ok(store.record({ action: "delete", path: "a.txt" }));
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(store.list().length, 3);
  assert.equal(store.verify().ok, true);
});

test("a fresh lock held by another machine is waited on, then broken once stale", () => {
  const repoRoot = tempRepo();
  const store = new AuditStore(repoRoot, { lockStaleMs: 300 });
  fs.mkdirSync(path.join(repoRoot, ".cortex", "audit"), { recursive: true });
  const lockPath = path.join(repoRoot, ".cortex", "audit", "audit.jsonl.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ token: "remote", host: "other-host", pid: 1234, ts: Date.now() }));

  const started = Date.now();
  assert.ok(store.record({ action: "create", path: "a.txt" }));
  assert.ok(Date.now() - started >= 250, "should wait for the lock to go stale");
  assert.equal(fs.existsSync(lockPath), false);
});
