import { useEffect, useRef, useState } from "react";
import { FALLBACK_APP_VERSION } from "../app/constants.js";

// Text and visibility for the boot splash shown while the backend starts.
export default function useBootSplash({ snapshot, error }) {
  const bootStartedAtRef = useRef(Date.now());
  const [bootDismissed, setBootDismissed] = useState(false);

  const splashVisible = !bootDismissed || !snapshot;
  const appVersion = snapshot?.app?.version || FALLBACK_APP_VERSION;
  const bootHeadline = error
    ? "Startup interrupted"
    : snapshot
      ? "Workspace synchronized"
      : "Activating your local AI workstation";
  const bootMessage = error
    ? error
    : snapshot
      ? "Session state restored. Opening the workspace shell."
      : "Bringing up the local backend, rehydrating project state, and staging the desktop shell.";
  const bootStatusText = error
    ? "Error"
    : snapshot
      ? "Ready"
      : "Starting backend";

  useEffect(() => {
    if (!snapshot || error) {
      return;
    }
    const remaining = Math.max(0, 400 - (Date.now() - bootStartedAtRef.current));
    const dismissTimer = window.setTimeout(() => {
      setBootDismissed(true);
    }, remaining);
    return () => {
      window.clearTimeout(dismissTimer);
    };
  }, [error, snapshot]);

  return { appVersion, bootDismissed, bootHeadline, bootMessage, bootStatusText, splashVisible };
}
