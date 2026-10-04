/**
 * device-bridge.test.ts — W6a 装置桥云端侧的纯逻辑真值测试。
 * 跑法：npx --yes tsx --test deploy-staging/gateway/device-bridge.test.ts
 *
 * 不打真服务、不碰真档案、零上游／零付费。涵盖：
 *   - denylist（含路径逃逸 ..、前缀混淆、大小写、symlink 字面）
 *   - 工具白名单
 *   - 大小夹制与截断标记
 *   - 同意票验证（过期／不匹配／重放 各一例）
 *   - 注册/心跳/轮询/回传/逾时的端到端（记忆体内）
 *   - 预设 OFF（env 未设时 handler 直接 404、不触网）
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  DEVICE_BRIDGE_TOOLS,
  MAX_READ_BYTES,
  DEFAULT_READ_BYTES,
  MAX_FILE_READ_BYTES,
  isSensitivePath,
  isFilesystemRoot,
  isPathWithinRoot,
  isToolAllowed,
  clampReadSize,
  clampFileBytes,
  matchRuleSpecifier,
  recursiveRootProblem,
  sanitizeAuthorizedRoots,
  sensitiveResultProblem,
  suggestAuthorizationRoot,
  truncateWithMarker,
  type PermissionRule,
} from "./device-bridge-policy.ts"
import {
  DeviceBridge,
  ConsentTokenStore,
  deviceBridgeEnabled,
  deviceBridgeRuntimeState,
  finalizeDeviceResult,
  sanitizeToolArgs,
  handleDeviceBridgeRoutes,
  handleInternalDeviceAuthorize,
  handleInternalDeviceInvoke,
  handleInternalDeviceStatus,
  type InternalDeviceRouteDeps,
} from "./device-bridge.ts"

// ───────────────────────── denylist ─────────────────────────

test("isSensitivePath: Claude Code 敏感清单逐条命中", () => {
  const hits = [
    "~/.ssh/id_rsa",
    "~/.aws/credentials",
    "~/.gnupg/secring.gpg",
    "~/.kube/config",
    "~/.docker/config.json",
    "~/.git-credentials",
    "~/.netrc",
    "~/.npmrc",
    "~/.pgpass",
    "~/.bash_history",
    "~/.zsh_history",
    "/home/lenovo/.ssh/id_ed25519",
    "/root/.aws/config",
  ]
  for (const p of hits) assert.equal(isSensitivePath(p), true, p)
})

test("isSensitivePath: 浏览器 profile 目录命中（Linux 与 macOS）", () => {
  const hits = [
    "~/.config/google-chrome/Default/Cookies",
    "~/.config/chromium/Default/Login Data",
    "~/.config/brave-browser/Default/History",
    "~/.mozilla/firefox/abc123.default/cookies.sqlite",
    "~/Library/Application Support/Google/Chrome/Default/Login Data",
    "~/Library/Application Support/Firefox/Profiles/x.default/cookies.sqlite",
  ]
  for (const p of hits) assert.equal(isSensitivePath(p), true, p)
})

test("isSensitivePath: 路径逃逸 '..' 仍命中（扫描所有段，不比前缀）", () => {
  assert.equal(isSensitivePath("~/.ssh/../../etc/passwd"), true)
  assert.equal(isSensitivePath("/tmp/../.ssh/id_rsa"), true)
  assert.equal(isSensitivePath("a/../../.aws/credentials"), true)
  assert.equal(isSensitivePath("./deep/../../x/.netrc"), true)
})

test("isSensitivePath: 前缀混淆不误命中（真档名不是敏感目录）", () => {
  assert.equal(isSensitivePath("~/.sshfoo/id_rsa"), false)
  assert.equal(isSensitivePath("~/.ssh-backup/keys"), false)
  assert.equal(isSensitivePath("~/.ssh2/id"), false)
  assert.equal(isSensitivePath("/tmp/notes.ssh.md"), false)
  assert.equal(isSensitivePath("~/.netrc.bak"), false) // basename 不精确相等
})

test("isSensitivePath: 大小写一律 fail-closed（.SSH/.Aws 也挡）", () => {
  assert.equal(isSensitivePath("~/.SSH/id_rsa"), true)
  assert.equal(isSensitivePath("~/.Aws/credentials"), true)
  assert.equal(isSensitivePath("C:\\Users\\me\\.Ssh\\id_rsa"), true)
})

test("isSensitivePath: Windows 反斜线分隔符照样正规化", () => {
  assert.equal(isSensitivePath("C:\\Users\\me\\.ssh\\id_rsa"), true)
  assert.equal(isSensitivePath("C:\\Users\\me\\project\\a.ts"), false)
})

test("isSensitivePath: symlink 字面 — 纯字串判定跟不了 symlink（已知限制，daemon 须 realpath）", () => {
  // `~/link_to_ssh -> ~/.ssh`：字串不含 `.ssh` 段 → 本函式回 false。
  assert.equal(isSensitivePath("~/link_to_ssh/id_rsa"), false)
  // daemon realpath 后得到真实目标，再跑同一支判定 → 命中。两层合力才完整。
  assert.equal(isSensitivePath("/home/me/.ssh/id_rsa"), true)
})

test("isSensitivePath: 非敏感一般路径放行", () => {
  for (const p of ["/tmp/a.txt", "~/projects/app.ts", "~/.config/Code/User/settings.json", "/etc/hosts"]) {
    assert.equal(isSensitivePath(p), false, p)
  }
})

test("isSensitivePath: 缺值／型别错／空字串一律 fail-closed 视为敏感", () => {
  assert.equal(isSensitivePath(""), true)
  assert.equal(isSensitivePath("   "), true)
  assert.equal(isSensitivePath(null), true)
  assert.equal(isSensitivePath(undefined), true)
  assert.equal(isSensitivePath(123), true)
})

// ───────────────────────── 工具白名单 ─────────────────────────

test("isToolAllowed: 最小集合四工具放行、其余全挡", () => {
  assert.deepEqual([...DEVICE_BRIDGE_TOOLS], ["list_dir", "read_file", "grep", "stat"])
  for (const t of DEVICE_BRIDGE_TOOLS) assert.equal(isToolAllowed(t), true, t)
  for (const t of ["write_file", "delete_file", "rm", "exec", "bash", "Read", "read_file ", "", null, 1]) {
    assert.equal(isToolAllowed(t), false, String(t))
  }
})

// ───────────────────────── 大小夹制 ─────────────────────────

test("clampReadSize: 缺值/非正数 → 预设，超限 → 上限，其余取整", () => {
  assert.equal(clampReadSize(undefined), DEFAULT_READ_BYTES)
  assert.equal(clampReadSize(0), DEFAULT_READ_BYTES)
  assert.equal(clampReadSize(-5), DEFAULT_READ_BYTES)
  assert.equal(clampReadSize(Number.NaN), DEFAULT_READ_BYTES)
  assert.equal(clampReadSize(Infinity), DEFAULT_READ_BYTES)
  assert.equal(clampReadSize("1024"), DEFAULT_READ_BYTES)
  assert.equal(clampReadSize(1000), 1000)
  assert.equal(clampReadSize(512.9), 512)
  assert.equal(clampReadSize(MAX_READ_BYTES * 10), MAX_READ_BYTES)
})

// ───────────────────────── 截断标记 ─────────────────────────

test("truncateWithMarker: 未超限原样、超限附标记且 keptBytes<=max", () => {
  const short = truncateWithMarker("hello", 100)
  assert.equal(short.truncated, false)
  assert.equal(short.text, "hello")
  assert.equal(short.keptBytes, 5)

  const long = "A".repeat(500)
  const t = truncateWithMarker(long, 100)
  assert.equal(t.truncated, true)
  assert.ok(t.keptBytes <= 100)
  assert.ok(t.keptBytes > 0)
  assert.match(t.text, /\[truncated \d+ bytes\]$/)
  assert.ok(t.text.startsWith("A".repeat(t.keptBytes)))
})

test("truncateWithMarker: 多位元组 UTF-8 边界安全（尾端不留替换字元）", () => {
  const text = "é".repeat(200) // 每字 2 bytes
  const t = truncateWithMarker(text, 101) // 101 为奇数，必切在字元中间
  assert.equal(t.truncated, true)
  assert.ok(t.keptBytes % 2 === 0, `keptBytes=${t.keptBytes} 应落在字元边界`)
  assert.equal(t.text.includes("\uFFFD"), false)
})

test("finalizeDeviceResult: read_file 的 text 受 256KB 硬上限", () => {
  const big = "x".repeat(MAX_READ_BYTES + 5000)
  const out = finalizeDeviceResult({ path: "/tmp/big.txt", text: big })
  assert.equal(out.truncated, true)
  assert.ok(out.bytes <= MAX_READ_BYTES)
  assert.equal(typeof out.result.truncated_bytes, "number")
  assert.match(String(out.result.text), /\[truncated \d+ bytes\]$/)
})

test("finalizeDeviceResult: 结构化结果过大 → 包成截断文字壳", () => {
  const out = finalizeDeviceResult({
    entries: Array.from({ length: 20000 }, (_, i) => `entry-${i}-${"x".repeat(20)}`),
  })
  assert.equal(out.truncated, true)
  assert.equal(out.result.truncated, true)
  assert.equal(typeof out.result.text, "string")
})

// ───────────────────────── 同意票验证 ─────────────────────────

test("consent token: happy path — 单次可用，第二次为重放", () => {
  const store = new ConsentTokenStore()
  const token = store.mint({ deviceId: "dev1", tool: "read_file", requestId: "req1" }, 1000, 100)
  assert.equal(store.size(), 1)
  assert.deepEqual(store.consume(token, { deviceId: "dev1", tool: "read_file", requestId: "req1" }, 200), { ok: true })
  assert.deepEqual(store.consume(token, { deviceId: "dev1", tool: "read_file", requestId: "req1" }, 201), {
    ok: false,
    code: "consent_token_replayed",
  })
})

test("consent token: 找不到的票", () => {
  const store = new ConsentTokenStore()
  assert.deepEqual(store.consume("ct_missing", { deviceId: "dev1", tool: "read_file", requestId: "req1" }), {
    ok: false,
    code: "consent_token_not_found",
  })
  assert.deepEqual(store.consume("", { deviceId: "dev1", tool: "read_file", requestId: "req1" }), {
    ok: false,
    code: "consent_token_not_found",
  })
})

test("consent token: 过期（且顺手删除）", () => {
  const store = new ConsentTokenStore()
  const token = store.mint({ deviceId: "dev1", tool: "stat", requestId: "req2" }, 10, 1000)
  assert.deepEqual(store.consume(token, { deviceId: "dev1", tool: "stat", requestId: "req2" }, 1011), {
    ok: false,
    code: "consent_token_expired",
  })
  assert.equal(store.size(), 0)
})

test("consent token: 绑定不匹配（装置／工具／请求 id 任一不符）", () => {
  const store = new ConsentTokenStore()
  const token = store.mint({ deviceId: "dev1", tool: "read_file", requestId: "req3" }, 1000, 0)
  assert.deepEqual(store.consume(token, { deviceId: "dev2", tool: "read_file", requestId: "req3" }, 1), {
    ok: false,
    code: "consent_token_mismatch",
  })
  assert.deepEqual(store.consume(token, { deviceId: "dev1", tool: "grep", requestId: "req3" }, 1), {
    ok: false,
    code: "consent_token_mismatch",
  })
  assert.deepEqual(store.consume(token, { deviceId: "dev1", tool: "read_file", requestId: "reqX" }, 1), {
    ok: false,
    code: "consent_token_mismatch",
  })
})

// ───────────────────────── 参数净化 ─────────────────────────

test("sanitizeToolArgs: 敏感路径在闸道侧就被挡", () => {
  const r = sanitizeToolArgs("read_file", { path: "~/.ssh/id_rsa" })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "sensitive_path")
})

test("sanitizeToolArgs: read_file limit 被夹到上限、offset 预设 0", () => {
  const r = sanitizeToolArgs("read_file", { path: "/tmp/a.txt", limit: 10 * MAX_READ_BYTES })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.args.limit, MAX_READ_BYTES)
    assert.equal(r.args.offset, 0)
  }
})

test("sanitizeToolArgs: grep 缺 pattern → bad_request", () => {
  const r = sanitizeToolArgs("grep", { path: "/tmp" })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "bad_request")
})

// ───────────────────────── 桥：注册／心跳／invoke ─────────────────────────

function registeredBridge(opts: ConstructorParameters<typeof DeviceBridge>[0] = {}) {
  const bridge = new DeviceBridge(opts)
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1" })
  return { bridge, reg }
}

test("invoke: 非白名单工具直接拒（连装置都不查）", async () => {
  const { bridge, reg } = registeredBridge()
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "write_file", args: { path: "/tmp/a" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "tool_not_allowed")
})

test("invoke: 敏感路径拒", async () => {
  const { bridge, reg } = registeredBridge()
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "stat", args: { path: "~/.aws/credentials" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "sensitive_path")
})

test("invoke: 未注册装置 → device_offline", async () => {
  const bridge = new DeviceBridge()
  const out = await bridge.invoke({ tenant: "u:1", deviceId: "dev_nope", tool: "stat", args: { path: "/tmp/a" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "device_offline")
})

test("invoke: 心跳过期 → device_offline", async () => {
  const bridge = new DeviceBridge({ heartbeatTtlMs: 1000 })
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", now: Date.now() - 60_000 })
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "stat", args: { path: "/tmp/a" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "device_offline")
})

test("invoke → poll → submitResult（带同意票）→ 收到结果", async () => {
  const { bridge, reg } = registeredBridge({ requestTimeoutMs: 2000 })
  const pending = bridge.invoke({
    tenant: "u:1",
    deviceId: reg.deviceId,
    tool: "read_file",
    args: { path: "/tmp/a.txt", limit: 16 },
  })

  const polled = await bridge.poll({ tenant: "u:1", deviceId: reg.deviceId, connectionId: reg.connectionId })
  assert.equal(polled.ok, true)
  if (!polled.ok || !polled.request) throw new Error("expected a request")
  const msg = polled.request
  assert.equal(msg.tool, "read_file")
  assert.equal(typeof msg.consent_token, "string")
  assert.ok(msg.expires_at > msg.issued_at)

  const sub = bridge.submitResult({
    tenant: "u:1",
    deviceId: reg.deviceId,
    connectionId: reg.connectionId,
    requestId: msg.request_id,
    consentToken: msg.consent_token,
    result: { path: "/tmp/a.txt", text: "hello world" },
  })
  assert.equal(sub.ok, true)

  const out = await pending
  assert.equal(out.ok, true)
  if (out.ok) {
    assert.equal(out.result.text, "hello world")
    assert.equal(out.truncated, false)
  }
})

test("invoke: submitResult 带错票（重放另一票）→ 拒绝且请求不落地", async () => {
  const { bridge, reg } = registeredBridge({ requestTimeoutMs: 2000 })
  // 先消耗一张无关票，制造一个「已被用过」的 token。
  const stale = bridge.tokens.mint({ deviceId: "other", tool: "stat", requestId: "other" }, 1000)
  bridge.tokens.consume(stale, { deviceId: "other", tool: "stat", requestId: "other" })

  const pending = bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "stat", args: { path: "/tmp/a" } })
  const polled = await bridge.poll({ tenant: "u:1", deviceId: reg.deviceId, connectionId: reg.connectionId })
  if (!polled.ok || !polled.request) throw new Error("expected a request")
  const bad = bridge.submitResult({
    tenant: "u:1",
    deviceId: reg.deviceId,
    connectionId: reg.connectionId,
    requestId: polled.request.request_id,
    consentToken: stale, // 绑定不符
    result: { text: "nope" },
  })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.code, "consent_token_mismatch")
  // 正确票仍可用 → 请求没被坏回传毁掉。
  const good = bridge.submitResult({
    tenant: "u:1",
    deviceId: reg.deviceId,
    connectionId: reg.connectionId,
    requestId: polled.request.request_id,
    consentToken: polled.request.consent_token,
    result: { path: "/tmp/a", size: 1 },
  })
  assert.equal(good.ok, true)
  const out = await pending
  assert.equal(out.ok, true)
})

test("invoke: 逾时取消 → device_request_timeout", async () => {
  const { bridge, reg } = registeredBridge({ requestTimeoutMs: 40 })
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "stat", args: { path: "/tmp/a" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "device_request_timeout")
  assert.equal(bridge.stats().pending, 0)
})

test("心跳：连线不符 → device_connection_stale", () => {
  const { bridge, reg } = registeredBridge()
  const hb = bridge.heartbeat({ tenant: "u:1", deviceId: reg.deviceId, connectionId: "conn_wrong" })
  assert.equal(hb.ok, false)
  assert.equal(hb.code, "device_connection_stale")
})

test("poll：waitMs=0 无待办 → request:null", async () => {
  const { bridge, reg } = registeredBridge()
  const out = await bridge.poll({ tenant: "u:1", deviceId: reg.deviceId, connectionId: reg.connectionId, waitMs: 0 })
  assert.deepEqual(out, { ok: true, request: null })
})

// 重连幽灵 waiter（2026-10-04）：旧连线的长轮询 waiter 未清理时，新连线的第一发 invoke
// 会被它 shift 走、回给已 abort 的旧 HTTP ⇒ 请求凭空消失、吃满 timeout。waiter 必须绑
// connectionId 并在唤醒后重验；不符者不得取件（已取则 re-queue）。
test("重连幽灵 waiter：旧连线残留长轮询不得吞掉新连线的第一发 invoke", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 1_500 })
  const reg1 = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", deviceId: "dev_stable", roots: ["/home/u/project"] })
  // 旧连线挂起一个长轮询（真实世界其 HTTP 已因重连被 abort，但 waiter 尚未清理）。
  const oldPoll = bridge.poll({ tenant: "u:1", deviceId: "dev_stable", connectionId: reg1.connectionId, waitMs: 5_000 })
  // 装置重连：同 deviceId（同 deviceKey）⇒ 旧连线作废。
  const reg2 = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", deviceId: "dev_stable", roots: ["/home/u/project"] })
  assert.notEqual(reg2.connectionId, reg1.connectionId)

  const pending = bridge.invoke({ tenant: "u:1", deviceId: "dev_stable", tool: "stat", args: { path: "/home/u/project/a.txt" } })
  // 让被 notifyPoll 唤醒的幽灵 waiter（若有）的 microtask 先有机会跑。
  await new Promise((r) => setTimeout(r, 20))

  const polled2 = await bridge.poll({ tenant: "u:1", deviceId: "dev_stable", connectionId: reg2.connectionId, waitMs: 0 })
  assert.equal(polled2.ok, true)
  if (!polled2.ok) return
  assert.ok(polled2.request, "新连线的第一次 poll 必须拿到请求（不可被幽灵 waiter 吞掉）")
  const msg = polled2.request!
  const sub = bridge.submitResult({
    tenant: "u:1",
    deviceId: "dev_stable",
    connectionId: reg2.connectionId,
    requestId: msg.request_id,
    consentToken: msg.consent_token,
    result: { path: "/home/u/project/a.txt", size: 3 },
  })
  assert.equal(sub.ok, true)
  const out = await pending
  assert.equal(out.ok, true)
  if (out.ok) assert.equal(out.result.size, 3)

  // 旧连线的长轮询必须以 stale 收场（不得回出任何请求）。
  const oldOut = await oldPoll
  assert.equal(oldOut.ok, false)
  if (!oldOut.ok) assert.equal(oldOut.code, "device_connection_stale")
})

// ───────────────────────── 预设 OFF ─────────────────────────

test("deviceBridgeEnabled: 预设 OFF，仅 truthy 开启", () => {
  assert.equal(deviceBridgeEnabled({} as NodeJS.ProcessEnv), false)
  assert.equal(deviceBridgeEnabled({ EIMU_DEVICE_BRIDGE: "" } as NodeJS.ProcessEnv), false)
  assert.equal(deviceBridgeEnabled({ EIMU_DEVICE_BRIDGE: "0" } as NodeJS.ProcessEnv), false)
  assert.equal(deviceBridgeEnabled({ EIMU_DEVICE_BRIDGE: "off" } as NodeJS.ProcessEnv), false)
  for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) {
    assert.equal(deviceBridgeEnabled({ EIMU_DEVICE_BRIDGE: v } as NodeJS.ProcessEnv), true, v)
  }
})

test("handler：开关未开时任何 device-bridge 路由一律 404（且不触网）", async () => {
  const saved = process.env.EIMU_DEVICE_BRIDGE
  delete process.env.EIMU_DEVICE_BRIDGE
  try {
    const req = new Request("http://gw.internal/agent/v1/device-bridge/register", { method: "POST", body: "{}" })
    const res = await handleDeviceBridgeRoutes(req, { rawKey: "placeholder-not-a-credential", pathname: "/agent/v1/device-bridge/register" })
    assert.equal(res.status, 404)
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error.code, "not_found")
  } finally {
    if (saved === undefined) delete process.env.EIMU_DEVICE_BRIDGE
    else process.env.EIMU_DEVICE_BRIDGE = saved
  }
})

// ───────────────────────── H2（2026-10-04）：递回型工具的根夹制 ─────────────────────────
//
// 漏洞：云端只在请求路径上跑 denylist；`path="/home/u/project"` 放行后，装置端 grep
// 递回进 `project/.ssh/` 并只回截断行，云端看不到。修法＝把递回根夹在使用者已授权根
// 之下（本档的向量表 + policy.recursiveRootProblem），并以契约要求装置自报敏感触碰。

interface PolicyVectors {
  sensitive: { path: unknown; expected: boolean; category: string }[]
  filesystemRoot: { path: unknown; expected: boolean; category: string }[]
  containment: { root: string; path: string; expected: boolean; category: string }[]
  recursiveRoot: { path: string; roots: string[]; reason: string | null; category: string }[]
}

const vectors = JSON.parse(
  readFileSync(new URL("./device-bridge-policy.vectors.json", import.meta.url), "utf8"),
) as PolicyVectors

test("vectors: isSensitivePath 逐条符合向量表（家目录内外/.. 逃逸/前缀混淆/大小写/Windows/Unicode/空值）", () => {
  assert.ok(vectors.sensitive.length >= 30)
  for (const v of vectors.sensitive) {
    assert.equal(isSensitivePath(v.path), v.expected, `${v.category}: ${JSON.stringify(v.path)}`)
  }
})

test("vectors: isFilesystemRoot 逐条符合向量表（/ 与 Windows 磁碟根/UNC）", () => {
  assert.ok(vectors.filesystemRoot.length >= 10)
  for (const v of vectors.filesystemRoot) {
    assert.equal(isFilesystemRoot(v.path), v.expected, `${v.category}: ${JSON.stringify(v.path)}`)
  }
})

test("vectors: isPathWithinRoot 逐条符合向量表（父目录/前缀混淆/.. 逃逸/大小写/相对路径）", () => {
  assert.ok(vectors.containment.length >= 12)
  for (const v of vectors.containment) {
    assert.equal(isPathWithinRoot(v.path, v.root), v.expected, `${v.category}: ${v.path} vs ${v.root}`)
  }
})

test("vectors: recursiveRootProblem 逐条符合向量表（根/无授权根/父目录/敏感根）", () => {
  assert.ok(vectors.recursiveRoot.length >= 5)
  for (const v of vectors.recursiveRoot) {
    assert.equal(recursiveRootProblem(v.path, v.roots), v.reason, `${v.category}: ${v.path}`)
  }
})

test("policy: 非字串 fail-closed（向量表外补 undefined）", () => {
  assert.equal(isSensitivePath(undefined), true)
  assert.equal(recursiveRootProblem(undefined, ["/home/u/p"]), "not_within_authorized_root")
  assert.equal(isFilesystemRoot(undefined), false)
})

test("policy: sanitizeAuthorizedRoots 丢弃敏感/根/相对/~ 授权根并去重", () => {
  const out = sanitizeAuthorizedRoots([
    "/home/u/project",
    "/home/u/.ssh", // 敏感 → 丢
    "/", // 档案系统根 → 丢
    "\\\\?\\C:\\", // Windows 扩充长度磁碟根 → 丢
    "//", // 空段 → 丢
    "~/proj", // tilde/相对 → 丢
    "relative/x", // 相对 → 丢
    "", // 空 → 丢
    "/home/u/project", // 重复 → 去重
    123,
  ])
  assert.deepEqual(out, ["/home/u/project"])
  assert.deepEqual(sanitizeAuthorizedRoots(null), [])
  assert.deepEqual(sanitizeAuthorizedRoots("x"), [])
})

test("policy: clampFileBytes 夹到单档输入上限", () => {
  assert.equal(clampFileBytes(undefined), MAX_FILE_READ_BYTES)
  assert.equal(clampFileBytes(0), MAX_FILE_READ_BYTES)
  assert.equal(clampFileBytes(1024), 1024)
  assert.equal(clampFileBytes(MAX_FILE_READ_BYTES * 10), MAX_FILE_READ_BYTES)
})

test("policy: sensitiveResultProblem 只认装置明确自报", () => {
  assert.equal(sensitiveResultProblem({ matches: [] }), null)
  assert.equal(sensitiveResultProblem(null), null)
  assert.equal(sensitiveResultProblem({ sensitive_path_touched: true }), "device reported touching a sensitive path")
  assert.equal(sensitiveResultProblem({ excluded_sensitive_count: 2 }), "device reported excluding sensitive paths")
  assert.equal(sensitiveResultProblem({ excluded_sensitive_count: 0 }), null)
  assert.equal(sensitiveResultProblem({ sensitive_paths: ["/home/u/.ssh/x"] }), "device reported sensitive paths in recursion")
})

function registeredBridgeWithRoots(roots: unknown, opts: ConstructorParameters<typeof DeviceBridge>[0] = {}) {
  const bridge = new DeviceBridge(opts)
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", roots })
  return { bridge, reg }
}

test("H2: sanitizeToolArgs 带授权根时，grep 根夹制生效", () => {
  const ok = sanitizeToolArgs("grep", { path: "/home/u/project/a", pattern: "x" }, { authorizedRoots: ["/home/u/project"] })
  assert.equal(ok.ok, true)
  const bad = sanitizeToolArgs("grep", { path: "/home/u", pattern: "x" }, { authorizedRoots: ["/home/u/project"] })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.code, "path_not_authorized")
})

test("H2: grep 父目录（授权根之上）→ path_not_authorized", async () => {
  const { bridge, reg } = registeredBridgeWithRoots(["/home/u/project"])
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "grep", args: { path: "/home/u", pattern: "PRIVATE" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "path_not_authorized")
})

test("H2: grep 档案系统根 → path_not_authorized", async () => {
  const { bridge, reg } = registeredBridgeWithRoots(["/home/u/project"])
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "grep", args: { path: "/", pattern: "PRIVATE" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "path_not_authorized")
})

test("H2: grep 未授权任何根 → path_not_authorized（fail-closed）", async () => {
  const { bridge, reg } = registeredBridge() // 无 roots
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "grep", args: { path: "/home/u/project", pattern: "x" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "path_not_authorized")
})

test("H2: grep 敏感段祖先（path 含 .ssh）→ sensitive_path（且敏感根不进授权集）", async () => {
  const { bridge, reg } = registeredBridgeWithRoots(["/home/u/.ssh/project"])
  assert.deepEqual(reg.authorizedRoots, [])
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "grep", args: { path: "/home/u/.ssh/project", pattern: "x" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "sensitive_path")
})

test("H2: list_dir 档案系统根 → path_not_authorized", async () => {
  const { bridge, reg } = registeredBridgeWithRoots(["/home/u/project"])
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "list_dir", args: { path: "/" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "path_not_authorized")
})

test("H2: grep 在授权根之下的正常流程（poll→submit）成功，且下发 max_file_bytes", async () => {
  const { bridge, reg } = registeredBridgeWithRoots(["/home/u/project"], { requestTimeoutMs: 2000 })
  const pending = bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "grep", args: { path: "/home/u/project/src", pattern: "TODO" } })
  const polled = await bridge.poll({ tenant: "u:1", deviceId: reg.deviceId, connectionId: reg.connectionId })
  if (!polled.ok || !polled.request) throw new Error("expected a request")
  assert.equal(polled.request.args.path, "/home/u/project/src")
  assert.equal(polled.request.args.max_file_bytes, MAX_FILE_READ_BYTES)
  const sub = bridge.submitResult({
    tenant: "u:1",
    deviceId: reg.deviceId,
    connectionId: reg.connectionId,
    requestId: polled.request.request_id,
    consentToken: polled.request.consent_token,
    result: { path: "/home/u/project/src", matches: [{ line: 1, text: "TODO" }] },
  })
  assert.equal(sub.ok, true)
  const out = await pending
  assert.equal(out.ok, true)
})

test("H2: 装置自报递回触碰敏感 → 整笔拒绝 sensitive_path，结果不落地", async () => {
  const { bridge, reg } = registeredBridgeWithRoots(["/home/u/project"], { requestTimeoutMs: 2000 })
  const pending = bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "grep", args: { path: "/home/u/project", pattern: "KEY" } })
  const polled = await bridge.poll({ tenant: "u:1", deviceId: reg.deviceId, connectionId: reg.connectionId })
  if (!polled.ok || !polled.request) throw new Error("expected a request")
  const sub = bridge.submitResult({
    tenant: "u:1",
    deviceId: reg.deviceId,
    connectionId: reg.connectionId,
    requestId: polled.request.request_id,
    consentToken: polled.request.consent_token,
    result: { matches: [], excluded_sensitive_count: 1, sensitive_path_touched: true },
  })
  assert.equal(sub.ok, false)
  if (!sub.ok) assert.equal(sub.code, "sensitive_path")
  const out = await pending
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "sensitive_path")
})

// ────────────────── 唯读查询（环境事实层 localBridge 来源）──────────────────

test("deviceBridgeRuntimeState: 唯读快照（在线/装置数/授权根数），总开关 OFF → enabled=false", () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", roots: ["/home/u/project", "/home/u/docs"], now: T })
  const before = bridge.stats()

  // env 未开 → enabled=false，且不查注册表
  const off = deviceBridgeRuntimeState(1, { bridge, env: {}, now: T })
  assert.deepEqual(off, { enabled: false, online: false, deviceCount: 0, authorizedRootCount: 0 })

  // env 开、心跳未过期 → 在线且已授权根
  const on = deviceBridgeRuntimeState(1, { bridge, env: { EIMU_DEVICE_BRIDGE: "1" }, now: T + 1_000 })
  assert.deepEqual(on, { enabled: true, online: true, deviceCount: 1, authorizedRootCount: 2 })

  // 心跳逾时 → online=false（装置仍算已注册）
  const stale = deviceBridgeRuntimeState(1, { bridge, env: { EIMU_DEVICE_BRIDGE: "1" }, now: T + 90_001 })
  assert.deepEqual(stale, { enabled: true, online: false, deviceCount: 1, authorizedRootCount: 0 })

  // 别的使用者看不到这台装置
  const other = deviceBridgeRuntimeState(2, { bridge, env: { EIMU_DEVICE_BRIDGE: "1" }, now: T + 1_000 })
  assert.deepEqual(other, { enabled: true, online: false, deviceCount: 0, authorizedRootCount: 0 })

  // 唯读：不改动注册表状态（装置数/待办/票）
  assert.deepEqual(bridge.stats(), before)

  // 在线但未授权任何根 → authorizedRootCount=0（据此判 no_authorized_roots）
  const noRoots = new DeviceBridge()
  noRoots.register({ tenant: "u:9", userId: 9, apiKeyHash: "h9", roots: [], now: T })
  const nr = deviceBridgeRuntimeState(9, { bridge: noRoots, env: { EIMU_DEVICE_BRIDGE: "1" }, now: T + 1 })
  assert.equal(nr.online, true)
  assert.equal(nr.authorizedRootCount, 0)
})

// ───────────── W6a 内部路由：pickDeviceForTenant（寻址）─────────────
//
// agent 工具只知道 session_id；/internal/device/invoke 由租户挑装置。挑选必须**不猜**：
// 多台且多台在线（或全部离线且 >1）＝ ambiguous，不得任选一台。

test("pickDeviceForTenant: 0 台（从未注册）→ no_device_registered", () => {
  const bridge = new DeviceBridge()
  const r = bridge.pickDeviceForTenant("u:1")
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "no_device_registered")
})

test("pickDeviceForTenant: 1 台 online → 回它", () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", now: T })
  const r = bridge.pickDeviceForTenant("u:1", T + 1_000)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.deviceId, reg.deviceId)
})

test("pickDeviceForTenant: 1 台 offline（心跳逾时）→ device_offline", () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", now: T })
  const r = bridge.pickDeviceForTenant("u:1", T + 90_001)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "device_offline")
})

test("pickDeviceForTenant: 多台只有 1 台 online → 回那台", () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "ha", deviceId: "devA", now: T - 200_000 }) // offline
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "hb", deviceId: "devB", now: T }) // online
  const r = bridge.pickDeviceForTenant("u:1", T)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.deviceId, "devB")
})

test("pickDeviceForTenant: 多台多台 online → device_ambiguous（不猜）", () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "ha", deviceId: "devA", now: T })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "hb", deviceId: "devB", now: T })
  const r = bridge.pickDeviceForTenant("u:1", T)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "device_ambiguous")
})

test("pickDeviceForTenant: 多台全部 offline（>1）→ device_ambiguous（不猜）", () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "ha", deviceId: "devA", now: T })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "hb", deviceId: "devB", now: T })
  const r = bridge.pickDeviceForTenant("u:1", T + 90_001)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "device_ambiguous")
})

test("pickDeviceForTenant: 租户隔离（别的租户的装置不算）", () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  bridge.register({ tenant: "u:2", userId: 2, apiKeyHash: "h2", now: T })
  const r = bridge.pickDeviceForTenant("u:1", T)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "no_device_registered")
})

test("describeTenantDevices: 0 台 → null；1 台 → online/roots/lastHeartbeat", () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  assert.equal(bridge.describeTenantDevices("u:1", T), null)
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", roots: ["/home/u/project"], now: T })
  const d = bridge.describeTenantDevices("u:1", T + 1_000)
  assert.deepEqual(d, { online: true, roots: ["/home/u/project"], lastHeartbeatMs: T })
  const stale = bridge.describeTenantDevices("u:1", T + 90_001)
  assert.equal(stale?.online, false)
})

// ───────────── W6a 内部路由：/internal/device/invoke 与 /status ─────────────

function internalDeps(bridge: DeviceBridge, tenants: Record<string, string | null> = { sess_ok: "u:1" }): InternalDeviceRouteDeps {
  return { bridge, resolveTenant: async (sid) => (sid in tenants ? tenants[sid] : null) }
}

test("/internal/device/invoke: happy path（mock 装置走完 poll→result）回冻结契约形状", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 2_000 })
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", roots: ["/home/u/project"] })
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", {
    method: "POST",
    body: JSON.stringify({ op: "read_file", path: "/home/u/project/a.txt", limit: 32 }),
  })
  const pending = handleInternalDeviceInvoke(req, internalDeps(bridge))

  const polled = await bridge.poll({ tenant: "u:1", deviceId: reg.deviceId, connectionId: reg.connectionId, waitMs: 3_000 })
  if (!polled.ok || !polled.request) throw new Error("expected a request")
  assert.equal(polled.request.tool, "read_file")
  assert.equal(polled.request.args.path, "/home/u/project/a.txt")
  assert.equal(polled.request.args.limit, 32)

  const sub = bridge.submitResult({
    tenant: "u:1",
    deviceId: reg.deviceId,
    connectionId: reg.connectionId,
    requestId: polled.request.request_id,
    consentToken: polled.request.consent_token,
    result: { path: "/home/u/project/a.txt", text: "hello" },
  })
  assert.equal(sub.ok, true)

  const res = await pending
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.tool, "read_file")
  assert.equal(typeof body.request_id, "string")
  assert.equal(body.truncated, false)
  assert.equal(typeof body.bytes, "number")
  // finalizeDeviceResult 对含 text 的结果会补 `truncated` 后设栏位（既有语义，非本路由）。
  const result = body.result as { path: string; text: string }
  assert.equal(result.path, "/home/u/project/a.txt")
  assert.equal(result.text, "hello")
})

test("/internal/device/invoke: session 解析不到 → session_unknown", async () => {
  const bridge = new DeviceBridge()
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=nope", { method: "POST", body: JSON.stringify({ op: "stat", path: "/tmp/a" }) })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 404)
  const body = (await res.json()) as { ok: boolean; error: { code: string } }
  assert.equal(body.ok, false)
  assert.equal(body.error.code, "session_unknown")
})

test("/internal/device/invoke: resolver 抛错 → session_unknown（fail-closed，不外泄）", async () => {
  const bridge = new DeviceBridge()
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", { method: "POST", body: JSON.stringify({ op: "stat", path: "/tmp/a" }) })
  const res = await handleInternalDeviceInvoke(req, { bridge, resolveTenant: async () => { throw new Error("db down") } })
  assert.equal(res.status, 404)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "session_unknown")
})

test("/internal/device/invoke: 租户无装置 → no_device_registered", async () => {
  const bridge = new DeviceBridge()
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", { method: "POST", body: JSON.stringify({ op: "stat", path: "/tmp/a" }) })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 404)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "no_device_registered")
})

test("/internal/device/invoke: 装置离线 → device_offline", async () => {
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", now: Date.now() - 200_000 })
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", { method: "POST", body: JSON.stringify({ op: "stat", path: "/tmp/a" }) })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 404)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "device_offline")
})

test("/internal/device/invoke: 多台多 online → device_ambiguous", async () => {
  const bridge = new DeviceBridge()
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "ha", deviceId: "devA" })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "hb", deviceId: "devB" })
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", { method: "POST", body: JSON.stringify({ op: "stat", path: "/tmp/a" }) })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 409)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "device_ambiguous")
})

test("/internal/device/invoke: 非白名单 op → tool_not_allowed", async () => {
  const bridge = new DeviceBridge()
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1" })
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", { method: "POST", body: JSON.stringify({ op: "write_file", path: "/tmp/a" }) })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 403)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "tool_not_allowed")
})

test("/internal/device/invoke: denylist 仍生效（敏感路径 → sensitive_path）", async () => {
  const bridge = new DeviceBridge()
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", roots: ["/home/u/project"] })
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", {
    method: "POST",
    body: JSON.stringify({ op: "read_file", path: "/home/u/.ssh/id_rsa" }),
  })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 403)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "sensitive_path")
})

test("/internal/device/invoke: 授权根仍生效（授权根外 → path_not_authorized）", async () => {
  const bridge = new DeviceBridge()
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", roots: ["/home/u/project"] })
  // 注：共享 denylist 不含裸 `/etc/passwd`（见向量表；两端一致，非缺口）——
  // 这里要验的是**授权根**这道防线，故以授权根外的 grep 递回根证明。
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", {
    method: "POST",
    body: JSON.stringify({ op: "grep", path: "/etc", pattern: "root" }),
  })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 403)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "path_not_authorized")
})

test("/internal/device/invoke: 缺 session_id / 缺 op / 坏 body → bad_request", async () => {
  const bridge = new DeviceBridge()
  const noSid = await handleInternalDeviceInvoke(
    new Request("http://gw.internal/internal/device/invoke", { method: "POST", body: "{}" }),
    internalDeps(bridge),
  )
  assert.equal(noSid.status, 400)
  const noOp = await handleInternalDeviceInvoke(
    new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", { method: "POST", body: "{}" }),
    internalDeps(bridge),
  )
  assert.equal(noOp.status, 400)
  const badBody = await handleInternalDeviceInvoke(
    new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", { method: "POST", body: "not-json" }),
    internalDeps(bridge),
  )
  assert.equal(badBody.status, 400)
})

test("/internal/device/invoke: 装置在线但不回 result → device_timeout（不 hang）", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 60 })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1" })
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", {
    method: "POST",
    body: JSON.stringify({ op: "stat", path: "/tmp/a" }),
  })
  const started = Date.now()
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  const elapsed = Date.now() - started
  assert.equal(res.status, 504)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "device_timeout")
  // 必须在逾时附近就返回（不永久 pending）；给足余裕以免 CI 抖动误判。
  assert.ok(elapsed < 5_000, `elapsed=${elapsed}ms`)
  assert.equal(bridge.stats().pending, 0)
})

test("/internal/device/status: 无装置 → device:null；有装置 → 冻结形状", async () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  const none = await handleInternalDeviceStatus(
    new Request("http://gw.internal/internal/device/status?session_id=sess_ok", { method: "GET" }),
    internalDeps(bridge, { sess_ok: "u:1" }),
  )
  assert.equal(none.status, 200)
  assert.deepEqual(await none.json(), { ok: true, device: null })

  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", roots: ["/home/u/project"], now: Date.now() })
  const has = await handleInternalDeviceStatus(
    new Request("http://gw.internal/internal/device/status?session_id=sess_ok", { method: "GET" }),
    internalDeps(bridge, { sess_ok: "u:1" }),
  )
  assert.equal(has.status, 200)
  const body = (await has.json()) as { ok: boolean; device: { online: boolean; roots: string[]; last_heartbeat_ms: number } }
  assert.equal(body.ok, true)
  assert.equal(body.device.online, true)
  assert.deepEqual(body.device.roots, ["/home/u/project"])
  assert.equal(typeof body.device.last_heartbeat_ms, "number")
})

test("/internal/device/status: session 解析不到 → session_unknown", async () => {
  const bridge = new DeviceBridge()
  const res = await handleInternalDeviceStatus(
    new Request("http://gw.internal/internal/device/status?session_id=nope", { method: "GET" }),
    internalDeps(bridge),
  )
  assert.equal(res.status, 404)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "session_unknown")
})

test("内部路由不放宽既有 denylist／白名单：op 白名单与 policy 工具集一致", () => {
  // 一对一映射的守门：内部 op 集合必须恰好等于既有 DeviceBridgeTool 白名单。
  const tools = ["list_dir", "read_file", "grep", "stat"]
  for (const t of tools) assert.equal(isToolAllowed(t), true, t)
  assert.equal(isToolAllowed("write_file"), false)
  assert.equal(isToolAllowed("delete"), false)
})

// ───────── 对话内授权送达装置（consent）＋ once 自动核销（2026-10-04）─────────
//
// 真机缺口：对话中 authorize(session/permanent) 只写进闸道记忆体，装置完全不知道 ⇒ 授权
// 永不收敛；once 又因 opencode 的 local_files 从不下发 authorization_token 而结构性死路。
// 以下用「真 invoke → 真 poll 拿 message」断言 message.consent 的有无与内容（非原始码扫描）。

const CONSENT_HOME = "/home/u"

function authorizeReq(body: Record<string, unknown>, sid = "sess_ok") {
  return new Request(`http://gw.internal/internal/device/authorize?session_id=${sid}`, { method: "POST", body: JSON.stringify(body) })
}

/** 取一发 invoke 下发给装置的 message；assert 收到请求。 */
async function takeMessage(bridge: DeviceBridge, deviceId: string, connectionId: string) {
  const polled = await bridge.poll({ tenant: "u:1", deviceId, connectionId, waitMs: 2_000 })
  if (!polled.ok || !polled.request) throw new Error("expected a request")
  return polled.request
}

