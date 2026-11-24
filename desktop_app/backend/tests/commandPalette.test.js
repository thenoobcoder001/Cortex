const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The palette logic lives in the web app (ES modules); load it from there.
const appDir = path.join(__dirname, "..", "..", "web", "src", "app");
const load = (name) => import(pathToFileURL(path.join(appDir, name)).href);

test("fuzzyMatch matches subsequences case-insensitively", async () => {
  const { fuzzyMatch } = await load("fuzzy.js");
  assert.ok(fuzzyMatch("nc", "New chat"));
  assert.ok(fuzzyMatch("TERM", "Toggle terminal"));
  assert.equal(fuzzyMatch("xyz", "New chat"), null);
  assert.equal(fuzzyMatch("chatt", "chat"), null);
  assert.deepEqual(fuzzyMatch("", "anything"), { score: 0, positions: [] });
  assert.deepEqual(fuzzyMatch("cha", "New chat").positions, [4, 5, 6]);
});

test("fuzzyMatch ranks prefixes and word starts above scattered hits", async () => {
  const { fuzzyMatch } = await load("fuzzy.js");
  const score = (q, t) => fuzzyMatch(q, t).score;
  assert.ok(score("set", "Settings") > score("set", "Reset sidebar"));
  assert.ok(score("ts", "Toggle sidebar") > score("ts", "Tests"));
  assert.ok(score("tsb", "Toggle sidebar") > score("tsb", "Theme: System sub"));
  assert.ok(score("term", "Toggle terminal") > score("term", "Determine"));
});

test("filterItems needs every word to match and orders by score", async () => {
  const { filterItems } = await load("fuzzy.js");
  const items = [
    { id: "a", title: "Open audit trail" },
    { id: "b", title: "Toggle terminal", keywords: "shell console" },
    { id: "c", title: "Fix login bug", subtitle: "cortex" },
    { id: "d", title: "Settings: Providers" },
  ];
  assert.deepEqual(filterItems(items, "term").map((item) => item.id), ["b"]);
  assert.deepEqual(filterItems(items, "shell").map((item) => item.id), ["b"]);
  assert.deepEqual(filterItems(items, "login cortex").map((item) => item.id), ["c"]);
  assert.deepEqual(filterItems(items, "login nope").map((item) => item.id), []);
  assert.deepEqual(filterItems(items, "").map((item) => item.id), ["a", "b", "c", "d"]);
  assert.deepEqual(filterItems(items, "prov")[0].matches, [10, 11, 12, 13]);
  assert.equal(filterItems(items, "t", { limit: 2 }).length, 2);
});

test("highlightSegments splits text into matched runs", async () => {
  const { highlightSegments } = await load("fuzzy.js");
  assert.deepEqual(highlightSegments("New chat", [4, 5]), [
    { text: "New ", match: false },
    { text: "ch", match: true },
    { text: "at", match: false },
  ]);
  assert.deepEqual(highlightSegments("abc", []), [{ text: "abc", match: false }]);
});

