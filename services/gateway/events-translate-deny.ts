import { readFileSync, appendFileSync } from "node:fs"
import path from "node:path"
import { WORKSPACE_DIR } from "./constants-gateway.ts"
import type { DenySource, DenyProvenance, DenyAuditRecord, ShadowedRule } from "./events-translate-types.ts"
// ── R8-B 工单 #2（2026-08-29）：拒单报因 ──
// R8 实锤：grep BRE 交替 \| 撞 deny 的 *|* 被拒，报错不说命中哪条规则，
// 模型花 78s 人肉逆向权限表。修法：被拒 bash 命令对 permission.bash 的
// deny glob 求匹配，error 帧附 matched_pattern + 一句替代写法。
export let bashDenyCache: { at: number; patterns: string[] } | null = null

/** 从 opencode.json 原文解析 deny glob（纯函式；载入路径与测试共用同一解析，避免测试用假表）。 */
export function parseBashDenyPatterns(raw: string): string[] {
  try {
    const cfg = JSON.parse(raw) as { permission?: { bash?: Record<string, string> } }
    return Object.entries(cfg.permission?.bash ?? {})
      .filter(([, v]) => v === "deny")
      .map(([k]) => k)
  } catch {
    return []
  }
}

export function loadBashDenyPatterns(): string[] {
  const now = Date.now()
  if (bashDenyCache && now - bashDenyCache.at < 60_000) return bashDenyCache.patterns
  let patterns: string[] = []
  try {
    // 路径可 env 覆写（测试喂真实表；生产不设即为既有 WORKSPACE_DIR 路径）。
    const cfgPath = process.env.BASH_DENY_CONFIG_PATH || path.join(WORKSPACE_DIR, ".opencode", "opencode.json")
    const raw = readFileSync(cfgPath, "utf-8")
    patterns = parseBashDenyPatterns(raw)
  } catch {
    // 配置读不到就不归因——报错退回短句，不阻塞工具错误透传
  }
  bashDenyCache = { at: now, patterns }
  // 需求2（2026-10-02）：启动／每次 60s 重载后做一次被遮蔽规则侦测并以结构化日志告警。
  logShadowedBashDenyRules(patterns)
  return patterns
}

/** deny glob → RegExp（* 通配任意字元含换行，其余按字面量）。 */
export function denyGlobToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*")
  return new RegExp(`^${body}$`)
}

/** 替代写法提示（按命中规则类型给一句可操作的话；出站文案一律简体，书写体镜像已拆）。 */
export function denyHintFor(pattern: string): string {
  if (pattern === "*|*")
    return "BRE 交替 \\| 含禁止符 |。改用宽匹配后自行筛选（如 grep -n \"第.*章\"），或改用 run_py 工具写脚本处理"
  if (pattern === "*&&*" || pattern === "*||*" || pattern === "*;*")
    return "执行环境只允许单条命令。拆成多次单命令调用，或改用 run_py 工具写脚本一次完成"
  if (pattern === "*>*" || pattern === "*>>*" || pattern === "*<*")
    return "执行环境禁止重定向/输入改向。拆成多次单命令调用，或改用 run_py 工具写脚本一次完成"
  return "请改用允许的命令（ls/cat/grep/sed -n/awk/find 等），或改用 run_py 工具写脚本"
}

/** 对 deny glob 求匹配；命中多条时取最具体的（非 * 字面量最长者），跳过全捕 *。
 *  patterns 可注入（测试直接喂真实 opencode.json 解析出的表）；省略时走 60s 快取载入。 */
export function bashDenyAttribution(cmd: string, patterns?: string[]): { pattern: string; hint: string } | null {
  if (!cmd) return null
  let best: { pattern: string; score: number } | null = null
  for (const p of patterns ?? loadBashDenyPatterns()) {
    if (p === "*") continue // 全捕规则不报因（零信息量）
    if (!denyGlobToRegExp(p).test(cmd)) continue
    const score = p.replace(/\*/g, "").length
    if (!best || score > best.score) best = { pattern: p, score }
  }
  if (!best) return null
  return { pattern: best.pattern, hint: denyHintFor(best.pattern) }
}

