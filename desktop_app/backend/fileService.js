const fs = require("node:fs");
const path = require("node:path");

const SKIP_NAMES = new Set([".git", ".gpt-tui", ".venv", "__pycache__", "node_modules", "out"]);

function walkFiles(root, limit = 200) {
  const found = [];
  const stack = [root];
  while (stack.length && found.length < limit) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        found.push(fullPath);
      }
      if (found.length >= limit) {
        break;
      }
    }
  }
  return found;
}

function buildUnifiedDiff(relativePath, beforeText, afterText) {
  const beforeLines = String(beforeText || "").split("\n");
  const afterLines = String(afterText || "").split("\n");
  const header = [`--- a/${relativePath}`, `+++ b/${relativePath}`];
  if (beforeText === afterText) {
    return header.join("\n");
  }

  const body = [];
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  body.push(`@@ -1,${beforeLines.length} +1,${afterLines.length} @@`);
  for (let index = 0; index < maxLines; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === afterLine) {
      if (beforeLine !== undefined) {
        body.push(` ${beforeLine}`);
      }
      continue;
    }
    if (beforeLine !== undefined) {
      body.push(`-${beforeLine}`);
    }
    if (afterLine !== undefined) {
      body.push(`+${afterLine}`);
    }
  }
  return [...header, ...body].join("\n");
}

class RepoFileService {
  constructor(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
  }

  setRepoRoot(root) {
    const resolved = path.resolve(root);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return [false, `Directory not found: ${resolved}`];
    }
    this.repoRoot = resolved;
    return [true, `Repo root switched to: ${this.repoRoot}`];
  }

  resolveRepoPath(rawPath) {
    if (!rawPath) {
      return [null, "Path is required."];
    }
    const candidate = path.isAbsolute(rawPath) ? rawPath : path.join(this.repoRoot, rawPath);
    const resolved = path.resolve(candidate);
    const relative = path.relative(this.repoRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return [null, "Path rejected: outside repo root."];
    }
    return [resolved, ""];
  }

  listFiles(root = this.repoRoot, limit = 200) {
    return walkFiles(path.resolve(root), limit);
  }

  snapshotRepoState(root = this.repoRoot, { limit = 2000, maxFileBytes = 200_000 } = {}) {
    const state = {};
    for (const fullPath of walkFiles(path.resolve(root), limit)) {
      const stats = fs.statSync(fullPath);
      const relativePath = path.relative(root, fullPath).replaceAll("\\", "/");
      let text = null;
      if (stats.size <= maxFileBytes) {
        try {
          text = fs.readFileSync(fullPath, "utf8");
        } catch {
          text = null;
        }
      }
      state[relativePath] = {
        path: fullPath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        text,
      };
    }
    return state;
  }

  diffRepoState(before, after) {
    const changes = [];
    const allPaths = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const relativePath of [...allPaths].sort()) {
      const previous = before[relativePath];
      const current = after[relativePath];
      if (!previous && current) {
        changes.push({
          action: "create",
          path: relativePath,
          oldPath: "",
          newPath: "",
          diff: buildUnifiedDiff(relativePath, "", current.text || ""),
        });
        continue;
      }
      if (previous && !current) {
        changes.push({
          action: "delete",
          path: relativePath,
          oldPath: "",
          newPath: "",
          diff: buildUnifiedDiff(relativePath, previous.text || "", ""),
        });
        continue;
      }
      if (!previous || !current) {
        continue;
      }
      if (previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
        continue;
      }
      const beforeText = previous.text || "";
      const afterText = current.text || "";
      if (beforeText === afterText) {
        continue;
      }
      changes.push({
        action: "edit",
        path: relativePath,
        oldPath: "",
        newPath: "",
        diff: buildUnifiedDiff(relativePath, beforeText, afterText),
      });
    }
    return changes;
  }

  readUtf8(filePath, maxChars = 6000) {
    const content = fs.readFileSync(filePath, "utf8");
    if (content.length <= maxChars) {
      return [content, false];
    }
    return [`${content.slice(0, maxChars)}\n\n...[truncated]...`, true];
  }
}

module.exports = {
  RepoFileService,
  buildUnifiedDiff,
};
