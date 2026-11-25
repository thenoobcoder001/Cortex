const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { AgyCliProvider, AgyStreamParser, parseAgyModels } = require("../providers");
const { agyToolSummary, writeAgyHookWorkspace } = require("../approvalBridge");
const agyHook = require("../agyApprovalHook");
const { DesktopSessionService } = require("../sessionService");
const { startBackendServer } = require("../server");

// Captured from agy 1.4.12 (`agy -p ... --output-format stream-json`),
// paths and user names scrubbed.
const FIXTURES = path.join(__dirname, "fixtures", "agy");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const events = (name) => fixture(name).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));

function parse(name) {
  const seen = { text: "", calls: [], results: [] };
  const parser = new AgyStreamParser({
    onText: (delta) => { seen.text += delta; },
    onToolCall: (call) => seen.calls.push(call),
    onToolResult: (result) => seen.results.push(result),
  });
  for (const event of events(name)) parser.push(event);
  return { parser, seen };
}

test("agy models output becomes models with effort variants grouped by base", () => {
  const models = parseAgyModels(fixture("models.txt"));
  const flash = models.filter((entry) => entry.base === "gemini-3.8-flash");
  assert.deepEqual(flash.map((entry) => entry.effort), ["high", "medium", "low"]);
  assert.equal(flash[0].displayName, "Gemini 3.8 Flash");
  const sonnet = models.find((entry) => entry.model === "claude-sonnet-4-6");
  assert.deepEqual(sonnet, { model: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Thinking)", base: "claude-sonnet-4-6", effort: null });
  // Spinner text or junk lines are ignored.
  assert.deepEqual(parseAgyModels("Fetching available models...\n\n"), []);
});

test("stream parser: plain reply, conversation id, final result", () => {
  const { parser, seen } = parse("plain-turn.jsonl");
  assert.equal(parser.conversationId, "60899765-1c03-4bb8-a1ff-2204a7aacbc6");
  assert.equal(seen.text, "PONG\n");
  assert.equal(parser.finalText(), "PONG");
  assert.equal(parser.result.status, "SUCCESS");
});

test("stream parser: tool steps become tool_call / tool_result", () => {
  const { parser, seen } = parse("tool-turn.jsonl");
  assert.deepEqual(seen.calls.map((call) => call.name), ["write_file", "read_file"]);
  assert.equal(seen.calls[0].args.Path, "C:\\work\\repo\\b.txt");
  assert.deepEqual(seen.results.map((result) => [result.name, result.ok]), [["write_file", true], ["read_file", true]]);
  assert.equal(seen.results[1].result, "1 lines, 6 bytes");
  assert.match(parser.finalText(), /^The content of \[a\.txt\]/);
});

test("stream parser: a resumed turn keeps the conversation id", () => {
  const { parser } = parse("resume-turn.jsonl");
  assert.equal(parser.conversationId, "e71ec4e2-6e65-4ded-91ce-d341cede53b4");
  assert.match(parser.finalText(), /b\.txt/);
});

test("stream parser: a denied tool is an ERROR result and denied_actions are kept", () => {
  const denied = parse("deny-rule-turn.jsonl");
  assert.equal(denied.seen.results[0].ok, false);
  assert.match(denied.seen.results[0].result, /Matches user-configured deny rule/);

  const headless = parse("headless-denied-command.jsonl");
  assert.equal(headless.parser.finalText(), "");
  assert.deepEqual(headless.parser.deniedActions(), ["RunCommand"]);
});

test("stream parser: a separate response after a tool starts a new paragraph", () => {
  const text = [];
  const parser = new AgyStreamParser({ onText: (delta) => text.push(delta) });
  const step = (body) => parser.push({ event: "step_update", step_update: { conversation_id: "c", ...body } });
  step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Looking." });
  step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "read_file", tool_info: { name: "read_file", parameters: {} } });
  step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "Done." });
  assert.equal(text.join(""), "Looking.\n\nDone.");
});

// ── provider runs against a fake agy ─────────────────────────────────────

function makeFakeAgy(control) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fake-agy-"));
  fs.copyFileSync(path.join(FIXTURES, "fake-agy.js"), path.join(dir, "fake-agy.js"));
  fs.writeFileSync(path.join(dir, "control.json"), JSON.stringify(control));
  let shim;
  if (process.platform === "win32") {
    shim = path.join(dir, "agy.cmd");
    fs.writeFileSync(shim, `@"${process.execPath}" "${path.join(dir, "fake-agy.js")}" %*\r\n`);
  } else {
    shim = path.join(dir, "agy");
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "fake-agy.js")}" "$@"\n`, { mode: 0o755 });
  }
  return {
    dir,
    shim,
    setControl: (next) => fs.writeFileSync(path.join(dir, "control.json"), JSON.stringify(next)),
    calls: () => fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agy-repo-"));
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n", "utf8");
  return root;
}

