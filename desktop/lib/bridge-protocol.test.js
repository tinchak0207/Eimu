// desktop/lib/bridge-protocol.test.js
//
// W6b 纯函式测试。跑法：
//   npx --yes tsx --test desktop/lib/bridge-protocol.test.js
//
// 全部用 node:test + node:assert，无外部依赖、无档案 I/O、无网路。

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const proto = require("./bridge-protocol.js");

const HOME = "/home/tester";
const POSIX = { home: HOME, platform: "linux" };

// ---------------------------------------------------------------------------
// 工具白名单
// ---------------------------------------------------------------------------
test("isToolAllowed: 只放行四个唯读工具，其余（含写入/执行类）一律拒", () => {
  for (const t of ["list_dir", "read_file", "grep", "stat"]) assert.equal(proto.isToolAllowed(t), true, t);
  for (const t of ["write_file", "delete", "exec", "shell", "bash", "", null, 1, {}, ["read_file"]]) {
    assert.equal(proto.isToolAllowed(t), false, String(t));
  }
});

test("sanitizeToolArgs: 未知工具回 tool_not_allowed", () => {
  const r = proto.sanitizeToolArgs("exec", { path: `${HOME}/x` }, POSIX);
  assert.equal(r.ok, false);
  assert.equal(r.code, "tool_not_allowed");
});

// ---------------------------------------------------------------------------
// 参数净化：未知栏位剥除 / 夹制 / 必填
// ---------------------------------------------------------------------------
test("sanitizeToolArgs: list_dir 剥除未知栏位、保留白名单栏位", () => {
  const r = proto.sanitizeToolArgs("list_dir", { path: `${HOME}/proj`, foo: 1, cmd: "rm -rf /", max_entries: 5 }, POSIX);
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, { path: `${HOME}/proj`, max_entries: 5 });
  assert.equal("foo" in r.args, false);
  assert.equal("cmd" in r.args, false);
});

test("sanitizeToolArgs: list_dir max_entries 越界（0/2001/非数）一律拒", () => {
  assert.equal(proto.sanitizeToolArgs("list_dir", { path: `${HOME}/p`, max_entries: 0 }, POSIX).ok, false);
  assert.equal(proto.sanitizeToolArgs("list_dir", { path: `${HOME}/p`, max_entries: 2001 }, POSIX).ok, false);
  assert.equal(proto.sanitizeToolArgs("list_dir", { path: `${HOME}/p`, max_entries: "7" }, POSIX).ok, false);
});

test("sanitizeToolArgs: read_file 预设 offset 0、limit 夹到上限且未知栏位剥除", () => {
  const def = proto.sanitizeToolArgs("read_file", { path: `${HOME}/a.txt`, secret: 1 }, POSIX);
  assert.deepEqual(def.args, { path: `${HOME}/a.txt`, offset: 0, limit: proto.DEFAULT_READ_BYTES });
  const big = proto.sanitizeToolArgs("read_file", { path: `${HOME}/a.txt`, limit: 10 * 1024 * 1024 }, POSIX);
  assert.equal(big.args.limit, proto.MAX_READ_BYTES);
  const off = proto.sanitizeToolArgs("read_file", { path: `${HOME}/a.txt`, offset: 128 }, POSIX);
  assert.equal(off.args.offset, 128);
});

test("sanitizeToolArgs: read_file 负 offset / 非整数一律拒", () => {
  assert.equal(proto.sanitizeToolArgs("read_file", { path: `${HOME}/a.txt`, offset: -1 }, POSIX).code, "bad_request");
  assert.equal(proto.sanitizeToolArgs("read_file", { path: `${HOME}/a.txt`, offset: 1.5 }, POSIX).ok, true); // 向下取整
  assert.equal(proto.sanitizeToolArgs("read_file", { path: `${HOME}/a.txt`, offset: "9" }, POSIX).ok, false);
});

test("sanitizeToolArgs: grep 必填 pattern、预设 max_matches=100、未知栏位剥除", () => {
  assert.equal(proto.sanitizeToolArgs("grep", { path: `${HOME}/p` }, POSIX).code, "bad_request");
  const r = proto.sanitizeToolArgs("grep", { path: `${HOME}/p`, pattern: "TODO", extra: "x" }, POSIX);
  assert.deepEqual(r.args, {
    path: `${HOME}/p`,
    pattern: "TODO",
    max_matches: 100,
    max_file_bytes: proto.MAX_FILE_READ_BYTES,
  });
});

