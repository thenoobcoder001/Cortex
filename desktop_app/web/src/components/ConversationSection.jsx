import MarkdownMessage from "./MarkdownMessage.jsx";

export default function ConversationSection({
  activePendingTurn,
  copyText,
  displayMessages,
  scrollRef,
}) {
  return (
    <section className="conversation-scroll" ref={scrollRef}>
      {displayMessages.length === 0 ? (
        <div className="conversation-empty">
          <h2>Start a conversation</h2>
          <p>Ask about the current repo, request changes, or inspect the codebase.</p>
        </div>
      ) : (
        displayMessages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={`message-row ${message.role}${message.pending ? " pending" : ""}`}
          >
            <div className="message-bubble">
              {message.role === "assistant" && (
                <div className="message-actions">
                  <button
                    type="button"
                    className="message-copy-btn"
                    onClick={() => void copyText(String(message.content || ""), "Response copied")}
                  >
                    Copy
                  </button>
                </div>
              )}
              <div className="message-content">
                {message.role === "assistant" ? (
                  <MarkdownMessage content={message.content} />
                ) : (
                  <pre>{String(message.content || "")}</pre>
                )}
              </div>
            </div>
          </div>
        ))
      )}
      {activePendingTurn?.running && (
        <div className="message-row assistant">
          <div className="thinking-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      )}
    </section>
  );
}
