"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const GENESIS_HASH = "0".repeat(64);
const MAX_BYTES = 10 * 1024 * 1024;

// Cross-process write lock. Several Cortex installs (or the desktop app plus
// a standalone backend) can point at the same repo, e.g. on a network share,
// so the read-tail-then-append sequence has to be serialised across
// processes, not just inside one event loop. An exclusive-create ("wx")
// lockfile works on Windows, macOS, Linux and SMB/NFS shares without native
// dependencies.
const LOCK_STALE_MS = 10_000; // a holder keeps the lock for milliseconds; older = crashed
const LOCK_TIMEOUT_MS = 15_000;
// Windows reports EPERM/EACCES/EBUSY while another process is deleting the
// lockfile, so those mean "contended" just like EEXIST.
const LOCK_CONTENDED_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists but belongs to another user
  }
}

function canonical(entry) {
  // Stable key order so the hash is reproducible regardless of insertion order.
  return JSON.stringify(entry, Object.keys(entry).sort());
}

function hashEntry(prevHash, entryWithoutHash) {
  return crypto.createHash("sha256").update(prevHash + canonical(entryWithoutHash)).digest("hex");
}

// Reads the last parseable JSON line of a JSONL file without loading the
// whole file, so re-reading the true on-disk tail before every write stays
// cheap even for a 10 MB log.
function readLastEntry(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let chunk = 64 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      if (start > 0) lines.shift(); // the first line may be cut mid-record
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          return JSON.parse(line);
        } catch { /* corrupt line, keep looking */ }
      }
      if (start === 0) return null;
      chunk *= 4;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Append-only, hash-chained audit log of agent actions for a single repo.
// Each line is a JSON record whose `hash` covers its own fields + the
// previous record's hash, so any edit or deletion of a past line breaks
// the chain from that point forward (tamper-evident, not tamper-proof —
// see verify()).
class AuditStore {
  constructor(repoRoot, options = {}) {
    this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.setRepoRoot(repoRoot);
  }

  setRepoRoot(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
    this.dir = path.join(this.repoRoot, ".cortex", "audit");
    this.logPath = path.join(this.dir, "audit.jsonl");
    this.lockPath = `${this.logPath}.lock`;
    this._seq = 0;
    this._lastHash = null;
  }

  // Always re-reads the tail from disk (called under the write lock): another
  // process may have appended since this instance last wrote, and trusting an
  // in-memory tail is exactly what used to fork the chain.
  _tailHash() {
    const last = readLastEntry(this.logPath);
    if (!last) {
      this._seq = 0;
      this._lastHash = GENESIS_HASH;
    } else {
      this._seq = Number.isInteger(last.seq) ? last.seq + 1 : this._readRaw().length;
      this._lastHash = typeof last.hash === "string" ? last.hash : GENESIS_HASH;
    }
    return this._lastHash;
  }

