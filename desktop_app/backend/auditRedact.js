"use strict";

// Masks credentials in free-text audit fields (commands, error details)
// before they are hashed and written. The audit log is meant to leave the
// machine (JSONL export, compliance reports), so a secret that reaches it in
// plaintext is a leak. Redaction is deliberately greedy: a false positive
// costs a little readability, a false negative costs a credential.

const MASK = "[REDACTED]";

// Variable / flag / key names that carry secrets: AWS_SECRET_ACCESS_KEY,
// GITHUB_TOKEN, --password, api_key, client-secret, MYSQL_PWD, ...
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passphrase|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth[_-]?key|session[_-]?key)[A-Za-z0-9_.-]*`;
const VALUE = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'&|;,)}]+`;

function maskValue(value) {
  const quote = value[0] === "\"" || value[0] === "'" ? value[0] : "";
  return `${quote}${MASK}${quote}`;
}

const RULES = [
  // PEM private keys pasted into a command (echo "-----BEGIN ...").
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  // Credentials embedded in URLs: https://user:pass@host, https://<token>@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]{20,}@/gi, `$1${MASK}@`],
  // Authorization header schemes.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`],
  // Well-known token shapes.
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, `sk-${MASK}`],
  [/\b([rsp]k_(?:live|test)_)[A-Za-z0-9]{10,}/g, `$1${MASK}`],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, `$1${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, `github_pat_${MASK}`],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, `glpat-${MASK}`],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, `npm_${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // NAME=value assignments and args: env prefixes, export/set/$env:,
  // --password=..., api_key=..., "token": "...", password: ...
  [new RegExp(String.raw`\b(${SECRET_NAME})(\s*=\s*|"\s*:\s*|\s*:\s+)(${VALUE})`, "gi"),
    (_match, name, separator, value) => `${name}${separator}${maskValue(value)}`],
  // Space-separated flags: --password hunter2, --api-key "abc", -token x
  [new RegExp(String.raw`(\s--?${SECRET_NAME})(\s+)(?!-)(${VALUE})`, "gi"),
    (_match, flag, separator, value) => `${flag}${separator}${maskValue(value)}`],
];

function redactSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

module.exports = { redactSecrets, REDACTION_MASK: MASK };
