// Confirmation dialog shown before deleting a chat.
export default function ConfirmDeleteChatDialog({
  confirmDeleteChat,
  setConfirmDeleteChat,
  handleDeleteChat,
}) {
  return (
    <div className="confirm-overlay" onClick={() => setConfirmDeleteChat(null)}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-badge">Danger</div>
        <div className="confirm-title">Delete this chat?</div>
        <div className="confirm-copy">This chat and all its messages will be permanently deleted. This cannot be undone.</div>
        <div className="confirm-actions">
          <button type="button" className="secondary-button" onClick={() => setConfirmDeleteChat(null)}>Cancel</button>
          <button
            type="button"
            className="danger-button"
            onClick={(e) => handleDeleteChat(e, confirmDeleteChat.chatId, confirmDeleteChat.repoRoot)}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
