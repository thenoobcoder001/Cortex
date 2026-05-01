"use strict";

async function handle(ctx) {
  const { method, pathname, body, reply, response, origin, service, assertRepoRoot } = ctx;

  if (method === "POST" && pathname === "/api/chat/send") {
    assertRepoRoot(body.repoRoot || null, service);
    reply(200, await service.sendMessage(body.message, {
      chatId:        body.chatId        || null,
      repoRoot:      body.repoRoot      || null,
      model:         body.model         || null,
      promptPreset:  body.promptPreset  || null,
      toolSafetyMode: body.toolSafetyMode || null,
    }));
    return true;
  }

  if (method === "POST" && pathname === "/api/chat/send-stream") {
    assertRepoRoot(body.repoRoot || null, service);
    const streamHeaders = {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    };
    if (origin) streamHeaders["Access-Control-Allow-Origin"] = origin;
    response.writeHead(200, streamHeaders);
    try {
      for await (const event of service.sendMessageEvents(body.message, {
        chatId:        body.chatId        || null,
        repoRoot:      body.repoRoot      || null,
        model:         body.model         || null,
        promptPreset:  body.promptPreset  || null,
        toolSafetyMode: body.toolSafetyMode || null,
      })) {
        response.write(`${JSON.stringify(event)}\n`);
      }
    } catch (error) {
      response.write(`${JSON.stringify({ type: "error", message: String(error?.message || error) })}\n`);
    }
    response.end();
    return true;
  }

  return false;
}

module.exports = { handle };
