import { Download, RotateCw, X } from "lucide-react";

export default function UpdateBanner({ updateBanner, onDismiss }) {
  if (!updateBanner) {
    return null;
  }

  const ready = updateBanner.state === "ready";

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-text">
        <strong>{ready ? `Cortex ${updateBanner.version} is ready` : `Cortex ${updateBanner.version} is available`}</strong>
        <span>{ready ? "Restart to finish installing." : "Download it now; it installs when you restart."}</span>
      </div>
      <div className="update-banner-actions">
        {ready ? (
          <button type="button" className="primary-button composer-send" onClick={() => window.desktopApi?.updaterInstall?.()}>
            <RotateCw size={14} aria-hidden="true" />
            Restart now
          </button>
        ) : (
          <button type="button" className="primary-button composer-send" onClick={() => window.desktopApi?.updaterDownload?.()}>
            <Download size={14} aria-hidden="true" />
            Download
          </button>
        )}
        <button type="button" className="icon-button" onClick={onDismiss} title="Not now" aria-label="Not now">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
