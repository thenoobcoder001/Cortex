"use strict";

const crypto = require("node:crypto");

// Pending approval requests, per chat. A provider asks (request), the user
// answers through POST /api/approvals/respond (respond), and the provider's
// promise settles with the decision. Timeouts and interrupts decline.
//
// Every request and decision is handed to onAudit so it lands in the
// hash-chained audit log next to the actions it allowed or stopped.

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_SUMMARY_DIFF_CHARS = 8000;

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}\n... (truncated)` : value;
}

function normalizeDecision(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["approve", "approved", "accept", "allow", "yes"].includes(text)) return "approve";
  if (["decline", "declined", "deny", "denied", "reject", "no"].includes(text)) return "decline";
  return "";
}

class ApprovalRegistry {
  constructor({ timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS, onAudit = null } = {}) {
    this.timeoutMs = timeoutMs;
    this.onAudit = onAudit; // (entry, repoRoot) => void
    this.pendingById = new Map(); // id -> { approval, resolve, timer }
    this.listeners = new Map(); // chatId -> Set<fn>
    this.alwaysAllow = new Map(); // chatId -> Set<command>
  }

  // Events for one chat: { type: "approval_request", approval } and
  // { type: "approval_resolved", approvalId, decision, by }.
  subscribe(chatId, listener) {
    const key = String(chatId || "");
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
    return () => {
      const set = this.listeners.get(key);
      if (!set) return;
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }

  _emit(chatId, event) {
    for (const listener of this.listeners.get(String(chatId || "")) || []) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop the decision reaching the provider.
      }
    }
  }

  _audit(approval, action, extra = {}) {
    if (!this.onAudit) return;
    const parts = [`approval ${approval.id}`, approval.kind];
    if (approval.toolName) parts.push(`tool ${approval.toolName}`);
    if (extra.detail) parts.push(extra.detail);
    try {
      this.onAudit({
        source: extra.source || "agent",
        provider: approval.provider,
        model: approval.model,
        chatId: approval.chatId,
        action,
        path: approval.path || "",
        command: approval.command || "",
        success: extra.success !== false,
        detail: parts.join("; "),
      }, approval.repoRoot || null);
    } catch {
      // Audit failures never block the turn.
    }
  }

  isAlwaysAllowed(chatId, command) {
    const text = String(command || "").trim();
    return Boolean(text) && Boolean(this.alwaysAllow.get(String(chatId || ""))?.has(text));
  }

  // summary: { kind: "command"|"file_change"|"tool"|"permissions", command,
  //            cwd, path, diff, toolName, reason, provider, model, repoRoot }
  // Returns { approval, promise } where promise resolves to
  // { decision: "approve"|"decline", by, always }.
  request(chatId, summary = {}) {
    const approval = {
      id: crypto.randomUUID(),
      chatId: String(chatId || ""),
      kind: String(summary.kind || "tool"),
      provider: String(summary.provider || ""),
      model: String(summary.model || ""),
      repoRoot: String(summary.repoRoot || ""),
      toolName: String(summary.toolName || ""),
      command: String(summary.command || ""),
      cwd: String(summary.cwd || ""),
      path: String(summary.path || ""),
      diff: truncate(summary.diff, MAX_SUMMARY_DIFF_CHARS),
      reason: String(summary.reason || ""),
      // "Always allow" is offered for plain commands only: a command string
      // is easy to match exactly, a file change is not.
      canAlwaysAllow: String(summary.kind || "") === "command" && Boolean(String(summary.command || "").trim()),
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
    };

    this._audit(approval, "approval_requested");

    // The mode itself allows this (e.g. an edit in Auto-accept edits) but the
    // provider still asked; answer at once and keep the audit trail.
    if (summary.autoApprove) {
      const by = String(summary.autoApprove === true ? "permission mode" : summary.autoApprove);
      this._audit(approval, "approved", { source: "cortex", detail: `by ${by}` });
      return { approval: { ...approval, autoResolved: true }, promise: Promise.resolve({ decision: "approve", by, always: false }) };
    }

    if (approval.canAlwaysAllow && this.isAlwaysAllowed(approval.chatId, approval.command)) {
      const result = { decision: "approve", by: "always-allow rule", always: true };
      this._audit(approval, "approved", { source: "cortex", detail: "by always-allow rule for this chat" });
      return { approval: { ...approval, autoResolved: true }, promise: Promise.resolve(result) };
    }

    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => {
      this._settle(approval.id, { decision: "decline", by: "timeout", source: "cortex", detail: "timed out with no answer" });
    }, this.timeoutMs);
    timer.unref?.();
    this.pendingById.set(approval.id, { approval, resolve, timer });
    this._emit(approval.chatId, { type: "approval_request", chatId: approval.chatId, approval: this.publicView(approval) });
    return { approval, promise };
  }

  _settle(id, { decision, by, source, detail, always = false }) {
    const entry = this.pendingById.get(id);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.pendingById.delete(id);
    const { approval } = entry;
    this._audit(approval, decision === "approve" ? "approved" : "declined", {
      source,
      success: true,
      detail: [detail || `by ${by}`, always ? "always allow this command for this chat" : ""].filter(Boolean).join("; "),
    });
    this._emit(approval.chatId, { type: "approval_resolved", chatId: approval.chatId, approvalId: id, decision, by });
    entry.resolve({ decision, by, always });
    return { approval: this.publicView(approval), decision, by };
  }

  // Answer from a user. `by` says who/where (desktop, relay:<device>, ...).
  respond(id, { decision, alwaysAllow = false, by = "desktop", chatId = null } = {}) {
    const entry = this.pendingById.get(String(id || ""));
    if (!entry) throw new Error("Approval request not found or already answered.");
    if (chatId && String(chatId) !== entry.approval.chatId) {
      throw new Error("Approval request belongs to a different chat.");
    }
    const normalized = normalizeDecision(decision);
    if (!normalized) throw new Error("Decision must be approve or decline.");
    const always = normalized === "approve" && Boolean(alwaysAllow) && entry.approval.canAlwaysAllow;
    if (always) {
      const key = entry.approval.chatId;
      if (!this.alwaysAllow.has(key)) this.alwaysAllow.set(key, new Set());
      this.alwaysAllow.get(key).add(entry.approval.command.trim());
    }
    return this._settle(entry.approval.id, { decision: normalized, by, source: "user", detail: `by ${by}`, always });
  }

  // Declines everything still waiting for a chat (interrupt, delete, turn end).
  cancelChat(chatId, reason = "interrupted") {
    const key = String(chatId || "");
    const ids = [...this.pendingById.values()]
      .filter((entry) => entry.approval.chatId === key)
      .map((entry) => entry.approval.id);
    for (const id of ids) {
      this._settle(id, { decision: "decline", by: reason, source: "cortex", detail: `cancelled: ${reason}` });
    }
    return ids.length;
  }

  forgetChat(chatId) {
    this.cancelChat(chatId, "chat deleted");
    this.alwaysAllow.delete(String(chatId || ""));
  }

  publicView(approval) {
    return { ...approval };
  }

  pending(chatId = null) {
    return [...this.pendingById.values()]
      .map((entry) => this.publicView(entry.approval))
      .filter((approval) => !chatId || approval.chatId === String(chatId))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  waitingChatIds() {
    return [...new Set([...this.pendingById.values()].map((entry) => entry.approval.chatId))].sort();
  }
}

module.exports = {
  ApprovalRegistry,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  normalizeDecision,
};
