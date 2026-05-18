"use strict";

// Runs as an Electron utilityProcess so the Node HTTP backend has its own
// event loop, completely separate from the Electron main-process message pump.
// This prevents the "Not Responding" label that appeared when sync I/O or
// active streaming starved the Win32 message pump in the main process.

const { startBackendServer, relayConnect, relayDisconnect, relayStatus, relayProbe } = require("../backend/server");

let _handle = null;

function reply(id, result) {
  process.send({ id, ok: true, result });
}

function replyError(id, message) {
  process.send({ id, ok: false, error: String(message) });
}

async function startServer(host, preferredPort) {
  if (_handle) {
    await _handle.close().catch(() => {});
    _handle = null;
  }
  // Try the preferred port first; fall back to OS-assigned if taken.
  try {
    _handle = await startBackendServer({ host, port: preferredPort });
  } catch {
    _handle = await startBackendServer({ host, port: 0 });
  }
  return _handle.url;
}

process.on("message", async (event) => {
  const { id, type, payload = {} } = event;
  try {
    switch (type) {
      case "start": {
        const url = await startServer(payload.host || "127.0.0.1", payload.port || 8765);
        reply(id, { url });
        break;
      }
      case "restart": {
        const url = await startServer(payload.host || "127.0.0.1", payload.port || 8765);
        reply(id, { url });
        break;
      }
      case "relay:connect": {
        const result = await relayConnect(payload);
        reply(id, result);
        break;
      }
      case "relay:disconnect": {
        relayDisconnect();
        reply(id, { ok: true });
        break;
      }
      case "relay:status": {
        reply(id, relayStatus());
        break;
      }
      case "relay:probe": {
        const result = await relayProbe();
        reply(id, result);
        break;
      }
      default:
        replyError(id, `Unknown message type: ${type}`);
    }
  } catch (err) {
    replyError(id, err?.message || String(err));
  }
});
