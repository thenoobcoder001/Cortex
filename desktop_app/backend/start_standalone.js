const os = require("node:os");
const { startBackendServer, relayConnect } = require("./server");
const { AppConfigStore } = require("./configStore");
const { getTailscaleInfo, tailscaleUrl } = require("./tailscale");

function getLocalUrl(port) {
  for (const addrs of Object.values(os.networkInterfaces() || {})) {
    for (const addr of addrs || []) {
      if (!addr.internal && addr.family === "IPv4" && !addr.address.startsWith("100.")) {
        return `http://${addr.address}:${port}`;
      }
    }
  }
  return "";
}

async function getTailscaleUrl(port) {
  return tailscaleUrl(await getTailscaleInfo(), port);
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

// Same rule as electron/main.js: listen on loopback only unless remote access
// is switched on. CORTEX_REMOTE_ACCESS (1/true or 0/false) overrides the saved
// remoteAccessEnabled setting for this run.
function resolveBindHost({ env = process.env, config = {} } = {}) {
  const flag = String(env.CORTEX_REMOTE_ACCESS || "").trim().toLowerCase();
  let remote = Boolean(config.remoteAccessEnabled);
  if (TRUE_VALUES.has(flag)) remote = true;
  else if (FALSE_VALUES.has(flag)) remote = false;
  return remote ? "0.0.0.0" : "127.0.0.1";
}

async function main() {
  const port = 8765;
  const host = resolveBindHost({ config: AppConfigStore.load() });
  console.log(`Starting standalone backend on http://${host}:${port}...`);
  if (host === "127.0.0.1") {
    console.log("Remote access is off; set CORTEX_REMOTE_ACCESS=1 to listen on all interfaces.");
  }

  let handle;
  try {
    handle = await startBackendServer({ host, port });
    console.log(`Backend running at ${handle.url}`);
  } catch (error) {
    console.error("Failed to start backend:", error);
    process.exit(1);
  }

  // Auto-connect Cortex relay if credentials are saved
  const config = AppConfigStore.load();
  if (config.cortexToken) {
    const localUrl    = getLocalUrl(port);
    const tsUrl       = await getTailscaleUrl(port);
    console.log("Cortex relay: connecting...");
    try {
      const result = await relayConnect({
        token:           config.cortexToken,
        deviceId:        config.cortexDeviceId      || undefined,
        reconnectSecret: config.cortexReconnectSecret || undefined,
        localUrl,
        tailscaleUrl:    tsUrl,
        localBackendPort: port,
      });
      config.cortexDeviceId        = result.deviceId;
      config.cortexReconnectSecret = result.reconnectSecret;
      config.save();
      console.log(`Cortex relay: connected as ${result.deviceId} (socket ${result.socketId})`);
    } catch (err) {
      console.warn("Cortex relay auto-connect failed:", err.message);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveBindHost };
