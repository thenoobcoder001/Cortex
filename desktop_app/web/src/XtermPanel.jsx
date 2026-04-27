import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export default function XtermPanel({ backendUrl, chatId, repoRoot, onReady, onUnmount }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const esRef = useRef(null);
  const historyRef = useRef("");

  useEffect(() => {
    if (!containerRef.current || !backendUrl || !chatId) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "\"IBM Plex Mono\", \"Cascadia Code\", Consolas, monospace",
      theme: {
        background: "#0d0d0d",
        foreground: "#c8f2d6",
        cursor: "#7ed2a2",
        selectionBackground: "rgba(126,210,162,0.25)",
        black: "#1a1a1a",
        red: "#e06c75",
        green: "#7ed2a2",
        yellow: "#e5c07b",
        blue: "#61afef",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#abb2bf",
        brightBlack: "#5c6370",
        brightRed: "#e06c75",
        brightGreen: "#98c379",
        brightYellow: "#e5c07b",
        brightBlue: "#61afef",
        brightMagenta: "#c678dd",
        brightCyan: "#56b6c2",
        brightWhite: "#ffffff",
      },
      scrollback: 5000,
      allowTransparency: true,
      convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;
    historyRef.current = "";

    // Expose write function to parent
    if (onReady) onReady((data) => term.write(data));

    const applyHistory = (nextHistory) => {
      const normalized = String(nextHistory || "");
      if (!normalized || normalized === historyRef.current) {
        return;
      }
      if (normalized.startsWith(historyRef.current)) {
        term.write(normalized.slice(historyRef.current.length));
      } else {
        term.reset();
        term.write(normalized);
      }
      historyRef.current = normalized;
    };

    const syncSnapshot = async () => {
      try {
        const response = await fetch(`${backendUrl}/api/terminal?chatId=${encodeURIComponent(chatId)}`);
        const data = await response.json();
        if (!response.ok) {
          return;
        }
        applyHistory(data.history || "");
      } catch {
        // Polling is a best-effort fallback when SSE is flaky.
      }
    };

    const syncSize = async () => {
      try {
        fit.fit();
      } catch {
        // ignore fit failures until the container has dimensions
      }
      const cols = Math.max(Number(term.cols) || 0, 40);
      const rows = Math.max(Number(term.rows) || 0, 12);
      await fetch(`${backendUrl}/api/terminal/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, repoRoot, cols, rows }),
      }).catch(() => {});
      await fetch(`${backendUrl}/api/terminal/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, cols, rows }),
      }).catch(() => {});
    };

    window.requestAnimationFrame(() => {
      void syncSize().then(() => syncSnapshot());
    });

    const es = new EventSource(`${backendUrl}/api/terminal/stream?chatId=${encodeURIComponent(chatId)}`);
    esRef.current = es;
    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "history") {
          applyHistory(msg.data);
        } else if (msg.type === "data") {
          const chunk = String(msg.data || "");
          if (!chunk) {
            return;
          }
          term.write(chunk);
          historyRef.current += chunk;
        }
      } catch {
        // ignore malformed SSE payloads
      }
    };

    const pollTimer = window.setInterval(() => {
      void syncSnapshot();
    }, 1200);

    term.onData((data) => {
      fetch(`${backendUrl}/api/terminal/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, data, repoRoot }),
      }).catch(() => {});
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        const cols = Math.max(Number(term.cols) || 0, 40);
        const rows = Math.max(Number(term.rows) || 0, 12);
        fetch(`${backendUrl}/api/terminal/resize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId, cols, rows }),
        }).catch(() => {});
      } catch {
        // ignore resize failures
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      window.clearInterval(pollTimer);
      resizeObserver.disconnect();
      es.close();
      term.dispose();
      if (onUnmount) onUnmount();
      esRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      historyRef.current = "";
    };
  }, [backendUrl, chatId, repoRoot]);

  return <div ref={containerRef} className="xterm-container" />;
}
