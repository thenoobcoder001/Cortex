"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const GENESIS_HASH = "0".repeat(64);
const MAX_BYTES = 10 * 1024 * 1024;

function canonical(entry) {
  // Stable key order so the hash is reproducible regardless of insertion order.
  return JSON.stringify(entry, Object.keys(entry).sort());
}

function hashEntry(prevHash, entryWithoutHash) {
  return crypto.createHash("sha256").update(prevHash + canonical(entryWithoutHash)).digest("hex");
}

// Append-only, hash-chained audit log of agent actions for a single repo.
// Each line is a JSON record whose `hash` covers its own fields + the
// previous record's hash, so any edit or deletion of a past line breaks
// the chain from that point forward (tamper-evident, not tamper-proof —
// see verify()).
class AuditStore {
  constructor(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
    this.dir = path.join(this.repoRoot, ".cortex", "audit");
    this.logPath = path.join(this.dir, "audit.jsonl");
    this._seq = 0;
    this._lastHash = null; // lazily resolved from disk on first record()
  }

  setRepoRoot(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
    this.dir = path.join(this.repoRoot, ".cortex", "audit");
    this.logPath = path.join(this.dir, "audit.jsonl");
    this._seq = 0;
    this._lastHash = null;
  }

  _tailHash() {
    if (this._lastHash !== null) return this._lastHash;
    const entries = this._readRaw();
    this._seq = entries.length;
    this._lastHash = entries.length ? entries[entries.length - 1].hash : GENESIS_HASH;
    return this._lastHash;
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
    } catch {
      // Never let audit failures break the agent turn that triggered them.
      return null;
    }
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
}

module.exports = { AuditStore };
