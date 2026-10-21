import { memoryAgeDays, memoryFreshnessWarning } from "./memory-recall"
import type { SessionState } from "./types-gateway"
// ─────────────────────────── 全局记忆接线（PRD P0-4，2026-09-15）───────────────────────────
// 契约 = MEMORY-INTERFACES.md §3.5/§3.6/§4/§7/§8 + PRD §6。memory-gate/memory-batch/
// memory-recall 三模组已落位且逻辑冻结（单测 50 绿），本档只接线不动其逻辑。
// 本区内容：注入块组装纯函式（§4）、批次 deps 与定时器（§3.5/§8）、每回合召回
// prefetch（§7）、三个端点（batch-run / memory-trace / memory-recall）。
// 凭据纪律：MEMORY_INGEST_SECRET 与签名值永不写进 log／回应。

// §6.1 预算表：L0 2400、L1 800（system，首回合）；召回前缀 1800 由 renderRecallPrefix
// 自行封顶；合计硬上限 5000（R1 尺可断言）。
export const MEMORY_L0_BUDGET = 2400
export const MEMORY_L1_BUDGET = 800
export const MEMORY_INJECTION_TOTAL_BUDGET = 5000
// 2026-10-19：服务端实时平台状态块（非记忆）。预算 600；插在 L1 之后。
export const MEMORY_PLATFORM_STATUS_BUDGET = 600
// 2026-10-19 P1：热语料展开块（本轮相关记忆正文）。预算 1800（= RECALL_PREFIX_CAP），
// 但**必须计入 5000 总预算**：可用额度 = min(1800, 5000 - 已有各块长度之和)，
// 额度 ≤0 时整块不注入。历史缺陷：本块曾在 buildMemoryInjectionBlocks 之外 push，
// 绕过总预算（实测 2400+800+600+900+1800=6500）。
export const MEMORY_WARM_RECALL_BUDGET = 1800
export const MEMORY_PRIVATE_DOCS_MAX = 8 // 契约 §4：私有 active docs 注入 ≤8
export const MEMORY_TRUNC_MARK = "（已截断）" // 契约 §4 截断标记
export const MEMORY_RECALL_PREFETCH_TTL_MS = 5 * 60 * 1000 // 预取候选保鲜期（§7 prefetch）
export const MEMORY_ASSISTANT_HEAD_CHARS = 200 // §7 query 的 assistant 头部长度

/**
 * §4 注入文案（用途边界）：私有记忆只作「方法与偏好」参考，不是本轮创作底稿。
 * 病根：既往作品方案（角色/世界观/剧情/分镜）原样入 prompt，模型对「全新的世界观、
 * 全新的片」也照样沿用，创意被旧方案污染。故在私有记忆块前明写边界。
 */
export const MEMORY_PRIVATE_SCOPE_NOTE = [
  "以下过往记忆只作「方法与偏好」参考，不是本轮创作的底稿：",
  "- 用户要全新原创（新世界观、新片、新创意）时，禁止沿用其中任何既有作品的具体内容（角色、设定、剧情、片名、分镜、方案、文案），一律从零创作。",
  "- 只有用户明确点名「沿用 / 延续 / 基于 X」时，才可复用 X 的具体内容。",
  "- 可借用的只有方法：流程、风格配方、参数经验、失败教训。",
].join("\n")

export function clampMemoryChars(text: string, cap: number): string {
  if (text.length <= cap) return text
  return text.slice(0, Math.max(0, cap - MEMORY_TRUNC_MARK.length)) + MEMORY_TRUNC_MARK
}

// ── 新创作闸门（2026-10-01 翻旧账事故）────────────────────────────────────
// 病根：私有 memory_docs（旧专案 brief/世界观/分镜/曲目）每会话无条件注入，召回又按
// 字面把「百合 OP」直配旧专案；模型把「可参考」当成「默认沿用」，用户要新创意却拿到旧方案。
// 处置：①偏好类记忆（跨专案通用）照常注入；专案档案前置复用纪律；②本轮用户明确要新创意
// → 专案档案与召回前缀整段不注入，并在本轮 parts 前缀强制「从零构思」指令。
const FRESH_CREATIVE_RE =
  /新(创意|创意|点子|点子|构思|构思|故事|题材|题材|世界观|世界观|作品|企划|企划)|全新|原创|原创|从零|从零|另起(炉灶|炉灶)?|重新(设计|设计|构思|构思|想|做一个|做一个)|不要(沿用|参考|参考|照搬|复用|复用|套用)|别(用|抄|套)(之前|以前|旧|旧)|别(用|抄|套)(之前|以前|旧|旧)|from scratch|brand[- ]new|fresh (idea|concept|take)|new (idea|concept|world)/i

