export const QUICK_COMMANDS = [
  {
    patterns: [
      /\b(list|show|what)\s+(emulators?|avds?)\b/i,
      /\bwhich\s+emulators?\b/i,
    ],
    type: "list-avds",
    buildCommand: () => null,
  },
  {
    patterns: [
      /\b(open|start|launch)\s+(the\s+)?emulator\b/i,
      /\b(open|start|launch)\s+avd\b/i,
    ],
    type: "launch-emulator",
    buildCommand: (message) => {
      const avdMatch =
        message.match(/(?:emulator|avd)\s+((?!emulator|avd|the\b)[\w-]+)/i) ||
        message.match(/([\w-]+(?:_api\d+)?)\s+(?:emulator|avd)/i);
      const avd = avdMatch?.[1] || "";
      const triggerWords = new Set(["open", "start", "launch", "the", "emulator", "avd"]);
      const resolvedAvd = triggerWords.has(avd.toLowerCase()) ? "" : avd;
      return { avd: resolvedAvd };
    },
  },
];

export const PROMPT_PRESETS = [
  { value: "chat", label: "Chat" },
  { value: "code", label: "Code" },
  { value: "plan", label: "Plan" },
  { value: "debug", label: "Debug" },
  { value: "refactor", label: "Refactor" },
  { value: "explain", label: "Explain" },
];

export const TOOL_SAFETY_OPTIONS = [
  { value: "write", label: "Write-enabled" },
  { value: "read", label: "Read-only" },
];

export const EXTERNAL_EDITOR_OPTIONS = [
  { id: "vscode",       label: "VS Code" },
  { id: "visualstudio", label: "Visual Studio" },
  { id: "cursor",       label: "Cursor" },
  { id: "antigravity",  label: "Antigravity" },
  { id: "fileexplorer", label: "File Explorer" },
  { id: "terminal",     label: "Terminal" },
];

export const FALLBACK_APP_VERSION = "0.0.9";
export const THEME_MODE_STORAGE_KEY = "cortex.theme-mode";
export const SAVED_PROJECTS_KEY = "cortex.saved-projects";
export const RESOURCE_DASHBOARD_STORAGE_KEY = "cortex.show-resource-dashboard";
export const UI_PREFS_STORAGE_KEY = "cortex.ui-prefs";

// Keys used before the rename from "gpt-tui" to "cortex", mapped to their new
// names. migrateLegacyStorageKeys() moves them over once on startup.
export const LEGACY_STORAGE_KEYS = {
  "gpt-tui.theme-mode": THEME_MODE_STORAGE_KEY,
  "gpt-tui.saved-projects": SAVED_PROJECTS_KEY,
  "gpt-tui.show-resource-dashboard": RESOURCE_DASHBOARD_STORAGE_KEY,
  "gpt-tui.ui-prefs": UI_PREFS_STORAGE_KEY,
};

export const DEFAULT_UI_PREFS = {
  codeWrap: false,
  enterToSend: true,
  confirmChatDelete: true,
};
