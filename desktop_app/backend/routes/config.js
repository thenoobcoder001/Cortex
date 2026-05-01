"use strict";

async function handle(ctx) {
  const { method, pathname, body, reply, service, isLocal } = ctx;

  if (method === "GET" && pathname === "/api/status") {
    reply(200, service.snapshot());
    return true;
  }

  if (method === "POST" && pathname === "/api/config") {
    let configBody = body;
    if (!isLocal) {
      // Remote callers may only change safe fields.
      // API keys, memory, safety mode, and remote access toggle are desktop-only.
      const { model, promptPreset, contextCarryMessages, repoRoot } = body;
      configBody = { model, promptPreset, contextCarryMessages, repoRoot };
    }
    reply(200, service.updateConfig(configBody));
    return true;
  }

  if (method === "POST" && pathname === "/api/config/delete") {
    reply(200, service.deleteSettingsFile());
    return true;
  }

  if (method === "POST" && pathname === "/api/cache/clear") {
    reply(200, service.clearLocalData(Array.isArray(body.repoRoots) ? body.repoRoots : []));
    return true;
  }

  if (method === "POST" && pathname === "/api/providers/test") {
    reply(200, await service.testProviderConnection(body));
    return true;
  }

  return false;
}

module.exports = { handle };
