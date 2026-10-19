/**
 * memory-gate.ts — VPS gateway 侧纯函式闸门 G1/G2/G3/G4/G6（契约 §5、§1、§8）。
 *
 * 铁律：无 IO、无 env 读取——一切开关以呼叫端注入的 ctx 为准
 * （sharedEnabled 对应 `MEMORY_SHARED_ENABLED`，ownerKeyHint 对应 gateway hashKey）。
 *
 * 共享库收证纪律（2026-10-19）：shared 文档只收平台可观测证据——G2 硬线要求
 * `evidenceKind === "tool_result"`（否则 `g2_evidence_shared`），杜绝用户原话/模型推理
 * 进入全服可见的 shared 库；且 shared 必须带提出者身份（`contributorKey = ownerKeyHint`），
 * 缺 ownerKey 一律 `g4_no_owner`；G4 身份泄漏降级 private 时删除 `contributorKey`。
 *
 * 输入 = curator 原始候选（契约 §6 输出 schema，snake_case）；
 * 输出 doc = `AgentMemoryDocInput`（snake→camel 转换发生在本档，此后全链路驼峰）。
 *
 * 凭证纪律（G3）：丢弃时 reason 只回代号，结果物件绝不回显命中内容。
 * 本档禁止 import 仓库 src/（gateway 独立 bundle），型别在 §1 契约内本地重定义。
 */

// ─────────────────────────── 契约 §1 型别（本地副本，非 import）

export type MemoryScope = "private" | "shared"
export type MemoryType = "user" | "feedback" | "project" | "domain" | "workflow"
export type EvidenceKind = "tool_result" | "user_confirmed" | "verbatim"

/** 契约 §1：gateway 送 ingest 的 doc（id/status/revision/createdAt/updatedAt 由服务端生成）。 */
export interface AgentMemoryDocInput {
  scope: MemoryScope
  ownerKey?: string
  /** shared 文档的提出者 ownerKey（= 网关 hashKey），用于跨账号佐证；private 不携带。 */
  contributorKey?: string
  domain: string
  slug: string
  description: string
  type: MemoryType
  body: string
  links?: string[]
  evidence?: string
  evidenceKind: EvidenceKind
  selfScore: number
  promptVersion?: string
}

/** curator（§6 schema）单条候选的松散形状：G1 前一切皆 unknown。 */
export interface CuratorCandidate {
  scope?: unknown
  domain?: unknown
  slug?: unknown
  description?: unknown
  type?: unknown
  body?: unknown
  links?: unknown
  evidence?: unknown
  evidence_kind?: unknown
  self_score?: unknown
  self_score_reason?: unknown
  [key: string]: unknown
}

export interface GateContext {
  /** 对应 env `MEMORY_SHARED_ENABLED`：false 时共享库零写入 → shared 候选直接丢弃。 */
  sharedEnabled: boolean
  /** private doc 归属（SHA-256(apiKey) 前 12 bytes hex，契约 §1）；缺栏时 shared→private 降级不可达，只能丢。 */
  ownerKeyHint?: string
}

export type GateAction = "accept" | "downgrade" | "drop"

export interface GateResult {
  action: GateAction
  /** 代号（g1_structure / g2_evidence / g2_evidence_shared / g3_secret / g6_score / g4_identity_downgraded / g4_no_owner / shared_disabled），恒不含正文。 */
  reason: string
  doc?: AgentMemoryDocInput
}

// ─────────────────────────── 闸门常量

const SCOPE_VALUES: readonly string[] = ["private", "shared"]
const TYPE_VALUES: readonly string[] = ["user", "feedback", "project", "domain", "workflow"]
const EVIDENCE_KIND_VALUES: readonly string[] = ["tool_result", "user_confirmed", "verbatim"]

const SLUG_RE = /^[a-z0-9-]{1,64}$/
const DESCRIPTION_MAX = 120 // 契约 §1/§5
const BODY_MAX = 2000 // 契约 §1/§5
const EVIDENCE_MIN = 10 // 契约 §5 G2 硬线
const SELF_SCORE_MIN_SHARED = 4 // 契约 §5 G6
const SELF_SCORE_MIN_PRIVATE = 3 // 契约 §5 G6

/** G3 敏感样板（契约 §5）：子串命中即丢，reason 只回代号。 */
const G3_SUBSTRINGS: readonly string[] = [
  "sk-",
  "AIza",
  "Bearer ",
  "AKIA",
  "-----BEGIN",
  ".env",
]
const G3_REGEXES: readonly RegExp[] = [
  // JWT 三段（header.payload.signature，base64url 点分三段）
  /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // 密码/OTP 关键词（中英）
  /\b(password|passwd|passphrase|otp|one[-\s]?time[-\s]?(password|code)|verification\s+code)\b/i,
  /(密码|密码|验证码|验证码|一次性密码|一次性密码)/,
]

