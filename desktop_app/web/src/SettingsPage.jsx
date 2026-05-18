import React, { useEffect, useReducer, useRef, useState } from "react";

function UpdateSection() {
  const [status, setStatus] = useState(null); // { state, version, error, currentVersion }
  const [feedUrl, setFeedUrl] = useState("");
  const [showFeedInput, setShowFeedInput] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    window.desktopApi?.updaterGetStatus?.().then(setStatus).catch(() => {});
    window.desktopApi?.onUpdateStatus?.((s) => setStatus((prev) => ({ ...prev, ...s })));
  }, []);

  async function handleCheck() {
    setLoading(true);
    try { const s = await window.desktopApi?.updaterCheck?.(); if (s) setStatus(s); }
    catch { /* ignore */ } finally { setLoading(false); }
  }

  async function handleDownload() {
    setLoading(true);
    try { await window.desktopApi?.updaterDownload?.(); }
    catch { /* ignore */ } finally { setLoading(false); }
  }

  async function handleInstall() {
    await window.desktopApi?.updaterInstall?.();
  }

  async function handleSaveFeedUrl() {
    if (!feedUrl.trim()) return;
    await window.desktopApi?.updaterSetFeedUrl?.(feedUrl.trim());
    setShowFeedInput(false);
  }

  const state = status?.state || "idle";
  const stateLabel = {
    idle: "Not checked yet",
    checking: "Checking for updates…",
    "up-to-date": "You're on the latest version",
    available: `Update available — v${status?.version}`,
    downloading: `Downloading… ${status?.version}`,
    ready: `Ready to install — v${status?.version}`,
    error: `Error: ${status?.error}`,
  }[state] || state;

  return (
    <section className="settings-section-card">
      <div className="settings-block-title">Updates</div>
      <div className="danger-zone-copy">
        Current version: <strong>{status?.currentVersion || "—"}</strong>
      </div>

      <div className={`provider-test-result ${state === "available" || state === "ready" ? "ok" : state === "error" ? "error" : ""}`}
        style={{ marginBottom: 8 }}>
        {stateLabel}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="secondary-button" disabled={loading || state === "checking"} onClick={handleCheck}>
          {state === "checking" ? "Checking…" : "Check for Updates"}
        </button>
        {state === "available" && (
          <button type="button" className="primary-button" disabled={loading} onClick={handleDownload}>
            Download Update
          </button>
        )}
        {state === "downloading" && (
          <button type="button" className="primary-button" disabled>Downloading…</button>
        )}
        {state === "ready" && (
          <button type="button" className="primary-button" onClick={handleInstall}>
            Restart & Install
          </button>
        )}
      </div>

      <button type="button" className="secondary-button" style={{ marginTop: 4, alignSelf: "flex-start" }}
        onClick={() => setShowFeedInput(!showFeedInput)}>
        {showFeedInput ? "Hide" : "Set Update Server URL"}
      </button>
      {showFeedInput && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <input value={feedUrl} placeholder="https://your-update-server.com/updates"
            onChange={(e) => setFeedUrl(e.target.value)}
            style={{ flex: 1 }} />
          <button type="button" className="primary-button" onClick={handleSaveFeedUrl}>Save</button>
        </div>
      )}
    </section>
  );
}

