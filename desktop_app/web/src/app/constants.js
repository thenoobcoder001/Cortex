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
  { id: "vscode", label: "VS Code" },
  { id: "antigravity", label: "Antigravity" },
  { id: "cursor", label: "Cursor" },
];

export const FALLBACK_APP_VERSION = "0.0.2";
export const THEME_MODE_STORAGE_KEY = "gpt-tui.theme-mode";
export const SAVED_PROJECTS_KEY = "gpt-tui.saved-projects";
