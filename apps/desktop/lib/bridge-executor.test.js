// desktop/lib/bridge-executor.test.js
//
// W6b 执行器测试（**真正读档的危险路径**）。跑法：
//   npx --yes tsx --test desktop/lib/bridge-executor.test.js
//
// 用 node:test + node:assert，真暂存目录（真档案系统行为）＋注入计数版 fs。
// 这补上先前「所有绿灯只测纯函式复本、executeTool/requireLocalPath 零测试」的自欺。

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBridgeExecutor, isFsRoot, MAX_GREP_FILE_BYTES } = require("./bridge-executor.js");
const { HARD_DENY_PATTERNS, SAFETY_CHECK_FILES, SAFETY_CHECK_DIRS } = require("./permission-rules.js");
const policy = require("./policy.js");

function makeTempRoot() {
  return nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "eimu-bridge-exec-")));
}

function rmrf(p) {
  nodeFs.rmSync(p, { recursive: true, force: true });
}

/** 注入用 fs：预设 node:fs，另记录 readFileSync/statSync 被呼叫的路径。 */
function countingFs() {
  const calls = { readFileSync: [], statSync: [] };
  const fs = { ...nodeFs };
  fs.readFileSync = (p, ...a) => {
    calls.readFileSync.push(String(p));
    return nodeFs.readFileSync(p, ...a);
  };
  fs.statSync = (p, ...a) => {
    calls.statSync.push(String(p));
    return nodeFs.statSync(p, ...a);
  };
  return { fs, calls };
}

function isCode(code) {
  return (err) => err && err.code === code;
}

// ---------------------------------------------------------------------------
// H1：allowlist 必填，空集 = 全拒
// ---------------------------------------------------------------------------
test("H1: 空 allowlist ⇒ 一律拒（no_authorized_roots），不得退回只验 denylist", async () => {
  const root = makeTempRoot();
  try {
    const f = path.join(root, "a.txt");
    nodeFs.writeFileSync(f, "hi");
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [] });
    assert.throws(() => ex.requireLocalPath(f), isCode("no_authorized_roots"));
    await assert.rejects(ex.executeTool("read_file", { path: f }), isCode("no_authorized_roots"));
    await assert.rejects(ex.executeTool("grep", { path: root, pattern: "hi" }), isCode("no_authorized_roots"));
  } finally {
    rmrf(root);
  }
});

test("H1: 未提供 roots（undefined）⇒ 视为空集全拒", () => {
  const root = makeTempRoot();
  try {
    const f = path.join(root, "a.txt");
    nodeFs.writeFileSync(f, "hi");
    const ex = createBridgeExecutor({ fs: nodeFs });
    assert.throws(() => ex.requireLocalPath(f), isCode("no_authorized_roots"));
  } finally {
    rmrf(root);
  }
});

// ---------------------------------------------------------------------------
// H3：家目录外敏感路径
// ---------------------------------------------------------------------------
test("H3: 家目录外敏感路径 ⇒ 拒（sensitive_path）", () => {
  const ex = createBridgeExecutor({ fs: nodeFs, roots: ["/tmp"] });
  for (const p of [
    "/tmp/x/.ssh/id_rsa",
    "/home/otheruser/.ssh/id_rsa",
    "/mnt/data/proj/.ssh/id_rsa",
    "/mnt/data/proj/.aws/credentials",
    "/etc-eimu/.gnupg/secring.gpg",
  ]) {
    assert.throws(() => ex.requireLocalPath(p), isCode("sensitive_path"), p);
  }
});

test("H3: 授权根之下仍不得放行敏感路径", () => {
  const root = makeTempRoot();
  try {
    nodeFs.mkdirSync(path.join(root, ".ssh"), { recursive: true });
    const key = path.join(root, ".ssh", "id_rsa");
    nodeFs.writeFileSync(key, "key");
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root] });
    assert.throws(() => ex.requireLocalPath(key), isCode("sensitive_path"));
  } finally {
    rmrf(root);
  }
});