/** 收尾：回一笔结果让 invoke 落地，避免 pending 拖尾。 */
function finish(bridge: DeviceBridge, deviceId: string, connectionId: string, msg: { request_id: string; consent_token: string }) {
  bridge.submitResult({
    tenant: "u:1",
    deviceId,
    connectionId,
    requestId: msg.request_id,
    consentToken: msg.consent_token,
    result: { path: "/x", text: "ok" },
  })
}

test("consent: authorize(session) 后，下一发 invoke 的 message 带 consent（scope=session、roots 含该根）", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 2_000 })
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", mode: "ask", home: CONSENT_HOME })
  const ares = await handleInternalDeviceAuthorize(authorizeReq({ scope: "session", root: `${CONSENT_HOME}/project` }), internalDeps(bridge))
  assert.equal(ares.status, 200)

  const pending = bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: `${CONSENT_HOME}/project/a.txt` } })
  const msg = await takeMessage(bridge, reg.deviceId, reg.connectionId)
  const consent = (msg as { consent?: { scope: string; roots: string[] } }).consent
  assert.deepEqual(consent, { scope: "session", roots: [`${CONSENT_HOME}/project`] })
  finish(bridge, reg.deviceId, reg.connectionId, msg)
  await pending
})

test("consent: authorize(permanent) 同理（scope=permanent）；session＋permanent 混用取 permanent、roots 取全部", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 2_000 })
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", mode: "ask", home: CONSENT_HOME })
  await handleInternalDeviceAuthorize(authorizeReq({ scope: "permanent", root: `${CONSENT_HOME}/docs` }), internalDeps(bridge))
  const p1 = bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: `${CONSENT_HOME}/docs/a.txt` } })
  const m1 = await takeMessage(bridge, reg.deviceId, reg.connectionId)
  assert.deepEqual((m1 as { consent?: unknown }).consent, { scope: "permanent", roots: [`${CONSENT_HOME}/docs`] })
  finish(bridge, reg.deviceId, reg.connectionId, m1)
  await p1

  // 追加 session 于另一个根：roots 应含两根，scope 仍 permanent。
  await handleInternalDeviceAuthorize(authorizeReq({ scope: "session", root: `${CONSENT_HOME}/project` }), internalDeps(bridge))
  const p2 = bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: `${CONSENT_HOME}/docs/a.txt` } })
  const m2 = await takeMessage(bridge, reg.deviceId, reg.connectionId)
  const consent = (m2 as { consent?: { scope: string; roots: string[] } }).consent
  assert.equal(consent?.scope, "permanent")
  assert.deepEqual(consent?.roots?.slice().sort(), [`${CONSENT_HOME}/docs`, `${CONSENT_HOME}/project`].sort())
  finish(bridge, reg.deviceId, reg.connectionId, m2)
  await p2
})

