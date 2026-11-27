const test = require("node:test");
const assert = require("node:assert/strict");
const { CodexAgentText } = require("../providers");

test("codex: messages in one turn are kept apart by a paragraph break", () => {
  const reply = new CodexAgentText();
  const streamed = [reply.add("m1", "Running the tests"), reply.add("m1", "."), reply.add("m2", "All pass.")];
  assert.equal(reply.text, "Running the tests.\n\nAll pass.");
  assert.deepEqual(streamed, ["Running the tests", ".", "\n\nAll pass."]);
  // Completion of a streamed item adds nothing.
  assert.equal(reply.complete("m2", "All pass."), "");
  // An item that never streamed is appended, separated.
  assert.equal(reply.complete("m3", "Done."), "\n\nDone.");
  assert.equal(reply.text, "Running the tests.\n\nAll pass.\n\nDone.");
});

test("codex: no double break when a message already ends with a newline", () => {
  const reply = new CodexAgentText();
  reply.add("a", "First\n");
  reply.add("b", "Second");
  assert.equal(reply.text, "First\n\nSecond");
});

test("codex: older servers without item ids keep the old behaviour", () => {
  const reply = new CodexAgentText();
  reply.add("", "Hello ");
  reply.add("", "world");
  assert.equal(reply.complete("x", "Hello world"), "");
  assert.equal(reply.text, "Hello world");
  const onlyFinal = new CodexAgentText();
  assert.equal(onlyFinal.complete("", "Just the end"), "Just the end");
  assert.equal(onlyFinal.text, "Just the end");
});
