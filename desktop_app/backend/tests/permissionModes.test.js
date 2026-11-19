const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizePermissionMode,
  chatPermissionMode,
  resolveRequestPermissionMode,
  legacyToolSafetyMode,
  codexPolicy,
  claudePermissionArgs,
  geminiApprovalMode,
  apiToolGate,
  describePermissionMode,
  CLAUDE_APPROVAL_TOOL,
} = require("../permissionModes");

test("legacy read/write chats migrate to read-only / full-access", () => {
  assert.equal(chatPermissionMode({ tool_safety_mode: "read" }), "read-only");
  assert.equal(chatPermissionMode({ tool_safety_mode: "write" }), "full-access");
  assert.equal(chatPermissionMode({}), "full-access");
  assert.equal(chatPermissionMode({ tool_safety_mode: "write", permission_mode: "supervised" }), "supervised");
  assert.equal(chatPermissionMode({ permission_mode: "bogus", tool_safety_mode: "read" }), "read-only");
  assert.equal(normalizePermissionMode("read"), "read-only");
  assert.equal(normalizePermissionMode("write"), "full-access");
  assert.equal(normalizePermissionMode("nonsense"), "full-access");
  assert.equal(legacyToolSafetyMode("read-only"), "read");
  assert.equal(legacyToolSafetyMode("supervised"), "write");
});

test("a legacy 'write' request cannot lift a supervised chat to full access", () => {
  assert.equal(resolveRequestPermissionMode({ toolSafetyMode: "write", stored: "supervised" }), "supervised");
  assert.equal(resolveRequestPermissionMode({ toolSafetyMode: "write", stored: "auto-accept-edits" }), "auto-accept-edits");
  assert.equal(resolveRequestPermissionMode({ toolSafetyMode: "write", stored: "read-only" }), "full-access");
  assert.equal(resolveRequestPermissionMode({ toolSafetyMode: "read", stored: "supervised" }), "read-only");
  assert.equal(resolveRequestPermissionMode({ permissionMode: "full-access", toolSafetyMode: "read", stored: "supervised" }), "full-access");
  assert.equal(resolveRequestPermissionMode({ stored: null, fallback: "supervised" }), "supervised");
});

test("codex modes map to app-server approval policy and sandbox", () => {
  assert.deepEqual(codexPolicy("read-only"), { approvalPolicy: "never", sandbox: "read-only" });
  assert.deepEqual(codexPolicy("supervised"), { approvalPolicy: "untrusted", sandbox: "read-only" });
  assert.deepEqual(codexPolicy("auto-accept-edits"), { approvalPolicy: "untrusted", sandbox: "workspace-write" });
  // Full access is exactly the old "write" behaviour.
  assert.deepEqual(codexPolicy("full-access"), { approvalPolicy: "never", sandbox: "workspace-write" });
});

test("claude modes map to --permission-mode and the approval prompt tool", () => {
  const full = claudePermissionArgs("full-access");
  assert.ok(full.includes("--dangerously-skip-permissions"));

  const readOnly = claudePermissionArgs("read-only");
  assert.deepEqual(readOnly.slice(0, 2), ["--permission-mode", "dontAsk"]);
  assert.equal(readOnly[readOnly.indexOf("--allowedTools") + 1], "Read,Glob,Grep,LS");
  assert.ok(!readOnly.includes("--dangerously-skip-permissions"));

  const supervised = claudePermissionArgs("supervised", { promptTool: true });
  assert.equal(supervised[supervised.indexOf("--permission-mode") + 1], "default");
  assert.equal(supervised[supervised.indexOf("--permission-prompt-tool") + 1], CLAUDE_APPROVAL_TOOL);
  // Bash/Write/Edit must not be pre-approved, or they would never ask.
  assert.doesNotMatch(supervised[supervised.indexOf("--allowedTools") + 1], /Bash|Write|Edit/);

  const edits = claudePermissionArgs("auto-accept-edits", { promptTool: true });
  assert.equal(edits[edits.indexOf("--permission-mode") + 1], "acceptEdits");

  // No bridge: nobody can answer, so prompts are refused rather than faked.
  const noBridge = claudePermissionArgs("supervised", { promptTool: false });
  assert.ok(!noBridge.includes("--permission-prompt-tool"));
  assert.equal(noBridge[noBridge.indexOf("--permission-prompts") + 1], "none");
});

test("gemini cli and hermes fall back and say so", () => {
  assert.equal(geminiApprovalMode("read-only"), "default");
  assert.equal(geminiApprovalMode("supervised"), "default");
  assert.equal(geminiApprovalMode("auto-accept-edits"), "auto_edit");
  assert.equal(geminiApprovalMode("full-access"), "auto_edit");

  const gem = describePermissionMode("gemini-cli:auto", "supervised");
  assert.equal(gem.effectiveMode, "read-only");
  assert.equal(gem.interactive, false);
  assert.ok(gem.note);

  const hermes = describePermissionMode("hermes:default", "read-only");
  assert.equal(hermes.effectiveMode, "full-access");
  assert.ok(hermes.note);

  assert.equal(describePermissionMode("codex:gpt-5.4", "supervised").interactive, true);
  assert.equal(describePermissionMode("claude:haiku", "supervised").interactive, true);
  assert.equal(describePermissionMode("claude:haiku", "supervised", { claudeBridge: false }).interactive, false);
  assert.equal(describePermissionMode("llama-3.3-70b", "auto-accept-edits").interactive, true);
  assert.equal(describePermissionMode("codex:gpt-5.4", "full-access").interactive, false);
});

test("api tool gate asks, blocks or allows per mode", () => {
  assert.equal(apiToolGate("supervised", "write_file"), "ask");
  assert.equal(apiToolGate("supervised", "run_terminal_command"), "ask");
  assert.equal(apiToolGate("supervised", "read_file"), "allow");
  assert.equal(apiToolGate("auto-accept-edits", "edit_file"), "allow");
  assert.equal(apiToolGate("auto-accept-edits", "run_terminal_command"), "ask");
  assert.equal(apiToolGate("read-only", "write_file"), "block");
  assert.equal(apiToolGate("read-only", "list_files"), "allow");
  assert.equal(apiToolGate("full-access", "run_terminal_command"), "allow");
});
