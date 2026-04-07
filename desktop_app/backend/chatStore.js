const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function cleanUserText(text) {
  return String(text || "").replace(/^\[Mode:[^\]]+\][^\n]*\n\n/, "").trim();
}

class ProjectChatStore {
  constructor(repoRoot) {
    this.setRepoRoot(repoRoot);
  }

  setRepoRoot(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
  }

  get storeDir() {
    return path.join(this.repoRoot, ".gpt-tui", "chats");
  }

  get indexFile() {
    return path.join(this.storeDir, "index.json");
  }

  chatFile(chatId) {
    return path.join(this.storeDir, `${chatId}.json`);
  }

  ensureDir() {
    fs.mkdirSync(this.storeDir, { recursive: true });
  }

  loadIndex() {
    try {
      if (!fs.existsSync(this.indexFile)) {
        return [];
      }
      const raw = JSON.parse(fs.readFileSync(this.indexFile, "utf8"));
      return Array.isArray(raw) ? raw.filter((item) => item && item.chat_id) : [];
    } catch {
      return [];
    }
  }

  saveIndex(items) {
    this.ensureDir();
    fs.writeFileSync(this.indexFile, JSON.stringify(items, null, 2), "utf8");
  }

  titleFromMessages(messages) {
    for (const message of messages || []) {
      if (String(message.role || "") !== "user") {
        continue;
      }
      const cleaned = cleanUserText(message.content);
      if (!cleaned) {
        continue;
      }
      const first = cleaned.split(/\r?\n/, 1)[0].trim();
      return first.length > 64 ? `${first.slice(0, 64).trimEnd()}...` : first;
    }
    return "New chat";
  }

  listChats() {
    const items = this.loadIndex().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return items.map((item) => ({
      chatId: String(item.chat_id || ""),
      title: String(item.title || "New chat"),
      updatedAt: String(item.updated_at || ""),
      createdAt: String(item.created_at || ""),
      model: String(item.model || ""),
      changeCount: Number(item.change_count || 0),
      toolSafetyMode: String(item.tool_safety_mode || "write"),
    }));
  }

  loadChat(chatId) {
    if (!chatId) {
      return null;
    }
    try {
      const fullPath = this.chatFile(chatId);
      if (!fs.existsSync(fullPath)) {
        return null;
      }
      const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      return raw && typeof raw === "object" ? raw : null;
    } catch {
      return null;
    }
  }

  createChat(messages, { model, providerState = null, changes = [], toolSafetyMode = "write" } = {}) {
    const chatId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${crypto.randomBytes(3).toString("hex")}`;
    this.saveChat(chatId, messages, { model, providerState, changes, toolSafetyMode });
    return chatId;
  }

  saveChat(chatId, messages, { model, providerState = null, changes = [], toolSafetyMode = "write" } = {}) {
    if (!chatId) {
      return;
    }
    this.ensureDir();
    const timestamp = nowIso();
    const title = this.titleFromMessages(messages);
    const payload = {
      chat_id: chatId,
      title,
      updated_at: timestamp,
      model,
      messages,
      changes,
      tool_safety_mode: toolSafetyMode || "write",
    };
    if (providerState && Object.keys(providerState).length > 0) {
      payload.provider_state = providerState;
    }
    fs.writeFileSync(this.chatFile(chatId), JSON.stringify(payload, null, 2), "utf8");

    const items = this.loadIndex();
    const existing = items.find((item) => String(item.chat_id || "") === chatId);
    if (existing) {
      existing.title = title;
      existing.updated_at = timestamp;
      existing.model = model;
      existing.change_count = Array.isArray(changes) ? changes.length : 0;
      existing.tool_safety_mode = toolSafetyMode || "write";
      if (!existing.created_at) {
        existing.created_at = timestamp;
      }
    } else {
      items.push({
        chat_id: chatId,
        title,
        created_at: timestamp,
        updated_at: timestamp,
        model,
        change_count: Array.isArray(changes) ? changes.length : 0,
        tool_safety_mode: toolSafetyMode || "write",
      });
    }
    this.saveIndex(items);
  }

  deleteChat(chatId) {
    if (!chatId) {
      return false;
    }
    try {
      const fullPath = this.chatFile(chatId);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch {
      return false;
    }
    const items = this.loadIndex();
    const nextItems = items.filter((item) => String(item.chat_id || "") !== chatId);
    this.saveIndex(nextItems);
    return true;
  }
}

module.exports = {
  ProjectChatStore,
};
