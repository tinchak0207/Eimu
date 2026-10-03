// desktop/lib/bridge-executor.test.js
//
// W6b 執行器測試（**真正讀檔的危險路徑**）。跑法：
//   npx --yes tsx --test desktop/lib/bridge-executor.test.js
//
// 用 node:test + node:assert，真暫存目錄（真檔案系統行為）＋注入計數版 fs。
// 這補上先前「所有綠燈只測純函式複本、executeTool/requireLocalPath 零測試」的自欺。

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBridgeExecutor, isFsRoot, MAX_GREP_FILE_BYTES } = require("./bridge-executor.js");

function makeTempRoot() {
  return nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "eimu-bridge-exec-")));
}

function rmrf(p) {
  nodeFs.rmSync(p, { recursive: true, force: true });
}

/** 注入用 fs：預設 node:fs，另記錄 readFileSync/statSync 被呼叫的路徑。 */
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
test("H1: 空 allowlist ⇒ 一律拒（no_authorized_roots），不得退回只驗 denylist", async () => {
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

test("H1: 未提供 roots（undefined）⇒ 視為空集全拒", () => {
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
// H3：家目錄外敏感路徑
// ---------------------------------------------------------------------------
test("H3: 家目錄外敏感路徑 ⇒ 拒（sensitive_path）", () => {
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

test("H3: 授權根之下仍不得放行敏感路徑", () => {
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

test("symlink: 授權根內指到敏感位置的 symlink ⇒ 解 realpath 後拒", () => {
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
// H2：遞迴收集剪掉敏感段
// ---------------------------------------------------------------------------
test("H2: 父目錄含敏感段的遞迴收集 ⇒ 敏感檔被排除", () => {
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
    assert.equal(hit.some((p) => p.includes(".ssh")), false, "敏感段不得被收集/讀取");
  } finally {
    rmrf(root);
  }
});

// ---------------------------------------------------------------------------
// M3：單檔大小上限 + 檔案系統根拒絕
// ---------------------------------------------------------------------------
test("M3: 超過單檔大小上限 ⇒ 跳過並標記，且不整檔讀入記憶體", () => {
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
    assert.equal(calls.readFileSync.some((p) => p.endsWith("big.txt")), false, "大檔不得被 readFileSync");
  } finally {
    rmrf(root);
  }
});

test("M3: path='/'（檔案系統根）⇒ 拒（path_is_root）", () => {
  assert.equal(isFsRoot("/"), true);
  assert.equal(isFsRoot("/tmp"), false);
  const ex = createBridgeExecutor({ fs: nodeFs, roots: ["/tmp"] });
  assert.throws(() => ex.requireLocalPath("/"), isCode("path_is_root"));
});

// ---------------------------------------------------------------------------
// H2 輸入側：grep 逐檔上限 = min(雲端下發 max_file_bytes, 本機上限)
// ---------------------------------------------------------------------------
test("H2: grep 真的用 max_file_bytes（超過即跳過且不讀檔；雲端大值被本機夾住）", () => {
  const root = makeTempRoot();
  try {
    const medium = path.join(root, "medium.txt");
    nodeFs.writeFileSync(medium, `NEEDLE${"x".repeat(4096)}`); // ~4KB
    const { fs, calls } = countingFs();
    const ex = createBridgeExecutor({ fs, roots: [root] });

    // 未帶 max_file_bytes → 本機上限（1MB），4KB 檔可讀
    const all = ex.toolGrep({ path: root, pattern: "NEEDLE" });
    assert.equal(all.skipped_large_files, 0);
    assert.ok(all.matches.some((m) => m.path.endsWith("medium.txt")));

    // 雲端下發 64 bytes → 4KB 檔被跳過，且不得 readFileSync（不整檔入記憶體）
    calls.readFileSync.length = 0;
    const capped = ex.toolGrep({ path: root, pattern: "NEEDLE", max_file_bytes: 64 });
    assert.equal(capped.skipped_large_files, 1);
    assert.equal(capped.matches.some((m) => m.path.endsWith("medium.txt")), false);
    assert.equal(calls.readFileSync.some((p) => p.endsWith("medium.txt")), false);

    // 雲端下發超大值 → 被本機上限夾住（不得比契約鬆）
    const clamped = ex.toolGrep({ path: root, pattern: "NEEDLE", max_file_bytes: 64 * 1024 * 1024 });
    assert.equal(clamped.skipped_large_files, 0);
    assert.ok(clamped.matches.some((m) => m.path.endsWith("medium.txt")));
  } finally {
    rmrf(root);
  }
});

// ---------------------------------------------------------------------------
// H2 契約面第二層：grep/list_dir 自報敏感觸碰
// ---------------------------------------------------------------------------
test("H2: grep 遞迴碰到敏感段 ⇒ 自報 excluded_sensitive_count / sensitive_path_touched", () => {
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

test("H2: list_dir 敏感 entry 不進回傳並自報計數", () => {
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
// allowlist 邊界 / 工具白名單 / 一般操作
// ---------------------------------------------------------------------------
test("allowlist: 授權根外的一般路徑 ⇒ not_authorized", () => {
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

test("requireLocalPath: 授權根內不存在的路徑 ⇒ not_found", () => {
  const root = makeTempRoot();
  try {
    const ex = createBridgeExecutor({ fs: nodeFs, roots: [root] });
    assert.throws(() => ex.requireLocalPath(path.join(root, "nope.txt")), isCode("not_found"));
  } finally {
    rmrf(root);
  }
});

test("executeTool: 未知工具 ⇒ tool_not_allowed（無任何寫/刪/執行工具）", async () => {
  const ex = createBridgeExecutor({ fs: nodeFs, roots: ["/tmp"] });
  await assert.rejects(ex.executeTool("exec", { path: "/tmp" }), isCode("tool_not_allowed"));
  await assert.rejects(ex.executeTool("write_file", { path: "/tmp" }), isCode("tool_not_allowed"));
});

test("read_file: offset/limit 生效且 limit 夾到硬上限", async () => {
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

test("list_dir/stat: 授權根內正常運作", async () => {
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
