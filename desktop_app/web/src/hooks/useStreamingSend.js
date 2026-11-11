import { useEffect, useMemo, useRef, useState } from "react";
import { QUICK_COMMANDS } from "../app/constants.js";
import { readNdjsonStream } from "../app/utils.js";

// The chat composer's send flow: the draft, the optimistic "pending turn" per
// chat while /api/chat/send-stream streams NDJSON events back, quick terminal
// commands, live-terminal sends, and interrupting a running chat.
export default function useStreamingSend({
  backendUrl,
  snapshot,
  setSnapshot,
  setRepoDraft,
  setError,
  postJson,
  syncSavedProjects,
  fetchProjectChats,
  terminal,
}) {
  const { liveTermWriteRef, runInTerminal, terminalPanelOpen, terminalViewMode } = terminal;
  const activeChatIdRef = useRef("");
  const snapshotRef = useRef(null);
  const backendUrlRef = useRef("");
  const [draft, setDraft] = useState("");
  const [pendingTurns, setPendingTurns] = useState({});
  const [sendingChatIds, setSendingChatIds] = useState([]);

  useEffect(() => {
    activeChatIdRef.current = snapshot?.config?.activeChatId || "";
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    backendUrlRef.current = backendUrl;
  }, [backendUrl]);

  const activePendingTurn = useMemo(() => {
    const activeChatId = snapshot?.config?.activeChatId || "";
    return pendingTurns[activeChatId] || null;
  }, [pendingTurns, snapshot?.config?.activeChatId]);

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

  return {
    activePendingTurn,
    draft,
    handleInterruptChat,
    handleSend,
    pendingTurns,
    sendingChatIds,
    setDraft,
    setPendingTurns,
    setSendingChatIds,
  };
}
