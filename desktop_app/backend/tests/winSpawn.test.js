"use strict";
const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const os     = require("node:os");
const path   = require("node:path");
const { spawnSync } = require("node:child_process");

const platform = require("../platform");

// Arguments that break naive cmd.exe quoting: metacharacters, env-var
// expansion, embedded quotes, trailing backslashes and the empty string.
const TRICKY_ARGS = [
  "plain",
  "a b",
  "a&b",
  "a|b",
  "q\"uo\"te",
  "%PATH%",
  "%%",
  "trail\\",
  "tr ail\\",
  "x^y",
  "!bang!",
  "",
  "(p)",
  "<in>",
  "Bash,Read,Write",
  "C:\\Program Files\\x",
  "back\\\"slash",
  "a;b=c",
  "*?",
  "`tick`",
  "--model",
  "claude-opus-4-5",
];

test("escapeCmdArg quotes and caret-escapes cmd metacharacters", () => {
  assert.equal(platform.escapeCmdArg("plain"), "^\"plain^\"");
  assert.equal(platform.escapeCmdArg(""), "^\"^\"");
  assert.equal(platform.escapeCmdArg("a&b"), "^\"a^&b^\"");
  assert.equal(platform.escapeCmdArg("%PATH%"), "^\"^%PATH^%^\"");
  assert.equal(platform.escapeCmdArg("a b"), "^\"a^ b^\"");
});

test("escapeCmdArg doubles backslashes before quotes and at the end", () => {
  // MSVCRT rules: `\"` → `\\\"`, trailing `\` → `\\` before the closing quote.
  assert.equal(platform.escapeCmdArg("x\\\"y"), "^\"x\\\\\\^\"y^\"");
  assert.equal(platform.escapeCmdArg("dir\\"), "^\"dir\\\\^\"");
});

test("escapeCmdArg double-escapes for batch shims", () => {
  assert.equal(platform.escapeCmdArg("a&b", { doubleEscape: true }), "^^^\"a^^^&b^^^\"");
});

test("escapeCmdCommand quotes paths with spaces", () => {
  assert.equal(
    platform.escapeCmdCommand("C:\\Program Files\\nodejs\\npx.cmd"),
    "^\"C:\\Program^ Files\\nodejs\\npx.cmd^\"",
  );
});

test("windowsSpawnSpec spawns .exe directly without a shell", () => {
  const spec = platform.windowsSpawnSpec("C:\\tools\\codex.exe", ["--version", "a&b"]);
  assert.equal(spec.file, "C:\\tools\\codex.exe");
  assert.deepEqual(spec.args, ["--version", "a&b"]);
  assert.equal(spec.options.windowsVerbatimArguments, undefined);
});

test("windowsSpawnSpec routes .cmd shims through cmd.exe /d /s /c", () => {
  const spec = platform.windowsSpawnSpec("C:\\npm\\claude.cmd", ["--version"]);
  assert.match(spec.file, /cmd(\.exe)?$/i);
  assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
  // Program path escaped once; args escaped twice because the shim's %*
  // expansion is parsed by cmd.exe a second time.
  assert.equal(spec.args[3], "\"^\"C:\\npm\\claude.cmd^\" ^^^\"--version^^^\"\"");
  assert.equal(spec.options.windowsVerbatimArguments, true);
});

test("windowsSpawnSpec rejects newlines in arguments sent through cmd.exe", () => {
  assert.throws(() => platform.windowsSpawnSpec("C:\\npm\\claude.cmd", ["a\nb"]), /newlines/);
  // .exe targets get proper argv, so multi-line text is fine there.
  assert.doesNotThrow(() => platform.windowsSpawnSpec("C:\\x\\hermes.exe", ["a\nb"]));
});

// Real round trip: run an npm-style .cmd shim from a directory whose name has
// spaces and metacharacters, and check node sees exactly the args we sent.
test("windowsSpawnSpec round-trips tricky args through a .cmd shim and an .exe", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd test (x)&y "));
  try {
    fs.writeFileSync(path.join(dir, "echo.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    fs.writeFileSync(
      path.join(dir, "echo shim.cmd"),
      // Same shape as the shims npm writes for global CLIs.
      `@ECHO off\r\n"${process.execPath}" "%~dp0\\echo.js" %*\r\n`,
    );
    const cases = [
      { command: path.join(dir, "echo shim.cmd"), args: TRICKY_ARGS },
      { command: process.execPath, args: [path.join(dir, "echo.js"), ...TRICKY_ARGS] },
    ];
    for (const { command, args } of cases) {
      const spec = platform.windowsSpawnSpec(command, args);
      const result = spawnSync(spec.file, spec.args, { ...spec.options, encoding: "utf8" });
      assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), TRICKY_ARGS, `args mangled for ${command}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
