import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, Ban, CircleAlert, Download, FilePen, FilePlus, FileSearch, FileUp, FileX, FolderPlus, History,
  RefreshCw, Replace, ShieldAlert, ShieldCheck, ShieldX, SquareTerminal, TriangleAlert,
} from "lucide-react";
import { AUDIT_ACTIONS, AUDIT_STATUS_BADGES, auditActionInfo, auditEntryLabel, auditEntryStatus, middleTruncate } from "./app/auditActions.js";
import "./audit.css";

const ICONS = { FilePen, FilePlus, FileSearch, FileUp, FileX, FolderPlus, Replace, ShieldX, SquareTerminal, TriangleAlert };
const STATUS_ICONS = { blocked: Ban, failed: CircleAlert, incomplete: TriangleAlert };
const PATH_MAX = 72;

function PathText({ value }) {
  const short = middleTruncate(value, PATH_MAX);
  return <span title={short === value ? undefined : value}>{short}</span>;
}

function EntrySubject({ entry }) {
  if (entry.command) return <span title={entry.command}>{entry.command}</span>;
  if (entry.old_path || entry.new_path) {
    return (
      <>
        <PathText value={entry.old_path || "?"} />
        {" → "}
        <PathText value={entry.new_path || "?"} />
      </>
    );
  }
  if (entry.path) return <PathText value={entry.path} />;
  return <span>{entry.detail || "No additional details"}</span>;
}

export default function AuditPage({ backendUrl, repoRoot, onBack }) {
  const [entries, setEntries] = useState([]);
  const [chain, setChain] = useState({ ok: true, brokenAtSeq: null });
  const [action, setAction] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadEntries = useCallback(async () => {
    if (!backendUrl || !repoRoot) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ repoRoot, limit: "500" });
      if (action) params.set("action", action);
      if (provider) params.set("provider", provider);
      const response = await fetch(`${backendUrl}/api/audit?${params}`);
      if (!response.ok) throw new Error((await response.json()).detail || "Unable to load audit trail");
      const data = await response.json();
      setEntries(data.entries || []);
      setChain(data.chain || { ok: true, brokenAtSeq: null });
    } catch (nextError) {
      setError(String(nextError?.message || nextError));
    } finally {
      setLoading(false);
    }
  }, [action, backendUrl, provider, repoRoot]);

  useEffect(() => { void loadEntries(); }, [loadEntries]);

  const providers = useMemo(
    () => [...new Set(entries.map((entry) => entry.provider).filter(Boolean))].sort(),
    [entries],
  );

  // The API filters by action and provider; outcome is filtered here.
  const visibleEntries = useMemo(
    () => (status ? entries.filter((entry) => (auditEntryStatus(entry) === "ok") === (status === "ok")) : entries),
    [entries, status],
  );

  const exportJsonl = async () => {
    const params = new URLSearchParams({ repoRoot });
    const response = await fetch(`${backendUrl}/api/audit/export?${params}`);
    if (!response.ok) {
      setError("Unable to export the audit trail");
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `cortex-audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="audit-screen">
      <header className="audit-header">
        <div>
          <button type="button" className="settings-nav-back" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back
          </button>
          <h1>Audit trail</h1>
          <p title={repoRoot}>{repoRoot}</p>
        </div>
        <div className="audit-header-actions">
          <span className={chain.ok ? "audit-chain audit-chain--ok" : "audit-chain audit-chain--broken"}>
            {chain.ok ? <ShieldCheck size={14} aria-hidden="true" /> : <ShieldAlert size={14} aria-hidden="true" />}
            {chain.ok ? "Chain verified" : `Chain broken at #${chain.brokenAtSeq ?? "?"}`}
          </span>
          <button type="button" className="secondary-button audit-button" onClick={() => void exportJsonl()} disabled={!entries.length && !action && !provider}>
            <Download size={15} aria-hidden="true" />
            Export JSONL
          </button>
        </div>
      </header>

      <section className="audit-toolbar" aria-label="Audit filters">
        <select value={action} onChange={(event) => setAction(event.target.value)}>
          <option value="">All actions</option>
          {AUDIT_ACTIONS.map((item) => <option key={item.id} value={item.id}>{item.filter}</option>)}
        </select>
        <select value={provider} onChange={(event) => setProvider(event.target.value)}>
          <option value="">All providers</option>
          {providers.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Outcome">
          <option value="">All outcomes</option>
          <option value="ok">Succeeded</option>
          <option value="problem">Blocked or failed</option>
        </select>
        <button type="button" className="icon-button" onClick={() => void loadEntries()} title="Refresh" aria-label="Refresh">
          <RefreshCw size={16} aria-hidden="true" />
        </button>
        <span className="audit-count">{visibleEntries.length} {visibleEntries.length === 1 ? "event" : "events"}</span>
      </section>

      {error && <div className="error-banner">{error}</div>}
      <section className="audit-timeline" aria-live="polite">
        {loading && <div className="audit-empty">Loading audit events…</div>}
        {!loading && !visibleEntries.length && (
          <div className="audit-empty">
            <History size={28} className="audit-empty-icon" aria-hidden="true" />
            {action || provider || status ? (
              <>
                <h2>No events match these filters</h2>
                <p>Try "All actions", "All providers" and "All outcomes".</p>
              </>
            ) : (
              <>
                <h2>No agent actions yet</h2>
                <p>
                  File changes from every finished chat turn show up here, including Claude Code and Codex turns: Cortex compares the
                  project before and after each turn. Commands are logged when they run in the built-in terminal or through Cortex's
                  own tools (API-key models); commands Claude Code or Codex run inside their own CLI are not. Blocked attempts are
                  logged too. Each event is chained to the one before it, so any later edit to the log is detected.
                </p>
              </>
            )}
          </div>
        )}
        {!loading && visibleEntries.map((entry) => {
          const entryStatus = auditEntryStatus(entry);
          const Icon = ICONS[auditActionInfo(entry.action)?.icon];
          const StatusIcon = STATUS_ICONS[entryStatus];
          return (
            <article className={`audit-event audit-event--${entryStatus}`} key={entry.hash || `${entry.ts}-${entry.seq}`}>
              <div className={`audit-event-marker audit-event-marker--${entryStatus === "ok" ? "success" : "failure"}`} />
              <div className="audit-event-body">
                <div className="audit-event-heading">
                  <strong className="audit-event-title">
                    {Icon && <Icon size={15} aria-hidden="true" />}
                    {auditEntryLabel(entry)}
                    {StatusIcon && (
                      <span className={`audit-status-badge audit-status-badge--${entryStatus}`}>
                        <StatusIcon size={12} aria-hidden="true" />
                        {AUDIT_STATUS_BADGES[entryStatus]}
                      </span>
                    )}
                  </strong>
                  <time dateTime={entry.ts}>{new Date(entry.ts).toLocaleString()}</time>
                </div>
                <code className="audit-subject"><EntrySubject entry={entry} /></code>
                {entry.detail && (entry.path || entry.command || entry.old_path || entry.new_path) && (
                  <p className="audit-detail">{entry.detail}</p>
                )}
                <div className="audit-meta">
                  {entry.source && <span>{entry.source}</span>}
                  {entry.provider && <span>{entry.provider}</span>}
                  {entry.model && <span>{entry.model}</span>}
                  {entry.exit_code != null && <span>exit {entry.exit_code}</span>}
                  <span>#{entry.seq}</span>
                </div>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
