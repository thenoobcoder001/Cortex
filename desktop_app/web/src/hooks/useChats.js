import { useState } from "react";
import { normalizeProject } from "../app/utils.js";

// Create / switch / rename / delete chats, including the inline rename and
// delete-confirmation state used by the sidebar.
export default function useChats({
  snapshot,
  setSnapshot,
  setRepoDraft,
  setError,
  postJson,
  activeRepoRoot,
  syncSavedProjects,
  fetchProjectChats,
  setProjectChats,
  setPendingTurns,
  setSendingChatIds,
  closeAllMenus,
}) {
  const [renamingChat, setRenamingChat] = useState(null);
  const [renameChatDraft, setRenameChatDraft] = useState("");
  const [confirmDeleteChat, setConfirmDeleteChat] = useState(null); // { chatId, repoRoot }

  const handleNewChat = async (repoRoot = snapshot?.config?.repoRoot || "") => {
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/new", { repoRoot });
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
      syncSavedProjects(nextSnapshot.config.repoRoot);
      void fetchProjectChats(nextSnapshot.config.repoRoot).catch(() => {});
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleActivateChat = async (chatId, repoRoot = snapshot?.config?.repoRoot || "") => {
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/activate", { chatId, repoRoot });
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
      syncSavedProjects(nextSnapshot.config.repoRoot);
      void fetchProjectChats(nextSnapshot.config.repoRoot).catch(() => {});
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleDeleteChat = async (event, chatId, repoRoot = snapshot?.config?.repoRoot || "") => {
    event.stopPropagation();
    setConfirmDeleteChat(null);
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/delete", { chatId, repoRoot });
      setSnapshot(nextSnapshot);
      setPendingTurns((current) => {
        const next = { ...current };
        delete next[chatId];
        return next;
      });
      setSendingChatIds((current) => current.filter((id) => id !== chatId));
      const normalizedRepoRoot = normalizeProject(repoRoot);
      if (normalizedRepoRoot && normalizedRepoRoot !== activeRepoRoot) {
        setProjectChats((current) => ({
          ...current,
          [normalizedRepoRoot]: (current[normalizedRepoRoot] || []).filter(
            (chat) => chat.chatId !== chatId,
          ),
        }));
      } else {
        void fetchProjectChats(repoRoot).catch(() => {});
      }
      // stopPropagation prevents workspace-shell onClick from clearing open menus/dropdowns.
      // Explicitly close all of them so nothing can block the textarea after delete.
      closeAllMenus();
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleStartRenameChat = (event, chat, repoRoot = snapshot?.config?.repoRoot || "") => {
    event.stopPropagation();
    setRenamingChat({
      chatId: chat.chatId,
      repoRoot: normalizeProject(repoRoot),
    });
    setRenameChatDraft(chat?.title || "Untitled chat");
  };

  const handleCancelRenameChat = () => {
    setRenamingChat(null);
    setRenameChatDraft("");
  };

  const handleSubmitRenameChat = async (chat, repoRoot = snapshot?.config?.repoRoot || "") => {
    const currentTitle = chat?.title || "Untitled chat";
    const trimmedTitle = renameChatDraft.replace(/\s+/g, " ").trim();
    if (!trimmedTitle || trimmedTitle === currentTitle) {
      handleCancelRenameChat();
      return;
    }
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/rename", {
        chatId: chat.chatId,
        repoRoot,
        title: trimmedTitle,
      });
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);

      const normalizedRepoRoot = normalizeProject(repoRoot);
      if (normalizedRepoRoot && normalizedRepoRoot !== activeRepoRoot) {
        setProjectChats((current) => ({
          ...current,
          [normalizedRepoRoot]: (current[normalizedRepoRoot] || []).map((item) =>
            item.chatId === chat.chatId ? { ...item, title: trimmedTitle } : item,
          ),
        }));
      } else {
        void fetchProjectChats(repoRoot).catch(() => {});
      }
      handleCancelRenameChat();
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  return {
    confirmDeleteChat,
    handleActivateChat,
    handleCancelRenameChat,
    handleDeleteChat,
    handleNewChat,
    handleStartRenameChat,
    handleSubmitRenameChat,
    renameChatDraft,
    renamingChat,
    setConfirmDeleteChat,
    setRenameChatDraft,
  };
}
