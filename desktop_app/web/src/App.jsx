import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const PROMPT_PRESETS = [
  { value: "chat", label: "Chat" },
  { value: "code", label: "Code" },
  { value: "plan", label: "Plan" },
  { value: "debug", label: "Debug" },
  { value: "refactor", label: "Refactor" },
  { value: "explain", label: "Explain" },
];

const TOOL_SAFETY_OPTIONS = [
  { value: "write", label: "Write-enabled" },
  { value: "read", label: "Read-only" },
];

const EXTERNAL_EDITOR_OPTIONS = [
  { id: "vscode", label: "VS Code" },
  { id: "antigravity", label: "Antigravity" },
  { id: "cursor", label: "Cursor" },
];

const FALLBACK_APP_VERSION = "0.0.1";
const THEME_MODE_STORAGE_KEY = "gpt-tui.theme-mode";

function EditorIcon({ editorId }) {
  if (editorId === "vscode") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M16.2 2.4 7.8 10l-4-3.1L1.4 8.1l4.2 3.9-4.2 3.9 2.4 1.2 4-3.1 8.4 7.6 5.4-2.6V5z"
        />
      </svg>
    );
  }
  if (editorId === "cursor") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 2 4 7v10l8 5 8-5V7zm0 2.2 5.8 3.6L12 11.4 6.2 7.8zM6 9.5l5 3.1v6.8L6 16.3zm7 9.9v-6.8l5-3.1v6.8z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2c-1.7 3.6-5.3 5.1-8 5.6 1.5 1.8 2.6 4.3 2.6 7 0 2.7-1.1 5.2-2.6 7 2.7-.5 6.3-2 8-5.6 1.7 3.6 5.3 5.1 8 5.6-1.5-1.8-2.6-4.3-2.6-7 0-2.7 1.1-5.2 2.6-7-2.7-.5-6.3-2-8-5.6z"
      />
    </svg>
  );
}

const SAVED_PROJECTS_KEY = "gpt-tui.saved-projects";

function loadThemeMode() {
  try {
    const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // ignore
  }
  return "system";
}

function saveThemeMode(mode) {
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

function groupedModels(models) {
  const grouped = new Map();
  for (const model of models) {
    const items = grouped.get(model.group) || [];
    items.push(model);
    grouped.set(model.group, items);
  }
  return [...grouped.entries()];
}

function parentModelLabel(modelId, modelGroups) {
  for (const [group, items] of modelGroups) {
    if (items.some((model) => model.id === modelId)) {
      return group;
    }
  }
  return "Model";
}

function providerStateForGroup(group, providers) {
  if (group === "Claude") {
    return providers?.claude || { available: false, connected: false };
  }
  if (group === "Gemini") {
    return providers?.gemini || { available: false, connected: false };
  }
  if (group === "Gemini CLI") {
    return providers?.geminiCli || { available: false, connected: false };
  }
  if (group === "Codex") {
    return providers?.codex || { available: false, connected: false };
  }
  if (group === "Groq") {
    return providers?.groq || { available: false, connected: false };
  }
  return { available: false, connected: false };
}

function stripPresetPrefix(text) {
  return text.replace(/^\[Mode:[^\]]+\][^\n]*\n\n/, "").trim();
}

