"use strict";

const { getTailscaleInfo, tailscaleUrl } = require("../tailscale");

// GET /api/tailscale/status
// Reports whether this machine is reachable over Tailscale and the URL the
// mobile app should use in Direct mode to hit the same backend APIs.
async function handle(ctx) {
  const { method, pathname, reply, port } = ctx;

  if (method === "GET" && pathname === "/api/tailscale/status") {
    const info = await getTailscaleInfo();
    reply(200, {
      available: info.available,
      cliAvailable: info.cliAvailable,
      online: info.online,
      ip: info.ip,
      magicDNS: info.magicDNS,
      url: tailscaleUrl(info, port),
    });
    return true;
  }

  return false;
}

module.exports = { handle };