test("symlink: 授权根内指到敏感位置的 symlink ⇒ 解 realpath 后拒", () => {
  const root = makeTempRoot();
  const outside = makeTempRoot();
  try {
    nodeFs.mkdirSync(path.join(outside, ".ssh"), { recursive: true });
    const secret = path.join(outside, ".ssh", "id_rsa");
    nodeFs.writeFileSync(secret, "k");
    const link = path.join(root, "innocent.txt");
    nodeFs.symlinkSync(secret, link);
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root] });
    assert.throws(() => ex.requireLocalPath(link), isCode("sensitive_path"));
  } finally {
    rmrf(root);
    rmrf(outside);
  }
});

// ---------------------------------------------------------------------------
// H2：递回收集剪掉敏感段
// ---------------------------------------------------------------------------
test("H2: 父目录含敏感段的递回收集 ⇒ 敏感档被排除", () => {
  const root = makeTempRoot();
  try {
    nodeFs.writeFileSync(path.join(root, "normal.txt"), "NEEDLE here\n");
    nodeFs.mkdirSync(path.join(root, ".ssh"), { recursive: true });
    nodeFs.writeFileSync(path.join(root, ".ssh", "id_rsa"), "NEEDLE secret\n");
    nodeFs.mkdirSync(path.join(root, "sub"), { recursive: true });
    nodeFs.writeFileSync(path.join(root, "sub", "ok.txt"), "NEEDLE sub\n");
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root] });
    const res = ex.toolGrep({ path: root, pattern: "NEEDLE" });
    const hit = res.matches.map((m) => m.path);
    assert.ok(hit.some((p) => p.endsWith("normal.txt")));
    assert.ok(hit.some((p) => p.endsWith("ok.txt")));
    assert.equal(hit.some((p) => p.includes(".ssh")), false, "敏感段不得被收集/读取");
  } finally {
    rmrf(root);
  }
});

// ---------------------------------------------------------------------------
// M3：单档大小上限 + 档案系统根拒绝
// ---------------------------------------------------------------------------
test("M3: 超过单档大小上限 ⇒ 跳过并标记，且不整档读入记忆体", () => {
  const root = makeTempRoot();
  try {
    const big = path.join(root, "big.txt");
    nodeFs.writeFileSync(big, Buffer.concat([Buffer.from("NEEDLE\n"), Buffer.alloc(MAX_GREP_FILE_BYTES + 16, 0x41)]));
    nodeFs.writeFileSync(path.join(root, "small.txt"), "NEEDLE small\n");
    const { fs, calls } = countingFs();
    const ex = createBridgeExecutor({ fs, roots: [root] });
    const res = ex.toolGrep({ path: root, pattern: "NEEDLE" });
    assert.equal(res.skipped_large_files, 1);
    assert.ok(res.matches.some((m) => m.path.endsWith("small.txt")));
    assert.equal(res.matches.some((m) => m.path.endsWith("big.txt")), false);
    assert.equal(calls.readFileSync.some((p) => p.endsWith("big.txt")), false, "大档不得被 readFileSync");
  } finally {
    rmrf(root);
  }
});

test("M3: path='/'（档案系统根）⇒ 拒（path_is_root）", () => {
  assert.equal(isFsRoot("/"), true);
  assert.equal(isFsRoot("/tmp"), false);
  const ex = createBridgeExecutor({ fs: nodeFs, roots: ["/tmp"] });
  assert.throws(() => ex.requireLocalPath("/"), isCode("path_is_root"));
});

