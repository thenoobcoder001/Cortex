"use strict";

// A tiny MCP stdio server that Claude CLI uses as its --permission-prompt-tool.
// Claude calls the `approve` tool whenever a tool use needs permission; this
// forwards the request to the Cortex backend and blocks until the user
// approves or declines in Cortex (or the request times out there).
//
// Started by Claude CLI from a per-turn --mcp-config written by Cortex, with:
//   CORTEX_APPROVAL_URL    http://127.0.0.1:<port>/api/approvals/bridge
//   CORTEX_APPROVAL_TOKEN  per-turn secret tying requests to one chat
//
// Plain Node, no dependencies, newline-delimited JSON-RPC 2.0 on stdio.

const http = require("node:http");
const readline = require("node:readline");

const SERVER_NAME = "cortex_approvals";

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
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

async function callApprove(args) {
  const toolName = String(args?.tool_name || "");
  const input = args?.input && typeof args.input === "object" ? args.input : {};
  let result;
  try {
    const answer = await askCortex(toolName, input);
    result = answer.decision === "approve"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: `The user declined this action in Cortex (${answer.by || "declined"}). Do not retry it; continue without it or ask the user.` };
  } catch (error) {
    result = { behavior: "deny", message: `Cortex could not ask for approval: ${String(error?.message || error)}` };
  }
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return; // notification
  try {
    if (method === "initialize") {
      write({
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: "1.0.0" },
        },
      });
      return;
    }
    if (method === "ping") {
      write({ id, result: {} });
      return;
    }
    if (method === "tools/list") {
      write({
        id,
        result: {
          tools: [{
            name: "approve",
            description: "Asks the Cortex user to approve or decline a tool use.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                input: { type: "object" },
                tool_use_id: { type: "string" },
              },
              required: ["tool_name", "input"],
            },
          }],
        },
      });
      return;
    }
    if (method === "tools/call" && params?.name === "approve") {
      write({ id, result: await callApprove(params.arguments) });
      return;
    }
    write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    write({ id, error: { code: -32603, message: String(error?.message || error) } });
  }
}

if (require.main === module) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void handle(message);
  });
  lines.on("close", () => process.exit(0));
}

module.exports = { handle, callApprove };
