import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminalSync } from "./app/terminalSync.js";

export default function XtermPanel({ backendUrl, chatId, repoRoot, onReady, onUnmount }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const esRef = useRef(null);
  // Latest callbacks, read from the effect without re-running it.
  const onReadyRef = useRef(onReady);
  const onUnmountRef = useRef(onUnmount);
  onReadyRef.current = onReady;
  onUnmountRef.current = onUnmount;

  useEffect(() => {
    if (!containerRef.current || !backendUrl || !chatId) return;

    const readTerminalTheme = () => {
      const styles = getComputedStyle(document.documentElement);
      const css = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
      return {
        background: css("--terminal-bg", "#091016"),
        foreground: css("--terminal-fg", "#d8f3e6"),
        cursor: css("--terminal-cursor", "#76d7a7"),
        selectionBackground: css("--terminal-selection", "rgba(112,214,255,0.24)"),
        black: css("--bg-soft", "#101820"),
        red: css("--danger", "#ef7d7d"),
        green: css("--success", "#76d7a7"),
        yellow: css("--accent-warm", "#f2c36c"),
        blue: css("--accent", "#70d6ff"),
        magenta: "#b68cff",
        cyan: "#64e0d2",
        white: css("--text-muted", "#98a8b7"),
        brightBlack: css("--text-faint", "#647889"),
        brightRed: "#ff9a9a",
        brightGreen: "#9bf0c2",
        brightYellow: "#ffd98a",
        brightBlue: "#9be4ff",
        brightMagenta: "#d3b7ff",
        brightCyan: "#9cf3ea",
        brightWhite: css("--text", "#e6edf3"),
      };
    };

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "\"SFMono-Regular\", \"Cascadia Mono\", \"Cascadia Code\", Consolas, \"Liberation Mono\", monospace",
      theme: readTerminalTheme(),
      scrollback: 5000,
      allowTransparency: true,
      convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;

    // Size the terminal to its box before anything is written. Output drawn
    // at xterm's default 80x24 and refit later runs lines together.
    // The backend is never sized below 40x12, so the xterm isn't either:
    // both sides must agree or ConPTY's cursor moves land on the wrong cells.
    let viewSize = null;
    const fitNow = () => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
          return false;
        }
        viewSize = { cols: Math.max(dims.cols, 40), rows: Math.max(dims.rows, 12) };
        if (term.cols !== viewSize.cols || term.rows !== viewSize.rows) {
          term.resize(viewSize.cols, viewSize.rows);
        }
        return true;
      } catch {
        return false; // no dimensions yet
      }
    };
    fitNow();

    let lastSentSize = "";
    const postSize = () => {
      if (!viewSize) return Promise.resolve();
      const key = `${viewSize.cols}x${viewSize.rows}`;
      if (key === lastSentSize) return Promise.resolve();
      lastSentSize = key;
      return fetch(`${backendUrl}/api/terminal/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, ...viewSize }),
      }).catch(() => {});
    };

    let disposed = false;
    const sync = createTerminalSync(term, {
      getViewSize: () => viewSize,
      onGap: () => void syncSnapshot(),
    });

    // One fetch at a time; a request made meanwhile runs once it finishes so
    // a gap in the stream is always followed by a fresh snapshot.
    let syncing = false;
    let syncAgain = false;
    const syncSnapshot = async () => {
      if (syncing) {
        syncAgain = true;
        return;
      }
      syncing = true;
      try {
        do {
          syncAgain = false;
          const response = await fetch(`${backendUrl}/api/terminal?chatId=${encodeURIComponent(chatId)}`);
          const data = await response.json();
          if (response.ok && !disposed) {
            sync.applySnapshot(data);
          }
        } while (syncAgain && !disposed);
      } catch {
        // Polling is a best-effort fallback when SSE is flaky.
      } finally {
        syncing = false;
      }
    };

    // Expose write function to parent
    if (onReadyRef.current) onReadyRef.current((data) => sync.run(() => term.write(data)));

    const es = new EventSource(`${backendUrl}/api/terminal/stream?chatId=${encodeURIComponent(chatId)}`);
    esRef.current = es;
    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "history") {
          sync.applySnapshot(msg);
        } else if (msg.type === "data") {
          sync.applyData(msg);
        }
      } catch {
        // ignore malformed SSE payloads
      }
    };

    window.requestAnimationFrame(() => {
      if (disposed) return;
      void sync.run(() => {
        fitNow();
      }).then(async () => {
        await fetch(`${backendUrl}/api/terminal/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId, repoRoot, ...(viewSize || { cols: 120, rows: 30 }) }),
        }).catch(() => {});
        await postSize();
        await syncSnapshot();
      });
    });

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
      // Queued so a refit never lands in the middle of a replay.
      void sync.run(() => {
        fitNow();
      }).then(postSize);
    });
    resizeObserver.observe(containerRef.current);

    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      disposed = true;
      sync.dispose();
      window.clearInterval(pollTimer);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      es.close();
      term.dispose();
      if (onUnmountRef.current) onUnmountRef.current();
      esRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
  }, [backendUrl, chatId, repoRoot]);

  return <div ref={containerRef} className="xterm-container" />;
}
