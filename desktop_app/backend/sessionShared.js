function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function normalizeMessages(messages) {
  return Array.isArray(messages)
    ? messages.filter((message) => message && message.role).map((message) => ({ ...message }))
    : [];
}

function normalizeChanges(changes) {
  return Array.isArray(changes)
    ? changes
        .filter((change) => change && change.action && change.path)
        .map((change) => ({
          action: String(change.action),
          path: String(change.path),
          oldPath: String(change.oldPath || ""),
          newPath: String(change.newPath || ""),
          diff: String(change.diff || ""),
        }))
    : [];
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== "object") {
    return null;
  }
  const path = String(plan.path || "").trim();
  const content = String(plan.content || "").trim();
  if (!path || !content) {
    return null;
  }
  return {
    path,
    content,
    createdAt: String(plan.createdAt || plan.created_at || ""),
    title: String(plan.title || ""),
  };
}

module.exports = {
  nowIso,
  normalizeMessages,
  normalizeChanges,
  normalizePlan,
};
