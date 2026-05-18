import { SAVED_PROJECTS_KEY, THEME_MODE_STORAGE_KEY } from "./constants.js";

function prefersWindowsPaths() {
  if (typeof navigator === "undefined") {
    return false;
  }
  return navigator.userAgent.includes("Windows");
}

export function stripAnsi(str) {
  return String(str || "")
    .replace(/\x1b\[[^\x40-\x7e]*[\x40-\x7e]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}

export function providerCliCommand(modelId) {
  if (!modelId) return "claude";
  if (modelId.startsWith("gemini-cli:")) return "gemini";
  if (modelId.startsWith("codex:")) return "codex";
  return "claude";
}

export function providerCliLaunchCommand(snapshot) {
  const resumeCommand = String(snapshot?.liveTerminalCommand || "").trim();
  if (resumeCommand) {
    return resumeCommand;
  }
  return providerCliCommand(snapshot?.config?.model || "");
}

export function loadThemeMode() {
  try {
    const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // ignore
  }
  return "dark";
}

export function saveThemeMode(mode) {
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

export function groupedModels(models) {
  const grouped = new Map();
  for (const model of models) {
    const items = grouped.get(model.group) || [];
    items.push(model);
    grouped.set(model.group, items);
  }
  return [...grouped.entries()];
}

export function parentModelLabel(modelId, modelGroups) {
  for (const [group, items] of modelGroups) {
    if (items.some((model) => model.id === modelId)) {
      return group;
    }
  }
  return "Model";
}

export function providerStateForGroup(group, providers) {
  if (group === "Claude") {
    return providers?.claude || { available: false, connected: false };
  }
  if (group === "Gemini") {
    return providers?.gemini || { available: false, connected: false };
  }
  if (group === "Gemini CLI") {
    return providers?.geminiCli || { available: false, connected: false };
  }
  if (group === "Codex") {
    return providers?.codex || { available: false, connected: false };
  }
  if (group === "Groq") {
    return providers?.groq || { available: false, connected: false };
  }
  return { available: false, connected: false };
}

export function stripPresetPrefix(text) {
  return text.replace(/^\[Mode:[^\]]+\][^\n]*\n\n/, "").trim();
}

export function cleanResponse(text) {
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

export function projectLabel(repoRoot) {
  if (!repoRoot) {
    return "Workspace";
  }
  return repoRoot.split(/[/\\]/).filter(Boolean).at(-1) || repoRoot;
}

export function normalizeProject(repoRoot) {
  const trimmed = String(repoRoot || "").trim();
  if (!trimmed) {
    return "";
  }
  if (prefersWindowsPaths()) {
    return trimmed.replaceAll("/", "\\");
  }
  return trimmed.replaceAll("\\", "/");
}

export function loadSavedProjects() {
  try {
    const stored = window.localStorage.getItem(SAVED_PROJECTS_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
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

export function saveSavedProjects(projects) {
  window.localStorage.setItem(SAVED_PROJECTS_KEY, JSON.stringify(projects));
}

export function upsertProject(projects, repoRoot) {
  const path = normalizeProject(repoRoot);
  if (!path) {
    return projects;
  }
  if (projects.some((project) => project.path === path)) {
    return projects;
  }
  return [...projects, { path, name: projectLabel(path) }];
}

export async function readDesktopConfig() {
  if (window.desktopApi?.getConfig) {
    return window.desktopApi.getConfig();
  }
  return {
    backendUrl: import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8765",
    remoteAccessEnabled: false,
    remoteAccessUrls: [],
  };
}

export async function readNdjsonStream(response, onEvent) {
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
