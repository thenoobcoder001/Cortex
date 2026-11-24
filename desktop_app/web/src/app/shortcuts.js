// App-wide keyboard shortcuts. Plain JS (no JSX) so the backend test runner
// can import it.

// `key` is compared with KeyboardEvent.key; `code` (when set) with
// KeyboardEvent.code, for keys whose `key` changes with the keyboard layout.
// `whileTyping`: also fires when focus is in a text field (the composer).
// `inTerminal`: also fires when focus is in the embedded terminal, where every
// other Ctrl combination belongs to the shell.
export const SHORTCUTS = {
  palette: { key: "k", label: "K", whileTyping: true },
  newChat: { key: "n", label: "N", whileTyping: true },
  toggleSidebar: { key: "b", label: "B" },
  toggleTerminal: { key: "`", code: "Backquote", label: "`", inTerminal: true },
  settings: { key: ",", code: "Comma", label: "," },
};

export function isMacPlatform(nav = typeof navigator !== "undefined" ? navigator : null) {
  const platform = String(nav?.userAgentData?.platform || nav?.platform || "");
  return /mac|iphone|ipad|ipod/i.test(platform);
}

// Returns the id of the shortcut the event triggers, or null. Requires
// Ctrl (Cmd on mac) and no Alt or Shift.
export function matchShortcut(event, isMac = false) {
  if (!event || event.altKey || event.shiftKey) return null;
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  const key = String(event.key || "").toLowerCase();
  for (const [id, shortcut] of Object.entries(SHORTCUTS)) {
    if (key === shortcut.key || (shortcut.code && event.code === shortcut.code)) return id;
  }
  return null;
}

// Whether a matched shortcut should run given where focus is.
export function shortcutAllowed(id, { typing = false, inTerminal = false } = {}) {
  const shortcut = SHORTCUTS[id];
  if (!shortcut) return false;
  if (inTerminal) return Boolean(shortcut.inTerminal);
  if (typing) return Boolean(shortcut.whileTyping);
  return true;
}

// Key caps for display, e.g. ["Ctrl", "K"] or ["⌘", "K"].
export function shortcutKeys(id, isMac = false) {
  const shortcut = SHORTCUTS[id];
  if (!shortcut) return [];
  return [isMac ? "⌘" : "Ctrl", shortcut.label];
}

export function shortcutText(id, isMac = false) {
  const keys = shortcutKeys(id, isMac);
  return keys.length ? keys.join(isMac ? "" : "+") : "";
}

// True for elements that take typed text. Duck-typed so it can be tested
// without a DOM.
export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = String(target.type || "text").toLowerCase();
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image"].includes(type);
}
