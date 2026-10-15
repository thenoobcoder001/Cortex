import { Bug, Compass, FlaskConical, ListChecks } from "lucide-react";
import MarkdownMessage from "./MarkdownMessage.jsx";

const STARTERS = [
  {
    icon: Compass,
    title: "Explain this codebase",
    prompt: "Give me a short tour of this codebase: what it does, the main folders, and where to start reading.",
  },
  {
    icon: Bug,
    title: "Find likely bugs",
    prompt: "Look for likely bugs in the most recently changed files. List each one with the file, line and why it's a problem.",
  },
  {
    icon: FlaskConical,
    title: "Write missing tests",
    prompt: "Find an important function that has no tests and write tests for it.",
  },
  {
    icon: ListChecks,
    title: "Plan a feature",
    prompt: "Help me plan a new feature for this project. Ask me what it is first.",
  },
];

export default function ConversationSection({
  activePendingTurn,
  copyText,
  displayMessages,
  onPickStarter,
  projectName,
  scrollRef,
}) {
  return (
    <section className="conversation-scroll" ref={scrollRef}>
      {displayMessages.length === 0 ? (
        <div className="conversation-empty">
          <h2>{projectName ? `What should we work on in ${projectName}?` : "What should we work on?"}</h2>
          <p>Your coding agent works in this folder. Pick a starting point or describe what you need.</p>
          {onPickStarter && (
            <div className="starter-grid">
              {STARTERS.map(({ icon: Icon, title, prompt }) => (
                <button key={title} type="button" className="starter-card" onClick={() => onPickStarter(prompt)}>
                  <Icon size={18} className="starter-card-icon" aria-hidden="true" />
                  <span className="starter-card-title">{title}</span>
                  <span className="starter-card-prompt">{prompt}</span>
                </button>
              ))}
            </div>
          )}
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
      {activePendingTurn?.running && !activePendingTurn?.assistantText && (
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
