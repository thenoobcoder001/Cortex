"use strict";

// Tailscale detection helpers shared by the standalone server, the relay
// registration, and the /api/tailscale/status route. Prefers the `tailscale`
// CLI (for MagicDNS name + online status) and falls back to scanning network
// interfaces for an address in the Tailscale CGNAT range (100.64.0.0/10).

const os = require("node:os");
const { execFile } = require("node:child_process");

function tailscaleIpFromInterfaces() {
  for (const addrs of Object.values(os.networkInterfaces() || {})) {
    for (const addr of addrs || []) {
      if (!addr.internal && addr.family === "IPv4" && addr.address.startsWith("100.")) {
        return addr.address;
      }
    }
  }
  return "";
}

function runTailscaleCli(args) {
  return new Promise((resolve) => {
    try {
      execFile("tailscale", args, { timeout: 4000, windowsHide: true }, (err, stdout) => {
        resolve(err ? "" : String(stdout || "").trim());
      });
    } catch {
      resolve("");
    }
  });
}

async function getTailscaleInfo() {
  let ip = "";
  let magicDNS = "";
  let online = false;
  let cliAvailable = false;

  const statusJson = await runTailscaleCli(["status", "--json"]);
  if (statusJson) {
    cliAvailable = true;
    try {
      const status = JSON.parse(statusJson);
      const self = status.Self || {};
      online = Boolean(self.Online);
      if (Array.isArray(self.TailscaleIPs)) {
        ip = self.TailscaleIPs.find((addr) => /^100\./.test(addr)) || self.TailscaleIPs[0] || "";
      }
      const dns = String(self.DNSName || "").replace(/\.$/, "");
      if (dns) magicDNS = dns;
    } catch {
      // fall through to interface scan
    }
  }

  if (!ip) ip = tailscaleIpFromInterfaces();

  const available = Boolean(ip);
  return {
    available,
    cliAvailable,
    online: online || available,
    ip,
    magicDNS,
  };
}

// Build a reachable backend URL for the given port. Prefers the MagicDNS name
// when available (stable across IP changes), otherwise the raw Tailscale IP.
function tailscaleUrl(info, port) {
  if (!info) return "";
  const host = info.magicDNS || info.ip;
  return host ? `http://${host}:${port}` : "";
}

module.exports = { getTailscaleInfo, tailscaleUrl, tailscaleIpFromInterfaces };