// ── 需求1（2026-10-02）：拒绝决策的 provenance ──
// 设计取自 Claude Code PermissionDecisionReason（带型别联合 rule/mode/hook/classifier/
// sandboxOverride/safetyCheck，见 teacher-repo src/types/permissions.ts:271-324）；
// **未复制任何程式码**，只取其「拒绝原因须为结构化带型别物件，而非自由字串」的设计。
// 向下相容：既有 error 帧栏位 matched_pattern / hint 语义一字不改，只新增 deny_provenance。

/** 依 opencode 拒绝讯息判定成因类别（为 path gate / sandbox 层预留同一 provenance 型别）。 */
export function classifyDenySource(message: string): DenySource {
  if (/\bsandbox\b|bwrap|operation not permitted/i.test(message)) return "sandbox_unavailable"
  if (/(^|[^A-Za-z])path([^A-Za-z]|$)|路径|不可见|outside the workspace/i.test(message)) return "path_gate"
  if (/specified a rule which prevents|relevant rules/i.test(message)) return "deny_glob"
  return "unknown"
}

/** 拒绝决策的结构化 provenance；与 bashDenyAttribution 同源，不改变其结果。 */
export function bashDenyProvenance(cmd: string, patterns?: string[], message?: string): DenyProvenance | null {
  const cls = message ? classifyDenySource(message) : "deny_glob"
  const att = bashDenyAttribution(cmd, patterns)
  if (!att) {
    if (!cmd) return null
    return {
      source: cls === "deny_glob" ? "unknown" : cls,
      pattern: null,
      reason: "bash 被拒但未匹配到 deny 表任何具体 glob（表可能已漂移）",
      hint: denyHintFor(""),
    }
  }
  return {
    source: cls === "unknown" ? "deny_glob" : cls,
    pattern: att.pattern,
    reason: `bash 命中${cls === "deny_glob" ? " deny 表规则" : cls} ${att.pattern}`,
    hint: att.hint,
  }
}

// 持久稽核：沿用既有日志落点（gateway stdout → journald）＋ append-only jsonl；
// 落盘失败一律 fail-open，绝不阻塞拒单。路径可用 env 覆写（测试注入 tmp 档）。
export const DENY_AUDIT_PATH = process.env.DENY_AUDIT_PATH || "/opt/agent-harness/deny-audit.jsonl"


export function appendDenyAudit(
  record: DenyAuditRecord,
  // 预设路径于呼叫时解析（env 可于执行期覆写，供测试把稽核导入 tmp；生产不设＝DENY_AUDIT_PATH）。
  auditPath: string = process.env.DENY_AUDIT_PATH ?? DENY_AUDIT_PATH,
): void {
  let line: string
  try {
    line = JSON.stringify(record)
  } catch {
    return
  }
  console.log(`[gateway] deny-audit ${line}`)
  if (auditPath === "") return
  try {
    appendFileSync(auditPath, line + "\n")
  } catch {
    // 稽核落盘失败不得阻塞拒单
  }
}

// ── 需求2（2026-10-02）：被遮蔽规则侦测 ──
// 设计取自 Claude Code shadowedRuleDetection（侦测 tool-wide deny/ask 使更具体的 allow
// 永不生效，见 teacher-repo src/utils/permissions/shadowedRuleDetection.ts:193-234）；
// **未复制任何程式码**。
//
// 语义界定（现场证据 opencode-runtime/opencode.json）：我方 permission.bash 是 deny-only
// 表＝ 44 条 deny ＋ 唯一一条 tool-wide "*": "allow"。**没有 allow/ask 分层**，故 teacher 的
// 缺陷类（specific allow 被 tool-wide deny 遮蔽 ⇒ 有人意图放行却被永久挡住）在此形态下
// **真空不成立**：不 deny 即 allow，不存在「意图放行的 allow 规则」可被遮蔽。硬套 allow/deny
// 对抗模型只会做出无意义的假缺陷。可计算的真实类比有两类（皆为 lint 级，非安全缺陷）：
//   (a) subsumed：更窄的 deny 规则其匹配集是某更宽 deny 规则的子集 ⇒ 该规则对拒绝覆盖面
//       零贡献（冗余），删除不改变行为；
//   (b) pathological_breadth：匹配面病态过宽的样式（`*` 全捕，或 `*x*` 内容级子串扫描）——
//       这是 08-29 橘猫事件的真实病灶（`*curl*` 扫描封死免费池）。

