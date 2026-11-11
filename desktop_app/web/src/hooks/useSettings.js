import { useEffect, useState } from "react";
import { SAVED_PROJECTS_KEY } from "../app/constants.js";
import { normalizeProject } from "../app/utils.js";

// Editable copies of the backend config shown on the Settings page. They are
// refreshed from every new snapshot config and only saved on "Save".
export function useSettingsDrafts({ snapshot }) {
  const [groqApiKeyDraft, setGroqApiKeyDraft] = useState("");
  const [geminiApiKeyDraft, setGeminiApiKeyDraft] = useState("");
  const [openaiApiKeyDraft, setOpenaiApiKeyDraft] = useState("");
  const [assistantMemoryDraft, setAssistantMemoryDraft] = useState("");
  const [contextCarryMessagesDraft, setContextCarryMessagesDraft] = useState("5");
  const [settingsPromptPreset, setSettingsPromptPreset] = useState("code");
  const [remoteAccessEnabledDraft, setRemoteAccessEnabledDraft] = useState(false);
  const [remoteAccessUrls, setRemoteAccessUrls] = useState([]);
  const [networkSettingsSaving, setNetworkSettingsSaving] = useState(false);
  const [showClearCacheConfirm, setShowClearCacheConfirm] = useState(false);
  const [showDeleteSettingsConfirm, setShowDeleteSettingsConfirm] = useState(false);
  const [providerTestState, setProviderTestState] = useState({});

  useEffect(() => {
    if (!snapshot?.config) {
      return;
    }
    setGroqApiKeyDraft(snapshot.config.apiKey || "");
    setGeminiApiKeyDraft(snapshot.config.geminiApiKey || "");
    setOpenaiApiKeyDraft(snapshot.config.openaiApiKey || "");
    setAssistantMemoryDraft(snapshot.config.assistantMemory || "");
    setContextCarryMessagesDraft(String(snapshot.config.contextCarryMessages ?? 5));
    setSettingsPromptPreset(snapshot.config.promptPreset || "code");
    setRemoteAccessEnabledDraft(Boolean(snapshot.config.remoteAccessEnabled));
  }, [snapshot?.config]);

  return {
    groqApiKeyDraft,
    setGroqApiKeyDraft,
    geminiApiKeyDraft,
    setGeminiApiKeyDraft,
    openaiApiKeyDraft,
    setOpenaiApiKeyDraft,
    assistantMemoryDraft,
    setAssistantMemoryDraft,
    contextCarryMessagesDraft,
    setContextCarryMessagesDraft,
    settingsPromptPreset,
    setSettingsPromptPreset,
    remoteAccessEnabledDraft,
    setRemoteAccessEnabledDraft,
    remoteAccessUrls,
    setRemoteAccessUrls,
    networkSettingsSaving,
    setNetworkSettingsSaving,
    showClearCacheConfirm,
    setShowClearCacheConfirm,
    showDeleteSettingsConfirm,
    setShowDeleteSettingsConfirm,
    providerTestState,
    setProviderTestState,
  };
}

// Save / clear cache / delete settings file / test provider actions.
export function useSettingsActions({
  drafts,
  snapshot,
  setSnapshot,
  backendUrl,
  repoDraft,
  setRepoDraft,
  setError,
  postJson,
  handleConfigUpdate,
  applyDesktopConfig,
  refreshStatus,
  savedProjects,
  onCacheCleared,
}) {
  const handleSaveSettings = async () => {
    setError("");
    drafts.setNetworkSettingsSaving(true);
    try {
      await handleConfigUpdate({
        repoRoot: repoDraft,
        apiKey: drafts.groqApiKeyDraft,
        geminiApiKey: drafts.geminiApiKeyDraft,
        openaiApiKey: drafts.openaiApiKeyDraft,
        promptPreset: drafts.settingsPromptPreset,
        assistantMemory: drafts.assistantMemoryDraft,
        contextCarryMessages: Number.parseInt(drafts.contextCarryMessagesDraft || "5", 10) || 0,
        remoteAccessEnabled: drafts.remoteAccessEnabledDraft,
      });
      if (window.desktopApi?.setRemoteAccess) {
        const nextDesktopConfig = await window.desktopApi.setRemoteAccess(drafts.remoteAccessEnabledDraft);
        applyDesktopConfig(nextDesktopConfig);
        await refreshStatus(nextDesktopConfig?.backendUrl || backendUrl);
      }
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      drafts.setNetworkSettingsSaving(false);
    }
  };

  const handleClearCache = async () => {
    setError("");
    try {
      const repoRoots = [...new Set(
        [snapshot?.config?.repoRoot || "", ...savedProjects.map((project) => project.path)]
          .map((value) => normalizeProject(value))
          .filter(Boolean),
      )];
      const nextSnapshot = await postJson("/api/cache/clear", { repoRoots });
      window.localStorage.removeItem(SAVED_PROJECTS_KEY);
      onCacheCleared();
      drafts.setShowClearCacheConfirm(false);
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
      drafts.setGroqApiKeyDraft("");
      drafts.setGeminiApiKeyDraft("");
      drafts.setOpenaiApiKeyDraft("");
      drafts.setAssistantMemoryDraft("");
      drafts.setContextCarryMessagesDraft("5");
      drafts.setSettingsPromptPreset("code");
      drafts.setRemoteAccessEnabledDraft(false);
      drafts.setRemoteAccessUrls([]);
    } catch (nextError) {
      setError(String(nextError));
      drafts.setShowClearCacheConfirm(false);
    }
  };

  const handleDeleteSettingsFile = async () => {
    setError("");
    try {
      const nextSnapshot = await postJson("/api/config/delete", {});
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot || "");
      drafts.setGroqApiKeyDraft("");
      drafts.setGeminiApiKeyDraft("");
      drafts.setOpenaiApiKeyDraft("");
      drafts.setAssistantMemoryDraft("");
      drafts.setContextCarryMessagesDraft(String(nextSnapshot.config.contextCarryMessages ?? 5));
      drafts.setSettingsPromptPreset(nextSnapshot.config.promptPreset || "code");
      drafts.setRemoteAccessEnabledDraft(Boolean(nextSnapshot.config.remoteAccessEnabled));
      drafts.setShowDeleteSettingsConfirm(false);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleTestProvider = async (providerId) => {
    setError("");
    drafts.setProviderTestState((current) => ({
      ...current,
      [providerId]: { status: "running", message: "Testing..." },
    }));
    try {
      const result = await postJson("/api/providers/test", {
        providerId,
        apiKey: drafts.groqApiKeyDraft,
        geminiApiKey: drafts.geminiApiKeyDraft,
        openaiApiKey: drafts.openaiApiKeyDraft,
      });
      drafts.setProviderTestState((current) => ({
        ...current,
        [providerId]: { status: "ok", message: result.message || "Connection looks good." },
      }));
    } catch (nextError) {
      const message = String(nextError?.message || nextError);
      drafts.setProviderTestState((current) => ({
        ...current,
        [providerId]: { status: "error", message },
      }));
    }
  };

  return { handleClearCache, handleDeleteSettingsFile, handleSaveSettings, handleTestProvider };
}
