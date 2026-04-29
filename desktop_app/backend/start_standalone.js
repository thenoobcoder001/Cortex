const os = require("node:os");
const { startBackendServer, relayConnect } = require("./server");
const { AppConfigStore } = require("./configStore");

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

function getTailscaleUrl(port) {
  for (const addrs of Object.values(os.networkInterfaces() || {})) {
    for (const addr of addrs || []) {
      if (!addr.internal && addr.family === "IPv4" && addr.address.startsWith("100.")) {
        return `http://${addr.address}:${port}`;
      }
    }
  }
  return "";
}

async function main() {
  const port = 8765;
  const host = "0.0.0.0";
  console.log(`Starting standalone backend on http://${host}:${port}...`);

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
    const localUrl     = getLocalUrl(port);
    const tailscaleUrl = getTailscaleUrl(port);
    console.log("Cortex relay: connecting...");
    try {
      const result = await relayConnect({
        token:           config.cortexToken,
        deviceId:        config.cortexDeviceId      || undefined,
        reconnectSecret: config.cortexReconnectSecret || undefined,
        localUrl,
        tailscaleUrl,
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

main();
