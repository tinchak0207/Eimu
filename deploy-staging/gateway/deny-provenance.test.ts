/**
 * deny-provenance.test.ts —— 需求1（拒絕決策 provenance）＋需求2（被遮蔽規則偵測）的真值測試。
 *
 * 真值來源：**真實**的 deny 表 deploy-staging/opencode-runtime/opencode.json（不是假表），
 * 以與網關同一支 parseBashDenyPatterns 解析。跑法：
 *   bash deploy-staging/vps-tools/run-tests.sh deny-provenance.test.ts
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  parseBashDenyPatterns,
  bashDenyAttribution,
  bashDenyProvenance,
  denyHintFor,
  detectShadowedBashDenyRules,
  logShadowedBashDenyRules,
  appendDenyAudit,
  handleToolPartUpdate,
  type DenyAuditRecord,
} from "./events-translate.ts"

const REAL_JSON = fileURLToPath(new URL("../opencode-runtime/opencode.json", import.meta.url))
const rawCfg = readFileSync(REAL_JSON, "utf-8")
const realPatterns = parseBashDenyPatterns(rawCfg)

// 確定性隔離（在任何測試與任何 default 載入之前執行，杜絕執行順序／主機環境依賴）：
//  - 讓網關 60s 快取載入路徑（loadBashDenyPatterns 預設路徑）永遠指向真表，
//    不因宿主 /opt/agent-harness 是否存在、或測試先後而異（快取是模組級可變狀態）；
//  - 讓稽核落點導入本次執行專屬 tmp，不寫到主機 /opt。
process.env.BASH_DENY_CONFIG_PATH = REAL_JSON
process.env.DENY_AUDIT_PATH = path.join(mkdtempSync(path.join(tmpdir(), "deny-audit-e2e-")), "audit.jsonl")

// ── 前置真值：確認真的讀到真表 ──
test("真表載入：44 條 deny，含 sudo*/apt*/rm -rf /*，無全捕 *", () => {
  assert.equal(realPatterns.length, 44, "opencode-runtime 的 deny 條數")
  assert.ok(realPatterns.includes("sudo*"))
  assert.ok(realPatterns.includes("apt*"))
  assert.ok(realPatterns.includes("rm -rf /*"))
  assert.ok(!realPatterns.includes("*"), "當前真表無全捕 deny")
})

// ── 需求1：provenance ──
test("provenance：真命中 deny 的 bash → source/pattern/hint 全對", () => {
  const cmd = "chmod 777 /etc/shadow"
  const prov = bashDenyProvenance(cmd, realPatterns)
  assert.ok(prov, "應有 provenance")
  assert.equal(prov.source, "deny_glob")
  assert.equal(prov.pattern, "chmod*")
  assert.equal(prov.hint, denyHintFor("chmod*"))
  assert.match(prov.reason, /chmod\*/)
})

test("provenance：取最具體命中（apt-get* 勝過 apt*）", () => {
  const prov = bashDenyProvenance("apt-get install -y curl", realPatterns)
  assert.equal(prov?.pattern, "apt-get*")
})

test("provenance：同分時取先出現者（rm -rf / 與 rm -rf /* 同分）", () => {
  const prov = bashDenyProvenance("rm -rf /", realPatterns)
  assert.equal(prov?.pattern, "rm -rf /")
})

test("provenance：被拒但表內查不到具體 glob → source=unknown、pattern=null（誠實缺口）", () => {
  const prov = bashDenyProvenance("xargs rm -rf /tmp/x", realPatterns)
  assert.ok(prov)
  assert.equal(prov.source, "unknown")
  assert.equal(prov.pattern, null)
  assert.equal(typeof prov.hint, "string")
})

test("向下相容：bashDenyAttribution 回傳欄位集一字不變（僅 pattern/hint）", () => {
  const att = bashDenyAttribution("chmod 777 x", realPatterns)
  assert.ok(att)
  assert.deepEqual(Object.keys(att).sort(), ["hint", "pattern"])
  assert.equal(att.pattern, "chmod*")
})

// ── 需求1：真驅動 handleToolPartUpdate，檢查 error 幀 ──
function makeFakeState(sessionId: string): any {
  return {
    sessionId,
    clients: new Set(),
    replayBuffer: [],
    eventCounter: 0,
    lastActivityAt: Date.now(),
    toolStatusSeen: new Set(),
    toolInvokeSeen: new Set(),
    canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(),
    announcedUrls: new Set(),
    partTextEmitted: new Map(),
    partStripState: new Map(),
    suppressedParts: new Set(),
    messageRole: new Map(),
    pendingConfirms: new Map(),
    pendingQuestions: new Map(),
    resolvedConfirms: new Map(),
    sessionTasks: new Map(),
  }
}

function collectFrames(state: any): Record<string, unknown>[] {
  const dec = new TextDecoder()
  const out: Record<string, unknown>[] = []
  for (const entry of state.replayBuffer) {
    if (!entry || !entry.frame) continue
    const txt = dec.decode(entry.frame)
    const m = txt.match(/event: ([^\n]+)\ndata: (.+)\n/)
    if (!m) continue
    out.push({ __event: m[1], ...(JSON.parse(m[2]) as Record<string, unknown>) })
  }
  return out
}

