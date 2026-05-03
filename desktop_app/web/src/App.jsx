import React, { useEffect, useMemo, useRef, useState } from "react";
import SettingsPage from "./SettingsPage.jsx";
import { EXTERNAL_EDITOR_OPTIONS, FALLBACK_APP_VERSION, PROMPT_PRESETS, QUICK_COMMANDS, SAVED_PROJECTS_KEY } from "./app/constants.js";
import {
  cleanResponse,
  groupedModels,
  loadSavedProjects,
  loadThemeMode,
  normalizeProject,
  parentModelLabel,
  projectLabel,
  providerCliLaunchCommand,
  providerStateForGroup,
  readDesktopConfig,
  readNdjsonStream,
  saveSavedProjects,
  saveThemeMode,
  stripPresetPrefix,
  upsertProject,
} from "./app/utils.js";
import BootScreen from "./components/BootScreen.jsx";
import ComposerPanel from "./components/ComposerPanel.jsx";
import ConversationSection from "./components/ConversationSection.jsx";
import EditorIcon from "./components/EditorIcon.jsx";
import ProjectContextMenu from "./components/ProjectContextMenu.jsx";
import TerminalPanelSection from "./components/TerminalPanelSection.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";

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
  const [liveStatus, setLiveStatus] = useState("Idle");
  const [pendingTurns, setPendingTurns] = useState({});
  const [sendingChatIds, setSendingChatIds] = useState([]);
  const [messageQueue, setMessageQueue] = useState({});
  const [currentScreen, setCurrentScreen] = useState("chat");
  const [savedProjects, setSavedProjects] = useState(() => loadSavedProjects());
  const [projectMenuPath, setProjectMenuPath] = useState("");
  const [projectMenuPos, setProjectMenuPos] = useState({ top: 0, left: 0 });
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuPos, setModelMenuPos] = useState({ bottom: 0, left: 0 });
  const modelPickerRef = useRef(null);
  const [hoveredModelGroup, setHoveredModelGroup] = useState("");
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
  const [themeMode, setThemeMode] = useState(() => loadThemeMode());
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
  const activeChat = useMemo(
    () => snapshot?.chats?.find((chat) => chat.chatId === snapshot?.config?.activeChatId) || null,
    [snapshot],
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
  const activeModelShort = activeModelId.replace(/^codex:|^gemini-cli:|^claude:/, "");
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

    if (activePendingTurn?.userMessage) {
      visible.push({ role: "user", content: activePendingTurn.userMessage, pending: true });
    }
    if (activePendingTurn?.assistantText) {
      visible.push({ role: "assistant", content: activePendingTurn.assistantText, pending: true });
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
    setLiveStatus("Idle");
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
    setLiveStatus("Stopping request...");
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
      setLiveStatus("Interrupt failed");
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
      setLiveStatus("Idle");
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

  const copyText = async (text, status) => {
    try {
      await navigator.clipboard.writeText(text);
      setLiveStatus(status);
      window.setTimeout(() => setLiveStatus("Idle"), 1200);
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

  const handleOpenTerminal = async () => {
    if (!activeTerminalChatId) {
      setError("Start or select a chat before opening a terminal.");
      return;
    }
    setError("");
    try {
      const nextSnapshot = await postJson("/api/terminal/open", {
        chatId: activeTerminalChatId,
        repoRoot: snapshot?.config?.repoRoot || "",
        cols: 100,
        rows: 24,
      });
      setTerminalSnapshot(nextSnapshot);
      setTerminalPanelOpen(true);
    } catch (nextError) {
      setError(String(nextError));
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
          setLiveStatus(`Done in ${event.elapsedSeconds}s`);
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
    if (activeChatIdRef.current === currentChatId) {
      setLiveStatus("Starting request...");
    }

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
          case "status":
            if (activeChatIdRef.current === eventChatId || activeChatIdRef.current === "") {
              setLiveStatus(event.message || event.phase || "Working...");
            }
            break;
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
            if (activeChatIdRef.current === eventChatId) {
              setLiveStatus(`Done in ${event.elapsedSeconds}s`);
            }
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
            if (activeChatIdRef.current === eventChatId || activeChatIdRef.current === "") {
              setLiveStatus("Request interrupted");
            }
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
              setLiveStatus("Request failed");
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
      setLiveStatus("Request failed");
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
    if (!window.confirm("Permanently delete this chat?")) return;
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
      />
    );
  }

  return (
    <>
      <UpdateBanner updateBanner={updateBanner} onDismiss={() => setUpdateBanner(null)} />
      <div
        className={`workspace-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
        style={updateBanner ? { paddingTop: 40 } : undefined}
        onClick={() => {
          setProjectMenuPath("");
          setModelMenuOpen(false);
          setEditorMenuOpen(false);
          setHeaderMoreOpen(false);
          setHeaderInfoOpen(false);
        }}
      >
        <aside className="sidebar">
          <div className="sidebar-section">
            <div className="sidebar-heading-row">
              <div>
                <div className="sidebar-label">Projects</div>
                <div className="sidebar-note">Saved folders and repos</div>
              </div>
              <button type="button" className="icon-button" onClick={handlePickRepo}>
                +
              </button>
            </div>

            <div className="project-list">
              {savedProjects.length === 0 && (
                <div className="rail-empty">Add a folder or project to start exploring files.</div>
              )}
              {savedProjects.map((project) => (
                <div key={project.path} className="project-group">
                  <div
                    className={
                      project.path === snapshot.config.repoRoot ? "project-item active" : "project-item"
                    }
                  >
                    <button
                      type="button"
                      className="project-main"
                      onClick={() => toggleRepo(project.path)}
                      title={project.path}
                    >
                      <span className="project-name">
                        <span className={expandedRepos.has(project.path) ? "chevron-icon expanded" : "chevron-icon"}>&gt;</span>{" "}
                        {project.name}
                      </span>
                    </button>
                    <div className="project-actions" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="project-action-btn"
                        onClick={() => void handleNewChat(project.path)}
                        title="New chat in project"
                      >
                        +
                      </button>
                      <div className="project-menu-wrap">
                        <button
                          type="button"
                          className="project-menu-trigger"
                          onClick={(event) => handleOpenMenu(event, project.path)}
                        >
                          ...
                        </button>
                      </div>
                    </div>
                  </div>

                  {expandedRepos.has(project.path) && (
                    <div className="project-detail-list">
                      {chatsForProject(project.path).length === 0 && <div className="rail-empty">No chats yet.</div>}
                      {chatsForProject(project.path).map((chat) => {
                        const showChatLoading =
                          runningChatIds.includes(chat.chatId) || sendingChatIds.includes(chat.chatId);
                        const showInterrupted = Boolean(chat.interrupted) && !showChatLoading;
                        const normalizedProjectPath = normalizeProject(project.path);
                        const isRenaming =
                          renamingChat?.chatId === chat.chatId &&
                          renamingChat?.repoRoot === normalizedProjectPath;

                        return (
                          <div
                            key={`${normalizedProjectPath}:${chat.chatId}`}
                            className={
                              chat.chatId === snapshot.config.activeChatId &&
                              normalizedProjectPath === activeRepoRoot
                                ? "chat-sidebar-row active"
                                : "chat-sidebar-row"
                            }
                            onClick={() => {
                              if (!isRenaming) {
                                handleActivateChat(chat.chatId, project.path);
                              }
                            }}
                          >
                            {isRenaming ? (
                              <input
                                className="chat-rename-input"
                                value={renameChatDraft}
                                autoFocus
                                ref={(input) => {
                                  if (input) {
                                    window.requestAnimationFrame(() => {
                                      input.focus();
                                      const end = input.value.length;
                                      input.setSelectionRange(end, end);
                                    });
                                  }
                                }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => setRenameChatDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    void handleSubmitRenameChat(chat, project.path);
                                  }
                                  if (event.key === "Escape") {
                                    event.preventDefault();
                                    handleCancelRenameChat();
                                  }
                                }}
                                onBlur={() => void handleSubmitRenameChat(chat, project.path)}
                              />
                            ) : (
                              <>
                                <button type="button" className="chat-sidebar-item" title={chat.title}>
                                  <span className="chat-dot"></span>
                                  <span className="chat-truncate">{chat.title || "Untitled chat"}</span>
                                </button>
                                {showChatLoading && <span className="chat-loading-spinner" aria-hidden="true"></span>}
                                {showInterrupted && (
                                  <span
                                    className="chat-recovery-indicator"
                                    title="Previous response was interrupted and can be resumed from this chat."
                                    aria-hidden="true"
                                  >
                                    !
                                  </span>
                                )}
                              </>
                            )}
                            {!isRenaming && (
                              <button
                                type="button"
                                className="chat-rename-btn"
                                onClick={(event) => handleStartRenameChat(event, chat, project.path)}
                                title="Rename chat"
                                aria-label="Rename chat"
                              >
                                Aa
                              </button>
                            )}
                            <button
                              type="button"
                              className="chat-delete-btn"
                              onClick={(event) => handleDeleteChat(event, chat.chatId, project.path)}
                              title="Delete chat"
                              aria-label="Delete chat"
                            >
                              x
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </aside>

        <main className="chat-area">
          <header className="chat-topbar">
            <div className="topbar-left">
              <button
                type="button"
                className="sidebar-toggle-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  setSidebarCollapsed((prev) => !prev);
                }}
                title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              >
                {sidebarCollapsed ? ">" : "<"}
              </button>
              <select
                className="header-thread-select"
                value={snapshot.config.activeChatId || ""}
                onChange={(event) => {
                  if (event.target.value) {
                    void handleActivateChat(event.target.value);
                  }
                }}
              >
                <option value="">New thread</option>
                {snapshot.chats.map((chat) => (
                  <option key={chat.chatId} value={chat.chatId}>
                    {chat.title}
                  </option>
                ))}
              </select>
              <span className="project-badge">{projectLabel(snapshot.config.repoRoot)}</span>
              <span className="provider-badge">{snapshot.providerName}</span>
              <span className="model-badge" title={activeModelId}>{activeModelShort}</span>

              <div className="header-info-wrap" onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="header-info-trigger"
                  onClick={() => {
                    setHeaderMoreOpen(false);
                    setHeaderInfoOpen((current) => !current);
                  }}
                  title="Context info"
                >
                  <span className="info-icon">i</span>
                </button>
                {headerInfoOpen && (
                  <div className="header-menu header-info-menu">
                    <div className="info-section">
                      <div className="info-label">Project</div>
                      <div className="info-value">{snapshot.config.repoRoot}</div>
                    </div>
                    <div className="info-section">
                      <div className="info-label">Provider</div>
                      <div className="info-value">{snapshot.providerName}</div>
                    </div>
                    <div className="info-section">
                      <div className="info-label">Model</div>
                      <div className="info-value">{activeModelShort}</div>
                      <div className="info-detail">{activeModelId}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="topbar-right">
              <div className="topbar-actions-primary">
                <button
                  type="button"
                  className={terminalPanelOpen ? "secondary-button terminal-toggle active" : "secondary-button terminal-toggle"}
                  onClick={() => void handleToggleTerminal()}
                >
                  {terminalPanelOpen ? "Hide terminal" : "Show terminal"}
                </button>
                {activeChatRunning && (
                  <button type="button" className="secondary-button" onClick={handleInterruptChat}>
                    Stop
                  </button>
                )}
              </div>
              <div className="topbar-actions-secondary">
                <div className="header-menu-wrap">
                  <button
                    type="button"
                    className="secondary-button header-menu-trigger"
                    onClick={(event) => {
                      event.stopPropagation();
                      setHeaderMoreOpen(false);
                      setEditorMenuOpen((current) => !current);
                    }}
                  >
                    Open in
                  </button>
                  {editorMenuOpen && (
                    <div className="header-menu">
                      {EXTERNAL_EDITOR_OPTIONS.map((editor) => (
                        <button
                          key={editor.id}
                          type="button"
                          onClick={(event) => { event.stopPropagation(); void handleOpenInEditor(editor.id); }}
                        >
                          <span className="header-menu-item-icon">
                            <EditorIcon editorId={editor.id} />
                          </span>
                          <span>{editor.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button type="button" className="secondary-button" onClick={() => void handleNewChat()}>
                  New chat
                </button>
                <button type="button" className="secondary-button" onClick={() => setCurrentScreen("settings")}>
                  Settings
                </button>
              </div>
              <div className="header-more-wrap" onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="secondary-button header-more-trigger"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditorMenuOpen(false);
                    setHeaderMoreOpen((current) => !current);
                  }}
                >
                  More
                </button>
                {headerMoreOpen && (
                  <div className="header-menu header-more-menu">
                    {/* Primary actions in More menu for smaller screens */}
                    <div className="header-menu-section mobile-only-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setHeaderMoreOpen(false);
                          void handleToggleTerminal();
                        }}
                      >
                        <span>{terminalPanelOpen ? "Hide terminal" : "Show terminal"}</span>
                      </button>
                      {activeChatRunning && (
                        <button
                          type="button"
                          onClick={() => {
                            setHeaderMoreOpen(false);
                            handleInterruptChat();
                          }}
                        >
                          <span>Stop</span>
                        </button>
                      )}
                      <div className="header-menu-divider"></div>
                    </div>

                    {EXTERNAL_EDITOR_OPTIONS.map((editor) => (
                      <button
                        key={editor.id}
                        type="button"
                        onClick={() => {
                          setHeaderMoreOpen(false);
                          void handleOpenInEditor(editor.id);
                        }}
                      >
                        <span className="header-menu-item-icon">
                          <EditorIcon editorId={editor.id} />
                        </span>
                        <span>Open in {editor.label}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreOpen(false);
                        void handleNewChat();
                      }}
                    >
                      <span>New chat</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreOpen(false);
                        void handleCopyWorkspacePath();
                      }}
                    >
                      <span>Copy workspace path</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreOpen(false);
                        setCurrentScreen("settings");
                      }}
                    >
                      <span>Settings</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>

          <div className="chat-main">
          {error && <div className="error-banner">{error}</div>}
          {pendingPairingDevices.length > 0 && (
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
            <section className="plan-card">
              <div className="plan-card-header">
                <div>
                  <div className="plan-card-label">Plan</div>
                  <div className="plan-card-title">{activePlan.title || "Implementation Plan"}</div>
                </div>
                <div className="plan-card-actions">
                  <button type="button" className="secondary-button" onClick={() => void copyText(activePlan.content || "", "Plan copied")}>
                    Copy
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void handleOpenLocalFile(activePlan.path)}>
                    Open file
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void handleContinueWithPlan()}>
                    Continue with plan
                  </button>
                </div>
              </div>
              <div className="plan-card-path">{activePlan.path}</div>
              <pre className="plan-card-preview">{String(activePlan.content || "")}</pre>
            </section>
          )}

          <ConversationSection
            activePendingTurn={activePendingTurn}
            copyText={copyText}
            displayMessages={displayMessages}
            scrollRef={scrollRef}
          />
          </div>{/* chat-main */}

          <ComposerPanel
            activeModelParent={activeModelParent}
            draft={draft}
            hoveredModelGroup={hoveredModelGroup}
            modelGroups={modelGroups}
            modelGroupStates={modelGroupStates}
            modelMenuOpen={modelMenuOpen}
            modelMenuPos={modelMenuPos}
            modelPickerRef={modelPickerRef}
            onChangeDraft={setDraft}
            onChooseModel={(modelId) => {
              setModelMenuOpen(false);
              setHoveredModelGroup("");
              void handleConfigUpdate({ model: modelId });
            }}
            onHoverGroup={setHoveredModelGroup}
            onPromptPresetChange={handlePromptPresetChange}
            onSend={handleSend}
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
