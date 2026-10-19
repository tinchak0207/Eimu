/**
 * memory-note.ts —「事实 + 证据」低成本记忆通道的确定性规范化器（2026-10-19）。
 *
 * 目的：模型只交 `{fact, evidence, source[, scope, domain, slug, type]}`，
 * 其余（结构、slug、描述、域缺省、self_score）全部由本档补齐，**不呼叫 LLM**，
 * 不产生任何付费上游请求。
 *
 * 铁律：
 * - 纯函式：无 IO、无 env、无时间依赖（同样输入恒得同样输出，slug 亦然）。
 * - 失败只回代号（g1_structure / g2_evidence / g2_evidence_shared），不回显正文。
 * - 输出 candidate 为 snake_case（`evidence_kind`/`self_score`），形状与
 *   `applyMemoryGates` 的 `CuratorCandidate` 输入一致——上层可直接过闸。
 * - `contributorKey` 只在 shared 且拿到 ownerKeyHint 时携带；private 恒不携带
 *   （private 的归属由呼叫端以服务端解析出的 ownerKey 补上）。
 */
import { createHash } from "node:crypto"

export interface MemoryNoteInput {
  fact: string
  evidence: string
  source: "tool_result" | "user_confirmed"
  scope?: "private" | "shared"
  domain?: string
  slug?: string
  type?: "user" | "feedback" | "project" | "domain" | "workflow"
}

export type MemoryNoteResult =
  | { ok: true; candidate: Record<string, unknown> }
  | { ok: false; reason: string }

const FACT_MAX = 2000
const EVIDENCE_MIN = 10
const DESCRIPTION_MAX = 120
const DOMAIN_MAX = 40
const SLUG_RE = /^[a-z0-9-]{1,64}$/
const SCOPES: readonly string[] = ["private", "shared"]
const SOURCES: readonly string[] = ["tool_result", "user_confirmed"]
const TYPES: readonly string[] = ["user", "feedback", "project", "domain", "workflow"]

/** shared 的通道定价：满足既有 G6 下限（≥4）；风险由 shared 证据规则与跨账号佐证承接。 */
const SELF_SCORE_SHARED = 4
/** private 的通道定价：满足既有 G6 下限（≥3）。 */
const SELF_SCORE_PRIVATE = 3

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

/** description = fact 第一个非空行；连续空白压成单空格；硬截 120 字元。 */
function descriptionOf(fact: string): string {
  const firstLine = fact.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ""
  return firstLine.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX)
}

/**
 * domain 会被逐字注入跨租户召回块（见 memory-gate G1 注释），因此只接受
 * 一行短标识：去掉换行与【】[]，压空白，截 40 字元；清洗后为空 → 回落缺省。
 */
function domainOf(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback
  const cleaned = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/[【】[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DOMAIN_MAX)
  return cleaned.length > 0 ? cleaned : fallback
}

/**
 * 规范化单条「事实 + 证据」记忆。
 *
 * `opts.ownerKeyHint` 必须是服务端解析出的身份（gateway hashKey），
 * 绝不接受请求体自报的 ownerKey。
 */
export function normalizeMemoryNote(
  input: MemoryNoteInput,
  opts?: { ownerKeyHint?: string },
): MemoryNoteResult {
  // ── G1 结构：必填栏型别与长度；scope/source/type 必须是枚举值 ──────────
  if (input === null || typeof input !== "object") return { ok: false, reason: "g1_structure" }
  const { fact, evidence, source, scope: scopeRaw, domain: domainRaw, slug: slugRaw, type: typeRaw } =
    input as MemoryNoteInput

  if (typeof fact !== "string" || typeof evidence !== "string") {
    return { ok: false, reason: "g1_structure" }
  }
  const factTrimmed = fact.trim()
  if (factTrimmed.length < 1 || factTrimmed.length > FACT_MAX) {
    return { ok: false, reason: "g1_structure" }
  }

  if (typeof source !== "string" || !SOURCES.includes(source)) {
    return { ok: false, reason: "g1_structure" }
  }

  const scope = scopeRaw === undefined ? "private" : scopeRaw
  if (typeof scope !== "string" || !SCOPES.includes(scope)) {
    return { ok: false, reason: "g1_structure" }
  }

  const type = typeRaw === undefined ? (scope === "shared" ? "domain" : "user") : typeRaw
  if (typeof type !== "string" || !TYPES.includes(type)) {
    return { ok: false, reason: "g1_structure" }
  }

  // ── G2 证据：trim 后 ≥10 字元；shared 只收平台可观测的工具结果 ─────────
  const evidenceTrimmed = evidence.trim()
  if (evidenceTrimmed.length < EVIDENCE_MIN) {
    return { ok: false, reason: "g2_evidence" }
  }
  if (scope === "shared" && source !== "tool_result") {
    return { ok: false, reason: "g2_evidence_shared" }
  }

  const description = descriptionOf(factTrimmed)
  if (description.length === 0) {
    // fact 已非空，理论上不可达；仍 fail-closed 回结构代号。
    return { ok: false, reason: "g1_structure" }
  }

  // slug：调用方给了合法 kebab-case 就尊重；否则用 fact 的短哈希（确定性、无正文泄漏）。
  const slug =
    typeof slugRaw === "string" && SLUG_RE.test(slugRaw)
      ? slugRaw
      : `note-${sha256Hex(factTrimmed).slice(0, 8)}`

  const ownerKeyHint =
    typeof opts?.ownerKeyHint === "string" && opts.ownerKeyHint.length > 0
      ? opts.ownerKeyHint
      : undefined

  const candidate: Record<string, unknown> = {
    scope,
    domain: domainOf(domainRaw, scope === "shared" ? "platform" : "general"),
    slug,
    description,
    type,
    body: factTrimmed,
    evidence: evidenceTrimmed,
    evidence_kind: source,
    self_score: scope === "shared" ? SELF_SCORE_SHARED : SELF_SCORE_PRIVATE,
    links: [],
  }
  if (scope === "shared" && ownerKeyHint) {
    candidate.contributorKey = ownerKeyHint
  }
  return { ok: true, candidate }
}
