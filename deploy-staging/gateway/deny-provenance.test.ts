/**
 * deny-provenance.test.ts —— 需求1（拒绝决策 provenance）＋需求2（被遮蔽规则侦测）的真值测试。
 *
 * 真值来源：**真实**的 deny 表 deploy-staging/opencode-runtime/opencode.json（不是假表），
 * 以与网关同一支 parseBashDenyPatterns 解析。跑法：
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

// 确定性隔离（在任何测试与任何 default 载入之前执行，杜绝执行顺序／主机环境依赖）：
//  - 让网关 60s 快取载入路径（loadBashDenyPatterns 预设路径）永远指向真表，
//    不因宿主 /opt/agent-harness 是否存在、或测试先后而异（快取是模组级可变状态）；
//  - 让稽核落点导入本次执行专属 tmp，不写到主机 /opt。
process.env.BASH_DENY_CONFIG_PATH = REAL_JSON
process.env.DENY_AUDIT_PATH = path.join(mkdtempSync(path.join(tmpdir(), "deny-audit-e2e-")), "audit.jsonl")

// ── 前置真值：确认真的读到真表 ──
test("真表载入：44 条 deny，含 sudo*/apt*/rm -rf /*，无全捕 *", () => {
  assert.equal(realPatterns.length, 44, "opencode-runtime 的 deny 条数")
  assert.ok(realPatterns.includes("sudo*"))
  assert.ok(realPatterns.includes("apt*"))
  assert.ok(realPatterns.includes("rm -rf /*"))
  assert.ok(!realPatterns.includes("*"), "当前真表无全捕 deny")
})

// ── 需求1：provenance ──
test("provenance：真命中 deny 的 bash → source/pattern/hint 全对", () => {
  const cmd = "chmod 777 /etc/shadow"
  const prov = bashDenyProvenance(cmd, realPatterns)
  assert.ok(prov, "应有 provenance")
  assert.equal(prov.source, "deny_glob")
  assert.equal(prov.pattern, "chmod*")
  assert.equal(prov.hint, denyHintFor("chmod*"))
  assert.match(prov.reason, /chmod\*/)
})

test("provenance：取最具体命中（apt-get* 胜过 apt*）", () => {
  const prov = bashDenyProvenance("apt-get install -y curl", realPatterns)
  assert.equal(prov?.pattern, "apt-get*")
})

test("provenance：同分时取先出现者（rm -rf / 与 rm -rf /* 同分）", () => {
  const prov = bashDenyProvenance("rm -rf /", realPatterns)
  assert.equal(prov?.pattern, "rm -rf /")
})

test("provenance：被拒但表内查不到具体 glob → source=unknown、pattern=null（诚实缺口）", () => {
  const prov = bashDenyProvenance("xargs rm -rf /tmp/x", realPatterns)
  assert.ok(prov)
  assert.equal(prov.source, "unknown")
  assert.equal(prov.pattern, null)
  assert.equal(typeof prov.hint, "string")
})

test("向下相容：bashDenyAttribution 回传栏位集一字不变（仅 pattern/hint）", () => {
  const att = bashDenyAttribution("chmod 777 x", realPatterns)
  assert.ok(att)
  assert.deepEqual(Object.keys(att).sort(), ["hint", "pattern"])
  assert.equal(att.pattern, "chmod*")
})

// ── 需求1：真驱动 handleToolPartUpdate，检查 error 帧 ──
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

test("error 帧：既有栏位语义不变＋新增 deny_provenance", () => {
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
  assert.ok(tr, "应发出 tool.result 帧")
  const err = (tr as any).error
  const att = bashDenyAttribution(cmd, realPatterns)!
  // 既有栏位：一字不变
  assert.equal(err.code, "tool_error")
  assert.equal(err.matched_pattern, att.pattern)
  assert.equal(err.hint, att.hint)
  assert.ok(typeof err.message === "string" && err.message.includes("此操作不在允许范围内，已跳过"))
  assert.ok(typeof err.human_message === "string")
  // 新增栏位：结构化 provenance
  assert.equal(err.deny_provenance.source, "deny_glob")
  assert.equal(err.deny_provenance.pattern, "chmod*")
  assert.equal(err.deny_provenance.hint, att.hint)
  // 栏位集合＝旧集合 ∪ {deny_provenance}
  assert.deepEqual(
    Object.keys(err).sort(),
    ["code", "message", "human_message", "matched_pattern", "hint", "deny_provenance"].sort(),
  )
  // 稽核确实由 error 帧路径写入本执行专属 tmp（不依赖主机 /opt）
  const audit = JSON.parse(readFileSync(process.env.DENY_AUDIT_PATH as string, "utf-8").trim())
  assert.equal(audit.session_id, "sess_prov_test")
  assert.equal(audit.source, "deny_glob")
  assert.equal(audit.pattern, "chmod*")
})

