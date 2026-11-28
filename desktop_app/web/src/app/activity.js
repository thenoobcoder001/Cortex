// The agent's step log for one turn (commands, reads, edits...), as the chat
// shows it. Plain JS (no JSX) so the backend test runner can import it.
//
// A step: { id, kind, label, status, exitCode?, durationMs?, auditSeq?, startedAt? }
// status: "running" | "done" | "failed" | "declined" | "unknown"

// Applies one streamed tool_call / tool_result event to the step list.
// Returns the same array when nothing changed.
export function applyActivityEvent(steps, event, now = Date.now()) {
  const list = Array.isArray(steps) ? steps : [];
  if (!event || !event.id) return list;
  const id = String(event.id);
  if (event.type === "tool_call") {
    // Steps need a label; older backends sent tool events without one.
    if (!event.label) return list;
    if (list.some((step) => step.id === id)) return list;
    return [...list, { id, kind: event.kind || "tool", label: String(event.label), status: "running", startedAt: now }];
  }
  if (event.type === "tool_result") {
    let found = false;
    const next = list.map((step) => {
      if (step.id !== id) return step;
      found = true;
      const status = event.status === "declined"
        ? "declined"
        : event.status === "failed" || event.ok === false ? "failed" : "done";
      return {
        ...step,
        status,
        exitCode: Number.isInteger(event.exitCode) ? event.exitCode : step.exitCode,
        durationMs: Number.isFinite(event.durationMs) ? event.durationMs : now - (step.startedAt || now),
        auditSeq: Number.isInteger(event.auditSeq) ? event.auditSeq : step.auditSeq,
      };
    });
    return found ? next : list;
  }
  return list;
}

const PHRASES = {
  command: (n) => `ran ${n} ${n === 1 ? "command" : "commands"}`,
  read: (n) => `read ${n} ${n === 1 ? "file" : "files"}`,
  list: (n) => `listed ${n} ${n === 1 ? "folder" : "folders"}`,
  search: (n) => `searched ${n === 1 ? "once" : `${n} times`}`,
  edit: (n) => `made ${n} ${n === 1 ? "edit" : "edits"}`,
  web: (n) => `${n} web ${n === 1 ? "lookup" : "lookups"}`,
  tool: (n) => `used ${n} ${n === 1 ? "tool" : "tools"}`,
  agent: (n) => `started ${n} ${n === 1 ? "sub-agent" : "sub-agents"}`,
  plan: () => "updated the plan",
};
const ORDER = ["edit", "command", "read", "search", "list", "web", "tool", "agent", "plan"];

// "made 1 edit, ran 2 commands, read 3 files · 1 failed"
export function summarizeActivity(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const counts = new Map();
  for (const step of list) counts.set(step.kind, (counts.get(step.kind) || 0) + 1);
  const parts = ORDER.filter((kind) => counts.get(kind)).map((kind) => PHRASES[kind](counts.get(kind)));
  const failed = list.filter((step) => step.status === "failed").length;
  const declined = list.filter((step) => step.status === "declined").length;
  const problems = [failed && `${failed} failed`, declined && `${declined} declined`].filter(Boolean);
  const text = parts.join(", ");
  return problems.length ? `${text} · ${problems.join(", ")}` : text;
}

// 800 -> "0.8s", 12000 -> "12s", 73000 -> "1m 13s", 3600000 -> "1h 0m"
export function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${(value / 1000).toFixed(1)}s`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// The step to show on the live line: the newest still running, else the newest.
export function currentStep(steps) {
  const list = Array.isArray(steps) ? steps : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index].status === "running") return list[index];
  }
  return list.at(-1) || null;
}
