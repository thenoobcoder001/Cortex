"use strict";

// Per-turn file changes: what one assistant turn did to the repo, kept so the
// diff panel can show it and "Revert this turn" can undo it.
//
// Storage: .cortex/chats/turns/<chatId>/<turnId>.json holds the full record
// (diffs + pre-turn content for revert). The chat message itself only carries
// a small summary (`turnChanges`), because chat messages ride along on every
// /api/status poll.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { diffFile, isBinaryText } = require("./turnDiff");

// Files bigger than this are fingerprinted by size + mtime instead of hashed.
const HASH_MAX_BYTES = 50 * 1024 * 1024;
// Upper bound on pre-turn text stored for revert across one turn.
const RESTORE_TEXT_BUDGET_CHARS = 24 * 1024 * 1024;
// Chat ids look like "20261103123456.-a1b2c3" (dot included); "." and ".." are not ids.
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]{1,80}$/;

const ACTION_NAMES = { create: "added", edit: "modified", delete: "deleted" };

class RevertConflictError extends Error {
  constructor(message, conflicts = []) {
    super(message);
    this.name = "RevertConflictError";
    this.conflicts = conflicts;
  }
}

function assertSafeId(value, label) {
  const text = String(value || "");
  if (!SAFE_ID.test(text)) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

function newTurnId() {
  return `turn-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

// A fingerprint of a file's current content, or null when it does not exist.
function fileSignature(fullPath) {
  let stats;
  try {
    stats = fs.statSync(fullPath);
  } catch {
    return null;
  }
  if (!stats.isFile()) return `other:${stats.mode}`;
  if (stats.size > HASH_MAX_BYTES) return `stat:${stats.size}:${stats.mtimeMs}`;
  try {
    return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex")}`;
  } catch {
    return `stat:${stats.size}:${stats.mtimeMs}`;
  }
}

function turnsDir(repoRoot, chatId) {
  return path.join(path.resolve(repoRoot), ".cortex", "chats", "turns", assertSafeId(chatId, "chat id"));
}

function turnFile(repoRoot, chatId, turnId) {
  return path.join(turnsDir(repoRoot, chatId), `${assertSafeId(turnId, "turn id")}.json`);
}

function summarizeTurn(record) {
  const files = record.files || [];
  const revertedCount = files.filter((file) => file.status === "reverted").length;
  return {
    id: record.turnId,
    files: files.length,
    additions: files.reduce((sum, file) => sum + (file.additions || 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions || 0), 0),
    reverted: revertedCount === 0 ? "none" : revertedCount === files.length ? "all" : "partial",
  };
}

// changes: output of RepoFileService.diffRepoState (create/edit/delete).
function buildTurnRecord({ repoRoot, chatId, turnId = newTurnId(), beforeState, afterState, changes }) {
  const root = path.resolve(repoRoot);
  let restoreBudget = RESTORE_TEXT_BUDGET_CHARS;
  const files = [];
  for (const change of changes || []) {
    const relativePath = String(change.path || "");
    const action = ACTION_NAMES[change.action];
    if (!relativePath || !action) continue;
    const before = beforeState?.[relativePath] || null;
    const after = afterState?.[relativePath] || null;
    const beforeText = before && typeof before.text === "string" ? before.text : null;
    const afterText = after && typeof after.text === "string" ? after.text : null;
    const diff = diffFile(relativePath, {
      beforeText,
      afterText,
      beforeAbsent: action === "added",
      afterAbsent: action === "deleted",
    });

    // To undo an add we delete the file; to undo an edit or delete we need
    // the exact pre-turn text, which is only kept for text files that fit
    // the snapshot's size budget.
    let restoreText = null;
    let unrevertableReason = "";
    if (action !== "added") {
      if (beforeText == null) {
        unrevertableReason = "The file was too large to keep a copy before this turn.";
      } else if (isBinaryText(beforeText)) {
        unrevertableReason = "Binary files cannot be restored.";
      } else if (typeof before.size === "number" && Buffer.byteLength(beforeText, "utf8") !== before.size) {
        // Not valid UTF-8 (e.g. Latin-1): the kept text would not write back
        // byte-for-byte, so restoring it would corrupt the file.
        unrevertableReason = "The file is not UTF-8 text, so it cannot be restored exactly.";
      } else if (beforeText.length > restoreBudget) {
        unrevertableReason = "This turn changed too much text to keep a copy of every file.";
      } else {
        restoreText = beforeText;
        restoreBudget -= beforeText.length;
      }
    }

    files.push({
      path: relativePath,
      action,
      additions: diff.additions,
      deletions: diff.deletions,
      binary: diff.binary,
      tooLarge: diff.tooLarge,
      diff: diff.diff,
      revertable: !unrevertableReason,
      unrevertableReason,
      restoreText,
      afterSignature: action === "deleted" ? null : fileSignature(path.join(root, relativePath)),
      status: "applied",
    });
  }
  return {
    version: 1,
    turnId: assertSafeId(turnId, "turn id"),
    chatId: assertSafeId(chatId, "chat id"),
    createdAt: new Date().toISOString(),
    files,
  };
}