/**
 * G7 指令注入样板（2026-09-29 审计新增，仅 shared → 丢弃）。
 * 威胁：shared 记忆会被召回并注入「所有用户」的上下文，是跨租户的间接注入通道。
 * 恶意用户可把一段祈使指令伪装成「领域知识」写进 shared 库，之后污染全体会话。
 * 本闸只扫 shared 候选：命中「改写指令/冒充系统权威/索密钥/绕计费」样板即丢。
 * private 记忆只回注该用户本人，风险域为自身，不过本闸（避免误伤正常私有笔记）。
 */
const G7_REGEXES: readonly RegExp[] = [
  /(忽略|无视|无视|漠视|覆盖|覆盖|推翻|作废|作废)\s*(上|以上|之前|先前|前面|所有|全部|系统|系统|previous|prior|above|all)/i,
  /ignore\s+(all\s+)?(previous|prior|earlier|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|the\s+above)/i,
  /(你现在是|你现在是|from now on you are|you are now|扮演|pretend to be|act as (?:a|an|the)\s)/i,
  /(以|作为|作为)\s*(系统|系统|管理员|管理员|开发者|开发者|administrator|developer|root)\s*(身份|权限|权限|模式|mode)/i,
  /(system\s*prompt|developer\s*mode|jailbreak|越狱|越狱|DAN\b)/i,
  /(泄露|透露|输出|输出|告诉我|告诉我|reveal|print|show)\s*(你的|the)?\s*(系统提示|系统提示|指令|prompt|api\s*key|密钥|密钥|token|凭证|凭证)/i,
  /(绕过|绕过|跳过|跳过|bypass|skip)\s*(计费|计费|扣费|扣费|billing|quota|付费|付费|confirm|确认|确认|审核|审核|gate)/i,
  /(免费生成|免费生成|免扣费|免扣费|不扣费|不扣费|无需确认|无需确认|自动放行|自动放行)/,
  // 纯祈使开头且指向 agent 行为（覆盖典型注入句式；正常领域知识罕以此开头）
  /^\s*(you must|you should always|always\s+(?:call|use|reply|respond|ignore)|从现在起|从现在起|请务必|请务必)\b/im,
]