// ── 需求1：持久稽核 ──
test("appendDenyAudit：落 jsonl 且栏位完整", () => {
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

// ── 需求2：被遮蔽规则侦测 ──
test("真表：侦测出 2 条冗余（apt-get*←apt*、rm -rf /←rm -rf /*），不误报独立红线", () => {
  const found = detectShadowedBashDenyRules(realPatterns)
  const sub = found.filter((s) => s.kind === "subsumed")
  assert.deepEqual(
    sub.map((s) => [s.rule, s.shadowedBy]).sort(),
    [
      ["apt-get*", "apt*"],
      ["rm -rf /", "rm -rf /*"],
    ],
  )
  assert.equal(found.filter((s) => s.kind === "pathological_breadth").length, 0, "当前真表无病态过宽")
  const rules = new Set(found.map((s) => s.rule))
  for (const independent of ["sudo*", "nc *", "ssh*", "su", "service *", "rm -rf /*"]) {
    assert.ok(!rules.has(independent), `${independent} 不应被判定为被遮蔽`)
  }
})

test("病态过宽：内容级子串扫描（*curl*/*sudo*）被抓出（08-29 橘猫病灶形态）", () => {
  const table = [...realPatterns, "*curl*", "*sudo*"]
  const found = detectShadowedBashDenyRules(table)
  const patho = found.filter((s) => s.kind === "pathological_breadth").map((s) => s.rule).sort()
  assert.deepEqual(patho, ["*curl*", "*sudo*"])
  // *sudo* 首字元即 *，无法证明其匹配集是 sudo* 的子集 → 不应误报 sudo* 被遮蔽
  assert.ok(!found.some((s) => s.kind === "subsumed" && s.rule === "sudo*"))
})

test("全捕 *：所有其他 deny 皆被其遮蔽（整表失效），* 本身为病态过宽", () => {
  const table = ["*", "sudo*", "apt-get*"]
  const found = detectShadowedBashDenyRules(table)
  assert.ok(found.some((s) => s.kind === "pathological_breadth" && s.rule === "*"))
  for (const r of ["sudo*", "apt-get*"]) {
    const s = found.find((x) => x.kind === "subsumed" && x.rule === r)
    assert.equal(s?.shadowedBy, "*")
  }
})

test("logShadowedBashDenyRules 回传即侦测结果（载入路径用同一函式）", () => {
  const found = logShadowedBashDenyRules(realPatterns)
  assert.equal(found.length, 2)
})

// ── 需求2：语义界定（为何 teacher 的缺陷类在此形态真空）固化 ──
test("语义固化：deny-only 表无 allow/ask 分层 ⇒ allow-shadowed-by-deny 缺陷类真空", () => {
  const cfg = JSON.parse(rawCfg) as { permission?: { bash?: Record<string, string> } }
  const bash = cfg.permission?.bash ?? {}
  const allow = Object.entries(bash).filter(([, v]) => v === "allow")
  const ask = Object.entries(bash).filter(([, v]) => v === "ask")
  assert.deepEqual(allow, [["*", "allow"]], "唯一 allow 是 tool-wide 回退")
  assert.equal(ask.length, 0, "无 ask 层")
  // 没有「具体 allow」可供遮蔽；不 deny 即 allow。故 teacher 的
  // 「specific allow 被 tool-wide deny 永久挡住」缺陷类在我方形态下不存在——
  // 能计算的只有 deny 之间的冗余（subsumed）与病态过宽，皆 lint 级非安全缺陷。
  assert.ok(realPatterns.every((p) => typeof p === "string" && p.length > 0))
})
