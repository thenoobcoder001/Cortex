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

module.exports = {
  nowIso,
  normalizeMessages,
  normalizeChanges,
};
