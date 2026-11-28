const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ACTIVITY_KINDS } = require("../activity");

// The chat's step-log helpers live in the web app (an ES module).
const modulePath = path.join(__dirname, "..", "..", "web", "src", "app", "activity.js");
const load = () => import(pathToFileURL(modulePath).href);

test("streamed tool events build the live step list", async () => {
  const { applyActivityEvent, currentStep } = await load();
  let steps = [];
  steps = applyActivityEvent(steps, { type: "tool_call", id: "a", kind: "command", label: "npm test" }, 1000);
  steps = applyActivityEvent(steps, { type: "tool_call", id: "b", kind: "read", label: "Read a.js" }, 1100);
  const same = applyActivityEvent(steps, { type: "tool_call", id: "a", kind: "command", label: "npm test" }, 1200);
  assert.equal(same, steps, "a repeated call changes nothing");
  assert.equal(applyActivityEvent(steps, { type: "tool_call", id: "c" }), steps, "no label: ignored (old events)");
  assert.equal(currentStep(steps).id, "b");

  steps = applyActivityEvent(steps, { type: "tool_result", id: "b", ok: true }, 1300);
  assert.equal(currentStep(steps).id, "a", "the newest step still running");
  steps = applyActivityEvent(steps, { type: "tool_result", id: "a", label: "npm test", ok: false, status: "failed", exitCode: 1, auditSeq: 7 }, 3000);
  assert.deepEqual(steps.map((s) => [s.id, s.status]), [["a", "failed"], ["b", "done"]]);
  assert.equal(steps[0].exitCode, 1);
  assert.equal(steps[0].auditSeq, 7);
  assert.equal(steps[0].durationMs, 2000);
});

test("summary line and durations", async () => {
  const { summarizeActivity, formatDuration } = await load();
  const steps = [
    { kind: "command", status: "done" },
    { kind: "command", status: "failed" },
    { kind: "read", status: "done" },
    { kind: "edit", status: "done" },
    { kind: "search", status: "declined" },
  ];
  assert.equal(summarizeActivity(steps), "made 1 edit, ran 2 commands, read 1 file, searched once · 1 failed, 1 declined");
  assert.equal(summarizeActivity([]), "");
  assert.equal(formatDuration(800), "0.8s");
  assert.equal(formatDuration(12000), "12s");
  assert.equal(formatDuration(73000), "1m 13s");
  assert.equal(formatDuration(3_660_000), "1h 1m");
});

test("every backend activity kind has a summary phrase", async () => {
  const { summarizeActivity } = await load();
  for (const kind of ACTIVITY_KINDS) {
    assert.ok(summarizeActivity([{ kind, status: "done" }]).length > 0, kind);
  }
});
