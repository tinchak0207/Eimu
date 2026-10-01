/**
 * memory-gate.ts — VPS gateway 側純函式閘門 G1/G2/G3/G4/G6（契約 §5、§1、§8）。
 *
 * 鐵律：無 IO、無 env 讀取——一切開關以呼叫端注入的 ctx 為準
 * （sharedEnabled 對應 `MEMORY_SHARED_ENABLED`，ownerKeyHint 對應 gateway hashKey）。
 *
 * 輸入 = curator 原始候選（契約 §6 輸出 schema，snake_case）；
 * 輸出 doc = `AgentMemoryDocInput`（snake→camel 轉換發生在本檔，此後全鏈路駝峰）。
 *
 * 憑證紀律（G3）：丟棄時 reason 只回代號，結果物件絕不回顯命中內容。
 * 本檔禁止 import 倉庫 src/（gateway 獨立 bundle），型別在 §1 契約內本地重定義。
 */

// ─────────────────────────── 契約 §1 型別（本地副本，非 import）

export type MemoryScope = "private" | "shared"
export type MemoryType = "user" | "feedback" | "project" | "domain" | "workflow"
export type EvidenceKind = "tool_result" | "user_confirmed" | "verbatim"

/** 契約 §1：gateway 送 ingest 的 doc（id/status/revision/createdAt/updatedAt 由服務端生成）。 */
export interface AgentMemoryDocInput {
  scope: MemoryScope
  ownerKey?: string
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

/** curator（§6 schema）單條候選的鬆散形狀：G1 前一切皆 unknown。 */
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
  /** 對應 env `MEMORY_SHARED_ENABLED`：false 時共享庫零寫入 → shared 候選直接丟棄。 */
  sharedEnabled: boolean
  /** private doc 歸屬（SHA-256(apiKey) 前 12 bytes hex，契約 §1）；缺欄時 shared→private 降級不可達，只能丟。 */
  ownerKeyHint?: string
}

export type GateAction = "accept" | "downgrade" | "drop"

export interface GateResult {
  action: GateAction
  /** 代號（g1_structure / g2_evidence / g3_secret / g6_score / g4_identity_downgraded / g4_no_owner / shared_disabled），恆不含正文。 */
  reason: string
  doc?: AgentMemoryDocInput
}

// ─────────────────────────── 閘門常量

const SCOPE_VALUES: readonly string[] = ["private", "shared"]
const TYPE_VALUES: readonly string[] = ["user", "feedback", "project", "domain", "workflow"]
const EVIDENCE_KIND_VALUES: readonly string[] = ["tool_result", "user_confirmed", "verbatim"]

const SLUG_RE = /^[a-z0-9-]{1,64}$/
const DESCRIPTION_MAX = 120 // 契約 §1/§5
const BODY_MAX = 2000 // 契約 §1/§5
const EVIDENCE_MIN = 10 // 契約 §5 G2 硬線
const SELF_SCORE_MIN_SHARED = 4 // 契約 §5 G6
const SELF_SCORE_MIN_PRIVATE = 3 // 契約 §5 G6

/** G3 敏感樣板（契約 §5）：子串命中即丟，reason 只回代號。 */
const G3_SUBSTRINGS: readonly string[] = [
  "sk-",
  "AIza",
  "Bearer ",
  "AKIA",
  "-----BEGIN",
  ".env",
]
const G3_REGEXES: readonly RegExp[] = [
  // JWT 三段（header.payload.signature，base64url 點分三段）
  /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // 密碼/OTP 關鍵詞（中英）
  /\b(password|passwd|passphrase|otp|one[-\s]?time[-\s]?(password|code)|verification\s+code)\b/i,
  /(密码|密碼|验证码|驗證碼|一次性密碼|一次性密码)/,
]

/**
 * G7 指令注入樣板（2026-09-29 審計新增，僅 shared → 丟棄）。
 * 威脅：shared 記憶會被召回並注入「所有用戶」的上下文，是跨租戶的間接注入通道。
 * 惡意用戶可把一段祈使指令偽裝成「領域知識」寫進 shared 庫，之後污染全體會話。
 * 本閘只掃 shared 候選：命中「改寫指令/冒充系統權威/索密鑰/繞計費」樣板即丟。
 * private 記憶只回注該用戶本人，風險域為自身，不過本閘（避免誤傷正常私有筆記）。
 */