/** glob 首个 `*` 之前的字面前缀（首字元即 * 时为 ""）。 */
function globLeadLiteral(glob: string): string {
  const i = glob.indexOf("*")
  return i < 0 ? glob : glob.slice(0, i)
}

/** 病态过宽判定（保守门槛，避免把常规短前缀误报成缺陷）。 */
function pathologicalBreadth(glob: string): string | null {
  if (glob === "*") return "全捕规则（*）：覆盖全部命令，等于禁用 bash 工具"
  if (glob.length > 2 && glob.startsWith("*") && glob.endsWith("*")) {
    return `内容级子串扫描（${glob}）：任何命令参数含该子串即被拒——08-29 橘猫事件的病灶形态`
  }
  if (/^.\*$/.test(glob)) return `前缀仅 1 个字元的宽匹配（${glob}）：覆盖面极大，易误伤合法命令`
  return null
}

/**
 * 声音式（不误报）子集判定：规则 r 的匹配集 ⊆ 规则 b 的匹配集。
 * 仅对「单尾星」宽规则（b = P*，匹配一切以 P 开头的字串）做证明；其余形态一律回 false
 * （宁可漏报不可误报——lint 警告不能造假缺陷）。
 */
function isPatternSubset(r: string, b: string): boolean {
  if (r === b) return false
  if (b === "*") return true
  if (!b.endsWith("*") || b.indexOf("*") !== b.length - 1) return false
  const prefix = b.slice(0, -1)
  if (prefix === "") return true
  if (r.startsWith("*")) return false // 首字元即 * ⇒ 可匹配不以 prefix 开头的字串，无法证明
  return globLeadLiteral(r).startsWith(prefix)
}

/**
 * 侦测 deny 表中被遮蔽／病态过宽的规则。纯函式，供载入路径与测试共用。
 * 回传顺序：先全部 pathological_breadth，再全部 subsumed（各自按输入序）。
 */
export function detectShadowedBashDenyRules(patterns: string[]): ShadowedRule[] {
  const uniq = [...new Set(patterns)]
  const out: ShadowedRule[] = []
  for (const p of uniq) {
    const verdict = pathologicalBreadth(p)
    if (verdict) out.push({ rule: p, kind: "pathological_breadth", shadowedBy: null, reason: verdict })
  }
  for (const p of uniq) {
    let best: string | null = null
    for (const q of uniq) {
      if (q === p || !isPatternSubset(p, q)) continue
      if (best === null) {
        best = q
        continue
      }
      const bq = globLeadLiteral(q).length
      const bb = globLeadLiteral(best).length
      if (bq < bb || (bq === bb && q < best)) best = q
    }
    if (best !== null) {
      out.push({
        rule: p,
        kind: "subsumed",
        shadowedBy: best,
        reason: `规则 ${p} 的匹配集是 ${best} 的子集，对拒绝覆盖面零贡献（冗余规则，删除不改变行为）`,
      })
    }
  }
  return out
}

/** 载入／重载时呼叫：结构化日志告警；回传侦测结果供测试与呼叫方使用。 */
export function logShadowedBashDenyRules(patterns: string[]): ShadowedRule[] {
  const shadowed = detectShadowedBashDenyRules(patterns)
  if (patterns.length === 0) return shadowed // 表读不到：不报「0 findings」误导（与 parse 失败区分）
  if (shadowed.length === 0) {
    console.log(
      "[gateway] shadowed-deny scan: 0 findings（deny-only 表无 allow 层，teacher 的 allow-shadowed 缺陷类真空）",
    )
    return shadowed
  }
  for (const s of shadowed) {
    console.log(
      `[gateway] shadowed-deny ${s.kind} rule=${JSON.stringify(s.rule)} shadowed_by=${JSON.stringify(
        s.shadowedBy,
      )} reason=${s.reason}`,
    )
  }
  return shadowed
}
