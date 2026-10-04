// bridge-credential 的单元测试（node:test，不碰真凭证；一律用假值）。
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isHttpUrl,
  isUsableCredential,
  parseCredentialStore,
  isOwnerOnlyMode,
  readCredentialStore,
} = require("./bridge-credential.js");

const GOOD = { gatewayBaseUrl: "https://store.tinchak0207.xyz", apiKey: "sk-biz-test-not-a-real-key" };

test("isHttpUrl: 只收 http(s)，拒 file/javascript/相对路径", () => {
  assert.equal(isHttpUrl("https://a.example"), true);
  assert.equal(isHttpUrl("http://127.0.0.1:8081"), true);
  assert.equal(isHttpUrl("file:///etc/passwd"), false);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("store.example.com"), false);
  assert.equal(isHttpUrl(""), false);
  assert.equal(isHttpUrl(null), false);
});

test("isUsableCredential: 缺栏位/空字串/非物件一律不可用", () => {
  assert.equal(isUsableCredential(GOOD), true);
  assert.equal(isUsableCredential(undefined), false);
  assert.equal(isUsableCredential(null), false);
  assert.equal(isUsableCredential([]), false);
  assert.equal(isUsableCredential("sk-biz-x"), false);
  assert.equal(isUsableCredential({ ...GOOD, gatewayBaseUrl: "" }), false);
  assert.equal(isUsableCredential({ ...GOOD, gatewayBaseUrl: "file:///x" }), false);
  assert.equal(isUsableCredential({ ...GOOD, apiKey: "" }), false);
  assert.equal(isUsableCredential({ ...GOOD, apiKey: "   " }), false);
  assert.equal(isUsableCredential({ gatewayBaseUrl: GOOD.gatewayBaseUrl }), false);
});

test("parseCredentialStore: 坏 JSON 回 null，好 JSON 去空白", () => {
  assert.equal(parseCredentialStore("{ not json"), null);
  assert.equal(parseCredentialStore(""), null);
  assert.equal(parseCredentialStore(null), null);
  assert.equal(parseCredentialStore("[]"), null);
  assert.deepEqual(parseCredentialStore(JSON.stringify(GOOD)), GOOD);
  assert.deepEqual(
    parseCredentialStore(JSON.stringify({ gatewayBaseUrl: " https://a.example ", apiKey: " k " })),
    { gatewayBaseUrl: "https://a.example", apiKey: "k" },
  );
});

test("isOwnerOnlyMode: 0600 可用，0644/0660 一律拒（win32 不适用）", () => {
  assert.equal(isOwnerOnlyMode(0o100600, "linux"), true);
  assert.equal(isOwnerOnlyMode(0o100600, "darwin"), true);
  assert.equal(isOwnerOnlyMode(0o100644, "linux"), false);
  assert.equal(isOwnerOnlyMode(0o100660, "linux"), false);
  assert.equal(isOwnerOnlyMode(undefined, "linux"), false);
  assert.equal(isOwnerOnlyMode(0o100644, "win32"), true);
});

test("readCredentialStore: 档案不存在 ⇒ 静默 null（桥本来就该 OFF，不告警）", () => {
  const warnings = [];
  const result = readCredentialStore("/no/such/device-bridge.json", {
    statSync: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    onWarn: (r) => warnings.push(r),
  });
  assert.equal(result, null);
  assert.deepEqual(warnings, []);
});

test("readCredentialStore: 权限过宽 ⇒ 拒用并告警", () => {
  const warnings = [];
  const result = readCredentialStore("/tmp/x/device-bridge.json", {
    platform: "linux",
    statSync: () => ({ mode: 0o100644 }),
    readFileSync: () => JSON.stringify(GOOD),
    onWarn: (r) => warnings.push(r),
  });
  assert.equal(result, null);
  assert.deepEqual(warnings, ["credential_file_permissions_too_open"]);
});

test("readCredentialStore: 读档失败／内容不合法 ⇒ 拒用并告警，且原因不含 apiKey", () => {
  const warnings = [];
  assert.equal(
    readCredentialStore("/tmp/x/device-bridge.json", {
      platform: "linux",
      statSync: () => ({ mode: 0o100600 }),
      readFileSync: () => {
        throw new Error("EACCES");
      },
      onWarn: (r) => warnings.push(r),
    }),
    null,
  );
  assert.equal(
    readCredentialStore("/tmp/x/device-bridge.json", {
      platform: "linux",
      statSync: () => ({ mode: 0o100600 }),
      readFileSync: () => "{ broken",
      onWarn: (r) => warnings.push(r),
    }),
    null,
  );
  assert.deepEqual(warnings, ["credential_file_unreadable", "credential_file_invalid"]);
  for (const w of warnings) assert.doesNotMatch(w, /sk-biz/);
});

test("readCredentialStore: 正常 0600 档案 ⇒ 回凭证", () => {
  const result = readCredentialStore("/tmp/x/device-bridge.json", {
    platform: "linux",
    statSync: () => ({ mode: 0o100600 }),
    readFileSync: () => JSON.stringify(GOOD),
  });
  assert.deepEqual(result, GOOD);
});
