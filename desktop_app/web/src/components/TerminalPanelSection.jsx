import XtermPanel from "../XtermPanel.jsx";
import { projectLabel, stripAnsi } from "../app/utils.js";

export default function TerminalPanelSection({
  activeTerminalChatId,
  backendUrl,
  liveTermWriteRef,
  onClose,
  onRefresh,
  onRunCommand,
  onSwitchToLive,
  onToggle,
  repoRoot,
  setTerminalDraft,
  setTerminalViewMode,
  terminalDraft,
  terminalOutputRef,
  terminalPanelOpen,
  terminalSnapshot,
  terminalViewMode,
}) {
  if (!terminalPanelOpen) {
    return null;
  }

  return (
    <section className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-header-left">
          <div className="terminal-kicker">Terminal</div>
          <div className="terminal-title">
            {terminalSnapshot?.status === "running" ? "Running" : "Ready"} · {projectLabel(repoRoot)}
          </div>
        </div>
        <div className="terminal-actions">
          <div className="terminal-view-toggle">
            <button
              type="button"
              className={terminalViewMode === "chat" ? "terminal-view-btn active" : "terminal-view-btn"}
              onClick={() => setTerminalViewMode("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              className={terminalViewMode === "live" ? "terminal-view-btn active" : "terminal-view-btn"}
              onClick={() => void onSwitchToLive()}
            >
              Live
            </button>
          </div>
          {terminalViewMode === "chat" && (
            <button type="button" className="secondary-button" onClick={() => void onRefresh()}>
              Refresh
            </button>
          )}
          <button type="button" className="secondary-button" onClick={() => void onClose()}>
            Close
          </button>
          <button
            type="button"
            className="terminal-expand-btn"
            onClick={() => void onToggle()}
            title={terminalPanelOpen ? "Collapse terminal" : "Expand terminal"}
          >
            {terminalPanelOpen ? "▲" : "▼"}
          </button>
        </div>
      </div>
      {terminalPanelOpen && activeTerminalChatId && (
        <div
          style={
            terminalViewMode !== "live"
              ? {
                  position: "absolute",
                  visibility: "hidden",
                  pointerEvents: "none",
                  width: "1px",
                  height: "1px",
                  overflow: "hidden",
                }
              : {}
          }
        >
          <XtermPanel
            backendUrl={backendUrl}
            chatId={activeTerminalChatId}
            repoRoot={repoRoot || ""}
            onReady={(writeFn) => {
              liveTermWriteRef.current = writeFn;
            }}
            onUnmount={() => {
              liveTermWriteRef.current = null;
            }}
          />
        </div>
      )}
      {terminalPanelOpen && terminalViewMode === "chat" && (
        <div className="terminal-output" ref={terminalOutputRef}>
          {terminalSnapshot?.history ? (
            stripAnsi(terminalSnapshot.history)
          ) : (
            <span className="terminal-placeholder-inline">
              Open this thread terminal, then run commands in the selected workspace.
            </span>
          )}
        </div>
      )}
      {terminalViewMode === "chat" && (
        <div className="terminal-command-row">
          <input
            value={terminalDraft}
            onChange={(event) => setTerminalDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onRunCommand();
              }
            }}
            placeholder="Run a command in the workspace..."
          />
          <button type="button" className="primary-button" onClick={() => void onRunCommand()}>
            Run
          </button>
        </div>
      )}
    </section>
  );
}
