"use strict";

// PreToolUse hook that Antigravity CLI (agy) runs before every tool call in
// a Cortex turn that asks for approval (Supervised / Auto-accept edits).
// agy writes { toolCall: { name, args }, ... } to stdin and reads
// { decision: "allow" | "deny", reason } from stdout. This forwards the call
// to the Cortex backend and waits until the user approves or declines there.
//
// Started from the per-turn wrapper written by approvalBridge.js with:
//   CORTEX_APPROVAL_URL    http://127.0.0.1:<port>/api/approvals/bridge
//   CORTEX_APPROVAL_TOKEN  per-turn secret tying requests to one chat
//
// Fails closed: if Cortex can't be reached the tool is denied. (agy also
// denies the tool when this script crashes or outlives the hook timeout.)
// Plain Node, no dependencies.

const http = require("node:http");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function askCortex(toolName, input) {
  const url = new URL(process.env.CORTEX_APPROVAL_URL || "");
  const payload = JSON.stringify({ token: process.env.CORTEX_APPROVAL_TOKEN || "", toolName, input });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        try {
          const body = JSON.parse(data);
          if (response.statusCode !== 200) {
            reject(new Error(body?.detail || `Cortex answered ${response.statusCode}`));
            return;
          }
          resolve(body);
        } catch (error) {
          reject(error);
        }
      });
    });
    // No timeout here on purpose: Cortex owns the approval timeout.
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

// Returns the JSON object agy expects on stdout.
async function decide(rawInput) {
  let toolCall = {};
  try {
    toolCall = JSON.parse(rawInput || "{}")?.toolCall || {};
  } catch {
    return { decision: "deny", reason: "Cortex could not read the tool call." };
  }
  const toolName = String(toolCall.name || "");
  const input = toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};
  try {
    const answer = await askCortex(toolName, input);
    if (answer.decision === "approve") {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      reason: `The user declined this action in Cortex (${answer.by || "declined"}). Do not retry it; continue without it or ask the user.`,
    };
  } catch (error) {
    return { decision: "deny", reason: `Cortex could not ask for approval: ${String(error?.message || error)}` };
  }
}

if (require.main === module) {
  readStdin()
    .then(decide)
    .then((result) => {
      process.stdout.write(JSON.stringify(result));
    });
}

module.exports = { decide };