test("consent: 无任何授权记录时，message 不得出现 consent 栏位（装置不得无条件落盘）", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 2_000 })
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", mode: "full", home: CONSENT_HOME })
  const pending = bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: `${CONSENT_HOME}/project/a.txt` } })
  const msg = await takeMessage(bridge, reg.deviceId, reg.connectionId)
  assert.equal("consent" in msg, false)
  finish(bridge, reg.deviceId, reg.connectionId, msg)
  await pending
})

test("once: 无 token 自动核销（第一发放行、message.consent=once；第二发不再放行）", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 2_000 })
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", mode: "ask", home: CONSENT_HOME })
  const ares = await handleInternalDeviceAuthorize(authorizeReq({ scope: "once", root: `${CONSENT_HOME}/project` }), internalDeps(bridge))
  const { token } = (await ares.json()) as { token: string }
  assert.equal(typeof token, "string")

  const pending = bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: `${CONSENT_HOME}/project/a.txt` } })
  const msg = await takeMessage(bridge, reg.deviceId, reg.connectionId)
  assert.deepEqual((msg as { consent?: unknown }).consent, { scope: "once", roots: [`${CONSENT_HOME}/project`] })
  finish(bridge, reg.deviceId, reg.connectionId, msg)
  const first = await pending
  assert.equal(first.ok, true, "自动核销＝本次放行")

  const second = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: `${CONSENT_HOME}/project/a.txt` } })
  assert.equal(second.ok, false)
  assert.equal((second as { code: string }).code, "needs_authorization")
})

