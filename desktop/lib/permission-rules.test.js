// desktop/lib/permission-rules.test.js
//
// 第二道防線純函式測試。跑法：
//   node --test desktop/lib/*.test.js
//
// 全部用 node:test + node:assert，無外部依賴。
// 每條斷言都描述「正確語義」，不得把任何繞過/弱點寫成預期行為。

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const pr = require("./permission-rules.js");
const {
  RULE_EFFECTS,
  PERMISSION_MODES,
  REASONS,
  HARD_DENY_PATTERNS,
  SAFETY_CHECK_FILES,
  SAFETY_CHECK_DIRS,
  parseRule,
  isHardDenied,
  isSafetyCheckPath,
  evaluatePermission,
  suggestRoot,
} = pr;

const HOME = "/home/u";
const SETTINGS_ROOT = "/home/u/work";

/** 補預設值的 evaluatePermission 呼叫。 */
function evalP(o = {}) {
  return evaluatePermission({
    tool: "Read",
    rawPath: "/tmp/a.txt",
    mode: "ask",
    rules: {},
    authorizedRoots: [],
    home: HOME,
    settingsRoot: SETTINGS_ROOT,
    ...o,
  });
}

// ---------------------------------------------------------------------------
// 常數（單一真源）
// ---------------------------------------------------------------------------
test("常數：RULE_EFFECTS 順序即優先序 deny→ask→allow；PERMISSION_MODES 為四模式", () => {
  assert.deepEqual(RULE_EFFECTS, ["deny", "ask", "allow"]);
  assert.deepEqual(PERMISSION_MODES, ["off", "ask", "auto", "full"]);
});

test("safety-check 清單逐條照 Claude Code（檔案 10、目錄 4）", () => {
  assert.deepEqual(SAFETY_CHECK_FILES, [
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".ripgreprc",
    ".mcp.json",
    ".claude.json",
  ]);
  assert.deepEqual(SAFETY_CHECK_DIRS, [".git", ".vscode", ".idea", ".claude"]);
});

// ---------------------------------------------------------------------------
// parseRule
// ---------------------------------------------------------------------------
test("parseRule：無 effect 的工具級規則 effect=null，由呼叫端依桶指派", () => {
  assert.deepEqual(parseRule("Read"), { effect: null, tool: "Read", specifier: null });
  assert.deepEqual(parseRule("  Read  "), { effect: null, tool: "Read", specifier: null });
});

test("parseRule：Tool(specifier) 帶出 specifier", () => {
  assert.deepEqual(parseRule("Read(//etc/**)"), {
    effect: null,
    tool: "Read",
    specifier: "//etc/**",
  });
  assert.deepEqual(parseRule("Read(~/Movies/**)"), {
    effect: null,
    tool: "Read",
    specifier: "~/Movies/**",
  });
});

test("parseRule：effect 前綴（大小寫不敏感）", () => {
  assert.deepEqual(parseRule("deny:Read(~/x)"), {
    effect: "deny",
    tool: "Read",
    specifier: "~/x",
  });
  assert.deepEqual(parseRule("ASK:Read"), { effect: "ask", tool: "Read", specifier: null });
  assert.deepEqual(parseRule("allow:Read(*)"), {
    effect: "allow",
    tool: "Read",
    specifier: null,
  });
});

test("parseRule：Tool()/Tool(*) 等價工具級（照 Claude）；轉義括號還原", () => {
  assert.deepEqual(parseRule("Bash()"), { effect: null, tool: "Bash", specifier: null });
  assert.deepEqual(parseRule("Bash(*)"), { effect: null, tool: "Bash", specifier: null });
  assert.deepEqual(parseRule("Bash(foo\\(bar\\))"), {
    effect: null,
    tool: "Bash",
    specifier: "foo(bar)",
  });
});

test("parseRule：壞形式一律回 null（不得猜測）", () => {
  assert.equal(parseRule(""), null);
  assert.equal(parseRule("   "), null);
  assert.equal(parseRule("()"), null); // 只有括號、無 tool
  assert.equal(parseRule("(foo)"), null); // 無 tool
  assert.equal(parseRule("bogus:Read"), null); // 非白名單 effect
  assert.equal(parseRule("delete:Read"), null);
  assert.equal(parseRule("Read("), null); // 無收尾括號
  assert.equal(parseRule("Read(a)b"), null); // 收尾後有殘字
  assert.equal(parseRule("Read)"), null); // 孤立右括號
  assert.equal(parseRule("deny:"), null); // effect 後無規則
  assert.equal(parseRule(null), null);
  assert.equal(parseRule(123), null);
});

// ---------------------------------------------------------------------------
// 硬 denylist：逐條樣式斷言
// ---------------------------------------------------------------------------
test("isHardDenied：每個硬 denylist 樣式都拒（含大小寫折疊）", () => {
  const cases = [
    [`${HOME}/.ssh/id_rsa`, "~/.ssh 目錄"],
    [`${HOME}/.aws/credentials`, "~/.aws 目錄"],
    [`${HOME}/.gnupg/secring.gpg`, "~/.gnupg 目錄"],
    [`${HOME}/.kube/config`, "~/.kube 目錄"],
    [`${HOME}/.docker/config.json`, "~/.docker 目錄"],
    [`${HOME}/.config/gh/hosts.yml`, "~/.config 目錄"],
    [`${HOME}/.local/share/keyrings/login.keyring`, "~/.local/share/keyrings 目錄"],
    [`${HOME}/.git-credentials`, "~/.git-credentials"],
    [`${HOME}/.netrc`, "~/.netrc"],
    [`${HOME}/.pgpass`, "~/.pgpass"],
    [`${HOME}/.bash_history`, "~/.bash_history"],
    ["/etc/shadow", "/etc/shadow"],
    ["/etc/sudoers", "/etc/sudoers"],
    ["/proc/1234/environ", "/proc/*/environ"],
    ["/proc/self/environ", "/proc/*/environ"],
    ["/data/server.pem", "*.pem"],
    ["/data/tls.key", "*.key"],
    ["/data/client.p12", "*.p12"],
    ["/tmp/id_rsa_old", "id_rsa*"],
    ["/tmp/id_ed25519.pub", "id_ed25519*"],
    ["/data/my-credentials.json", "*credential*"],
    ["/data/app-secrets.yaml", "*secret*"],
    ["/data/gcp-service-account-prod.json", "*service-account*.json"],
    ["/data/.env", ".env"],
    ["/data/.env.local", ".env.*"],
    [`${HOME}/.SSH/id_rsa`, "大小寫折疊：.SSH"],
    ["/data/CERT.PEM", "大小寫折疊：.PEM"],
  ];
  for (const [p, why] of cases) {
    assert.equal(isHardDenied({ raw: p, home: HOME }), true, `${p} — ${why}`);
  }
  // tilde 形式亦命中
  assert.equal(isHardDenied({ raw: "~/.ssh/id_rsa", home: HOME }), true);
  assert.equal(isHardDenied({ raw: "~/.config/x/y", home: HOME }), true);
});

test("isHardDenied：一般檔案不誤殺；每個 pattern 皆有人斷言", () => {
  for (const p of ["/tmp/a.txt", `${HOME}/Movies/clip.mp4`, "/data/project/main.ts", "/proc/self/cmdline", "/data/app.env", "/data/notes.txt"]) {
    assert.equal(isHardDenied({ raw: p, home: HOME }), false, p);
  }
  // 每個 pattern 都能被至少一條斷言覆蓋（防止清單縮水而測試仍綠）
  assert.ok(HARD_DENY_PATTERNS.length >= 24, "硬 denylist 樣式數不得少於 spec 條數");
  const patterns = HARD_DENY_PATTERNS.map((p) => p.pattern);
  for (const must of [
    "~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker", "~/.config",
    "~/.local/share/keyrings", "~/.git-credentials", "~/.netrc", "~/.pgpass",
    "~/.bash_history", "/etc/shadow", "/etc/sudoers", "/proc/*/environ",
    "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*", "*credential*",
    "*secret*", "*service-account*.json", ".env", ".env.*",
  ]) {
    assert.ok(patterns.includes(must), `硬 denylist 缺少樣式 ${must}`);
  }
});

test("isHardDenied：家目錄外的敏感檔名仍拒（H3 語義，不把繞過當正確）", () => {
  assert.equal(isHardDenied({ raw: "/tmp/x/.ssh/id_rsa", home: HOME }), true);
  assert.equal(isHardDenied({ raw: "/mnt/data/.aws/credentials", home: HOME }), true);
  assert.equal(isHardDenied({ raw: "/var/data/service-account-x.json", home: HOME }), true);
});

