import React, { useEffect, useMemo, useRef, useState } from "react";
import SettingsPage from "./SettingsPage.jsx";
import AuditPage from "./AuditPage.jsx";
import { DEFAULT_UI_PREFS, FALLBACK_APP_VERSION, PROMPT_PRESETS, QUICK_COMMANDS, SAVED_PROJECTS_KEY } from "./app/constants.js";
import {
  cleanResponse,
  groupedModels,
  loadSavedProjects,
  loadShowResourceDashboard,
  loadThemeMode,
  loadUiPrefs,
  normalizeProject,
  parentModelLabel,
  projectLabel,
  providerCliLaunchCommand,
  providerStateForGroup,
  readDesktopConfig,
  readNdjsonStream,
  saveSavedProjects,
  saveShowResourceDashboard,
  saveThemeMode,
  saveUiPrefs,
  stripPresetPrefix,
  upsertProject,
} from "./app/utils.js";
import AppNavbar from "./components/AppNavbar.jsx";
import BootScreen from "./components/BootScreen.jsx";
import ComposerPanel from "./components/ComposerPanel.jsx";
import ConfirmDeleteChatDialog from "./components/ConfirmDeleteChatDialog.jsx";
import ConversationSection from "./components/ConversationSection.jsx";
import PairingRequestsBanner from "./components/PairingRequestsBanner.jsx";
import PlanCard from "./components/PlanCard.jsx";
import ProjectContextMenu from "./components/ProjectContextMenu.jsx";
import ProjectSidebar from "./components/ProjectSidebar.jsx";
import ResourceDashboard from "./components/ResourceDashboard.jsx";
import TerminalPanelSection from "./components/TerminalPanelSection.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";

const DISMISSED_UPDATE_KEY = "cortex.dismissed-update";

