"use strict";

const fs = require("node:fs");
const path = require("node:path");

function folderExists(target) {
  if (!target || !path.isAbsolute(target)) return false;
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

async function handle(ctx) {
  const { method, pathname, body, reply, service, isLocal } = ctx;

  if (method === "GET" && pathname === "/api/status") {
    const params = ctx.url?.searchParams;
    const isLite = params?.get("lite") === "true";
    // lite=true skips expensive workspaceChanges/files/messages computation entirely.
    // The workspace diff (`changes`, `activeChatChanges`) is opt-in with
    // ?include=changes: no current client reads it from this poll.
    const include = String(params?.get("include") || "").split(",").map((s) => s.trim());
    reply(200, service.snapshot({ lite: isLite, includeChanges: include.includes("changes") }));
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

  // Which saved project folders still exist, for the sidebar. Desktop only:
  // remote callers have no business probing the disk.
  //   POST /api/projects/exists { paths: [...] } -> { exists: { path: bool } }
  if (method === "POST" && pathname === "/api/projects/exists") {
    if (!isLocal) {
      reply(403, { detail: "Only the desktop app can check project folders." });
      return true;
    }
    const paths = Array.isArray(body.paths) ? body.paths.slice(0, 200).map(String) : [];
    reply(200, { exists: Object.fromEntries(paths.map((target) => [target, folderExists(target)])) });
    return true;
  }

  if (method === "POST" && pathname === "/api/providers/test") {
    reply(200, await service.testProviderConnection(body));
    return true;
  }

  return false;
}

module.exports = { handle, folderExists };
