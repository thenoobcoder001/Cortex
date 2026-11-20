const test = require("node:test");
const assert = require("node:assert/strict");
const { diffLines, diffFile, MAX_DIFF_INPUT_LINES } = require("../turnDiff");

function replay(ops) {
  return {
    before: ops.filter((op) => op.type !== "+").map((op) => op.line),
    after: ops.filter((op) => op.type !== "-").map((op) => op.line),
  };
}

test("diffLines ops always rebuild both sides (randomised)", () => {
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 2000; round += 1) {
    const make = () => Array.from({ length: rand(14) }, () => "abcd"[rand(4)]);
    const before = make();
    const after = make();
    const rebuilt = replay(diffLines(before, after));
    assert.deepEqual(rebuilt.before, before);
    assert.deepEqual(rebuilt.after, after);
  }
});

test("one inserted line is one addition, not a rewrite of everything below", () => {
  const before = "one\ntwo\nthree\nfour\n";
  const after = "one\nNEW\ntwo\nthree\nfour\n";
  const result = diffFile("a.txt", { beforeText: before, afterText: after });
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 0);
  assert.equal(result.diff, [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,4 +1,5 @@",
    " one",
    "+NEW",
    " two",
    " three",
    " four",
  ].join("\n"));
});

test("distant changes become separate hunks with three lines of context", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const changed = [...lines];
  changed[1] = "CHANGED 2";
  changed[25] = "CHANGED 26";
  const { diff, additions, deletions } = diffFile("f.txt", {
    beforeText: `${lines.join("\n")}\n`,
    afterText: `${changed.join("\n")}\n`,
  });
  assert.equal(additions, 2);
  assert.equal(deletions, 2);
  const headers = diff.split("\n").filter((line) => line.startsWith("@@"));
  assert.deepEqual(headers, ["@@ -1,5 +1,5 @@", "@@ -23,7 +23,7 @@"]);
});

test("added and deleted files diff against /dev/null", () => {
  const added = diffFile("new.txt", { beforeAbsent: true, afterText: "a\nb\n" });
  assert.match(added.diff, /^--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1,2 @@\n\+a\n\+b$/);
  const deleted = diffFile("old.txt", { beforeText: "x\n", afterAbsent: true });
  assert.equal(deleted.deletions, 1);
  assert.match(deleted.diff, /\+\+\+ \/dev\/null/);
});

test("binary files are flagged, not diffed", () => {
  const result = diffFile("img.png", { beforeText: "PNG\u0000\u0001", afterText: "PNG\u0000\u0002" });
  assert.equal(result.binary, true);
  assert.equal(result.diff, "");
});

test("files without captured text or past the caps are marked too large", () => {
  assert.equal(diffFile("big.bin", { beforeText: null, afterText: "x" }).tooLarge, true);
  const huge = Array.from({ length: MAX_DIFF_INPUT_LINES + 1 }, (_, i) => `${i}`).join("\n");
  assert.equal(diffFile("huge.txt", { beforeAbsent: true, afterText: huge }).tooLarge, true);
  const capped = diffFile("long.txt", { beforeAbsent: true, afterText: "x".repeat(500), maxChars: 100 });
  assert.equal(capped.tooLarge, true);
  assert.equal(capped.diff, "");
  assert.equal(capped.additions, 1, "counts survive the cap");
});
