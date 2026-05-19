"use strict";

async function handle(ctx) {
  const { method, pathname, body, reply, service, isLocal } = ctx;

  if (method === "GET" && pathname === "/api/status") {
    const isLite = ctx.url?.searchParams?.get("lite") === "true";
    // lite=true skips expensive workspaceChanges/files/messages computation entirely.
    reply(200, service.snapshot({ lite: isLite }));
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
    // Remote callers (mobile) never need changes/files/messages — skip the expensive diff.
    reply(200, service.updateConfig(configBody, { lite: !isLocal }));
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