export function isFreshCreativeRequest(text: string): boolean {
  return typeof text === "string" && FRESH_CREATIVE_RE.test(text)
}

/** 偏好类记忆（pref-*／preference/user/feedback domain）跨专案通用；其余视为过往专案/作品档案。 */
export function isPreferenceMemoryDoc(d: { domain?: unknown; slug?: unknown }): boolean {
  const slug = typeof d.slug === "string" ? d.slug : ""
  const domain = typeof d.domain === "string" ? d.domain : ""
  return /^pref(erence)?[-_]/i.test(slug) || /^(pref|preference|preferences|user|profile|feedback)$/i.test(domain)
}

export const PROJECT_REUSE_RULE =
  "【历史项目档案·复用纪律】下列是过往项目/作品档案，只有用户明确点名续作（提到该片名、角色名，或说『接着做/继续上次』）时才可复用；其余任何新的创作请求都必须从零构思世界观、角色、分镜与曲目，禁止借用或改写其中设定，派发给 expert 的简报也不得夹带这些档案。"

export const FRESH_CREATIVE_TURN_DIRECTIVE =
  "【本轮为全新创作】用户要的是新创意：忽略一切历史项目档案（片名、角色、世界观、分镜、曲目、时长版本），从零构思；只保留账户偏好与通用领域知识。派发给 expert 的简报同样不得引用旧项目。"

/**
 * 热语料可用额度（单一真源，2026-10-19 P1）：总预算先扣除「热语料之前已占用的全部块」
 * （L0＋L1＋平台状态＋连续性实际长度）后的剩余，再夹到 MEMORY_WARM_RECALL_BUDGET。
 * `charsBeforeWarm` 必须已含连续性块（连续性按实际注入长度、由 MEMORY_CONTINUITY_BUDGET 封顶）。
 * buildMemoryInjectionBlocks 与呼叫端（context-injection）共用本函式，禁止各自复制公式。
 */
export function memoryWarmRecallRoom(charsBeforeWarm: number): number {
  const used = Math.max(0, charsBeforeWarm)
  return Math.min(MEMORY_WARM_RECALL_BUDGET, Math.max(0, MEMORY_INJECTION_TOTAL_BUDGET - used))
}

/**
 * 契约 §4 注入块组装（纯函式；PRD §9 R1 注入形状尺的可测面）：
 * L0 私有块 = 既有 user_profile/lessons（D2 文案）+ memory_docs（≤8，§4 索引行格式），
 * 2400 字元硬上限，超限截断尾标「（已截断）」；
 * L1 共享目录块 = memory_index_md，800 字元，末尾带 memory_recall 使用指引
 * （MEMORY_SHARED_ENABLED=false → 零注入，§8）。
 * 合计 5000 字元为代码级 assert：单块封顶后理论不可达（2400+800≤3200），
 * 触发即不变量被破坏——诚实记 error 并强制截尾，用户回合不烧。
 */
