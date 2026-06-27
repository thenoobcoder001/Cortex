"use strict";

const { getTailscaleInfo, tailscaleUrl } = require("../tailscale");
const { AppConfigStore } = require("../configStore");

// GET /api/tailscale/status
// Reports whether this machine is reachable over Tailscale and the URL the
// mobile app should use in Direct mode to hit the same backend APIs.
//
// `pairUrl` embeds the device's mobile access token so scanning the QR pairs
// the phone for direct (non-relay) access. The token is only ever returned to
// the local desktop UI (loopback-authorized), the same trust model the relay
// uses when it shares the token during pairing.
async function handle(ctx) {
  const { method, pathname, reply, port } = ctx;

  if (method === "GET" && pathname === "/api/tailscale/status") {
    const info = await getTailscaleInfo();
    const url = tailscaleUrl(info, port);
    const token = AppConfigStore.load().mobileToken || "";
    const pairUrl = url && token ? `${url}/?t=${encodeURIComponent(token)}` : url;
    reply(200, {
      available: info.available,
      cliAvailable: info.cliAvailable,
      online: info.online,
      ip: info.ip,
      magicDNS: info.magicDNS,
      url,
      pairUrl,
    });
    return true;
  }

  return false;
}

module.exports = { handle };