test("error 幀：既有欄位語義不變＋新增 deny_provenance", () => {
  const state = makeFakeState("sess_prov_test")
  const cmd = "chmod 777 /etc/shadow"
  handleToolPartUpdate(state, {
    tool: "bash",
    callID: "call_prov_1",
    state: {
      status: "error",
      input: { command: cmd },
      error: "The user specified a rule which prevents this operation. Relevant rules: [...]",
    },
  })
  const tr = collectFrames(state).find((f) => f.__event === "tool.result")
  assert.ok(tr, "應發出 tool.result 幀")
  const err = (tr as any).error
  const att = bashDenyAttribution(cmd, realPatterns)!
  // 既有欄位：一字不變
  assert.equal(err.code, "tool_error")
  assert.equal(err.matched_pattern, att.pattern)
  assert.equal(err.hint, att.hint)
  assert.ok(typeof err.message === "string" && err.message.includes("此操作不在允许范围内，已跳过"))
  assert.ok(typeof err.human_message === "string")
  // 新增欄位：結構化 provenance
  assert.equal(err.deny_provenance.source, "deny_glob")
  assert.equal(err.deny_provenance.pattern, "chmod*")
  assert.equal(err.deny_provenance.hint, att.hint)
  // 欄位集合＝舊集合 ∪ {deny_provenance}
  assert.deepEqual(
    Object.keys(err).sort(),
    ["code", "message", "human_message", "matched_pattern", "hint", "deny_provenance"].sort(),
  )
  // 稽核確實由 error 幀路徑寫入本執行專屬 tmp（不依賴主機 /opt）
  const audit = JSON.parse(readFileSync(process.env.DENY_AUDIT_PATH as string, "utf-8").trim())
  assert.equal(audit.session_id, "sess_prov_test")
  assert.equal(audit.source, "deny_glob")
  assert.equal(audit.pattern, "chmod*")
})

// ── 需求1：持久稽核 ──
test("appendDenyAudit：落 jsonl 且欄位完整", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deny-audit-"))
  const file = path.join(dir, "audit.jsonl")
  const rec: DenyAuditRecord = {
    ts: "2026-10-02T00:00:00.000Z",
    session_id: "sess_x",
    call_id: "call_x",
    tool: "bash",
    operation: '（被拒操作：bash 命令 "chmod 777 /etc/shadow"）',
    source: "deny_glob",
    pattern: "chmod*",
    reason: "bash 命中 deny 表规则 chmod*",
    hint: denyHintFor("chmod*"),
  }
  appendDenyAudit(rec, file)
  const lines = readFileSync(file, "utf-8").trim().split("\n")
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), rec)
})

// ── 需求2：被遮蔽規則偵測 ──
test("真表：偵測出 2 條冗餘（apt-get*←apt*、rm -rf /←rm -rf /*），不誤報獨立紅線", () => {
  const found = detectShadowedBashDenyRules(realPatterns)
  const sub = found.filter((s) => s.kind === "subsumed")
  assert.deepEqual(
    sub.map((s) => [s.rule, s.shadowedBy]).sort(),
    [
      ["apt-get*", "apt*"],
      ["rm -rf /", "rm -rf /*"],
    ],
  )
  assert.equal(found.filter((s) => s.kind === "pathological_breadth").length, 0, "當前真表無病態過寬")
  const rules = new Set(found.map((s) => s.rule))
  for (const independent of ["sudo*", "nc *", "ssh*", "su", "service *", "rm -rf /*"]) {
    assert.ok(!rules.has(independent), `${independent} 不應被判定為被遮蔽`)
  }
})

test("病態過寬：內容級子串掃描（*curl*/*sudo*）被抓出（08-29 橘貓病灶形態）", () => {
  const table = [...realPatterns, "*curl*", "*sudo*"]
  const found = detectShadowedBashDenyRules(table)
  const patho = found.filter((s) => s.kind === "pathological_breadth").map((s) => s.rule).sort()
  assert.deepEqual(patho, ["*curl*", "*sudo*"])
  // *sudo* 首字元即 *，無法證明其匹配集是 sudo* 的子集 → 不應誤報 sudo* 被遮蔽
  assert.ok(!found.some((s) => s.kind === "subsumed" && s.rule === "sudo*"))
})

test("全捕 *：所有其他 deny 皆被其遮蔽（整表失效），* 本身為病態過寬", () => {
  const table = ["*", "sudo*", "apt-get*"]
  const found = detectShadowedBashDenyRules(table)
  assert.ok(found.some((s) => s.kind === "pathological_breadth" && s.rule === "*"))
  for (const r of ["sudo*", "apt-get*"]) {
    const s = found.find((x) => x.kind === "subsumed" && x.rule === r)
    assert.equal(s?.shadowedBy, "*")
  }
})

test("logShadowedBashDenyRules 回傳即偵測結果（載入路徑用同一函式）", () => {
  const found = logShadowedBashDenyRules(realPatterns)
  assert.equal(found.length, 2)
})

// ── 需求2：語義界定（為何 teacher 的缺陷類在此形態真空）固化 ──
test("語義固化：deny-only 表無 allow/ask 分層 ⇒ allow-shadowed-by-deny 缺陷類真空", () => {
  const cfg = JSON.parse(rawCfg) as { permission?: { bash?: Record<string, string> } }
  const bash = cfg.permission?.bash ?? {}
  const allow = Object.entries(bash).filter(([, v]) => v === "allow")
  const ask = Object.entries(bash).filter(([, v]) => v === "ask")
  assert.deepEqual(allow, [["*", "allow"]], "唯一 allow 是 tool-wide 回退")
  assert.equal(ask.length, 0, "無 ask 層")
  // 沒有「具體 allow」可供遮蔽；不 deny 即 allow。故 teacher 的
  // 「specific allow 被 tool-wide deny 永久擋住」缺陷類在我方形態下不存在——
  // 能計算的只有 deny 之間的冗餘（subsumed）與病態過寬，皆 lint 級非安全缺陷。
  assert.ok(realPatterns.every((p) => typeof p === "string" && p.length > 0))
})
