// Labels and status rules for audit trail entries. Plain JS (no JSX) so the
// backend test runner can import it.

// Every action the backend passes to AuditStore.record(), in filter order.
// `label` reads as something that happened; `attempt` is used when the entry
// was blocked or failed, so a refused edit doesn't read as "Edited".
// `icon` is a lucide-react component name, resolved in AuditPage.jsx.
export const AUDIT_ACTIONS = [
  { id: "create", label: "Created file", attempt: "Create file", filter: "Created files", icon: "FilePlus" },
  { id: "write", label: "Wrote file", attempt: "Write file", filter: "File writes", icon: "FileUp" },
  { id: "edit", label: "Edited file", attempt: "Edit file", filter: "Edited files", icon: "FilePen" },
  { id: "delete", label: "Deleted", attempt: "Delete", filter: "Deletions", icon: "FileX" },
  { id: "rename", label: "Renamed", attempt: "Rename", filter: "Renames", icon: "Replace" },
  { id: "create_directory", label: "Created folder", attempt: "Create folder", filter: "Created folders", icon: "FolderPlus" },
  { id: "run_command", label: "Ran command", attempt: "Run command", filter: "Commands", icon: "SquareTerminal" },
  { id: "read", label: "Read file", attempt: "Read file", filter: "File reads (outside project)", icon: "FileSearch" },
  { id: "audit_incomplete", label: "Audit incomplete", attempt: "Audit incomplete", filter: "Incomplete audits", icon: "TriangleAlert" },
  { id: "approval_requested", label: "Asked for approval", attempt: "Ask for approval", filter: "Approval requests", icon: "ShieldQuestion" },
  { id: "approved", label: "Approved", attempt: "Approve", filter: "Approvals", icon: "ShieldCheck" },
  { id: "declined", label: "Declined", attempt: "Decline", filter: "Declines", icon: "ShieldOff" },
  { id: "permission_mode_changed", label: "Changed permission mode", attempt: "Change permission mode", filter: "Permission mode changes", icon: "SlidersHorizontal" },
  { id: "revert", label: "Reverted turn changes", attempt: "Revert turn changes", filter: "Reverts", icon: "Undo2" },
  { id: "revert_refused", label: "Revert refused", attempt: "Revert refused", filter: "Refused reverts", icon: "Ban" },
  { id: "hmac_replay", label: "Replayed request rejected", attempt: "Replayed request rejected", filter: "Replayed requests", icon: "ShieldX" },
];

const BY_ID = new Map(AUDIT_ACTIONS.map((action) => [action.id, action]));

export function auditActionInfo(actionId) {
  return BY_ID.get(actionId) || null;
}

// "ok" | "blocked" | "failed" | "incomplete"
export function auditEntryStatus(entry) {
  if (!entry || entry.success !== false) return "ok";
  if (entry.action === "audit_incomplete") return "incomplete";
  const detail = String(entry.detail || "").trim().toLowerCase();
  if (detail.startsWith("blocked") || detail.startsWith("rejected") || entry.action === "hmac_replay") return "blocked";
  return "failed";
}

export const AUDIT_STATUS_BADGES = {
  blocked: "Blocked",
  failed: "Failed",
  incomplete: "Incomplete",
};

export function auditEntryLabel(entry) {
  const info = auditActionInfo(entry?.action);
  if (!info) {
    const raw = String(entry?.action || "").replaceAll("_", " ").trim();
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Agent action";
  }
  return auditEntryStatus(entry) === "ok" ? info.label : info.attempt;
}

// Shortens a long path by cutting the middle, keeping more of the end (the
// file name) than the start. Returns the text unchanged when it fits.
export function middleTruncate(text, max = 72) {
  const value = String(text ?? "");
  if (max < 5 || value.length <= max) return value;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  const tail = keep - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
