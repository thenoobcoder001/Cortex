"use strict";

// Shell commands that always need a person's say-so, whatever the chat's
// permission mode. One list for every provider:
//
//   Claude CLI   every shell call goes to the approval bridge in Full access;
//                the bridge asks only for these (see claudeShellAskSettings),
//                and .claude/settings.json carries the same patterns as
//                "ask" rules for people running claude by hand.
//   Codex        the app-server asks Cortex before commands; Full access
//                accepts everything except these.
//   API models   run_terminal_command asks for these, runs the rest.
//
// assessCommand() returns null (fine), { level: "ask", reason } or
// { level: "block", reason }. "block" is kept for the few commands no coding
// task needs and no click should be able to allow: wiping the whole disk,
// the filesystem root or the home folder.

const path = require("node:path");

// A shell token: "double quoted", 'single quoted' or a bare word.
const TOKEN = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|()]+)`;

function unquote(token) {
  const text = String(token || "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

// Git Bash spells C:\x as /c/x; make it a Windows path so it can be compared.
function toNativePath(target, platform = process.platform) {
  const text = String(target || "");
  if (platform === "win32") {
    const match = /^\/([a-zA-Z])(\/.*)?$/.exec(text);
    if (match) return `${match[1].toUpperCase()}:${(match[2] || "/").replace(/\//g, "\\")}`;
  }
  return text;
}

function isInside(root, candidate, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const relative = pathApi.relative(root, candidate);
  if (!relative) return true;
  return !relative.startsWith("..") && !pathApi.isAbsolute(relative);
}

// True when `target` (as typed after cd / git -C) points outside the repo.
// Without a repo root every absolute or parent path counts as outside.
function leavesRepo(target, { repoRoot = "", platform = process.platform } = {}) {
  const raw = unquote(target);
  if (!raw || raw === "-") return false;
  if (/^(~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)/i.test(raw)) return true;
  if (/^[$%]/.test(raw)) return true; // a variable: can't tell where it goes
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const native = toNativePath(raw, platform);
  if (!repoRoot) {
    return pathApi.isAbsolute(native) || /^\.\.([\\/]|$)/.test(native);
  }
  const resolved = pathApi.resolve(repoRoot, native);
  if (platform === "win32") {
    return !isInside(repoRoot.toLowerCase(), resolved.toLowerCase(), platform);
  }
  return !isInside(repoRoot, resolved, platform);
}

// rm/rmdir/Remove-Item targets that would wipe a drive, the root or home.
function wipesEverything(target) {
  const raw = unquote(target).replace(/\\/g, "/").replace(/\/+$/, "/");
  return /^(\/|\/\*|~|~\/|~\/\*|\$HOME\/?\*?|[a-zA-Z]:\/?\*?|\/[a-zA-Z]\/?\*?)$/.test(raw);
}

const RECURSIVE_RM = new RegExp(String.raw`(?:^|[\s;&|("'])rm\s+((?:-{1,2}[\w-]+\s+)*)(${TOKEN})`, "g");

function recursiveRmTargets(command) {
  const targets = [];
  for (const match of command.matchAll(RECURSIVE_RM)) {
    const flags = match[1] || "";
    if (/(^|\s)-[a-zA-Z]*[rR]|--recursive/.test(flags)) targets.push(match[2]);
  }
  return targets;
}

// rmdir /s, rd /s and Remove-Item -Recurse targets.
function windowsRecursiveTargets(command) {
  const targets = [];
  const rd = new RegExp(String.raw`\b(?:rmdir|rd)\s+((?:\/[a-zA-Z]\s+)*)(${TOKEN})`, "gi");
  for (const match of command.matchAll(rd)) {
    if (/\/s/i.test(match[1] || "")) targets.push(match[2]);
  }
  const removeItem = new RegExp(String.raw`\b(?:Remove-Item|ri)\b([^\n;&|]*)`, "gi");
  for (const match of command.matchAll(removeItem)) {
    const args = match[1] || "";
    if (!/\s-Recurse\b/i.test(args)) continue;
    for (const token of args.match(new RegExp(TOKEN, "g")) || []) {
      if (!token.startsWith("-")) targets.push(token);
    }
  }
  return targets;
}

