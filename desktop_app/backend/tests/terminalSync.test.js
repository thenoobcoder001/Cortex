const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The sync logic lives in the web app (an ES module); load it from there.
const modulePath = path.join(__dirname, "..", "..", "web", "src", "app", "terminalSync.js");
const load = () => import(pathToFileURL(modulePath).href);

// Records what reaches the terminal. Writes finish asynchronously, like xterm's.
function fakeTerm(cols = 100, rows = 20) {
  return {
    cols,
    rows,
    ops: [],
    text: "",
    write(data, done) {
      setImmediate(() => {
        this.ops.push(["write", data]);
        this.text += data;
        done?.();
      });
    },
    reset() {
      this.ops.push(["reset"]);
      this.text = "";
    },
    resize(c, r) {
      this.ops.push(["resize", c, r]);
      this.cols = c;
      this.rows = r;
    },
  };
}

const flush = (sync) => sync.run(() => {});
const snap = (history, total, extra = {}) => ({ epoch: 1, history, total, sizes: [], ...extra });

test("stream chunks already covered by a snapshot are not written again", async () => {
  const { createTerminalSync } = await load();
  const term = fakeTerm();
  const sync = createTerminalSync(term);

  sync.applySnapshot(snap("hello", 5));
  // A poll taken after this output can arrive before the stream delivers it.
  sync.applySnapshot(snap("hello world", 11));
  sync.applyData({ epoch: 1, data: " world", end: 11 });
  sync.applyData({ epoch: 1, data: "!", end: 12 });
  // A stale poll arriving late changes nothing.
  sync.applySnapshot(snap("hello world", 11));
  await flush(sync);

  assert.equal(term.text, "hello world!");
});

test("a remount replays the history once and continues from the stream", async () => {
  const { createTerminalSync } = await load();
  const term = fakeTerm();
  const sync = createTerminalSync(term);

  // The stream's first message and the mount-time GET carry the same snapshot.
  sync.applySnapshot(snap("dir output\r\n", 12));
  sync.applySnapshot(snap("dir output\r\n", 12));
  sync.applyData({ epoch: 1, data: "C:\\>", end: 16 });
  await flush(sync);

  assert.equal(term.text, "dir output\r\nC:\\>");
  assert.equal(term.ops.filter((op) => op[0] === "reset").length, 1);
});

test("a chunk past what was written asks for a snapshot instead of leaving a hole", async () => {
  const { createTerminalSync } = await load();
  const term = fakeTerm();
  let gaps = 0;
  const sync = createTerminalSync(term, { onGap: () => { gaps += 1; } });

  sync.applyData({ epoch: 1, data: "early", end: 5 }); // before any snapshot
  sync.applySnapshot(snap("abc", 3));
  sync.applyData({ epoch: 1, data: "xyz", end: 10 }); // offsets 3..7 missing
  await flush(sync);

  assert.equal(gaps, 2);
  assert.equal(term.text, "abc");
});

test("a reopened terminal (new epoch) replaces the old output", async () => {
  const { createTerminalSync } = await load();
  const term = fakeTerm();
  const sync = createTerminalSync(term);

  sync.applySnapshot(snap("old session", 11));
  sync.applySnapshot(snap("new", 3, { epoch: 2 }));
  await flush(sync);

  assert.equal(term.text, "new");
});

test("a replay follows recorded size changes, then returns to the view size", async () => {
  const { createTerminalSync } = await load();
  const term = fakeTerm(120, 30);
  const sync = createTerminalSync(term, { getViewSize: () => ({ cols: 120, rows: 30 }) });

  // History starts at offset 100 after trimming.
  sync.applySnapshot(snap("AAAABBBB", 108, {
    sizes: [{ at: 100, cols: 80, rows: 24 }, { at: 104, cols: 90, rows: 20 }],
  }));
  await flush(sync);

  assert.deepEqual(term.ops, [
    ["reset"],
    ["resize", 80, 24],
    ["write", "AAAA"],
    ["resize", 90, 20],
    ["write", "BBBB"],
    ["resize", 120, 30],
  ]);
});

test("nothing is written after dispose", async () => {
  const { createTerminalSync } = await load();
  const term = fakeTerm();
  const sync = createTerminalSync(term);
  sync.dispose();
  sync.applySnapshot(snap("late", 4));
  await flush(sync);
  assert.deepEqual(term.ops, []);
});
