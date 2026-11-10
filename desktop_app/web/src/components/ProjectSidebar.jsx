import { AlertCircle, Check, ChevronRight, Folder, MoreHorizontal, Pencil, SquarePen, Trash2, X } from "lucide-react";
import { normalizeProject } from "../app/utils.js";

// Left sidebar listing saved projects and, for each expanded one, its chats (with inline rename and delete).
export default function ProjectSidebar({
  snapshot,
  activeRepoRoot,
  savedProjects,
  expandedRepos,
  toggleRepo,
  chatsForProject,
  runningChatIds,
  sendingChatIds,
  uiPrefs,
  renamingChat,
  renameChatDraft,
  setRenameChatDraft,
  setConfirmDeleteChat,
  handleOpenMenu,
  handleNewChat,
  handleActivateChat,
  handleStartRenameChat,
  handleSubmitRenameChat,
  handleCancelRenameChat,
  handleDeleteChat,
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-heading-row">
          <div className="sidebar-label">Projects</div>
        </div>

        <div className="project-list">
          {savedProjects.length === 0 && (
            <div className="rail-empty">Add a folder or project to start exploring files.</div>
          )}
          {savedProjects.map((project) => (
            <div key={project.path} className="project-group">
              <div
                className={
                  project.path === snapshot.config.repoRoot ? "project-item active" : "project-item"
                }
              >
                <button
                  type="button"
                  className="project-main"
                  onClick={() => toggleRepo(project.path)}
                  title={project.path}
                >
                  <span className="project-name">
                    <Folder size={15} className="project-folder-icon" aria-hidden="true" />
                    {project.name}
                    <ChevronRight
                      size={14}
                      className={expandedRepos.has(project.path) ? "project-disclosure expanded" : "project-disclosure"}
                      aria-hidden="true"
                    />
                  </span>
                </button>
                <div className="project-actions" onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="project-action-btn"
                    onClick={() => void handleNewChat(project.path)}
                    title="New chat in project"
                    aria-label="New chat in project"
                  >
                    <SquarePen size={15} />
                  </button>
                  <div className="project-menu-wrap">
                    <button
                      type="button"
                      className="project-menu-trigger"
                      onClick={(event) => handleOpenMenu(event, project.path)}
                      title="Project options"
                      aria-label="Project options"
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                </div>
              </div>

              {expandedRepos.has(project.path) && (
                <div className="project-detail-list">
                  {chatsForProject(project.path).length === 0 && <div className="rail-empty">No chats yet.</div>}
                  {chatsForProject(project.path).map((chat) => {
                    const showChatLoading =
                      runningChatIds.includes(chat.chatId) || sendingChatIds.includes(chat.chatId);
                    const showInterrupted = Boolean(chat.interrupted) && !showChatLoading;
                    const normalizedProjectPath = normalizeProject(project.path);
                    const isRenaming =
                      renamingChat?.chatId === chat.chatId &&
                      renamingChat?.repoRoot === normalizedProjectPath;

                    return (
                      <div
                        key={`${normalizedProjectPath}:${chat.chatId}`}
                        className={
                          chat.chatId === snapshot.config.activeChatId &&
                          normalizedProjectPath === activeRepoRoot
                            ? "chat-sidebar-row active"
                            : "chat-sidebar-row"
                        }
                        onClick={() => {
                          if (!isRenaming) {
                            handleActivateChat(chat.chatId, project.path);
                          }
                        }}
                      >
                        {isRenaming ? (
                          <input
                            className="chat-rename-input"
                            value={renameChatDraft}
                            autoFocus
                            ref={(input) => {
                              if (input) {
                                window.requestAnimationFrame(() => {
                                  input.focus();
                                  const end = input.value.length;
                                  input.setSelectionRange(end, end);
                                });
                              }
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => setRenameChatDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void handleSubmitRenameChat(chat, project.path);
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                handleCancelRenameChat();
                              }
                            }}
                            onBlur={() => void handleSubmitRenameChat(chat, project.path)}
                          />
                        ) : (
                          <>
                            <button type="button" className="chat-sidebar-item" title={chat.title}>
                              <span className="chat-dot"></span>
                              <span className="chat-truncate">{chat.title || "Untitled chat"}</span>
                            </button>
                            {showChatLoading && <span className="chat-loading-spinner" aria-hidden="true"></span>}
                            {showInterrupted && (
                              <span
                                className="chat-recovery-indicator"
                                title="Previous response was interrupted and can be resumed from this chat."
                                aria-hidden="true"
                              >
                                <AlertCircle size={14} />
                              </span>
                            )}
                          </>
                        )}
                        {isRenaming ? (
                          <>
                            <button
                              type="button"
                              className="chat-rename-confirm-btn"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => { e.stopPropagation(); void handleSubmitRenameChat(chat, project.path); }}
                              title="Confirm rename"
                              aria-label="Confirm rename"
                            >
                              <Check size={14} />
                            </button>
                            <button
                              type="button"
                              className="chat-rename-cancel-btn"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => { e.stopPropagation(); handleCancelRenameChat(); }}
                              title="Cancel rename"
                              aria-label="Cancel rename"
                            >
                              <X size={14} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="chat-rename-btn"
                              onClick={(event) => handleStartRenameChat(event, chat, project.path)}
                              title="Rename chat"
                              aria-label="Rename chat"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              className="chat-delete-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (uiPrefs.confirmChatDelete) {
                                  setConfirmDeleteChat({ chatId: chat.chatId, repoRoot: project.path });
                                } else {
                                  void handleDeleteChat(e, chat.chatId, project.path);
                                }
                              }}
                              title="Delete chat"
                              aria-label="Delete chat"
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