export default function App() {
  const scrollRef = useRef(null);
  const terminalOutputRef = useRef(null);
  const activeChatIdRef = useRef("");
  const snapshotRef = useRef(null);
  const backendUrlRef = useRef("");
  const liveTermWriteRef = useRef(null);
  const liveCliLaunchedRef = useRef(new Set());
  const bootStartedAtRef = useRef(Date.now());
  const [updateBanner, setUpdateBanner] = useState(null); // { version }
  const [backendUrl, setBackendUrl] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [projectChats, setProjectChats] = useState({});
  const [draft, setDraft] = useState("");
  const [expandedRepos, setExpandedRepos] = useState(() => new Set());
  const [error, setError] = useState("");
  const [repoDraft, setRepoDraft] = useState("");
  const [pendingTurns, setPendingTurns] = useState({});
  const [sendingChatIds, setSendingChatIds] = useState([]);
  const [currentScreen, setCurrentScreen] = useState("chat");
  const [savedProjects, setSavedProjects] = useState(() => loadSavedProjects());
  const [projectMenuPath, setProjectMenuPath] = useState("");
  const [projectMenuPos, setProjectMenuPos] = useState({ top: 0, left: 0 });
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuPos, setModelMenuPos] = useState({ bottom: 0, left: 0 });
  const modelPickerRef = useRef(null);
  const [hoveredModelGroup, setHoveredModelGroup] = useState("");
  const [hoveredModelSubGroup, setHoveredModelSubGroup] = useState("");
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const [groqApiKeyDraft, setGroqApiKeyDraft] = useState("");
  const [geminiApiKeyDraft, setGeminiApiKeyDraft] = useState("");
  const [openaiApiKeyDraft, setOpenaiApiKeyDraft] = useState("");
  const [assistantMemoryDraft, setAssistantMemoryDraft] = useState("");
  const [contextCarryMessagesDraft, setContextCarryMessagesDraft] = useState("5");
  const [settingsPromptPreset, setSettingsPromptPreset] = useState("code");
  const [remoteAccessEnabledDraft, setRemoteAccessEnabledDraft] = useState(false);
  const [remoteAccessUrls, setRemoteAccessUrls] = useState([]);
  const [networkSettingsSaving, setNetworkSettingsSaving] = useState(false);
  const [bootDismissed, setBootDismissed] = useState(false);
  const [showClearCacheConfirm, setShowClearCacheConfirm] = useState(false);
  const [showDeleteSettingsConfirm, setShowDeleteSettingsConfirm] = useState(false);
  const [pendingPairingDevices, setPendingPairingDevices] = useState([]);
  const [pairingActionLoading, setPairingActionLoading] = useState({});
  const [providerTestState, setProviderTestState] = useState({});
  const [headerMoreOpen, setHeaderMoreOpen] = useState(false);
  const [headerInfoOpen, setHeaderInfoOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [renamingChat, setRenamingChat] = useState(null);
  const [renameChatDraft, setRenameChatDraft] = useState("");
  const [confirmDeleteChat, setConfirmDeleteChat] = useState(null); // { chatId, repoRoot }
  const [themeMode, setThemeMode] = useState(() => loadThemeMode());
  const [showResourceDashboard, setShowResourceDashboard] = useState(() => loadShowResourceDashboard());
  const [uiPrefs, setUiPrefs] = useState(() => loadUiPrefs());
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(false);
  const [terminalSnapshot, setTerminalSnapshot] = useState(null);
  const [terminalDraft, setTerminalDraft] = useState("");
  const [terminalViewMode, setTerminalViewMode] = useState("chat"); // "chat" | "live"
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true,
  );

  const runningChatIds = snapshot?.runningChatIds || [];
  const interruptedRuns = snapshot?.interruptedRuns || [];
  const activeRepoRoot = normalizeProject(snapshot?.config?.repoRoot || "");
  const resolvedTheme = themeMode === "system" ? (systemPrefersDark ? "dark" : "light") : themeMode;
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
    activeChatIdRef.current = snapshot?.config?.activeChatId || "";
    snapshotRef.current = snapshot;
  }, [snapshot]);

  // ── update listener ────────────────────────────────────────────────────────
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

  useEffect(() => {
    backendUrlRef.current = backendUrl;
  }, [backendUrl]);

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

  useEffect(() => {
    if (!window.matchMedia) {
      return undefined;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event) => {
      setSystemPrefersDark(event.matches);
    };
    setSystemPrefersDark(mediaQuery.matches);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    saveThemeMode(themeMode);
  }, [resolvedTheme, themeMode]);

  useEffect(() => {
    saveShowResourceDashboard(showResourceDashboard);
  }, [showResourceDashboard]);

  useEffect(() => {
    saveUiPrefs(uiPrefs);
    document.documentElement.dataset.codeWrap = uiPrefs.codeWrap ? "on" : "off";
  }, [uiPrefs]);

  const updateUiPref = (patch) => setUiPrefs((prev) => ({ ...prev, ...patch }));
  const restoreDisplayDefaults = () => {
    setThemeMode("dark");
    setShowResourceDashboard(false);
    setUiPrefs({ ...DEFAULT_UI_PREFS });
  };

  useEffect(() => {
    if (!activeRepoRoot || !snapshot?.chats) {
      return;
    }
    setProjectChats((current) => ({
      ...current,
      [activeRepoRoot]: snapshot.chats,
    }));
  }, [activeRepoRoot, snapshot?.chats]);

  useEffect(() => {
    if (snapshot?.config?.repoRoot) {
      setExpandedRepos((prev) => new Set([...prev, snapshot.config.repoRoot]));
    }
  }, [snapshot?.config?.repoRoot]);

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

  const toggleRepo = (repoPath) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoPath)) {
        next.delete(repoPath);
      } else {
        next.add(repoPath);
      }
      return next;
    });
  };

  const handleOpenMenu = (event, path) => {
    event.stopPropagation();
    setEditorMenuOpen(false);
    setHeaderMoreOpen(false);
    const rect = event.currentTarget.getBoundingClientRect();
    if (projectMenuPath === path) {
      setProjectMenuPath("");
    } else {
      setProjectMenuPath(path);
      setProjectMenuPos({ top: rect.bottom + 8, left: rect.left - 130 });
    }
  };

  const toggleModelMenu = (event) => {
    event.stopPropagation();
    setEditorMenuOpen(false);
    setHeaderMoreOpen(false);
    if (!modelGroups.length) {
      return;
    }
    const nextOpen = !modelMenuOpen;
    setModelMenuOpen(nextOpen);
    if (!nextOpen) {
      setHoveredModelGroup("");
      return;
    }
    if (modelPickerRef.current) {
      const rect = modelPickerRef.current.getBoundingClientRect();
      setModelMenuPos({ bottom: window.innerHeight - rect.top + 8, left: rect.left });
    }
    const preferredGroup = modelGroupStates.get(activeModelParent)?.connected
      ? activeModelParent
      : modelGroups.find(([group]) => modelGroupStates.get(group)?.connected)?.[0] || activeModelParent;
    setHoveredModelGroup(preferredGroup);
  };

  const modelGroups = useMemo(() => groupedModels(snapshot?.models || []), [snapshot]);
  const modelGroupStates = useMemo(
    () =>
      new Map(
        modelGroups.map(([group]) => [group, providerStateForGroup(group, snapshot?.providers || {})]),
      ),
    [modelGroups, snapshot?.providers],
  );
  const activeModelParent = useMemo(
    () => parentModelLabel(snapshot?.config?.model || "", modelGroups),
    [modelGroups, snapshot?.config?.model],
  );
  const interruptedRunByChat = useMemo(
    () =>
      new Map(
        interruptedRuns
          .filter((run) => run?.chatId)
          .map((run) => [run.chatId, run]),
      ),
    [interruptedRuns],
  );
  const activeInterruptedRun = useMemo(
    () => interruptedRunByChat.get(snapshot?.config?.activeChatId || "") || null,
    [interruptedRunByChat, snapshot?.config?.activeChatId],
  );
  const activeChatRunning = useMemo(
    () => runningChatIds.includes(snapshot?.config?.activeChatId || ""),
    [runningChatIds, snapshot?.config?.activeChatId],
  );

  const activePendingTurn = useMemo(() => {
    const activeChatId = snapshot?.config?.activeChatId || "";
    return pendingTurns[activeChatId] || null;
  }, [pendingTurns, snapshot?.config?.activeChatId]);
  const activeModelId = snapshot?.config?.model || "";
  const activeModelShort = activeModelId.replace(/^codex:|^gemini-cli:|^claude:|^hermes:/, "");
  const activePlan = snapshot?.activePlan || null;
  const activeTerminalChatId = snapshot?.config?.activeChatId || "";

  const displayMessages = useMemo(() => {
    const visible = (snapshot?.messages || [])
      .filter((message) => ["user", "assistant", "system"].includes(message.role))
      .filter((message) => String(message.content || "").trim().length > 0)
      .map((message) => ({
        ...message,
        content:
          message.role === "assistant"
            ? cleanResponse(String(message.content || ""))
            : message.role === "user"
              ? stripPresetPrefix(String(message.content || ""))
              : String(message.content || "").trim(),
      }));

    // Once the backend has saved the user's message (the `user_message` stream
    // event and status polls both carry it), the snapshot already ends with it.
    // Only show the optimistic copy until then, or it appears twice.
    const lastVisible = visible.at(-1);
    const pendingUserAlreadySaved =
      lastVisible?.role === "user" &&
      lastVisible.content === stripPresetPrefix(String(activePendingTurn?.userMessage || ""));
    if (activePendingTurn?.userMessage && !pendingUserAlreadySaved) {
      visible.push({ role: "user", content: activePendingTurn.userMessage, pending: true });
    }
    if (activePendingTurn?.assistantText) {
      visible.push({ role: "assistant", content: activePendingTurn.assistantText });
    }
    return visible;
  }, [activePendingTurn, snapshot]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayMessages, pendingTurns]);

  const preservePartialAssistantMessage = (chatId, assistantText) => {
    const partial = String(assistantText || "");
    if (!partial.trim()) {
      return;
    }
    setSnapshot((current) => {
      if (!current || current.config?.activeChatId !== chatId) {
        return current;
      }
      const existingMessages = Array.isArray(current.messages) ? current.messages : [];
      const lastMessage = existingMessages.at(-1);
      if (lastMessage?.role === "assistant" && String(lastMessage.content || "") === partial) {
        return current;
      }
      return {
        ...current,
        messages: [...existingMessages, { role: "assistant", content: partial, incomplete: true }],
      };
    });
  };

  useEffect(() => {
    const el = terminalOutputRef.current;
    if (!el || !terminalPanelOpen) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [terminalSnapshot?.history, terminalPanelOpen]);

  const refreshTerminal = async (chatId = activeTerminalChatId) => {
    if (!backendUrl || !chatId) {
      setTerminalSnapshot(null);
      return null;
    }
    const response = await fetch(`${backendUrl}/api/terminal?chatId=${encodeURIComponent(chatId)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || `Terminal request failed (${response.status})`);
    }
    setTerminalSnapshot(data);
    return data;
  };

  useEffect(() => {
    if (!terminalPanelOpen || !backendUrl || !activeTerminalChatId) {
      return undefined;
    }
    let alive = true;
    const tick = async () => {
      try {
        const data = await refreshTerminal(activeTerminalChatId);
        if (!alive) {
          return;
        }
        if (data?.status === "closed") {
          return;
        }
      } catch {
        // The chat UI already has a global error path; avoid noisy polling errors.
      }
    };
    void tick();
    const interval = window.setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTerminalChatId, backendUrl, terminalPanelOpen]);

  const syncSavedProjects = (repoRoot) => {
    setSavedProjects((current) => {
      const nextProjects = upsertProject(current, repoRoot);
      saveSavedProjects(nextProjects);
      return nextProjects;
    });
  };

  const applyDesktopConfig = (config) => {
    setBackendUrl(config?.backendUrl || "");
    setRemoteAccessEnabledDraft(Boolean(config?.remoteAccessEnabled));
    setRemoteAccessUrls(Array.isArray(config?.remoteAccessUrls) ? config.remoteAccessUrls : []);
  };

  const fetchProjectChats = async (repoRoot, urlOverride) => {
    const normalizedRepoRoot = normalizeProject(repoRoot);
    const targetUrl = urlOverride || backendUrl;
    if (!normalizedRepoRoot || !targetUrl) {
      return [];
    }
    const response = await fetch(
      `${targetUrl}/api/chats?repoRoot=${encodeURIComponent(normalizedRepoRoot)}`,
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || `Chat list request failed (${response.status})`);
    }
    const chats = Array.isArray(data.chats) ? data.chats : [];
    setProjectChats((current) => ({
      ...current,
      [normalizedRepoRoot]: chats,
    }));
    return chats;
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
  }, []);

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
  }, [backendUrl]);

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
  }, [backendUrl, runningChatIds.length, sendingChatIds.length]);

  useEffect(() => {
    if (!backendUrl) {
      return;
    }
    const expandedProjectPaths = savedProjects
      .map((project) => normalizeProject(project.path))
      .filter((path) => expandedRepos.has(path));
    expandedProjectPaths.forEach((repoRoot) => {
      if (repoRoot !== activeRepoRoot && !projectChats[repoRoot]) {
        void fetchProjectChats(repoRoot).catch(() => {});
      }
    });
  }, [activeRepoRoot, backendUrl, expandedRepos, projectChats, savedProjects]);

  const postJson = async (path, payload) => {
    const response = await fetch(`${backendUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || `Request failed (${response.status})`);
    }
    return data;
  };

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

  const handleConfigUpdate = async (patch) => {
    setError("");
    try {
      const nextSnapshot = await postJson("/api/config", patch);
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
      syncSavedProjects(nextSnapshot.config.repoRoot);
      void fetchProjectChats(nextSnapshot.config.repoRoot).catch(() => {});
      return nextSnapshot;
    } catch (nextError) {
      setError(String(nextError));
      throw nextError;
    }
  };

  const handleSaveSettings = async () => {
    setError("");
    setNetworkSettingsSaving(true);
    try {
      await handleConfigUpdate({
        repoRoot: repoDraft,
        apiKey: groqApiKeyDraft,
        geminiApiKey: geminiApiKeyDraft,
        openaiApiKey: openaiApiKeyDraft,
        promptPreset: settingsPromptPreset,
        assistantMemory: assistantMemoryDraft,
        contextCarryMessages: Number.parseInt(contextCarryMessagesDraft || "5", 10) || 0,
        remoteAccessEnabled: remoteAccessEnabledDraft,
      });
      if (window.desktopApi?.setRemoteAccess) {
        const nextDesktopConfig = await window.desktopApi.setRemoteAccess(remoteAccessEnabledDraft);
        applyDesktopConfig(nextDesktopConfig);
        await refreshStatus(nextDesktopConfig?.backendUrl || backendUrl);
      }
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setNetworkSettingsSaving(false);
    }
  };

  const handleToolSafetyChange = async (toolSafetyMode) => {
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/preferences", {
        chatId: snapshot?.config?.activeChatId || null,
        repoRoot: snapshot?.config?.repoRoot || "",
        toolSafetyMode,
      });
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handlePromptPresetChange = async (promptPreset) => {
    await handleConfigUpdate({ promptPreset });
  };

  const handleInterruptChat = async () => {
    const activeChatId = snapshot?.config?.activeChatId || "";
    if (!activeChatId) {
      return;
    }
    setError("");
    // Optimistically clear all loading indicators immediately
    setPendingTurns((current) => {
      if (!current[activeChatId]) return current;
      return { ...current, [activeChatId]: { ...current[activeChatId], running: false } };
    });
    setSendingChatIds((current) => current.filter((id) => id !== activeChatId));
    setSnapshot((current) => {
      if (!current) return current;
      return { ...current, runningChatIds: (current.runningChatIds || []).filter((id) => id !== activeChatId) };
    });
    try {
      await postJson("/api/chats/interrupt", { chatId: activeChatId });
    } catch (nextError) {
      setError(String(nextError));
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
      setSavedProjects([]);
      setProjectChats({});
      setPendingTurns({});
      setSendingChatIds([]);
      setCurrentScreen("chat");
      setShowClearCacheConfirm(false);
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
      setGroqApiKeyDraft("");
      setGeminiApiKeyDraft("");
      setOpenaiApiKeyDraft("");
      setAssistantMemoryDraft("");
      setContextCarryMessagesDraft("5");
      setSettingsPromptPreset("code");
      setRemoteAccessEnabledDraft(false);
      setRemoteAccessUrls([]);
    } catch (nextError) {
      setError(String(nextError));
      setShowClearCacheConfirm(false);
    }
  };

  const handleDeleteSettingsFile = async () => {
    setError("");
    try {
      const nextSnapshot = await postJson("/api/config/delete", {});
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot || "");
      setGroqApiKeyDraft("");
      setGeminiApiKeyDraft("");
      setOpenaiApiKeyDraft("");
      setAssistantMemoryDraft("");
      setContextCarryMessagesDraft(String(nextSnapshot.config.contextCarryMessages ?? 5));
      setSettingsPromptPreset(nextSnapshot.config.promptPreset || "code");
      setRemoteAccessEnabledDraft(Boolean(nextSnapshot.config.remoteAccessEnabled));
      setShowDeleteSettingsConfirm(false);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleTestProvider = async (providerId) => {
    setError("");
    setProviderTestState((current) => ({
      ...current,
      [providerId]: { status: "running", message: "Testing..." },
    }));
    try {
      const result = await postJson("/api/providers/test", {
        providerId,
        apiKey: groqApiKeyDraft,
        geminiApiKey: geminiApiKeyDraft,
        openaiApiKey: openaiApiKeyDraft,
      });
      setProviderTestState((current) => ({
        ...current,
        [providerId]: { status: "ok", message: result.message || "Connection looks good." },
      }));
    } catch (nextError) {
      const message = String(nextError?.message || nextError);
      setProviderTestState((current) => ({
        ...current,
        [providerId]: { status: "error", message },
      }));
    }
  };

  const handleOpenInEditor = async (editorId) => {
    const repoRoot = snapshot?.config?.repoRoot || "";
    if (!repoRoot) {
      setError("Select a project folder first.");
      setEditorMenuOpen(false);
      return;
    }
    setError("");
    try {
      await window.desktopApi?.openInEditor?.(editorId, repoRoot);
      setEditorMenuOpen(false);
    } catch (nextError) {
      setError(String(nextError));
      setEditorMenuOpen(false);
    }
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleOpenLocalFile = async (filePath) => {
    setError("");
    try {
      await window.desktopApi?.openFile?.(filePath);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleToggleTerminal = async () => {
    const chatId = activeTerminalChatId;
    if (!chatId) {
      setError("Start or select a chat before opening a terminal.");
      return;
    }
    setError("");
    const nextOpen = !terminalPanelOpen;
    setTerminalPanelOpen(nextOpen);
    if (nextOpen) {
      try {
        const current = await refreshTerminal(chatId);
        if (!current || current.status !== "running") {
          const nextSnapshot = await postJson("/api/terminal/open", {
            chatId,
            repoRoot: snapshot?.config?.repoRoot || "",
            cols: 100,
            rows: 24,
          });
          setTerminalSnapshot(nextSnapshot);
        }
      } catch (nextError) {
        setError(String(nextError));
      }
    }
  };

  const handleSendTerminalCommand = async () => {
    const command = terminalDraft.trim();
    if (!command || !activeTerminalChatId) {
      return;
    }
    setTerminalDraft("");
    setError("");
    try {
      const nextSnapshot = await postJson("/api/terminal/write", {
        chatId: activeTerminalChatId,
        repoRoot: snapshot?.config?.repoRoot || "",
        command,
      });
      setTerminalSnapshot(nextSnapshot);
      setTerminalPanelOpen(true);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleCloseTerminal = async () => {
    if (!activeTerminalChatId) {
      return;
    }
    setError("");
    try {
      const nextSnapshot = await postJson("/api/terminal/close", { chatId: activeTerminalChatId });
      liveCliLaunchedRef.current.delete(activeTerminalChatId);
      setTerminalSnapshot(nextSnapshot);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleContinueWithPlan = async () => {
    if (!activePlan) {
      return;
    }
    const prompt = [
      `Continue by executing the approved plan from: ${activePlan.path}`,
      "",
      activePlan.content,
    ].join("\n");
    setDraft(prompt);
    if ((snapshot?.config?.promptPreset || "") !== "code") {
      await handleConfigUpdate({ promptPreset: "code" });
    }
  };

  const sendToAI = async (message) => {
    const snap = snapshotRef.current;
    const url = backendUrlRef.current;
    if (!snap || !url) return;
    const chatId = snap.config?.activeChatId || "";
    if (!chatId) return;

    const requestPayload = {
      message,
      chatId,
      repoRoot: snap.config?.repoRoot || "",
      model: snap.config?.model || "",
      promptPreset: snap.config?.promptPreset || "",
      toolSafetyMode: snap.config?.toolSafetyMode || "",
    };

    setSendingChatIds((current) => (current.includes(chatId) ? current : [...current, chatId]));
    setPendingTurns((current) => ({
      ...current,
      [chatId]: { chatId, userMessage: null, assistantText: "", running: true },
    }));

    try {
      const response = await fetch(`${url}/api/chat/send-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.detail || `Request failed (${response.status})`);
      }
      await readNdjsonStream(response, (event) => {
        const eventChatId = event.chatId || chatId;
        if (event.type === "cli_output" || event.type === "assistant") {
          setPendingTurns((current) => ({
            ...current,
            [eventChatId]: {
              chatId: eventChatId,
              userMessage: null,
              assistantText: event.type === "assistant"
                ? (event.text || "")
                : `${current[eventChatId]?.assistantText || ""}${event.text || ""}`,
              running: true,
            },
          }));
        } else if (event.type === "completed") {
          if (event.snapshot) {
            setSnapshot(event.snapshot);
            setRepoDraft(event.snapshot.config.repoRoot);
            syncSavedProjects(event.snapshot.config.repoRoot);
          }
          setPendingTurns((current) => { const next = { ...current }; delete next[eventChatId]; return next; });
          setSendingChatIds((current) => current.filter((id) => id !== eventChatId));
        } else if (event.type === "error") {
          setPendingTurns((current) => { const next = { ...current }; delete next[eventChatId]; return next; });
          setSendingChatIds((current) => current.filter((id) => id !== eventChatId));
          setError(event.message || "Stream failed.");
        }
      });
    } catch (err) {
      setPendingTurns((current) => { const next = { ...current }; delete next[chatId]; return next; });
      setSendingChatIds((current) => current.filter((id) => id !== chatId));
      setError(String(err));
    }
  };

  const pollTerminalThenNotifyAI = async (userCommand, chatId) => {
    const maxWaitMs = 120000;
    const pollMs = 3000;
    const stableMs = 6000;
    const start = Date.now();
    let lastHistory = "";
    let lastChangedAt = Date.now();

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => window.setTimeout(r, pollMs));
      try {
        const snap = await fetch(`${backendUrlRef.current}/api/terminal?chatId=${encodeURIComponent(chatId)}`).then((r) => r.json());
        const history = snap?.history || "";
        if (history !== lastHistory) {
          lastHistory = history;
          lastChangedAt = Date.now();
        } else if (lastHistory.length > 0 && Date.now() - lastChangedAt >= stableMs) {
          break;
        }
      } catch {
        break;
      }
    }

    if (!lastHistory.trim()) return;

    // Strip ANSI escape codes before sending to AI
    const clean = lastHistory.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "").trim();
    const contextMessage = `Terminal output for \`${userCommand}\`:\n\`\`\`\n${clean}\n\`\`\`\n\nBriefly summarise what happened and flag any issues.`;
    await sendToAI(contextMessage);
  };

  const handleSwitchToLive = async () => {
    setTerminalViewMode("live");
    setTerminalPanelOpen(true);
    const chatId = activeTerminalChatId;
    if (!chatId) return;
    setError("");
    try {
      const current = await refreshTerminal(chatId).catch(() => null);
      const wasRunning = current && current.status === "running";
      if (!wasRunning) {
        // Terminal was closed or never opened — clear any stale launch record
        liveCliLaunchedRef.current.delete(chatId);
        await postJson("/api/terminal/open", {
          chatId,
          repoRoot: snapshot?.config?.repoRoot || "",
          cols: 120,
          rows: 30,
        });
        // Small delay so the shell is ready before we send the CLI command
        await new Promise((r) => window.setTimeout(r, 600));
      }
      // Only send the CLI launch command if we haven't already done so for this terminal session
      if (!liveCliLaunchedRef.current.has(chatId)) {
        liveCliLaunchedRef.current.add(chatId);
        const cliCmd = providerCliLaunchCommand(snapshot);
        await postJson("/api/terminal/write", {
          chatId,
          repoRoot: snapshot?.config?.repoRoot || "",
          command: cliCmd,
        });
      }
      setTerminalSnapshot(await refreshTerminal(chatId).catch(() => null));
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const runInTerminal = async (command) => {
    const chatId = activeTerminalChatId;
    if (!chatId) {
      setError("Start or select a chat before running a terminal command.");
      return;
    }
    const current = await refreshTerminal(chatId).catch(() => null);
    if (!current || current.status !== "running") {
      const opened = await postJson("/api/terminal/open", {
        chatId,
        repoRoot: snapshot?.config?.repoRoot || "",
        cols: 100,
        rows: 24,
      });
      setTerminalSnapshot(opened);
    }
    const next = await postJson("/api/terminal/write", {
      chatId,
      repoRoot: snapshot?.config?.repoRoot || "",
      command,
    });
    setTerminalSnapshot(next);
    setTerminalPanelOpen(true);
  };

  const handleSend = async () => {
    if (!draft.trim()) return;

    const outgoingMessage = draft.trim();

    // Live terminal mode — stream AI response directly into xterm
    if (terminalViewMode === "live" && terminalPanelOpen && liveTermWriteRef.current) {
      setDraft("");
      setError("");
      const write = liveTermWriteRef.current;
      const currentConfig = snapshot?.config || {};
      const currentChatId = snapshot?.config?.activeChatId || "";

      // Echo the user input into xterm
      write(`\r\n\x1b[32m>\x1b[0m ${outgoingMessage}\r\n\r\n`);

      const requestPayload = {
        message: outgoingMessage,
        chatId: currentChatId || null,
        repoRoot: currentConfig.repoRoot || "",
        model: currentConfig.model || "",
        promptPreset: currentConfig.promptPreset || "",
        toolSafetyMode: currentConfig.toolSafetyMode || "",
      };

      try {
        const response = await fetch(`${backendUrl}/api/chat/send-stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(data?.detail || `Request failed (${response.status})`);
        }
        let hadCliOutput = false;
        await readNdjsonStream(response, (event) => {
          if (event.type === "cli_output") {
            const chunk = event.text || "";
            if (chunk) {
              hadCliOutput = true;
              write(chunk);
            }
          } else if (event.type === "assistant") {
            // CLI providers (claude/codex/gemini-cli) already streamed the full text
            // via cli_output chunks — writing it again here would double the response.
            if (!hadCliOutput) {
              write(event.text || "");
            }
          } else if (event.type === "completed") {
            write("\r\n");
            if (event.snapshot) {
              setSnapshot(event.snapshot);
              setRepoDraft(event.snapshot.config.repoRoot);
              syncSavedProjects(event.snapshot.config.repoRoot);
            }
          } else if (event.type === "error") {
            write(`\r\n\x1b[31mError: ${event.message || "Stream failed."}\x1b[0m\r\n`);
          }
        });
      } catch (nextError) {
        write(`\r\n\x1b[31mError: ${String(nextError)}\x1b[0m\r\n`);
      }
      return;
    }

    // Quick terminal commands — run in terminal, show in chat, poll output → AI
    for (const qc of QUICK_COMMANDS) {
      if (qc.patterns.some((p) => p.test(outgoingMessage))) {
        setDraft("");
        setError("");

        // List AVDs directly in chat — no terminal needed
        if (qc.type === "list-avds") {
          try {
            const data = await fetch(`${backendUrl}/api/android/avds`).then((r) => r.json());
            const avds = data.avds || [];
            const listText = avds.length
              ? `Available emulators:\n${avds.map((a) => `  • ${a}`).join("\n")}\n\nType \`open emulator <name>\` to launch one.`
              : "No emulators found. Make sure Android SDK is installed and at least one AVD is created.";
            setSnapshot((current) => {
              if (!current) return current;
              return {
                ...current,
                messages: [
                  ...(current.messages || []),
                  { role: "user", content: outgoingMessage },
                  { role: "assistant", content: listText },
                ],
              };
            });
          } catch (nextError) {
            setError(String(nextError));
          }
          return;
        }

        // Launch Emulator via API
        if (qc.type === "launch-emulator") {
          const args = qc.buildCommand(outgoingMessage);
          if (!args.avd) {
            // If no AVD name provided, first list them
            void fetch(`${backendUrl}/api/android/avds`).then(r => r.json()).then(data => {
              const avds = data.avds || [];
              const listText = avds.length
                ? `Please specify which emulator to launch:\n${avds.map((a) => `  • ${a}`).join("\n")}\n\nExample: \`open emulator ${avds[0]}\``
                : "No emulators found to launch.";
              setSnapshot((current) => {
                if (!current) return current;
                return {
                  ...current,
                  messages: [
                    ...(current.messages || []),
                    { role: "user", content: outgoingMessage },
                    { role: "assistant", content: listText },
                  ],
                };
              });
            });
          } else {
            // Try to launch the specific AVD
            try {
              const res = await fetch(`${backendUrl}/api/android/launch`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ avd: args.avd })
              });
              const data = await res.json();
              if (res.ok) {
                setSnapshot((current) => {
                  if (!current) return current;
                  return {
                    ...current,
                    messages: [
                      ...(current.messages || []),
                      { role: "user", content: outgoingMessage },
                      { role: "assistant", content: data.message || `Launching ${args.avd}...` },
                    ],
                  };
                });
              } else {
                setError(`Error launching emulator: ${data.detail}`);
              }
            } catch (launchErr) {
              setError(`Error launching emulator: ${String(launchErr)}`);
            }
          }
          return;
        }

        const cmd = qc.buildCommand(outgoingMessage);
        const chatId = snapshot?.config?.activeChatId || "";
        setSnapshot((current) => {
          if (!current) return current;
          return {
            ...current,
            messages: [
              ...(current.messages || []),
              { role: "user", content: outgoingMessage },
              { role: "assistant", content: `Running in terminal:\n\`${cmd}\`\n\nWaiting for output...` },
            ],
          };
        });
        void runInTerminal(cmd)
          .then(() => pollTerminalThenNotifyAI(outgoingMessage, chatId))
          .catch((nextError) => setError(String(nextError)));
        return;
      }
    }

    const currentConfig = snapshot?.config || {};
    const currentChatId = snapshot?.config?.activeChatId || "";
    const requestPayload = {
      message: outgoingMessage,
      chatId: currentChatId || null,
      repoRoot: currentConfig.repoRoot || "",
      model: currentConfig.model || "",
      promptPreset: currentConfig.promptPreset || "",
      toolSafetyMode: currentConfig.toolSafetyMode || "",
    };
    if (currentChatId && sendingChatIds.includes(currentChatId)) {
      return;
    }

    const requestKey = currentChatId || `draft:${Date.now()}`;
    let resolvedChatId = requestKey;
    const previousPendingTurn = currentChatId ? pendingTurns[currentChatId] : null;
    if (currentChatId && previousPendingTurn?.assistantText && !previousPendingTurn?.running) {
      preservePartialAssistantMessage(currentChatId, previousPendingTurn.assistantText);
      setPendingTurns((current) => {
        const next = { ...current };
        delete next[currentChatId];
        return next;
      });
    }
    setDraft("");
    setError("");
    setPendingTurns((current) => ({
      ...current,
      [requestKey]: { chatId: requestKey, userMessage: outgoingMessage, assistantText: "", running: true },
    }));
    setSendingChatIds((current) => (current.includes(requestKey) ? current : [...current, requestKey]));

    try {
      const response = await fetch(`${backendUrl}/api/chat/send-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.detail || `Request failed (${response.status})`);
      }

      await readNdjsonStream(response, (event) => {
        const eventChatId = event.chatId || requestKey;

        switch (event.type) {
          case "user_message": {
            resolvedChatId = eventChatId;
            if (
              event.snapshot &&
              (activeChatIdRef.current === "" || activeChatIdRef.current === event.chatId)
            ) {
              setSnapshot(event.snapshot);
              setRepoDraft(event.snapshot.config.repoRoot);
              syncSavedProjects(event.snapshot.config.repoRoot);
            }
            setSendingChatIds((current) => {
              const next = current.filter((chatId) => chatId !== requestKey);
              return next.includes(eventChatId) ? next : [...next, eventChatId];
            });
            setPendingTurns((current) => {
              const previous = current[eventChatId] || current[requestKey] || {};
              const next = { ...current };
              delete next[requestKey];
              next[eventChatId] = {
                chatId: eventChatId,
                userMessage: event.message,
                assistantText: previous.assistantText || "",
                running: true,
              };
              return next;
            });
            break;
          }
          case "cli_output":
            setPendingTurns((current) => {
              const previous = current[eventChatId] || current[requestKey] || {};
              return {
                ...current,
                [eventChatId]: {
                  chatId: eventChatId,
                  userMessage: previous.userMessage || outgoingMessage,
                  assistantText: `${previous.assistantText || ""}${event.text || ""}`,
                  running: true,
                },
              };
            });
            break;
          case "assistant":
            setPendingTurns((current) => ({
              ...current,
              [eventChatId]: {
                chatId: eventChatId,
                userMessage: current[eventChatId]?.userMessage || outgoingMessage,
                assistantText: event.text || "",
                running: true,
              },
            }));
            break;
          case "completed":
            if (event.snapshot) {
              setSnapshot(event.snapshot);
              setRepoDraft(event.snapshot.config.repoRoot);
              syncSavedProjects(event.snapshot.config.repoRoot);
              void fetchProjectChats(event.snapshot.config.repoRoot).catch(() => {});
            }
            setPendingTurns((current) => {
              const next = { ...current };
              delete next[eventChatId];
              return next;
            });
            setSendingChatIds((current) => current.filter((chatId) => chatId !== eventChatId && chatId !== requestKey));
            break;
          case "interrupted":
            if (event.snapshot) {
              setSnapshot(event.snapshot);
              setRepoDraft(event.snapshot.config.repoRoot);
              syncSavedProjects(event.snapshot.config.repoRoot);
              void fetchProjectChats(event.snapshot.config.repoRoot).catch(() => {});
            }
            setPendingTurns((current) => {
              const partialText = event.partialText || current[eventChatId]?.assistantText || "";
              preservePartialAssistantMessage(eventChatId, partialText);
              const next = { ...current };
              delete next[eventChatId];
              delete next[requestKey];
              return next;
            });
            setSendingChatIds((current) => current.filter((chatId) => chatId !== eventChatId && chatId !== requestKey));
            break;
          case "error":
            setPendingTurns((current) => {
              const partialText = current[eventChatId]?.assistantText || current[requestKey]?.assistantText || "";
              preservePartialAssistantMessage(eventChatId, partialText);
              const next = { ...current };
              delete next[eventChatId];
              delete next[requestKey];
              return next;
            });
            setSendingChatIds((current) => current.filter((chatId) => chatId !== eventChatId && chatId !== requestKey));
            if (activeChatIdRef.current === eventChatId || activeChatIdRef.current === "") {
              setError(event.message || "Stream failed.");
            }
            break;
          default:
            break;
        }
      });
    } catch (nextError) {
      setPendingTurns((current) => {
        const partialText = current[resolvedChatId]?.assistantText || current[requestKey]?.assistantText || "";
        preservePartialAssistantMessage(resolvedChatId, partialText);
        const next = { ...current };
        delete next[requestKey];
        delete next[resolvedChatId];
        return next;
      });
      setSendingChatIds((current) => current.filter((chatId) => chatId !== requestKey && chatId !== resolvedChatId));
      setError(String(nextError));
    }
  };

  const handleNewChat = async (repoRoot = snapshot?.config?.repoRoot || "") => {
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/new", { repoRoot });
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
      syncSavedProjects(nextSnapshot.config.repoRoot);
      void fetchProjectChats(nextSnapshot.config.repoRoot).catch(() => {});
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleActivateChat = async (chatId, repoRoot = snapshot?.config?.repoRoot || "") => {
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/activate", { chatId, repoRoot });
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
      syncSavedProjects(nextSnapshot.config.repoRoot);
      void fetchProjectChats(nextSnapshot.config.repoRoot).catch(() => {});
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleDeleteChat = async (event, chatId, repoRoot = snapshot?.config?.repoRoot || "") => {
    event.stopPropagation();
    setConfirmDeleteChat(null);
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/delete", { chatId, repoRoot });
      setSnapshot(nextSnapshot);
      setPendingTurns((current) => {
        const next = { ...current };
        delete next[chatId];
        return next;
      });
      setSendingChatIds((current) => current.filter((id) => id !== chatId));
      const normalizedRepoRoot = normalizeProject(repoRoot);
      if (normalizedRepoRoot && normalizedRepoRoot !== activeRepoRoot) {
        setProjectChats((current) => ({
          ...current,
          [normalizedRepoRoot]: (current[normalizedRepoRoot] || []).filter(
            (chat) => chat.chatId !== chatId,
          ),
        }));
      } else {
        void fetchProjectChats(repoRoot).catch(() => {});
      }
      // stopPropagation prevents workspace-shell onClick from clearing open menus/dropdowns.
      // Explicitly close all of them so nothing can block the textarea after delete.
      setProjectMenuPath("");
      setModelMenuOpen(false);
      setEditorMenuOpen(false);
      setHeaderMoreOpen(false);
      setHeaderInfoOpen(false);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleCopyWorkspacePath = async (repoRoot = snapshot?.config?.repoRoot || "") => {
    const normalizedRepoRoot = normalizeProject(repoRoot);
    if (!normalizedRepoRoot) {
      return;
    }
    setProjectMenuPath("");
    setHeaderMoreOpen(false);
    await copyText(normalizedRepoRoot, "Workspace path copied");
  };

  const handleStartRenameChat = (event, chat, repoRoot = snapshot?.config?.repoRoot || "") => {
    event.stopPropagation();
    setRenamingChat({
      chatId: chat.chatId,
      repoRoot: normalizeProject(repoRoot),
    });
    setRenameChatDraft(chat?.title || "Untitled chat");
  };

  const handleCancelRenameChat = () => {
    setRenamingChat(null);
    setRenameChatDraft("");
  };

  const handleSubmitRenameChat = async (chat, repoRoot = snapshot?.config?.repoRoot || "") => {
    const currentTitle = chat?.title || "Untitled chat";
    const trimmedTitle = renameChatDraft.replace(/\s+/g, " ").trim();
    if (!trimmedTitle || trimmedTitle === currentTitle) {
      handleCancelRenameChat();
      return;
    }
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/rename", {
        chatId: chat.chatId,
        repoRoot,
        title: trimmedTitle,
      });
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);

      const normalizedRepoRoot = normalizeProject(repoRoot);
      if (normalizedRepoRoot && normalizedRepoRoot !== activeRepoRoot) {
        setProjectChats((current) => ({
          ...current,
          [normalizedRepoRoot]: (current[normalizedRepoRoot] || []).map((item) =>
            item.chatId === chat.chatId ? { ...item, title: trimmedTitle } : item,
          ),
        }));
      } else {
        void fetchProjectChats(repoRoot).catch(() => {});
      }
      handleCancelRenameChat();
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handlePickRepo = async () => {
    const picked = await window.desktopApi?.pickRepoDirectory?.();
    if (!picked) return;
    setProjectMenuPath("");
    setRepoDraft(picked);
    syncSavedProjects(picked);
    await handleConfigUpdate({ repoRoot: picked });
  };

  const handleOpenSavedProject = async (repoRoot) => {
    if (!repoRoot || repoRoot === snapshot?.config?.repoRoot) {
      setProjectMenuPath("");
      return;
    }
    setProjectMenuPath("");
    setRepoDraft(repoRoot);
    await handleConfigUpdate({ repoRoot });
  };

  const handleRemoveSavedProject = async (repoRoot) => {
    const nextProjects = savedProjects.filter((project) => project.path !== repoRoot);
    saveSavedProjects(nextProjects);
    setSavedProjects(nextProjects);
    setProjectMenuPath("");

    if (repoRoot === snapshot?.config?.repoRoot && nextProjects.length > 0) {
      await handleConfigUpdate({ repoRoot: nextProjects[0].path });
    }
  };

  const chatsForProject = (repoRoot) => {
    const projectPath = normalizeProject(repoRoot);
    if (projectPath === activeRepoRoot) {
      return snapshot?.chats || [];
    }
    return projectChats[projectPath] || [];
  };

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

  if (!snapshot) {
    return (
      <BootScreen
        appVersion={appVersion}
        bootHeadline={bootHeadline}
        bootMessage={bootMessage}
        bootStatusText={bootStatusText}
        error={error}
        snapshot={snapshot}
      />
    );
  }

  if (currentScreen === "settings") {
    return (
      <SettingsPage
        error={error}
        networkSettingsSaving={networkSettingsSaving}
        onBack={() => setCurrentScreen("chat")}
        onSave={handleSaveSettings}
        repoDraft={repoDraft}
        setRepoDraft={setRepoDraft}
        onPickRepo={handlePickRepo}
        promptPresets={PROMPT_PRESETS}
        settingsPromptPreset={settingsPromptPreset}
        setSettingsPromptPreset={setSettingsPromptPreset}
        assistantMemoryDraft={assistantMemoryDraft}
        setAssistantMemoryDraft={setAssistantMemoryDraft}
        contextCarryMessagesDraft={contextCarryMessagesDraft}
        setContextCarryMessagesDraft={setContextCarryMessagesDraft}
        themeMode={themeMode}
        setThemeMode={setThemeMode}
        resolvedTheme={resolvedTheme}
        showResourceDashboard={showResourceDashboard}
        setShowResourceDashboard={setShowResourceDashboard}
        uiPrefs={uiPrefs}
        updateUiPref={updateUiPref}
        onRestoreDisplayDefaults={restoreDisplayDefaults}
        remoteAccessEnabledDraft={remoteAccessEnabledDraft}
        setRemoteAccessEnabledDraft={setRemoteAccessEnabledDraft}
        remoteAccessUrls={remoteAccessUrls}
        providers={snapshot.providers}
        providerTestState={providerTestState}
        onTestProvider={handleTestProvider}
        showClearCacheConfirm={showClearCacheConfirm}
        setShowClearCacheConfirm={setShowClearCacheConfirm}
        onClearCache={handleClearCache}
        showDeleteSettingsConfirm={showDeleteSettingsConfirm}
        setShowDeleteSettingsConfirm={setShowDeleteSettingsConfirm}
        onDeleteSettingsFile={handleDeleteSettingsFile}
        configPath={snapshot?.config?.configPath || ""}
        backendUrl={backendUrl}
      />
    );
  }

  if (currentScreen === "audit") {
    return (
      <AuditPage
        backendUrl={backendUrl}
        repoRoot={snapshot.config.repoRoot}
        onBack={() => setCurrentScreen("chat")}
      />
    );
  }

  const workspaceShellStyle = {
    ...(updateBanner ? { paddingTop: 40 } : {}),
    ...(resolvedTheme === "light" ? { "--sidebar-bg": "#f8f8f8" } : {}),
  };

  return (
    <>
      <UpdateBanner
        updateBanner={updateBanner}
        onDismiss={() => {
          try {
            window.localStorage.setItem(DISMISSED_UPDATE_KEY, `${updateBanner.version}:${updateBanner.state}`);
          } catch {}
          setUpdateBanner(null);
        }}
      />
      <div
        className={`workspace-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
        data-theme={resolvedTheme}
        style={workspaceShellStyle}
        onClick={() => {
          setProjectMenuPath("");
          setModelMenuOpen(false);
          setEditorMenuOpen(false);
          setHeaderMoreOpen(false);
          setHeaderInfoOpen(false);
        }}
      >
        <AppNavbar
          snapshot={snapshot}
          activeModelId={activeModelId}
          activeModelShort={activeModelShort}
          activeChatRunning={activeChatRunning}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
          headerInfoOpen={headerInfoOpen}
          setHeaderInfoOpen={setHeaderInfoOpen}
          headerMoreOpen={headerMoreOpen}
          setHeaderMoreOpen={setHeaderMoreOpen}
          editorMenuOpen={editorMenuOpen}
          setEditorMenuOpen={setEditorMenuOpen}
          terminalPanelOpen={terminalPanelOpen}
          setCurrentScreen={setCurrentScreen}
          handlePickRepo={handlePickRepo}
          handleActivateChat={handleActivateChat}
          handleToggleTerminal={handleToggleTerminal}
          handleOpenInEditor={handleOpenInEditor}
          handleNewChat={handleNewChat}
          handleInterruptChat={handleInterruptChat}
          handleCopyWorkspacePath={handleCopyWorkspacePath}
        />

        <div className="workspace-body">
        <ProjectSidebar
          snapshot={snapshot}
          activeRepoRoot={activeRepoRoot}
          savedProjects={savedProjects}
          expandedRepos={expandedRepos}
          toggleRepo={toggleRepo}
          chatsForProject={chatsForProject}
          runningChatIds={runningChatIds}
          sendingChatIds={sendingChatIds}
          uiPrefs={uiPrefs}
          renamingChat={renamingChat}
          renameChatDraft={renameChatDraft}
          setRenameChatDraft={setRenameChatDraft}
          setConfirmDeleteChat={setConfirmDeleteChat}
          handleOpenMenu={handleOpenMenu}
          handleNewChat={handleNewChat}
          handleActivateChat={handleActivateChat}
          handleStartRenameChat={handleStartRenameChat}
          handleSubmitRenameChat={handleSubmitRenameChat}
          handleCancelRenameChat={handleCancelRenameChat}
          handleDeleteChat={handleDeleteChat}
        />

        <main className="chat-area">

          <div className="chat-main">
          {error && <div className="error-banner">{error}</div>}
          {pendingPairingDevices.length > 0 && (
            <PairingRequestsBanner
              pendingPairingDevices={pendingPairingDevices}
              pairingActionLoading={pairingActionLoading}
              handleApprovePairingDevice={handleApprovePairingDevice}
              handleRejectPairingDevice={handleRejectPairingDevice}
            />
          )}
          {!error && activeInterruptedRun && (
            <div className="recovery-banner">
              Previous response was interrupted. Continue from the last saved turn.
            </div>
          )}
          <TerminalPanelSection
            activeTerminalChatId={activeTerminalChatId}
            backendUrl={backendUrl}
            liveTermWriteRef={liveTermWriteRef}
            onClose={handleCloseTerminal}
            onRefresh={() => refreshTerminal().catch((nextError) => setError(String(nextError)))}
            onRunCommand={handleSendTerminalCommand}
            onSwitchToLive={handleSwitchToLive}
            onToggle={handleToggleTerminal}
            repoRoot={snapshot.config.repoRoot || ""}
            setTerminalDraft={setTerminalDraft}
            setTerminalViewMode={setTerminalViewMode}
            terminalDraft={terminalDraft}
            terminalOutputRef={terminalOutputRef}
            terminalPanelOpen={terminalPanelOpen}
            terminalSnapshot={terminalSnapshot}
            terminalViewMode={terminalViewMode}
          />
          {activePlan && (
            <PlanCard
              activePlan={activePlan}
              copyText={copyText}
              handleOpenLocalFile={handleOpenLocalFile}
              handleContinueWithPlan={handleContinueWithPlan}
            />
          )}

          {showResourceDashboard && (
            <ResourceDashboard resources={snapshot.resources} chats={snapshot.chats || []} />
          )}

          <ConversationSection
            activePendingTurn={activePendingTurn}
            copyText={copyText}
            displayMessages={displayMessages}
            onPickStarter={(prompt) => {
              setDraft(prompt);
              window.requestAnimationFrame(() => document.querySelector(".composer-panel textarea")?.focus());
            }}
            projectName={snapshot.config.repoRoot ? projectLabel(snapshot.config.repoRoot) : ""}
            scrollRef={scrollRef}
          />
          </div>{/* chat-main */}

          <ComposerPanel
            activeModelParent={activeModelParent}
            draft={draft}
            hoveredModelGroup={hoveredModelGroup}
            hoveredModelSubGroup={hoveredModelSubGroup}
            modelGroups={modelGroups}
            modelGroupStates={modelGroupStates}
            modelMenuOpen={modelMenuOpen}
            modelMenuPos={modelMenuPos}
            modelPickerRef={modelPickerRef}
            onChangeDraft={setDraft}
            onChooseModel={(modelId) => {
              setModelMenuOpen(false);
              setHoveredModelGroup("");
              setHoveredModelSubGroup("");
              void handleConfigUpdate({ model: modelId });
            }}
            onHoverGroup={(g) => { setHoveredModelGroup(g); setHoveredModelSubGroup(""); }}
            onHoverSubGroup={setHoveredModelSubGroup}
            onPromptPresetChange={handlePromptPresetChange}
            onSend={handleSend}
            onStop={handleInterruptChat}
            running={terminalViewMode === "chat" && activeChatRunning}
            enterToSend={uiPrefs.enterToSend}
            onToggleModelMenu={toggleModelMenu}
            onToolSafetyChange={handleToolSafetyChange}
            promptPreset={snapshot.config.promptPreset}
            selectedModelId={snapshot.config.model}
            sendingDisabled={terminalViewMode === "chat" && Boolean(snapshot.config.activeChatId) && sendingChatIds.includes(snapshot.config.activeChatId)}
            terminalPanelOpen={terminalPanelOpen}
            terminalViewMode={terminalViewMode}
            toolSafetyMode={snapshot.config.toolSafetyMode}
          />
        </main>
        </div>{/* workspace-body */}
      </div>

      {projectMenuPath && (
        <ProjectContextMenu
          left={projectMenuPos.left}
          onCopyPath={() => {
            void handleCopyWorkspacePath(projectMenuPath);
          }}
          onOpenFolder={() => {
            void handleOpenSavedProject(projectMenuPath);
            setProjectMenuPath("");
          }}
          onRemove={() => {
            void handleRemoveSavedProject(projectMenuPath);
            setProjectMenuPath("");
          }}
          top={projectMenuPos.top}
        />
      )}

      {confirmDeleteChat && (
        <ConfirmDeleteChatDialog
          confirmDeleteChat={confirmDeleteChat}
          setConfirmDeleteChat={setConfirmDeleteChat}
          handleDeleteChat={handleDeleteChat}
        />
      )}

      {splashVisible && (
        <BootScreen
          appVersion={appVersion}
          bootDismissed={bootDismissed}
          bootHeadline={bootHeadline}
          bootMessage={bootMessage}
          bootStatusText={bootStatusText}
          error={error}
          overlay
          snapshot={snapshot}
          workspaceLabel={snapshot?.config?.repoRoot ? projectLabel(snapshot.config.repoRoot) : "PENDING"}
        />
      )}
    </>
  );
}
