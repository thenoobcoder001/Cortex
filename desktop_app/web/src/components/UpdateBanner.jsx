export default function UpdateBanner({ updateBanner, onDismiss }) {
  if (!updateBanner) {
    return null;
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: updateBanner.state === "ready" ? "#16a34a" : "#2563eb",
        color: "#fff",
        padding: "10px 20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      <span>
        {updateBanner.state === "ready"
          ? `✓ Cortex v${updateBanner.version} downloaded — restart to install`
          : `↑ Cortex v${updateBanner.version} is available`}
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        {updateBanner.state === "available" && (
          <button
            type="button"
            onClick={() => window.desktopApi?.updaterDownload?.()}
            style={{
              background: "#fff",
              color: "#2563eb",
              border: "none",
              borderRadius: 6,
              padding: "4px 12px",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Download
          </button>
        )}
        {updateBanner.state === "ready" && (
          <button
            type="button"
            onClick={() => window.desktopApi?.updaterInstall?.()}
            style={{
              background: "#fff",
              color: "#16a34a",
              border: "none",
              borderRadius: 6,
              padding: "4px 12px",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Restart & Install
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          style={{
            background: "transparent",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.4)",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