test("sanitizeToolArgs: grep 保留并夹制云端下发的 max_file_bytes（取 min，不得比契约松）", () => {
  // 未下发 → 契约上限（与云端 device-bridge-policy.ts:clampFileBytes 同语义）
  const def = proto.sanitizeToolArgs("grep", { path: `${HOME}/p`, pattern: "x" }, POSIX);
  assert.equal(def.args.max_file_bytes, proto.MAX_FILE_READ_BYTES);
  // 云端下发较小值 → 原值保留（本机只能更严，不能放大）
  const small = proto.sanitizeToolArgs("grep", { path: `${HOME}/p`, pattern: "x", max_file_bytes: 64 * 1024 }, POSIX);
  assert.equal(small.args.max_file_bytes, 64 * 1024);
  // 云端下发超大值 → 夹到本机／契约上限
  const big = proto.sanitizeToolArgs("grep", { path: `${HOME}/p`, pattern: "x", max_file_bytes: 64 * 1024 * 1024 }, POSIX);
  assert.equal(big.args.max_file_bytes, proto.MAX_FILE_READ_BYTES);
  // 非法值（0/负/字串）→ 回退契约上限（fail-closed，不放大）
  for (const bad of [0, -1, "1024", null]) {
    assert.equal(
      proto.sanitizeToolArgs("grep", { path: `${HOME}/p`, pattern: "x", max_file_bytes: bad }, POSIX).args.max_file_bytes,
      proto.MAX_FILE_READ_BYTES,
      String(bad),
    );
  }
  // 非 grep 工具不得携带此栏位
  const st = proto.sanitizeToolArgs("stat", { path: `${HOME}/p`, max_file_bytes: 1 }, POSIX);
  assert.equal("max_file_bytes" in st.args, false);
});

test("sanitizeToolArgs: grep max_matches 越界拒", () => {
  assert.equal(proto.sanitizeToolArgs("grep", { path: `${HOME}/p`, pattern: "x", max_matches: 501 }, POSIX).ok, false);
  assert.equal(proto.sanitizeToolArgs("grep", { path: `${HOME}/p`, pattern: "x", max_matches: 500 }, POSIX).ok, true);
});

test("sanitizeToolArgs: stat 只留 path", () => {
  const r = proto.sanitizeToolArgs("stat", { path: `${HOME}/p`, nofollow: true, atime: 1 }, POSIX);
  assert.deepEqual(r.args, { path: `${HOME}/p` });
});

test("sanitizeToolArgs: args 非物件 / path 缺失一律拒", () => {
  assert.equal(proto.sanitizeToolArgs("stat", null, POSIX).code, "bad_request");
  assert.equal(proto.sanitizeToolArgs("stat", "x", POSIX).code, "bad_request");
  assert.equal(proto.sanitizeToolArgs("stat", { path: "  " }, POSIX).code, "bad_request");
});

// ---------------------------------------------------------------------------
// denylist（复用 policy.js isSensitivePath；含 .. 逃逸与前缀混淆）
// ---------------------------------------------------------------------------
test("denyReason: 敏感目录/档案与其下皆拒", () => {
  assert.equal(proto.denyReason(`${HOME}/.ssh/id_rsa`, POSIX), "sensitive_path");
  assert.equal(proto.denyReason(`${HOME}/.aws/credentials`, POSIX), "sensitive_path");
  assert.equal(proto.denyReason(`${HOME}/.gnupg/secring.gpg`, POSIX), "sensitive_path");
  assert.equal(proto.denyReason(`${HOME}/.kube/config`, POSIX), "sensitive_path");
  assert.equal(proto.denyReason(`${HOME}/.docker/config.json`, POSIX), "sensitive_path");
  assert.equal(proto.denyReason(`${HOME}/.config/google-chrome/Default/Login Data`, POSIX), "sensitive_path");
  assert.equal(proto.denyReason(`${HOME}/.mozilla/firefox/x/cookies.sqlite`, POSIX), "sensitive_path");
  assert.equal(proto.denyReason(`${HOME}/.npmrc`, POSIX), "sensitive_path");
  assert.equal(proto.denyReason(`${HOME}/.git-credentials`, POSIX), "sensitive_path");
});

test("denyReason: .. 逃逸先正规化，仍命中 denylist", () => {
  assert.equal(proto.denyReason(`${HOME}/work/../.ssh/id_rsa`, POSIX), "sensitive_path");
  assert.equal(proto.denyReason(`${HOME}/a/b/../../.aws/credentials`, POSIX), "sensitive_path");
});

test("denyReason: 前缀混淆不误命中（.sshfoo/.ssh-backup 是真档名）", () => {
  assert.equal(proto.denyReason(`${HOME}/.sshfoo/id_rsa`, POSIX), null);
  assert.equal(proto.denyReason(`${HOME}/.ssh-backup/x`, POSIX), null);
  assert.equal(proto.denyReason(`${HOME}/.awsbackup/creds`, POSIX), null);
});

test("denyReason: 一般路径放行；空/非字串 fail-closed", () => {
  assert.equal(proto.denyReason(`${HOME}/Documents/notes.txt`, POSIX), null);
  assert.equal(proto.denyReason("/tmp/eimu/clip.mp4", POSIX), null);
  assert.equal(proto.denyReason("", POSIX), "bad_path");
  assert.equal(proto.denyReason("   ", POSIX), "bad_path");
  assert.equal(proto.denyReason(null, POSIX), "bad_path");
});

