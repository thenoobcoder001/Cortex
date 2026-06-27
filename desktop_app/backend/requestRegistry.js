class RequestRegistry {
  constructor() {
    this.requests = new Map();
  }

  start(chatId, metadata = {}) {
    if (this.requests.has(chatId)) {
      throw new Error("This chat is already running a request.");
    }
    const controller = new AbortController();
    const entry = {
      ...metadata,
      chatId,
      startedAt: metadata.startedAt || new Date().toISOString(),
      pids: [],
      controller,
    };
    this.requests.set(chatId, entry);
    return entry;
  }

  attachProcess(chatId, pid) {
    const entry = this.requests.get(chatId);
    const normalizedPid = Math.trunc(Number(pid));
    if (!entry || !Number.isFinite(normalizedPid) || normalizedPid <= 0) {
      return false;
    }
    if (!entry.pids.includes(normalizedPid)) {
      entry.pids.push(normalizedPid);
    }
    return true;
  }

  finish(chatId) {
    this.requests.delete(chatId);
  }

  has(chatId) {
    return this.requests.has(chatId);
  }

  get(chatId) {
    return this.requests.get(chatId) || null;
  }

  interrupt(chatId) {
    const entry = this.requests.get(chatId);
    if (!entry) {
      return false;
    }
    entry.controller.abort();
    return true;
  }

  ids() {
    return [...this.requests.keys()].sort();
  }

  entries() {
    return [...this.requests.entries()]
      .map(([chatId, entry]) => ({
        chatId,
        repoRoot: entry.repoRoot || "",
        model: entry.model || "",
        startedAt: entry.startedAt || "",
        pids: Array.isArray(entry.pids) ? [...entry.pids] : [],
      }))
      .sort((a, b) => a.chatId.localeCompare(b.chatId));
  }
}

module.exports = {
  RequestRegistry,
};