function fakeProvider(repoRoot, fake) {
  const provider = new AgyCliProvider(repoRoot);
  provider.resolveCli = () => fake.shim;
  provider._available = true;
  return provider;
}

const user = (content) => [{ role: "user", content }];

test("provider streams a reply, sends the prompt as an NDJSON message and remembers the conversation", async () => {
  const repo = makeRepo();
  const fake = makeFakeAgy({ scenario: "fixture", fixture: path.join(FIXTURES, "tool-turn.jsonl") });
  const provider = fakeProvider(repo, fake);
  const chunks = [];
  const tools = [];
  const text = await provider.chatCompletionStreamRaw(user("make b.txt"), "agy:gemini-3.8-flash-low", {
    permissionMode: "full-access",
    onOutput: (chunk) => chunks.push(chunk),
    onEvent: (type, payload) => tools.push([type, payload.name]),
  });
  assert.match(text, /The content of/);
  assert.equal(chunks.join("").trim(), text);
  assert.deepEqual(tools, [["tool_call", "write_file"], ["tool_result", "write_file"], ["tool_call", "read_file"], ["tool_result", "read_file"]]);
  assert.equal(provider.sessionId, "e71ec4e2-6e65-4ded-91ce-d341cede53b4");
  assert.equal(provider.sessionMode, "resume_id");

  const [call] = fake.calls();
  assert.ok(call.args.includes("--dangerously-skip-permissions"));
  assert.ok(call.args.includes("--disable-slash-commands"));
  assert.equal(call.args[call.args.indexOf("--model") + 1], "gemini-3.8-flash-low");
  assert.equal(call.args[call.args.indexOf("--input-format") + 1], "stream-json");
  const message = JSON.parse(call.stdin.trim());
  assert.equal(message.event, "user");
  assert.match(message.message.content, /make b\.txt/);

  // Next turn resumes the same conversation and sends only the new message.
  await provider.chatCompletionStreamRaw([...user("make b.txt"), { role: "assistant", content: "ok" }, ...user("and again")], "agy:default", { permissionMode: "full-access" });
  const second = fake.calls()[1];
  assert.equal(second.args[second.args.indexOf("--conversation") + 1], "e71ec4e2-6e65-4ded-91ce-d341cede53b4");
  assert.ok(!second.args.includes("--model"), "agy:default lets agy pick");
  assert.equal(JSON.parse(second.stdin.trim()).message.content, "and again");
});

test("provider retries fresh, with full context, when agy doesn't know the conversation", async () => {
  const repo = makeRepo();
  const fake = makeFakeAgy({ scenario: "fixture", fixture: path.join(FIXTURES, "plain-turn.jsonl"), staleIds: ["gone-id"] });
  const provider = fakeProvider(repo, fake);
  provider.sessionId = "gone-id";
  provider.sessionMode = "resume_id";
  const text = await provider.chatCompletionStreamRaw([...user("first"), { role: "assistant", content: "one" }, ...user("second")], "agy:default", { permissionMode: "full-access" });
  assert.equal(text, "PONG");
  const calls = fake.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[calls[0].args.indexOf("--conversation") + 1], "gone-id");
  assert.ok(!calls[1].args.includes("--conversation"));
  assert.match(JSON.parse(calls[1].stdin.trim()).message.content, /first[\s\S]*second/);
  assert.equal(provider.sessionId, "60899765-1c03-4bb8-a1ff-2204a7aacbc6");
});

test("provider reports agy errors and blocked actions in plain words", async () => {
  const repo = makeRepo();
  const fake = makeFakeAgy({ scenario: "fixture", fixture: path.join(FIXTURES, "error-result.jsonl"), exitCode: 1 });
  const provider = fakeProvider(repo, fake);
  await assert.rejects(
    provider.chatCompletionStreamRaw(user("x"), "agy:default", { permissionMode: "full-access" }),
    /agy CLI failed: failed to decode stream input/,
  );

  fake.setControl({ scenario: "fixture", fixture: path.join(FIXTURES, "headless-denied-command.jsonl") });
  const text = await provider.chatCompletionStreamRaw(user("run git status"), "agy:default", { permissionMode: "read-only" });
  assert.match(text, /^Antigravity was not allowed to: RunCommand/);
});

test("read-only passes deny rules; a deny-rule write is refused", async () => {
  const repo = makeRepo();
  const target = path.join(repo, "nope.txt");
  const fake = makeFakeAgy({ scenario: "write", file: target, content: "x" });
  const provider = fakeProvider(repo, fake);
  const text = await provider.chatCompletionStreamRaw(user("write"), "agy:default", { permissionMode: "read-only" });
  assert.match(text, /could not write/);
  assert.equal(fs.existsSync(target), false);
  const [call] = fake.calls();
  const settings = JSON.parse(call.args[call.args.indexOf("--settings") + 1]);
  assert.ok(settings.permissions.deny.includes("write_file(*)"));
  assert.ok(!call.args.includes("--dangerously-skip-permissions"));
});

