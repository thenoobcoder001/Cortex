"use strict";

const { spawn } = require("node:child_process");
const platform = require("../platform");
const { resolveAndroidEnv } = require("../androidEnv");

async function handle(ctx) {
  const { method, pathname, url, body, reply, isLocal } = ctx;

  if (!pathname.startsWith("/api/android")) return false;

  // Android management is desktop-only
  if (!isLocal) {
    reply(403, { detail: "Android management is not available over the network." });
    return true;
  }

  if (method === "GET" && pathname === "/api/android/avds") {
    const { exec } = require("node:child_process");
    exec("emulator -list-avds", { 
      encoding: "utf8", 
      timeout: 8000,
      env: resolveAndroidEnv(process.env)
    }, (error, stdout) => {
      const avds = (stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      reply(200, { avds });
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/android/launch") {
    const { avd } = body;
    if (!avd) {
      reply(400, { detail: "AVD name is required." });
      return true;
    }

    // Launch emulator detached so it survives backend restarts
    const env = resolveAndroidEnv(process.env);
    const child = spawn("emulator", ["-avd", avd], {
      detached: true,
      stdio: "ignore",
      env
    });
    child.unref();

    reply(200, { ok: true, message: `Launching emulator ${avd}...` });
    return true;
  }

  return false;
}

module.exports = { handle };