function cleanResponse(text) {
  if (!text) return "";

  let cleaned = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,10}(?:;[0-9]{0,10})*)?[0-9A-ORZcf-nqry=><]/g, "");
  const metadataPatterns = [
    /^(workdir|model|provider|approval|sandbox|reasoning|session id|tokens used):.*$/gim,
    /^OpenAI Codex v[\d.]+.*$/gim,
    /^Conversation context:.*$/gim,
    /^Latest request:.*$/gim,
    /^-{2,}$/gm,
  ];

  metadataPatterns.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, "");
  });

  cleaned = cleaned.replace(/OpenAI Codex[\s\S]*?(-{2,}|Latest request:)/gim, "");
  cleaned = cleaned.replace(/^(user|assistant|codex|system)\s*$/gim, "");
  cleaned = cleaned.replace(/\[Mode: [^\]]+\][^\n]*/gi, "");
  cleaned = cleaned.replace(/\[\d+m/g, "");
  cleaned = cleaned.replace(/\[0m/g, "");

  return cleaned.trim().replace(/\n{3,}/g, "\n\n");
}

function projectLabel(repoRoot) {
  if (!repoRoot) {
    return "Workspace";
  }
  return repoRoot.split(/[/\\]/).filter(Boolean).at(-1) || repoRoot;
}

function normalizeProject(repoRoot) {
  return String(repoRoot || "").trim().replaceAll("/", "\\");
}

function diffLineClass(line) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("---") || line.startsWith("+++")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

function loadSavedProjects() {
  try {
    const raw = window.localStorage.getItem(SAVED_PROJECTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => normalizeProject(item?.path || item))
      .filter(Boolean)
      .map((path) => ({ path, name: projectLabel(path) }));
  } catch {
    return [];
  }
}

function saveSavedProjects(projects) {
  window.localStorage.setItem(SAVED_PROJECTS_KEY, JSON.stringify(projects));
}

function upsertProject(projects, repoRoot) {
  const path = normalizeProject(repoRoot);
  if (!path) {
    return projects;
  }
  if (projects.some((project) => project.path === path)) {
    return projects;
  }
  return [...projects, { path, name: projectLabel(path) }];
}

async function readDesktopConfig() {
  if (window.desktopApi?.getConfig) {
    return window.desktopApi.getConfig();
  }
  return {
    backendUrl: import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8765",
    remoteAccessEnabled: false,
    remoteAccessUrls: [],
  };
}

async function readNdjsonStream(response, onEvent) {
  if (!response.body) {
    throw new Error("Streaming response body is not available.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      onEvent(JSON.parse(trimmed));
    }
  }

  const tail = buffer.trim();
  if (tail) {
    onEvent(JSON.parse(tail));
  }
}

export default function App() {
  const scrollRef = useRef(null);
  const activeChatIdRef = useRef("");
  const bootStartedAtRef = useRef(Date.now());
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
  const [diffPanelOpen, setDiffPanelOpen] = useState(false);
  const [selectedDiffIndex, setSelectedDiffIndex] = useState(0);
  const [gitChanges, setGitChanges] = useState([]);
  const [gitChangesError, setGitChangesError] = useState(null);
  const [showClearCacheConfirm, setShowClearCacheConfirm] = useState(false);
  const [showDeleteSettingsConfirm, setShowDeleteSettingsConfirm] = useState(false);
  const [providerTestState, setProviderTestState] = useState({});
  const [headerMoreOpen, setHeaderMoreOpen] = useState(false);
  const [headerInfoOpen, setHeaderInfoOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [renamingChat, setRenamingChat] = useState(null);
  const [renameChatDraft, setRenameChatDraft] = useState("");
  const [themeMode, setThemeMode] = useState(() => loadThemeMode());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true,
  );

  const runningChatIds = snapshot?.runningChatIds || [];
  const interruptedRuns = snapshot?.interruptedRuns || [];
  const activeChanges = gitChanges;
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
  }, [snapshot?.config?.activeChatId]);

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

  const fetchGitChanges = async (repoRoot) => {
    const root = repoRoot || snapshot?.config?.repoRoot || "";
    if (!root) return;
    try {
      const response = await fetch(`${backendUrl}/api/workspace/git-status?repoRoot=${encodeURIComponent(root)}`);
      const data = await response.json();
      setGitChanges(data.changes || []);
      setGitChangesError(data.error || null);
    } catch (err) {
      setGitChanges([]);
      setGitChangesError(String(err));
    }
  };

  // Poll git changes every 5s so the button count stays current
  useEffect(() => {
    if (!snapshot?.config?.repoRoot) return;
    void fetchGitChanges();
    const interval = setInterval(() => void fetchGitChanges(), 30000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.config?.repoRoot]);

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
      setDiffPanelOpen(false);
      setSelectedDiffIndex(0);
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

  const handleOpenDiffFile = async () => {
    if (!selectedDiff) {
      return;
    }
    const filePath = `${snapshot?.config?.repoRoot || ""}\\${selectedDiff.path.replaceAll("/", "\\")}`;
    setError("");
    try {
      await window.desktopApi?.openFile?.(filePath);
    } catch (nextError) {
      setError(String(nextError));
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

  const handleSend = async () => {
    if (!draft.trim()) return;

    const outgoingMessage = draft.trim();
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
              void fetchGitChanges(event.snapshot.config.repoRoot);
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
            setPendingTurns((current) => ({
              ...current,
              [eventChatId]: {
                chatId: eventChatId,
                userMessage: current[eventChatId]?.userMessage || outgoingMessage,
                assistantText: event.partialText || current[eventChatId]?.assistantText || "",
                running: false,
              },
            }));
            setSendingChatIds((current) => current.filter((chatId) => chatId !== eventChatId && chatId !== requestKey));
            if (activeChatIdRef.current === eventChatId || activeChatIdRef.current === "") {
              setLiveStatus("Request interrupted");
            }
            break;
          case "error":
            setPendingTurns((current) => {
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
        const next = { ...current };
        delete next[requestKey];
        return next;
      });
      setSendingChatIds((current) => current.filter((chatId) => chatId !== requestKey));
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

  const selectedDiff = activeChanges[selectedDiffIndex] || null;

  useEffect(() => {
    setSelectedDiffIndex((current) => Math.min(current, Math.max(0, activeChanges.length - 1)));
  }, [activeChanges]);

  if (!snapshot) {
    return (
      <div className="boot-screen">
        <div className="boot-container">
          <div className="boot-main">
            <div className="boot-glow"></div>
            
            <div className="boot-hex-wrap">
              <div className="boot-hex">
                <div className="boot-hex-inner"></div>
              </div>
            </div>
            
            <div className="boot-content">
              <div className="boot-badge">{error ? "SYSTEM HALTED" : "BOOT PROTOCOL"}</div>
              <h1 className="boot-title">{bootHeadline}</h1>
              <p className="boot-subtitle">{bootMessage}</p>
            </div>

            <div className="boot-progress-wrap">
              <div className="boot-progress-track">
                <div 
                  className="boot-progress-fill" 
                  style={{ width: snapshot ? "100%" : "72%" }}
                ></div>
              </div>
              <div className="boot-progress-labels">
                <span className="boot-status-text">{bootStatusText}</span>
                <span className="boot-percent">{snapshot ? "Ready" : "Loading"}</span>
              </div>
            </div>
          </div>
          
          <div className="boot-footer">
            <div className="boot-footer-item">
              <span className="label">APP</span>
              <span className="value">Cortex</span>
            </div>
            <div className="boot-footer-item">
              <span className="label">ENVIRONMENT</span>
              <span className="value">Desktop</span>
            </div>
            <div className="boot-footer-item">
              <span className="label">VERSION</span>
              <span className="value">v{appVersion}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (currentScreen === "settings") {
    return (
      <div className="settings-screen">
        <div className="settings-page">
          <header className="settings-page-header">
            <div className="settings-page-heading">
              <button type="button" className="secondary-button settings-back" onClick={() => setCurrentScreen("chat")}>
                Back
              </button>
              <div>
                <div className="settings-title">Settings</div>
                <div className="settings-subtitle">Provider access, memory, and workspace behavior</div>
              </div>
            </div>
            <button type="button" className="primary-button" onClick={handleSaveSettings}>
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
                  <button type="button" onClick={handlePickRepo}>
                    Browse
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Default mode</span>
                <select value={settingsPromptPreset} onChange={(event) => setSettingsPromptPreset(event.target.value)}>
                  {PROMPT_PRESETS.map((preset) => (
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
                {Object.entries(snapshot.providers).map(([providerId, provider]) => (
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
                        onClick={() => void handleTestProvider(providerId)}
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
                <button type="button" className="danger-button" onClick={handleClearCache}>
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
              <div className="confirm-path">{snapshot?.config?.configPath || "Unavailable"}</div>
              <div className="confirm-actions">
                <button type="button" className="secondary-button" onClick={() => setShowDeleteSettingsConfirm(false)}>
                  Cancel
                </button>
                <button type="button" className="danger-button" onClick={handleDeleteSettingsFile}>
                  Delete file
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className={`workspace-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
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
                        <span className={expandedRepos.has(project.path) ? "chevron-icon expanded" : "chevron-icon"}>â€º</span>{" "}
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
                {sidebarCollapsed ? "Â»" : "Â«"}
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
                  className="secondary-button"
                  onClick={() => setDiffPanelOpen((current) => !current)}
                >
                  {diffPanelOpen ? `Hide diff (${activeChanges.length})` : `Show diff (${activeChanges.length})`}
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
                          setDiffPanelOpen((current) => !current);
                        }}
                      >
                        <span>{diffPanelOpen ? "Hide diff" : `Show diff (${activeChanges.length})`}</span>
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
          {!error && activeInterruptedRun && (
            <div className="recovery-banner">
              Previous response was interrupted. Continue from the last saved turn.
            </div>
          )}
          {diffPanelOpen && (
            <section className="diff-panel">
              <div className="diff-file-list">
                <div className="diff-file-list-header">
                  <span className="diff-file-list-title">Git changes ({activeChanges.length})</span>
                  <button type="button" className="secondary-button" onClick={() => void fetchGitChanges()}>Refresh</button>
                </div>
                {gitChangesError && (
                  <div className="diff-git-error">{gitChangesError}</div>
                )}
                {activeChanges.map((change, index) => (
                  <button
                    key={`${change.path}-${index}`}
                    type="button"
                    className={selectedDiffIndex === index ? "diff-file-item active" : "diff-file-item"}
                    onClick={() => setSelectedDiffIndex(index)}
                  >
                    <span className={`change-action ${change.action}`}>{change.action}</span>
                    <span className="diff-file-name">{change.path}</span>
                  </button>
                ))}
              </div>
              <div className="diff-viewer">
                {selectedDiff && (
                  <>
                    <div className="diff-viewer-header">
                      <span className={`change-action ${selectedDiff.action}`}>{selectedDiff.action}</span>
                      <span className="change-path">{selectedDiff.path}</span>
                    </div>
                    <div className="diff-viewer-actions">
                      <button type="button" className="secondary-button" onClick={() => void copyText(selectedDiff.diff || "", "Diff copied")}>
                        Copy diff
                      </button>
                      <button type="button" className="secondary-button" onClick={handleOpenDiffFile}>
                        Open file
                      </button>
                    </div>
                    {(selectedDiff.oldPath || selectedDiff.newPath) &&
                      selectedDiff.oldPath !== selectedDiff.newPath && (
                        <div className="change-rename-row">
                          {selectedDiff.oldPath || selectedDiff.path}
                          {" -> "}
                          {selectedDiff.newPath || selectedDiff.path}
                        </div>
                      )}
                    <div className="change-diff-preview">
                      {(selectedDiff.diff || "No diff available.").split("\n").map((line, index) => (
                        <div key={`${index}-${line}`} className={`diff-line ${diffLineClass(line)}`}>
                          {line || " "}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

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

          <section className="conversation-scroll" ref={scrollRef}>
            {displayMessages.length === 0 ? (
              <div className="conversation-empty">
                <h2>Start a conversation</h2>
                <p>Ask about the current repo, request changes, or inspect the codebase.</p>
              </div>
            ) : (
              displayMessages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`message-row ${message.role}${message.pending ? " pending" : ""}`}
                >
                  <div className="message-bubble">
                    {message.role === "assistant" && (
                      <div className="message-actions">
                        <button
                          type="button"
                          className="message-copy-btn"
                          onClick={() => void copyText(String(message.content || ""), "Response copied")}
                        >
                          Copy
                        </button>
                      </div>
                    )}
                    <div className="message-content">
                      <pre>{String(message.content || "")}</pre>
                    </div>
                  </div>
                </div>
              ))
            )}
            {activePendingTurn?.running && (
              <div className="message-row assistant">
                <div className="thinking-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}
          </section>
          </div>{/* chat-main */}

          <div className="composer-panel">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="Ask for changes, inspect the repo, or debug a file..."
            />
            <div className="composer-footer">
              <div className="composer-controls">
                <select
                  value={snapshot.config.promptPreset || "code"}
                  onChange={(event) => void handlePromptPresetChange(event.target.value)}
                  title="Prompt mode"
                >
                  {PROMPT_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <select
                  value={snapshot.config.toolSafetyMode || "write"}
                  onChange={(event) => void handleToolSafetyChange(event.target.value)}
                  title="Chat permissions"
                >
                  {TOOL_SAFETY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <div
                  className="model-picker"
                >
                  <button
                    ref={modelPickerRef}
                    type="button"
                    className="model-picker-trigger"
                    title={snapshot.config.model}
                    onClick={toggleModelMenu}
                  >
                    <span>{activeModelParent}</span>
                    <span className={modelMenuOpen ? "model-picker-caret open" : "model-picker-caret"}>{">"}</span>
                  </button>
                  {modelMenuOpen && createPortal(
                    <>
                    <div className="model-picker-menu" onClick={(event) => event.stopPropagation()} style={{ position: "fixed", bottom: modelMenuPos.bottom, left: modelMenuPos.left, top: "auto" }}>
                      <div className="model-group-list">
                        {modelGroups.map(([group, items]) => (
                          <button
                            key={group}
                            type="button"
                            className={
                              !modelGroupStates.get(group)?.connected
                                ? "model-group-item disabled"
                                : hoveredModelGroup === group
                                  ? "model-group-item active"
                                  : "model-group-item"
                            }
                            disabled={!modelGroupStates.get(group)?.connected}
                            onMouseEnter={() => setHoveredModelGroup(group)}
                            onFocus={() => setHoveredModelGroup(group)}
                            title={
                              modelGroupStates.get(group)?.connected
                                ? group
                                : `${group} is not ready`
                            }
                          >
                            <span>{group}</span>
                            <span className="model-group-arrow">
                              {modelGroupStates.get(group)?.connected ? ">" : "!"}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="model-submenu-flyout" onClick={(event) => event.stopPropagation()} style={{ position: "fixed", bottom: modelMenuPos.bottom, left: modelMenuPos.left + 188, top: "auto" }}>
                      <div className="model-submenu">
                        {(
                          modelGroups.find(([group]) => group === hoveredModelGroup) ||
                          modelGroups.find(([group]) => modelGroupStates.get(group)?.connected) ||
                          [null, []]
                        )[1].map((model) => (
                          <button
                            key={model.id}
                            type="button"
                            className={snapshot.config.model === model.id ? "model-subitem active" : "model-subitem"}
                            title={model.label}
                            onClick={() => {
                              setModelMenuOpen(false);
                              setHoveredModelGroup("");
                              void handleConfigUpdate({ model: model.id });
                            }}
                          >
                            <span className="model-subitem-name">{model.id.replace(/^codex:|^gemini-cli:/, "")}</span>
                            <span className="model-subitem-meta">{model.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    </>,
                    document.body
                  )}
                </div>
              </div>
              <button
                type="button"
                className="primary-button"
                onClick={handleSend}
                disabled={Boolean(snapshot.config.activeChatId) && sendingChatIds.includes(snapshot.config.activeChatId)}
              >
                Send
              </button>
            </div>
          </div>
        </main>
      </div>

      {projectMenuPath && (
        <div
          className="project-menu fixed-menu"
          style={{
            position: "fixed",
            top: `${projectMenuPos.top}px`,
            left: `${projectMenuPos.left}px`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              void handleOpenSavedProject(projectMenuPath);
              setProjectMenuPath("");
            }}
          >
            Open folder
          </button>
          <button
            type="button"
            onClick={() => {
              void handleCopyWorkspacePath(projectMenuPath);
            }}
          >
            Copy path
          </button>
          <button
            type="button"
            className="danger-action"
            onClick={() => {
              void handleRemoveSavedProject(projectMenuPath);
              setProjectMenuPath("");
            }}
          >
            Remove from list
          </button>
        </div>
      )}

      {splashVisible && (
        <div className={bootDismissed ? "boot-overlay fading" : "boot-overlay"}>
          <div className="boot-container">
            <div className="boot-main">
              <div className="boot-glow"></div>
              
              <div className="boot-hex-wrap">
                <div className="boot-hex">
                  <div className="boot-hex-inner"></div>
                </div>
              </div>
              
              <div className="boot-content">
                <div className="boot-badge">{error ? "SYSTEM HALTED" : "BOOT PROTOCOL"}</div>
                <h1 className="boot-title">{bootHeadline}</h1>
                <p className="boot-subtitle">{bootMessage}</p>
              </div>

              <div className="boot-progress-wrap">
                <div className="boot-progress-track">
                  <div 
                    className="boot-progress-fill" 
                    style={{ width: snapshot ? "100%" : "72%" }}
                  ></div>
                </div>
                <div className="boot-progress-labels">
                  <span className="boot-status-text">{bootStatusText}</span>
                  <span className="boot-percent">{snapshot ? "Ready" : "Loading"}</span>
                </div>
              </div>
            </div>
            
            <div className="boot-footer">
              <div className="boot-footer-item">
                <span className="label">APP</span>
                <span className="value">Cortex</span>
              </div>
              <div className="boot-footer-item">
                <span className="label">WORKSPACE</span>
                <span className="value">{snapshot?.config?.repoRoot ? projectLabel(snapshot.config.repoRoot) : "PENDING"}</span>
              </div>
              <div className="boot-footer-item">
                <span className="label">VERSION</span>
                <span className="value">v{appVersion}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
