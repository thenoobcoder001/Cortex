"use strict";

const fs   = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    exec(`git -c safe.directory=* ${args}`, { cwd, encoding: "utf8", timeout: 10000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message || String(error)));
      else resolve(stdout || "");
    });
  });
}

function parseDiffByFile(diffText) {
  const files = {};
  if (!diffText) return files;
  const chunks = diffText.split(/^(?=diff --git )/m).filter(Boolean);
  for (const chunk of chunks) {
    const match = chunk.match(/^diff --git a\/.+ b\/(.+)\n/);
    if (match) files[match[1]] = chunk.trimEnd();
  }
  return files;
}

async function gitChanges(repoRoot) {
  if (!repoRoot) return { changes: [], error: "No repo root provided" };
  try {
    let statusOut;
    try {
      statusOut = await runGit("status --porcelain=v1 -uall", repoRoot);
    } catch (gitError) {
      return { changes: [], error: `git status failed: ${gitError.message}` };
    }
    if (!statusOut.trim()) return { changes: [], error: null };

    const [diffTracked, diffStaged] = await Promise.all([
      runGit("diff HEAD", repoRoot).catch(() => ""),
      runGit("diff --cached", repoRoot).catch(() => ""),
    ]);
    const diffByFile = { ...parseDiffByFile(diffStaged), ...parseDiffByFile(diffTracked) };
    const changes = [];
    for (const line of statusOut.split("\n").filter(Boolean)) {
      const xy       = line.slice(0, 2);
      const rest     = line.slice(3).trim();
      let filePath   = rest;
      let oldPath    = null;
      let newPath    = null;
      if ((xy[0] === "R" || xy[1] === "R") && rest.includes(" -> ")) {
        [oldPath, newPath] = rest.split(" -> ").map((s) => s.trim());
        filePath = newPath;
      }
      let action = "edit";
      if (xy[0] === "?" && xy[1] === "?")       action = "add";
      else if (xy[0] === "D" || xy[1] === "D")  action = "delete";
      else if (xy[0] === "A" || xy[1] === "A")  action = "add";
      else if (xy[0] === "R" || xy[1] === "R")  action = "rename";
      let diff = diffByFile[filePath] || (oldPath ? diffByFile[oldPath] : "") || "";
      if (!diff) {
        try {
          const fullPath = path.join(repoRoot, filePath);
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            const content = fs.readFileSync(fullPath, "utf8");
            diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${content.split("\n").length} @@\n` +
              content.split("\n").map((l) => `+${l}`).join("\n");
          }
        } catch { diff = ""; }
      }
      changes.push({ action, path: filePath, diff, oldPath: oldPath || undefined, newPath: newPath || undefined });
    }
    return { changes, error: null };
  } catch (err) {
    return { changes: [], error: String(err.message || err) };
  }
}

async function handle(ctx) {
  const { method, pathname, url, reply, service } = ctx;

  if (method === "GET" && pathname === "/api/file") {
    const filePath = url.searchParams.get("path") || "";
    if (!filePath) {
      reply(400, { detail: "path parameter required." });
      return true;
    }
    // P2-K: always require a selected project — never fall back to CWD
    if (!service.repoRoot) {
      reply(403, { detail: "No project selected." });
      return true;
    }
    const resolved = path.resolve(filePath);
    const root     = path.resolve(service.repoRoot);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      reply(403, { detail: "Path outside project root." });
      return true;
    }
    reply(200, service.readFile(filePath));
    return true;
  }

  if (method === "GET" && pathname === "/api/workspace/git-status") {
    const repoRoot = url.searchParams.get("repoRoot") || service.repoRoot || "";
    reply(200, await gitChanges(repoRoot));
    return true;
  }

  if (method === "GET" && pathname === "/api/android/avds") {
    exec("emulator -list-avds", { encoding: "utf8", timeout: 8000 }, (error, stdout) => {
      const avds = (stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      reply(200, { avds });
    });
    return true;
  }

  return false;
}

module.exports = { handle };
