import React, { useEffect, useMemo, useRef, useState } from "react";

const PROMPT_PRESETS = [
  { value: "code", label: "Code" },
  { value: "debug", label: "Debug" },
  { value: "refactor", label: "Refactor" },
  { value: "explain", label: "Explain" },
];

const TOOL_SAFETY_OPTIONS = [
  { value: "write", label: "Write-enabled" },
  { value: "read", label: "Read-only" },
];

const SAVED_PROJECTS_KEY = "gpt-tui.saved-projects";

function groupedModels(models) {
  const grouped = new Map();
  for (const model of models) {
    const items = grouped.get(model.group) || [];
    items.push(model);
    grouped.set(model.group, items);
  }
  return [...grouped.entries()];
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

async function readDesktopConfig() {
  if (window.desktopApi?.getConfig) {
    return window.desktopApi.getConfig();
  }
  return { backendUrl: import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8765" };
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savedProjects, setSavedProjects] = useState(() => loadSavedProjects());
  const [projectMenuPath, setProjectMenuPath] = useState("");
  const [projectMenuPos, setProjectMenuPos] = useState({ top: 0, left: 0 });
  const [bootPhase, setBootPhase] = useState(0);
  const [bootMinElapsed, setBootMinElapsed] = useState(false);
  const [bootDismissed, setBootDismissed] = useState(false);

  const runningChatIds = snapshot?.runningChatIds || [];
  const activeRepoRoot = normalizeProject(snapshot?.config?.repoRoot || "");
  const bootSteps = [
    "Prime the local runtime",
    "Attach provider bridges",
    "Index project memory",
    "Open the operator console",
  ];
  const splashVisible = !bootDismissed || !snapshot;
  const completedBootSteps = snapshot
    ? bootSteps.length
    : Math.min(bootSteps.length - 1, Math.max(1, bootPhase + 1));
  const bootHeadline = error
    ? "Startup interrupted"
    : snapshot && bootMinElapsed
      ? "Workspace synchronized"
      : "Activating your local AI workstation";
  const bootMessage = error
    ? error
    : snapshot && bootMinElapsed
      ? "Session state restored. Opening the workspace shell."
      : "Bringing up the local backend, rehydrating project state, and staging the desktop shell.";

  useEffect(() => {
    activeChatIdRef.current = snapshot?.config?.activeChatId || "";
  }, [snapshot?.config?.activeChatId]);

  useEffect(() => {
    const stepTimer = window.setInterval(() => {
      setBootPhase((current) => Math.min(current + 1, bootSteps.length - 1));
    }, 480);
    const minTimer = window.setTimeout(() => {
      setBootMinElapsed(true);
    }, 2200);
    return () => {
      window.clearInterval(stepTimer);
      window.clearTimeout(minTimer);
    };
  }, []);

  useEffect(() => {
    if (!snapshot || !bootMinElapsed || error) {
      return;
    }
    const remaining = Math.max(0, 2600 - (Date.now() - bootStartedAtRef.current));
    const dismissTimer = window.setTimeout(() => {
      setBootDismissed(true);
    }, remaining);
    return () => {
      window.clearTimeout(dismissTimer);
    };
  }, [bootMinElapsed, error, snapshot]);

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
    const rect = event.currentTarget.getBoundingClientRect();
    if (projectMenuPath === path) {
      setProjectMenuPath("");
    } else {
      setProjectMenuPath(path);
      setProjectMenuPos({ top: rect.bottom + 8, left: rect.left - 130 });
    }
  };

  const modelGroups = useMemo(() => groupedModels(snapshot?.models || []), [snapshot]);
  const activeChat = useMemo(
    () => snapshot?.chats?.find((chat) => chat.chatId === snapshot?.config?.activeChatId) || null,
    [snapshot],
  );

  const activePendingTurn = useMemo(() => {
    const activeChatId = snapshot?.config?.activeChatId || "";
    return pendingTurns[activeChatId] || null;
  }, [pendingTurns, snapshot?.config?.activeChatId]);

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
        setBackendUrl(config.backendUrl);
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
      if (repoRoot === activeRepoRoot || projectChats[repoRoot]) {
        return;
      }
      void fetchProjectChats(repoRoot).catch(() => {});
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
    } catch (nextError) {
      setError(String(nextError));
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
      [requestKey]: { chatId: requestKey, userMessage: outgoingMessage, assistantText: "" },
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
          case "assistant":
            setPendingTurns((current) => ({
              ...current,
              [eventChatId]: {
                chatId: eventChatId,
                userMessage: current[eventChatId]?.userMessage || outgoingMessage,
                assistantText: event.text || "",
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
                  style={{ width: `${(completedBootSteps / bootSteps.length) * 100}%` }}
                ></div>
              </div>
              <div className="boot-progress-labels">
                <span className="boot-status-text">
                  {error ? "Error" : bootSteps[completedBootSteps - 1] || "Initializing..."}
                </span>
                <span className="boot-percent">
                  {Math.round((completedBootSteps / bootSteps.length) * 100)}%
                </span>
              </div>
            </div>
          </div>
          
          <div className="boot-footer">
            <div className="boot-footer-item">
              <span className="label">RUNTIME</span>
              <span className="value">v1.2.4-STABLE</span>
            </div>
            <div className="boot-footer-item">
              <span className="label">ENVIRONMENT</span>
              <span className="value">WDMX_CORE</span>
            </div>
            <div className="boot-footer-item">
              <span className="label">VERSION</span>
              <span className="value">0.9.2-BETA</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="workspace-shell" onClick={() => setProjectMenuPath("")}>
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
                        <span className={expandedRepos.has(project.path) ? "chevron-icon expanded" : "chevron-icon"}>›</span>{" "}
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
                    <div className="project-chat-list">
                      {chatsForProject(project.path).length === 0 && <div className="rail-empty">No chats yet.</div>}
                      {chatsForProject(project.path).map((chat) => {
                        const showChatLoading =
                          runningChatIds.includes(chat.chatId) || sendingChatIds.includes(chat.chatId);

                        return (
                          <div
                            key={`${normalizeProject(project.path)}:${chat.chatId}`}
                            className={
                              chat.chatId === snapshot.config.activeChatId &&
                              normalizeProject(project.path) === activeRepoRoot
                                ? "chat-sidebar-row active"
                                : "chat-sidebar-row"
                            }
                            onClick={() => handleActivateChat(chat.chatId, project.path)}
                          >
                            <button type="button" className="chat-sidebar-item" title={chat.title}>
                              <span className="chat-dot"></span>
                              <span className="chat-truncate">{chat.title || "Untitled chat"}</span>
                            </button>
                            {showChatLoading && <span className="chat-loading-spinner" aria-hidden="true"></span>}
                            <button
                              type="button"
                              className="chat-delete-btn"
                              onClick={(event) => handleDeleteChat(event, chat.chatId, project.path)}
                              title="Delete chat"
                            >
                              ×
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
            </div>

            <div className="topbar-right">
              <button type="button" className="secondary-button" onClick={handleNewChat}>
                New chat
              </button>
              <button type="button" className="secondary-button" onClick={() => setSettingsOpen(true)}>
                Settings
              </button>
            </div>
          </header>

          {error && <div className="error-banner">{error}</div>}

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
                    <div className="message-content">
                      <pre>{String(message.content || "")}</pre>
                    </div>
                  </div>
                </div>
              ))
            )}
            {activePendingTurn && (
              <div className="message-row assistant">
                <div className="thinking-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}
          </section>

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
                  value={snapshot.config.model}
                  onChange={(event) => handleConfigUpdate({ model: event.target.value })}
                >
                  {modelGroups.map(([group, items]) => (
                    <optgroup key={group} label={group}>
                      {items.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <select
                  value={snapshot.config.promptPreset}
                  onChange={(event) => handleConfigUpdate({ promptPreset: event.target.value })}
                >
                  {PROMPT_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <select
                  value={snapshot.config.toolSafetyMode}
                  onChange={(event) => handleConfigUpdate({ toolSafetyMode: event.target.value })}
                >
                  {TOOL_SAFETY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
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

      {settingsOpen && (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="settings-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <div>
                <div className="settings-title">Settings</div>
                <div className="settings-subtitle">Workspace and runtime configuration</div>
              </div>
              <button type="button" className="secondary-button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>

            <div className="settings-grid">
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
                <span>Prompt preset</span>
                <select
                  value={snapshot.config.promptPreset}
                  onChange={(event) => handleConfigUpdate({ promptPreset: event.target.value })}
                >
                  {PROMPT_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Tool safety</span>
                <select
                  value={snapshot.config.toolSafetyMode}
                  onChange={(event) => handleConfigUpdate({ toolSafetyMode: event.target.value })}
                >
                  {TOOL_SAFETY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="settings-block">
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
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="settings-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => handleConfigUpdate({ repoRoot: repoDraft })}
              >
                Save workspace
              </button>
            </div>
          </div>
        </div>
      )}

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
                    style={{ width: `${(completedBootSteps / bootSteps.length) * 100}%` }}
                  ></div>
                </div>
                <div className="boot-progress-labels">
                  <span className="boot-status-text">
                    {error ? "Error" : bootSteps[completedBootSteps - 1] || "Finalizing..."}
                  </span>
                  <span className="boot-percent">
                    {Math.round((completedBootSteps / bootSteps.length) * 100)}%
                  </span>
                </div>
              </div>
            </div>
            
            <div className="boot-footer">
              <div className="boot-footer-item">
                <span className="label">RUNTIME</span>
                <span className="value">v1.2.4-STABLE</span>
              </div>
              <div className="boot-footer-item">
                <span className="label">WORKSPACE</span>
                <span className="value">{snapshot?.config?.repoRoot ? projectLabel(snapshot.config.repoRoot) : "PENDING"}</span>
              </div>
              <div className="boot-footer-item">
                <span className="label">ACCESS</span>
                <span className="value">W-CLASS</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
