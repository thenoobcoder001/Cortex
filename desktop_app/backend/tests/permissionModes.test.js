const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizePermissionMode,
  chatPermissionMode,
  resolveRequestPermissionMode,
  legacyToolSafetyMode,
  codexPolicy,
  claudePermissionArgs,
  agyPermissionConfig,
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
  // Full access: same sandbox as before, but Codex asks before commands so
  // Cortex can stop risky ones (everything else is accepted at once).
  assert.deepEqual(codexPolicy("full-access"), { approvalPolicy: "untrusted", sandbox: "workspace-write" });
});

test("claude modes map to --permission-mode and the approval prompt tool", () => {
  const full = claudePermissionArgs("full-access");
  assert.ok(full.includes("--dangerously-skip-permissions"));
  assert.ok(!full.includes("--settings"));

  // Full access with the bridge: shell calls ask (settings file) and the
  // bridge answers them.
  const fullBridge = claudePermissionArgs("full-access", { promptTool: true, settingsPath: "s.json" });
  assert.ok(fullBridge.includes("--dangerously-skip-permissions"));
  assert.equal(fullBridge[fullBridge.indexOf("--settings") + 1], "s.json");
  assert.equal(fullBridge[fullBridge.indexOf("--permission-prompt-tool") + 1], CLAUDE_APPROVAL_TOOL);
  // Without the bridge the risky-pattern settings still apply and decline.
  const fullNoBridge = claudePermissionArgs("full-access", { settingsPath: "s.json" });
  assert.equal(fullNoBridge[fullNoBridge.indexOf("--permission-prompts") + 1], "none");

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

test("antigravity maps each mode onto agy settings, asking through the hook", () => {
  const full = agyPermissionConfig("full-access");
  assert.deepEqual(full.args, ["--dangerously-skip-permissions"]);
  assert.equal(full.settings, null);

  const readOnly = agyPermissionConfig("read-only");
  assert.deepEqual(readOnly.args, []);
  assert.deepEqual(readOnly.settings.permissions.deny, ["write_file(*)", "command(*)", "mcp(*)"]);
  assert.equal(readOnly.hook, false);

  // With the hook, the hook is the gate; the allow rule only stops headless
  // agy from refusing a command the user approved.
  for (const mode of ["supervised", "auto-accept-edits"]) {
    const hooked = agyPermissionConfig(mode, { hook: true });
    assert.equal(hooked.hook, true);
    assert.equal(hooked.effectiveMode, mode);
    assert.deepEqual(hooked.settings.permissions.allow, ["command(*)"]);
    assert.ok(!hooked.args.includes("--dangerously-skip-permissions"));
  }

  // Without it nobody can answer: Supervised becomes Read-only, Auto-accept
  // edits refuses commands.
  const supervised = agyPermissionConfig("supervised");
  assert.equal(supervised.effectiveMode, "read-only");
  assert.deepEqual(supervised.settings, readOnly.settings);
  const edits = agyPermissionConfig("auto-accept-edits");
  assert.ok(edits.settings.permissions.deny.includes("command(*)"));
  assert.ok(!edits.settings.permissions.deny.includes("write_file(*)"));

  assert.equal(describePermissionMode("agy:default", "supervised").interactive, true);
  const noBridge = describePermissionMode("agy:default", "supervised", { bridge: false });
  assert.equal(noBridge.interactive, false);
  assert.equal(noBridge.effectiveMode, "read-only");
  assert.ok(noBridge.note);
  assert.equal(describePermissionMode("agy:default", "full-access").note, "");
});

test("hermes falls back and says so", () => {

  const hermes = describePermissionMode("hermes:default", "read-only");
  assert.equal(hermes.effectiveMode, "full-access");
  assert.ok(hermes.note);

  assert.equal(describePermissionMode("codex:gpt-5.4", "supervised").interactive, true);
  assert.equal(describePermissionMode("claude:haiku", "supervised").interactive, true);
  assert.equal(describePermissionMode("claude:haiku", "supervised", { bridge: false }).interactive, false);
  assert.equal(describePermissionMode("llama-3.3-70b", "auto-accept-edits").interactive, true);
  assert.equal(describePermissionMode("codex:gpt-5.4", "full-access").interactive, false);
});

test("full access still asks about risky commands on codex, claude and api models", () => {
  assert.equal(describePermissionMode("codex:gpt-5.4", "full-access").asksForRiskyCommands, true);
  assert.equal(describePermissionMode("claude:haiku", "full-access").asksForRiskyCommands, true);
  assert.equal(describePermissionMode("llama-3.3-70b", "full-access").asksForRiskyCommands, true);
  assert.equal(describePermissionMode("codex:gpt-5.4", "supervised").asksForRiskyCommands, false);
  assert.equal(describePermissionMode("hermes:default", "full-access").asksForRiskyCommands, false);
  const noBridge = describePermissionMode("claude:haiku", "full-access", { bridge: false });
  assert.equal(noBridge.asksForRiskyCommands, false);
  assert.match(noBridge.note, /risky commands are declined/);
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
