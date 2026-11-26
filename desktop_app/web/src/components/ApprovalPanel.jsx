import { useState } from "react";
import { AlertTriangle, Check, CheckCheck, FilePen, ShieldAlert, Terminal, X } from "lucide-react";

const KIND_LABELS = {
  command: "Run a command",
  file_change: "Change files",
  permissions: "Extra permissions",
  tool: "Use a tool",
};

// One request: why Cortex asks, what would run, and Allow once / Always
// allow in this chat / Decline. The agent carries on from the answer.
function ApprovalCard({ approval, answering, onRespond }) {
  const [showDiff, setShowDiff] = useState(true);
  const Icon = approval.risk ? AlertTriangle : approval.kind === "command" ? Terminal : approval.kind === "file_change" ? FilePen : ShieldAlert;
  const busy = Boolean(answering);

  return (
    <div
      className={approval.risk ? "approval-card risky" : "approval-card"}
      role="alertdialog"
      aria-label={`${approval.provider || "Agent"} wants to ${KIND_LABELS[approval.kind] || "act"}`}
    >
      <div className="approval-card-head">
        <Icon size={15} className="ui-icon" />
        <span className="approval-card-title">
          {approval.provider || "Agent"} wants to {(KIND_LABELS[approval.kind] || "act").toLowerCase()}
        </span>
        {approval.toolName && <span className="approval-card-tool">{approval.toolName}</span>}
      </div>
      {approval.risk && <div className="approval-card-risk">{approval.risk}</div>}
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
        <button
          type="button"
          className="ghost-button approval-decline"
          disabled={busy}
          title="The agent is told you declined and continues another way"
          onClick={() => void onRespond(approval, "decline")}
        >
          <X size={14} className="ui-icon" />
          {answering === "decline" ? "Declining..." : "Decline"}
        </button>
        {approval.canAlwaysAllow && (
          <button
            type="button"
            className="ghost-button approval-always"
            disabled={busy}
            title="Allow this exact command for the rest of this chat without asking"
            onClick={() => void onRespond(approval, "approve", { alwaysAllow: true })}
          >
            <CheckCheck size={14} className="ui-icon" />
            Always allow in this chat
          </button>
        )}
        <button
          type="button"
          className="primary-button approval-approve"
          disabled={busy}
          onClick={() => void onRespond(approval, "approve")}
        >
          <Check size={14} className="ui-icon" />
          {answering === "approve" ? "Allowing..." : "Allow once"}
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
