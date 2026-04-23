const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");
const { URL } = require("node:url");
const { DesktopSessionService } = require("./sessionService");

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    // -c safe.directory=* bypasses the dubious-ownership check that fires when
    // files were created by a different OS user (e.g. the Codex sandbox account).
    exec(`git -c safe.directory=* ${args}`, { cwd, encoding: "utf8", timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message || String(error)));
      } else {
        resolve(stdout || "");
      }
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
    // -uall lists every individual untracked file (not just directories)
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
    // Merge both diffs; prefer the HEAD diff when both exist for a file
    const diffByFile = { ...parseDiffByFile(diffStaged), ...parseDiffByFile(diffTracked) };
    const changes = [];
    for (const line of statusOut.split("\n").filter(Boolean)) {
      const xy = line.slice(0, 2);
      const rest = line.slice(3).trim();
      let filePath = rest;
      let oldPath = null;
      let newPath = null;
      if ((xy[0] === "R" || xy[1] === "R") && rest.includes(" -> ")) {
        [oldPath, newPath] = rest.split(" -> ").map((s) => s.trim());
        filePath = newPath;
      }
      let action = "edit";
      if (xy[0] === "?" && xy[1] === "?") action = "add";
      else if (xy[0] === "D" || xy[1] === "D") action = "delete";
      else if (xy[0] === "A" || xy[1] === "A") action = "add";
      else if (xy[0] === "R" || xy[1] === "R") action = "rename";
      let diff = diffByFile[filePath] || (oldPath ? diffByFile[oldPath] : "") || "";
      // For untracked files git diff won't have them — read content directly
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

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  sendJson(response, 400, { detail: String(error?.message || error) });
}

function startBackendServer({ host = "127.0.0.1", port = 8765, service = null } = {}) {
  const effectiveService = service || new DesktopSessionService();
  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJson(response, 200, effectiveService.snapshot());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/chats") {
        sendJson(response, 200, { chats: effectiveService.listChats(url.searchParams.get("repoRoot")) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/chats/messages") {
        sendJson(response, 200, effectiveService.getChatMessages(
          url.searchParams.get("chatId") || "",
          url.searchParams.get("repoRoot"),
          {
            before: url.searchParams.get("before"),
            limit: url.searchParams.get("limit"),
          },
        ));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/file") {
        sendJson(response, 200, effectiveService.readFile(url.searchParams.get("path") || ""));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/workspace/git-status") {
        const repoRoot = url.searchParams.get("repoRoot") || effectiveService.repoRoot || "";
        sendJson(response, 200, await gitChanges(repoRoot));
        return;
      }

      const body = request.method === "POST" ? await readJsonBody(request) : {};

      if (request.method === "POST" && url.pathname === "/api/config") {
        sendJson(response, 200, effectiveService.updateConfig(body));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/new") {
        sendJson(response, 200, effectiveService.newChat(body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/activate") {
        sendJson(response, 200, effectiveService.activateChat(body.chatId, body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/delete") {
        sendJson(response, 200, effectiveService.deleteChat(body.chatId, body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/rename") {
        sendJson(response, 200, effectiveService.renameChat(body.chatId, body.title, body.repoRoot || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/interrupt") {
        sendJson(response, 200, effectiveService.interruptChat(body.chatId || null));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chats/preferences") {
        sendJson(response, 200, effectiveService.updateChatPreferences({
          toolSafetyMode: body.toolSafetyMode,
          chatId: body.chatId || null,
          repoRoot: body.repoRoot || null,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cache/clear") {
        sendJson(response, 200, effectiveService.clearLocalData(Array.isArray(body.repoRoots) ? body.repoRoots : []));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/config/delete") {
        sendJson(response, 200, effectiveService.deleteSettingsFile());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/providers/test") {
        sendJson(response, 200, await effectiveService.testProviderConnection(body));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chat/send") {
        sendJson(
          response,
          200,
          await effectiveService.sendMessage(body.message, {
            chatId: body.chatId || null,
            repoRoot: body.repoRoot || null,
            model: body.model || null,
            promptPreset: body.promptPreset || null,
            toolSafetyMode: body.toolSafetyMode || null,
          }),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chat/send-stream") {
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        try {
          for await (const event of effectiveService.sendMessageEvents(body.message, {
            chatId: body.chatId || null,
            repoRoot: body.repoRoot || null,
            model: body.model || null,
            promptPreset: body.promptPreset || null,
            toolSafetyMode: body.toolSafetyMode || null,
          })) {
            response.write(`${JSON.stringify(event)}\n`);
          }
        } catch (error) {
          response.write(`${JSON.stringify({ type: "error", message: String(error?.message || error) })}\n`);
        }
        response.end();
        return;
      }

      sendJson(response, 404, { detail: "Not found" });
    } catch (error) {
      sendError(response, error);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve({
        server,
        service: effectiveService,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}

module.exports = {
  startBackendServer,
};