test("supervised without an approval bridge falls back to read-only and says so", async () => {
  const repo = makeRepo();
  const target = path.join(repo, "nope.txt");
  const fake = makeFakeAgy({ scenario: "write", file: target, content: "x" });
  const provider = fakeProvider(repo, fake);
  const notices = [];
  await provider.chatCompletionStreamRaw(user("write"), "agy:default", { permissionMode: "supervised", onNotice: (note) => notices.push(note) });
  assert.equal(fs.existsSync(target), false);
  // No bridge configured at all: describePermissionMode already said so, so no extra notice.
  assert.deepEqual(notices, []);
});

// ── approval hook + bridge ────────────────────────────────────────────────

test("agy tool summaries: reads pass, edits and commands ask, the hook folder is refused", () => {
  const repo = makeRepo();
  const control = path.join(repo, ".cortex", "agy-approvals", "turn-1");
  const options = { repoRoot: repo, permissionMode: "supervised", controlDir: control };
  assert.deepEqual(agyToolSummary("read_file", { Path: path.join(repo, "seed.txt") }, options), { pass: true, by: "read-only tool" });

  const write = agyToolSummary("write_file", { Path: path.join(repo, "seed.txt"), Content: "new\n" }, options);
  assert.equal(write.kind, "file_change");
  assert.equal(write.path, "seed.txt");
  assert.match(write.diff, /-seed/);
  assert.match(write.diff, /\+new/);
  assert.equal(write.autoApprove, false);

  const edit = agyToolSummary("edit_file", { Path: path.join(repo, "seed.txt"), Target: "seed", Replacement: "sown" }, { ...options, permissionMode: "auto-accept-edits" });
  assert.match(edit.diff, /\+sown/);
  assert.equal(edit.autoApprove, "auto-accept edits mode");
  const outside = agyToolSummary("write_file", { Path: path.join(os.tmpdir(), "elsewhere.txt"), Content: "x" }, { ...options, permissionMode: "auto-accept-edits" });
  assert.equal(outside.autoApprove, false);

  const command = agyToolSummary("run_command", { CommandLine: "git status", toolSummary: "check" }, options);
  assert.deepEqual([command.kind, command.command, command.reason], ["command", "git status", "check"]);

  assert.equal(agyToolSummary("browser_click_element", { Index: 1 }, options).kind, "tool");
  assert.ok(agyToolSummary("read_file", { Path: path.join(control, ".agents", "hooks.json") }, options).block);
  assert.ok(agyToolSummary("write_file", { Path: path.join(control, ".agents", "hooks.json").replace(/\\/g, "/"), Content: "{}" }, options).block);
});

test("hook workspace: hooks.json runs the wrapper through CORTEX_AGY_HOOK and is removed after", () => {
  const repo = makeRepo();
  const hook = writeAgyHookWorkspace({ url: "http://127.0.0.1:1/api/approvals/bridge", token: "tok", repoRoot: repo });
  assert.ok(hook.dir.startsWith(path.join(repo, ".cortex", "agy-approvals")));
  const hooks = JSON.parse(fs.readFileSync(path.join(hook.dir, ".agents", "hooks.json"), "utf8"));
  const handler = hooks["cortex-approvals"].PreToolUse[0];
  assert.equal(handler.matcher, "*");
  assert.equal(handler.hooks[0].command, process.platform === "win32" ? "%CORTEX_AGY_HOOK%" : "\"$CORTEX_AGY_HOOK\"");
  assert.ok(handler.hooks[0].timeout >= 600);
  const wrapper = hook.env.CORTEX_AGY_HOOK.replace(/^"|"$/g, "");
  assert.match(fs.readFileSync(wrapper, "utf8"), /CORTEX_APPROVAL_TOKEN=.?tok/);
  hook.cleanup();
  assert.equal(fs.existsSync(hook.dir), false);
});

test("hook script answers allow / deny and fails closed", async () => {
  let answer = { decision: "approve", by: "desktop" };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.toolName, "run_command");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = { url: process.env.CORTEX_APPROVAL_URL, token: process.env.CORTEX_APPROVAL_TOKEN };
  process.env.CORTEX_APPROVAL_URL = `http://127.0.0.1:${server.address().port}/api/approvals/bridge`;
  process.env.CORTEX_APPROVAL_TOKEN = "t";
  try {
    const input = JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "ls" } } });
    assert.deepEqual(await agyHook.decide(input), { decision: "allow" });
    answer = { decision: "decline", by: "timeout" };
    const declined = await agyHook.decide(input);
    assert.equal(declined.decision, "deny");
    assert.match(declined.reason, /timeout/);
    assert.equal((await agyHook.decide("not json")).decision, "deny");
    process.env.CORTEX_APPROVAL_URL = "http://127.0.0.1:1/api/approvals/bridge";
    assert.equal((await agyHook.decide(input)).decision, "deny");
  } finally {
    process.env.CORTEX_APPROVAL_URL = previous.url || "";
    process.env.CORTEX_APPROVAL_TOKEN = previous.token || "";
    server.close();
  }
});