test("suggestAuthorizationRoot: 夹制四案例（家目录／档案系统根／root_too_broad／home=null）", () => {
  // 0) 主修：list_dir 目录 ⇒ 建议目录本身（不再建议过宽的家目录）
  assert.equal(suggestAuthorizationRoot(`${CONSENT_HOME}/Downloads`, CONSENT_HOME, true), `${CONSENT_HOME}/downloads`)
  // 不加 isDirectory（read_file/stat 语义）时仍建议父目录（此处父目录＝家目录）
  assert.equal(suggestAuthorizationRoot(`${CONSENT_HOME}/Downloads`, CONSENT_HOME, false), CONSENT_HOME)
  // 1) 建议值等于家目录 → 回被存取路径本身，不得 null
  assert.equal(suggestAuthorizationRoot(CONSENT_HOME, CONSENT_HOME, true), CONSENT_HOME)
  // 2) 被存取路径为档案系统根 → 回根本身，不得 null
  assert.equal(suggestAuthorizationRoot("/", CONSENT_HOME, true), "/")
  // 3) 建议值落在 root_too_broad 范围（单段 /home）→ 回该路径本身，不得 null
  assert.equal(suggestAuthorizationRoot("/home", CONSENT_HOME, true), "/home")
  // 4) home=null：仍以路径语义给建议（目录→本身；档案→父目录）；无法归一化才 null
  assert.equal(suggestAuthorizationRoot(`${CONSENT_HOME}/downloads`, null, true), `${CONSENT_HOME}/downloads`)
  assert.equal(suggestAuthorizationRoot(`${CONSENT_HOME}/downloads/a.txt`, null, false), `${CONSENT_HOME}/downloads`)
  assert.equal(suggestAuthorizationRoot("relative/x", null, true), null)
})

