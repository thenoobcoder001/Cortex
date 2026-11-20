import { useState } from "react";
import { Check, FilePen, ShieldAlert, Terminal, X } from "lucide-react";

const KIND_LABELS = {
  command: "Run a command",
  file_change: "Change files",
  permissions: "Extra permissions",
  tool: "Use a tool",
};

function ApprovalCard({ approval, answering, onRespond }) {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const Icon = approval.kind === "command" ? Terminal : approval.kind === "file_change" ? FilePen : ShieldAlert;
  const busy = Boolean(answering);

  return (
    <div className="approval-card" role="alertdialog" aria-label={`${approval.provider || "Agent"} wants to ${KIND_LABELS[approval.kind] || "act"}`}>
      <div className="approval-card-head">
        <Icon size={15} className="ui-icon" />
        <span className="approval-card-title">
          {approval.provider || "Agent"} wants to {(KIND_LABELS[approval.kind] || "act").toLowerCase()}
        </span>
        {approval.toolName && <span className="approval-card-tool">{approval.toolName}</span>}
      </div>
      {approval.command && <pre className="approval-card-command">{approval.command}</pre>}
      {approval.path && <div className="approval-card-path" title={approval.path}>{approval.path}</div>}
      {approval.reason && <div className="approval-card-reason">{approval.reason}</div>}
      {approval.diff && (
        <>
          <button type="button" className="approval-card-toggle" onClick={() => setShowDiff((value) => !value)}>
            {showDiff ? "Hide changes" : "Show changes"}
          </button>
          {showDiff && <pre className="approval-card-diff">{approval.diff}</pre>}
        </>
      )}
      <div className="approval-card-actions">
        {approval.canAlwaysAllow && (
          <label className="approval-card-always">
            <input
              type="checkbox"
              checked={alwaysAllow}
              disabled={busy}
              onChange={(event) => setAlwaysAllow(event.target.checked)}
            />
            Always allow this command in this chat
          </label>
        )}
        <button
          type="button"
          className="ghost-button approval-decline"
          disabled={busy}
          onClick={() => void onRespond(approval, "decline")}
        >
          <X size={14} className="ui-icon" />
          {answering === "decline" ? "Declining..." : "Decline"}
        </button>
        <button
          type="button"
          className="primary-button approval-approve"
          disabled={busy}
          onClick={() => void onRespond(approval, "approve", { alwaysAllow })}
        >
          <Check size={14} className="ui-icon" />
          {answering === "approve" ? "Approving..." : "Approve"}
        </button>
      </div>
    </div>
  );
}

// Approval requests for the active chat, shown above the composer.
export default function ApprovalPanel({ approvals, answering, onRespond }) {
  if (!approvals.length) return null;
  return (
    <div className="approval-panel">
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          answering={answering[approval.id]}
          onRespond={onRespond}
        />
      ))}
    </div>
  );
}