const G7_REGEXES: readonly RegExp[] = [
  /(忽略|无视|無視|漠视|覆盖|覆蓋|推翻|作废|作廢)\s*(上|以上|之前|先前|前面|所有|全部|系统|系統|previous|prior|above|all)/i,
  /ignore\s+(all\s+)?(previous|prior|earlier|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|the\s+above)/i,
  /(你现在是|你現在是|from now on you are|you are now|扮演|pretend to be|act as (?:a|an|the)\s)/i,
  /(以|作为|作為)\s*(系统|系統|管理员|管理員|开发者|開發者|administrator|developer|root)\s*(身份|权限|權限|模式|mode)/i,
  /(system\s*prompt|developer\s*mode|jailbreak|越狱|越獄|DAN\b)/i,
  /(泄露|透露|输出|輸出|告诉我|告訴我|reveal|print|show)\s*(你的|the)?\s*(系统提示|系統提示|指令|prompt|api\s*key|密钥|密鑰|token|凭证|憑證)/i,
  /(绕过|繞過|跳过|跳過|bypass|skip)\s*(计费|計費|扣费|扣費|billing|quota|付费|付費|confirm|确认|確認|审核|審核|gate)/i,
  /(免费生成|免費生成|免扣费|免扣費|不扣费|不扣費|无需确认|無需確認|自动放行|自動放行)/,
  // 純祈使開頭且指向 agent 行為（覆蓋典型注入句式；正常領域知識罕以此開頭）
  /^\s*(you must|you should always|always\s+(?:call|use|reply|respond|ignore)|从现在起|從現在起|请务必|請務必)\b/im,
]

/** G4 身份泄漏樣板（契約 §5，僅 shared）：命中 → 降級 private；無 ownerKey 可降 → 丟棄。 */
const G4_REGEXES: readonly RegExp[] = [
  /[0-9a-fA-F]{24,}/, // ownerKey hex 長串（SHA-256 前 12 bytes = 24 hex）
  /ses_[A-Za-z0-9]/, // opencode session id
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // 郵箱
  /(?:https?:\/\/|www\.)\S+/i, // URL
  /(?:^|[\s(])\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/, // 絕對路徑（≥2 段）
  /[A-Za-z]:\\[^\s]+/, // Windows 絕對路徑
  /[$¥€£₹]\s*\d/, // 價格：貨幣符 + 數字
  /\d+(?:[.,]\d+)?\s*(?:元|美元|美金|块|塊|円|日元|人民幣|usd|cny|rmb|jpy|coins?)/i, // 價格：數字 + 貨幣單位
]

// ─────────────────────────── 工具

/** 剝 ```json / ``` 圍欄（curator 違約帶 fence 時的兜底；三態：無圍欄/```json/```）。 */
export function stripJsonFence(text: string): string {
  const source = String(text ?? "")
  const m = source.match(/^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/)
  return (m ? m[1] : source).trim()
}

function isString(v: unknown): v is string {
  return typeof v === "string"
}

/**
 * 依序跑 G1 → G2 → G3 → G6 → G4（契約 §5 gateway 側分工）。
 * 任何一閘丟棄即返回，不繼續後續閘。
 */
export function applyMemoryGates(
  candidate: CuratorCandidate,
  ctx: GateContext,
): GateResult {
  // G0（§8）：共享庫總開關關閉 → shared 零寫入。
  if (!ctx.sharedEnabled && candidate?.scope === "shared") {
    return { action: "drop", reason: "shared_disabled" }
  }

  // ── G1 結構（契約 §5/§1）：必填齊全、slug 正則、長度上限、枚舉命中。
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { action: "drop", reason: "g1_structure" }
  }
  const { scope, domain, slug, description, type, body } = candidate
  const evidenceKind = candidate.evidence_kind
  const selfScore = candidate.self_score
  if (
    !isString(scope) || !SCOPE_VALUES.includes(scope) ||
    // 2026-09-29 紅隊 H6：domain 會被逐字注入召回塊，限一行短標識（≤40 字、無換行/方括號），
    // 杜絕把長段指令塞進 domain 繞過正文閘。
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

  // ── G2 證據（契約 §5 硬線）：evidence ≥10 字元且 evidenceKind 命中枚舉（枚舉已由 G1 把關）。
  if (!isString(candidate.evidence) || candidate.evidence.trim().length < EVIDENCE_MIN) {
    return { action: "drop", reason: "g2_evidence" }
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

  // ── G3 敏感（契約 §5）：掃 description+body+evidence+domain+slug+links，命中即丟；不回顯內容。
  // 2026-09-29 紅隊 H6：domain/slug 會被 renderRecallPrefix 逐字注入「所有用戶」的召回塊，
  //   必須與正文同受 G3/G4/G7 把關（此前只掃 3 欄，domain 是未設防的跨租戶注入縫）。
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

  // ── G6 分數（契約 §5）：shared ≥4、private ≥3（以原始 scope 判定）。
  const minScore = doc.scope === "shared" ? SELF_SCORE_MIN_SHARED : SELF_SCORE_MIN_PRIVATE
  if (doc.selfScore < minScore) {
    return { action: "drop", reason: "g6_score" }
  }

  // ── G7 指令注入（2026-09-29 審計，僅 shared）：防跨租戶記憶投毒。命中即丟，不回顯內容。
  if (doc.scope === "shared") {
    for (const re of G7_REGEXES) {
      if (re.test(scanned)) {
        return { action: "drop", reason: "g7_injection" }
      }
    }
  }

  // ── G4 身份泄漏（契約 §5，僅 shared）：命中 → 降級 private；無 ownerKey 可降 → 丟棄。
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
      return {
        action: "downgrade",
        reason: "g4_identity_downgraded",
        doc: { ...doc, scope: "private", ownerKey },
      }
    }
  }

  return { action: "accept", reason: "ok", doc }
}
