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

function ptySession(overrides = {}) {
  const resizes = [];
  return runningSession({
    isPty: true,
    child: { pid: 123, write() {}, resize(cols, rows) { resizes.push([cols, rows]); } },
    resizes,
    epoch: 7,
    total: 0,
    cols: 100,
    rows: 20,
    sizes: [{ at: 0, cols: 100, rows: 20 }],
    ...overrides,
  });
}

test("append() numbers output so clients can write each chunk once", () => {
  const terminal = new TerminalService();
  const session = ptySession();
  terminal.sessions.set("chat-1", session);
  const events = [];
  terminal.on("data:chat-1", (data, meta) => events.push([data, meta]));

  terminal.append(session, "abc");
  terminal.append(session, "de");

  assert.deepEqual(events, [["abc", { epoch: 7, end: 3 }], ["de", { epoch: 7, end: 5 }]]);
  const snap = terminal.snapshot("chat-1");
  assert.equal(snap.history, "abcde");
  assert.equal(snap.total, 5);
  assert.equal(snap.epoch, 7);
});

test("resize() skips same-size calls, which make ConPTY repaint the screen", () => {
  const terminal = new TerminalService();
  const session = ptySession({ total: 10 });
  terminal.sessions.set("chat-1", session);

  terminal.resize({ chatId: "chat-1", cols: 100, rows: 20 });
  assert.deepEqual(session.resizes, []);

  terminal.resize({ chatId: "chat-1", cols: 80, rows: 24 });
  terminal.resize({ chatId: "chat-1", cols: 80, rows: 24 });
  assert.deepEqual(session.resizes, [[80, 24]]);
  assert.deepEqual(terminal.snapshot("chat-1").sizes, [
    { at: 0, cols: 100, rows: 20 },
    { at: 10, cols: 80, rows: 24 },
  ]);
});

test("trimming history keeps the size in effect where it now starts", () => {
  const terminal = new TerminalService();
  const session = ptySession();
  terminal.sessions.set("chat-1", session);

  terminal.append(session, "x".repeat(50_000));
  terminal.resize({ chatId: "chat-1", cols: 80, rows: 24 });
  terminal.append(session, "y".repeat(50_000));
  terminal.resize({ chatId: "chat-1", cols: 90, rows: 24 });
  terminal.append(session, "z".repeat(30_000));

  const snap = terminal.snapshot("chat-1");
  assert.equal(snap.history.length, 80_000);
  assert.equal(snap.total, 130_000);
  assert.deepEqual(snap.sizes, [
    { at: 50_000, cols: 80, rows: 24 },
    { at: 100_000, cols: 90, rows: 24 },
  ]);
});