  _acquireLock() {
    const token = `${os.hostname()}:${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
    const deadline = Date.now() + this.lockTimeoutMs;
    let delay = 1;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, "wx");
        try {
          fs.writeSync(fd, JSON.stringify({ token, host: os.hostname(), pid: process.pid, ts: Date.now() }));
        } finally {
          fs.closeSync(fd);
        }
        return token;
      } catch (error) {
        if (!LOCK_CONTENDED_CODES.has(error.code)) throw error;
      }
      if (this._breakStaleLock()) continue;
      if (Date.now() >= deadline) return null;
      sleepSync(delay + Math.floor(Math.random() * 3));
      delay = Math.min(delay * 2, 25);
    }
  }

  // Removes a lock left behind by a crashed or hung writer. A lock is stale
  // when it is older than lockStaleMs, or when its owner is on this machine
  // and no longer running — or is this very process: record() is fully
  // synchronous, so a lock carrying our own pid can only be a leftover.
  _breakStaleLock() {
    let raw;
    let stat;
    try {
      raw = fs.readFileSync(this.lockPath, "utf8");
      stat = fs.statSync(this.lockPath);
    } catch (error) {
      return error.code === "ENOENT"; // released meanwhile: retry at once
    }
    let owner = {};
    try { owner = JSON.parse(raw); } catch { /* half-written: judge by age only */ }
    const age = Date.now() - stat.mtimeMs;
    const sameHost = owner.host === os.hostname();
    const ownerGone = sameHost && (owner.pid === process.pid || !processAlive(owner.pid));
    if (age < this.lockStaleMs && !ownerGone) return false;
    try {
      // Only remove the exact lock judged stale, not a fresh one that
      // replaced it in the meantime.
      if (fs.readFileSync(this.lockPath, "utf8") === raw) fs.unlinkSync(this.lockPath);
    } catch { /* someone else removed it first */ }
    return true;
  }

  _releaseLock(token) {
    if (!token) return;
    try {
      if (fs.readFileSync(this.lockPath, "utf8").includes(token)) fs.unlinkSync(this.lockPath);
    } catch { /* already gone */ }
  }

  _withLock(fn) {
    let token = null;
    try {
      token = this._acquireLock();
    } catch {
      token = null;
    }
    // If the lock cannot be had within lockTimeoutMs, still write: dropping
    // the entry would be worse than the (tail-re-read-narrowed) risk of a
    // fork, which verify() would then surface rather than hide.
    try {
      return fn();
    } finally {
      this._releaseLock(token);
    }
  }

  _rotateIfNeeded() {
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size > MAX_BYTES) {
        fs.renameSync(this.logPath, `${this.logPath}.1`);
        // Chain intentionally does not carry across rotation boundaries —
        // the archived file remains independently verifiable.
        this._seq = 0;
        this._lastHash = GENESIS_HASH;
      }
    } catch { /* file may not exist yet */ }
  }

  // entry: { source, provider, model, chatId, action, path, oldPath, newPath, command, exitCode, success, detail }
  record(entry) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      return this._withLock(() => this._appendLocked(entry));
    } catch {
      // Never let audit failures break the agent turn that triggered them.
      return null;
    }
  }

  _appendLocked(entry) {
    this._rotateIfNeeded();
    const prevHash = this._tailHash();
    const base = {
      ts: new Date().toISOString(),
      seq: this._seq,
      source: entry.source || "agent",
      provider: entry.provider || "",
      model: entry.model || "",
      chat_id: entry.chatId || "",
      action: entry.action || "",
      path: entry.path || "",
      old_path: entry.oldPath || "",
      new_path: entry.newPath || "",
      command: entry.command || "",
      exit_code: entry.exitCode ?? null,
      success: entry.success !== false,
      detail: entry.detail || "",
      prev_hash: prevHash,
    };
    const hash = hashEntry(prevHash, base);
    const record = { ...base, hash };
    fs.appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
    this._seq += 1;
    this._lastHash = hash;
    return record;
  }

  recordChanges(changes, meta = {}) {
    for (const change of changes || []) {
      this.record({
        source: "agent",
        action: change.action,
        path: change.path,
        oldPath: change.oldPath,
        newPath: change.newPath,
        ...meta,
      });
    }
  }

  _readRaw() {
    if (!fs.existsSync(this.logPath)) return [];
    const lines = fs.readFileSync(this.logPath, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    return out;
  }

  // Returns { ok, brokenAtSeq } — brokenAtSeq is the first record whose
  // stored hash no longer matches its recomputed hash (tamper or corruption).
  verify() {
    const entries = this._readRaw();
    let prevHash = GENESIS_HASH;
    for (const entry of entries) {
      const { hash, ...rest } = entry;
      if (rest.prev_hash !== prevHash || hashEntry(rest.prev_hash, rest) !== hash) {
        return { ok: false, brokenAtSeq: entry.seq ?? null };
      }
      prevHash = hash;
    }
    return { ok: true, brokenAtSeq: null };
  }

  list({ limit = 200, action = "", provider = "" } = {}) {
    let entries = this._readRaw();
    if (action) entries = entries.filter((e) => e.action === action);
    if (provider) entries = entries.filter((e) => e.provider === provider);
    return entries.slice(-Math.max(1, Number(limit) || 200)).reverse();
  }

  exportJsonl() {
    if (!fs.existsSync(this.logPath)) return "";
    return fs.readFileSync(this.logPath, "utf8");
  }
}

module.exports = { AuditStore };
