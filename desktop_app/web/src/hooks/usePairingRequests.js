import { useEffect, useState } from "react";

// Mobile devices waiting for pairing approval, polled every 3s.
export default function usePairingRequests({ backendUrl, postJson, setError }) {
  const [pendingPairingDevices, setPendingPairingDevices] = useState([]);
  const [pairingActionLoading, setPairingActionLoading] = useState({});

  const refreshPairingRequests = async (urlOverride) => {
    const targetUrl = urlOverride || backendUrl;
    if (!targetUrl) {
      setPendingPairingDevices([]);
      return [];
    }
    const response = await fetch(`${targetUrl}/api/cortex/pairing-requests`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || `Pairing request fetch failed (${response.status})`);
    }
    const pending = Array.isArray(data.pending) ? data.pending : [];
    setPendingPairingDevices(pending);
    return pending;
  };

  useEffect(() => {
    if (!backendUrl) {
      setPendingPairingDevices([]);
      return undefined;
    }
    let alive = true;
    const tick = async () => {
      try {
        await refreshPairingRequests();
      } catch {
        if (!alive) {
          return;
        }
      }
    };
    void tick();
    const interval = window.setInterval(() => void tick(), 3000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  // refreshPairingRequests is recreated each render; listing it would reset the interval every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl]);

  const handleApprovePairingDevice = async (deviceId) => {
    setPairingActionLoading((current) => ({ ...current, [deviceId]: true }));
    try {
      await postJson("/api/cortex/approve-device", { deviceId });
      setPendingPairingDevices((current) => current.filter((id) => id !== deviceId));
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setPairingActionLoading((current) => ({ ...current, [deviceId]: false }));
    }
  };

  const handleRejectPairingDevice = async (deviceId) => {
    setPairingActionLoading((current) => ({ ...current, [deviceId]: true }));
    try {
      await postJson("/api/cortex/reject-device", { deviceId });
      setPendingPairingDevices((current) => current.filter((id) => id !== deviceId));
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setPairingActionLoading((current) => ({ ...current, [deviceId]: false }));
    }
  };

  return {
    handleApprovePairingDevice,
    handleRejectPairingDevice,
    pairingActionLoading,
    pendingPairingDevices,
    refreshPairingRequests,
  };
}