test("matchShortcut uses Ctrl off mac and Cmd on mac", async () => {
  const { matchShortcut } = await load("shortcuts.js");
  const key = (k, extra = {}) => ({ key: k, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
  assert.equal(matchShortcut(key("k", { ctrlKey: true })), "palette");
  assert.equal(matchShortcut(key("K", { ctrlKey: true })), "palette");
  assert.equal(matchShortcut(key("k", { metaKey: true })), null);
  assert.equal(matchShortcut(key("k", { metaKey: true }), true), "palette");
  assert.equal(matchShortcut(key("k", { ctrlKey: true }), true), null);
  assert.equal(matchShortcut(key("n", { ctrlKey: true })), "newChat");
  assert.equal(matchShortcut(key("b", { ctrlKey: true })), "toggleSidebar");
  assert.equal(matchShortcut(key("Dead", { ctrlKey: true, code: "Backquote" })), "toggleTerminal");
  assert.equal(matchShortcut(key(",", { ctrlKey: true })), "settings");
  assert.equal(matchShortcut(key("k")), null);
  assert.equal(matchShortcut(key("k", { ctrlKey: true, shiftKey: true })), null);
  assert.equal(matchShortcut(key("k", { ctrlKey: true, altKey: true })), null);
});

test("only Ctrl+K and Ctrl+N fire while typing; only Ctrl+` in the terminal", async () => {
  const { shortcutAllowed } = await load("shortcuts.js");
  const ids = ["palette", "newChat", "toggleSidebar", "toggleTerminal", "settings"];
  const allowed = (where) => ids.filter((id) => shortcutAllowed(id, where));
  assert.deepEqual(allowed({}), ids);
  assert.deepEqual(allowed({ typing: true }), ["palette", "newChat"]);
  assert.deepEqual(allowed({ typing: true, inTerminal: true }), ["toggleTerminal"]);
  assert.equal(shortcutAllowed("nope"), false);
});

test("isTypingTarget recognises text fields", async () => {
  const { isTypingTarget } = await load("shortcuts.js");
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "search" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
});

test("shortcutKeys shows Ctrl or the Cmd symbol", async () => {
  const { shortcutKeys, shortcutText } = await load("shortcuts.js");
  assert.deepEqual(shortcutKeys("palette"), ["Ctrl", "K"]);
  assert.deepEqual(shortcutKeys("palette", true), ["⌘", "K"]);
  assert.equal(shortcutText("toggleTerminal"), "Ctrl+`");
  assert.deepEqual(shortcutKeys("nope"), []);
});

function sampleContext(calls = []) {
  const record = (name) => (...args) => calls.push([name, ...args]);
  return {
    activeChatId: "c1",
    activeRepoRoot: "/work/alpha",
    activeModelId: "claude:sonnet",
    themeMode: "dark",
    projects: [{ path: "/work/beta" }, { path: "/work/alpha" }],
    chatsForProject: (repo) => (repo === "/work/alpha"
      ? [{ chatId: "c1", title: "Fix login" }, { chatId: "c2", title: "" }]
      : [{ chatId: "c9", title: "Beta chat" }]),
    models: [
      { id: "claude:sonnet", label: "Sonnet", group: "Claude" },
      { id: "codex:gpt", label: "GPT", group: "Codex" },
    ],
    isModelGroupConnected: (group) => group === "Claude",
    actions: {
      newChat: record("newChat"),
      activateChat: record("activateChat"),
      openSettings: record("openSettings"),
      setModel: record("setModel"),
      setTheme: record("setTheme"),
      openInEditor: record("openInEditor"),
      openProject: record("openProject"),
    },
  };
}

test("palette commands cover chats in every project, active project first", async () => {
  const { buildPaletteCommands } = await load("paletteCommands.js");
  const calls = [];
  const items = buildPaletteCommands(sampleContext(calls));
  const chats = items.filter((item) => item.group === "Chats");
  assert.deepEqual(chats.map((item) => item.title), ["Fix login", "Untitled chat", "Beta chat"]);
  assert.match(chats[0].subtitle, /current/);
  chats[2].run();
  assert.deepEqual(calls.at(-1), ["activateChat", "c9", "/work/beta"]);
});

test("palette commands include actions, settings sections, themes, editors and connected models", async () => {
  const { buildPaletteCommands } = await load("paletteCommands.js");
  const calls = [];
  const items = buildPaletteCommands(sampleContext(calls));
  const ids = new Set(items.map((item) => item.id));
  for (const id of ["action:new-chat", "action:toggle-sidebar", "action:toggle-terminal", "action:settings",
    "action:audit", "settings:providers", "theme:light", "editor:vscode", "model:claude:sonnet", "project:/work/beta"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.ok(!ids.has("model:codex:gpt"), "models from disconnected providers are left out");
  assert.equal(items.find((item) => item.id === "action:new-chat").shortcut, "newChat");
  items.find((item) => item.id === "settings:providers").run();
  items.find((item) => item.id === "theme:light").run();
  items.find((item) => item.id === "model:claude:sonnet").run();
  assert.deepEqual(calls, [["openSettings", "providers"], ["setTheme", "light"], ["setModel", "claude:sonnet"]]);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length, "ids are unique");
});

test("default palette list is short and grouping keeps best group first", async () => {
  const { buildPaletteCommands, defaultPaletteItems, groupItems } = await load("paletteCommands.js");
  const items = buildPaletteCommands(sampleContext());
  const defaults = defaultPaletteItems(items, { chatLimit: 2 });
  assert.equal(defaults.filter((item) => item.group === "Chats").length, 2);
  assert.ok(!defaults.some((item) => item.group === "Models" || item.group === "Open in"));
  const groups = groupItems([
    { id: "1", group: "Chats" }, { id: "2", group: "Actions" }, { id: "3", group: "Chats" },
  ]);
  assert.deepEqual(groups.map((group) => [group.name, group.items.length]), [["Chats", 2], ["Actions", 1]]);
});

test("no editor commands without an active project", async () => {
  const { buildPaletteCommands } = await load("paletteCommands.js");
  const items = buildPaletteCommands({ ...sampleContext(), activeRepoRoot: "" });
  assert.ok(!items.some((item) => item.group === "Open in"));
});
