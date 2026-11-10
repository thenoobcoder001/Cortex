// Banner listing mobile devices waiting for pairing approval.
export default function PairingRequestsBanner({
  pendingPairingDevices,
  pairingActionLoading,
  handleApprovePairingDevice,
  handleRejectPairingDevice,
}) {
  return (
    <div className="recovery-banner" style={{ display: "grid", gap: 10 }}>
      <div>
        Mobile pairing request{pendingPairingDevices.length > 1 ? "s" : ""} waiting for approval.
      </div>
      {pendingPairingDevices.map((deviceId) => (
        <div
          key={deviceId}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            borderRadius: 8,
            background: "rgba(255,255,255,0.06)",
          }}
        >
          <span style={{ flex: 1, fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
            {deviceId}
          </span>
          <button
            type="button"
            className="primary-button"
            style={{ padding: "4px 12px", fontSize: 12 }}
            disabled={pairingActionLoading[deviceId]}
            onClick={() => void handleApprovePairingDevice(deviceId)}
          >
            Approve
          </button>
          <button
            type="button"
            className="danger-button"
            style={{ padding: "4px 12px", fontSize: 12 }}
            disabled={pairingActionLoading[deviceId]}
            onClick={() => void handleRejectPairingDevice(deviceId)}
          >
            Reject
          </button>
        </div>
      ))}
    </div>
  );
}
