"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { redactSecrets } = require("./auditRedact");

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

function readEntries(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}

const ARCHIVE_NAME = /^audit\.jsonl\.(\d+)$/;

function archiveIndex(filePath) {
  return Number(ARCHIVE_NAME.exec(path.basename(filePath))?.[1] || 0);
}

// Append-only, hash-chained audit log of agent actions for a single repo.
// Each line is a JSON record whose `hash` covers its own fields + the
// previous record's hash, so any edit or deletion of a past line breaks
// the chain from that point forward (tamper-evident, not tamper-proof —
// see verify()).
//
// When audit.jsonl grows past maxBytes it is renamed to the next free
// archive slot — audit.jsonl.1, .2, .3, ... (higher = newer) — and nothing is
// ever overwritten or deleted. The chain (and seq) carries on across files:
// the first record of the new audit.jsonl points at the last record of the
// newest archive, so verify() covers the whole history.
class AuditStore {
  constructor(repoRoot, options = {}) {
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
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
    this._archiveCache = new Map(); // archive path -> { key, summary }
  }

  // Archive files, oldest first.
  _archivePaths() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => ARCHIVE_NAME.test(name))
      .map((name) => path.join(this.dir, name))
      .sort((a, b) => archiveIndex(a) - archiveIndex(b));
  }

  // Every segment of the history, oldest first, ending with the live log.
  _segmentPaths() {
    return [...this._archivePaths(), this.logPath];
  }

  // Always re-reads the tail from disk (called under the write lock): another
  // process may have appended since this instance last wrote, and trusting an
  // in-memory tail is exactly what used to fork the chain.
  _tailHash() {
    let last = readLastEntry(this.logPath);
    if (!last) {
      // Fresh live log right after a rotation: continue from the newest archive.
      const archives = this._archivePaths();
      if (archives.length) last = readLastEntry(archives[archives.length - 1]);
    }
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

  // Runs under the write lock, so two processes cannot claim the same slot.
  // Archives are never overwritten or deleted.
  _rotateIfNeeded() {
    let size;
    try {
      size = fs.statSync(this.logPath).size;
    } catch {
      return; // live log does not exist yet
    }
    if (size <= this.maxBytes) return;
    const archives = this._archivePaths();
    let slot = archives.length ? archiveIndex(archives[archives.length - 1]) + 1 : 1;
    while (fs.existsSync(`${this.logPath}.${slot}`)) slot += 1;
    fs.renameSync(this.logPath, `${this.logPath}.${slot}`);
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
      // Free-text fields are redacted before hashing, so the chain covers
      // exactly what is stored and the secret never touches disk.
      path: redactSecrets(String(entry.path || "")),
      old_path: redactSecrets(String(entry.oldPath || "")),
      new_path: redactSecrets(String(entry.newPath || "")),
      command: redactSecrets(String(entry.command || "")),
      exit_code: entry.exitCode ?? null,
      success: entry.success !== false,
      detail: redactSecrets(String(entry.detail || "")),
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
    return readEntries(this.logPath);
  }

  // Checks one segment's internal chain and reports where it starts and ends,
  // so verify() can check the links between segments.
  _verifySegment(filePath) {
    const entries = readEntries(filePath);
    const summary = {
      ok: true,
      brokenAtSeq: null,
      count: entries.length,
      firstSeq: entries.length ? entries[0].seq ?? null : null,
      firstPrev: entries.length ? entries[0].prev_hash : null,
      lastHash: null,
    };
    let prevHash = summary.firstPrev;
    for (const entry of entries) {
      const { hash, ...rest } = entry;
      if (rest.prev_hash !== prevHash || hashEntry(rest.prev_hash, rest) !== hash) {
        return { ...summary, ok: false, brokenAtSeq: entry.seq ?? null };
      }
      prevHash = hash;
    }
    summary.lastHash = prevHash;
    return summary;
  }

  // Archives never change once written, so their verification is cached by
  // size + mtime; any later edit to an archive invalidates the cache entry.
  _verifyArchive(filePath) {
    let key = "";
    try {
      const stat = fs.statSync(filePath);
      key = `${stat.size}:${stat.mtimeMs}`;
    } catch { /* vanished: verify (as empty) without caching */ }
    const cached = this._archiveCache.get(filePath);
    if (key && cached && cached.key === key) return cached.summary;
    const summary = this._verifySegment(filePath);
    if (key) this._archiveCache.set(filePath, { key, summary });
    return summary;
  }

  // Returns { ok, brokenAtSeq, segments, entries } over every archive plus the
  // live log. brokenAtSeq is the first record whose hash no longer matches
  // its contents or whose prev_hash does not point at the record before it
  // (tamper, deletion or corruption). Each segment's first record must link
  // to the previous segment's last record; the one accepted exception is a
  // restart at the genesis hash, which logs rotated by older Cortex versions
  // contain. A deleted oldest archive therefore shows up as a broken link.
  verify() {
    const summaries = [
      ...this._archivePaths().map((file) => this._verifyArchive(file)),
      this._verifySegment(this.logPath),
    ];
    let prevHash = GENESIS_HASH;
    let entries = 0;
    for (const summary of summaries) {
      const result = { ok: false, brokenAtSeq: summary.brokenAtSeq, segments: summaries.length, entries };
      if (!summary.ok) return result;
      if (!summary.count) continue;
      if (summary.firstPrev !== prevHash && summary.firstPrev !== GENESIS_HASH) {
        return { ...result, brokenAtSeq: summary.firstSeq };
      }
      entries += summary.count;
      prevHash = summary.lastHash;
    }
    return { ok: true, brokenAtSeq: null, segments: summaries.length, entries };
  }

  // Newest first, reading archives only as far back as the limit needs.
  list({ limit = 200, action = "", provider = "" } = {}) {
    const max = Math.max(1, Number(limit) || 200);
    const segments = this._segmentPaths();
    const out = [];
    for (let index = segments.length - 1; index >= 0 && out.length < max; index -= 1) {
      let entries = readEntries(segments[index]);
      if (action) entries = entries.filter((e) => e.action === action);
      if (provider) entries = entries.filter((e) => e.provider === provider);
      for (let at = entries.length - 1; at >= 0 && out.length < max; at -= 1) out.push(entries[at]);
    }
    return out;
  }

  // Full history, oldest first, as one JSONL document.
  exportJsonl() {
    let out = "";
    for (const file of this._segmentPaths()) {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch { /* live log may not exist yet */ }
      if (text) out += text.endsWith("\n") ? text : `${text}\n`;
    }
    return out;
  }
}

module.exports = { AuditStore };
