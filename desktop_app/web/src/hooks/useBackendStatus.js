import { useEffect } from "react";
import { loadSavedProjects, readDesktopConfig } from "../app/utils.js";

// Startup handshake with the local backend plus /api/status polling while a
// chat is running. Snapshot / backendUrl state itself is owned by App.
export default function useBackendStatus({
  backendUrl,
  setBackendUrl,
  setSnapshot,
  setRepoDraft,
  setError,
  setRemoteAccessEnabledDraft,
  setRemoteAccessUrls,
  syncSavedProjects,
  fetchProjectChats,
  refreshPairingRequests,
  runningChatIds,
  sendingChatIds,
}) {
  const applyDesktopConfig = (config) => {
    setBackendUrl(config?.backendUrl || "");
    setRemoteAccessEnabledDraft(Boolean(config?.remoteAccessEnabled));
    setRemoteAccessUrls(Array.isArray(config?.remoteAccessUrls) ? config.remoteAccessUrls : []);
  };

  const refreshStatus = async (urlOverride) => {
    const targetUrl = urlOverride || backendUrl;
    if (!targetUrl) return;
    const response = await fetch(`${targetUrl}/api/status`);
    if (!response.ok) {
      throw new Error(`Status request failed (${response.status})`);
    }
    const nextSnapshot = await response.json();
    setSnapshot(nextSnapshot);
    setRepoDraft(nextSnapshot.config.repoRoot);
    syncSavedProjects(nextSnapshot.config.repoRoot);
  };

  useEffect(() => {
    let alive = true;
    readDesktopConfig()
      .then(async (config) => {
        if (!alive) return;
        applyDesktopConfig(config);
        await refreshStatus(config.backendUrl);
        await refreshPairingRequests(config.backendUrl).catch(() => []);
        const initialProjects = loadSavedProjects();
        await Promise.all(
          [...new Set(initialProjects.map((project) => project.path))]
            .filter(Boolean)
            .map((repoRoot) => fetchProjectChats(repoRoot, config.backendUrl).catch(() => [])),
        );
      })
      .catch((nextError) => {
        if (!alive) return;
        setError(String(nextError));
      });
    return () => {
      alive = false;
    };
  // Runs once on mount; the helpers are recreated each render and must not restart it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!backendUrl || (runningChatIds.length === 0 && sendingChatIds.length === 0)) {
      return undefined;
    }
    let alive = true;
    const tick = async () => {
      try {
        if (alive) {
          await refreshStatus();
        }
      } catch {
        // Resource polling should not interrupt the active chat stream.
      }
    };
    const interval = window.setInterval(() => void tick(), 2500);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  // refreshStatus is recreated each render; listing it would reset the interval every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, runningChatIds.length, sendingChatIds.length]);

  return { applyDesktopConfig, refreshStatus };
}
