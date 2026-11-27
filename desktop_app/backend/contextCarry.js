"use strict";

// What earlier conversation a provider sees when it starts without its own
// session (a switch to another provider, or a CLI session that was reset).
//
// - carryContext: the most recent messages within a character budget, never
//   fewer than the "Cross-model context carry" setting, plus the chat's first
//   request when it fell outside the budget (it usually says what the whole
//   chat is about).
// - labelReplies: earlier assistant replies written by a different model are
//   marked "[Earlier reply from <model>]" so the new model doesn't take them
//   for its own.

const DEFAULT_CARRY_CHARS = 24000;
const FIRST_MESSAGE_MAX_CHARS = 4000;

function contentLength(message) {
  return String(message?.content || "").length;
}

function conversation(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => ["user", "assistant"].includes(String(message?.role || "")));
}

// minMessages: the setting (0 carries nothing). charBudget: total characters
// to fill beyond that minimum.
function carryContext(messages, { minMessages = 5, charBudget = DEFAULT_CARRY_CHARS } = {}) {
  const turns = conversation(messages);
  const minimum = Math.max(0, Math.trunc(Number(minMessages) || 0));
  if (!minimum || !turns.length) return [];
  let start = turns.length;
  let used = 0;
  while (start > 0) {
    const next = turns[start - 1];
    const size = contentLength(next);
    const withinMinimum = turns.length - start < minimum;
    if (!withinMinimum && used + size > charBudget) break;
    used += size;
    start -= 1;
  }
  const kept = turns.slice(start);
  const firstUserIndex = turns.findIndex((message) => message.role === "user");
  if (firstUserIndex >= 0 && firstUserIndex < start) {
    const first = turns[firstUserIndex];
    const text = String(first.content || "");
    const clipped = text.length > FIRST_MESSAGE_MAX_CHARS ? `${text.slice(0, FIRST_MESSAGE_MAX_CHARS)}\n... (truncated)` : text;
    const skipped = start - firstUserIndex - 1;
    const note = skipped > 0 ? `[First message in this chat; ${skipped} later message${skipped === 1 ? "" : "s"} left out]` : "[First message in this chat]";
    return [{ ...first, content: `${note}\n${clipped}` }, ...kept];
  }
  return kept;
}

// currentModel: the model about to answer. fallbackModel: who wrote replies
// that predate per-message models ("" leaves those unlabelled).
function labelReplies(messages, { currentModel = "", fallbackModel = "" } = {}) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (String(message?.role || "") !== "assistant") return message;
    const author = String(message.model || fallbackModel || "");
    if (!author || author === currentModel) return message;
    return { ...message, content: `[Earlier reply from ${author}]\n${String(message.content || "")}` };
  });
}

module.exports = {
  DEFAULT_CARRY_CHARS,
  FIRST_MESSAGE_MAX_CHARS,
  carryContext,
  labelReplies,
};