function localHost(token) {
  return /^(?:[a-z][\w+.-]*:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i.test(token);
}

// curl/wget & co. are fine against a local dev server, risky elsewhere.
function reachesInternet(command) {
  const pattern = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer)\b([^\n;&|]*)/gi;
  for (const match of command.matchAll(pattern)) {
    const tokens = (match[2].match(new RegExp(TOKEN, "g")) || [])
      .map(unquote)
      .filter((token) => token && !token.startsWith("-"));
    const urls = tokens.filter((token) => /^[a-z][\w+.-]*:\/\//i.test(token));
    const local = urls.length ? urls.every(localHost) : tokens.some(localHost);
    if (!local) return true;
  }
  return false;
}

const RULES = [
  {
    id: "wipe-disk",
    level: "block",
    reason: "wipes a whole drive, the root folder or the home folder",
    test: (command) =>
      recursiveRmTargets(command).some(wipesEverything)
      || windowsRecursiveTargets(command).some(wipesEverything)
      || /\bformat(?:\.com)?\s+[a-zA-Z]:/i.test(command),
  },
  {
    id: "recursive-delete",
    level: "ask",
    reason: "deletes files recursively",
    test: (command) =>
      recursiveRmTargets(command).length > 0
      || windowsRecursiveTargets(command).length > 0
      || /\b(?:del|erase)\s+(?:[^\n;&|]*\s)?\/[sq]\b/i.test(command)
      || /\b(?:rm|del|erase)\b[^\n;&|]*\s-Recurse\b/i.test(command)
      || /\bgit\s+clean\b[^\n;&|]*\s-[a-zA-Z]*f/.test(command),
  },
  {
    id: "force-push",
    level: "ask",
    reason: "force-pushes and can overwrite history on the remote",
    test: (command) => /\bgit\s+(?:-[^\s]+\s+)*push\b[^\n;&|]*(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S)/.test(command),
  },
  {
    id: "publish",
    level: "ask",
    reason: "publishes a package",
    test: (command) => /\b(?:npm|yarn|pnpm|bun)\s+(?:[^\n;&|]*\s)?publish\b/.test(command)
      || /\b(?:cargo|twine|gem|dotnet\s+nuget)\s+(?:publish|upload|push)\b/.test(command),
  },
  {
    id: "network",
    level: "ask",
    reason: "downloads from or sends data to the internet",
    test: reachesInternet,
  },
  {
    id: "leave-repo",
    level: "ask",
    reason: "works in a folder outside this project",
    test: (command, options) => {
      const cdPattern = new RegExp(String.raw`(?:^|[\s;&|("'])(?:cd|chdir|pushd|Set-Location|sl)\s+(?:\/d\s+)?(${TOKEN})`, "gi");
      for (const match of command.matchAll(cdPattern)) {
        if (leavesRepo(match[1], options)) return true;
      }
      const gitC = new RegExp(String.raw`\bgit\s+-C\s+(${TOKEN})`, "g");
      for (const match of command.matchAll(gitC)) {
        if (leavesRepo(match[1], options)) return true;
      }
      return false;
    },
  },
];

const RULE_REASONS = Object.fromEntries(RULES.map((rule) => [rule.id, rule.reason]));

// options: { repoRoot, platform }
function assessCommand(command, options = {}) {
  const text = String(command || "");
  if (!text.trim()) return null;
  const opts = { platform: process.platform, ...options };
  for (const level of ["block", "ask"]) {
    for (const rule of RULES) {
      if (rule.level !== level) continue;
      let hit = false;
      try {
        hit = Boolean(rule.test(text, opts));
      } catch {
        hit = false;
      }
      if (hit) return { id: rule.id, level: rule.level, reason: rule.reason };
    }
  }
  return null;
}

// The line an approval card shows above the command.
function riskLabel(risk) {
  if (!risk) return "";
  return `Risky command: ${risk.reason}`;
}

// ── Claude CLI settings ────────────────────────────────────────────────────
// Claude's own permission rules are prefix globs, so they cannot see where a
// cd goes or tell localhost from the internet. They back the shared list
// when Claude runs without Cortex (someone running `claude` in the repo by
// hand) and when the approval bridge is unavailable.
const CLAUDE_ASK_RULES = [
  "Bash(rm -rf *)",
  "Bash(rm -fr *)",
  "Bash(rm -r *)",
  "Bash(rm -R *)",
  "Bash(rm -Rf *)",
  "Bash(rm -fR *)",
  "Bash(rm --recursive *)",
  "Bash(rmdir /s *)",
  "Bash(rd /s *)",
  "Bash(del /s *)",
  "Bash(del /q *)",
  "Bash(git clean *)",
  "Bash(cd ..)",
  "Bash(cd ../*)",
  "Bash(cd ~*)",
  "Bash(git -C *)",
  "Bash(git push --force *)",
  "Bash(git push -f *)",
  "Bash(git push --force-with-lease *)",
  "Bash(wget *)",
  "Bash(Invoke-WebRequest *)",
  "Bash(iwr *)",
  "Bash(npm publish *)",
  "Bash(yarn publish *)",
  "Bash(pnpm publish *)",
];

// Exact commands only (a glob like "rm -rf /*" would also catch every
// absolute path). See the "block" rule above for why these stay denied.
const CLAUDE_DENY_RULES = [
  "Bash(rm -rf /)",
  "Bash(rm -fr /)",
  "Bash(rm -rf ~)",
  "Bash(rm -fr ~)",
  "Bash(rm -rf ~/)",
  "Bash(format *)",
];

// Per-turn --settings for Claude in Full access with the bridge: every shell
// call asks, and the bridge answers with assessCommand (so only risky ones
// reach the user).
const CLAUDE_SHELL_TOOLS = ["Bash", "PowerShell"];

function claudeShellAskSettings() {
  return { permissions: { ask: [...CLAUDE_SHELL_TOOLS] } };
}

// Per-turn --settings when the bridge is unavailable: risky patterns ask,
// and with nobody to answer Claude declines them.
function claudeRiskyAskSettings() {
  return { permissions: { ask: [...CLAUDE_ASK_RULES], deny: [...CLAUDE_DENY_RULES] } };
}

module.exports = {
  CLAUDE_ASK_RULES,
  CLAUDE_DENY_RULES,
  CLAUDE_SHELL_TOOLS,
  RULE_REASONS,
  assessCommand,
  claudeRiskyAskSettings,
  claudeShellAskSettings,
  leavesRepo,
  riskLabel,
  toNativePath,
};
