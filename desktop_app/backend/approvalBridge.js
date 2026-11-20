"use strict";

// Backend side of the Claude approval bridge (see approvalMcpServer.js):
// the per-turn MCP config that starts the bridge, and turning a Claude tool
// use into what the approval card shows.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildUnifiedDiff } = require("./fileService");

// In a packaged build the backend sits inside app.asar; the bridge script is
// unpacked next to it (build.asarUnpack) so a plain Node process can run it.
function resolveServerScript() {
  const script = path.join(__dirname, "approvalMcpServer.js");
  const marker = `app.asar${path.sep}`;
  if (script.includes(marker)) {
    const unpacked = script.replace(marker, `app.asar.unpacked${path.sep}`);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return script;
}

const MCP_SERVER_SCRIPT = resolveServerScript();

function claudeToolSummary(toolName, input) {
  const name = String(toolName || "");
  const args = input && typeof input === "object" ? input : {};
  if (name === "Bash" || name === "PowerShell") {
    return {
      kind: "command",
      toolName: name,
      command: String(args.command || ""),
      reason: String(args.description || ""),
    };
  }
  if (name === "Write") {
    const filePath = String(args.file_path || "");
    return { kind: "file_change", toolName: name, path: filePath, diff: buildUnifiedDiff(filePath, "", String(args.content || "")) };
  }
  if (name === "Edit") {
    const filePath = String(args.file_path || "");
    return { kind: "file_change", toolName: name, path: filePath, diff: buildUnifiedDiff(filePath, String(args.old_string || ""), String(args.new_string || "")) };
  }
  if (name === "MultiEdit") {
    const filePath = String(args.file_path || "");
    const edits = Array.isArray(args.edits) ? args.edits : [];
    const diff = edits
      .map((edit) => buildUnifiedDiff(filePath, String(edit?.old_string || ""), String(edit?.new_string || "")))
      .join("\n");
    return { kind: "file_change", toolName: name, path: filePath, diff };
  }
  if (name === "NotebookEdit") {
    return { kind: "file_change", toolName: name, path: String(args.notebook_path || ""), diff: String(args.new_source || "") };
  }
  let detail = "";
  try {
    detail = JSON.stringify(args).slice(0, 2000);
  } catch {
    detail = "";
  }
  return { kind: "tool", toolName: name, reason: detail };
}

// The node binary that runs the bridge. Inside Electron, process.execPath is
// the Electron binary, which acts as plain Node with ELECTRON_RUN_AS_NODE=1.
function bridgeCommand() {
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

// Writes a one-turn --mcp-config file. Returns { configPath, cleanup }.
function writeClaudeMcpConfig({ url, token }) {
  const { command, env } = bridgeCommand();
  const config = {
    mcpServers: {
      cortex_approvals: {
        type: "stdio",
        command,
        args: [MCP_SERVER_SCRIPT],
        env: { ...env, CORTEX_APPROVAL_URL: url, CORTEX_APPROVAL_TOKEN: token },
      },
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-approvals-"));
  const configPath = path.join(dir, `mcp-${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
  return {
    configPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp file only holds a token that is already revoked.
      }
    },
  };
}

module.exports = {
  MCP_SERVER_SCRIPT,
  claudeToolSummary,
  writeClaudeMcpConfig,
};
