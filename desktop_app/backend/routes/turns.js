"use strict";

const { RevertConflictError } = require("../turnChanges");

// Per-turn diffs and revert. Diffs load here on demand, never via /api/status.
async function handle(ctx) {
  const { method, pathname, url, body, reply, service, assertRepoRoot, isLocal } = ctx;

  if (method === "GET" && pathname === "/api/turns/diff") {
    const repoRoot = url.searchParams.get("repoRoot") || null;
    assertRepoRoot(repoRoot, service);
    reply(200, service.getTurnDiff({
      chatId: url.searchParams.get("chatId") || "",
      turnId: url.searchParams.get("turnId") || "",
      repoRoot,
    }));
    return true;
  }

  if (method === "POST" && pathname === "/api/turns/revert") {
    assertRepoRoot(body.repoRoot || null, service);
    try {
      reply(200, service.revertTurn({
        chatId: body.chatId || "",
        turnId: body.turnId || "",
        repoRoot: body.repoRoot || null,
        path: body.path || null,
      }, { lite: !isLocal }));
    } catch (error) {
      if (!(error instanceof RevertConflictError)) throw error;
      // A refusal is an expected answer, not a server fault: phones get the
      // reason too (generic 400s hide the message from remote callers).
      reply(409, { detail: error.message, conflicts: error.conflicts });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