/** G4 身份泄漏样板（契约 §5，仅 shared）：命中 → 降级 private；无 ownerKey 可降 → 丢弃。 */
const G4_REGEXES: readonly RegExp[] = [
  /[0-9a-fA-F]{24,}/, // ownerKey hex 长串（SHA-256 前 12 bytes = 24 hex）
  /ses_[A-Za-z0-9]/, // opencode session id
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // 邮箱
  /(?:https?:\/\/|www\.)\S+/i, // URL
  /(?:^|[\s(])\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/, // 绝对路径（≥2 段）
  /[A-Za-z]:\\[^\s]+/, // Windows 绝对路径
  /[$¥€£₹]\s*\d/, // 价格：货币符 + 数字
  /\d+(?:[.,]\d+)?\s*(?:元|美元|美金|块|块|円|日元|人民币|usd|cny|rmb|jpy|coins?)/i, // 价格：数字 + 货币单位
]

// ─────────────────────────── 工具

/** 剥 ```json / ``` 围栏（curator 违约带 fence 时的兜底；三态：无围栏/```json/```）。 */
export function stripJsonFence(text: string): string {
  const source = String(text ?? "")
  const m = source.match(/^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/)
  return (m ? m[1] : source).trim()
}

function isString(v: unknown): v is string {
  return typeof v === "string"
}

/**
 * 依序跑 G1 → G2 → G3 → G6 → G4（契约 §5 gateway 侧分工）。
 * 任何一闸丢弃即返回，不继续后续闸。
 */
export function applyMemoryGates(
  candidate: CuratorCandidate,
  ctx: GateContext,
): GateResult {
  // G0（§8）：共享库总开关关闭 → shared 零写入。
  if (!ctx.sharedEnabled && candidate?.scope === "shared") {
    return { action: "drop", reason: "shared_disabled" }
  }

  // ── G1 结构（契约 §5/§1）：必填齐全、slug 正则、长度上限、枚举命中。
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { action: "drop", reason: "g1_structure" }
  }
  const { scope, domain, slug, description, type, body } = candidate
  const evidenceKind = candidate.evidence_kind
  const selfScore = candidate.self_score
  if (
    !isString(scope) || !SCOPE_VALUES.includes(scope) ||
    // 2026-09-29 红队 H6：domain 会被逐字注入召回块，限一行短标识（≤40 字、无换行/方括号），
    // 杜绝把长段指令塞进 domain 绕过正文闸。
    !isString(domain) || domain.trim().length === 0 || domain.length > 40 || /[\n\r【】\[\]⟦⟧]/.test(domain) ||
    !isString(slug) || !SLUG_RE.test(slug) ||
    !isString(description) || description.length === 0 || description.length > DESCRIPTION_MAX ||
    !isString(type) || !TYPE_VALUES.includes(type) ||
    !isString(body) || body.length === 0 || body.length > BODY_MAX ||
    !isString(evidenceKind) || !EVIDENCE_KIND_VALUES.includes(evidenceKind) ||
    typeof selfScore !== "number" || !Number.isFinite(selfScore) || selfScore < 1 || selfScore > 5
  ) {
    return { action: "drop", reason: "g1_structure" }
  }
  let links: string[] = []
  if (candidate.links !== undefined) {
    if (!Array.isArray(candidate.links) || !candidate.links.every((l) => isString(l) && l.length > 0)) {
      return { action: "drop", reason: "g1_structure" }
    }
    links = candidate.links as string[]
  }

  // ── G2 证据（契约 §5 硬线）：evidence ≥10 字元且 evidenceKind 命中枚举（枚举已由 G1 把关）。
  if (!isString(candidate.evidence) || candidate.evidence.trim().length < EVIDENCE_MIN) {
    return { action: "drop", reason: "g2_evidence" }
  }
  // 共享库只收平台可观测证据（2026-10-19 硬闸）：shared 必须 evidenceKind === "tool_result"，
  //   用户原话（user_confirmed）/ 逐字转述（verbatim）/ 模型推理一律不得进入全服可见库；private 不受影响。
  if (candidate.scope === "shared" && evidenceKind !== "tool_result") {
    return { action: "drop", reason: "g2_evidence_shared" }
  }

  const doc: AgentMemoryDocInput = {
    scope: scope as MemoryScope,
    domain: domain.trim(),
    slug,
    description,
    type: type as MemoryType,
    body,
    ...(links.length > 0 ? { links } : {}),
    evidence: candidate.evidence,
    evidenceKind: evidenceKind as EvidenceKind,
    selfScore,
  }

  // ── G3 敏感（契约 §5）：扫 description+body+evidence+domain+slug+links，命中即丢；不回显内容。
  // 2026-09-29 红队 H6：domain/slug 会被 renderRecallPrefix 逐字注入「所有用户」的召回块，
  //   必须与正文同受 G3/G4/G7 把关（此前只扫 3 栏，domain 是未设防的跨租户注入缝）。
  const scanned = `${description}\n${body}\n${candidate.evidence}\n${domain}\n${slug}\n${links.join("\n")}`
  for (const needle of G3_SUBSTRINGS) {
    if (scanned.includes(needle)) {
      return { action: "drop", reason: "g3_secret" }
    }
  }
  for (const re of G3_REGEXES) {
    if (re.test(scanned)) {
      return { action: "drop", reason: "g3_secret" }
    }
  }

  // ── G6 分数（契约 §5）：shared ≥4、private ≥3（以原始 scope 判定）。
  const minScore = doc.scope === "shared" ? SELF_SCORE_MIN_SHARED : SELF_SCORE_MIN_PRIVATE
  if (doc.selfScore < minScore) {
    return { action: "drop", reason: "g6_score" }
  }

  // ── 提出者身份（2026-10-19，仅 shared）：shared 必须可追溯到提出者（contributorKey = 网关 hashKey）；
  //    缺 ownerKeyHint 时无处归属，沿用既有 g4_no_owner 代号丢弃。private 用 ownerKey，不携带提出者。
  if (doc.scope === "shared") {
    const contributorKey = typeof ctx.ownerKeyHint === "string" && ctx.ownerKeyHint.length > 0
      ? ctx.ownerKeyHint
      : undefined
    if (!contributorKey) {
      return { action: "drop", reason: "g4_no_owner" }
    }
    doc.contributorKey = contributorKey
  }

  // ── G7 指令注入（2026-09-29 审计，仅 shared）：防跨租户记忆投毒。命中即丢，不回显内容。
  if (doc.scope === "shared") {
    for (const re of G7_REGEXES) {
      if (re.test(scanned)) {
        return { action: "drop", reason: "g7_injection" }
      }
    }
  }

  // ── G4 身份泄漏（契约 §5，仅 shared）：命中 → 降级 private；无 ownerKey 可降 → 丢弃。
  if (doc.scope === "shared") {
    let leak = false
    for (const re of G4_REGEXES) {
      if (re.test(scanned)) {
        leak = true
        break
      }
    }
    if (leak) {
      const ownerKey = typeof ctx.ownerKeyHint === "string" && ctx.ownerKeyHint.length > 0
        ? ctx.ownerKeyHint
        : undefined
      if (!ownerKey) {
        return { action: "drop", reason: "g4_no_owner" }
      }
      // 降级为 private：private 用 ownerKey 归属，不携带提出者 → 必须删除 contributorKey。
      const { contributorKey: _ignoredContributorKey, ...privateDoc } = doc
      return {
        action: "downgrade",
        reason: "g4_identity_downgraded",
        doc: { ...privateDoc, scope: "private", ownerKey },
      }
    }
  }

  return { action: "accept", reason: "ok", doc }
}
