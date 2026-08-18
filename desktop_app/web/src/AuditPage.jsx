import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./audit.css";

const ACTION_LABELS = {
  create: "Created",
  edit: "Edited",
  delete: "Deleted",
  rename: "Renamed",
  run_command: "Command",
};

function entrySubject(entry) {
  if (entry.command) return entry.command;
  if (entry.old_path || entry.new_path) return `${entry.old_path || "?"} → ${entry.new_path || "?"}`;
  return entry.path || entry.detail || "No additional details";
}

export default function AuditPage({ backendUrl, repoRoot, onBack }) {
  const [entries, setEntries] = useState([]);
  const [chain, setChain] = useState({ ok: true, brokenAtSeq: null });
  const [action, setAction] = useState("");
  const [provider, setProvider] = useState("");
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
          <button type="button" className="audit-back" onClick={onBack}>← Back to workspace</button>
          <h1>Audit trail</h1>
          <p title={repoRoot}>{repoRoot}</p>
        </div>
        <div className="audit-header-actions">
          <span className={chain.ok ? "audit-chain audit-chain--ok" : "audit-chain audit-chain--broken"}>
            {chain.ok ? "Chain verified" : `Chain broken at #${chain.brokenAtSeq ?? "?"}`}
          </span>
          <button type="button" className="secondary-button" onClick={() => void exportJsonl()}>Export JSONL</button>
        </div>
      </header>

      <section className="audit-toolbar" aria-label="Audit filters">
        <select value={action} onChange={(event) => setAction(event.target.value)}>
          <option value="">All actions</option>
          <option value="create">Created files</option>
          <option value="edit">Edited files</option>
          <option value="delete">Deleted files</option>
          <option value="rename">Renamed files</option>
          <option value="run_command">Commands</option>
        </select>
        <select value={provider} onChange={(event) => setProvider(event.target.value)}>
          <option value="">All providers</option>
          {providers.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button type="button" className="secondary-button" onClick={() => void loadEntries()}>Refresh</button>
        <span className="audit-count">{entries.length} {entries.length === 1 ? "event" : "events"}</span>
      </section>

      {error && <div className="error-banner">{error}</div>}
      <section className="audit-timeline" aria-live="polite">
        {loading && <div className="audit-empty">Loading audit events…</div>}
        {!loading && !entries.length && <div className="audit-empty">No agent actions match these filters yet.</div>}
        {!loading && entries.map((entry) => (
          <article className="audit-event" key={entry.hash || `${entry.ts}-${entry.seq}`}>
            <div className={`audit-event-marker audit-event-marker--${entry.success ? "success" : "failure"}`} />
            <div className="audit-event-body">
              <div className="audit-event-heading">
                <strong>{ACTION_LABELS[entry.action] || entry.action || "Agent action"}</strong>
                <time dateTime={entry.ts}>{new Date(entry.ts).toLocaleString()}</time>
              </div>
              <code className="audit-subject">{entrySubject(entry)}</code>
              <div className="audit-meta">
                {entry.provider && <span>{entry.provider}</span>}
                {entry.model && <span>{entry.model}</span>}
                {entry.exit_code !== null && <span>exit {entry.exit_code}</span>}
                <span>#{entry.seq}</span>
              </div>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