// ── whole chain: Cortex backend + fake agy + real hook ───────────────────

class MemoryConfig {
  constructor(repoRoot) {
    Object.assign(this, {
      repoRoot, path: "", activeChatId: "", model: "agy:default", modelExplicit: true,
      apiKey: "", geminiApiKey: "", openaiApiKey: "", promptPreset: "code", toolSafetyMode: "write",
      permissionMode: "", assistantMemory: "", contextCarryMessages: 5, geminiSessionId: "",
      codexSessionId: "", activeRuns: [], interruptedRuns: [], recentRepoRoots: [repoRoot],
    });
  }

  save() {}
  reset() {}
  deleteFile() {}
}

class IdleCli {
  constructor() {
    Object.assign(this, { available: true, connected: true, sessionId: "", sessionMode: "fresh" });
  }

  setRepoRoot() {}
  setApiKey() {}
}

function idleApi() {
  return { available: true, connected: false, apiKey: "", setApiKey() {} };
}

async function supervisedTurn(decision) {
  const repo = makeRepo();
  const target = path.join(repo, "hello.txt");
  const fake = makeFakeAgy({ scenario: "write", file: target, content: "hi\n" });
  const service = new DesktopSessionService({
    config: new MemoryConfig(repo),
    repoRoot: repo,
    agyProvider: fakeProvider(repo, fake),
    codexProvider: new IdleCli(),
    claudeProvider: new IdleCli(),
    hermesProvider: new IdleCli(),
    groqProvider: idleApi(),
    geminiProvider: idleApi(),
  });
  const backend = await startBackendServer({ host: "127.0.0.1", port: 0, service });
  try {
    const seen = [];
    for await (const event of service.sendMessageEvents("create hello.txt", { model: "agy:default", repoRoot: repo, permissionMode: "supervised" })) {
      seen.push(event);
      if (event.type === "approval_request") {
        assert.equal(fs.existsSync(target), false, "nothing written before the answer");
        assert.equal(event.approval.kind, "file_change");
        assert.equal(event.approval.path, "hello.txt");
        assert.equal(event.approval.provider, "Antigravity");
        service.respondToApproval({ approvalId: event.approval.id, decision, chatId: event.chatId });
      }
    }
    const audit = service.listAuditEntries(repo, { limit: 100 }).entries.reverse();
    return { repo, target, seen, audit, fake };
  } finally {
    await backend.close();
  }
}

test("supervised agy turn: the hook asks Cortex, approval writes the file and it is audited", async () => {
  const { target, seen, audit, fake, repo } = await supervisedTurn("approve");
  assert.ok(seen.some((event) => event.type === "approval_request"));
  assert.equal(fs.readFileSync(target, "utf8"), "hi\n");
  assert.equal(seen.at(-1).type, "completed");
  assert.match(seen.at(-1).assistantMessage, /Wrote the file/);
  assert.ok(seen.some((event) => event.type === "tool_call" && event.name === "write_file"));
  const actions = audit.map((entry) => entry.action);
  assert.ok(actions.includes("approval_requested"));
  assert.ok(actions.includes("approved"));
  assert.ok(audit.some((entry) => entry.path === "hello.txt" && entry.provider === "Antigravity"), "file change audited from the snapshot diff");
  const turnCall = fake.calls().find((call) => call.stdin);
  assert.ok(turnCall.args.includes("--add-dir"));
  const settings = JSON.parse(turnCall.args[turnCall.args.indexOf("--settings") + 1]);
  assert.deepEqual(settings.permissions.allow, ["command(*)"]);
  // The per-turn hook folder is gone and never counted as a change.
  assert.deepEqual(fs.readdirSync(path.join(repo, ".cortex", "agy-approvals")), []);
  assert.ok(!audit.some((entry) => String(entry.path || "").includes("agy-approvals")));
});

test("supervised agy turn: a declined approval blocks the write", async () => {
  const { target, seen, audit } = await supervisedTurn("decline");
  assert.equal(fs.existsSync(target), false);
  assert.match(seen.at(-1).assistantMessage, /could not write/);
  assert.ok(audit.some((entry) => entry.action === "declined"));
  assert.ok(seen.some((event) => event.type === "tool_result" && event.ok === false));
});
