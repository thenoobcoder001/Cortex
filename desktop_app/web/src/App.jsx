import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import SettingsPage from "./SettingsPage.jsx";
import XtermPanel from "./XtermPanel.jsx";

function stripAnsi(str) {
  return String(str || "")
    // CSI sequences: ESC [ + any non-final bytes (param/intermediate) + final byte (0x40-0x7E)
    // Covers standard SGR (\x1b[32m), DEC private (\x1b[?2026h), and all other CSI variants
    .replace(/\x1b\[[^\x40-\x7e]*[\x40-\x7e]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")  // OSC sequences
    .replace(/\x1b[^[\]]/g, "")               // other two-char escape sequences
    .replace(/\r\n/g, "\n")                    // normalize CRLF
    .replace(/\r/g, "");                       // remove bare CR (cursor-overwrite, meaningless in div)
}

function providerCliCommand(modelId) {
  if (!modelId) return "claude";
  if (modelId.startsWith("gemini-cli:")) return "gemini";
  if (modelId.startsWith("codex:")) return "codex";
  return "claude";
}

function providerCliLaunchCommand(snapshot) {
  const resumeCommand = String(snapshot?.liveTerminalCommand || "").trim();
  if (resumeCommand) {
    return resumeCommand;
  }
  return providerCliCommand(snapshot?.config?.model || "");
}

const QUICK_COMMANDS = [
  {
    // "list emulators", "list avds", "show emulators", etc.
    patterns: [
      /\b(list|show|what)\s+(emulators?|avds?)\b/i,
      /\bwhich\s+emulators?\b/i,
    ],
    type: "list-avds",
    buildCommand: () => null,
  },
  {
    // "open emulator", "start emulator tablet10_api35", "launch avd pixel7", etc.
    patterns: [
      /\b(open|start|launch)\s+(the\s+)?emulator\b/i,
      /\b(open|start|launch)\s+avd\b/i,
    ],
    buildCommand: (message) => {
      // Match AVD name after "emulator" or "avd" keyword, but not the trigger words themselves
      const avdMatch =
        message.match(/(?:emulator|avd)\s+((?!emulator|avd|the\b)[\w-]+)/i) ||
        message.match(/([\w-]+(?:_api\d+)?)\s+(?:emulator|avd)/i);
      const avd = avdMatch?.[1] || "";
      // Reject if what we captured is just a trigger word
      const triggerWords = new Set(["open", "start", "launch", "the", "emulator", "avd"]);
      const resolvedAvd = triggerWords.has(avd.toLowerCase()) ? "" : avd;
      return resolvedAvd
        ? `powershell -ExecutionPolicy Bypass -File E:\\codex\\start-emulator.ps1 -avd ${resolvedAvd}`
        : `powershell -ExecutionPolicy Bypass -File E:\\codex\\start-emulator.ps1`;
    },
  },
];

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

function MarkdownMessage({ content }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children, ...props }) => (
          <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        ),
      }}
    >
      {String(content || "")}
    </ReactMarkdown>
  );
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
  const terminalOutputRef = useRef(null);
  const activeChatIdRef = useRef("");
  const snapshotRef = useRef(null);
  const backendUrlRef = useRef("");
  const liveTermWriteRef = useRef(null);
  const liveCliLaunchedRef = useRef(new Set());
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
          {!error && activeInterruptedRun && (
            <div className="recovery-banner">
              Previous response was interrupted. Continue from the last saved turn.
            </div>
          )}
          {terminalPanelOpen && (
          <section className="terminal-panel">
            <div className="terminal-header">
              <div className="terminal-header-left">
                <div className="terminal-kicker">Terminal</div>
                <div className="terminal-title">
                  {terminalSnapshot?.status === "running" ? "Running" : "Ready"} · {projectLabel(snapshot.config.repoRoot)}
                </div>
              </div>
              <div className="terminal-actions">
                <div className="terminal-view-toggle">
                  <button
                    type="button"
                    className={terminalViewMode === "chat" ? "terminal-view-btn active" : "terminal-view-btn"}
                    onClick={() => setTerminalViewMode("chat")}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    className={terminalViewMode === "live" ? "terminal-view-btn active" : "terminal-view-btn"}
                    onClick={() => void handleSwitchToLive()}
                  >
                    Live
                  </button>
                </div>
                {terminalViewMode === "chat" && (
                  <button type="button" className="secondary-button" onClick={() => void refreshTerminal().catch((nextError) => setError(String(nextError)))}>
                    Refresh
                  </button>
                )}
                <button type="button" className="secondary-button" onClick={() => void handleCloseTerminal()}>
                  Close
                </button>
                <button
                  type="button"
                  className="terminal-expand-btn"
                  onClick={() => void handleToggleTerminal()}
                  title={terminalPanelOpen ? "Collapse terminal" : "Expand terminal"}
                >
                  {terminalPanelOpen ? "▲" : "▼"}
                </button>
              </div>
            </div>
            {/* Keep XtermPanel mounted whenever the panel is open so switching to Chat
                tab and back doesn't wipe content that was streamed directly into xterm. */}
            {terminalPanelOpen && activeTerminalChatId && (
              <div style={terminalViewMode !== "live" ? { position: "absolute", visibility: "hidden", pointerEvents: "none", width: "1px", height: "1px", overflow: "hidden" } : {}}>
                <XtermPanel
                  backendUrl={backendUrl}
                  chatId={activeTerminalChatId}
                  repoRoot={snapshot.config.repoRoot || ""}
                  onReady={(writeFn) => { liveTermWriteRef.current = writeFn; }}
                  onUnmount={() => { liveTermWriteRef.current = null; }}
                />
              </div>
            )}
            {terminalPanelOpen && terminalViewMode === "chat" && (
              <div className="terminal-output" ref={terminalOutputRef}>
                {terminalSnapshot?.history
                  ? stripAnsi(terminalSnapshot.history)
                  : <span className="terminal-placeholder-inline">Open this thread terminal, then run commands in the selected workspace.</span>
                }
              </div>
            )}
            {terminalViewMode === "chat" && (
              <div className="terminal-command-row">
                <input
                  value={terminalDraft}
                  onChange={(event) => setTerminalDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleSendTerminalCommand();
                    }
                  }}
                  placeholder="Run a command in the workspace..."
                />
                <button type="button" className="primary-button" onClick={() => void handleSendTerminalCommand()}>
                  Run
                </button>
              </div>
            )}
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
                      {message.role === "assistant" ? (
                        <MarkdownMessage content={message.content} />
                      ) : (
                        <pre>{String(message.content || "")}</pre>
                      )}
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

          <div
            className="composer-panel"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <textarea
              value={draft}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={terminalViewMode === "live" && terminalPanelOpen ? `Talking to ${providerCliCommand(snapshot?.config?.model || "")} — type anything...` : "Ask for changes, inspect the repo, or debug a file..."}
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
                disabled={terminalViewMode === "chat" && Boolean(snapshot.config.activeChatId) && sendingChatIds.includes(snapshot.config.activeChatId)}
              >
                {terminalViewMode === "live" && terminalPanelOpen ? "Run" : "Send"}
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
