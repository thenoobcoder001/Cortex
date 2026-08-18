const test = require("node:test");
const assert = require("node:assert/strict");
const { TerminalService } = require("./terminalService");

function runningSession(overrides = {}) {
  return {
    chatId: "chat-1",
    cwd: process.cwd(),
    child: { pid: 123, stdin: { write() {} } },
    isPty: false,
    status: "running",
    history: "",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exitCode: null,
    ...overrides,
  };
}

test("write() audits commands submitted through the built-in terminal", () => {
  const terminal = new TerminalService();
  const events = [];
  terminal.onAudit = (entry) => events.push(entry);
  terminal.sessions.set("chat-1", runningSession());

  terminal.write({ chatId: "chat-1", command: "npm test" });

  assert.deepEqual(events, [{
    source: "terminal",
    action: "run_command",
    command: "npm test",
    chatId: "chat-1",
    success: true,
    detail: "submitted to interactive terminal",
  }]);
});

test("write() records a failed audit event when terminal input throws", () => {
  const terminal = new TerminalService();
  const events = [];
  terminal.onAudit = (entry) => events.push(entry);
  terminal.sessions.set("chat-1", runningSession({
    child: { pid: 123, stdin: { write() { throw new Error("pipe closed"); } } },
  }));

  terminal.write({ chatId: "chat-1", command: "npm test" });

  assert.equal(events.length, 1);
  assert.equal(events[0].success, false);
  assert.equal(events[0].detail, "pipe closed");
});
