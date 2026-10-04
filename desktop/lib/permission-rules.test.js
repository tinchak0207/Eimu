// desktop/lib/permission-rules.test.js
//
// 第二道防线纯函式测试。跑法：
//   node --test desktop/lib/*.test.js
//
// 全部用 node:test + node:assert，无外部依赖。
// 每条断言都描述「正确语义」，不得把任何绕过/弱点写成预期行为。

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

/** 补预设值的 evaluatePermission 呼叫。 */
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
// 常数（单一真源）
// ---------------------------------------------------------------------------
test("常数：RULE_EFFECTS 顺序即优先序 deny→ask→allow；PERMISSION_MODES 为四模式", () => {
  assert.deepEqual(RULE_EFFECTS, ["deny", "ask", "allow"]);
  assert.deepEqual(PERMISSION_MODES, ["off", "ask", "auto", "full"]);
});

test("safety-check 清单逐条照 Claude Code（档案 10、目录 4）", () => {
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
test("parseRule：无 effect 的工具级规则 effect=null，由呼叫端依桶指派", () => {
  assert.deepEqual(parseRule("Read"), { effect: null, tool: "Read", specifier: null });
  assert.deepEqual(parseRule("  Read  "), { effect: null, tool: "Read", specifier: null });
});

test("parseRule：Tool(specifier) 带出 specifier", () => {
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

test("parseRule：effect 前缀（大小写不敏感）", () => {
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

test("parseRule：Tool()/Tool(*) 等价工具级（照 Claude）；转义括号还原", () => {
  assert.deepEqual(parseRule("Bash()"), { effect: null, tool: "Bash", specifier: null });
  assert.deepEqual(parseRule("Bash(*)"), { effect: null, tool: "Bash", specifier: null });
  assert.deepEqual(parseRule("Bash(foo\\(bar\\))"), {
    effect: null,
    tool: "Bash",
    specifier: "foo(bar)",
  });
});

test("parseRule：坏形式一律回 null（不得猜测）", () => {
  assert.equal(parseRule(""), null);
  assert.equal(parseRule("   "), null);
  assert.equal(parseRule("()"), null); // 只有括号、无 tool
  assert.equal(parseRule("(foo)"), null); // 无 tool
  assert.equal(parseRule("bogus:Read"), null); // 非白名单 effect
  assert.equal(parseRule("delete:Read"), null);
  assert.equal(parseRule("Read("), null); // 无收尾括号
  assert.equal(parseRule("Read(a)b"), null); // 收尾后有残字
  assert.equal(parseRule("Read)"), null); // 孤立右括号
  assert.equal(parseRule("deny:"), null); // effect 后无规则
  assert.equal(parseRule(null), null);
  assert.equal(parseRule(123), null);
});

// ---------------------------------------------------------------------------
// 硬 denylist：逐条样式断言
// ---------------------------------------------------------------------------
test("isHardDenied：每个硬 denylist 样式都拒（含大小写折叠）", () => {
  const cases = [
    [`${HOME}/.ssh/id_rsa`, "~/.ssh 目录"],
    [`${HOME}/.aws/credentials`, "~/.aws 目录"],
    [`${HOME}/.gnupg/secring.gpg`, "~/.gnupg 目录"],
    [`${HOME}/.kube/config`, "~/.kube 目录"],
    [`${HOME}/.docker/config.json`, "~/.docker 目录"],
    [`${HOME}/.config/gh/hosts.yml`, "~/.config 目录"],
    [`${HOME}/.local/share/keyrings/login.keyring`, "~/.local/share/keyrings 目录"],
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
    [`${HOME}/.SSH/id_rsa`, "大小写折叠：.SSH"],
    ["/data/CERT.PEM", "大小写折叠：.PEM"],
  ];
  for (const [p, why] of cases) {
    assert.equal(isHardDenied({ raw: p, home: HOME }), true, `${p} — ${why}`);
  }
  // tilde 形式亦命中
  assert.equal(isHardDenied({ raw: "~/.ssh/id_rsa", home: HOME }), true);
  assert.equal(isHardDenied({ raw: "~/.config/x/y", home: HOME }), true);
});

test("isHardDenied：一般档案不误杀；每个 pattern 皆有人断言", () => {
  for (const p of ["/tmp/a.txt", `${HOME}/Movies/clip.mp4`, "/data/project/main.ts", "/proc/self/cmdline", "/data/app.env", "/data/notes.txt"]) {
    assert.equal(isHardDenied({ raw: p, home: HOME }), false, p);
  }
  // 每个 pattern 都能被至少一条断言覆盖（防止清单缩水而测试仍绿）
  assert.ok(HARD_DENY_PATTERNS.length >= 24, "硬 denylist 样式数不得少于 spec 条数");
  const patterns = HARD_DENY_PATTERNS.map((p) => p.pattern);
  for (const must of [
    "~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker", "~/.config",
    "~/.local/share/keyrings", "~/.git-credentials", "~/.netrc", "~/.pgpass",
    "~/.bash_history", "/etc/shadow", "/etc/sudoers", "/proc/*/environ",
    "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*", "*credential*",
    "*secret*", "*service-account*.json", ".env", ".env.*",
  ]) {
    assert.ok(patterns.includes(must), `硬 denylist 缺少样式 ${must}`);
  }
});

test("isHardDenied：家目录外的敏感档名仍拒（H3 语义，不把绕过当正确）", () => {
  assert.equal(isHardDenied({ raw: "/tmp/x/.ssh/id_rsa", home: HOME }), true);
  assert.equal(isHardDenied({ raw: "/mnt/data/.aws/credentials", home: HOME }), true);
  assert.equal(isHardDenied({ raw: "/var/data/service-account-x.json", home: HOME }), true);
});

test("isHardDenied：同时比对原始与 symlink 解析后路径（任一命中即拒）", () => {
  // raw 干净、resolved 是敏感档 → 拒（纯字串判定跟不了 symlink 的补位）
  assert.equal(
    isHardDenied({ raw: `${HOME}/Movies/link.txt`, resolved: `${HOME}/.ssh/id_rsa`, home: HOME }),
    true,
  );
  // raw 敏感、resolved 干净 → 仍拒（不得因解析后干净就放行）
  assert.equal(
    isHardDenied({ raw: `${HOME}/.ssh/id_rsa`, resolved: `${HOME}/Movies/link.txt`, home: HOME }),
    true,
  );
});

test("isHardDenied：fail-closed（非字串/空/~无法展开）", () => {
  assert.equal(isHardDenied({ raw: "", home: HOME }), true);
  assert.equal(isHardDenied({ raw: "   ", home: HOME }), true);
  assert.equal(isHardDenied({ raw: null, home: HOME }), true);
  assert.equal(isHardDenied({ raw: 123, home: HOME }), true);
  assert.equal(isHardDenied(null, HOME), true);
  assert.equal(isHardDenied({ raw: "~/x", home: null }, null), true); // ~ 无 home → fail-closed
  assert.equal(isHardDenied({ raw: "/tmp/ok.txt", resolved: "", home: HOME }), true); // resolved 有给但不合法
});

// ---------------------------------------------------------------------------
// safety-check
// ---------------------------------------------------------------------------
test("isSafetyCheckPath：危险档名/目录逐条命中、一般路径不命中", () => {
  assert.equal(isSafetyCheckPath(`${HOME}/.bashrc`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/.gitconfig`), true);
  assert.equal(isSafetyCheckPath("/etc/.Profile"), true); // 大小写折叠（.profile）
  assert.equal(isSafetyCheckPath(`${HOME}/.ripgreprc`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/proj/.git/config`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/proj/.vscode/settings.json`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/.claude/settings.json`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/.idea/workspace.xml`), true);
  assert.equal(isSafetyCheckPath(`${HOME}/Movies/clip.mp4`), false);
  assert.equal(isSafetyCheckPath("/tmp/a.txt"), false);
  // 物件形式：任一命中即命中
  assert.equal(isSafetyCheckPath({ raw: `/tmp/a.txt`, resolved: `${HOME}/.bashrc` }), true);
  // fail-closed（非法输入 → ask）
  assert.equal(isSafetyCheckPath(""), true);
  assert.equal(isSafetyCheckPath(null), true);
});

// ---------------------------------------------------------------------------
// 判定序：逐序各一条
// ---------------------------------------------------------------------------
test("判定序 1：硬 denylist 压过 safety-check 与 allow 规则与 full 模式 → deny/hard_deny", () => {
  const r = evalP({
    rawPath: `${HOME}/.config/.bashrc`, // 同时命中 ~/.config（硬）与 .bashrc（safety）
    mode: "full",
    rules: { allow: ["Read"] },
  });
  assert.equal(r.decision, "deny");
  assert.equal(r.reason, REASONS.HARD_DENY);
});

test("判定序 2：safety-check 压过规则 deny → ask/safety_check", () => {
  const r = evalP({
    rawPath: `${HOME}/proj/.git/config`,
    mode: "auto",
    rules: { deny: ["Read"] }, // 工具级 deny
    authorizedRoots: [`${HOME}/proj`],
  });
  assert.equal(r.decision, "ask");
  assert.equal(r.reason, REASONS.SAFETY_CHECK);
});

test("判定序 3：规则 deny 压过 ask 与 allow → deny/rule_deny", () => {
  const r = evalP({
    rawPath: "/tmp/pic.png",
    mode: "auto",
    rules: { deny: ["Read(//tmp/**)"], ask: ["Read(//tmp/**)"], allow: ["Read(//tmp/**)"] },
  });
  assert.equal(r.decision, "deny");
  assert.equal(r.reason, REASONS.RULE_DENY);
  assert.equal(r.rule.specifier, "//tmp/**");
});

test("判定序 4：规则 ask 压过 allow → ask/rule_ask", () => {
  const r = evalP({
    rawPath: "/tmp/pic.png",
    mode: "auto",
    rules: { ask: ["Read(//tmp/**)"], allow: ["Read(//tmp/**)"] },
  });
  assert.equal(r.decision, "ask");
  assert.equal(r.reason, REASONS.RULE_ASK);
});

test("判定序 5：规则 allow 压过模式 → allow/rule_allow", () => {
  const r = evalP({
    rawPath: "/data/pic.png",
    mode: "off", // 模式一律拒，但 allow 规则先命中
    rules: { allow: ["Read(//data/**)"] },
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.reason, REASONS.RULE_ALLOW);
});

test("判定序 6：模式语义放行（auto 根内）→ allow/mode_auto", () => {
  const r = evalP({
    rawPath: `${HOME}/proj/a.txt`,
    mode: "auto",
    rules: {},
    authorizedRoots: [`${HOME}/proj`],
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.reason, REASONS.MODE_AUTO);
});

test("判定序 7：模式不涵盖 → 预设 ask/default_ask", () => {
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
// 三桶：deny 压 allow、ask 压 allow
// ---------------------------------------------------------------------------
test("三桶：deny 压过 allow（物件桶）", () => {
  const r = evalP({
    rawPath: "/data/x.txt",
    rules: { deny: ["Read(//data/**)"], allow: ["Read(//data/**)"] },
  });
  assert.equal(r.decision, "deny");
  assert.equal(r.reason, REASONS.RULE_DENY);
});

test("三桶：ask 压过 allow（物件桶）", () => {
  const r = evalP({
    rawPath: "/data/x.txt",
    rules: { ask: ["Read(//data/**)"], allow: ["Read(//data/**)"] },
  });
  assert.equal(r.decision, "ask");
  assert.equal(r.reason, REASONS.RULE_ASK);
});

test("三桶：扁平阵列以自带 effect 分桶；无 effect 者不套用（不意外放行）", () => {
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
// 路径前缀四语义 + /** + symlink 两态
// ---------------------------------------------------------------------------
test("前缀：//path 为档案系统根绝对", () => {
  assert.equal(
    evalP({ rawPath: "/etc/passwd", mode: "ask", rules: { deny: ["Read(//etc/**)"] } }).decision,
    "deny",
  );
  // 不得命中家目录下的同名相对结构
  assert.equal(
    evalP({ rawPath: `${HOME}/etc/passwd`, mode: "ask", rules: { deny: ["Read(//etc/**)"] } }).decision,
    "ask",
  );
});

test("前缀：~/path 为家目录", () => {
  assert.equal(
    evalP({ rawPath: `${HOME}/secret/a`, mode: "ask", rules: { deny: ["Read(~/secret/**)"] } }).decision,
    "deny",
  );
  assert.equal(
    evalP({ rawPath: "/data/secret/a", mode: "ask", rules: { deny: ["Read(~/secret/**)"] } }).decision,
    "ask",
  );
});

test("前缀：/path 相对设定来源（settingsRoot）", () => {
  assert.equal(
    evalP({ rawPath: `${SETTINGS_ROOT}/proj/a`, mode: "ask", rules: { deny: ["Read(/proj/**)"] } }).decision,
    "deny",
  );
  assert.equal(
    evalP({ rawPath: `${HOME}/proj/a`, mode: "ask", rules: { deny: ["Read(/proj/**)"] } }).decision,
    "ask",
  );
});

test("前缀：无前缀 / ./x 为任意位置", () => {
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

test("/**：目录本身与其下皆命中；裸目录样式亦然", () => {
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

test("symlink 两态：deny 规则对 raw/resolved 任一命中即拒", () => {
  // raw 命中、resolved 干净
  assert.equal(
    evalP({
      rawPath: `${HOME}/sshTarget/x`,
      resolvedPath: `${HOME}/Movies/x`,
      mode: "ask",
      rules: { deny: ["Read(~/sshTarget/**)"] },
    }).decision,
    "deny",
  );
  // raw 干净、resolved 命中
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

test("symlink 两态：allow 规则要求所有路径皆命中，防走私出根", () => {
  const r = evalP({
    rawPath: `${HOME}/Movies/link`,
    resolvedPath: "/etc/hosts", // 解析后落在授权根外
    mode: "auto",
    rules: { allow: ["Read(~/Movies/**)"] },
    authorizedRoots: [`${HOME}/Movies`],
  });
  assert.notEqual(r.decision, "allow"); // 不得因 raw 命中 allow 就放行
  assert.equal(r.decision, "ask");
  assert.equal(r.reason, REASONS.DEFAULT_ASK);
});

// ---------------------------------------------------------------------------
// 四模式 ×（根内／根外／家目录）矩阵
// ---------------------------------------------------------------------------
test("四模式决策矩阵（无规则）：根内／根外／家目录", () => {
  const roots = [`${HOME}/proj`];
  const inside = `${HOME}/proj/a.txt`; // 授权根内（且在家目录内）
  const outside = "/data/b.txt"; // 根外且家外
  const inHome = `${HOME}/notes.txt`; // 家目录内、授权根外

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

test("模式：auto 空授权根＝不外放（fail-closed），full 家目录外问", () => {
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
// 硬 denylist 于 full 模式 + allow 规则下仍拒（每个样式）
// ---------------------------------------------------------------------------
test("硬 denylist 不可被 full 模式或 allow 规则绕过（逐样式）", () => {
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
    assert.equal(r.decision, "deny", `${p} 必须被硬 denylist 拒`);
    assert.equal(r.reason, REASONS.HARD_DENY, `${p} reason`);
  }
});

// ---------------------------------------------------------------------------
// suggestRoot
// ---------------------------------------------------------------------------
test("suggestRoot：回最接近目录；过宽根回 null", () => {
  assert.equal(suggestRoot(`${HOME}/Movies/a.mp4`, { home: HOME }), `${HOME}/Movies`);
  assert.equal(suggestRoot("/data/proj/x.txt", { home: HOME }), "/data/proj");
  assert.equal(suggestRoot(`${HOME}/Movies/Docs/x.mp4`, { home: HOME }), `${HOME}/Movies/Docs`);

  // 过宽根：一律 null（由呼叫端改要求单档授权）
  assert.equal(suggestRoot("/", { home: HOME }), null);
  assert.equal(suggestRoot(`${HOME}/x.mp4`, { home: HOME }), null); // 家目录本身
  assert.equal(suggestRoot("/home", { home: HOME }), null); // 家目录祖先
  assert.equal(suggestRoot("/tmp", { home: HOME }), null); // 单层目录
  assert.equal(suggestRoot("relative/x.txt", { home: HOME }), null); // 非绝对
  // 敏感目录不建议授权
  assert.equal(suggestRoot(`${HOME}/.config/x.txt`, { home: HOME }), null);
  assert.equal(suggestRoot(`${HOME}/proj/.git/x`, { home: HOME }), null);
});

// ---------------------------------------------------------------------------
// 硬 denylist 与 safety-check 清单不可为空（防清单被砍而测试沉默通过）
// ---------------------------------------------------------------------------
test("sanity：清单非空且决策必为三值之一", () => {
  assert.ok(HARD_DENY_PATTERNS.length > 0);
  assert.ok(SAFETY_CHECK_FILES.length > 0);
  assert.ok(SAFETY_CHECK_DIRS.length > 0);
  const r = evalP({ rawPath: "/tmp/a.txt" });
  assert.ok(["allow", "deny", "ask"].includes(r.decision));
});
// ---------------------------------------------------------------------------
// allowRuleForRoot（对话内就地授权）：产生与闸道 authorizationRuleSpecifier 同形的规则
// ---------------------------------------------------------------------------
test("allowRuleForRoot：与闸道 authorizationRuleSpecifier 同形（//<root>/**）", () => {
  assert.deepEqual(pr.allowRuleForRoot("/home/u/Downloads/"), {
    effect: "allow",
    tool: "*",
    specifier: "//home/u/Downloads/**",
  });
  assert.deepEqual(pr.allowRuleForRoot("  /home/u/Downloads  "), {
    effect: "allow",
    tool: "*",
    specifier: "//home/u/Downloads/**",
  });
});

test("allowRuleForRoot：规则以既有 matchSpecifier 语义命中该根及其下（不及其外）", () => {
  const rule = pr.allowRuleForRoot("/home/u/Downloads");
  const ctx = { home: HOME, settingsRoot: SETTINGS_ROOT };
  const hit = (p) => pr._internals.matchSpecifier(rule.specifier, pr._internals.toMatchPath(p, HOME), ctx);
  assert.equal(hit("/home/u/Downloads"), true);
  assert.equal(hit("/home/u/Downloads/a/b.txt"), true);
  assert.equal(hit("/home/u/Other/a.txt"), false);
  assert.equal(hit("/home/u/Downloadsevil/a"), false);
});

test("allowRuleForRoot：fail-closed（非字串／相对／过宽根 → null，不得变 //** 全放行）", () => {
  assert.equal(pr.allowRuleForRoot(123), null);
  assert.equal(pr.allowRuleForRoot(""), null);
  assert.equal(pr.allowRuleForRoot("relative/path"), null);
  assert.equal(pr.allowRuleForRoot("/"), null);
  assert.equal(pr.allowRuleForRoot("//"), null);
});

test("规则 tool 为 * 时对所有工具生效（与闸道 toolMatches 同语义）", () => {
  const r = evalP({
    tool: "list_dir",
    rawPath: "/data/x",
    resolvedPath: "/data/x",
    rules: { allow: [{ effect: "allow", tool: "*", specifier: "//data/**" }] },
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.reason, REASONS.RULE_ALLOW);
  // 非万用工具名仍只对同名工具生效
  const r2 = evalP({ tool: "list_dir", rawPath: "/data/x", rules: { allow: [{ effect: "allow", tool: "Read", specifier: "//data/**" }] } });
  assert.equal(r2.decision, "ask");
});