function CortexRelaySection() {
  const [status, setStatus] = useState(null);
  const [tab, setTab] = useState("signin"); // "signin" | "register"
  const [step, setStep] = useState("form"); // "form" | "verify"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [pendingDevices, setPendingDevices] = useState([]);
  const [approvedDevices, setApprovedDevices] = useState([]);
  const [pairingLoading, setPairingLoading] = useState({});
  const [connectionCheck, setConnectionCheck] = useState({ state: "idle", message: "" });
  const pollRef = useRef(null);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch("http://127.0.0.1:8765/api/cortex/status");
      const s = await res.json();
      if (s.state !== "connected" && s.hasSavedSession) {
        // WS dropped but we have saved credentials — reconnect silently
        fetch("http://127.0.0.1:8765/api/cortex/reconnect", { method: "POST" })
          .then(r => r.json())
          .then(d => { if (d.connected) setStatus({ state: "connected", deviceId: d.deviceId, socketId: d.socketId }); })
          .catch(() => {});
        // Keep showing connected while reconnecting
        setStatus(prev => prev?.state === "connected" ? prev : { state: "reconnecting", deviceId: null, socketId: null });
      } else {
        setStatus(s);
      }
    } catch { /* ignore */ }
    // Poll for pending and approved devices
    try {
      const res = await fetch("http://127.0.0.1:8765/api/cortex/pairing-requests");
      const data = await res.json();
      setPendingDevices(data.pending || []);
      setApprovedDevices(data.approved || []);
    } catch { /* ignore */ }
  }

  async function handleApprove(deviceId) {
    setPairingLoading(prev => ({ ...prev, [deviceId]: true }));
    try {
      await fetch("http://127.0.0.1:8765/api/cortex/approve-device", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      setPendingDevices(prev => prev.filter(id => id !== deviceId));
    } catch { /* ignore */ }
    finally { setPairingLoading(prev => ({ ...prev, [deviceId]: false })); }
  }

  async function handleReject(deviceId) {
    setPairingLoading(prev => ({ ...prev, [deviceId]: true }));
    try {
      await fetch("http://127.0.0.1:8765/api/cortex/reject-device", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      setPendingDevices(prev => prev.filter(id => id !== deviceId));
    } catch { /* ignore */ }
    finally { setPairingLoading(prev => ({ ...prev, [deviceId]: false })); }
  }

  async function handleRemove(deviceId) {
    setPairingLoading(prev => ({ ...prev, [deviceId]: true }));
    try {
      await fetch("http://127.0.0.1:8765/api/cortex/remove-device", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      setApprovedDevices(prev => prev.filter(id => id !== deviceId));
    } catch { /* ignore */ }
    finally { setPairingLoading(prev => ({ ...prev, [deviceId]: false })); }
  }

  function reset() { setEmail(""); setPassword(""); setCode(""); setError(""); setInfo(""); setStep("form"); }
  function switchTab(t) { setTab(t); reset(); }

  async function handleSignIn() {
    const trimEmail = email.trim();
    const trimPass  = password.trim();
    if (!trimEmail || !trimPass) { setError("Enter email and password."); return; }
    setLoading(true); setError(""); setInfo("");
    try {
      const res = await fetch("http://127.0.0.1:8765/api/cortex/send-verification", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimEmail, password: trimPass }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Sign in failed");
      if (data.connected) {
        setStatus({ state: "connected", deviceId: data.deviceId, socketId: data.socketId });
        reset();
        return;
      }
      // Server returned a message but no token — shouldn't happen on sign-in
      throw new Error(data.detail || "Unexpected response from server");
    } catch (err) { setError(err.message || "Sign in failed."); }
    finally { setLoading(false); }
  }

  async function handleRegister() {
    const trimEmail = email.trim();
    const trimPass  = password.trim();
    if (!trimEmail || !trimPass) { setError("Enter email and password."); return; }
    setLoading(true); setError(""); setInfo("");
    try {
      const res = await fetch("http://127.0.0.1:8765/api/cortex/send-verification", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimEmail, password: trimPass }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Registration failed");
      setInfo(data.message || "Verification code sent.");
      setStep("verify");
    } catch (err) { setError(err.message || "Registration failed."); }
    finally { setLoading(false); }
  }

  async function handleVerify() {
    if (!code.trim()) { setError("Enter the verification code."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("http://127.0.0.1:8765/api/cortex/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Verification failed");
      setStatus({ state: "connected", deviceId: data.deviceId, socketId: data.socketId });
      reset();
    } catch (err) { setError(err.message || "Verification failed."); }
    finally { setLoading(false); }
  }

  async function handleDisconnect() {
    setLoading(true);
    try {
      await fetch("http://127.0.0.1:8765/api/cortex/disconnect", { method: "POST" });
      await window.desktopApi?.cortexDisconnect?.();
      setStatus({ state: "disconnected", deviceId: null, socketId: null });
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  async function handleRefreshConnection() {
    setConnectionCheck({ state: "checking", message: "Verifying relay connection..." });
    try {
      const res = await fetch("http://127.0.0.1:8765/api/cortex/probe", { method: "POST" });
      const result = await res.json();

      if (result?.verified) {
        setStatus((prev) => ({ ...(prev || {}), ...result }));
        setConnectionCheck({
          state: "ok",
          message: `Verified just now · Device ID: ${result.deviceId || status?.deviceId || "—"}`,
        });
      } else {
        setStatus((prev) => ({ ...(prev || {}), ...result }));
        setConnectionCheck({ state: "error", message: result?.detail || "Relay is not connected." });
      }
    } catch (err) {
      setConnectionCheck({
        state: "error",
        message: err?.message || "Relay verification failed.",
      });
    }
  }

  const connected = status?.state === "connected";
  const reconnecting = status?.state === "reconnecting";

  return (
    <section className="settings-section-card">
      <div className="settings-block-title">Cortex Relay</div>
      {!connected && (
        <div className="danger-zone-copy">
          Connect this desktop to the Cortex relay so mobile devices can reach it over any network.
        </div>
      )}

      {connected ? (
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <button
              type="button"
              className="secondary-button"
              style={{ padding: "6px 12px" }}
              disabled={connectionCheck.state === "checking"}
              onClick={() => void handleRefreshConnection()}
            >
              {connectionCheck.state === "checking" ? "Checking..." : "Refresh connection"}
            </button>
            {connectionCheck.message && (
              <div
                className={
                  connectionCheck.state === "ok"
                    ? "provider-test-result ok"
                    : connectionCheck.state === "error"
                      ? "provider-test-result error"
                      : "provider-test-result"
                }
                style={{ marginBottom: 0, flex: 1, minWidth: 220 }}
              >
                {connectionCheck.message}
              </div>
            )}
          </div>
          <div className="provider-test-result ok" style={{ marginBottom: 10 }}>
            {`Connected · Device ID: ${status.deviceId || "—"}`}
          </div>

          {pendingDevices.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="settings-block-title" style={{ fontSize: 13, marginBottom: 6 }}>
                Pairing Requests
              </div>
              {pendingDevices.map(deviceId => (
                <div key={deviceId} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "8px 10px", background: "var(--surface-1, #1e1e1e)", borderRadius: 6 }}>
                  <span style={{ flex: 1, fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
                    {deviceId}
                  </span>
                  <button
                    type="button"
                    className="primary-button"
                    style={{ padding: "4px 12px", fontSize: 12 }}
                    disabled={pairingLoading[deviceId]}
                    onClick={() => handleApprove(deviceId)}
                  >
                    Allow
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    style={{ padding: "4px 12px", fontSize: 12 }}
                    disabled={pairingLoading[deviceId]}
                    onClick={() => handleReject(deviceId)}
                  >
                    Block
                  </button>
                </div>
              ))}
            </div>
          )}

          {approvedDevices.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="settings-block-title" style={{ fontSize: 13, marginBottom: 6 }}>
                Approved Devices
              </div>
              {approvedDevices.map(deviceId => (
                <div key={deviceId} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "8px 10px", background: "var(--surface-1, #1e1e1e)", borderRadius: 6 }}>
                  <span style={{ flex: 1, fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
                    {deviceId}
                  </span>
                  <button
                    type="button"
                    className="danger-button"
                    style={{ padding: "4px 12px", fontSize: 12 }}
                    disabled={pairingLoading[deviceId]}
                    onClick={() => handleRemove(deviceId)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <button type="button" className="danger-button" disabled={loading} onClick={handleDisconnect}>
            {loading ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : reconnecting ? (
        <div className="provider-test-result" style={{ marginBottom: 10 }}>Reconnecting…</div>
      ) : step === "verify" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {info && <div className="provider-test-result ok">{info}</div>}
          <div className="danger-zone-copy">Enter the 6-digit code sent to <strong>{email}</strong></div>
          <label className="field">
            <span>Verification Code</span>
            <input
              type="text"
              value={code}
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={6}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, "")); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && handleVerify()}
              style={{ letterSpacing: 8, fontSize: 22, textAlign: "center" }}
            />
          </label>
          {error && <div className="provider-test-result error">{error}</div>}
          <button type="button" className="primary-button" disabled={loading} onClick={handleVerify}>
            {loading ? "Verifying…" : "Verify & Connect"}
          </button>
          <button type="button" className="secondary-button" disabled={loading} onClick={() => { setStep("form"); setError(""); setInfo(""); setCode(""); }}>
            Back
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="cortex-auth-tabs">
            <button type="button" className={tab === "signin" ? "cortex-tab active" : "cortex-tab"} onClick={() => switchTab("signin")}>Sign In</button>
            <button type="button" className={tab === "register" ? "cortex-tab active" : "cortex-tab"} onClick={() => switchTab("register")}>Register</button>
          </div>
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} autoComplete="email" placeholder="you@example.com"
              onChange={(e) => { setEmail(e.target.value); setError(""); }} />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} autoComplete={tab === "register" ? "new-password" : "current-password"} placeholder="••••••••"
              onChange={(e) => { setPassword(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && (tab === "signin" ? handleSignIn() : handleRegister())} />
          </label>
          {error && <div className="provider-test-result error">{error}</div>}
          {tab === "signin" ? (
            <button type="button" className="primary-button" disabled={loading} onClick={handleSignIn}>
              {loading ? "Signing in…" : "Sign In"}
            </button>
          ) : (
            <button type="button" className="primary-button" disabled={loading} onClick={handleRegister}>
              {loading ? "Sending code…" : "Create Account"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function splitRemoteAccessUrls(remoteAccessUrls) {
  const entries = Array.isArray(remoteAccessUrls) ? remoteAccessUrls : [];
  return {
    tailscaleUrls: entries.filter((entry) =>
      /^tailscale/i.test(String(entry?.label || "")) || String(entry?.url || "").includes("://100."),
    ),
    localNetworkUrls: entries.filter((entry) =>
      !/^tailscale/i.test(String(entry?.label || "")) && !String(entry?.url || "").includes("://100."),
    ),
  };
}

export default function SettingsPage({
  error,
  networkSettingsSaving,
  onBack,
  onSave,
  repoDraft,
  setRepoDraft,
  onPickRepo,
  promptPresets,
  settingsPromptPreset,
  setSettingsPromptPreset,
  assistantMemoryDraft,
  setAssistantMemoryDraft,
  contextCarryMessagesDraft,
  setContextCarryMessagesDraft,
  themeMode,
  setThemeMode,
  resolvedTheme,
  remoteAccessEnabledDraft,
  setRemoteAccessEnabledDraft,
  remoteAccessUrls,
  providers,
  providerTestState,
  onTestProvider,
  showClearCacheConfirm,
  setShowClearCacheConfirm,
  onClearCache,
  showDeleteSettingsConfirm,
  setShowDeleteSettingsConfirm,
  onDeleteSettingsFile,
  configPath,
}) {
  const { tailscaleUrls, localNetworkUrls } = splitRemoteAccessUrls(remoteAccessUrls);

  return (
    <div className="settings-screen">
      <div className="settings-page">
        <header className="settings-page-header">
          <div className="settings-page-heading">
            <button type="button" className="secondary-button settings-back" onClick={onBack}>
              Back
            </button>
            <div>
              <div className="settings-title">Settings</div>
              <div className="settings-subtitle">Provider access, memory, and workspace behavior</div>
            </div>
          </div>
          <button type="button" className="primary-button" onClick={onSave}>
            {networkSettingsSaving ? "Saving..." : "Save settings"}
          </button>
        </header>

        {error && <div className="error-banner">{error}</div>}

        <div className="settings-page-grid">
          <section className="settings-section-card">
            <div className="settings-block-title">Appearance</div>
            <label className="field">
              <span>Theme</span>
              <select value={themeMode} onChange={(event) => setThemeMode(event.target.value)}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <div className="theme-hint">
              Applies instantly. Current theme: {resolvedTheme}.
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-block-title">Workspace</div>
            <label className="field">
              <span>Repo root</span>
              <div className="field-row">
                <input
                  value={repoDraft}
                  onChange={(event) => setRepoDraft(event.target.value)}
                  placeholder="E:\\path\\to\\repo"
                />
                <button type="button" onClick={onPickRepo}>
                  Browse
                </button>
              </div>
            </label>
            <label className="field">
              <span>Default mode</span>
              <select value={settingsPromptPreset} onChange={(event) => setSettingsPromptPreset(event.target.value)}>
                {promptPresets.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="settings-section-card">
            <div className="settings-block-title">Memory</div>
            <label className="field">
              <span>Assistant memory</span>
              <textarea
                className="settings-textarea"
                value={assistantMemoryDraft}
                onChange={(event) => setAssistantMemoryDraft(event.target.value)}
                placeholder="Add stable preferences, project conventions, names, or behavior notes to pass as persistent context."
              />
            </label>
            <label className="field">
              <span>Cross-model context carry</span>
              <input
                value={contextCarryMessagesDraft}
                onChange={(event) => setContextCarryMessagesDraft(event.target.value.replace(/[^\d]/g, ""))}
                placeholder="5"
              />
            </label>
          </section>

          <CortexRelaySection />
          <UpdateSection />

          <section className="settings-section-card settings-section-wide">
            <div className="settings-block-title">Remote Access</div>
            <div className="danger-zone-copy">
              Enable this to let the installed app accept connections from Tailscale or your local network.
            </div>
            <label className="field">
              <span>Network exposure</span>
              <select
                value={remoteAccessEnabledDraft ? "enabled" : "disabled"}
                onChange={(event) => setRemoteAccessEnabledDraft(event.target.value === "enabled")}
              >
                <option value="disabled">Disabled</option>
                <option value="enabled">Enabled</option>
              </select>
            </label>
            <div className="connection-guide">
              <div className="connection-guide-card">
                <div className="connection-guide-title">Local network</div>
                <div className="connection-guide-copy">
                  Connect the laptop and phone to the same Wi-Fi, save these settings, then use one of the local URLs below inside
                  the mobile app.
                </div>
                <div className="connection-guide-note">
                  Best for nearby pairing and fastest response time.
                </div>
                {remoteAccessEnabledDraft && localNetworkUrls.length > 0 && (
                  <div className="settings-storage-note">
                    <code>{localNetworkUrls.map((entry) => `${entry.label}: ${entry.url}`).join("\n")}</code>
                  </div>
                )}
              </div>
              <div className="connection-guide-card">
                <div className="connection-guide-title">Tailscale</div>
                <div className="connection-guide-copy">
                  Most reliable remote option. Use this when the phone is on mobile data or the two devices are on different networks.
                </div>
                <div className="connection-guide-steps">
                  <span>1. Install Tailscale on the laptop and the phone.</span>
                  <span>2. Sign both devices into the same tailnet.</span>
                  <span>3. Confirm both devices show as connected in Tailscale.</span>
                  <span>4. Save these settings so Cortex listens on the network.</span>
                  <span>5. In the mobile app, paste the Tailscale URL shown below and connect.</span>
                </div>
                {remoteAccessEnabledDraft && tailscaleUrls.length > 0 && (
                  <div className="settings-storage-note">
                    <code>{tailscaleUrls.map((entry) => `${entry.label}: ${entry.url}`).join("\n")}</code>
                  </div>
                )}
              </div>
              <div className="connection-guide-card">
                <div className="connection-guide-title">Your server</div>
                <div className="connection-guide-copy">
                  Best when you want account-based pairing without requiring Tailscale. Persist device state, not the raw socket itself.
                </div>
                <div className="connection-guide-steps">
                  <span>1. Keep one outbound WebSocket from the desktop app to your server.</span>
                  <span>2. Authenticate the user and register a stable device ID for the desktop.</span>
                  <span>3. Send a heartbeat every 20 to 30 seconds and store last_seen on the server.</span>
                  <span>4. Persist user_id, device_id, status, last_seen, and reconnect token in your database or Redis.</span>
                  <span>5. When the socket drops, mark the device offline after timeout and let it reconnect automatically.</span>
                  <span>6. Let the mobile app query paired desktops and relay traffic only when local network or Tailscale is unavailable.</span>
                </div>
                <div className="connection-guide-note">
                  Recommended server pattern: WebSocket for presence and control, normal HTTP or object storage for larger files like screenshots or APKs.
                </div>
              </div>
            </div>
            {remoteAccessEnabledDraft && (
              <div className="provider-test-result ok">
                {remoteAccessUrls.length
                  ? remoteAccessUrls.map((entry) => `${entry.label}: ${entry.url}`).join("\n")
                  : "Save settings to restart the backend and generate reachable URLs."}
              </div>
            )}
          </section>

          <section className="settings-section-card settings-section-wide">
            <div className="settings-block-title">Providers</div>
            <div className="provider-grid">
              {Object.entries(providers || {}).map(([providerId, provider]) => (
                <div key={providerId} className="provider-card">
                  <span className="provider-name">{providerId}</span>
                  <span className={provider.available ? "provider-ok" : "provider-muted"}>
                    {provider.available ? "available" : "missing"}
                  </span>
                  <span className={provider.connected ? "provider-ok" : "provider-muted"}>
                    {provider.connected ? "ready" : "not ready"}
                  </span>
                  <div className="provider-card-actions">
                    <button
                      type="button"
                      className="secondary-button provider-test-button"
                      onClick={() => void onTestProvider(providerId)}
                      disabled={providerTestState[providerId]?.status === "running"}
                    >
                      {providerTestState[providerId]?.status === "running" ? "Testing..." : "Test connection"}
                    </button>
                  </div>
                  {providerTestState[providerId]?.message && (
                    <div
                      className={
                        providerTestState[providerId]?.status === "ok"
                          ? "provider-test-result ok"
                          : providerTestState[providerId]?.status === "error"
                            ? "provider-test-result error"
                            : "provider-test-result"
                      }
                    >
                      {providerTestState[providerId].message}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section-card settings-section-wide">
            <div className="settings-block-title">Danger Zone</div>
            <div className="danger-zone-copy">
              Clear cached local app data, saved project metadata, chat history, accepted diff baselines, and provider session state.
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="danger-button"
                onClick={() => setShowClearCacheConfirm(true)}
              >
                Clear cache
              </button>
            </div>
          </section>
        </div>
      </div>

      {showClearCacheConfirm && (
        <div className="confirm-overlay" onClick={() => setShowClearCacheConfirm(false)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="confirm-badge">Danger</div>
            <div className="confirm-title">Clear local app data?</div>
            <div className="confirm-copy">
              This will remove saved chats, workspace diff baselines, cached project metadata, provider sessions, and local settings for known projects.
            </div>
            <div className="confirm-actions">
              <button type="button" className="secondary-button" onClick={() => setShowClearCacheConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="danger-button" onClick={onClearCache}>
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
      {showDeleteSettingsConfirm && (
        <div className="confirm-overlay" onClick={() => setShowDeleteSettingsConfirm(false)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="confirm-badge">Danger</div>
            <div className="confirm-title">Delete the local settings file?</div>
            <div className="confirm-copy">
              This removes the config file that stores saved API keys and local app settings.
              Project chat data and accepted workspace baselines are not deleted.
            </div>
            <div className="confirm-path">{configPath || "Unavailable"}</div>
            <div className="confirm-actions">
              <button type="button" className="secondary-button" onClick={() => setShowDeleteSettingsConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="danger-button" onClick={onDeleteSettingsFile}>
                Delete file
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
