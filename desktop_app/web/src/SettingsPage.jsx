import React from "react";

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
            <div className="settings-block-title">Remote Access</div>
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
            <div className="danger-zone-copy">
              Enable this to let the installed app accept connections from Tailscale or your local network.
            </div>
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
