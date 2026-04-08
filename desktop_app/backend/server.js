const http = require("node:http");
const { URL } = require("node:url");
const { DesktopSessionService } = require("./sessionService");

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
      if (request.method === "GET" && url.pathname === "/api/file") {
        sendJson(response, 200, effectiveService.readFile(url.searchParams.get("path") || ""));
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