// ---------------------------------------------------------------------------
// H2 输入侧：grep 逐档上限 = min(云端下发 max_file_bytes, 本机上限)
// ---------------------------------------------------------------------------
test("H2: grep 真的用 max_file_bytes（超过即跳过且不读档；云端大值被本机夹住）", () => {
  const root = makeTempRoot();
  try {
    const medium = path.join(root, "medium.txt");
    nodeFs.writeFileSync(medium, `NEEDLE${"x".repeat(4096)}`); // ~4KB
    const { fs, calls } = countingFs();
    const ex = createBridgeExecutor({ fs, roots: [root] });

    // 未带 max_file_bytes → 本机上限（1MB），4KB 档可读
    const all = ex.toolGrep({ path: root, pattern: "NEEDLE" });
    assert.equal(all.skipped_large_files, 0);
    assert.ok(all.matches.some((m) => m.path.endsWith("medium.txt")));

    // 云端下发 64 bytes → 4KB 档被跳过，且不得 readFileSync（不整档入记忆体）
    calls.readFileSync.length = 0;
    const capped = ex.toolGrep({ path: root, pattern: "NEEDLE", max_file_bytes: 64 });
    assert.equal(capped.skipped_large_files, 1);
    assert.equal(capped.matches.some((m) => m.path.endsWith("medium.txt")), false);
    assert.equal(calls.readFileSync.some((p) => p.endsWith("medium.txt")), false);

    // 云端下发超大值 → 被本机上限夹住（不得比契约松）
    const clamped = ex.toolGrep({ path: root, pattern: "NEEDLE", max_file_bytes: 64 * 1024 * 1024 });
    assert.equal(clamped.skipped_large_files, 0);
    assert.ok(clamped.matches.some((m) => m.path.endsWith("medium.txt")));
  } finally {
    rmrf(root);
  }
});

// ---------------------------------------------------------------------------
// H2 契约面第二层：grep/list_dir 自报敏感触碰
// ---------------------------------------------------------------------------
test("H2: grep 递回碰到敏感段 ⇒ 自报 excluded_sensitive_count / sensitive_path_touched", () => {
  const root = makeTempRoot();
  const clean = makeTempRoot();
  try {
    nodeFs.writeFileSync(path.join(root, "ok.txt"), "NEEDLE\n");
    nodeFs.mkdirSync(path.join(root, ".ssh"), { recursive: true });
    nodeFs.writeFileSync(path.join(root, ".ssh", "id_rsa"), "NEEDLE secret\n");
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root] });
    const res = ex.toolGrep({ path: root, pattern: "NEEDLE" });
    assert.equal(res.excluded_sensitive_count, 1);
    assert.equal(res.sensitive_path_touched, true);
    assert.equal(res.matches.some((m) => m.path.includes(".ssh")), false);

    nodeFs.writeFileSync(path.join(clean, "a.txt"), "NEEDLE\n");
    const ex2 = createBridgeExecutor({ fs: nodeFs, roots: [clean] });
    const res2 = ex2.toolGrep({ path: clean, pattern: "NEEDLE" });
    assert.equal(res2.excluded_sensitive_count, 0);
    assert.equal(res2.sensitive_path_touched, false);
  } finally {
    rmrf(root);
    rmrf(clean);
  }
});

test("H2: list_dir 敏感 entry 不进回传并自报计数", () => {
  const root = makeTempRoot();
  try {
    nodeFs.writeFileSync(path.join(root, "a.txt"), "a");
    nodeFs.mkdirSync(path.join(root, ".ssh"), { recursive: true });
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root] });
    const res = ex.toolListDir({ path: root });
    assert.equal(res.entries.some((e) => e.name === ".ssh"), false);
    assert.equal(res.excluded_sensitive_count, 1);
    assert.equal(res.sensitive_path_touched, true);
  } finally {
    rmrf(root);
  }
});

// ---------------------------------------------------------------------------
// allowlist 边界 / 工具白名单 / 一般操作
// ---------------------------------------------------------------------------
test("allowlist: 授权根外的一般路径 ⇒ not_authorized", () => {
  const root = makeTempRoot();
  const other = makeTempRoot();
  try {
    const f = path.join(other, "x.txt");
    nodeFs.writeFileSync(f, "x");
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root] });
    assert.throws(() => ex.requireLocalPath(f), isCode("not_authorized"));
  } finally {
    rmrf(root);
    rmrf(other);
  }
});

