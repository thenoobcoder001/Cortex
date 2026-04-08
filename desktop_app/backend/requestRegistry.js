class RequestRegistry {
  constructor() {
    this.requests = new Map();
  }

  start(chatId, metadata = {}) {
    if (this.requests.has(chatId)) {
      throw new Error("This chat is already running a request.");
    }
    const controller = new AbortController();
    const entry = { ...metadata, controller };
    this.requests.set(chatId, entry);
    return entry;
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
}

module.exports = {
  RequestRegistry,
};
