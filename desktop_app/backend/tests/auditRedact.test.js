"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { redactSecrets } = require("../auditRedact");
const { AuditStore } = require("../auditStore");
const { ToolExecutor } = require("../toolExecutor");
const { RepoFileService } = require("../fileService");

// Built at runtime so the repo itself never contains token-shaped literals
// that secret scanners would flag.
const fake = {
  aws: `AKIA${"ABCDEFGHIJKLMNOP"}`,
  ghp: `ghp_${"a1B2c3D4e5".repeat(4)}`,
  ghPat: `github_pat_${"11ABCDEFG0".repeat(3)}`,
  openai: `sk-proj-${"Xy9".repeat(12)}`,
  anthropic: `sk-ant-api03-${"Qw8".repeat(12)}`,
  stripe: `sk_live_${"9z".repeat(12)}`,
  google: `AIza${"S".repeat(35)}`,
  slack: `xoxb-${"1234567890"}-abcdefghij`,
  jwt: `eyJ${"hbGciOiJI"}.eyJ${"zdWIiOiIx"}.${"c2lnbmF0dXJl"}`,
};

const cases = [
  ["env assignment prefix", `AWS_SECRET_ACCESS_KEY=supersecretvalue npm run deploy`, ["supersecretvalue"]],
  ["AWS key id", `aws configure set aws_access_key_id ${fake.aws}`, [fake.aws]],
  ["GitHub PAT in remote URL", `git remote set-url origin https://user:${fake.ghp}@github.com/acme/app.git`, [fake.ghp]],
  ["token-only URL userinfo", `git clone https://${fake.ghp}@github.com/acme/app.git`, [fake.ghp]],
  ["fine-grained PAT", `gh auth login --with-token ${fake.ghPat}`, [fake.ghPat]],
  ["OpenAI key", `OPENAI_API_KEY=${fake.openai} codex`, [fake.openai]],
  ["Anthropic key bare", `claude --key ${fake.anthropic}`, [fake.anthropic]],
  ["Stripe key", `stripe login --api-key ${fake.stripe}`, [fake.stripe]],
  ["Google key", `gcloud x --key=${fake.google}`, [fake.google]],
  ["Slack token", `notify ${fake.slack}`, [fake.slack]],
  ["JWT", `use ${fake.jwt}`, [fake.jwt]],
  ["Bearer header", `curl -H "Authorization: Bearer abc123def456ghi" https://api`, ["abc123def456ghi"]],
  ["Basic header", `http GET api Authorization:"Basic dXNlcjpwYXNzd29yZA=="`, ["dXNlcjpwYXNzd29yZA=="]],
  ["password= arg", `mysql --password=hunter2hunter -u root`, ["hunter2hunter"]],
  ["token= query arg", `deploy token=t0ps3cr3t region=eu`, ["t0ps3cr3t"]],
  ["api_key= arg", `run.sh api_key=abcd1234 --verbose`, ["abcd1234"]],
  ["space-separated flag", `psql --password "my pass phrase" db`, ["my pass phrase"]],
  ["export", `export GITHUB_TOKEN=plainvalue123 && gh pr list`, ["plainvalue123"]],
  ["PowerShell env", `$env:DB_PASSWORD="quoted-secret"; npm start`, ["quoted-secret"]],
  ["cmd set", `set NPM_TOKEN=npmsecretvalue&& npm publish`, ["npmsecretvalue"]],
  ["JSON body", `curl -d '{"client_secret": "jsonsecret99"}' x`, ["jsonsecret99"]],
  ["PEM key", `echo "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----" > k`, ["MIIEow"]],
];

for (const [label, input, secrets] of cases) {
  test(`redactSecrets masks ${label}`, () => {
    const out = redactSecrets(input);
    for (const secret of secrets) assert.ok(!out.includes(secret), `${label} leaked: ${out}`);
    assert.match(out, /\[REDACTED\]/);
  });
}

test("redactSecrets leaves ordinary commands alone", () => {
  for (const command of [
    "npm run lint && npm test",
    "git commit -m \"fix: token refresh\"",
    "git log --author=chirag --oneline",
    "node build.js --mode=production",
    "cd src && ls -la",
  ]) {
    assert.equal(redactSecrets(command), command);
  }
});

test("secrets never reach audit.jsonl and the chain still verifies", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-audit-redact-"));
  const store = new AuditStore(repoRoot);
  const executor = new ToolExecutor(new RepoFileService(repoRoot), repoRoot);
  executor.onAudit = (entry) => store.record(entry);

  const commands = [
    `AWS_SECRET_ACCESS_KEY=${fake.aws}SECRET npm run deploy`,
    `git remote set-url origin https://user:${fake.ghp}@github.com/acme/app.git`,
  ];
  executor.readOnly = true; // audited without actually running anything
  for (const command of commands) {
    await executor.executeWithMetadata("run_terminal_command", { command });
  }
  store.record({ action: "run_command", command: "x", success: false, detail: `spawn failed: Bearer ${"t".repeat(20)}` });

  const raw = fs.readFileSync(path.join(repoRoot, ".cortex", "audit", "audit.jsonl"), "utf8");
  assert.ok(!raw.includes(fake.aws));
  assert.ok(!raw.includes(fake.ghp));
  assert.ok(!raw.includes("t".repeat(20)));
  assert.match(raw, /AWS_SECRET_ACCESS_KEY=\[REDACTED\] npm run deploy/);
  assert.equal(store.verify().ok, true);
});