test("requireLocalPath: 授权根内不存在的路径 ⇒ not_found", () => {
  const root = makeTempRoot();
  try {
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root] });
    assert.throws(() => ex.requireLocalPath(path.join(root, "nope.txt")), isCode("not_found"));
  } finally {
    rmrf(root);
  }
});

test("executeTool: 未知工具 ⇒ tool_not_allowed（无任何写/删/执行工具）", async () => {
  const ex = createBridgeExecutor({ fs: nodeFs, roots: ["/tmp"] });
  await assert.rejects(ex.executeTool("exec", { path: "/tmp" }), isCode("tool_not_allowed"));
  await assert.rejects(ex.executeTool("write_file", { path: "/tmp" }), isCode("tool_not_allowed"));
});

test("read_file: offset/limit 生效且 limit 夹到硬上限", async () => {
  const root = makeTempRoot();
  try {
    const f = path.join(root, "a.txt");
    nodeFs.writeFileSync(f, "0123456789");
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root] });
    const r = await ex.executeTool("read_file", { path: f, offset: 2, limit: 3 });
    assert.equal(r.text, "234");
    assert.equal(r.bytes_read, 3);
    const big = await ex.executeTool("read_file", { path: f, limit: 10 * 1024 * 1024 });
    assert.equal(big.limit, 256 * 1024);
  } finally {
    rmrf(root);
  }
});

test("list_dir/stat: 授权根内正常运作", async () => {
  const root = makeTempRoot();
  try {
    nodeFs.writeFileSync(path.join(root, "a.txt"), "a");
    nodeFs.mkdirSync(path.join(root, "d"));
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root] });
    const ld = await ex.executeTool("list_dir", { path: root });
    assert.ok(ld.entries.some((e) => e.name === "a.txt" && e.type === "file"));
    assert.ok(ld.entries.some((e) => e.name === "d" && e.type === "dir"));
    const st = await ex.executeTool("stat", { path: path.join(root, "a.txt") });
    assert.equal(st.type, "file");
    assert.equal(st.size, 1);
  } finally {
    rmrf(root);
  }
});

// ---------------------------------------------------------------------------
// 第二道防线（W6c）：permission-rules.evaluatePermission 在执行前独立复核
// 即使 gateway 端放行（喂 allow 规则 ＋ mode=full）本机仍自行拒绝。
// ---------------------------------------------------------------------------

/** 给定设定（home=授权根）＋一个「放行一切」的 allow 规则的执行器。 */
function defenseExecutor(home, mode = "full") {
  return createBridgeExecutor({
    fs: nodeFs,
    roots: [home],
    mode,
    // 工具级规则在 matchSpecifier 会回 false，故用 `//**`（任意绝对路径）确保 allow 真的命中。
    rules: { allow: ["read_file(//**)"] },
    home,
  });
}

/** 依 HARD_DENY_PATTERN 的 kind 构造一条命中用路径。 */
function hardDenyCasePath(p, home) {
  if (p.kind === "home-dir") return `${home}/${p.pattern.slice(2)}/x.txt`;
  if (p.kind === "home-file") return `${home}/${p.pattern.slice(2)}`;
  if (p.kind === "abs-file") return p.pattern;
  if (p.kind === "abs-glob") return "/proc/1234/environ";
  if (p.kind === "basename-glob") return `${home}/proj/${p.pattern.replace(/\*/g, "x")}`;
  return `${home}/proj/${p.pattern}`; // basename-exact
}

test("第二道防线：硬 denylist 逐样式，gateway 放行（allow 规则＋mode=full）仍 deny", () => {
  const home = makeTempRoot();
  try {
    const ex = defenseExecutor(home, "full");
    assert.ok(HARD_DENY_PATTERNS.length >= 20, "硬 denylist 应有完整样式");
    for (const p of HARD_DENY_PATTERNS) {
      const casePath = hardDenyCasePath(p, home);
      assert.throws(
        () => ex.enforcePermission("read_file", casePath, casePath),
        (err) => err && err.code === "permission_denied",
        `${p.kind}: ${p.pattern} → ${casePath}`,
      );
    }
  } finally {
    rmrf(home);
  }
});

