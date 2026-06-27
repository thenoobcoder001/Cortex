import { useState } from "react";

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value)} B`;
}

function shortModel(model) {
  const text = String(model || "");
  if (!text) return "Agent";
  const parts = text.split(":").filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)}` : text;
}

export default function ResourceDashboard({ resources, chats = [] }) {
  const [expanded, setExpanded] = useState(false);

  if (!resources) return null;

  const activeCount = Number(resources.agents?.activeCount || 0);
  const memoryPercent = Number(resources.system?.memoryPercent || 0);
  const level = resources.level || "ok";
  const agentItems = Array.isArray(resources.agents?.items) ? resources.agents.items : [];
  const titleByChat = new Map(chats.map((chat) => [chat.chatId, chat.title || "Untitled chat"]));
  const warningText = Array.isArray(resources.warnings) && resources.warnings.length
    ? resources.warnings.join(" ")
    : "Resource usage is within the expected range.";

  return (
    <section className={`resource-dashboard ${level} ${expanded ? "expanded" : "collapsed"}`}>
      <button
        type="button"
        className="resource-dashboard-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse resources panel" : "Expand resources panel"}
      >
        <span className="resource-kicker">Resources</span>
        <strong>{activeCount} active {activeCount === 1 ? "agent" : "agents"}</strong>
        <span className="resource-dashboard-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div className="resource-dashboard-body">
          <div className="resource-dashboard-main">
            <div className="resource-meter" aria-label={`System memory ${memoryPercent}%`}>
              <span style={{ width: `${Math.min(100, Math.max(0, memoryPercent))}%` }}></span>
            </div>
            <div className="resource-warning">{warningText}</div>
          </div>

          <div className="resource-stats">
            <div>
              <span>System</span>
              <strong>{memoryPercent.toFixed(1)}%</strong>
            </div>
            <div>
              <span>Agents</span>
              <strong>{formatBytes(resources.agents?.memoryBytes)}</strong>
            </div>
            <div>
              <span>Cortex</span>
              <strong>{formatBytes(resources.app?.memoryBytes)}</strong>
            </div>
          </div>

          {agentItems.length > 0 && (
            <div className="resource-agent-list">
              {agentItems.slice(0, 5).map((agent) => (
                <div className="resource-agent-row" key={agent.chatId}>
                  <span>{titleByChat.get(agent.chatId) || shortModel(agent.model)}</span>
                  <strong>{formatBytes(agent.memoryBytes)}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
