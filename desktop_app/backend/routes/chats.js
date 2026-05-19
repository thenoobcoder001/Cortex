"use strict";

async function handle(ctx) {
  const { method, pathname, url, body, reply, service, assertRepoRoot } = ctx;

  if (method === "GET" && pathname === "/api/chats") {
    reply(200, { chats: service.listChats(url.searchParams.get("repoRoot")) });
    return true;
  }

  if (method === "GET" && pathname === "/api/chats/messages") {
    reply(200, service.getChatMessages(
      url.searchParams.get("chatId") || "",
      url.searchParams.get("repoRoot"),
      {
        before: url.searchParams.get("before"),
        limit:  url.searchParams.get("limit"),
      },
    ));
    return true;
  }

  if (method === "POST" && pathname === "/api/chats/new") {
    assertRepoRoot(body.repoRoot || null, service);
    reply(200, service.newChat(body.repoRoot || null));
    return true;
  }

  if (method === "POST" && pathname === "/api/chats/activate") {
    assertRepoRoot(body.repoRoot || null, service);
    reply(200, service.activateChat(body.chatId, body.repoRoot || null));
    return true;
  }

  if (method === "POST" && pathname === "/api/chats/delete") {
    assertRepoRoot(body.repoRoot || null, service);
    reply(200, service.deleteChat(body.chatId, body.repoRoot || null));
    return true;
  }

  if (method === "POST" && pathname === "/api/chats/rename") {
    assertRepoRoot(body.repoRoot || null, service);
    reply(200, service.renameChat(body.chatId, body.title, body.repoRoot || null));
    return true;
  }

  if (method === "POST" && pathname === "/api/chats/interrupt") {
    reply(200, service.interruptChat(body.chatId || null));
    return true;
  }

  if (method === "POST" && pathname === "/api/chats/preferences") {
    assertRepoRoot(body.repoRoot || null, service);
    reply(200, service.updateChatPreferences({
      toolSafetyMode: body.toolSafetyMode,
      chatId:         body.chatId  || null,
      repoRoot:       body.repoRoot || null,
    }));
    return true;
  }

  return false;
}

module.exports = { handle };