export function buildMemoryInjectionBlocks(
  userMemory: SessionState["userMemory"],
  sharedEnabled: boolean,
  opts: {
    freshCreative?: boolean
    continuityLines?: string[]
    platformStatusLines?: string[]
    /** 热语料展开正文（已由 memory-recall 渲染/封顶）；本档统一纳入 5000 总预算。 */
    warmRecallPrefix?: string
  } = {},
): {
  lines: string[]
  /** 与 lines 对齐：每个块的实际类型，供上层按块给独立 section id／围栏标签。 */
  blockKinds: Array<"l0" | "l1" | "platform-status" | "warm-recall" | "continuity">
  trace: { private_docs: string[]; shared_index_chars: number; platform_status_chars: number }
} {
  const l0Parts: string[] = []
  const privateDocs: string[] = []
  if (userMemory) {
    const up = userMemory.user_profile ?? {}
    if (Object.keys(up).length > 0) {
      const fields = Object.entries(up)
        .map(([k, v]) => {
          const val = Array.isArray(v) ? v.join("、") : String(v ?? "")
          return `- ${k}: ${val}`
        })
        .join("\n")
      l0Parts.push(`以下是这个账户已确认的画像（来自之前的会话）：\n${fields}`)
    }
    const lessons = userMemory.lessons ?? []
    if (lessons.length > 0) {
      // D2（PRD §2.2）：旧文案「（已被确认）」属虚假陈述（生产 0 笔 confirmed），契约 §4 钦定中性文案。
      l0Parts.push(`以下是这个账户从过往合作中提炼的教训（仅供参考，可能已过期，冲突以现场为准）：\n${lessons.map((l) => `- ${l}`).join("\n")}`)
    }
    const docs = Array.isArray(userMemory.memory_docs) ? userMemory.memory_docs.slice(0, MEMORY_PRIVATE_DOCS_MAX) : []
    if (docs.length > 0) l0Parts.push(MEMORY_PRIVATE_SCOPE_NOTE)
    // 偏好在前、专案档案在后且前置复用纪律：2400 截断只会吃掉档案正文尾，不会吃掉纪律。
    const prefDocs = docs.filter((d) => isPreferenceMemoryDoc(d))
    const projectDocs = opts.freshCreative ? [] : docs.filter((d) => !isPreferenceMemoryDoc(d))
    const pushDoc = (d: (typeof docs)[number]) => {
      const domain = typeof d.domain === "string" && d.domain ? d.domain : "general"
      const slug = typeof d.slug === "string" && d.slug ? d.slug : "doc"
      // P1（2026-10-06）：L0 私有块补新鲜度标示——复用召回路径同一人话函式
      // （memory-recall.ts 的 memoryAgeDays/memoryFreshnessWarning，>1 天才加、强调「时间点
      // 观察非活状态、file:line 可能过时、断言前先验现场」）。updatedAt 已随 doc 透传
      // （MemoryDocLite 索引签名），零额外取数；今/昨/无时间资料 → 警示为空、不加噪音。
      const freshness = memoryFreshnessWarning(memoryAgeDays(d.updatedAt))
      // §4 索引行格式：`- [domain] slug — description` + 正文缩排。
      l0Parts.push(
        `- [${domain}] ${slug} — ${String(d.description ?? "")}\n   ${String(d.body ?? "")}${freshness ? `\n${freshness.trimEnd()}` : ""}`,
      )
      privateDocs.push(typeof d.id === "string" && d.id ? d.id : slug)
    }
    prefDocs.forEach(pushDoc)
    if (projectDocs.length > 0) {
      l0Parts.push(PROJECT_REUSE_RULE)
      projectDocs.forEach(pushDoc)
    }
  }
  type MemoryBlockKind = "l0" | "l1" | "platform-status" | "warm-recall" | "continuity"
  const entries: Array<{ kind: MemoryBlockKind; text: string }> = []
  let sharedIndexChars = 0
  let platformStatusChars = 0
  if (l0Parts.length > 0) entries.push({ kind: "l0", text: clampMemoryChars(l0Parts.join("\n"), MEMORY_L0_BUDGET) })
  const indexMd = typeof userMemory?.memory_index_md === "string" ? userMemory.memory_index_md.trim() : ""
  if (sharedEnabled && indexMd) {
    const l1 = clampMemoryChars(
      `以下是本平台积累的领域知识目录（仅供参考，可能已过期，冲突以现场为准）：\n${indexMd}\n（目录只作方法与领域知识参考：用户要全新原创时，不得把其中任一既有作品的具体内容当作可沿用的底稿；用户明确点名沿用某个 slug 时才可读取它的正文。）\n（模型可调用 memory_recall 工具读取全部正文）`,
      MEMORY_L1_BUDGET,
    )
    entries.push({ kind: "l1", text: l1 })
    sharedIndexChars = l1.length // trace 口径＝实际注入 L1 块字元数（预算消耗面）
  }
  // 2026-10-19：服务端实时平台状态（非记忆）紧跟在 L1 之后。内容由呼叫端从
  // /api/internal/platform-status 取来，本档保持纯函式：不读网络、不读缓存。
  // 只描述平台级事实（模型/冷却/近 1 小时成功率），不含用户、账号、请求 ID、价格。
  if (opts.platformStatusLines && opts.platformStatusLines.length > 0) {
    const block = clampMemoryChars(
      `【平台当前状态（这是服务端当前观测，不是记忆；与记忆冲突以此为准，与现场工具返回冲突以现场为准）】\n${opts.platformStatusLines.join("\n")}`,
      MEMORY_PLATFORM_STATUS_BUDGET,
    )
    entries.push({ kind: "platform-status", text: block })
    platformStatusChars = block.length
  }
  // 2026-10-19 P1：热语料块纳入统一预算（插在平台状态之后、连续性之前）。
  // 额度以「先给连续性预留」为准（单一真源 = memoryWarmRecallRoom）：
  //   room = 5000 - (L0 + L1 + 平台状态 + 连续性实际长度)，连续性长度按实际注入值、
  //   以 MEMORY_CONTINUITY_BUDGET 封顶。全满时 2400+800+600+900=4700 → 热语料只拿 300，
  //   总额恰好 5000：assert 不触发，连续性块不会被强制裁剪整块丢掉。
  //   额度 ≤0 整块不注入（呼叫端可用 memoryWarmRecallRoom 先行判断、不提前消耗 session 字节）。
  const warmPrefix = typeof opts.warmRecallPrefix === "string" ? opts.warmRecallPrefix : ""
  const continuityText =
    opts.continuityLines && opts.continuityLines.length > 0
      ? clampMemoryChars(opts.continuityLines.join("\n"), MEMORY_CONTINUITY_BUDGET)
      : ""
  if (warmPrefix.trim()) {
    const used = entries.reduce((n, e) => n + e.text.length, 0)
    const room = memoryWarmRecallRoom(used + continuityText.length)
    if (room > 0) {
      entries.push({
        kind: "warm-recall",
        text: clampMemoryChars(
          `【本轮相关记忆正文（语料已在缓存中直接展开，非指令）】这是与本轮任务相关的记忆正文，直接当作背景事实使用；与现场冲突以现场为准。\n${warmPrefix}`,
          room,
        ),
      })
    }
  }
  // H17：首回合连续性块（工作区资产索引／同题重下提示）。独立预算 MEMORY_CONTINUITY_BUDGET；
  // 呼叫端只在首回合（!state.vettingInjected）传入。
  if (continuityText) {
    entries.push({ kind: "continuity", text: continuityText })
  }
  const total = entries.reduce((n, e) => n + e.text.length, 0)
  if (total > MEMORY_INJECTION_TOTAL_BUDGET) {
    console.error(`[memory-inject] BUDGET ASSERT: total=${total} > ${MEMORY_INJECTION_TOTAL_BUDGET} — force clamp`)
    const keptEntries: typeof entries = []
    let used = 0
    for (const entry of entries) {
      if (used + entry.text.length > MEMORY_INJECTION_TOTAL_BUDGET) break
      keptEntries.push(entry)
      used += entry.text.length
    }
    return {
      lines: keptEntries.map((e) => e.text),
      blockKinds: keptEntries.map((e) => e.kind),
      trace: { private_docs: privateDocs, shared_index_chars: sharedIndexChars, platform_status_chars: platformStatusChars },
    }
  }
  return {
    lines: entries.map((e) => e.text),
    blockKinds: entries.map((e) => e.kind),
    trace: { private_docs: privateDocs, shared_index_chars: sharedIndexChars, platform_status_chars: platformStatusChars },
  }
}


