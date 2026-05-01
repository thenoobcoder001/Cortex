export default function BootScreen({
  appVersion,
  bootDismissed = false,
  bootHeadline,
  bootMessage,
  bootStatusText,
  error,
  overlay = false,
  snapshot,
  workspaceLabel = "PENDING",
}) {
  const content = (
    <div className="boot-container">
      <div className="boot-main">
        <div className="boot-glow"></div>

        <div className="boot-hex-wrap">
          <div className="boot-hex">
            <div className="boot-hex-inner"></div>
          </div>
        </div>

        <div className="boot-content">
          <div className="boot-badge">{error ? "SYSTEM HALTED" : "BOOT PROTOCOL"}</div>
          <h1 className="boot-title">{bootHeadline}</h1>
          <p className="boot-subtitle">{bootMessage}</p>
        </div>

        <div className="boot-progress-wrap">
          <div className="boot-progress-track">
            <div className="boot-progress-fill" style={{ width: snapshot ? "100%" : "72%" }}></div>
          </div>
          <div className="boot-progress-labels">
            <span className="boot-status-text">{bootStatusText}</span>
            <span className="boot-percent">{snapshot ? "Ready" : "Loading"}</span>
          </div>
        </div>
      </div>

      <div className="boot-footer">
        <div className="boot-footer-item">
          <span className="label">APP</span>
          <span className="value">Cortex</span>
        </div>
        <div className="boot-footer-item">
          <span className="label">{overlay ? "WORKSPACE" : "ENVIRONMENT"}</span>
          <span className="value">{overlay ? workspaceLabel : "Desktop"}</span>
        </div>
        <div className="boot-footer-item">
          <span className="label">VERSION</span>
          <span className="value">v{appVersion}</span>
        </div>
      </div>
    </div>
  );

  if (overlay) {
    return <div className={bootDismissed ? "boot-overlay fading" : "boot-overlay"}>{content}</div>;
  }

  return <div className="boot-screen">{content}</div>;
}
