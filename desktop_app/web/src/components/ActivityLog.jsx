import { useEffect, useState } from "react";
import {
  Ban, Bot, Check, ChevronRight, CircleHelp, FilePen, FileText, FolderOpen, Globe, ListChecks, Loader2, Search,
  ShieldCheck, SquareTerminal, Wrench, X,
} from "lucide-react";
import { currentStep, formatDuration, summarizeActivity } from "../app/activity.js";
import "../activity.css";

const KIND_ICONS = {
  command: SquareTerminal,
  read: FileText,
  list: FolderOpen,
  search: Search,
  edit: FilePen,
  web: Globe,
  tool: Wrench,
  agent: Bot,
  plan: ListChecks,
};

function StepStatus({ step }) {
  if (step.status === "running") return <Loader2 size={13} className="activity-spin" aria-label="Running" />;
  if (step.status === "failed") {
    return (
      <span className="activity-step-status activity-step-status--failed">
        <X size={13} aria-hidden="true" />
        {Number.isInteger(step.exitCode) ? `exit ${step.exitCode}` : "failed"}
      </span>
    );
  }
  if (step.status === "declined") {
    return <span className="activity-step-status activity-step-status--declined"><Ban size={13} aria-hidden="true" />declined</span>;
  }
  if (step.status === "unknown") {
    return <span className="activity-step-status" title="The agent never reported how this ended"><CircleHelp size={13} aria-hidden="true" />no result</span>;
  }
  return <Check size={13} className="activity-step-ok" aria-label="Done" />;
}

// What the agent did during one turn: a "Working for 12s" line with the
// current step while it runs, then a collapsed "Worked for 41s · ran 2
// commands, made 1 edit" summary. Each command links to its audit entry.
export default function ActivityLog({ activity, onOpenAudit }) {
  const steps = Array.isArray(activity?.steps) ? activity.steps : [];
  const live = Boolean(activity?.live);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  if (!steps.length) return null;

  const elapsed = live
    ? formatDuration(now - (activity.startedAt || now))
    : formatDuration(activity.durationMs);
  const summary = summarizeActivity(steps);
  const current = live ? currentStep(steps) : null;
  const CurrentIcon = current ? KIND_ICONS[current.kind] || Wrench : null;

  return (
    <div className={`activity-log${live ? " activity-log--live" : ""}`}>
      <button
        type="button"
        className="activity-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={open ? "Hide steps" : "Show every step"}
      >
        {live
          ? <Loader2 size={14} className="activity-spin" aria-hidden="true" />
          : <ChevronRight size={14} className={`activity-chevron${open ? " open" : ""}`} aria-hidden="true" />}
        <span className="activity-summary-time">{live ? `Working for ${elapsed}` : `Worked for ${elapsed}`}</span>
        {summary && <span className="activity-summary-detail">· {summary}</span>}
      </button>

      {live && !open && current && (
        <div className={`activity-current activity-current--${current.status}`}>
          <CurrentIcon size={13} aria-hidden="true" />
          <span className={current.kind === "command" ? "activity-step-label activity-step-label--code" : "activity-step-label"} title={current.label}>
            {current.label}
          </span>
          <StepStatus step={current} />
        </div>
      )}

      {open && (
        <ol className="activity-steps">
          {steps.map((step) => {
            const Icon = KIND_ICONS[step.kind] || Wrench;
            return (
              <li key={step.id} className={`activity-step activity-step--${step.status}`}>
                <Icon size={13} className="activity-step-icon" aria-hidden="true" />
                <span className={step.kind === "command" ? "activity-step-label activity-step-label--code" : "activity-step-label"} title={step.label}>
                  {step.label}
                </span>
                <span className="activity-step-meta">
                  <StepStatus step={step} />
                  {step.status !== "running" && Number.isFinite(step.durationMs) && step.durationMs >= 1000 && (
                    <span className="activity-step-duration">{formatDuration(step.durationMs)}</span>
                  )}
                  {Number.isInteger(step.auditSeq) && onOpenAudit && (
                    <button
                      type="button"
                      className="activity-audit-link"
                      onClick={() => onOpenAudit(step.auditSeq)}
                      title="Open this command in the audit trail"
                      aria-label={`Open audit entry ${step.auditSeq}`}
                    >
                      <ShieldCheck size={12} aria-hidden="true" />#{step.auditSeq}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