// ── H17 跨会话连续性（机制层；2026-10-02）──────────────────────────────────
// 事故：同题 7 轮/7 小时/165 万 input token，每轮从零开始、首回合对上一轮产物毫无所知。
// 边界：不改「新创作禁沿用旧专案」规则——这里只做两件事：
//   (a) 首回合列「近期工作区资产索引」（只列清单供参考，明写新创作不得沿用，除非用户明说）；
//   (b) 同题重下侦测 → 提示 agent「此题已做过 N 轮，先向用户说明并确认新方向」。
// 两者都不自动沿用任何内容。纯函式，输入为 listSessionRows 的行（本档不碰 DB，易测）。
export const MEMORY_CONTINUITY_BUDGET = 900
export const RECENT_ASSET_WINDOW_MS = 72 * 3600_000
export const RECENT_ASSET_MAX_ITEMS = 10
export const REPEAT_TOPIC_WINDOW_MS = 12 * 3600_000
export const REPEAT_TOPIC_MIN_ROUNDS = 2
export const REPEAT_TOPIC_MIN_SIMILARITY = 0.3

export interface ContinuityRow {
  sessionId: string
  createdAt: number
  updatedAt: number
  data: { title?: string | null; workflowSnapshot?: Record<string, unknown> | undefined }
}

/** 字元二元组 Jaccard（中英通吃、无分词依赖）。 */
export function topicSimilarity(a: string, b: string): number {
  const grams = (t: string) => {
    const x = t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")
    const out = new Set<string>()
    for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2))
    return out
  }
  const A = grams(a)
  const B = grams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