test("sanitizeToolArgs: 敏感路径在净化阶段就被挡（sensitive_path）", () => {
  const r = proto.sanitizeToolArgs("read_file", { path: `${HOME}/.ssh/id_rsa` }, POSIX);
  assert.equal(r.ok, false);
  assert.equal(r.code, "sensitive_path");
});

// ---------------------------------------------------------------------------
// 大小夹制与截断标记
// ---------------------------------------------------------------------------
test("clampResult: 未超限原样回传且 truncated=false", () => {
  const s = "hello world";
  const r = proto.clampResult(s, 1024);
  assert.equal(r.truncated, false);
  assert.equal(r.result.text, s);
  assert.equal(r.bytes, Buffer.byteLength(s));
});

test("clampResult: 超限截断、附标记、bytes <= 上限", () => {
  const payload = "A".repeat(5000);
  const r = proto.clampResult(payload, 100);
  assert.equal(r.truncated, true);
  assert.ok(r.bytes <= 100);
  assert.match(r.result.text, /…\[truncated \d+ bytes\]$/);
  assert.equal(r.result.truncated, true);
});

test("clampResult: UTF-8 边界安全（多位元组不被切出 U+FFFD）", () => {
  const payload = "中".repeat(1000); // 每字 3 bytes
  const r = proto.clampResult(payload, 100); // 100 不是 3 的倍数 → 必然切在中间
  assert.equal(r.truncated, true);
  assert.equal(r.result.text.includes("\uFFFD"), false);
  assert.ok(r.bytes <= 100);
  assert.match(r.result.text, /…\[truncated \d+ bytes\]$/);
});

test("clampResult: 物件含 text 栏位只夹 text，保留后设栏位", () => {
  const r = proto.clampResult({ path: "/x", offset: 3, text: "B".repeat(4000) }, 64);
  assert.equal(r.truncated, true);
  assert.equal(r.result.path, "/x");
  assert.equal(r.result.offset, 3);
  assert.match(r.result.text, /…\[truncated \d+ bytes\]$/);
  assert.ok(Number.isInteger(r.result.truncated_bytes) && r.result.truncated_bytes > 0);
});

test("clampResult: 物件无 text 时走 JSON 序列化夹制", () => {
  const big = { entries: Array.from({ length: 500 }, (_, i) => ({ name: `file-${i}`, type: "file" })) };
  const r = proto.clampResult(big, 256);
  assert.equal(r.truncated, true);
  assert.equal(r.result.truncated, true);
  assert.match(r.result.text, /…\[truncated \d+ bytes\]$/);
  const small = proto.clampResult({ a: 1 }, 1024);
  assert.equal(small.truncated, false);
  assert.deepEqual(small.result, { a: 1 });
});

test("clampResult: maxBytes 非法/超硬上限 → 夹到 MAX_RESULT_BYTES", () => {
  const r = proto.clampResult("z".repeat(proto.MAX_RESULT_BYTES + 10), 10 * 1024 * 1024);
  assert.equal(r.truncated, true);
  assert.ok(r.bytes <= proto.MAX_RESULT_BYTES);
});

// ---------------------------------------------------------------------------
// 退避
// ---------------------------------------------------------------------------
test("nextBackoff: 指数成长且 0 起算 = baseMs", () => {
  assert.equal(proto.nextBackoff(0), 1000);
  assert.equal(proto.nextBackoff(1), 2000);
  assert.equal(proto.nextBackoff(2), 4000);
  assert.equal(proto.nextBackoff(3), 8000);
});

test("nextBackoff: 上界封顶（不随 attempt 无限成长）", () => {
  assert.ok(proto.nextBackoff(100) <= proto.DEFAULT_BACKOFF.maxMs);
  assert.equal(proto.nextBackoff(100), proto.DEFAULT_BACKOFF.maxMs);
  assert.ok(proto.nextBackoff(1e9, { maxMs: 5000 }) <= 5000);
});

test("nextBackoff: 非法 attempt/选项回退安全值", () => {
  assert.equal(proto.nextBackoff(-5), 1000);
  assert.equal(proto.nextBackoff(NaN), 1000);
  assert.equal(proto.nextBackoff(Infinity, { maxMs: 4000 }), 1000); // 非有限 attempt → 视为 0
  assert.equal(proto.nextBackoff(2, { baseMs: 0, factor: 0 }), proto.DEFAULT_BACKOFF.baseMs * 4); // 非法值回退预设（2^2）
});

test("nextBackoff: jitter 只在延迟上加量且仍封顶", () => {
  for (let i = 0; i < 50; i += 1) {
    const d = proto.nextBackoff(3, { jitterRatio: 0.2 });
    assert.ok(d >= 8000 && d <= proto.DEFAULT_BACKOFF.maxMs);
  }
  for (let i = 0; i < 50; i += 1) {
    assert.ok(proto.nextBackoff(100, { jitterRatio: 1 }) <= proto.DEFAULT_BACKOFF.maxMs);
  }
});
