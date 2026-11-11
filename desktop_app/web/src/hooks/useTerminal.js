import { useEffect, useRef, useState } from "react";
import { providerCliLaunchCommand } from "../app/utils.js";

// Per-chat terminal panel: open/close, polling its output, sending commands,
// and the "live" mode that runs the provider CLI inside xterm.
export default function useTerminal({ backendUrl, snapshot, postJson, setError }) {
  const terminalOutputRef = useRef(null);
  const liveTermWriteRef = useRef(null);
  const liveCliLaunchedRef = useRef(new Set());
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(false);
  const [terminalSnapshot, setTerminalSnapshot] = useState(null);
  const [terminalDraft, setTerminalDraft] = useState("");
  const [terminalViewMode, setTerminalViewMode] = useState("chat"); // "chat" | "live"

  const activeTerminalChatId = snapshot?.config?.activeChatId || "";

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

  return {
    activeTerminalChatId,
    handleCloseTerminal,
    handleSendTerminalCommand,
    handleSwitchToLive,
    handleToggleTerminal,
    liveTermWriteRef,
    refreshTerminal,
    runInTerminal,
    setTerminalDraft,
    setTerminalViewMode,
    terminalDraft,
    terminalOutputRef,
    terminalPanelOpen,
    terminalSnapshot,
    terminalViewMode,
  };
}