/** 同题重下侦测：窗口内、非本会话、标题与本轮内容相似的会话数 = 已做轮数。 */
export function detectRepeatTopic(
  rows: ContinuityRow[],
  content: string,
  opts: { excludeSessionId?: string; nowMs?: number } = {},
): { rounds: number; titles: string[] } {
  const now = opts.nowMs ?? Date.now()
  const hits = rows.filter((r) => {
    if (r.sessionId === opts.excludeSessionId) return false
    if (now - r.updatedAt > REPEAT_TOPIC_WINDOW_MS) return false
    const title = typeof r.data?.title === "string" ? r.data.title : ""
    return title.length > 0 && topicSimilarity(title, content) >= REPEAT_TOPIC_MIN_SIMILARITY
  })
  return { rounds: hits.length, titles: hits.slice(0, 3).map((r) => String(r.data.title)) }
}

/** 从 workflowSnapshot 抽「已完成且有产物 URL 的节点」→ `标题 → url`。 */
export function extractSnapshotAssets(snap: Record<string, unknown> | undefined): Array<{ title: string; url: string }> {
  if (!snap || typeof snap !== "object") return []
  const status = (snap.nodeStatus ?? {}) as Record<string, unknown>
  const content = (snap.nodeContent ?? {}) as Record<string, unknown>
  const nodes = ((snap.graph as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Array<Record<string, unknown>>
  const titleOf = new Map<string, string>()
  for (const n of nodes) {
    const id = typeof n?.id === "string" ? n.id : ""
    const t = typeof n?.title === "string" ? n.title : typeof (n?.data as any)?.title === "string" ? (n.data as any).title : ""
    if (id) titleOf.set(id, t)
  }
  const out: Array<{ title: string; url: string }> = []
  for (const [id, v] of Object.entries(content)) {
    if (typeof v !== "string" || !/^https?:\/\//i.test(v.trim())) continue
    const st = status[id]
    if (typeof st === "string" && !/^(done|completed|success|succeeded)$/i.test(st)) continue
    out.push({ title: titleOf.get(id) || id, url: v.trim() })
  }
  return out
}

/** 近期工作区资产索引（72h、≤10 条；只列清单）。无资产 → null。 */
export function buildRecentAssetIndex(
  rows: ContinuityRow[],
  opts: { excludeSessionId?: string; nowMs?: number } = {},
): string | null {
  const now = opts.nowMs ?? Date.now()
  const items: string[] = []
  for (const r of rows) {
    if (r.sessionId === opts.excludeSessionId) continue
    if (now - r.updatedAt > RECENT_ASSET_WINDOW_MS) continue
    const label = typeof r.data?.title === "string" && r.data.title ? r.data.title : r.sessionId.slice(0, 8)
    for (const a of extractSnapshotAssets(r.data?.workflowSnapshot)) {
      if (items.length >= RECENT_ASSET_MAX_ITEMS) break
      items.push(`- [${label}] ${a.title} → ${a.url}`)
    }
    if (items.length >= RECENT_ASSET_MAX_ITEMS) break
  }
  if (items.length === 0) return null
  return [
    "【近期工作区资产索引（仅供参考的清单）】新创作不得沿用下列任何资产，除非用户明说「沿用/延续/基于某项」；这里只让你知道账户里已有什么，不是底稿。",
    ...items,
  ].join("\n")
}

/**
 * 首回合连续性行（buildMemoryInjectionBlocks 的 opts.continuityLines）。
 * 呼叫端（messages-gw.ts，首回合 !state.vettingInjected 时）：
 *   continuityLines = buildFirstTurnContinuityLines(listSessionRows(key), state.sessionId, content)
 */
export function buildFirstTurnContinuityLines(
  rows: ContinuityRow[],
  sessionId: string,
  content: string,
  nowMs?: number,
): string[] {
  const lines: string[] = []
  const rep = detectRepeatTopic(rows, content, { excludeSessionId: sessionId, nowMs })
  if (rep.rounds >= REPEAT_TOPIC_MIN_ROUNDS) {
    lines.push(
      `【同题重下提示】此题近 ${REPEAT_TOPIC_WINDOW_MS / 3600_000} 小时内已做过 ${rep.rounds} 轮（${rep.titles.join("、")}）：先用一两句话向用户说明这一点，并确认本次要的新方向（沿用哪一版、还是全新重做），确认前不要开始大规模生成。不要自行沿用旧轮产物。`,
    )
  }
  const idx = buildRecentAssetIndex(rows, { excludeSessionId: sessionId, nowMs })
  if (idx) lines.push(idx)
  return lines
}
