"use strict";

const { claudeToolSummary } = require("../approvalBridge");

// Approval requests raised by running agents.
//
//   GET  /api/approvals?chatId=     pending requests (all chats if no chatId)
//   POST /api/approvals/respond     { approvalId, decision: "approve"|"decline", alwaysAllow?, chatId? }
//   POST /api/approvals/bridge      local only: the Claude approval MCP server
//                                   or the Antigravity approval hook asking on
//                                   behalf of a running turn; the response is
//                                   held until the user decides.
//
// /respond is an ordinary authenticated route, so the phone reaches it through
// the relay like any other request; the decision is audited with where it came from.

function requesterLabel(ctx) {
  const relayDevice = String(ctx.request?.headers?.["x-pocketai-relay-device"] || "").trim();
  if (relayDevice) return `relay:${relayDevice}`;
  if (ctx.isLocal) return "desktop";
  const remote = String(ctx.request?.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return `network:${remote || "unknown"}`;
}

async function handle(ctx) {
  const { method, pathname, url, body, reply, service } = ctx;
  if (!pathname.startsWith("/api/approvals")) return false;

  if (method === "GET" && pathname === "/api/approvals") {
    reply(200, service.listApprovals(url.searchParams.get("chatId") || null));
    return true;
  }

  if (method === "POST" && pathname === "/api/approvals/respond") {
    reply(200, service.respondToApproval({
      approvalId: body.approvalId,
      decision: body.decision,
      alwaysAllow: Boolean(body.alwaysAllow),
      chatId: body.chatId || null,
      by: requesterLabel(ctx),
    }));
    return true;
  }

  if (method === "POST" && pathname === "/api/approvals/bridge") {
    // Only the bridge Cortex itself started for a running turn (Claude's MCP
    // server, Antigravity's hook) may ask: loopback, no relay header, and the
    // per-turn token.
    const bridge = ctx.isLocal ? service.approvalBridges.get(String(body.token || "")) : null;
    if (!bridge) {
      reply(403, { detail: "Unknown approval bridge." });
      return true;
    }
    const answer = typeof bridge.handle === "function"
      ? await bridge.handle(body.toolName, body.input)
      : await bridge.ask(claudeToolSummary(body.toolName, body.input));
    reply(200, { decision: answer.decision, by: answer.by, ...(answer.message ? { message: answer.message } : {}) });
    return true;
  }

  return false;
}

module.exports = { handle, requesterLabel };
