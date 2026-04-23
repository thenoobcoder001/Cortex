const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function cleanUserText(text) {
  return String(text || "").replace(/^\[Mode:[^\]]+\][^\n]*\n\n/, "").trim();
}

function normalizeCustomTitle(title) {
  const cleaned = String(title || "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  return cleaned.length > 80 ? cleaned.slice(0, 80).trimEnd() : cleaned;
}

class ProjectChatStore {
  constructor(repoRoot) {
    this.setRepoRoot(repoRoot);
  }

  setRepoRoot(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
  }

  get storeDir() {
    return path.join(this.repoRoot, ".cortex", "chats");
  }

  get indexFile() {
    return path.join(this.storeDir, "index.json");
  }

  get workspaceFile() {
    return path.join(this.storeDir, "workspace.json");
  }

  get plansDir() {
    return path.join(this.repoRoot, ".cortex", "plans");
  }

  chatFile(chatId) {
    return path.join(this.storeDir, `${chatId}.json`);
  }

  ensureDir() {
    fs.mkdirSync(this.storeDir, { recursive: true });
  }

  ensurePlansDir() {
    fs.mkdirSync(this.plansDir, { recursive: true });
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

  loadWorkspaceState() {
    try {
      if (!fs.existsSync(this.workspaceFile)) {
        return {};
      }
      const raw = JSON.parse(fs.readFileSync(this.workspaceFile, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  saveWorkspaceState(state) {
    this.ensureDir();
    fs.writeFileSync(this.workspaceFile, JSON.stringify(state || {}, null, 2), "utf8");
  }

  loadAcceptedRepoState() {
    const state = this.loadWorkspaceState();
    return state?.accepted_repo_state && typeof state.accepted_repo_state === "object"
      ? state.accepted_repo_state
      : null;
  }

  saveAcceptedRepoState(repoState) {
    const state = this.loadWorkspaceState();
    state.accepted_repo_state = repoState || {};
    state.updated_at = nowIso();
    this.saveWorkspaceState(state);
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

  savePlan(chatId, title, prompt, content) {
    this.ensurePlansDir();
    const slug = String(title || "plan")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "plan";
    const fileName = `${chatId}-${Date.now()}-${slug}.md`;
    const fullPath = path.join(this.plansDir, fileName);
    const markdown = [
      `# ${title || "Implementation Plan"}`,
      "",
      "## Request",
      "",
      String(prompt || "").trim(),
      "",
      "## Plan",
      "",
      String(content || "").trim(),
      "",
    ].join("\n");
    fs.writeFileSync(fullPath, markdown, "utf8");
    return {
      path: fullPath,
      content: markdown,
      createdAt: nowIso(),
      title: title || "Implementation Plan",
    };
  }

  saveChat(chatId, messages, { model, providerState = null, changes = [], toolSafetyMode = "write", plan = undefined, customTitle = undefined } = {}) {
    if (!chatId) {
      return;
    }
    this.ensureDir();
    const timestamp = nowIso();
    const existingPayload = this.loadChat(chatId);
    const existingCustomTitle = normalizeCustomTitle(existingPayload?.custom_title);
    const nextCustomTitle = customTitle === undefined ? existingCustomTitle : normalizeCustomTitle(customTitle);
    const title = nextCustomTitle || this.titleFromMessages(messages);
    const nextPlan = plan === undefined ? existingPayload?.plan : plan;
    const payload = {
      chat_id: chatId,
      title,
      updated_at: timestamp,
      model,
      messages,
      changes,
      tool_safety_mode: toolSafetyMode || "write",
    };
    if (nextCustomTitle) {
      payload.custom_title = nextCustomTitle;
    }
    if (nextPlan && typeof nextPlan === "object") {
      payload.plan = nextPlan;
    }
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
      existing.has_plan = Boolean(nextPlan?.path);
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
        has_plan: Boolean(nextPlan?.path),
      });
    }
    this.saveIndex(items);
  }

  renameChat(chatId, title) {
    if (!chatId) {
      return null;
    }
    const normalizedTitle = normalizeCustomTitle(title);
    if (!normalizedTitle) {
      throw new Error("Chat title is required.");
    }
    const payload = this.loadChat(chatId);
    if (!payload) {
      return null;
    }
    payload.title = normalizedTitle;
    payload.custom_title = normalizedTitle;
    fs.writeFileSync(this.chatFile(chatId), JSON.stringify(payload, null, 2), "utf8");

    const items = this.loadIndex();
    const existing = items.find((item) => String(item.chat_id || "") === chatId);
    if (existing) {
      existing.title = normalizedTitle;
    } else {
      items.push({
        chat_id: chatId,
        title: normalizedTitle,
        created_at: String(payload.created_at || payload.updated_at || nowIso()),
        updated_at: String(payload.updated_at || nowIso()),
        model: String(payload.model || ""),
        change_count: Array.isArray(payload.changes) ? payload.changes.length : 0,
        tool_safety_mode: String(payload.tool_safety_mode || "write"),
        has_plan: Boolean(payload.plan?.path),
      });
    }
    this.saveIndex(items);
    return normalizedTitle;
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
