import { useEffect, useRef } from "react";
import { isMacPlatform, isTypingTarget, matchShortcut, shortcutAllowed } from "../app/shortcuts.js";

// Global shortcuts (see app/shortcuts.js). `handlers` maps shortcut ids to
// callbacks, plus `escape` for Esc. Listens in the capture phase so the
// embedded terminal can't swallow Ctrl+` before it gets here; anything not
// handled is left alone.
export default function useKeyboardShortcuts(handlers, { enabled = true } = {}) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const isMac = isMacPlatform();
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.isComposing) return;
      const current = handlersRef.current || {};
      const target = event.target;
      const inTerminal = Boolean(target?.closest?.(".xterm"));

      if (event.key === "Escape") {
        // Not prevented: the composer, dialogs and the terminal still see Esc.
        if (!inTerminal) current.escape?.(event);
        return;
      }

      const id = matchShortcut(event, isMac);
      if (!id || !current[id]) return;
      if (!shortcutAllowed(id, { typing: isTypingTarget(target), inTerminal })) return;
      event.preventDefault();
      event.stopPropagation();
      current[id](event);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