test("isHardDenied：同時比對原始與 symlink 解析後路徑（任一命中即拒）", () => {
  // raw 乾淨、resolved 是敏感檔 → 拒（純字串判定跟不了 symlink 的補位）
  assert.equal(
    isHardDenied({ raw: `${HOME}/Movies/link.txt`, resolved: `${HOME}/.ssh/id_rsa`, home: HOME }),
    true,
  );
  // raw 敏感、resolved 乾淨 → 仍拒（不得因解析後乾淨就放行）
  assert.equal(
    isHardDenied({ raw: `${HOME}/.ssh/id_rsa`, resolved: `${HOME}/Movies/link.txt`, home: HOME }),
    true,
  );
});

test("isHardDenied：fail-closed（非字串/空/~無法展開）", () => {
  assert.equal(isHardDenied({ raw: "", home: HOME }), true);
  assert.equal(isHardDenied({ raw: "   ", home: HOME }), true);
  assert.equal(isHardDenied({ raw: null, home: HOME }), true);
  assert.equal(isHardDenied({ raw: 123, home: HOME }), true);
  assert.equal(isHardDenied(null, HOME), true);
  assert.equal(isHardDenied({ raw: "~/x", home: null }, null), true); // ~ 無 home → fail-closed
  assert.equal(isHardDenied({ raw: "/tmp/ok.txt", resolved: "", home: HOME }), true); // resolved 有給但不合法
});

// ---------------------------------------------------------------------------
// safety-check
// ---------------------------------------------------------------------------
test("isSafetyCheckPath：危險檔名/目錄逐條命中、一般路徑不命中", () => {
  assert.equal(isSafetyCheckPath(`${HOME}/.bashrc`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/.gitconfig`), true);
  assert.equal(isSafetyCheckPath("/etc/.Profile"), true); // 大小寫折疊（.profile）
  assert.equal(isSafetyCheckPath(`${HOME}/.ripgreprc`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/proj/.git/config`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/proj/.vscode/settings.json`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/.claude/settings.json`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/.idea/workspace.xml`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/Movies/clip.mp4`), false);
  assert.equal(isSafetyCheckPath("/tmp/a.txt"), false);
  // 物件形式：任一命中即命中
  assert.equal(isSafetyCheckPath({ raw: `/tmp/a.txt`, resolved: `${HOME}/.bashrc` }), true);
  // fail-closed（非法輸入 → ask）
  assert.equal(isSafetyCheckPath(""), true);
  assert.equal(isSafetyCheckPath(null), true);
});

// ---------------------------------------------------------------------------
// 判定序：逐序各一條
// ---------------------------------------------------------------------------
test("判定序 1：硬 denylist 壓過 safety-check 與 allow 規則與 full 模式 → deny/hard_deny", () => {
  const r = evalP({
    rawPath: `${HOME}/.config/.bashrc`, // 同時命中 ~/.config（硬）與 .bashrc（safety）
    mode: "full",
    rules: { allow: ["Read"] },
  });
  assert.equal(r.decision, "deny");
  assert.equal(r.reason, REASONS.HARD_DENY);
});

test("判定序 2：safety-check 壓過規則 deny → ask/safety_check", () => {
  const r = evalP({
    rawPath: `${HOME}/proj/.git/config`,
    mode: "auto",
    rules: { deny: ["Read"] }, // 工具級 deny
    authorizedRoots: [`${HOME}/proj`],
  });
  assert.equal(r.decision, "ask");
  assert.equal(r.reason, REASONS.SAFETY_CHECK);
});

test("判定序 3：規則 deny 壓過 ask 與 allow → deny/rule_deny", () => {
  const r = evalP({
    rawPath: "/tmp/pic.png",
    mode: "auto",
    rules: { deny: ["Read(//tmp/**)"], ask: ["Read(//tmp/**)"], allow: ["Read(//tmp/**)"] },
  });
  assert.equal(r.decision, "deny");
  assert.equal(r.reason, REASONS.RULE_DENY);
  assert.equal(r.rule.specifier, "//tmp/**");
});

