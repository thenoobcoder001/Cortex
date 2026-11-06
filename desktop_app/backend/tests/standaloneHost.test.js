const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveBindHost } = require("../start_standalone");

test("standalone backend binds to loopback by default", () => {
  assert.equal(resolveBindHost({ env: {}, config: {} }), "127.0.0.1");
  assert.equal(resolveBindHost({ env: {}, config: { remoteAccessEnabled: false } }), "127.0.0.1");
  assert.equal(resolveBindHost({ env: { CORTEX_REMOTE_ACCESS: "maybe" }, config: {} }), "127.0.0.1");
});

test("standalone backend follows the saved remote-access setting", () => {
  assert.equal(resolveBindHost({ env: {}, config: { remoteAccessEnabled: true } }), "0.0.0.0");
});

test("CORTEX_REMOTE_ACCESS overrides the saved setting either way", () => {
  for (const on of ["1", "true", "YES", " on "]) {
    assert.equal(resolveBindHost({ env: { CORTEX_REMOTE_ACCESS: on }, config: {} }), "0.0.0.0", on);
  }
  for (const off of ["0", "false", "No", "off"]) {
    assert.equal(resolveBindHost({ env: { CORTEX_REMOTE_ACCESS: off }, config: { remoteAccessEnabled: true } }), "127.0.0.1", off);
  }
});
