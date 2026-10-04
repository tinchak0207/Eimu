/**
 * device-bridge.test.ts — W6a 裝置橋雲端側的純邏輯真值測試。
 * 跑法：npx --yes tsx --test deploy-staging/gateway/device-bridge.test.ts
 *
 * 不打真服務、不碰真檔案、零上游／零付費。涵蓋：
 *   - denylist（含路徑逃逸 ..、前綴混淆、大小寫、symlink 字面）
 *   - 工具白名單
 *   - 大小夾制與截斷標記
 *   - 同意票驗證（過期／不匹配／重放 各一例）
 *   - 註冊/心跳/輪詢/回傳/逾時的端到端（記憶體內）
 *   - 預設 OFF（env 未設時 handler 直接 404、不觸網）
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
  recursiveRootProblem,
  sanitizeAuthorizedRoots,
  sensitiveResultProblem,
  truncateWithMarker,
} from "./device-bridge-policy.ts"
import {
  DeviceBridge,
  ConsentTokenStore,
  deviceBridgeEnabled,
  deviceBridgeRuntimeState,
  finalizeDeviceResult,
  sanitizeToolArgs,
  handleDeviceBridgeRoutes,
  handleInternalDeviceInvoke,
  handleInternalDeviceStatus,
  type InternalDeviceRouteDeps,
} from "./device-bridge.ts"

// ───────────────────────── denylist ─────────────────────────

test("isSensitivePath: Claude Code 敏感清單逐條命中", () => {
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

test("isSensitivePath: 瀏覽器 profile 目錄命中（Linux 與 macOS）", () => {
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

test("isSensitivePath: 路徑逃逸 '..' 仍命中（掃描所有段，不比前綴）", () => {
  assert.equal(isSensitivePath("~/.ssh/../../etc/passwd"), true)
  assert.equal(isSensitivePath("/tmp/../.ssh/id_rsa"), true)
  assert.equal(isSensitivePath("a/../../.aws/credentials"), true)
  assert.equal(isSensitivePath("./deep/../../x/.netrc"), true)
})

test("isSensitivePath: 前綴混淆不誤命中（真檔名不是敏感目錄）", () => {
  assert.equal(isSensitivePath("~/.sshfoo/id_rsa"), false)
  assert.equal(isSensitivePath("~/.ssh-backup/keys"), false)
  assert.equal(isSensitivePath("~/.ssh2/id"), false)
  assert.equal(isSensitivePath("/tmp/notes.ssh.md"), false)
  assert.equal(isSensitivePath("~/.netrc.bak"), false) // basename 不精確相等
})

test("isSensitivePath: 大小寫一律 fail-closed（.SSH/.Aws 也擋）", () => {
  assert.equal(isSensitivePath("~/.SSH/id_rsa"), true)
  assert.equal(isSensitivePath("~/.Aws/credentials"), true)
  assert.equal(isSensitivePath("C:\\Users\\me\\.Ssh\\id_rsa"), true)
})

test("isSensitivePath: Windows 反斜線分隔符照樣正規化", () => {
  assert.equal(isSensitivePath("C:\\Users\\me\\.ssh\\id_rsa"), true)
  assert.equal(isSensitivePath("C:\\Users\\me\\project\\a.ts"), false)
})

test("isSensitivePath: symlink 字面 — 純字串判定跟不了 symlink（已知限制，daemon 須 realpath）", () => {
  // `~/link_to_ssh -> ~/.ssh`：字串不含 `.ssh` 段 → 本函式回 false。
  assert.equal(isSensitivePath("~/link_to_ssh/id_rsa"), false)
  // daemon realpath 後得到真實目標，再跑同一支判定 → 命中。兩層合力才完整。
  assert.equal(isSensitivePath("/home/me/.ssh/id_rsa"), true)
})

test("isSensitivePath: 非敏感一般路徑放行", () => {
  for (const p of ["/tmp/a.txt", "~/projects/app.ts", "~/.config/Code/User/settings.json", "/etc/hosts"]) {
    assert.equal(isSensitivePath(p), false, p)
  }
})

test("isSensitivePath: 缺值／型別錯／空字串一律 fail-closed 視為敏感", () => {
  assert.equal(isSensitivePath(""), true)
  assert.equal(isSensitivePath("   "), true)
  assert.equal(isSensitivePath(null), true)
  assert.equal(isSensitivePath(undefined), true)
  assert.equal(isSensitivePath(123), true)
})

// ───────────────────────── 工具白名單 ─────────────────────────

test("isToolAllowed: 最小集合四工具放行、其餘全擋", () => {
  assert.deepEqual([...DEVICE_BRIDGE_TOOLS], ["list_dir", "read_file", "grep", "stat"])
  for (const t of DEVICE_BRIDGE_TOOLS) assert.equal(isToolAllowed(t), true, t)
  for (const t of ["write_file", "delete_file", "rm", "exec", "bash", "Read", "read_file ", "", null, 1]) {
    assert.equal(isToolAllowed(t), false, String(t))
  }
})

// ───────────────────────── 大小夾制 ─────────────────────────

test("clampReadSize: 缺值/非正數 → 預設，超限 → 上限，其餘取整", () => {
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

// ───────────────────────── 截斷標記 ─────────────────────────

test("truncateWithMarker: 未超限原樣、超限附標記且 keptBytes<=max", () => {
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

test("truncateWithMarker: 多位元組 UTF-8 邊界安全（尾端不留替換字元）", () => {
  const text = "é".repeat(200) // 每字 2 bytes
  const t = truncateWithMarker(text, 101) // 101 為奇數，必切在字元中間
  assert.equal(t.truncated, true)
  assert.ok(t.keptBytes % 2 === 0, `keptBytes=${t.keptBytes} 應落在字元邊界`)
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

test("finalizeDeviceResult: 結構化結果過大 → 包成截斷文字殼", () => {
  const out = finalizeDeviceResult({
    entries: Array.from({ length: 20000 }, (_, i) => `entry-${i}-${"x".repeat(20)}`),
  })
  assert.equal(out.truncated, true)
  assert.equal(out.result.truncated, true)
  assert.equal(typeof out.result.text, "string")
})

// ───────────────────────── 同意票驗證 ─────────────────────────

test("consent token: happy path — 單次可用，第二次為重放", () => {
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

test("consent token: 過期（且順手刪除）", () => {
  const store = new ConsentTokenStore()
  const token = store.mint({ deviceId: "dev1", tool: "stat", requestId: "req2" }, 10, 1000)
  assert.deepEqual(store.consume(token, { deviceId: "dev1", tool: "stat", requestId: "req2" }, 1011), {
    ok: false,
    code: "consent_token_expired",
  })
  assert.equal(store.size(), 0)
})

test("consent token: 綁定不匹配（裝置／工具／請求 id 任一不符）", () => {
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

// ───────────────────────── 參數淨化 ─────────────────────────

test("sanitizeToolArgs: 敏感路徑在閘道側就被擋", () => {
  const r = sanitizeToolArgs("read_file", { path: "~/.ssh/id_rsa" })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "sensitive_path")
})

test("sanitizeToolArgs: read_file limit 被夾到上限、offset 預設 0", () => {
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

// ───────────────────────── 橋：註冊／心跳／invoke ─────────────────────────

function registeredBridge(opts: ConstructorParameters<typeof DeviceBridge>[0] = {}) {
  const bridge = new DeviceBridge(opts)
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1" })
  return { bridge, reg }
}

test("invoke: 非白名單工具直接拒（連裝置都不查）", async () => {
  const { bridge, reg } = registeredBridge()
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "write_file", args: { path: "/tmp/a" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "tool_not_allowed")
})

test("invoke: 敏感路徑拒", async () => {
  const { bridge, reg } = registeredBridge()
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "stat", args: { path: "~/.aws/credentials" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "sensitive_path")
})

test("invoke: 未註冊裝置 → device_offline", async () => {
  const bridge = new DeviceBridge()
  const out = await bridge.invoke({ tenant: "u:1", deviceId: "dev_nope", tool: "stat", args: { path: "/tmp/a" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "device_offline")
})

test("invoke: 心跳過期 → device_offline", async () => {
  const bridge = new DeviceBridge({ heartbeatTtlMs: 1000 })
  const reg = bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", now: Date.now() - 60_000 })
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "stat", args: { path: "/tmp/a" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "device_offline")
})

test("invoke → poll → submitResult（帶同意票）→ 收到結果", async () => {
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

test("invoke: submitResult 帶錯票（重放另一票）→ 拒絕且請求不落地", async () => {
  const { bridge, reg } = registeredBridge({ requestTimeoutMs: 2000 })
  // 先消耗一張無關票，製造一個「已被用過」的 token。
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
    consentToken: stale, // 綁定不符
    result: { text: "nope" },
  })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.code, "consent_token_mismatch")
  // 正確票仍可用 → 請求沒被壞回傳毀掉。
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

test("invoke: 逾時取消 → device_request_timeout", async () => {
  const { bridge, reg } = registeredBridge({ requestTimeoutMs: 40 })
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "stat", args: { path: "/tmp/a" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "device_request_timeout")
  assert.equal(bridge.stats().pending, 0)
})

test("心跳：連線不符 → device_connection_stale", () => {
  const { bridge, reg } = registeredBridge()
  const hb = bridge.heartbeat({ tenant: "u:1", deviceId: reg.deviceId, connectionId: "conn_wrong" })
  assert.equal(hb.ok, false)
  assert.equal(hb.code, "device_connection_stale")
})

test("poll：waitMs=0 無待辦 → request:null", async () => {
  const { bridge, reg } = registeredBridge()
  const out = await bridge.poll({ tenant: "u:1", deviceId: reg.deviceId, connectionId: reg.connectionId, waitMs: 0 })
  assert.deepEqual(out, { ok: true, request: null })
})

// ───────────────────────── 預設 OFF ─────────────────────────

test("deviceBridgeEnabled: 預設 OFF，僅 truthy 開啟", () => {
  assert.equal(deviceBridgeEnabled({} as NodeJS.ProcessEnv), false)
  assert.equal(deviceBridgeEnabled({ EIMU_DEVICE_BRIDGE: "" } as NodeJS.ProcessEnv), false)
  assert.equal(deviceBridgeEnabled({ EIMU_DEVICE_BRIDGE: "0" } as NodeJS.ProcessEnv), false)
  assert.equal(deviceBridgeEnabled({ EIMU_DEVICE_BRIDGE: "off" } as NodeJS.ProcessEnv), false)
  for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) {
    assert.equal(deviceBridgeEnabled({ EIMU_DEVICE_BRIDGE: v } as NodeJS.ProcessEnv), true, v)
  }
})

test("handler：開關未開時任何 device-bridge 路由一律 404（且不觸網）", async () => {
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

// ───────────────────────── H2（2026-10-04）：遞迴型工具的根夾制 ─────────────────────────
//
// 漏洞：雲端只在請求路徑上跑 denylist；`path="/home/u/project"` 放行後，裝置端 grep
// 遞迴進 `project/.ssh/` 並只回截斷行，雲端看不到。修法＝把遞迴根夾在使用者已授權根
// 之下（本檔的向量表 + policy.recursiveRootProblem），並以契約要求裝置自報敏感觸碰。

interface PolicyVectors {
  sensitive: { path: unknown; expected: boolean; category: string }[]
  filesystemRoot: { path: unknown; expected: boolean; category: string }[]
  containment: { root: string; path: string; expected: boolean; category: string }[]
  recursiveRoot: { path: string; roots: string[]; reason: string | null; category: string }[]
}

const vectors = JSON.parse(
  readFileSync(new URL("./device-bridge-policy.vectors.json", import.meta.url), "utf8"),
) as PolicyVectors

test("vectors: isSensitivePath 逐條符合向量表（家目錄內外/.. 逃逸/前綴混淆/大小寫/Windows/Unicode/空值）", () => {
  assert.ok(vectors.sensitive.length >= 30)
  for (const v of vectors.sensitive) {
    assert.equal(isSensitivePath(v.path), v.expected, `${v.category}: ${JSON.stringify(v.path)}`)
  }
})

test("vectors: isFilesystemRoot 逐條符合向量表（/ 與 Windows 磁碟根/UNC）", () => {
  assert.ok(vectors.filesystemRoot.length >= 10)
  for (const v of vectors.filesystemRoot) {
    assert.equal(isFilesystemRoot(v.path), v.expected, `${v.category}: ${JSON.stringify(v.path)}`)
  }
})

test("vectors: isPathWithinRoot 逐條符合向量表（父目錄/前綴混淆/.. 逃逸/大小寫/相對路徑）", () => {
  assert.ok(vectors.containment.length >= 12)
  for (const v of vectors.containment) {
    assert.equal(isPathWithinRoot(v.path, v.root), v.expected, `${v.category}: ${v.path} vs ${v.root}`)
  }
})

test("vectors: recursiveRootProblem 逐條符合向量表（根/無授權根/父目錄/敏感根）", () => {
  assert.ok(vectors.recursiveRoot.length >= 5)
  for (const v of vectors.recursiveRoot) {
    assert.equal(recursiveRootProblem(v.path, v.roots), v.reason, `${v.category}: ${v.path}`)
  }
})

test("policy: 非字串 fail-closed（向量表外補 undefined）", () => {
  assert.equal(isSensitivePath(undefined), true)
  assert.equal(recursiveRootProblem(undefined, ["/home/u/p"]), "not_within_authorized_root")
  assert.equal(isFilesystemRoot(undefined), false)
})

test("policy: sanitizeAuthorizedRoots 丟棄敏感/根/相對/~ 授權根並去重", () => {
  const out = sanitizeAuthorizedRoots([
    "/home/u/project",
    "/home/u/.ssh", // 敏感 → 丟
    "/", // 檔案系統根 → 丟
    "\\\\?\\C:\\", // Windows 擴充長度磁碟根 → 丟
    "//", // 空段 → 丟
    "~/proj", // tilde/相對 → 丟
    "relative/x", // 相對 → 丟
    "", // 空 → 丟
    "/home/u/project", // 重複 → 去重
    123,
  ])
  assert.deepEqual(out, ["/home/u/project"])
  assert.deepEqual(sanitizeAuthorizedRoots(null), [])
  assert.deepEqual(sanitizeAuthorizedRoots("x"), [])
})

test("policy: clampFileBytes 夾到單檔輸入上限", () => {
  assert.equal(clampFileBytes(undefined), MAX_FILE_READ_BYTES)
  assert.equal(clampFileBytes(0), MAX_FILE_READ_BYTES)
  assert.equal(clampFileBytes(1024), 1024)
  assert.equal(clampFileBytes(MAX_FILE_READ_BYTES * 10), MAX_FILE_READ_BYTES)
})

test("policy: sensitiveResultProblem 只認裝置明確自報", () => {
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

test("H2: sanitizeToolArgs 帶授權根時，grep 根夾制生效", () => {
  const ok = sanitizeToolArgs("grep", { path: "/home/u/project/a", pattern: "x" }, { authorizedRoots: ["/home/u/project"] })
  assert.equal(ok.ok, true)
  const bad = sanitizeToolArgs("grep", { path: "/home/u", pattern: "x" }, { authorizedRoots: ["/home/u/project"] })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.code, "path_not_authorized")
})

test("H2: grep 父目錄（授權根之上）→ path_not_authorized", async () => {
  const { bridge, reg } = registeredBridgeWithRoots(["/home/u/project"])
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "grep", args: { path: "/home/u", pattern: "PRIVATE" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "path_not_authorized")
})

test("H2: grep 檔案系統根 → path_not_authorized", async () => {
  const { bridge, reg } = registeredBridgeWithRoots(["/home/u/project"])
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "grep", args: { path: "/", pattern: "PRIVATE" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "path_not_authorized")
})

test("H2: grep 未授權任何根 → path_not_authorized（fail-closed）", async () => {
  const { bridge, reg } = registeredBridge() // 無 roots
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "grep", args: { path: "/home/u/project", pattern: "x" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "path_not_authorized")
})

test("H2: grep 敏感段祖先（path 含 .ssh）→ sensitive_path（且敏感根不進授權集）", async () => {
  const { bridge, reg } = registeredBridgeWithRoots(["/home/u/.ssh/project"])
  assert.deepEqual(reg.authorizedRoots, [])
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "grep", args: { path: "/home/u/.ssh/project", pattern: "x" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "sensitive_path")
})

test("H2: list_dir 檔案系統根 → path_not_authorized", async () => {
  const { bridge, reg } = registeredBridgeWithRoots(["/home/u/project"])
  const out = await bridge.invoke({ tenant: "u:1", deviceId: reg.deviceId, tool: "list_dir", args: { path: "/" } })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, "path_not_authorized")
})

test("H2: grep 在授權根之下的正常流程（poll→submit）成功，且下發 max_file_bytes", async () => {
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

test("H2: 裝置自報遞迴觸碰敏感 → 整筆拒絕 sensitive_path，結果不落地", async () => {
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

// ────────────────── 唯讀查詢（環境事實層 localBridge 來源）──────────────────

test("deviceBridgeRuntimeState: 唯讀快照（在線/裝置數/授權根數），總開關 OFF → enabled=false", () => {
  const T = 1_000_000
  const bridge = new DeviceBridge({ heartbeatTtlMs: 90_000 })
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", roots: ["/home/u/project", "/home/u/docs"], now: T })
  const before = bridge.stats()

  // env 未開 → enabled=false，且不查註冊表
  const off = deviceBridgeRuntimeState(1, { bridge, env: {}, now: T })
  assert.deepEqual(off, { enabled: false, online: false, deviceCount: 0, authorizedRootCount: 0 })

  // env 開、心跳未過期 → 在線且已授權根
  const on = deviceBridgeRuntimeState(1, { bridge, env: { EIMU_DEVICE_BRIDGE: "1" }, now: T + 1_000 })
  assert.deepEqual(on, { enabled: true, online: true, deviceCount: 1, authorizedRootCount: 2 })

  // 心跳逾時 → online=false（裝置仍算已註冊）
  const stale = deviceBridgeRuntimeState(1, { bridge, env: { EIMU_DEVICE_BRIDGE: "1" }, now: T + 90_001 })
  assert.deepEqual(stale, { enabled: true, online: false, deviceCount: 1, authorizedRootCount: 0 })

  // 別的使用者看不到這台裝置
  const other = deviceBridgeRuntimeState(2, { bridge, env: { EIMU_DEVICE_BRIDGE: "1" }, now: T + 1_000 })
  assert.deepEqual(other, { enabled: true, online: false, deviceCount: 0, authorizedRootCount: 0 })

  // 唯讀：不改動註冊表狀態（裝置數/待辦/票）
  assert.deepEqual(bridge.stats(), before)

  // 在線但未授權任何根 → authorizedRootCount=0（據此判 no_authorized_roots）
  const noRoots = new DeviceBridge()
  noRoots.register({ tenant: "u:9", userId: 9, apiKeyHash: "h9", roots: [], now: T })
  const nr = deviceBridgeRuntimeState(9, { bridge: noRoots, env: { EIMU_DEVICE_BRIDGE: "1" }, now: T + 1 })
  assert.equal(nr.online, true)
  assert.equal(nr.authorizedRootCount, 0)
})

// ───────────── W6a 內部路由：pickDeviceForTenant（尋址）─────────────
//
// agent 工具只知道 session_id；/internal/device/invoke 由租戶挑裝置。挑選必須**不猜**：
// 多台且多台在線（或全部離線且 >1）＝ ambiguous，不得任選一台。

test("pickDeviceForTenant: 0 台（從未註冊）→ no_device_registered", () => {
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

test("pickDeviceForTenant: 1 台 offline（心跳逾時）→ device_offline", () => {
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

test("pickDeviceForTenant: 租戶隔離（別的租戶的裝置不算）", () => {
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

// ───────────── W6a 內部路由：/internal/device/invoke 與 /status ─────────────

function internalDeps(bridge: DeviceBridge, tenants: Record<string, string | null> = { sess_ok: "u:1" }): InternalDeviceRouteDeps {
  return { bridge, resolveTenant: async (sid) => (sid in tenants ? tenants[sid] : null) }
}

test("/internal/device/invoke: happy path（mock 裝置走完 poll→result）回凍結契約形狀", async () => {
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
  // finalizeDeviceResult 對含 text 的結果會補 `truncated` 後設欄位（既有語義，非本路由）。
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

test("/internal/device/invoke: resolver 拋錯 → session_unknown（fail-closed，不外洩）", async () => {
  const bridge = new DeviceBridge()
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", { method: "POST", body: JSON.stringify({ op: "stat", path: "/tmp/a" }) })
  const res = await handleInternalDeviceInvoke(req, { bridge, resolveTenant: async () => { throw new Error("db down") } })
  assert.equal(res.status, 404)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "session_unknown")
})

test("/internal/device/invoke: 租戶無裝置 → no_device_registered", async () => {
  const bridge = new DeviceBridge()
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", { method: "POST", body: JSON.stringify({ op: "stat", path: "/tmp/a" }) })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 404)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "no_device_registered")
})

test("/internal/device/invoke: 裝置離線 → device_offline", async () => {
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

test("/internal/device/invoke: 非白名單 op → tool_not_allowed", async () => {
  const bridge = new DeviceBridge()
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1" })
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", { method: "POST", body: JSON.stringify({ op: "write_file", path: "/tmp/a" }) })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 403)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "tool_not_allowed")
})

test("/internal/device/invoke: denylist 仍生效（敏感路徑 → sensitive_path）", async () => {
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

test("/internal/device/invoke: 授權根仍生效（授權根外 → path_not_authorized）", async () => {
  const bridge = new DeviceBridge()
  bridge.register({ tenant: "u:1", userId: 1, apiKeyHash: "h1", roots: ["/home/u/project"] })
  // 註：共享 denylist 不含裸 `/etc/passwd`（見向量表；兩端一致，非缺口）——
  // 這裡要驗的是**授權根**這道防線，故以授權根外的 grep 遞迴根證明。
  const req = new Request("http://gw.internal/internal/device/invoke?session_id=sess_ok", {
    method: "POST",
    body: JSON.stringify({ op: "grep", path: "/etc", pattern: "root" }),
  })
  const res = await handleInternalDeviceInvoke(req, internalDeps(bridge))
  assert.equal(res.status, 403)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, "path_not_authorized")
})

test("/internal/device/invoke: 缺 session_id / 缺 op / 壞 body → bad_request", async () => {
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

test("/internal/device/invoke: 裝置在線但不回 result → device_timeout（不 hang）", async () => {
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
  // 必須在逾時附近就返回（不永久 pending）；給足餘裕以免 CI 抖動誤判。
  assert.ok(elapsed < 5_000, `elapsed=${elapsed}ms`)
  assert.equal(bridge.stats().pending, 0)
})

test("/internal/device/status: 無裝置 → device:null；有裝置 → 凍結形狀", async () => {
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

test("內部路由不放寬既有 denylist／白名單：op 白名單與 policy 工具集一致", () => {
  // 一對一映射的守門：內部 op 集合必須恰好等於既有 DeviceBridgeTool 白名單。
  const tools = ["list_dir", "read_file", "grep", "stat"]
  for (const t of tools) assert.equal(isToolAllowed(t), true, t)
  assert.equal(isToolAllowed("write_file"), false)
  assert.equal(isToolAllowed("delete"), false)
})
