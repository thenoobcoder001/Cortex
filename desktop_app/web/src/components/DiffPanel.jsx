import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Undo2, X } from "lucide-react";
import { postJson } from "../app/api.js";
import "../diff.css";

const ACTION_LETTER = { added: "A", modified: "M", deleted: "D" };
// Expand every file by default unless the turn touched a lot of them.
const AUTO_EXPAND_FILE_LIMIT = 8;

// Unified diff text -> rows with old/new line numbers for rendering.
function parseUnifiedDiff(text) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of String(text || "").split("\n")) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
    if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = match ? Number(match[1]) : 0;
      newLine = match ? Number(match[2]) : 0;
      rows.push({ kind: "hunk", text: raw });
      continue;
    }
    const sign = raw[0];
    const content = raw.slice(1).replace(/\r$/, "");
    if (sign === "+") {
      rows.push({ kind: "add", oldNo: "", newNo: newLine, text: content });
      newLine += 1;
    } else if (sign === "-") {
      rows.push({ kind: "del", oldNo: oldLine, newNo: "", text: content });
      oldLine += 1;
    } else if (sign === " ") {
      rows.push({ kind: "ctx", oldNo: oldLine, newNo: newLine, text: content });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

function FileDiffBody({ file }) {
  const rows = useMemo(() => parseUnifiedDiff(file.diff), [file.diff]);
  if (file.binary) return <div className="tdiff-file-note">Binary file, not shown.</div>;
  if (file.tooLarge) return <div className="tdiff-file-note">Diff too large to show.</div>;
  if (!rows.length) return <div className="tdiff-file-note">No line changes (whitespace or line endings only).</div>;
  return (
    <div className="tdiff-table" role="table">
      {rows.map((row, index) => (
        row.kind === "hunk" ? (
          <div key={index} className="tdiff-row tdiff-hunk" role="row">{row.text}</div>
        ) : (
          <div key={index} className={`tdiff-row tdiff-${row.kind}`} role="row">
            <span className="tdiff-no">{row.oldNo}</span>
            <span className="tdiff-no">{row.newNo}</span>
            <span className="tdiff-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}</span>
            <span className="tdiff-text">{row.text}</span>
          </div>
        )
      ))}
    </div>
  );
}

export default function DiffPanel({ backendUrl, chatId, repoRoot, turnId, onClose, onSnapshot }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [collapsed, setCollapsed] = useState({});
  const [confirming, setConfirming] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRefs = useRef({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ chatId, turnId, repoRoot: repoRoot || "" });
      const response = await fetch(`${backendUrl}/api/turns/diff?${query}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
      setData(body);
      setCollapsed(Object.fromEntries(body.files.map((file) => [file.path, body.files.length > AUTO_EXPAND_FILE_LIMIT])));
    } catch (nextError) {
      setError(String(nextError?.message || nextError));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [backendUrl, chatId, repoRoot, turnId]);

  useEffect(() => {
    setConfirming("");
    setNotice("");
    void load();
  }, [load]);

  const revert = async (filePath = null) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await postJson(backendUrl, "/api/turns/revert", {
        chatId, turnId, repoRoot, ...(filePath ? { path: filePath } : {}),
      });
      setData(result.turn);
      if (result.snapshot) onSnapshot?.(result.snapshot);
      setNotice(result.reverted.length === 1 ? `Reverted ${result.reverted[0]}.` : `Reverted ${result.reverted.length} files.`);
    } catch (nextError) {
      setError(String(nextError?.message || nextError));
      // Refresh so files that changed since show why they can't be reverted.
      void load();
    } finally {
      setBusy(false);
      setConfirming("");
    }
  };

  const files = data?.files || [];
  const pending = files.filter((file) => file.status !== "reverted");
  const canRevertTurn = pending.length > 0 && pending.every((file) => file.revertable);
  const summary = data?.summary;

  const jumpTo = (filePath) => {
    setCollapsed((current) => ({ ...current, [filePath]: false }));
    window.requestAnimationFrame(() => fileRefs.current[filePath]?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const allCollapsed = files.length > 0 && files.every((file) => collapsed[file.path]);

  return (
    <aside
      className="tdiff-panel"
      aria-label="Turn changes"
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <header className="tdiff-panel-header">
        <div className="tdiff-panel-title">
          <strong>Turn changes</strong>
          {summary && (
            <span className="tdiff-panel-stats">
              {summary.files === 1 ? "1 file" : `${summary.files} files`}
              <span className="turn-changes-add">+{summary.additions}</span>
              <span className="turn-changes-del">−{summary.deletions}</span>
            </span>
          )}
        </div>
        <div className="tdiff-panel-actions">
          {files.length > 1 && (
            <button
              type="button"
              className="tdiff-btn"
              onClick={() => setCollapsed(Object.fromEntries(files.map((file) => [file.path, !allCollapsed])))}
            >
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          )}
          {pending.length > 0 && (
            confirming === "*" ? (
              <>
                <button type="button" className="tdiff-btn danger" disabled={busy} onClick={() => void revert()}>
                  {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Undo2 size={13} aria-hidden="true" />}
                  Confirm revert
                </button>
                <button type="button" className="tdiff-btn" disabled={busy} onClick={() => setConfirming("")}>Cancel</button>
              </>
            ) : (
              <button
                type="button"
                className="tdiff-btn"
                disabled={!canRevertTurn || busy}
                title={canRevertTurn ? "Restore every file to how it was before this turn" : "Some files can't be reverted (see below)"}
                onClick={() => setConfirming("*")}
              >
                <Undo2 size={13} aria-hidden="true" />
                Revert this turn
              </button>
            )
          )}
          <button type="button" className="tdiff-icon-btn" onClick={onClose} aria-label="Close diff panel">
            <X size={16} />
          </button>
        </div>
      </header>

      {error && <div className="tdiff-panel-error" role="alert">{error}</div>}
      {notice && <div className="tdiff-panel-notice" role="status">{notice}</div>}

      {loading && !data ? (
        <div className="tdiff-panel-empty"><Loader2 size={16} className="spin" aria-hidden="true" /> Loading changes…</div>
      ) : (
        <div className="tdiff-panel-body">
          <ul className="tdiff-file-list">
            {files.map((file) => (
              <li key={file.path}>
                <button type="button" className={`tdiff-file-link${file.status === "reverted" ? " reverted" : ""}`} onClick={() => jumpTo(file.path)}>
                  <span className={`tdiff-action tdiff-action-${file.action}`}>{ACTION_LETTER[file.action] || "?"}</span>
                  <span className="tdiff-file-path">{file.path}</span>
                  <span className="turn-changes-add">+{file.additions}</span>
                  <span className="turn-changes-del">−{file.deletions}</span>
                </button>
              </li>
            ))}
          </ul>

          {files.map((file) => {
            const isCollapsed = Boolean(collapsed[file.path]);
            return (
              <section key={file.path} className="tdiff-file" ref={(node) => { fileRefs.current[file.path] = node; }}>
                <div className="tdiff-file-header">
                  <button
                    type="button"
                    className="tdiff-file-toggle"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((current) => ({ ...current, [file.path]: !isCollapsed }))}
                  >
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span className={`tdiff-action tdiff-action-${file.action}`}>{ACTION_LETTER[file.action] || "?"}</span>
                    <span className="tdiff-file-path">{file.path}</span>
                    <span className="turn-changes-add">+{file.additions}</span>
                    <span className="turn-changes-del">−{file.deletions}</span>
                  </button>
                  {file.status === "reverted" ? (
                    <span className="turn-changes-reverted">Reverted</span>
                  ) : confirming === file.path ? (
                    <>
                      <button type="button" className="tdiff-btn danger" disabled={busy} onClick={() => void revert(file.path)}>Confirm</button>
                      <button type="button" className="tdiff-btn" disabled={busy} onClick={() => setConfirming("")}>Cancel</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="tdiff-btn"
                      disabled={!file.revertable || busy}
                      title={file.revertable ? "Restore this file to how it was before this turn" : file.blockedReason}
                      onClick={() => setConfirming(file.path)}
                    >
                      Revert file
                    </button>
                  )}
                </div>
                {file.blockedReason && file.status !== "reverted" && (
                  <div className="tdiff-file-blocked">{file.blockedReason}</div>
                )}
                {!isCollapsed && <FileDiffBody file={file} />}
              </section>
            );
          })}
        </div>
      )}
    </aside>
  );
}
