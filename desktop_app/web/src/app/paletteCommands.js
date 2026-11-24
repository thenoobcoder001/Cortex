// Builds the command palette's item list from app state. Plain JS (no JSX):
// `icon` is a lucide-react component name resolved in CommandPalette.jsx.

import { EXTERNAL_EDITOR_OPTIONS, SETTINGS_SECTIONS } from "./constants.js";
import { normalizeProject, projectLabel } from "./utils.js";

const THEMES = [
  { id: "dark", label: "Dark", icon: "Moon" },
  { id: "light", label: "Light", icon: "Sun" },
  { id: "system", label: "System", icon: "Monitor" },
];

// ctx: {
//   activeChatId, activeRepoRoot, activeModelId, themeMode,
//   projects: [{ path }], chatsForProject(path) -> [{ chatId, title }],
//   models: [{ id, label, group }], isModelGroupConnected(group) -> bool,
//   actions: { newChat, toggleSidebar, toggleTerminal, openSettings(section?), openAudit,
//              pickProject, activateChat(chatId, repoRoot), openProject(path),
//              setModel(id), setTheme(mode), openInEditor(editorId) },
// }
export function buildPaletteCommands(ctx) {
  const actions = ctx.actions || {};
  const items = [];
  const activeRepo = normalizeProject(ctx.activeRepoRoot || "");

  items.push(
    { id: "action:new-chat", group: "Actions", title: "New chat", icon: "MessageSquarePlus", shortcut: "newChat",
      keywords: "create start thread conversation", run: () => actions.newChat?.() },
    { id: "action:toggle-sidebar", group: "Actions", title: "Toggle sidebar", icon: "PanelLeft", shortcut: "toggleSidebar",
      keywords: "hide show collapse expand panel", run: () => actions.toggleSidebar?.() },
    { id: "action:toggle-terminal", group: "Actions", title: "Toggle terminal", icon: "SquareTerminal", shortcut: "toggleTerminal",
      keywords: "shell console open close", run: () => actions.toggleTerminal?.() },
    { id: "action:settings", group: "Actions", title: "Open Settings", icon: "Settings", shortcut: "settings",
      keywords: "preferences options config", run: () => actions.openSettings?.() },
    { id: "action:audit", group: "Actions", title: "Open audit trail", icon: "History",
      keywords: "log history security changes", run: () => actions.openAudit?.() },
    { id: "action:pick-project", group: "Actions", title: "Open project folder…", icon: "FolderOpen",
      keywords: "add project browse repo directory", run: () => actions.pickProject?.() },
  );

  // Chats across all projects, the active project first.
  const projects = [...(ctx.projects || [])].sort(
    (a, b) => Number(normalizeProject(b.path) === activeRepo) - Number(normalizeProject(a.path) === activeRepo),
  );
  for (const project of projects) {
    const repo = normalizeProject(project.path);
    const name = projectLabel(repo);
    for (const chat of ctx.chatsForProject?.(repo) || []) {
      if (!chat?.chatId) continue;
      const active = chat.chatId === ctx.activeChatId && repo === activeRepo;
      items.push({
        id: `chat:${repo}:${chat.chatId}`,
        group: "Chats",
        title: chat.title || "Untitled chat",
        subtitle: active ? `${name} · current` : name,
        icon: "MessageSquare",
        keywords: "switch chat",
        run: () => actions.activateChat?.(chat.chatId, repo),
      });
    }
  }

  for (const project of projects) {
    const repo = normalizeProject(project.path);
    items.push({
      id: `project:${repo}`,
      group: "Projects",
      title: projectLabel(repo),
      subtitle: repo === activeRepo ? `${repo} · current` : repo,
      icon: "Folder",
      keywords: "switch project workspace",
      run: () => actions.openProject?.(repo),
    });
  }

  for (const model of ctx.models || []) {
    if (ctx.isModelGroupConnected && !ctx.isModelGroupConnected(model.group)) continue;
    items.push({
      id: `model:${model.id}`,
      group: "Models",
      title: model.label || model.id,
      subtitle: model.id === ctx.activeModelId ? `${model.group} · current` : model.group,
      icon: "Cpu",
      keywords: `change model ${model.id}`,
      run: () => actions.setModel?.(model.id),
    });
  }

  for (const section of SETTINGS_SECTIONS) {
    items.push({
      id: `settings:${section.id}`,
      group: "Settings",
      title: `Settings: ${section.label}`,
      icon: "Settings",
      keywords: "preferences open",
      run: () => actions.openSettings?.(section.id),
    });
  }

  for (const theme of THEMES) {
    items.push({
      id: `theme:${theme.id}`,
      group: "Theme",
      title: `Theme: ${theme.label}`,
      subtitle: theme.id === ctx.themeMode ? "current" : "",
      icon: theme.icon,
      keywords: "change theme appearance color mode",
      run: () => actions.setTheme?.(theme.id),
    });
  }

  if (activeRepo) {
    for (const editor of EXTERNAL_EDITOR_OPTIONS) {
      items.push({
        id: `editor:${editor.id}`,
        group: "Open in",
        title: `Open project in ${editor.label}`,
        subtitle: projectLabel(activeRepo),
        icon: "Code",
        keywords: "editor ide reveal",
        run: () => actions.openInEditor?.(editor.id),
      });
    }
  }

  return items;
}

// With no query the palette shows a short default list instead of every chat
// and model.
export function defaultPaletteItems(items, { chatLimit = 8 } = {}) {
  let chats = 0;
  return items.filter((item) => {
    if (item.group === "Chats") {
      chats += 1;
      return chats <= chatLimit;
    }
    return item.group !== "Models" && item.group !== "Open in";
  });
}

// Groups results under headings. Groups appear in the order of their first
// item, so with a query the group holding the best match comes first.
export function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return [...groups.entries()].map(([name, list]) => ({ name, items: list }));
}