test("判定序 4：規則 ask 壓過 allow → ask/rule_ask", () => {
  const r = evalP({
    rawPath: "/tmp/pic.png",
    mode: "auto",
    rules: { ask: ["Read(//tmp/**)"], allow: ["Read(//tmp/**)"] },
  });
  assert.equal(r.decision, "ask");
  assert.equal(r.reason, REASONS.RULE_ASK);
});

test("判定序 5：規則 allow 壓過模式 → allow/rule_allow", () => {
  const r = evalP({
    rawPath: "/data/pic.png",
    mode: "off", // 模式一律拒，但 allow 規則先命中
    rules: { allow: ["Read(//data/**)"] },
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.reason, REASONS.RULE_ALLOW);
});

test("判定序 6：模式語義放行（auto 根內）→ allow/mode_auto", () => {
  const r = evalP({
    rawPath: `${HOME}/proj/a.txt`,
    mode: "auto",
    rules: {},
    authorizedRoots: [`${HOME}/proj`],
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.reason, REASONS.MODE_AUTO);
});

test("判定序 7：模式不涵蓋 → 預設 ask/default_ask", () => {
  const r = evalP({
    rawPath: "/data/b.txt",
    mode: "auto",
    rules: {},
    authorizedRoots: [`${HOME}/proj`],
  });
  assert.equal(r.decision, "ask");
  assert.equal(r.reason, REASONS.DEFAULT_ASK);
});

// ---------------------------------------------------------------------------
// 三桶：deny 壓 allow、ask 壓 allow
// ---------------------------------------------------------------------------
test("三桶：deny 壓過 allow（物件桶）", () => {
  const r = evalP({
    rawPath: "/data/x.txt",
    rules: { deny: ["Read(//data/**)"], allow: ["Read(//data/**)"] },
  });
  assert.equal(r.decision, "deny");
  assert.equal(r.reason, REASONS.RULE_DENY);
});

test("三桶：ask 壓過 allow（物件桶）", () => {
  const r = evalP({
    rawPath: "/data/x.txt",
    rules: { ask: ["Read(//data/**)"], allow: ["Read(//data/**)"] },
  });
  assert.equal(r.decision, "ask");
  assert.equal(r.reason, REASONS.RULE_ASK);
});

test("三桶：扁平陣列以自帶 effect 分桶；無 effect 者不套用（不意外放行）", () => {
  const deny = evalP({
    rawPath: "/data/x.txt",
    rules: ["deny:Read(//data/**)", "allow:Read(//data/**)"],
  });
  assert.equal(deny.decision, "deny");
  const noEffect = evalP({ rawPath: "/data/x.txt", rules: ["Read(//data/**)"], mode: "ask" });
  assert.equal(noEffect.decision, "ask");
  assert.equal(noEffect.reason, REASONS.MODE_ASK);
});

// ---------------------------------------------------------------------------
// 路徑前綴四語義 + /** + symlink 兩態
// ---------------------------------------------------------------------------
test("前綴：//path 為檔案系統根絕對", () => {
  assert.equal(
    evalP({ rawPath: "/etc/passwd", mode: "ask", rules: { deny: ["Read(//etc/**)"] } }).decision,
    "deny",
  );
  // 不得命中家目錄下的同名相對結構
  assert.equal(
    evalP({ rawPath: `${HOME}/etc/passwd`, mode: "ask", rules: { deny: ["Read(//etc/**)"] } }).decision,
    "ask",
  );
});

test("前綴：~/path 為家目錄", () => {
  assert.equal(
    evalP({ rawPath: `${HOME}/secret/a`, mode: "ask", rules: { deny: ["Read(~/secret/**)"] } }).decision,
    "deny",
  );
  assert.equal(
    evalP({ rawPath: "/data/secret/a", mode: "ask", rules: { deny: ["Read(~/secret/**)"] } }).decision,
    "ask",
  );
});

test("前綴：/path 相對設定來源（settingsRoot）", () => {
  assert.equal(
    evalP({ rawPath: `${SETTINGS_ROOT}/proj/a`, mode: "ask", rules: { deny: ["Read(/proj/**)"] } }).decision,
    "deny",
  );
  assert.equal(
    evalP({ rawPath: `${HOME}/proj/a`, mode: "ask", rules: { deny: ["Read(/proj/**)"] } }).decision,
    "ask",
  );
});

test("前綴：無前綴 / ./x 為任意位置", () => {
  assert.equal(
    evalP({ rawPath: "/var/log/a.log", mode: "ask", rules: { deny: ["Read(*.log)"] } }).decision,
    "deny",
  );
  assert.equal(
    evalP({ rawPath: `${HOME}/a.log`, mode: "ask", rules: { deny: ["Read(*.log)"] } }).decision,
    "deny",
  );
  assert.equal(
    evalP({ rawPath: "/any/where/notes.md", mode: "ask", rules: { deny: ["Read(./notes.md)"] } }).decision,
    "deny",
  );
});

test("/**：目錄本身與其下皆命中；裸目錄樣式亦然", () => {
  assert.equal(
    evalP({ rawPath: `${HOME}/Movies`, mode: "ask", rules: { deny: ["Read(~/Movies/**)"] } }).decision,
    "deny",
  );
  assert.equal(
    evalP({ rawPath: `${HOME}/Movies/a/b/c.mp4`, mode: "ask", rules: { deny: ["Read(~/Movies/**)"] } }).decision,
    "deny",
  );
  assert.equal(
    evalP({ rawPath: `${HOME}/Movies/a.mp4`, mode: "ask", rules: { deny: ["Read(~/Movies)"] } }).decision,
    "deny",
  );
});

test("symlink 兩態：deny 規則對 raw/resolved 任一命中即拒", () => {
  // raw 命中、resolved 乾淨
  assert.equal(
    evalP({
      rawPath: `${HOME}/sshTarget/x`,
      resolvedPath: `${HOME}/Movies/x`,
      mode: "ask",
      rules: { deny: ["Read(~/sshTarget/**)"] },
    }).decision,
    "deny",
  );
  // raw 乾淨、resolved 命中
  assert.equal(
    evalP({
      rawPath: `${HOME}/Movies/link`,
      resolvedPath: `${HOME}/sshTarget/x`,
      mode: "ask",
      rules: { deny: ["Read(~/sshTarget/**)"] },
    }).decision,
    "deny",
  );
});

test("symlink 兩態：allow 規則要求所有路徑皆命中，防走私出根", () => {
  const r = evalP({
    rawPath: `${HOME}/Movies/link`,
    resolvedPath: "/etc/hosts", // 解析後落在授權根外
    mode: "auto",
    rules: { allow: ["Read(~/Movies/**)"] },
    authorizedRoots: [`${HOME}/Movies`],
  });
  assert.notEqual(r.decision, "allow"); // 不得因 raw 命中 allow 就放行
  assert.equal(r.decision, "ask");
  assert.equal(r.reason, REASONS.DEFAULT_ASK);
});

// ---------------------------------------------------------------------------
// 四模式 ×（根內／根外／家目錄）矩陣
// ---------------------------------------------------------------------------
test("四模式決策矩陣（無規則）：根內／根外／家目錄", () => {
  const roots = [`${HOME}/proj`];
  const inside = `${HOME}/proj/a.txt`; // 授權根內（且在家目錄內）
  const outside = "/data/b.txt"; // 根外且家外
  const inHome = `${HOME}/notes.txt`; // 家目錄內、授權根外

  const matrix = [
    // mode, path, expectedDecision, expectedReason
    ["off", inside, "deny", REASONS.MODE_OFF],
    ["off", outside, "deny", REASONS.MODE_OFF],
    ["off", inHome, "deny", REASONS.MODE_OFF],

    ["ask", inside, "ask", REASONS.MODE_ASK],
    ["ask", outside, "ask", REASONS.MODE_ASK],
    ["ask", inHome, "ask", REASONS.MODE_ASK],

    ["auto", inside, "allow", REASONS.MODE_AUTO],
    ["auto", outside, "ask", REASONS.DEFAULT_ASK],
    ["auto", inHome, "ask", REASONS.DEFAULT_ASK],

    ["full", inside, "allow", REASONS.MODE_FULL],
    ["full", outside, "ask", REASONS.DEFAULT_ASK],
    ["full", inHome, "allow", REASONS.MODE_FULL],
  ];
  for (const [mode, path, decision, reason] of matrix) {
    const r = evalP({ rawPath: path, mode, rules: {}, authorizedRoots: roots });
    assert.equal(r.decision, decision, `${mode} × ${path}`);
    assert.equal(r.reason, reason, `${mode} × ${path} reason`);
  }
});

test("模式：auto 空授權根＝不外放（fail-closed），full 家目錄外問", () => {
  const r1 = evalP({ rawPath: `${HOME}/proj/a.txt`, mode: "auto", authorizedRoots: [] });
  assert.equal(r1.decision, "ask");
  assert.equal(r1.reason, REASONS.DEFAULT_ASK);
  const r2 = evalP({ rawPath: "/data/b.txt", mode: "full" });
  assert.equal(r2.decision, "ask");
  assert.equal(r2.reason, REASONS.DEFAULT_ASK);
});

test("模式：非法 mode 一律拒（fail-closed）", () => {
  const r = evalP({ rawPath: "/tmp/a.txt", mode: "bypassPermissions" });
  assert.equal(r.decision, "deny");
  assert.equal(r.reason, REASONS.INVALID_MODE);
});

// ---------------------------------------------------------------------------
// 硬 denylist 於 full 模式 + allow 規則下仍拒（每個樣式）
// ---------------------------------------------------------------------------
test("硬 denylist 不可被 full 模式或 allow 規則繞過（逐樣式）", () => {
  const samples = [
    `${HOME}/.ssh/id_rsa`,
    `${HOME}/.aws/credentials`,
    `${HOME}/.gnupg/secring.gpg`,
    `${HOME}/.kube/config`,
    `${HOME}/.docker/config.json`,
    `${HOME}/.config/foo/bar`,
    `${HOME}/.local/share/keyrings/k`,
    `${HOME}/.git-credentials`,
    `${HOME}/.netrc`,
    `${HOME}/.pgpass`,
    `${HOME}/.bash_history`,
    "/etc/shadow",
    "/etc/sudoers",
    "/proc/1234/environ",
    "/data/server.pem",
    "/data/tls.key",
    "/data/client.p12",
    "/tmp/id_rsa_old",
    "/tmp/id_ed25519",
    "/data/my-credentials.json",
    "/data/app-secrets.yaml",
    "/data/gcp-service-account.json",
    "/data/.env",
    "/data/.env.production",
  ];
  for (const p of samples) {
    const r = evalP({
      rawPath: p,
      mode: "full",
      rules: { allow: ["Read"] },
      authorizedRoots: [HOME],
    });
    assert.equal(r.decision, "deny", `${p} 必須被硬 denylist 拒`);
    assert.equal(r.reason, REASONS.HARD_DENY, `${p} reason`);
  }
});

// ---------------------------------------------------------------------------
// suggestRoot
// ---------------------------------------------------------------------------
test("suggestRoot：回最接近目錄；過寬根回 null", () => {
  assert.equal(suggestRoot(`${HOME}/Movies/a.mp4`, { home: HOME }), `${HOME}/Movies`);
  assert.equal(suggestRoot("/data/proj/x.txt", { home: HOME }), "/data/proj");
  assert.equal(suggestRoot(`${HOME}/Movies/Docs/x.mp4`, { home: HOME }), `${HOME}/Movies/Docs`);

  // 過寬根：一律 null（由呼叫端改要求單檔授權）
  assert.equal(suggestRoot("/", { home: HOME }), null);
  assert.equal(suggestRoot(`${HOME}/x.mp4`, { home: HOME }), null); // 家目錄本身
  assert.equal(suggestRoot("/home", { home: HOME }), null); // 家目錄祖先
  assert.equal(suggestRoot("/tmp", { home: HOME }), null); // 單層目錄
  assert.equal(suggestRoot("relative/x.txt", { home: HOME }), null); // 非絕對
  // 敏感目錄不建議授權
  assert.equal(suggestRoot(`${HOME}/.config/x.txt`, { home: HOME }), null);
  assert.equal(suggestRoot(`${HOME}/proj/.git/x`, { home: HOME }), null);
});

// ---------------------------------------------------------------------------
// 硬 denylist 與 safety-check 清單不可為空（防清單被砍而測試沉默通過）
// ---------------------------------------------------------------------------
test("sanity：清單非空且決策必為三值之一", () => {
  assert.ok(HARD_DENY_PATTERNS.length > 0);
  assert.ok(SAFETY_CHECK_FILES.length > 0);
  assert.ok(SAFETY_CHECK_DIRS.length > 0);
  const r = evalP({ rawPath: "/tmp/a.txt" });
  assert.ok(["allow", "deny", "ask"].includes(r.decision));
});