import React, { useEffect, useMemo, useState } from "react";

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

function relativePath(filePath, repoRoot) {
  if (!filePath || !repoRoot) {
    return filePath;
  }
  const prefix = `${repoRoot}\\`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

function buildExplorerEntries(files, repoRoot) {
  const nodeMap = new Map();
  nodeMap.set("", {
    id: "",
    name: "",
    type: "folder",
    depth: -1,
    children: new Set(),
  });

  for (const absolutePath of files) {
    const relative = relativePath(absolutePath, repoRoot).replaceAll("/", "\\");
    const parts = relative.split("\\").filter(Boolean);
    let currentPath = "";

    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      const nextPath = currentPath ? `${currentPath}\\${part}` : part;
      if (!nodeMap.has(nextPath)) {
        nodeMap.set(nextPath, {
          id: nextPath,
          name: part,
          type: isFile ? "file" : "folder",
          absolutePath: isFile ? absolutePath : undefined,
          depth: index,
          children: new Set(),
        });
      }
      nodeMap.get(currentPath)?.children.add(nextPath);
      currentPath = nextPath;
    });
  }

  const entries = [];
  const walk = (nodeId) => {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const children = [...node.children]
      .map((childId) => nodeMap.get(childId))
      .filter(Boolean)
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === "folder" ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

    for (const child of children) {
      entries.push(child);
      if (child.type === "folder") {
        walk(child.id);
      }
    }
  };

  walk("");
  return entries;
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
  const [backendUrl, setBackendUrl] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [repoDraft, setRepoDraft] = useState("");
  const [liveStatus, setLiveStatus] = useState("Idle");
  const [pendingTurn, setPendingTurn] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savedProjects, setSavedProjects] = useState(() => loadSavedProjects());
  const [projectMenuPath, setProjectMenuPath] = useState("");

  const modelGroups = useMemo(() => groupedModels(snapshot?.models || []), [snapshot]);
  const activeChat = useMemo(
    () => snapshot?.chats?.find((chat) => chat.chatId === snapshot?.config?.activeChatId) || null,
    [snapshot],
  );
  const explorerEntries = useMemo(
    () => buildExplorerEntries(snapshot?.files || [], snapshot?.config?.repoRoot || ""),
    [snapshot],
  );
  const displayMessages = useMemo(() => {
    const visible = (snapshot?.messages || [])
      .filter((message) => ["user", "assistant", "system"].includes(message.role))
      .filter((message) => String(message.content || "").trim().length > 0)
      .map((message) => ({
        ...message,
        content:
          message.role === "user"
            ? stripPresetPrefix(String(message.content || ""))
            : String(message.content || "").trim(),
      }));

    if (pendingTurn?.userMessage) {
      visible.push({ role: "user", content: pendingTurn.userMessage, pending: true });
    }
    if (pendingTurn?.assistantText) {
      visible.push({ role: "assistant", content: pendingTurn.assistantText, pending: true });
    }
    return visible;
  }, [pendingTurn, snapshot]);

  const syncSavedProjects = (repoRoot) => {
    setSavedProjects((current) => {
      const nextProjects = upsertProject(current, repoRoot);
      saveSavedProjects(nextProjects);
      return nextProjects;
    });
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
      })
      .catch((nextError) => {
        if (!alive) return;
        setError(String(nextError));
      });
    return () => {
      alive = false;
    };
  }, []);

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
    setBusy(true);
    setError("");
    try {
      const nextSnapshot = await postJson("/api/config", patch);
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
      syncSavedProjects(nextSnapshot.config.repoRoot);
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const handleSend = async () => {
    if (!draft.trim() || busy) return;

    const outgoingMessage = draft.trim();
    setBusy(true);
    setError("");
    setLiveStatus("Starting request...");
    setPendingTurn({ userMessage: outgoingMessage, assistantText: "" });

    try {
      const response = await fetch(`${backendUrl}/api/chat/send-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: outgoingMessage }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.detail || `Request failed (${response.status})`);
      }

      await readNdjsonStream(response, (event) => {
        switch (event.type) {
          case "user_message":
            setPendingTurn((current) => ({
              userMessage: event.message,
              assistantText: current?.assistantText || "",
            }));
            break;
          case "status":
            setLiveStatus(event.message || event.phase || "Working...");
            break;
          case "assistant":
            setPendingTurn((current) => ({
              userMessage: current?.userMessage || outgoingMessage,
              assistantText: event.text || "",
            }));
            break;
          case "completed":
            setSnapshot(event.snapshot);
            setRepoDraft(event.snapshot.config.repoRoot);
            syncSavedProjects(event.snapshot.config.repoRoot);
            setPendingTurn(null);
            setLiveStatus(`Done in ${event.elapsedSeconds}s`);
            break;
          case "error":
            setError(event.message || "Stream failed.");
            setLiveStatus("Request failed");
            break;
          default:
            break;
        }
      });

      setDraft("");
    } catch (nextError) {
      setError(String(nextError));
      setLiveStatus("Request failed");
    } finally {
      setPendingTurn((current) => {
        if (!current) return current;
        return current.assistantText ? current : null;
      });
      setBusy(false);
    }
  };

  const handleNewChat = async () => {
    setBusy(true);
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/new", {});
      setSnapshot(nextSnapshot);
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const handleActivateChat = async (chatId) => {
    setBusy(true);
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/activate", { chatId });
      setSnapshot(nextSnapshot);
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setBusy(false);
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

  if (!snapshot) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <span className="boot-mark">GPT TUI</span>
          <h1>Loading desktop workspace</h1>
          <p>{error || "Starting local backend and preparing the renderer..."}</p>
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
                <div
                  key={project.path}
                  className={
                    project.path === snapshot.config.repoRoot ? "project-item active" : "project-item"
                  }
                >
                  <button
                    type="button"
                    className="project-main"
                    onClick={() => handleOpenSavedProject(project.path)}
                    title={project.path}
                  >
                    <span className="project-name">{project.name}</span>
                    <span className="project-path">{project.path}</span>
                  </button>
                  <div className="project-menu-wrap" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      className="project-menu-trigger"
                      onClick={() =>
                        setProjectMenuPath((current) => (current === project.path ? "" : project.path))
                      }
                    >
                      ...
                    </button>
                    {projectMenuPath === project.path && (
                      <div className="project-menu">
                        <button type="button" onClick={() => handleOpenSavedProject(project.path)}>
                          Open
                        </button>
                        <button type="button" className="danger-action" onClick={() => handleRemoveSavedProject(project.path)}>
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="sidebar-section fill">
            <div className="sidebar-label">Folders</div>
            <div className="explorer-list">
              {explorerEntries.length === 0 && (
                <div className="rail-empty">No files available for this project.</div>
              )}
              {explorerEntries.map((entry) =>
                entry.type === "folder" ? (
                  <div
                    key={entry.id}
                    className="explorer-folder"
                    style={{ paddingLeft: `${12 + entry.depth * 14}px` }}
                  >
                    {entry.name}
                  </div>
                ) : (
                  <div
                    key={entry.id}
                    className="explorer-file"
                    style={{ paddingLeft: `${12 + entry.depth * 14}px` }}
                    title={relativePath(entry.absolutePath, snapshot.config.repoRoot)}
                  >
                    {entry.name}
                  </div>
                ),
              )}
            </div>
          </div>
        </aside>

        <main className="chat-area">
          <header className="chat-topbar">
            <div>
              <div className="chat-title">{activeChat?.title || "New thread"}</div>
              <div className="chat-subtitle">
                {projectLabel(snapshot.config.repoRoot)} · {liveStatus}
              </div>
            </div>

            <div className="topbar-actions">
              <select
                className="header-select"
                value={snapshot.config.activeChatId || ""}
                onChange={(event) => {
                  if (event.target.value) {
                    void handleActivateChat(event.target.value);
                  }
                }}
              >
                <option value="">Current thread</option>
                {snapshot.chats.map((chat) => (
                  <option key={chat.chatId} value={chat.chatId}>
                    {chat.title}
                  </option>
                ))}
              </select>
              <button type="button" className="secondary-button" onClick={handleNewChat}>
                New chat
              </button>
              <button type="button" className="secondary-button" onClick={() => setSettingsOpen(true)}>
                Settings
              </button>
            </div>
          </header>

          {error && <div className="error-banner">{error}</div>}

          <section className="conversation-scroll">
            {displayMessages.length === 0 ? (
              <div className="conversation-empty">
                <h2>Start a conversation</h2>
                <p>Ask about the current repo, request changes, or inspect the codebase.</p>
              </div>
            ) : (
              displayMessages.map((message, index) => (
                <article
                  key={`${message.role}-${index}`}
                  className={`message-card ${message.role}${message.pending ? " pending" : ""}`}
                >
                  <div className="message-role">{message.role}</div>
                  <pre>{String(message.content || "")}</pre>
                </article>
              ))
            )}
          </section>

          <div className="composer-panel">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
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
              <button type="button" className="primary-button" onClick={handleSend} disabled={busy}>
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
    </>
  );
}
