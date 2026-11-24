"use strict";

// A stand-in for the Antigravity CLI (agy) used by agyProvider.test.js.
// The test copies this file into a temp folder with a control.json:
//   { scenario: "fixture", fixture: "<path to .jsonl>", stderr?, exitCode? }
//   { scenario: "write", file: "<abs path>", content: "..." }
//   { staleIds: ["..."] }   --conversation ids agy "doesn't know"
// Every call is appended to calls.jsonl ({ args, stdin }).
//
// Like agy 1.4.12 it: answers `models` and `-p /hooks`; for a turn reads one
// NDJSON user message from stdin; applies --settings deny rules; and runs the
// PreToolUse hook found in an --add-dir workspace through `cmd /c` (Windows)
// or `sh -c`, expanding CORTEX_AGY_HOOK from its environment.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(path.join(__dirname, "control.json"), "utf8"));
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function hookFiles() {
  const dirs = [];
  args.forEach((arg, index) => { if (arg === "--add-dir") dirs.push(args[index + 1]); });
  return dirs.map((dir) => path.join(dir, ".agents", "hooks.json")).filter((file) => fs.existsSync(file));
}

function runHook(toolCall) {
  for (const file of hookFiles()) {
    const hooks = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const spec of Object.values(hooks)) {
      for (const group of spec.PreToolUse || []) {
        for (const handler of group.hooks || []) {
          const isWin = process.platform === "win32";
          const result = spawnSync(isWin ? "cmd.exe" : "sh", isWin ? ["/d", "/c", handler.command] : ["-c", handler.command], {
            cwd: path.dirname(file),
            input: JSON.stringify({ conversationId: "fake", toolCall }),
            encoding: "utf8",
            windowsVerbatimArguments: isWin,
          });
          if (result.status !== 0) return { decision: "deny", reason: `hook failed: ${result.stderr}` };
          const answer = JSON.parse(result.stdout || "{}");
          if (answer.decision !== "allow") return answer;
        }
      }
    }
  }
  return { decision: "allow" };
}

function main(stdin) {
  fs.appendFileSync(path.join(__dirname, "calls.jsonl"), `${JSON.stringify({ args, stdin })}\n`);
  if (args[0] === "models") {
    process.stdout.write("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n");
    return;
  }
  if (flag("-p") === "/hooks") {
    const hooks = hookFiles().map((source) => ({ name: "cortex-approvals", enabled: true, source }));
    out({ conversation_id: "", status: "SUCCESS", response: "", command: { name: "hooks", data: { hooks } } });
    return;
  }
  const requested = flag("--conversation");
  const stale = requested && (control.staleIds || []).includes(requested);
  const id = requested && !stale ? requested : (control.newId || "conv-new");
  if (stale) {
    process.stderr.write(`warning: conversation "${requested}" not found\n`);
    out({ event: "init", conversation_id: id, init: { model: "fake" } });
    // Give Cortex time to stop us before the "model" runs.
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 3000)"]);
  }

  if (control.scenario === "fixture") {
    process.stdout.write(fs.readFileSync(control.fixture, "utf8"));
    if (control.stderr) process.stderr.write(control.stderr);
    process.exitCode = control.exitCode || 0;
    return;
  }

  // scenario "write": one write_file tool call, then a short answer.
  if (!stale) out({ event: "init", conversation_id: id, init: { model: "fake" } });
  const step = (body) => out({ event: "step_update", step_update: { conversation_id: id, ...body } });
  step({ step_index: 0, state: "DONE", step_type: "user_input" });
  const params = { Path: control.file };
  step({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "write_file", tool_info: { name: "write_file", parameters: params } });
  const settings = flag("--settings") ? JSON.parse(flag("--settings")) : {};
  const denied = !args.includes("--dangerously-skip-permissions") && (settings.permissions?.deny || []).includes("write_file(*)");
  let error = denied ? "Permission denied for write_file. Matches user-configured deny rule." : "";
  if (!error) {
    const answer = runHook({ name: "write_file", args: { Path: control.file, Content: control.content, Overwrite: true } });
    if (answer.decision !== "allow") error = `tool call denied by pre-tool hook: ${answer.reason || ""}`;
  }
  if (error) {
    step({ step_index: 1, state: "ERROR", step_type: "tool", tool_name: "write_file", tool_info: { name: "write_file", parameters: params, error: { type: "TOOL_ERROR", message: error } } });
  } else {
    fs.writeFileSync(control.file, control.content);
    step({ step_index: 1, state: "DONE", step_type: "tool", tool_name: "write_file", tool_info: { name: "write_file", parameters: params } });
  }
  const text = error ? "I could not write the file." : "Wrote the file.";
  step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: text });
  step({ step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "\n" });
  out({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: `${text}\n`, num_turns: 1 } });
}

let stdin = "";
if (args[0] === "models" || flag("-p") === "/hooks") {
  main(stdin);
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { stdin += chunk; });
  process.stdin.on("end", () => main(stdin));
}
