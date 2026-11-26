"use strict";

// The .claude/settings.json Cortex writes into a repo the first time it is
// opened, and the one-time move of its old "deny" rules to "ask".
//
// Older Cortex builds denied risky commands (rm -rf, git push --force, cd
// outside the repo...). A deny is silent: Claude just works around it and
// the person never hears about it. Those rules are now "ask", so the person
// gets an approval card instead. Only Cortex's own entries are moved, and
// only when the file still holds all of them (so it is recognisably the one
// Cortex wrote); everything else in the file is left exactly as it was.

const fs = require("node:fs");
const path = require("node:path");
const { CLAUDE_ASK_RULES, CLAUDE_DENY_RULES } = require("./riskyCommands");

const ALLOW_RULES = [
  // Safe read operations — always permitted
  "Read",
  "Glob",
  "Grep",
  "LS",
  // Common dev commands
  "Bash(git *)",
  "Bash(npm *)",
  "Bash(npx *)",
  "Bash(node *)",
  "Bash(yarn *)",
  "Bash(pnpm *)",
  "Bash(python *)",
  "Bash(python3 *)",
  "Bash(pip *)",
  "Bash(pip3 *)",
  "Bash(cargo *)",
  "Bash(go *)",
  "Bash(tsc *)",
  "Bash(eslint *)",
  "Bash(jest *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(echo *)",
  "Bash(pwd)",
  "Bash(find *)",
  "Bash(grep *)",
];

// Exactly what older Cortex builds wrote under "deny".
const LEGACY_DENY_RULES = [
  "Bash(cd ..)",
  "Bash(cd ../)",
  "Bash(cd ../*)",
  "Bash(cd /*)",
  "Bash(cd [A-Z]:*)",
  "Bash(wget *)",
  "Bash(Invoke-WebRequest *)",
  "Bash(iwr *)",
  "Bash(rm -rf *)",
  "Bash(rm -fr *)",
  "Bash(rmdir /s *)",
  "Bash(del /s *)",
  "Bash(del /q *)",
  "Bash(format *)",
  "Bash(git push --force *)",
  "Bash(git -C *)",
  "Bash(npm publish *)",
  "Bash(yarn publish *)",
];

function defaultClaudeSettings() {
  return {
    permissions: {
      allow: [...ALLOW_RULES],
      ask: [...CLAUDE_ASK_RULES],
      deny: [...CLAUDE_DENY_RULES],
    },
  };
}

function unique(list) {
  return [...new Set(list)];
}

// Returns the migrated settings object, or null when there is nothing to do
// (not Cortex's legacy file, or already migrated).
function migrateLegacySettings(settings) {
  const permissions = settings?.permissions;
  const deny = Array.isArray(permissions?.deny) ? permissions.deny : null;
  if (!deny || !LEGACY_DENY_RULES.every((rule) => deny.includes(rule))) return null;
  const keptDeny = deny.filter((rule) => !LEGACY_DENY_RULES.includes(rule) || CLAUDE_DENY_RULES.includes(rule));
  const ask = Array.isArray(permissions.ask) ? permissions.ask : [];
  return {
    ...settings,
    permissions: {
      ...permissions,
      ask: unique([...ask, ...CLAUDE_ASK_RULES]),
      deny: unique([...keptDeny, ...CLAUDE_DENY_RULES]),
    },
  };
}

// Writes .claude/settings.json when missing, or migrates Cortex's legacy
// deny list. Returns "created" | "migrated" | "kept" | "error".
function ensureClaudeSettings(repoRoot) {
  try {
    const claudeDir = path.join(repoRoot, ".claude");
    const settingsPath = path.join(claudeDir, "settings.json");
    if (fs.existsSync(settingsPath)) {
      let current;
      try {
        current = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      } catch {
        return "kept"; // not valid JSON: the person's file, leave it alone
      }
      const migrated = migrateLegacySettings(current);
      if (!migrated) return "kept";
      fs.writeFileSync(settingsPath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
      return "migrated";
    }
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(defaultClaudeSettings(), null, 2)}\n`, "utf8");
    return "created";
  } catch {
    return "error";
  }
}

module.exports = {
  LEGACY_DENY_RULES,
  defaultClaudeSettings,
  ensureClaudeSettings,
  migrateLegacySettings,
};