test("第二道防线：safety-check 档案/目录逐条，gateway 放行仍 ask（needs_authorization）", () => {
  const home = makeTempRoot();
  try {
    const ex = defenseExecutor(home, "full");
    for (const f of SAFETY_CHECK_FILES) {
      const p = `${home}/${f}`;
      assert.throws(
        () => ex.enforcePermission("read_file", p, p),
        (err) => err && err.code === "needs_authorization",
        `safety file: ${f}`,
      );
    }
    for (const d of SAFETY_CHECK_DIRS) {
      const p = `${home}/${d}/x.txt`;
      assert.throws(
        () => ex.enforcePermission("read_file", p, p),
        (err) => err && err.code === "needs_authorization",
        `safety dir: ${d}`,
      );
    }
  } finally {
    rmrf(home);
  }
});

test("第二道防线（执行路径）：授权根内硬 denylist 档（x.pem）即使 mode=full 也被拒", async () => {
  const root = makeTempRoot();
  try {
    const pem = path.join(root, "x.pem");
    nodeFs.writeFileSync(pem, "-----BEGIN KEY-----");
    const ex = defenseExecutor(root, "full");
    // policy.isSensitivePath 不含 *.pem ⇒ 必须由第二道防线拦下（证明不是靠第一层）。
    assert.equal(policy.isSensitivePath(pem), false, "前提：policy denylist 不挡 *.pem");
    await assert.rejects(ex.executeTool("read_file", { path: pem }), (err) => err && err.code === "permission_denied");
  } finally {
    rmrf(root);
  }
});

test("第二道防线（执行路径）：授权根内 .bashrc ⇒ needs_authorization（ask，不执行）", async () => {
  const root = makeTempRoot();
  try {
    const bashrc = path.join(root, ".bashrc");
    nodeFs.writeFileSync(bashrc, "export X=1\n");
    const ex = defenseExecutor(root, "auto");
    await assert.rejects(ex.executeTool("read_file", { path: bashrc }), (err) => err && err.code === "needs_authorization");
  } finally {
    rmrf(root);
  }
});

test("第二道防线（模式语义）：mode=ask 对一般档也 ask；mode=auto 授权根内放行", async () => {
  const root = makeTempRoot();
  try {
    const f = path.join(root, "normal.txt");
    nodeFs.writeFileSync(f, "hi");
    const askEx = createBridgeExecutor({ fs: nodeFs, roots: [root], mode: "ask" });
    await assert.rejects(askEx.executeTool("read_file", { path: f }), (err) => err && err.code === "needs_authorization");

    const autoEx = createBridgeExecutor({ fs: nodeFs, roots: [root], mode: "auto" });
    const r = await autoEx.executeTool("read_file", { path: f });
    assert.equal(r.text, "hi");
  } finally {
    rmrf(root);
  }
});

test("第二道防线（模式语义）：mode=off 一律拒（deny，先于一切）", async () => {
  const root = makeTempRoot();
  try {
    const f = path.join(root, "normal.txt");
    nodeFs.writeFileSync(f, "hi");
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root], mode: "off" });
    await assert.rejects(ex.executeTool("read_file", { path: f }), (err) => err && err.code === "permission_denied");
  } finally {
    rmrf(root);
  }
});

test("第二道防线：grep/list_dir 不会曝露或读入硬 denylist 档（.env）", async () => {
  const root = makeTempRoot();
  try {
    nodeFs.writeFileSync(path.join(root, "ok.txt"), "NEEDLE\n");
    nodeFs.writeFileSync(path.join(root, ".env"), "NEEDLE=secret\n");
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root], mode: "auto" });
    const g = ex.toolGrep({ path: root, pattern: "NEEDLE" });
    assert.equal(g.matches.some((m) => m.path.endsWith(".env")), false, "硬 denylist 档不得被读入");
    assert.ok(g.excluded_sensitive_count >= 1, "应自报排除硬 denylist 档");
    const ld = ex.toolListDir({ path: root });
    assert.equal(ld.entries.some((e) => e.name === ".env"), false, "硬 denylist 档不得曝露于 list_dir");
  } finally {
    rmrf(root);
  }
});

