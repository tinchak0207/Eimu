/**
 * device-bridge-permissions.test.ts — W6b 權限決策引擎（三桶規則／模式檔次／硬 denylist／
 * 需要授權的往返回路）的真值測試。
 *
 * 跑法：bash deploy-staging/vps-tools/run-tests.sh device-bridge-permissions.test.ts
 * 不打真服務、不碰真檔案、零網路、零付費。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  DANGEROUS_DIRECTORIES,
  DANGEROUS_FILES,
  DEVICE_BRIDGE_MODES,
  authorizationRootProblem,
  authorizationRuleSpecifier,
  evaluatePermission,
  isDeviceBridgeMode,
  isHardDeniedPath,
  isSafetyCheckPath,
  matchRuleSpecifier,
  sanitizePermissionRules,
  suggestAuthorizationRoot,
  type PermissionRule,
} from "./device-bridge-policy.ts"
import {
  DeviceBridge,
  OnceGrantStore,
  deviceBridgePolicyState,
  handleInternalDeviceAuthorize,
  handleInternalDeviceInvoke,
  handleInternalDeviceStatus,
  sanitizeToolArgs,
  type InternalDeviceRouteDeps,
} from "./device-bridge.ts"

const HOME = "/home/u"

interface PolicyVectors {
  hardDenylist: { path: unknown; expected: boolean; category: string }[]
  safetyCheck: { path: unknown; expected: boolean; category: string }[]
  ruleSpecifier: { specifier: string; path: string; home: string | null; configDir: string | null; expected: boolean; category: string }[]
}
const vectors = JSON.parse(
  readFileSync(new URL("./device-bridge-policy.vectors.json", import.meta.url), "utf8"),
) as PolicyVectors

function internalDeps(bridge: DeviceBridge, tenants: Record<string, string | null> = { sess_ok: "u:1" }): InternalDeviceRouteDeps {
  return { bridge, resolveTenant: async (sid) => (sid in tenants ? tenants[sid] : null) }
}
function registered(bridge: DeviceBridge, input: Record<string, unknown> = {}) {
  return bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", ...input })
}
const allowAll: PermissionRule = { effect: "allow", tool: "*" }

// ───────────────────────── 向量表：硬 denylist / safety / specifier ─────────────────────────

test("vectors: isHardDeniedPath 逐條符合向量表", () => {
  assert.ok(vectors.hardDenylist.length >= 30)
  for (const v of vectors.hardDenylist) assert.equal(isHardDeniedPath(v.path), v.expected, `${v.category}: ${JSON.stringify(v.path)}`)
})

test("vectors: isSafetyCheckPath 逐條符合向量表", () => {
  assert.ok(vectors.safetyCheck.length >= 15)
  for (const v of vectors.safetyCheck) assert.equal(isSafetyCheckPath(v.path), v.expected, `${v.category}: ${JSON.stringify(v.path)}`)
})

test("vectors: matchRuleSpecifier 逐條符合向量表（//｜~｜設定檔相對｜任意位置＋/**）", () => {
  assert.ok(vectors.ruleSpecifier.length >= 10)
  for (const v of vectors.ruleSpecifier) {
    const got = matchRuleSpecifier(v.specifier, v.path, { home: v.home, configDir: v.configDir ?? undefined })
    assert.equal(got, v.expected, `${v.category}: ${v.specifier} vs ${v.path}`)
  }
})

test("policy: safety 清單與 Claude Code 逐字一致", () => {
  for (const f of [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json", ".claude.json"]) {
    assert.equal(DANGEROUS_FILES.has(f), true, f)
  }
  for (const d of [".git", ".vscode", ".idea", ".claude"]) assert.equal(DANGEROUS_DIRECTORIES.has(d), true, d)
})

test("policy: isDeviceBridgeMode 只認四模式；sanitizePermissionRules 丟未知效果/工具並去重", () => {
  assert.deepEqual([...DEVICE_BRIDGE_MODES], ["off", "ask", "auto", "full"])
  for (const m of DEVICE_BRIDGE_MODES) assert.equal(isDeviceBridgeMode(m), true)
  for (const m of ["", "ASK", "always", null, 1]) assert.equal(isDeviceBridgeMode(m), false, String(m))
  const out = sanitizePermissionRules([
    { effect: "allow", tool: "read_file", specifier: "x" },
    { effect: "bogus", tool: "read_file" },
    { effect: "deny", tool: "exec" },
    { effect: "allow", tool: "read_file", specifier: "x" }, // 重複 → 去
    { effect: "ask", tool: "*" },
  ])
  assert.deepEqual(out, [
    { effect: "allow", tool: "read_file", specifier: "x" },
    { effect: "ask", tool: "*" },
  ])
})

// ───────────────────────── 判定序：逐序各一條 ─────────────────────────

test("判定序 1：硬 denylist > allow 規則（mode=full 也 deny）", () => {
  const v = evaluatePermission({ tool: "read_file", resolvedPath: "~/.ssh/id_rsa", mode: "full", rules: [allowAll], home: HOME })
  assert.equal(v.decision, "deny")
  assert.equal(v.reason, "denylist")
})

test("判定序 2：safety-check > allow 規則（一律 ask，不得自動放行）", () => {
  const v = evaluatePermission({ tool: "read_file", resolvedPath: `${HOME}/.bashrc`, mode: "full", rules: [allowAll], home: HOME })
  assert.equal(v.decision, "ask")
  assert.equal(v.reason, "safety_check")
})

test("判定序 3：規則 deny > 規則 allow（deny 壓過 allow）", () => {
  const rules: PermissionRule[] = [
    { effect: "allow", tool: "read_file", specifier: "~/project/**" },
    { effect: "deny", tool: "read_file", specifier: "~/project/notes.txt" },
  ]
  const v = evaluatePermission({ tool: "read_file", resolvedPath: `${HOME}/project/notes.txt`, mode: "full", rules, home: HOME })
  assert.equal(v.decision, "deny")
  assert.equal(v.reason, "rule_deny")
})

test("判定序 4：規則 ask > 規則 allow（ask 壓過 allow）", () => {
  const rules: PermissionRule[] = [
    { effect: "allow", tool: "read_file", specifier: "~/project/**" },
    { effect: "ask", tool: "read_file", specifier: "~/project/notes.txt" },
  ]
  const v = evaluatePermission({ tool: "read_file", resolvedPath: `${HOME}/project/notes.txt`, mode: "full", rules, home: HOME })
  assert.equal(v.decision, "ask")
  assert.equal(v.reason, "rule_ask")
})

test("判定序 5：規則 allow > 模式語義（mode=ask 也被 allow 放行）", () => {
  const v = evaluatePermission({ tool: "read_file", resolvedPath: `${HOME}/project/main.ts`, mode: "ask", rules: [{ effect: "allow", tool: "read_file", specifier: "~/project/**" }], home: HOME })
  assert.equal(v.decision, "allow")
  assert.equal(v.reason, "rule_allow")
})

test("判定序 6：模式語義 auto 根內放行 / 根外 ask", () => {
  const inRoot = evaluatePermission({ tool: "read_file", resolvedPath: `${HOME}/project/a.ts`, mode: "auto", authorizedRoots: [`${HOME}/project`], home: HOME })
  assert.deepEqual({ d: inRoot.decision, r: inRoot.reason }, { d: "allow", r: "authorized_root" })
  const outRoot = evaluatePermission({ tool: "read_file", resolvedPath: `${HOME}/other/a.ts`, mode: "auto", authorizedRoots: [`${HOME}/project`], home: HOME })
  assert.deepEqual({ d: outRoot.decision, r: outRoot.reason }, { d: "ask", r: "outside_roots" })
})

test("判定序 7：模式語義 full 家目錄內放行 / 家目錄外 ask", () => {
  const inHome = evaluatePermission({ tool: "read_file", resolvedPath: `${HOME}/anything/a.ts`, mode: "full", home: HOME })
  assert.deepEqual({ d: inHome.decision, r: inHome.reason }, { d: "allow", r: "home" })
  const outHome = evaluatePermission({ tool: "read_file", resolvedPath: "/tmp/a.txt", mode: "full", home: HOME })
  assert.deepEqual({ d: outHome.decision, r: outHome.reason }, { d: "ask", r: "outside_roots" })
})

test("判定序 8：mode=ask 無規則 → ask；mode=off → deny（先於一切）", () => {
  assert.equal(evaluatePermission({ tool: "stat", resolvedPath: `${HOME}/a.txt`, mode: "ask", home: HOME }).reason, "mode_ask")
  const off = evaluatePermission({ tool: "stat", resolvedPath: `${HOME}/a.txt`, mode: "off", rules: [allowAll], home: HOME })
  assert.deepEqual({ d: off.decision, r: off.reason }, { d: "deny", r: "mode_off" })
})

test("判定序 9：缺 mode 視為 ask（預設）", () => {
  const v = evaluatePermission({ tool: "stat", resolvedPath: `${HOME}/a.txt`, home: HOME })
  assert.equal(v.decision, "ask")
  assert.equal(v.reason, "mode_ask")
})

// ───────────────────────── 路徑前綴四語義 ＋ /** ＋ symlink 兩態 ─────────────────────────

test("specifier: //（檔案系統根絕對）、~/（家目錄）、/（設定檔相對）、無前綴（任意位置）＋/** 遞迴", () => {
  assert.equal(matchRuleSpecifier("//etc/hosts", "/etc/hosts", { home: HOME }), true)
  assert.equal(matchRuleSpecifier("~/projects/**", `${HOME}/projects/a/b.ts`, { home: HOME }), true)
  assert.equal(matchRuleSpecifier("/sub/x", "/cfg/sub/x", { home: HOME, configDir: "/cfg" }), true)
  assert.equal(matchRuleSpecifier("main.ts", "/deep/nested/main.ts", { home: HOME }), true)
  assert.equal(matchRuleSpecifier("~/projects", `${HOME}/projects/a.ts`, { home: HOME }), false) // 無 /** 只比相等
})

test("symlink 兩態：原始路徑與解析後路徑任一命中即算命中", () => {
  const rule: PermissionRule[] = [{ effect: "allow", tool: "read_file", specifier: "~/projects/**" }]
  const viaReal = evaluatePermission({ tool: "read_file", resolvedPath: "/tmp/link.txt", realPath: `${HOME}/projects/a.ts`, mode: "ask", rules: rule, home: HOME })
  assert.equal(viaReal.decision, "allow")
  const viaRaw = evaluatePermission({ tool: "read_file", resolvedPath: `${HOME}/projects/a.ts`, realPath: "/tmp/else.txt", mode: "ask", rules: rule, home: HOME })
  assert.equal(viaRaw.decision, "allow")
})

test("symlink 兩態：解析後落到硬 denylist 也要 deny", () => {
  const v = evaluatePermission({ tool: "read_file", resolvedPath: "/tmp/innocent.txt", realPath: `${HOME}/.ssh/id_rsa`, mode: "full", home: HOME })
  assert.deepEqual({ d: v.decision, r: v.reason }, { d: "deny", r: "denylist" })
})

// ───────────────────────── 四模式 × 邊界 決策矩陣 ─────────────────────────

test("決策矩陣：四模式 × 根內/根外（read_file）", () => {
  const cases: { mode: string; path: string; decision: string; reason: string }[] = [
    { mode: "off", path: `${HOME}/project/a.ts`, decision: "deny", reason: "mode_off" },
    { mode: "off", path: "/tmp/a.txt", decision: "deny", reason: "mode_off" },
    { mode: "ask", path: `${HOME}/project/a.ts`, decision: "ask", reason: "mode_ask" },
    { mode: "ask", path: "/tmp/a.txt", decision: "ask", reason: "mode_ask" },
    { mode: "auto", path: `${HOME}/project/a.ts`, decision: "allow", reason: "authorized_root" },
    { mode: "auto", path: `${HOME}/other/a.ts`, decision: "ask", reason: "outside_roots" },
    { mode: "full", path: `${HOME}/other/a.ts`, decision: "allow", reason: "home" },
    { mode: "full", path: "/tmp/a.txt", decision: "ask", reason: "outside_roots" },
  ]
  for (const c of cases) {
    const v = evaluatePermission({ tool: "read_file", resolvedPath: c.path, mode: c.mode, authorizedRoots: [`${HOME}/project`], home: HOME })
    assert.deepEqual({ d: v.decision, r: v.reason }, { d: c.decision, r: c.reason }, `${c.mode} ${c.path}`)
  }
})

test("決策矩陣：硬 denylist 在 mode=full ＋ allow 規則下仍 deny（逐條）", () => {
  for (const v of vectors.hardDenylist) {
    if (!v.expected || typeof v.path !== "string") continue
    const verdict = evaluatePermission({
      tool: "read_file",
      resolvedPath: v.path,
      mode: "full",
      rules: [allowAll],
      home: HOME,
    })
    assert.deepEqual({ d: verdict.decision, r: verdict.reason }, { d: "deny", r: "denylist" }, `${v.category}: ${JSON.stringify(v.path)}`)
  }
})

test("決策矩陣：檔案系統根在 mode=full ＋ allow 規則下仍 deny（不得遞迴整碟）", () => {
  // 判定序步驟 2（denylist 之後、safety 之前）先前零直接覆蓋：既有向量表只測
  // isFilesystemRoot 純函式，未測 evaluatePermission 真的把它當 deny 且不可被繞。
  for (const p of ["/", "C:\\", "C:/", "//server/share"]) {
    const v = evaluatePermission({ tool: "read_file", resolvedPath: p, mode: "full", rules: [allowAll], home: HOME })
    assert.deepEqual({ d: v.decision, r: v.reason }, { d: "deny", r: "filesystem_root" }, p)
  }
})

// ───────────────────────── invoke：needs_authorization 往返回路 ─────────────────────────

test("invoke: 配置 mode=ask 且無規則 → needs_authorization（HTTP 200，帶 root/reason/options）", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 30 })
  const reg = registered(bridge, { mode: "ask", home: HOME })
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: `${HOME}/project/src/a.ts` } })
  assert.equal(out.ok, false)
  const err = out as { ok: false; code: string; needsAuthorization?: { root: string; reason: string; options: { scope: string }[] } }
  assert.equal(err.code, "needs_authorization")
  assert.equal(err.needsAuthorization?.root, `${HOME}/project/src`)
  assert.equal(err.needsAuthorization?.reason, "mode_ask")
  assert.deepEqual(err.needsAuthorization?.options, [{ scope: "once" }, { scope: "session" }, { scope: "permanent" }])
})

test("invoke: denylist 不得回 needs_authorization（硬 deny → sensitive_path）", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 30 })
  const reg = registered(bridge, { mode: "full", rules: [{ effect: "allow", tool: "*" }], home: HOME })
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: "~/.ssh/id_rsa" } })
  assert.equal(out.ok, false)
  const err = out as { ok: false; code: string; needsAuthorization?: unknown }
  assert.equal(err.code, "sensitive_path")
  assert.equal(err.needsAuthorization, undefined)
})

test("internal /invoke: needs_authorization 回 HTTP 200 與凍結 body 形狀", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 30 })
  registered(bridge, { mode: "ask", home: HOME })
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", {
    method: "POST",
    body: JSON.stringify({ op: "read_file", path: `${HOME}/project/a.txt` }),
  })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 200)
  const body = (await res.json()) as { ok: boolean; error: { code: string; message: string; root: string; reason: string; options: { scope: string }[] } }
  assert.equal(body.ok, false)
  assert.equal(body.error.code, "needs_authorization")
  assert.equal(body.error.message, "此路徑尚未授權。")
  assert.equal(body.error.root, `${HOME}/project`)
  assert.equal(body.error.reason, "mode_ask")
  assert.deepEqual(body.error.options, [{ scope: "once" }, { scope: "session" }, { scope: "permanent" }])
})

test("internal /invoke: safety 檔案在 mode=full 且有 allow 規則下仍 needs_authorization(reason=safety_check)", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 30 })
  registered(bridge, { mode: "full", rules: [allowAll], home: HOME })
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", {
    method: "POST",
    body: JSON.stringify({ op: "read_file", path: `${HOME}/.bashrc` }),
  })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 200)
  const body = (await res.json()) as { error: { code: string; reason: string } }
  assert.equal(body.error.code, "needs_authorization")
  assert.equal(body.error.reason, "safety_check")
})

// ───────────────────────── authorize 端點：三 scope ＋ 四錯誤碼 ─────────────────────────

function authorizeReq(body: Record<string, unknown>, sid = "sess_ok") {
  return new Request(`http://gw.internal/internal/device/authorize?session_id=${sid}`, { method: "POST", body: JSON.stringify(body) })
}

test("authorize once：回 token 且不落規則（rules 不變）", async () => {
  const bridge = new DeviceBridge()
  registered(bridge, { mode: "ask", roots: [`${HOME}/project`], home: HOME })
  const res = await handleInternalDeviceAuthorize(authorizeReq({ scope: "once", root: `${HOME}/project` }), internalDeps(bridge))
  assert.equal(res.status, 200)
  const body = (await res.json()) as { ok: boolean; token?: string; applied: { scope: string; root: string }; rules: unknown[] }
  assert.equal(body.ok, true)
  assert.equal(typeof body.token, "string")
  assert.deepEqual(body.applied, { scope: "once", root: `${HOME}/project` })
  assert.deepEqual(body.rules, [])
})

test("authorize session：加進規則集並回傳之；permanent 另回 persist_on_device", async () => {
  const bridge = new DeviceBridge()
  registered(bridge, { mode: "ask", home: HOME })
  const s = await handleInternalDeviceAuthorize(authorizeReq({ scope: "session", root: `${HOME}/project` }), internalDeps(bridge))
  assert.equal(s.status, 200)
  const sb = (await s.json()) as { ok: boolean; rules: PermissionRule[] }
  assert.equal(sb.rules.length, 1)
  assert.equal(sb.rules[0].effect, "allow")
  assert.equal(sb.rules[0].specifier, authorizationRuleSpecifier(`${HOME}/project`))

  const p = await handleInternalDeviceAuthorize(authorizeReq({ scope: "permanent", root: `${HOME}/docs` }), internalDeps(bridge))
  assert.equal(p.status, 200)
  const pb = (await p.json()) as { ok: boolean; persist_on_device?: boolean; rules: PermissionRule[] }
  assert.equal(pb.persist_on_device, true)
  assert.equal(pb.rules.length, 2)
})

test("authorize 錯誤碼：bad_request / session_unknown / root_not_absolute / root_too_broad / denylisted_root", async () => {
  const bridge = new DeviceBridge()
  registered(bridge, { mode: "ask", home: HOME })
  const codes: [Record<string, unknown>, string, number][] = [
    [{ scope: "always", root: `${HOME}/project` }, "bad_request", 400],
    [{ scope: "session" }, "bad_request", 400],
    [{ scope: "session", root: "relative/path" }, "root_not_absolute", 400],
    [{ scope: "session", root: "/" }, "root_too_broad", 403],
    [{ scope: "session", root: "/home" }, "root_too_broad", 403],
    [{ scope: "session", root: "~" }, "root_too_broad", 403], // 家目錄本身（mode!=full）
    [{ scope: "session", root: `${HOME}/.ssh` }, "denylisted_root", 403],
  ]
  for (const [body, code, status] of codes) {
    const res = await handleInternalDeviceAuthorize(authorizeReq(body), internalDeps(bridge))
    assert.equal(res.status, status, `${code}`)
    const j = (await res.json()) as { error: { code: string } }
    assert.equal(j.error.code, code, JSON.stringify(body))
  }
})

test("authorize: session 解析不到 → session_unknown", async () => {
  const bridge = new DeviceBridge()
  const res = await handleInternalDeviceAuthorize(authorizeReq({ scope: "session", root: `${HOME}/project` }, "nope"), internalDeps(bridge))
  assert.equal(res.status, 404)
  const j = (await res.json()) as { error: { code: string } }
  assert.equal(j.error.code, "session_unknown")
})

// ───────────────────────── once token：用一次即失效（重放被拒）─────────────────────────

test("once token 可放行一次；重放被拒（回 needs_authorization）", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 40 })
  const reg = registered(bridge, { mode: "ask", home: HOME })
  const ares = await handleInternalDeviceAuthorize(authorizeReq({ scope: "once", root: `${HOME}/project` }), internalDeps(bridge))
  const { token } = (await ares.json()) as { token: string }

  // 帶 token：通過權限（之後因裝置不回而逾時 → 證明「已放行」）。
  const first = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: `${HOME}/project/a.txt` }, authorizationToken: token })
  assert.equal(first.ok, false)
  assert.equal((first as { code: string }).code, "device_request_timeout")

  // 重放同一 token：不再放行 → needs_authorization。
  const replay = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: `${HOME}/project/a.txt` }, authorizationToken: token })
  assert.equal((replay as { code: string }).code, "needs_authorization")
})

test("once token：工具綁定不符 → 不放行", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 40 })
  const reg = registered(bridge, { mode: "ask", home: HOME })
  const ares = await handleInternalDeviceAuthorize(authorizeReq({ scope: "once", root: `${HOME}/project`, tool: "read_file" }), internalDeps(bridge))
  const { token } = (await ares.json()) as { token: string }
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "stat", args: { path: `${HOME}/project/a.txt` }, authorizationToken: token })
  assert.equal((out as { code: string }).code, "needs_authorization")
})

test("OnceGrantStore: 過期 / 找不到 / root 外 / 重放", () => {
  const store = new OnceGrantStore()
  const t = store.mint({ tenant: "u:1", root: `${HOME}/project` }, 100, 1000)
  assert.deepEqual(store.consume("ag_missing", { tenant: "u:1", tool: "read_file", path: `${HOME}/project/a` }, 1001), { ok: false, code: "authorization_token_not_found" })
  assert.deepEqual(store.consume(t, { tenant: "u:1", tool: "read_file", path: `${HOME}/other/a` }, 1001), { ok: false, code: "authorization_token_mismatch" })
  assert.deepEqual(store.consume(t, { tenant: "u:1", tool: "read_file", path: `${HOME}/project/a` }, 1001), { ok: true })
  assert.deepEqual(store.consume(t, { tenant: "u:1", tool: "read_file", path: `${HOME}/project/a` }, 1002), { ok: false, code: "authorization_token_replayed" })
  const t2 = store.mint({ tenant: "u:1", root: `${HOME}/project` }, 10, 1000)
  assert.deepEqual(store.consume(t2, { tenant: "u:1", tool: "read_file", path: `${HOME}/project/a` }, 1011), { ok: false, code: "authorization_token_expired" })
})

// ───────────────────────── status：mode 與 rules ─────────────────────────

test("internal /status: 回傳 mode 與 rules", async () => {
  const bridge = new DeviceBridge()
  registered(bridge, { mode: "auto", roots: [`${HOME}/project`], home: HOME })
  const res = await handleInternalDeviceStatus(
    new Request("http://gw.internal/internal/device/status?session_id=sess_ok", { method: "GET" }),
    internalDeps(bridge),
  )
  assert.equal(res.status, 200)
  const body = (await res.json()) as { device: { mode: string; rules: unknown[]; roots: string[] } }
  assert.equal(body.device.mode, "auto")
  assert.deepEqual(body.device.rules, [])
  assert.deepEqual(body.device.roots, [`${HOME}/project`])
})

// ───────────────────────── 加嚴 ＋ 相容 ─────────────────────────

test("sanitizeToolArgs: 硬 denylist 加嚴（未配置模式的舊呼叫端也擋 .pem/.env/config）", () => {
  for (const p of ["/home/u/cert.pem", "/home/u/.env", `${HOME}/.config/Code/User/settings.json`, "/etc/shadow"]) {
    const r = sanitizeToolArgs("read_file", { path: p })
    assert.equal(r.ok, false, p)
    if (!r.ok) assert.equal(r.code, "sensitive_path", p)
  }
})

test("相容：register 未帶 mode/rules → 沿用升級前行為（路徑不進授權流程）", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 40 })
  const reg = registered(bridge) // 未帶 mode
  assert.equal(reg.permissionsEnabled, false)
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: "/tmp/a.txt" } })
  assert.equal(out.ok, false)
  assert.equal((out as { code: string }).code, "device_request_timeout") // 有走到下發，不是 needs_authorization
})

test("deviceBridgePolicyState: 總開關未開／無在線裝置 → null；在線 → mode/roots", () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  registered(bridge, { mode: "auto", roots: [`${HOME}/project`, `${HOME}/docs`], home: HOME, now: T })
  assert.equal(deviceBridgePolicyState(1, { bridge, env: {}, now: T }), null)
  assert.deepEqual(deviceBridgePolicyState(1, { bridge, env: { EIMU_DEVICE_BRIDGE: "1" }, now: T }), {
    mode: "auto",
    authorizedRoots: [`${HOME}/project`, `${HOME}/docs`],
  })
  assert.equal(deviceBridgePolicyState(1, { bridge, env: { EIMU_DEVICE_BRIDGE: "1" }, now: T + 90_001 }), null)
})

test("suggestAuthorizationRoot: 取檔案之上最接近的目錄", () => {
  assert.equal(suggestAuthorizationRoot(`${HOME}/project/src/a.ts`, HOME), `${HOME}/project/src`)
  assert.equal(suggestAuthorizationRoot("~/project/a.ts", HOME), `${HOME}/project`)
  assert.equal(suggestAuthorizationRoot("/tmp/a.txt", HOME), "/tmp")
  assert.equal(suggestAuthorizationRoot("relative/x", HOME), null)
})

test("authorizationRootProblem: 絕對/過寬/denylisted 判定", () => {
  assert.equal(authorizationRootProblem(`${HOME}/project`, HOME, "ask"), null)
  assert.equal(authorizationRootProblem("relative/x", HOME, "ask"), "root_not_absolute")
  assert.equal(authorizationRootProblem("/", HOME, "ask"), "root_too_broad")
  assert.equal(authorizationRootProblem(`${HOME}/.aws`, HOME, "ask"), "denylisted_root")
  assert.equal(authorizationRootProblem("~", HOME, "full"), null) // mode=full 允許家目錄本身
})