function saveTurnRecord(repoRoot, record) {
  const target = turnFile(repoRoot, record.chatId, record.turnId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record), "utf8");
  fs.renameSync(temp, target);
}

function loadTurnRecord(repoRoot, chatId, turnId) {
  const target = turnFile(repoRoot, chatId, turnId);
  try {
    const raw = JSON.parse(fs.readFileSync(target, "utf8"));
    return raw && typeof raw === "object" && Array.isArray(raw.files) ? raw : null;
  } catch {
    return null;
  }
}

function deleteTurnRecords(repoRoot, chatId) {
  if (!SAFE_ID.test(String(chatId || ""))) return;
  try {
    fs.rmSync(turnsDir(repoRoot, chatId), { recursive: true, force: true });
  } catch {
    // Missing or locked: leftover turn files are harmless.
  }
}

// Why the file can no longer be reverted safely, or "" when it can.
function conflictReason(root, file) {
  const current = fileSignature(path.join(root, file.path));
  if (file.action === "deleted") {
    return current == null ? "" : "it was created again after this turn";
  }
  if (current == null) return "it was deleted after this turn";
  if (current !== file.afterSignature) return "it was changed again after this turn";
  return "";
}

// The record as the diff panel sees it: no restore text, plus whether each
// file still matches what the turn left behind.
function publicTurnView(repoRoot, record) {
  const root = path.resolve(repoRoot);
  return {
    chatId: record.chatId,
    turnId: record.turnId,
    createdAt: record.createdAt,
    summary: summarizeTurn(record),
    files: record.files.map((file) => {
      const reverted = file.status === "reverted";
      const conflict = reverted ? "" : conflictReason(root, file);
      return {
        path: file.path,
        action: file.action,
        additions: file.additions,
        deletions: file.deletions,
        binary: Boolean(file.binary),
        tooLarge: Boolean(file.tooLarge),
        diff: file.diff || "",
        status: file.status,
        revertable: !reverted && file.revertable && !conflict,
        blockedReason: reverted ? "" : (file.unrevertableReason || (conflict ? `Can't revert: ${conflict}.` : "")),
      };
    }),
  };
}

// Restores the selected files of a turn to their pre-turn state. All-or-
// nothing: if any selected file was changed since, nothing is written.
// Returns { record, reverted: [paths] }.
function revertTurnFiles(repoRoot, record, { path: onlyPath = null } = {}) {
  const root = path.resolve(repoRoot);
  let targets = record.files.filter((file) => file.status !== "reverted");
  if (onlyPath) {
    const match = record.files.find((file) => file.path === onlyPath);
    if (!match) throw new Error(`This turn did not change ${onlyPath}.`);
    if (match.status === "reverted") throw new Error(`${onlyPath} is already reverted.`);
    targets = [match];
  }
  if (!targets.length) throw new Error("Everything in this turn is already reverted.");

  const conflicts = [];
  for (const file of targets) {
    if (!file.revertable) {
      conflicts.push({ path: file.path, reason: file.unrevertableReason || "it cannot be restored" });
      continue;
    }
    const reason = conflictReason(root, file);
    if (reason) conflicts.push({ path: file.path, reason });
  }
  if (conflicts.length) {
    const list = conflicts.map((item) => `${item.path} (${item.reason.replace(/\.$/, "")})`).join("; ");
    throw new RevertConflictError(
      `Nothing was reverted: ${conflicts.length === 1 ? "1 file" : `${conflicts.length} files`} can't go back safely: ${list}.`,
      conflicts,
    );
  }

  const reverted = [];
  for (const file of targets) {
    const fullPath = path.join(root, file.path);
    if (file.action === "added") {
      fs.rmSync(fullPath, { force: true });
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.restoreText, "utf8");
    }
    file.status = "reverted";
    file.revertedAt = new Date().toISOString();
    reverted.push(file.path);
  }
  return { record, reverted };
}

module.exports = {
  RevertConflictError,
  buildTurnRecord,
  saveTurnRecord,
  loadTurnRecord,
  deleteTurnRecords,
  publicTurnView,
  revertTurnFiles,
  summarizeTurn,
  fileSignature,
  newTurnId,
};