// ---------------------------------------------------------------------------
// grantedRoots（对话内就地授权）：mode=ask 下已同意的根放行；未同意仍 needs_authorization；
// 硬 denylist 不得被绕过。
// ---------------------------------------------------------------------------
test("grantedRoots：mode=ask 下，已同意的根（同/子路径）走 rule_allow 放行", async () => {
  const parent = makeTempRoot();
  try {
    const sub = path.join(parent, "sub");
    nodeFs.mkdirSync(sub);
    nodeFs.writeFileSync(path.join(sub, "a.txt"), "hi");
    // 既有 allowlist 只有 sub（使用者 pickFiles 挑的根）；同意根是 parent（对话内授权）。
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [sub], mode: "ask", home: parent });
    // 未同意：sub 虽在 allowlist，mode=ask ⇒ needs_authorization
    await assert.rejects(
      ex.executeTool("list_dir", { path: sub }),
      (err) => err && err.code === "needs_authorization",
    );
    // 同意 parent 后：sub 内放行（当次请求即生效）
    const ok = await ex.executeTool("list_dir", { path: sub }, { grantedRoots: [parent] });
    assert.ok(Array.isArray(ok.entries));
    // parent 本身亦在同意根内 ⇒ 放行
    const ok2 = await ex.executeTool("list_dir", { path: parent }, { grantedRoots: [parent] });
    assert.equal(ok2.path, parent);
  } finally {
    rmrf(parent);
  }
});

test("grantedRoots：未同意的其他已授权路径仍 needs_authorization（不放宽）", async () => {
  const parent = makeTempRoot();
  const other = makeTempRoot();
  try {
    const sub = path.join(parent, "sub");
    nodeFs.mkdirSync(sub);
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [sub, other], mode: "ask", home: parent });
    await assert.rejects(
      ex.executeTool("list_dir", { path: other }, { grantedRoots: [parent] }),
      (err) => err && err.code === "needs_authorization",
    );
  } finally {
    rmrf(parent);
    rmrf(other);
  }
});

test("grantedRoots：硬 denylist（~/.ssh/id_rsa）即使同意根含家目录祖先仍 deny", async () => {
  const home = makeTempRoot();
  try {
    const ssh = path.join(home, ".ssh");
    nodeFs.mkdirSync(ssh);
    nodeFs.writeFileSync(path.join(ssh, "id_rsa"), "-----BEGIN KEY-----");
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [home], mode: "ask", home });
    await assert.rejects(
      ex.executeTool("read_file", { path: path.join(ssh, "id_rsa") }, { grantedRoots: [home] }),
      (err) => err && (err.code === "sensitive_path" || err.code === "permission_denied"),
    );
  } finally {
    rmrf(home);
  }
});

test("grantedRoots：非阵列／非字串元素 fail-closed（不当空阵列清空既有授权）", async () => {
  const root = makeTempRoot();
  try {
    const f = path.join(root, "a.txt");
    nodeFs.writeFileSync(f, "hi");
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root], mode: "ask", home: root });
    // 既有 root 仍有效（allowlist 未因 grantedRoots 型别错被清空）⇒ 走第二道防线回 needs_authorization
    await assert.rejects(
      ex.executeTool("read_file", { path: f }, { grantedRoots: "not-an-array" }),
      (err) => err && err.code === "needs_authorization",
    );
    // 空阵列亦同
    await assert.rejects(
      ex.executeTool("read_file", { path: f }, { grantedRoots: [] }),
      (err) => err && err.code === "needs_authorization",
    );
  } finally {
    rmrf(root);
  }
});
