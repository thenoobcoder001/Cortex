"use strict";

// Line diff + unified-diff rendering for the per-turn diff panel.
//
// fileService.buildUnifiedDiff compares lines by position, which is fine for
// the audit trail but shows one inserted line as "everything below changed".
// The diff panel needs real hunks, so this is a small Myers O(ND) diff with
// common prefix/suffix trimming and hard caps so a huge rewrite cannot stall
// the turn that produced it.

const CONTEXT_LINES = 3;
// Past this many lines (both sides together) the file is reported as too
// large to diff instead of being diffed.
const MAX_DIFF_INPUT_LINES = 20_000;
// Myers keeps one row per edit step; past this the middle is shown as a
// straight replace (still correct, just not minimal).
const MAX_EDIT_DISTANCE = 4_000;
// Per-file cap on stored diff text.
const MAX_DIFF_CHARS = 120_000;

function splitLines(text) {
  const value = String(text ?? "");
  if (!value) return [];
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function isBinaryText(text) {
  return typeof text === "string" && text.includes("\u0000");
}

// Returns [{ type: " " | "-" | "+", line }] in order.
function diffLines(beforeLines, afterLines) {
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }
  let endBefore = beforeLines.length;
  let endAfter = afterLines.length;
  while (endBefore > start && endAfter > start && beforeLines[endBefore - 1] === afterLines[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const head = beforeLines.slice(0, start).map((line) => ({ type: " ", line }));
  const tail = beforeLines.slice(endBefore).map((line) => ({ type: " ", line }));
  const middle = myers(beforeLines.slice(start, endBefore), afterLines.slice(start, endAfter));
  return [...head, ...middle, ...tail];
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((line) => ({ type: "+", line }));
  if (!m) return a.map((line) => ({ type: "-", line }));
  const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
  const trace = [];
  let found = false;
  for (let d = 0; d <= limit && !found; d += 1) {
    const prev = d > 0 ? trace[d - 1] : null;
    const row = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (d === 0) {
        x = 0;
      } else if (k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1])) {
        x = prev[k + 1 + d - 1];
      } else {
        x = prev[k - 1 + d - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      row[k + d] = x;
      if (x >= n && y >= m) found = true;
    }
    trace.push(row);
  }
  if (!found) {
    return [...a.map((line) => ({ type: "-", line })), ...b.map((line) => ({ type: "+", line }))];
  }

  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const prev = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: " ", line: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (down) {
      ops.push({ type: "+", line: b[y - 1] });
    } else {
      ops.push({ type: "-", line: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ type: " ", line: a[x - 1] });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

function hunkRange(start, length) {
  return length === 1 ? `${start}` : `${start},${length}`;
}

// Groups ops into hunks with CONTEXT_LINES of context; returns the hunk
// lines (without the ---/+++ header) and the +/- counts.
function buildHunks(ops) {
  const changeIndexes = [];
  ops.forEach((op, index) => {
    if (op.type !== " ") changeIndexes.push(index);
  });
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "+") additions += 1;
    else if (op.type === "-") deletions += 1;
  }
  if (!changeIndexes.length) return { lines: [], additions, deletions };

  // Merge change positions into [from, to) windows including context.
  const windows = [];
  for (const index of changeIndexes) {
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(ops.length, index + CONTEXT_LINES + 1);
    const last = windows[windows.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else windows.push({ from, to });
  }

  // Line numbers (1-based) of each op on the old and new side.
  const oldNo = new Array(ops.length);
  const newNo = new Array(ops.length);
  let oldLine = 1;
  let newLine = 1;
  ops.forEach((op, index) => {
    oldNo[index] = oldLine;
    newNo[index] = newLine;
    if (op.type !== "+") oldLine += 1;
    if (op.type !== "-") newLine += 1;
  });

  const lines = [];
  for (const { from, to } of windows) {
    const slice = ops.slice(from, to);
    const oldLen = slice.filter((op) => op.type !== "+").length;
    const newLen = slice.filter((op) => op.type !== "-").length;
    const oldStart = oldLen ? oldNo[from] : oldNo[from] - 1;
    const newStart = newLen ? newNo[from] : newNo[from] - 1;
    lines.push(`@@ -${hunkRange(oldStart, oldLen)} +${hunkRange(newStart, newLen)} @@`);
    for (const op of slice) lines.push(`${op.type}${op.line}`);
  }
  return { lines, additions, deletions };
}

// Diff for one file. beforeText/afterText are null when that side is absent
// or its content was not captured (too large); `absent` tells which.
function diffFile(relativePath, {
  beforeText = null,
  afterText = null,
  beforeAbsent = false,
  afterAbsent = false,
  maxChars = MAX_DIFF_CHARS,
} = {}) {
  const result = { diff: "", additions: 0, deletions: 0, binary: false, tooLarge: false };
  if (isBinaryText(beforeText) || isBinaryText(afterText)) {
    result.binary = true;
    return result;
  }
  const beforeKnown = beforeAbsent || beforeText != null;
  const afterKnown = afterAbsent || afterText != null;
  if (!beforeKnown || !afterKnown) {
    result.tooLarge = true;
    return result;
  }
  const beforeLines = beforeAbsent ? [] : splitLines(beforeText);
  const afterLines = afterAbsent ? [] : splitLines(afterText);
  if (beforeLines.length + afterLines.length > MAX_DIFF_INPUT_LINES) {
    result.tooLarge = true;
    return result;
  }
  const { lines, additions, deletions } = buildHunks(diffLines(beforeLines, afterLines));
  result.additions = additions;
  result.deletions = deletions;
  const header = [
    `--- ${beforeAbsent ? "/dev/null" : `a/${relativePath}`}`,
    `+++ ${afterAbsent ? "/dev/null" : `b/${relativePath}`}`,
  ];
  const diff = [...header, ...lines].join("\n");
  if (diff.length > maxChars) {
    result.tooLarge = true;
    return result;
  }
  result.diff = diff;
  return result;
}

module.exports = {
  diffLines,
  diffFile,
  isBinaryText,
  splitLines,
  MAX_DIFF_CHARS,
  MAX_DIFF_INPUT_LINES,
};
