"use strict";

async function handle(ctx) {
  const { method, pathname, url, body, reply, response, origin, service, terminalService, isLocal } = ctx;

  if (!pathname.startsWith("/api/terminal")) return false;

  // Terminal is desktop-only — block relay / mobile callers
  if (!isLocal) {
    reply(403, { detail: "Terminal access is not available over the network." });
    return true;
  }

  if (method === "GET" && pathname === "/api/terminal") {
    reply(200, terminalService.snapshot(url.searchParams.get("chatId") || ""));
    return true;
  }

  if (method === "GET" && pathname === "/api/terminal/stream") {
    const chatId = url.searchParams.get("chatId") || "";
    const sseHeaders = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    };
    if (origin) sseHeaders["Access-Control-Allow-Origin"] = origin;
    response.writeHead(200, sseHeaders);
    const snap = terminalService.snapshot(chatId);
    if (snap.history) {
      response.write(`data: ${JSON.stringify({ type: "history", data: snap.history })}\n\n`);
    }
    const onData = (data) => {
      response.write(`data: ${JSON.stringify({ type: "data", data })}\n\n`);
    };
    terminalService.on(`data:${chatId}`, onData);
    ctx.request.on("close", () => {
      terminalService.off(`data:${chatId}`, onData);
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/terminal/open") {
    reply(200, terminalService.open({
      chatId:   body.chatId,
      repoRoot: body.repoRoot || service.repoRoot,
      cols:     body.cols,
      rows:     body.rows,
    }));
    return true;
  }

  if (method === "POST" && pathname === "/api/terminal/write") {
    reply(200, terminalService.write({
      chatId:   body.chatId,
      command:  body.command,
      repoRoot: body.repoRoot || service.repoRoot,
    }));
    return true;
  }

  if (method === "POST" && pathname === "/api/terminal/input") {
    reply(200, terminalService.input({
      chatId:   body.chatId,
      data:     body.data,
      repoRoot: body.repoRoot || service.repoRoot,
    }));
    return true;
  }

  if (method === "POST" && pathname === "/api/terminal/resize") {
    reply(200, terminalService.resize({
      chatId: body.chatId,
      cols:   body.cols,
      rows:   body.rows,
    }));
    return true;
  }

  if (method === "POST" && pathname === "/api/terminal/close") {
    reply(200, terminalService.close(body.chatId));
    return true;
  }

  return false;
}

module.exports = { handle };
