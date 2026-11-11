import { useEffect, useState } from "react";

const DISMISSED_UPDATE_KEY = "cortex.dismissed-update";

// Listens for auto-updater status from the Electron shell and tracks the banner.
export default function useUpdateBanner() {
  const [updateBanner, setUpdateBanner] = useState(null); // { version, state }

  useEffect(() => {
    const handler = (s) => {
      if (s.state === "available" || s.state === "ready") {
        let dismissed = "";
        try {
          dismissed = window.localStorage.getItem(DISMISSED_UPDATE_KEY) || "";
        } catch {}
        // A dismissed banner stays dismissed until a newer version (or the "ready" step) arrives.
        if (dismissed === `${s.version}:${s.state}`) return;
        setUpdateBanner({ version: s.version, state: s.state });
      } else if (s.state === "up-to-date") {
        setUpdateBanner(null);
      }
    };
    window.desktopApi?.onUpdateStatus?.(handler);
  }, []);

  const dismissUpdateBanner = () => {
    try {
      window.localStorage.setItem(DISMISSED_UPDATE_KEY, `${updateBanner.version}:${updateBanner.state}`);
    } catch {}
    setUpdateBanner(null);
  };

  return { updateBanner, dismissUpdateBanner };
}