test("authorize: 回执保留原大小写；该规则仍大小写不敏感命中（真 invoke 放行）", async () => {
  const bridge = new DeviceBridge({ requestTimeoutMs: 2_000 })
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", mode: "ask", home: CONSENT_HOME })
  const res = await handleInternalDeviceAuthorize(authorizeReq({ scope: "permanent", root: `${CONSENT_HOME}/Downloads` }), internalDeps(bridge))
  assert.equal(res.status, 200)
  const body = (await res.json()) as { applied: { root: string }; rules: PermissionRule[]; persist_on_device?: boolean }
  assert.equal(body.applied.root, `${CONSENT_HOME}/Downloads`, "回执须保留原大小写")
  assert.equal(body.persist_on_device, true)
  assert.equal(matchRuleSpecifier(body.rules[0].specifier!, `${CONSENT_HOME}/downloads/a.txt`, { home: CONSENT_HOME }), true)

  // 真行为：小写路径的 invoke 仍被该规则放行（下发出去＝未被 needs_authorization 拦）。
  const pending = bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "read_file", args: { path: `${CONSENT_HOME}/downloads/a.txt` } })
  const msg = await takeMessage(bridge, reg.deviceId, reg.connectionId)
  finish(bridge, reg.deviceId, reg.connectionId, msg)
  await pending
})
