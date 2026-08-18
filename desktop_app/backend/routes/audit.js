"use strict";

async function handle(ctx) {
  const { method, pathname, url, reply, replyText, service, assertRepoRoot } = ctx;

  if (method === "GET" && pathname === "/api/audit/export") {
    const repoRoot = url.searchParams.get("repoRoot") || null;
    assertRepoRoot(repoRoot, service);
    replyText(200, service.exportAuditEntries(repoRoot), {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": 'attachment; filename="cortex-audit.jsonl"',
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/audit") {
    const repoRoot = url.searchParams.get("repoRoot") || null;
    assertRepoRoot(repoRoot, service);
    reply(200, service.listAuditEntries(repoRoot, {
      limit: url.searchParams.get("limit") || 200,
      action: url.searchParams.get("action") || "",
      provider: url.searchParams.get("provider") || "",
    }));
    return true;
  }

  return false;
}

module.exports = { handle };
