const fs = require("node:fs");
const path = require("node:path");

const SKIP_NAMES = new Set([".git", ".cortex", ".venv", "__pycache__", "node_modules", "out"]);

// Repo snapshots feed the audit trail's change detection, so their job is
// completeness: the cap is high and, when it is hit, the snapshot says so
// (see snapshotInfo) instead of silently looking complete.
const SNAPSHOT_FILE_LIMIT = 50_000;
// File text is kept only for diffs. Past this total, further files are
// tracked by size + mtime alone so huge repos cannot exhaust memory.
const SNAPSHOT_TEXT_BUDGET_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_INFO = Symbol("snapshotInfo");

// Returns { files, truncated }: truncated is true when at least one more
// file existed beyond `limit`.
function walkFilesDetailed(root, limit = 200) {
  const files = [];
  const stack = [root];
  let truncated = false;
  while (stack.length && !truncated) {
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
      if (!entry.isFile()) {
        continue;
      }
      if (files.length >= limit) {
        truncated = true;
        break;
      }
      files.push(fullPath);
    }
  }
  return { files, truncated };
}

function walkFiles(root, limit = 200) {
  return walkFilesDetailed(root, limit).files;
}

// { truncated, limit, fileCount } for a state built by snapshotRepoState,
// or null for one that was not (e.g. a baseline loaded back from disk).
function snapshotInfo(state) {
  return (state && state[SNAPSHOT_INFO]) || null;
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

  snapshotRepoState(root = this.repoRoot, {
    limit = SNAPSHOT_FILE_LIMIT,
    maxFileBytes = 200_000,
    maxTextBytes = SNAPSHOT_TEXT_BUDGET_BYTES,
  } = {}) {
    const state = {};
    const { files, truncated } = walkFilesDetailed(path.resolve(root), limit);
    let textBytes = 0;
    for (const fullPath of files) {
      const stats = fs.statSync(fullPath);
      const relativePath = path.relative(root, fullPath).replaceAll("\\", "/");
      let text = null;
      if (stats.size <= maxFileBytes && textBytes + stats.size <= maxTextBytes) {
        try {
          text = fs.readFileSync(fullPath, "utf8");
          textBytes += stats.size;
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
    // Symbol key: invisible to Object.keys/JSON, cannot collide with a path.
    Object.defineProperty(state, SNAPSHOT_INFO, {
      value: { truncated, limit, fileCount: files.length },
      enumerable: false,
    });
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
      // Text is only kept for files under the size/text budget. When either
      // side has none, size + mtime is the only evidence, and a changed file
      // must still be reported rather than compared as "" === "".
      const contentKnown = previous.text != null && current.text != null;
      if (contentKnown && beforeText === afterText) {
        continue;
      }
      changes.push({
        action: "edit",
        path: relativePath,
        oldPath: "",
        newPath: "",
        diff: contentKnown ? buildUnifiedDiff(relativePath, beforeText, afterText) : buildUnifiedDiff(relativePath, "", ""),
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
  snapshotInfo,
  SNAPSHOT_FILE_LIMIT,
};
