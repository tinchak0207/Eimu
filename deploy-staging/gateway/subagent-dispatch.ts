import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { guardExpertContent, musicFirstBlockReason, lyricsFirstBlockReason, albumPhaseBlockReason, albumReviewBlockReason, isMusicWorkVerdict, isLyricistWorkVerdict, isReviewWorkVerdict, lyricsUpstreamBlockReason, isReworkSpec, reworkLockDirective, quarantineSpec, routeExpertAuthoritative, syncDispatchEligible, classifyDispatchMeta, classifyDispatchGuards, workflowTemplateDirective, isPlanOnlyNoGenerationIntent, consumesResearchVerdict, renderResearchInjection, type ResearchInjectItem, JevDispatchGuards } from "./jev-gate"
import { workflowService, workflowOwnerBySession } from "./workflow-gw"
import { templatePlaceholderContent } from "./workflow-templates"
import { notify } from "./internal-waiters.ts"
import { registerTeamMember, removeTeamMember } from "./agent-mailbox.ts"
import { isMultiStepAvProductionIntent } from "./canvas-write-gate.ts"
import { saveDelivery, loadSessionDeliveries } from "./persistence"
import { FORK_STARTED_NOTICE, validateSubagentName, forkNameFromLabel, normalizeEffort, subagentMaxDepth, agentNestingDepth, depthLimitMessage, parseSubagentModel } from "./subagent-policy.ts"
import type { SubagentModelRef, SubagentCheckpoint, SubagentRun, ResearchPredecessor } from "./subagent-types.ts"
import { SPEC_DEADLINE_LINE, MAX_ACTIVE_PER_PARENT, HARD_TIMEOUT_MS, ASYNC_HARD_TIMEOUT_MS, SUBAGENT_OUTPUT_REL, SUBAGENT_OUTPUT_DIR, SUBAGENT_CHECKPOINTS_DIR, safeCheckpointToken, resolveCheckpointFile, PERSIST_TAIL, SUBAGENT_BUSY_MESSAGE, parseSyncDeadlineMs, partialBodyOf, RESEARCH_PRECEDED_EXPERTS, readJsonObject } from "./subagent-types.ts"
import { fireSubagentHook, deps, byParent, byChildOc, completed, criticDispatchedByParent, deliveredByParent, resolveParentSession, unknownSessionResponse, boundMap } from "./subagent-runs.ts"
import { finishRun, armHeartbeat } from "./subagent-finish.ts"
import { persistRunOutput } from "./subagent-liveness.ts"
import { dispatchAttempt } from "./subagent-attempt.ts"
import { subagentChildSlug, buildSiblingRosterFact, ensureTranscript } from "./subagent-live.ts"
import { parentOwnsRunId } from "./subagent-messages.ts"
// C1（2026-10-21）：席位能力预检——任务书点名了该席位未启用的工具时，派工当刻就把
// 提示写回 orchestrator（原先 editor 无 image_generate 仍先派工、跑 10 分钟才 BLOCKED）。
import { checkSeatTools, formatSeatPreflightNotice, loadSeatToolTable, type SeatToolCheck } from "./seat-preflight.ts"

function readCompletedPredecessor(record: ResearchPredecessor): string | null {
  if (!record.relPath.startsWith(`${SUBAGENT_OUTPUT_REL}/`)) return null
  const file = record.relPath.slice(SUBAGENT_OUTPUT_REL.length + 1)
  if (file.includes("/") || file.includes("\\") || !file.startsWith(`${record.runId}-`)) return null
  try {
    const stored = readFileSync(join(SUBAGENT_OUTPUT_DIR, file), "utf8")
    if (!stored.includes(`- runId: \`${record.runId}\`\n`) || !stored.includes("- 状态: ok\n")) return null
    const body = stored.split("- 内容: 子代理最后一条 assistant 文本全文\n")[1]?.split(`\n\n---\n\n${PERSIST_TAIL}`)[0] ?? ""
    return body.trim() ? body : null
  } catch { return null }
}

/**
 * 2026-10-24（二审重写）：守卫判定的短路缓存。
 *
 * 为什么不再用词表预筛：上一版 MEDIA_CREATIVE_RE 对真实任务书 12/12 漏判（「做十首关于
 * 夏天的东西」「按周杰伦早期的风格出十首」「做一个完整的双面作品」全部 MISS），而词表本身
 * 又决定不了拦截语义——它只会让该问的问题没问出去。判定权因此整段交回 Jev：域判定题
 * （isLyricistWork/isMusicWork/isReviewWork）与工序题同批一次 POST，阈值与 fail-open
 * 语义都在 jev-gate 里，本档不再持有任何写着词/谱曲/媒体域的词表。
 *
 * 为什么每次派遣都付得起这次呼叫：
 * - 单次调用只发一次 POST，七题同批，加题不加延迟；
 * - `JEV_TIMEOUT_MS=2000`（jev-gate.ts:26），最坏 2 秒；
 * - `JEV_ENABLED !== "true"` 或无 key → jevUpstream 直接 return null，零网络延迟；
 * - 并发上限 MAX_ACTIVE_PER_PARENT=3，最多 3 路各一次呼叫。
 *
 * 缓存：同父会话 + 同 label + 整份任务书，TTL 60 秒。orchestrator 被 409 挡下后的重派、
 * 同一份任务书重试，都不必再付一次钱；过期即失效，避免把旧判定套到改过的任务书上。
 * 缓存放呼叫点，jev-gate 的判定函数保持纯函数性。
 *
 * 2026-10-24 修碰撞：旧键只哈希 prompt 前 4000 字——模板化任务书（同一张 spec 模板 +
 * 不同的「第 N 首/角色 A」）前 4000 字逐字相同，两张不同任务书共用一次判定，第 N 首
 * 会拿到第 1 首的「是否写词/是否谱曲」。现在哈希整份 prompt（≤20000 字全量；超长取
 * 首 10000 + 尾 10000 + 长度），并把 label 一并入键。
 */
const GUARD_CACHE_TTL_MS = 60_000
const GUARD_CACHE_MAX_ENTRIES = 2000
const guardCache = new Map<string, { at: number; guards: JevDispatchGuards }>()

function guardCacheKey(parentSessionId: string, label: string, prompt: string): string {
  // FNV-1a 32 位：只求短且稳定，不追求抗碰撞（碰撞最坏＝复用一次同父 60 秒内的判定，
  // 且键里已带父会话 id 与 label）。任务书超长时首尾各取 10000 字，避免只改中间却撞键。
  const full = prompt ?? ""
  const text = full.length <= 20000 ? full : `${full.slice(0, 10000)}\u0000${full.slice(-10000)}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  let labelHash = 0x811c9dc5
  for (let i = 0; i < (label ?? "").length; i++) {
    labelHash ^= (label ?? "").charCodeAt(i)
    labelHash = Math.imul(labelHash, 0x01000193) >>> 0
  }
  return `${parentSessionId}:${labelHash.toString(16)}:${full.length}:${hash.toString(16)}`
}

async function classifyDispatchGuardsCached(parentSessionId: string, label: string, prompt: string): Promise<JevDispatchGuards> {
  const key = guardCacheKey(parentSessionId, label, prompt)
  const hit = guardCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at <= GUARD_CACHE_TTL_MS) return hit.guards
  const guards = await classifyDispatchGuards(prompt)
  // 顺手清过期项，并给上限兜底（父会话多、任务书各不相同也不让本 Map 无界增长）。
  for (const [k, v] of guardCache) if (now - v.at > GUARD_CACHE_TTL_MS) guardCache.delete(k)
  while (guardCache.size >= GUARD_CACHE_MAX_ENTRIES) {
    const oldest = guardCache.keys().next()
    if (oldest.done) break
    guardCache.delete(oldest.value)
  }
  guardCache.set(key, { at: now, guards })
  return guards
}

/** 专辑范围判据的近窗回退（见调用点 inAlbum）。10 分钟≈一次专辑策划到作词的正常跨度。 */
const ALBUM_DELIVERY_WINDOW_MS = 10 * 60 * 1000

/**
 * 交付簿快照（2026-10-24 二审修 P2「重启即丢」）。
 *
 * 为什么要在调用点合并两源：进程内 `deliveredByParent` 是内存 Map，重启即丢；而
 * subagent-finish 早已把每一笔 ok 交付同步写进 SQLite `deliveries` 表。只读内存时，
 * 一次发布重启就能让「专辑已有词/曲」归零——随后要么误拦谱曲/评审，要么让评审对空簿
 * 静默放行。两源合并、按 relPath 去重，内存记录优先（它带 turnGen/at，判据更准）。
 * 回灌记录没有 turnGen：inAlbum 自然退到近窗判据，这是已知的精度边界，写在这里而不是藏起来。
 */
type DeliveryRow = { agent: string; label: string; relPath: string; contractOk?: boolean; at?: number; turnGen?: number }

function deliveryBook(parentSessionId: string): DeliveryRow[] {
  const mem = deliveredByParent.get(parentSessionId) ?? []
  let persisted: DeliveryRow[] = []
  try {
    const hydrated = loadSessionDeliveries(parentSessionId)
    // 本次进程起来之后的持久记录已在内存里（带 turnGen），只回灌更早的；at 留空＝走近窗判据。
    const seen = new Set(mem.map((d) => d.relPath).filter(Boolean))
    persisted = hydrated
      .filter((r) => r.relPath && !seen.has(r.relPath))
      .map((r) => ({ agent: r.agent, label: r.label, relPath: r.relPath }))
  } catch {
    persisted = []
  }
  return [...persisted, ...mem]
}

/**
 * 跨专辑候选歌词的正文开头（前 80 字，供 music 自己认领）。
 * 路径一律走与 readCompletedPredecessor 相同的白名单：必须是子代理产物目录下的
 * `{runId}-*.md`，防止交付簿里的任意路径被当成本机文件读进任务书。
 */
function deliveryHead(relPath: string): string {
  if (!relPath.startsWith(`${SUBAGENT_OUTPUT_REL}/`)) return ""
  const file = relPath.slice(SUBAGENT_OUTPUT_REL.length + 1)
  if (file.includes("/") || file.includes("\\")) return ""
  try {
    const stored = readFileSync(join(SUBAGENT_OUTPUT_DIR, file), "utf8")
    const body = stored.split("- 内容: 子代理最后一条 assistant 文本全文\n")[1]?.split(`\n\n---\n\n${PERSIST_TAIL}`)[0] ?? stored
    const flat = body.replace(/\s+/g, " ").trim()
    return flat ? flat.slice(0, 80) : ""
  } catch {
    return ""
  }
}

async function researchPredecessors(parent: any): Promise<{ records: ResearchPredecessor[]; available: boolean }> {
  const records = loadSessionDeliveries(parent.sessionId).filter((r) => readCompletedPredecessor(r) !== null)
  if (records.filter((r) => r.agent === "research").length >= MAX_ACTIVE_PER_PARENT || records.some((r) => RESEARCH_PRECEDED_EXPERTS.includes(r.agent))) return { records, available: true }
  // 旧通用研究没有D7交付行：仅从同父OpenCode真实dispatch工具返回绑定runId，
  // 再读该run的完整终态产物。用户正文/自称路径/URL/派遣ok均不能提供完成证据。
  try {
    const res = await fetch(`${deps!.openCodeUrl}/session/${parent.opencodeSessionId}/message`, { headers: deps!.openCodeHeaders(), signal: AbortSignal.timeout(10000) })
    if (!res.ok) return { records, available: false }
    const msgs = await res.json()
    if (!Array.isArray(msgs)) return { records, available: false }
    const files = readdirSync(SUBAGENT_OUTPUT_DIR)
    for (const m of msgs) {
      if (m.info?.role !== "assistant") continue
      for (const p of m.parts ?? []) {
        if (p.type !== "tool" || p.tool !== "subagent_dispatch" || p.state?.status !== "completed") continue
        let out: any
        try { out = typeof p.state.output === "string" ? JSON.parse(p.state.output) : p.state.output } catch { continue }
        const runId = out?.subagent_id
        if (typeof runId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId) || records.some((r) => r.runId === runId)) continue
        const file = files.find((f) => f.startsWith(`${runId}-`) && f.endsWith(".md"))
        if (!file) continue
        const input = p.state.input
        if (!input || typeof input.prompt !== "string") continue
        const record = { runId, agent: typeof input.expert === "string" ? input.expert : "", label: String(out.label ?? input.label ?? ""), relPath: `${SUBAGENT_OUTPUT_REL}/${file}` }
        if (readCompletedPredecessor(record) === null) continue
        if (!record.agent && (await classifyDispatchGuardsCached(parent.sessionId, String(input.label ?? ""), input.prompt)).research === true) record.agent = "research"
        if (record.agent !== "research" && !RESEARCH_PRECEDED_EXPERTS.includes(record.agent)) continue
        records.push(record)
        saveDelivery({ sessionId: parent.sessionId, ...record })
      }
    }
    return { records, available: true }
  } catch { return { records, available: false } }
}

/**
 * 2026-10-24：收集本会话**已交付研究正文**，准备注入下游任务书。
 *
 * 为什么不能只给路径：`subagent-live.ts` 的兄弟名册只列 path/label/status，子代理
 * 不知道「哪一份是它该读的研究」，也不知道读了要不要照办。过去三轮都在加「拦谁」，
 * 而用户诉求是「下游要拿到上游结论」——拦是手段，交付才是目的。
 *
 * 证据口径与 research_first 完全一致：只认 `agent === "research"` 且
 * `readCompletedPredecessor` 读到正文的记录（目录白名单、runId 前缀、状态 ok 三关）。
 * 只有链接堆（每行都是 URL）的「研究」不算研究，不注入。
 *
 * 探测失败（available=false）时**不阻断**：注入是增值，不是闸门；这里只留一行 log，
 * 由 research_first 那条闸（若被触发）自己决定是否 503。
 * 返回 null ＝ 没有任何可用研究正文（调用点据此零注入，输出与注入前逐字等价）。
 */
async function buildResearchInjection(parent: any, label: string): Promise<ResearchInjectItem[] | null> {
  let prior: { records: ResearchPredecessor[]; available: boolean }
  try {
    prior = await researchPredecessors(parent)
  } catch (e) {
    console.log(`[gateway] research injection skipped (predecessor lookup failed): label="${label}" ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  const rows = prior.records.filter((r) => r.agent === "research")
  if (!rows.length) {
    if (!prior.available) console.log(`[gateway] research injection: none (evidence unavailable) label="${label}"`)
    return null
  }
  const items: ResearchInjectItem[] = []
  for (const r of rows) {
    const body = readCompletedPredecessor(r)
    if (!body) continue
    // 只有 URL 堆的「研究」不注入（与 research_first 的有效研究判据同口径）。
    const hasProse = body.split("\n").some((line) => line.trim() && !/^\s*(?:[-*]\s*)?(?:https?:\/\/\S+|\[[^\]]*\]\(https?:\/\/[^)]+\))\s*$/.test(line))
    if (!hasProse) continue
    // 研究正文可能含网页摘录＝间接注入通道：逐份过既有 quarantineSpec 拿机器判定。
    let quarantineHits: string[] = []
    try {
      const q = await quarantineSpec(`research:${r.runId}`, body)
      if (q) quarantineHits = [q.slice(0, 80)]
    } catch {
      quarantineHits = []
    }
    items.push({ label: r.label, path: r.relPath, body, at: deliveryAt(parent.sessionId, r.relPath), quarantineHits })
  }
  return items.length ? items : null
}

/**
 * 该交付的完成时刻（「最近完成优先」排序用）。
 * 交付簿两源：内存记录带 at（判据最准）；SQLite 回灌只有 relPath，此时退回产物档
 * 修改时间——两者都拿不到就排最旧（不猜时间）。
 */
function deliveryAt(parentSessionId: string, relPath: string): number | undefined {
  const mem = (deliveredByParent.get(parentSessionId) ?? []).find((d) => d.relPath === relPath)
  if (typeof mem?.at === "number") return mem.at
  if (!relPath.startsWith(`${SUBAGENT_OUTPUT_REL}/`)) return undefined
  const file = relPath.slice(SUBAGENT_OUTPUT_REL.length + 1)
  if (file.includes("/") || file.includes("\\")) return undefined
  try {
    return statSync(join(SUBAGENT_OUTPUT_DIR, file)).mtimeMs
  } catch {
    return undefined
  }
}

export async function handleSubagentDispatch(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  const body = (await readJsonObject(req)) as {
    sessionId?: string
    label?: string
    prompt?: string
    async?: boolean
    expert?: string
    from_checkpoint_run_id?: string
    from_checkpoint_id?: string
    // CC 2.1.302 移植：fork / model / effort / name（isolation 从未生效，已删除）。
    fork?: boolean
    subagent_type?: string
    model?: string
    effort?: string
    name?: string
  }
  const label = typeof body.label === "string" ? body.label.trim() : ""
  // `fork:true` 与 `subagent_type:"fork"` 等价（照 CC Agent schema 的 subagent_type）。
  const isFork = body.fork === true || body.subagent_type === "fork"
  // P2b 刀1：prompt 需可被自动补行改写。
  let prompt = typeof body.prompt === "string" ? body.prompt : ""
  // C1（2026-10-21）席位能力预检的输入＝**原始任务书**。后面对 prompt 的机器注入
  // （死线行/隔离声明/军团模板/名册）不是 orchestrator 的要求，不能算「任务书点名工具」，
  // 故先在改写前留一份原样，预检只读它。
  const taskText = prompt
  if (!body.sessionId || !label || !prompt) {
    // D2（2026-10-02）：空字串错误码是反模式（历史 717 次）——失败一律带 code 与缺哪栏。
    const missing = [!body.sessionId ? "sessionId" : "", !label ? "label" : "", !prompt ? "prompt" : ""].filter(Boolean)
    return Response.json(
      { ok: false, code: "missing_required_args", error: `sessionId/label/prompt 均为必填；缺少：${missing.join("、")}`, missing },
      { status: 400 },
    )
  }
  // P2b 刀1：首行自动补死线行。已写「预期/预期 N」= 原样不动（避免双补）。
  // 字符集与 R1 parseSyncDeadlineMs 对齐（简/繁皆认），确保不重复补。
  // fork 是一次性执行指令（d7e），不补同步死线行。
  if (!isFork && !/^\s*[预预]\s*期\s*\d/.test(prompt)) {
    prompt = SPEC_DEADLINE_LINE + prompt
  }
  // X7/Y4（2026-10-14）深度上限：**派工前**查派工者的 childPath 深度。派工者是子代理时，
  // body.sessionId 是它的子 opencode 会话 id（byChildOc 能命中）。超限拒绝派工并如实回报
  // ——本轮只约束、不做多级路由（Codex exceeds_thread_spawn_depth_limit 同旨）。
  // CC 2.1.302 移植：默认 3（env SUBAGENT_MAX_DEPTH 覆写），文案照「Subagent nesting
  // limit reached (depth N of M)」；depth 为**派工者**的嵌套深度（main=0）。
  const requesterRun = byChildOc.get(body.sessionId)
  // CC 2.1.302 xn：fork 的可用性闸——编排/coordinator 模式不得 fork（main 会话即编排者），
  // fork 内不得再 fork（d7e 同一禁令的机器兜底），fork 不得 remote（远程会话无法继承历史）。
  // fork worker 禁止任何形式的再派工，不能把 fork:false 当作绕过入口。
  if (requesterRun?.isFork === true) {
    return Response.json(
      { ok: false, code: "fork_recursive_fork", error: "Forked workers cannot spawn subagents. Complete your task directly using your tools." },
      { status: 409 },
    )
  }
  if (isFork) {
    if (!requesterRun) {
      return Response.json(
        {
          ok: false,
          code: "fork_coordinator_mode",
          error: "Fork is not available in coordinator/orchestration mode. 主会话请派遣具名 worker；fork 只能由正在执行的子代理对自己的会话发起。",
        },
        { status: 409 },
      )
    }
  }
  if (requesterRun) {
    const depth = agentNestingDepth(requesterRun.childPath)
    const limit = subagentMaxDepth()
    if (depth >= limit) {
      console.log(
        `[gateway] subagent dispatch denied (depth ${depth} >= limit ${limit}): path=${requesterRun.childPath} label="${label}"`,
      )
      return Response.json(
        {
          ok: false,
          code: "depth_limit",
          error: depthLimitMessage(depth, limit),
          depth,
          limit,
          child_path: requesterRun.childPath,
        },
        { status: 409 },
      )
    }
  }
  // S4（FIX-G2）：session_id 必须解析到真实会话（gateway 会话／已知子代理会话）才放行——
  // 不认的 id 一律 404 unknown_session，不再把原始字符串当父键。已知子代理会话放行⇒子代理
  // 可用自己的 oc id 派孙代理（此前只认 resolveSession ⇒ 孙代理派工必 404）。
  const parent = resolveParentSession(body.sessionId)
  if (!parent) return unknownSessionResponse(body.sessionId)
  // CC 2.1.302 name：可达 64 字符；main/team-lead/user/system 保留；agent-id 形状拒绝。
  // fork 未给 name 时按 label 生成（照 aYt 的 `_`：前 3 词、≤24 字）。
  const nameCheck = validateSubagentName(body.name)
  if (nameCheck.ok !== true) {
    return Response.json({ ok: false, code: "invalid_name", error: nameCheck.error }, { status: 400 })
  }
  // P2（2026-10-18）：自动名同样必须过 validateSubagentName——label「latest/main/team lead」
  // 派生出的 `latest`/`main`/`team-lead` 是保留名，旧实现直接放行＝绕过保留名。不合法回退 "fork"。
  const autoForkName = nameCheck.name === undefined && isFork
  let requestedName = nameCheck.name
  if (autoForkName) {
    const derived = validateSubagentName(forkNameFromLabel(label))
    requestedName = derived.ok && derived.name ? derived.name : "fork"
  }
  // CC 2.1.302 后台默认（m0626 @5633 的 yo 公式）：agents run in the background by default。
  // 只有显式 async:false（且 Jev 判「下一步必须依赖结果」的快速事实查询）才同步；fork 恒后台
  // （aYt 的 isAsync:true）。并发上限仍由下方同一闸门控制，不变。
  let asyncMode = typeof deps.wakeParent === "function" && (isFork || body.async !== false)
  // 用户显式要求同步（async:false）但被 Jev 闸门强制转后台时置真：异步回执必须带上
  // sync_downgraded 与不可忽略的降级说明，避免模型对用户声称「同步等待」。
  let syncDowngraded = false
  if (!isFork && typeof deps.wakeParent === "function" && body.async === false) {
    const eligible = await syncDispatchEligible(prompt)
    if (eligible === false) {
      asyncMode = true
      syncDowngraded = true
      console.log(`[gateway] jev_gate: SYNC_DOWNGRADED label="${label}" (not a quick fact lookup, forced async)`)
    }
  }

  // R8 修复片2（2026-09-10）＋刀3 权威化（2026-09-19）：Expert 路由。
  // 仅 beast_mode ON 时生效（OFF 时 expert 静默丢弃 = 零 OFF 回归）。
  // 刀3 教义（2026-09-19 立、2026-10-02 暴君修正）：「派谁」不是 LLM 的决策——
  //   ① expert 栏可省略：省略时 Jev 选域（高信心才派，否则通用子代理）；
  //   ② LLM 点名 expert＝最终裁决：Jev 高信心不同意只记 ROUTE_DISSENT，不改派
  //     （原 ROUTE_OVERRIDE 已废除——曾把点名 video-director 的预览转存强改派
  //     editor，改派后域内无鉴权工具全 401；表面词汇无法反映工具持有面）；
  //   ③ Jev 挂 → fail-open 用点名值（行为＝部署前）。
  // 白名单校验照旧（Jev 建议也过 expert-ids.json；域外/未知 → 拒绝 400）。
  let expertId = ""
  // 2026-10-05 / 2026-10-24（二审重写）：派遣守卫的语义判定（研究与否／是否返工／
  // 依赖 music 与否／专辑工序／写词与谱曲域／评审域）一次批次问 Jev。
  // 调用条件＝`!isFork`：不再看 beast_mode，也不再用词表预筛。理由是词表那一层本身
  // 在制造漏判（12/12 MISS），而这次呼叫的实际成本已经核算过（见 classifyDispatchGuardsCached
  // 上方注释：单次 POST 七题同批、2s 超时、未启用零延迟、并发 ≤3、60 秒缓存）。
  // **零回归保证**：Jev 未启用/挂掉 ⇒ dispatchGuards 全 null ⇒ 各闸要求 === true 才拦，
  // null 恒放行，行为与改动前逐字等价。
  let dispatchGuards: JevDispatchGuards = {
    research: null,
    rework: null,
    musicDependency: null,
    lyricsDependency: null,
    albumDependency: null,
    lyricsUpstream: null,
    isLyricistWork: null,
    isMusicWork: null,
    isReviewWork: null,
  }
  const beastOn = deps.beastMode(parent)
  // 2026-10-24 修 P0（expertId 求值晚于使用）：原始点名值必须**在任何 verdict 之前**算出。
  // 旧实现里三个 *Verdict 在 expertId 仍是 "" 时求值，点名覆盖分支只有在野兽模式路由
  // 分支跑过之后（几十行以后）才有值 ⇒ OFF 下恒等于「没点名」，覆盖语义是死码。
  // 点名值以 body 原样为准，路由后的 expertId 只用于席位/工具面，不参与「这是不是写词」。
  const rawExpert = typeof body.expert === "string" ? body.expert.trim() : ""
  if (!isFork) {
    dispatchGuards = await classifyDispatchGuardsCached(parent.sessionId, label, prompt)
  }
  // 域判定（Jev 题 + 点名覆盖，见 jev-gate 的 isMusicWorkVerdict 等纯函数）。
  // P0 修复（2026-10-24 二审）：这里曾经把「写词在途」与「music 在途」两个值混用，
  // 导致专辑闸把「music 已经在跑」当成「词作者在跑」，合法并行谱曲被误拦。
  // 现在三个旗标各取自各自语义，下面每道门只读自己那一份。
  const isMusicWork = isMusicWorkVerdict(rawExpert, dispatchGuards.isMusicWork)
  const isLyricistWork = isLyricistWorkVerdict(rawExpert, dispatchGuards.isLyricistWork)
  const isReviewWork = isReviewWorkVerdict(rawExpert, dispatchGuards.isReviewWork)
  // 2026-10-24：本任务的素材是否必须建立在先前研究成果之上（决定是否注入研究正文、
  // 是否在本会话有研究在途时拦下）。点名为准 + Jev 判，零词表。
  const consumesResearch = !isFork && consumesResearchVerdict(rawExpert, dispatchGuards.consumesResearch)
  // B（2026-10-24）：本专辑范围内的交付判据。交付簿跨轮累积，「上一轮的歌还在簿里」
  // 会让新专辑还没出曲就放行评审。收窄口径＝**本 turnGen**（同一轮内完成的研究/作词/
  // 谱曲才算本专辑的实体）；turnGen 取不到或子代理跨轮完成（异步 run 落在下一轮）时，
  // 回退「近 N 分钟」。产物形如：{agent,label,relPath,contractOk,at,turnGen}。
  const deliveryRows = deliveryBook(parent.sessionId)
  const inAlbum = (d: DeliveryRow) => {
    const gen = parent.turnGen
    if (typeof gen === "number" && typeof d.turnGen === "number") return d.turnGen === gen
    return typeof d.at === "number" && Date.now() - d.at <= ALBUM_DELIVERY_WINDOW_MS
  }
  // 上一行是按内存交付簿算的；本条补上**持久簿回灌**（见上方「重启即丢」注释）：
  // 只有 relPath 的持久记录没有 at，上面的近窗判据恒 false ⇒ 重启后「本专辑已有词」
  // 又归零，谱曲/评审被误拦。回灌记录一律算作本专辑（它就是本会话的真实历史）。
  const inAlbumOrBackfilled = (d: DeliveryRow) =>
    inAlbum(d) || (typeof d.at !== "number" && typeof d.turnGen !== "number")
  // 本会话全部过契约歌词（先词后曲与歌词注入共用；跨轮累积＝「本会话已有词」语义）。
  const lyricDeliveries = deliveryRows.filter((d) => d.agent === "lyricist" && d.contractOk && d.relPath)
  // 在途写词（先词后曲、专辑工序、歌词注入共用；同步内存查询，无额外成本）。
  const lyricsInFlight = (byParent.get(parent.sessionId) ?? []).some((r) => r.agent === "lyricist" && r.status === "running")
  if (!isFork && (beastOn || rawExpert === "lyricist" || rawExpert === "music")) {
    let allowed: unknown
    try {
      allowed = (JSON.parse(readFileSync(`${import.meta.dir}/expert/expert-ids.json`, "utf8")) as { experts?: unknown })?.experts
    } catch (e) {
      return Response.json(
        { ok: false, code: "expert_registry_unavailable", error: `expert 清单不可读（gateway/expert/expert-ids.json：${e instanceof Error ? e.message : String(e)}）` },
        { status: 503 },
      )
    }
    if (!Array.isArray(allowed)) {
      return Response.json(
        { ok: false, code: "expert_registry_unavailable", error: "expert 清单不可读（gateway/expert/expert-ids.json 形状错误：缺 experts 阵列）" },
        { status: 503 },
      )
    }
    const allowedList = allowed as string[]
    if (rawExpert && !allowedList.includes(rawExpert)) {
      return Response.json({ ok: false, code: "unknown_expert", error: `未知 expert：${rawExpert}`, allowed: allowedList }, { status: 400 })
    }
    // 刀3 权威路由（Jev 失败回 null → fail-open 用点名值/空）。
    const routed = (await routeExpertAuthoritative(prompt, rawExpert)) ?? {
      expertId: rawExpert,
      source: rawExpert ? ("provided" as const) : ("none" as const),
    }
    if (routed.expertId && !allowedList.includes(routed.expertId)) {
      // Jev 建议域外（不该发生：criteria 就是七域＋other；防御性回退到点名值）。
      expertId = rawExpert
    } else {
      expertId = routed.expertId
    }
    // （守卫判定已上移到本分支之前，见上方注释；此处不再重复呼叫。）
    // H9（2026-10-02）：内容 vs expert 域一致性守卫。
    // 在 critic 登记之前执行——被降级的研究任务不得顶掉机器 critic pass 的触发判据。
    {
      const g = guardExpertContent(prompt, expertId, dispatchGuards.research)
      if (g.reason) {
        console.log(`[gateway] jev_gate: EXPERT_GUARD ${expertId || "-"} -> ${g.expertId || "generic"} label="${label}" reason=${g.reason}`)
        expertId = g.expertId
      }
    }
    // M2：music-first 机器前置断言（依赖音乐的任务须等 music 交付事件）。
    {
      const delivered = deliveredByParent.get(parent.sessionId) ?? []
      const musicInFlight = (byParent.get(parent.sessionId) ?? []).some((r) => r.agent === "music" && r.status === "running")
      const reason = musicFirstBlockReason(
        prompt,
        expertId,
        {
          musicInFlight,
          musicDelivered: delivered.some((d) => d.agent === "music"),
        },
        dispatchGuards.musicDependency,
      )
      if (reason) {
        console.log(`[gateway] jev_gate: MUSIC_FIRST_BLOCKED label="${label}" expert=${expertId || "-"} inflight=${musicInFlight}`)
        return Response.json({ ok: false, code: "music_first", error: reason, blocked: "music_first" }, { status: 409 })
      }
    }
    // 先词后曲复用真实交付簿：未过歌词契约不可作为前置成果。
    // 2026-10-24 修 bug：旧条件多一个 `prompt.includes(d.relPath)`——orchestrator 没在任务书里
    // 提到歌词路径时检查恒 false，已交付的歌词被当成没交付。是否提及路径与「歌词是否已交付」
    // 无关，去掉；注入路径的那行提示（下方）照旧用已交付歌词清单。
    const lyricsReason = lyricsFirstBlockReason(expertId, { lyricsDelivered: lyricDeliveries.length > 0, lyricsInFlight }, dispatchGuards.lyricsDependency);
    if (lyricsReason) return Response.json({ ok: false, code: "lyrics_first", error: lyricsReason, blocked: "lyrics_first" }, { status: 409 });
    // 刀 2（2026-09-15）：orchestrator **自行**派 critic = 本轮已有 critic 审核动作，
    // 机器 pass 的触发判据据此豁免（不重复派遣）。登记有界 Map。
    if (expertId === "critic") {
      criticDispatchedByParent.set(parent.sessionId, parent.turnGen ?? 0)
      boundMap(criticDispatchedByParent, 500)
    }
  }

  // 2026-10-24：专辑工序闸与「依赖上游歌词的下游」闸在 expert 路由分支之外——
  // beast_mode OFF 且不点名 expert 时 expertId 恒为 ""，放在分支内这些门对默认用户
  // 永远不参与计算。是不是谱曲/写词/评审，一律由上方 Jev 题 + 点名覆盖判（无词表）。
  // B（2026-10-24）：交付簿跨轮累积，「已交付」收窄到本专辑范围（本 turnGen 或近窗）。
  // P0 修复（2026-10-24 二审）：本对象字面量曾把 `lyricistInFlight` 写两次、后者值取自
  // music 在途，专辑闸于是读到错的旗标。现在两个键一次各写一遍：写词在途、music 在途。
  if (!isFork) {
    const musicInFlight = (byParent.get(parent.sessionId) ?? []).some((r) => r.agent === "music" && r.status === "running")
    const albumReason = albumPhaseBlockReason(isMusicWork, {
      isLyricistWork,
      lyricistInFlight: lyricsInFlight,
      lyricsInFlight: musicInFlight,
      lyricsDeliveredInAlbum: deliveryRows.filter((d) => d.agent === "lyricist" && inAlbumOrBackfilled(d)).length,
      albumDependency: dispatchGuards.albumDependency,
    })
    if (albumReason) {
      console.log(`[gateway] jev_gate: ALBUM_PHASE_BLOCKED label="${label}" expert=${expertId || "-"} lyricistInFlight=${lyricsInFlight} musicInFlight=${musicInFlight}`)
      return Response.json({ ok: false, code: "album_phase", error: albumReason, blocked: "album_phase" }, { status: 409 })
    }
    // P2 修复（2026-10-24 二审）：旧条件 `expertId === "critic"` 在 OFF 下恒假，评审闸不参与。
    // 现在求值条件＝Jev 判定的专辑工程 + 本次派遣是评审类；评审域本身由 Jev 题 + 点名覆盖判。
    if (dispatchGuards.albumDependency === true && isReviewWork) {
      const reviewReason = albumReviewBlockReason({
        musicDeliveredInAlbum: deliveryRows.filter((d) => d.agent === "music" && inAlbumOrBackfilled(d)).length,
        lyricsDeliveredInAlbum: deliveryRows.filter((d) => d.agent === "lyricist" && d.contractOk && d.relPath && inAlbumOrBackfilled(d)).length,
        albumDependency: dispatchGuards.albumDependency,
      })
      if (reviewReason) {
        console.log(`[gateway] jev_gate: ALBUM_REVIEW_BLOCKED label="${label}" expert=${expertId || "-"} rows=${deliveryRows.length}`)
        // 已知边界（2026-10-24）：交付簿两源（内存 + SQLite deliveries）都可能为空——
        // 内存重启即丢，SQLite 若本次部署前未开写也读不到。空簿时给出可操作文案，
        // 不做静默放行：orchestrator 应当先补派创作，而不是让评审对空气打分。
        const error =
          deliveryRows.length === 0
            ? "【机器闸·album-phase】专辑工程尚无 music 或歌词交付，评审没有可审的实体；且本会话交付簿为空（可能刚重启或本专辑确实还没开工）。先派 lyricist/music 并等其交付事件落盘，再派评审；不要对空簿评审。"
            : reviewReason
        return Response.json({ ok: false, code: "album_phase", error, blocked: "album_phase", delivery_rows: deliveryRows.length }, { status: 409 })
      }
    }
    // 写词任务自己开不了工＝最荒谬的一种拦法。豁免由 Jev 的 isLyricistWork + 点名覆盖判
    // （OFF 下 expertId 为 ""，旧写法在这里判 expertId 等于不判）。
    if (!isLyricistWork) {
      const upstreamReason = lyricsUpstreamBlockReason(
        { lyricsDelivered: lyricDeliveries.length > 0, lyricistInFlight: lyricsInFlight },
        dispatchGuards.lyricsUpstream,
      )
      if (upstreamReason) {
        console.log(`[gateway] jev_gate: LYRICS_UPSTREAM_BLOCKED label="${label}" expert=${expertId || "-"} lyricistInFlight=${lyricsInFlight} lyricsDelivered=${lyricDeliveries.length > 0}`)
        return Response.json({ ok: false, code: "lyrics_upstream", error: upstreamReason, blocked: "lyrics_upstream" }, { status: 409 })
      }
    }
    // 2026-10-24：研究在途拦截（只拦在途，不拦零研究）。
    // 病情＝主脑并发派「概念专辑方法研究」与「无主黎明歌词」，写词的人读不到尚未落盘的
    // 研究结论，前一路研究价值清零。判据＝Jev 判本任务消费研究成果（consumesResearch），
    // 且**本会话确有研究在跑**——此时派它出去只能拿旧结论或凭空编。
    // 刻意**不在零研究时硬拦**：用户可能就要一首歌，强制先派三路研究是过度；那条由
    // playbook 提示词层引导。三类豁免照旧复用既有判据：返工（Jev rework/词表回退）、
    // 用户已给完整原词（lyrics_upstream 判否）、纯器乐（Jev 判否）。
    if (consumesResearch) {
      const runningResearch = (byParent.get(parent.sessionId) ?? []).filter((r) => r.researchTask && r.status === "running" && !r.stopped)
      const userSuppliedLyrics = dispatchGuards.lyricsUpstream === false || dispatchGuards.lyricsDependency === false
      const rework = isReworkSpec(prompt, dispatchGuards.rework)
      if (runningResearch.length > 0 && !rework && !userSuppliedLyrics) {
        console.log(
          `[gateway] jev_gate: RESEARCH_INFLIGHT_BLOCKED label="${label}" expert=${expertId || "-"} running=${runningResearch.map((r) => r.label).join("|")}`,
        )
        return Response.json({
          ok: false,
          code: "research_inflight",
          blocked: "research_inflight",
          error: "【机器闸·research-inflight】研究尚在交付中，等它落盘再派，届时研究会自动注入你的任务书（无需你在任务书里贴正文）。",
          running_research: runningResearch.map((r) => ({ id: r.id, label: r.label })),
        }, { status: 409 })
      }
    }
  }
  // C（2026-10-24，二审修 P1/P2）：music 任务的歌词注入。
  // - 触发条件从 `expertId === "music"` 改为 isMusicWork（Jev 题 + 点名覆盖）：OFF 下
  //   expertId 恒为 ""，旧条件让注入永不存在，「十首关于夏天的东西」的谱曲者拿不到词。
  // - 注入集合必须过 inAlbum：交付簿跨轮跨专辑，命中媒体词时会把上一张专辑的全部词
  //   列给本轮谱曲者，照着谱错歌。
  // - 本专辑内无词但 Jev 判依赖歌词时：注入全部歌词，按完成时间倒序，带 label 与正文
  //   前 80 字摘要。为什么宁可多给元数据也不让机器猜专辑边界：口令式的「本专辑」在
  //   交付簿里没有可靠锚点（重启回灌无 turnGen、async 跨轮完成），机器猜错一次就是
  //   谱错歌；而 music 读到 label + 摘要就能自己认出哪几份是这张专辑的。
  if (!isFork && isMusicWork && dispatchGuards.lyricsDependency !== false) {
    const inAlbumLyrics = lyricDeliveries.filter((d) => inAlbum(d))
    if (inAlbumLyrics.length) {
      const list = inAlbumLyrics.map((d, i) => `${i + 1}. ${d.relPath}${d.label ? `（${d.label}）` : ""}`).join("\n")
      prompt += `\n\n【已交付歌词来源】本专辑共有 ${inAlbumLyrics.length} 份已过契约的歌词，逐首 read 完整文件、原样用于谱曲，不从摘要改写：\n${list}\n正文问题回交 lyricist。字数与 Z% 只引用回执，不心算。`
    } else if (lyricDeliveries.length && dispatchGuards.lyricsDependency === true) {
      const sorted = [...lyricDeliveries].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      const list = sorted
        .map((d, i) => {
          const head = deliveryHead(d.relPath)
          return `${i + 1}. ${d.relPath}${d.label ? `（${d.label}）` : ""}${head ? ` — 开头：${head}` : ""}`
        })
        .join("\n")
      prompt +=
        `\n\n【已交付歌词来源·跨专辑候选】本会话共有 ${sorted.length} 份已过契约歌词，均不在本专辑判定范围内（可能属于更早的专辑或更早一轮）。请按 label 与开头自行判断哪几份属于本次任务；确认属于本专辑的，逐首 read 完整文件、原样谱曲；不属于的不要用。清单按完成时间倒序（最新在前）：\n${list}\n若无法确认归属，回交 orchestrator 要求明确歌词路径，不要自行猜测混用。`
    }
  }

  // C1（2026-10-21）席位能力预检：专家席位成立时，拿原始任务书点名的工具对该席位
  // expert/opencode-agents.json 的 tools 布尔表。**命中不阻断派工**（换席位是
  // orchestrator 的判断），只把一行可见提示追加到派工结果 + console.warn。
  let seatCheck: SeatToolCheck = { ok: true, missing: [] }
  if (expertId) seatCheck = checkSeatTools(expertId, taskText, loadSeatToolTable())
  const seatNotice = seatCheck.missing.length > 0 ? formatSeatPreflightNotice(expertId, seatCheck.missing) : ""
  if (seatNotice) {
    console.warn(
      `[gateway] seat-preflight: expert=${expertId} label="${label}" missing=${seatCheck.missing.map((m) => m.tool).join(",")} → 仍派工（提示 orchestrator 换席位或改派）`,
    )
  }

  // 刀 2B（2026-09-19）：派遣 spec 消毒（权威）。研究结论/网页内容嵌 spec 是活的
  // 间接注入通道（手册模板二【研究输入】逐字嵌 prompt）。Jev 判拦截线以上 →
  // spec 头注入机器隔离声明（不拦派遣、只废掉注入指令的效力）。
  {
    if (!isFork) {
      const quarantine = await quarantineSpec(`dispatch:${label || "unlabeled"}`, prompt)
      if (quarantine) prompt = `${quarantine}\n${prompt}`
    }
  }

  // 量级瘦身 A（2026-09-19）：spec 模板机器注入。三军模板（研究/创作/毒蛇评审，
  // playbook 1.8 逐字迁出至 spec-templates.json）按 Jev 任务分类自动追加到任务书
  // 头部——orchestrator 只写任务意图，配方由机器持有。Jev 挂 → 不注入（fail-open，
  // 子代理照原 spec 跑；模板缺档同理跳过，只留 log）。
  // 0920 暴君裁定：模板选择接 System One——同一请求批次取回工作流模板判定，
  // 命中制作类（confidence≥0.8）即把骨架硬注入任务书头（先于军团模板），
  // 让「没人负责选模板」不再可能（事故：60s 百合 OP MV 裸跑＝无角色卡约束）。
  let researchTask = dispatchGuards.research === true
  if (!isFork && expertId !== "lyricist") {
    let templateInjected = false
    try {
      const tpl = JSON.parse(readFileSync(`${import.meta.dir}/spec-templates.json`, "utf8")) as Record<string, string>
      const meta = await classifyDispatchMeta(prompt)
      researchTask = researchTask || meta.specKey === "research"
      // 研究先行是创作前置，不能只靠模型读到规则后自觉执行。复用真实run及落盘，
      // 不把派遣成功、URL列表或提示词的“已完成研究”当成前置成果。
      // 2026-10-24：判据从 `RESEARCH_PRECEDED_EXPERTS.includes(expertId)` 换成 Jev 的
      // consumesResearch——旧名单没有 lyricist/music，写词谱曲从来不受约束；而旧条件还要求
      // beastOn && specKey==="creation" && meta.template，BEAST OFF（默认）恒不触发。
      // 现在只要「本任务消费研究成果」就参与判定，零研究且无研究在途时放行（放行权交
      // playbook 提示词层，避免用户就要一首歌时被强制先派三路研究）。
      if (consumesResearch && !researchTask) {
        const runningResearch = (byParent.get(parent.sessionId) ?? []).filter((r) => r.researchTask && r.status === "running" && !r.stopped)
        const prior = await researchPredecessors(parent)
        if (!prior.available) return Response.json({ ok: false, code: "research_evidence_unavailable", error: "已有研究/创作的同会话持久证据暂时读不到；请保留现有产物，待证据恢复后继续，不要重做研究。" }, { status: 503 })
        const research = prior.records.filter((r) => r.agent === "research" && (readCompletedPredecessor(r) ?? "").split("\n").some((line) => line.trim() && !/^\s*(?:[-*]\s*)?(?:https?:\/\/\S+|\[[^\]]*\]\(https?:\/\/[^)]+\))\s*$/.test(line)))
        const continuing = isReworkSpec(prompt, dispatchGuards.rework) && prior.records.some((r) => r.agent === expertId && readCompletedPredecessor(r) !== null)
        if (!continuing && runningResearch.length > 0 && !prior.records.some((r) => r.agent === "research" && readCompletedPredecessor(r) !== null)) {
          return Response.json({
            ok: false, code: "research_first", blocked: "research_first",
            error: "研究是创作必经阶段。当前研究尚未交付完毕，而本任务需要建立在其结论之上：等研究落盘后再派，届时研究会自动注入你的任务书（无需你在任务书里贴正文）。",
            completed_research: research.map((r) => ({ id: r.runId, label: r.label, path: r.relPath })),
            running_research: runningResearch.map((r) => ({ id: r.id, label: r.label })),
          }, { status: 409 })
        }
      }
      if (meta.template) {
        // R2-G1：禁生成／只要方案 → 指令声明＋骨架 lean（与 messages-gw PROMPT_SKELETON 同闸）。
        const planOnlyLean = isPlanOnlyNoGenerationIntent(prompt)
        prompt = `${workflowTemplateDirective(meta.template.templateId, meta.template.confidence, planOnlyLean ? { planOnlyLean: true } : undefined)}\n\n---\n\n${prompt}`
        console.log(
          `[gateway] jev_gate: WORKFLOW_TEMPLATE injected template=${meta.template.templateId} confidence=${meta.template.confidence.toFixed(2)} planOnlyLean=${planOnlyLean} label="${label}" expert=${expertId || "-"}`,
        )
        // 0920 暴君裁定（第二版）：模板判定完成即建骨架弹上画布——不等 Expert
        // 去调 workflow_start（实锤：Expert 根本没调，右边永远空白，「太慢了」）。
        // 建构用占位内容满足后端「每个 text role 非空」的验证；Expert 之后同模板
        // 呼叫 workflow_start 走 P0 幂等守卫复用同一支 wf，再用 workflow_update_node
        // 回填真内容。失败一律 fail-open（Expert 仍可自行建立，行为＝部署前）。
        try {
          // 修 4（2026-10-02）：per-session 骨架去重——本会话整个生命周期最多一个骨架。
          // 先查该父会话是否已有 workflowSnapshot（持久镜像）或已登记 owner wf：有则
          // 复用同一个 workflowId，不新建不覆盖（此前同一会话建 14 个 wf 只留最后一个=孤儿）。
          const snap = (parent as { workflowSnapshot?: { workflowId?: unknown } }).workflowSnapshot
          const snapWfId = snap && typeof snap.workflowId === "string" ? snap.workflowId : undefined
          const priorWfId = workflowOwnerBySession.get(parent.sessionId) ?? snapWfId
          if (priorWfId) {
            workflowOwnerBySession.set(parent.sessionId, priorWfId)
            console.log(
              `[gateway] jev_gate: WORKFLOW_SKELETON reused wf=${priorWfId} session=${parent.sessionId} (per-session 去重，不新建不覆盖)`,
            )
          } else {
            const r = workflowService.startFast(
              meta.template.templateId,
              templatePlaceholderContent(meta.template.templateId) as never,
              parent,
              planOnlyLean ? { planOnlyLean: true } : undefined,
            )
            if ("workflowId" in r && typeof r.workflowId === "string") {
              workflowOwnerBySession.set(parent.sessionId, r.workflowId)
              console.log(
                `[gateway] jev_gate: WORKFLOW_SKELETON built template=${meta.template.templateId} wf=${r.workflowId} session=${parent.sessionId} planOnlyLean=${planOnlyLean} (判定即弹，不等 Expert)`,
              )
            } else {
              console.log(`[gateway] workflow skeleton skipped (start error): ${"error" in r ? r.error : "unknown"}`)
            }
          }
        } catch (e) {
          console.log(`[gateway] workflow skeleton build failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (meta.specKey && typeof tpl[meta.specKey] === "string" && tpl[meta.specKey]) {
        prompt = `【系统注入·任务类型清单】只核对本任务真正要交付的部分。与本次交付物无关的条目跳过并写明原因，清单不是第二份任务。\n\n${tpl[meta.specKey]}\n\n---\n\n【任务书原文】\n${prompt}`
        templateInjected = true
      }
    } catch (e) {
      console.log(`[gateway] spec template injection skipped (read/classify failed): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (templateInjected) console.log(`[gateway] spec template injected: label="${label}"`)
  }

  // M3（2026-10-02）：返工 spec 内容锁。侦测到返工任务 → 注入「只改 X 栏、其余逐字沿用
  // <原稿路径>＋交付附 diff」（原稿路径＝同 label/同 expert 最近一份落盘交付物）。
  if (!isFork && isReworkSpec(prompt, dispatchGuards.rework)) {
    const delivered = deliveredByParent.get(parent.sessionId) ?? []
    const prior = [...delivered].reverse().find((d) => d.relPath && (d.label === label.slice(0, 20) || (expertId && d.agent === expertId)))
    prompt = `${reworkLockDirective(prior?.relPath ?? "")}\n\n---\n\n${prompt}`
    console.log(`[gateway] jev_gate: REWORK_LOCK injected label="${label}" original=${prior?.relPath || "-"}`)
  }

  // 支柱二（检查点增量断点接管）：若指定了 from_checkpoint_run_id，查出前序检查点并结构化注入任务书。
  // P0（2026-10-18）：两个 token 都会拼进档名——先过白名单，非法一律 400（实测 `x/../../..` 被拒）。
  const fromCpRunIdRaw = safeCheckpointToken(body.from_checkpoint_run_id)
  const fromCpIdRaw = safeCheckpointToken(body.from_checkpoint_id)
  if (fromCpRunIdRaw === null || fromCpIdRaw === null) {
    return Response.json(
      {
        ok: false,
        code: "invalid_checkpoint_id",
        error: "from_checkpoint_run_id / from_checkpoint_id 只接受 1-64 位字母、数字、下划线、连字符（路径分隔符与 .. 一律拒绝）。",
      },
      { status: 400 },
    )
  }
  const fromCpRunId = fromCpRunIdRaw ?? ""
  const fromCpId = fromCpIdRaw ?? ""
  let inheritedCp: SubagentCheckpoint | undefined
  if (fromCpRunId && !isFork) {
    const liveRun = (byParent.get(parent.sessionId) ?? []).find((r) => r.id === fromCpRunId)
    if (liveRun?.checkpoints?.length) {
      inheritedCp = fromCpId ? liveRun.checkpoints.find((c) => c.id === fromCpId) : liveRun.lastCheckpoint ?? liveRun.checkpoints[liveRun.checkpoints.length - 1]
    }
    // F1（P1·跨会话越权修复，2026-10-14）：回退两条腿（completed 记录 / 落盘检查点档）都必须过
    // 父归属闸——liveRun 那条已按父过滤，这两条没有：B 知道 A 的 run id 即可把 A 的终态检查点
    // （summary/data 整段）注入本会话任务书。归属不成立＝视同查不到（不回退、不注入），行为与
    // 其他「查不到」一致。归属判据复用同一文件既有的 parentOwnsRunId。
    const cpOwned = parentOwnsRunId(parent.sessionId, fromCpRunId)
    if (!inheritedCp && cpOwned) {
      const compRec = completed.get(fromCpRunId)
      if (compRec?.lastCheckpoint && (!fromCpId || compRec.lastCheckpoint.id === fromCpId)) {
        inheritedCp = compRec.lastCheckpoint
      }
    }
    if (!inheritedCp && cpOwned) {
      try {
        if (existsSync(SUBAGENT_CHECKPOINTS_DIR)) {
          const files = readdirSync(SUBAGENT_CHECKPOINTS_DIR).filter((f) => f.startsWith(`${fromCpRunId}-`) && f.endsWith(".json"))
          if (files.length > 0) {
            files.sort()
            // P0：目标档路径必须由受校验 token 构造，且 resolve 后仍在 checkpoints 目录内。
            const targetFile = fromCpId ? `${fromCpRunId}-${fromCpId}.json` : files[files.length - 1]
            const fallbackId = fromCpId || targetFile.slice(fromCpRunId.length + 1, -".json".length)
            const targetPath = resolveCheckpointFile(SUBAGENT_CHECKPOINTS_DIR, fromCpRunId, fallbackId)
            if (targetPath && existsSync(targetPath)) {
              inheritedCp = JSON.parse(readFileSync(targetPath, "utf8")) as SubagentCheckpoint
            }
          }
        }
      } catch (e) {
        console.warn(`[gateway] subagent checkpoint read deferred: ${fromCpRunId}`, e)
      }
    }
  }

  if (inheritedCp) {
    const cpFact = `【检查点断点接管·系统事实】
本子代理继承前序子代理（runId: ${inheritedCp.run_id}）阶段【${inheritedCp.stage}】进度 ${inheritedCp.progress}%：
- 阶段摘要：${inheritedCp.summary}
- 检查点数据：
${JSON.stringify(inheritedCp.data, null, 2)}

【铁律】以上阶段与任务已完成并验证，绝对禁止从零重跑！直接从该阶段断点接续攻坚！\n\n`
    prompt = `${cpFact}${prompt}`
  }

  // 并发上限：第 4 个拒绝（已挂起 suspended 的子代理交出并发槽，不计入运行数），文案原样给主代理。
  const list = byParent.get(parent.sessionId) ?? []
  const runningList = list.filter((r) => r.status === "running")
  if (runningList.length >= MAX_ACTIVE_PER_PARENT) {
    return Response.json({
      ok: false,
      code: "concurrency_limit",
      error: SUBAGENT_BUSY_MESSAGE,
      running: runningList.map((r) => ({ id: r.id, label: r.label, elapsed_ms: Date.now() - r.startedAt })),
    }, { status: 409 })
  }

  // 2026-10-24：研究正文注入（核心）。判定＝Jev 的 guard_consumes_research（点名非创作域
  // 可否决），内容＝本会话已交付研究的正文，不再是「只给路径让你自己去找」。
  // - 无研究正文 ⇒ 零注入，任务书与注入前逐字等价；
  // - 放在兄弟名册之前，让下游先看到「结论」再看「还有谁在跑」；
  // - 正文块的隔离声明与逐份 quarantine 见 jev-gate renderResearchInjection。
  if (!isFork && consumesResearch) {
    const items = await buildResearchInjection(parent, label)
    if (items) {
      const inj = renderResearchInjection(items)
      if (inj.text) {
        prompt = `${inj.text}\n\n${prompt}`
        console.log(
          `[gateway] jev_gate: RESEARCH_INJECTED label="${label}" expert=${expertId || "-"} docs=${inj.injected.length} chars=${inj.chars} truncated=${inj.truncated} omitted=${inj.omitted.length}`,
        )
        for (const d of inj.injected) {
          console.log(`[gateway] jev_gate: RESEARCH_INJECTED doc="${d.label}" path=${d.path} chars=${d.chars} truncated=${d.truncated}`)
        }
        if (inj.omitted.length) console.log(`[gateway] jev_gate: RESEARCH_INJECTED omitted=${inj.omitted.join(",")}`)
      }
    }
  }

  // Y4（2026-10-14）兄弟名册：把「本父会话当前存在哪些子代理」作为任务书头部事实块注入。
  // 病灶：子代理只知道自己那点 prompt，不知道同会话还有谁在跑、谁已交付 ⇒ 重复劳动／
  // 互相踩脚。名册是**启动时刻的快照**（照 Claude Code sibling roster 语义）；本 run 此刻
  // 还没进 list，天然不入册。无事实＝零注入（输出与注入前逐字等价）。
  // 刻意放在全部 Jev 分类／守卫／模板注入之后：注入内容不参与语义判定（零扰动）。
  const rosterFact = isFork ? "" : buildSiblingRosterFact(parent.sessionId)
  if (rosterFact) prompt = `${rosterFact}${prompt}`

  // 模型链：父会话 persona 主模型 + registry fallbacks（空链 = 吃 opencode 预设，
  // 仅在 registry 缺失的极端情况发生，此时无链可换）。
  // CC 2.1.302：显式 model 覆写优先级最高（fork 忽略，继承父模型）；effort 只选档与
  // 任务书声明（opencode 1.18 无 per-request effort 栏位，见 subagent-policy.ts）。
  let chain: SubagentModelRef[] = []
  try {
    chain = deps.subagentModelChain(parent) ?? []
  } catch (e) {
    console.error(`[gateway] subagent model chain failed (fallback to opencode default): id=${parent.sessionId}`, e)
  }
  const effort = isFork ? undefined : normalizeEffort(body.effort)
  if (!isFork && body.effort !== undefined && body.effort !== null && body.effort !== "" && effort === undefined) {
    return Response.json(
      { ok: false, code: "invalid_effort", error: `effort 只接受 low/medium/high/xhigh/max（收到 ${JSON.stringify(body.effort)}）` },
      { status: 400 },
    )
  }
  let modelOverride: SubagentModelRef | undefined
  if (!isFork && body.model !== undefined && body.model !== null && body.model !== "") {
    const parsed = parseSubagentModel(body.model, chain[0]?.providerID)
    if (!parsed) {
      return Response.json(
        { ok: false, code: "invalid_model", error: `model 需为 "provider/model" 或可补齐 provider 的 modelID（收到 ${JSON.stringify(body.model)}）` },
        { status: 400 },
      )
    }
    modelOverride = parsed
    chain = [parsed, ...chain.filter((m) => m.providerID !== parsed.providerID || m.modelID !== parsed.modelID)]
  }

  // P2（2026-10-18 并发同名原子占位）：名字检查与占位必须与 `targetList.push(run)` 处在**同一段
  // 同步代码**里——此前检查发生在多个 await（Jev 分类/路由/模板）之前，两个并发 dispatch 能
  // 同时通过检查、各自推出同名 run。这里在 push 前紧邻检查（中间无 await），单线程下即原子。
  if (requestedName) {
    const isUnfinished = (r: SubagentRun): boolean => !r.stopped && (r.status === "running" || r.status === "interrupted" || r.status === "suspended")
    // 重新读取当前数组（并发 dispatch 可能已把 byParent 换成新数组）；检查与 push 之间无 await。
    const currentList = byParent.get(parent.sessionId) ?? list
    const activeNames = new Set(currentList.filter(isUnfinished).map((r) => r.name))
    if (activeNames.has(requestedName)) {
      // fork 的自动名（label 派生）照 aYt 的 allocateName：自动加序号，不让并发 fork 因撞名失败。
      if (autoForkName) {
        const base = requestedName
        for (let i = 2; i <= 99; i++) {
          const candidate = `${base}-${i}`.slice(0, 64)
          if (!activeNames.has(candidate)) {
            requestedName = candidate
            break
          }
        }
      }
      if (activeNames.has(requestedName)) {
        return Response.json(
          { ok: false, code: "name_taken", error: `name「${requestedName}」已被本会话一个**尚未结束**的子代理占用；换一个名字或等它结束后再用。` },
          { status: 409 },
        )
      }
    }
  }
  const runId = crypto.randomUUID()
  const run: SubagentRun = {
    id: runId,
    // X3：父子链寻址。派工者是子代理时挂在它的路径下（本轮只做深度约束，不做多级路由）。
    childPath: requesterRun ? `${requesterRun.childPath}/${subagentChildSlug(label, runId)}` : `/root/${subagentChildSlug(label, runId)}`,
    parentSubagentId: requesterRun?.id,
    parentGatewaySessionId: parent.sessionId,
    parentOpencodeSessionId: parent.opencodeSessionId,
    opencodeSessionId: "",
    label: label.slice(0, 20),
    name: requestedName,
    isFork: isFork || undefined,
    forkSourceOpencodeSessionId: isFork ? body.sessionId : undefined,
    // D7：fork 的结果回到发起它的子代理，而不是主会话。
    forkRequesterRunId: isFork ? requesterRun?.id : undefined,
    // D6：记录真实派工者（子会话创建时写 parentID）。
    requesterOpencodeSessionId: body.sessionId,
    // 父 system prompt 快照：fork 取派工者自己的 system 快照（宪法/契约/授权/worker 规则），
    // 这是 d7e 的 parent system prompt snapshot；不是主会话的 lastPromptBody。
    forkSystemSnapshot: isFork ? requesterRun?.systemPromptSnapshot : undefined,
    effort,
    modelOverride,
    startedAt: Date.now(),
    status: "running",
    prompt,
    modelChain: chain,
    attempt: 1,
    // 片 D（2026-09-15）：交付闸门重派计数，硬帽 1 次。
    reworkCount: 0,
    // X8/X5/X6/X7（协作总线）：新栏位一律显式初始化（有界容器），不留 undefined 分叉。
    toolTimeline: [],
    pendingChildMessages: [],
    pendingParentNotes: [],
    pendingQuestions: [],
    submissionSeq: 0,
    beastMode: deps.beastMode(parent),
    agent: expertId || undefined,
    researchTask,
    asyncMode,
    messageRole: new Map(),
    partEmitted: new Map(),
    partKind: new Map(),
    suppressedParts: new Set(),
    partText: new Map(),
    lastActivityAt: Date.now(),
    pendingTools: new Set(),
    artifacts: [],
    toolStatusEmitted: new Map(),
    checkpoints: inheritedCp ? [inheritedCp] : [],
    lastCheckpoint: inheritedCp,
    fromCheckpoint: inheritedCp ? { run_id: inheritedCp.run_id, checkpoint_id: inheritedCp.id, stage: inheritedCp.stage } : undefined,
  }
  const targetList = byParent.get(parent.sessionId) ?? list
  targetList.push(run)
  byParent.set(parent.sessionId, targetList)
  // run 建立成功（已入注册表、可被事件/状态查询看见）→ SubagentStart。
  fireSubagentHook("SubagentStart", run, { async_mode: asyncMode === true })
  ensureTranscript(run)
  // 2026-10-11 修画布：music／video-director 派遣即标影音意图；编剧／剪辑在父会话已标或 prompt 命中时补标。
  if (expertId === "music" || expertId === "video-director") {
    parent.avProductionIntent = true
    if (!parent.avProductionTemplateId) {
      parent.avProductionTemplateId = expertId === "music" ? "music" : "feature_film"
    }
  } else if (
    (expertId === "screenwriter" || expertId === "editor") &&
    (parent.avProductionIntent === true ||
      isMultiStepAvProductionIntent({ templateId: parent.avProductionTemplateId, prompt }))
  ) {
    parent.avProductionIntent = true
  }

  // 硬顶：同步 15 分钟（工具轮询 16 分钟死线之前收尾）；R6 async 30 分钟
  // （军团的窄领域研究/创作任务合法地更长，无工具死线顶着，给足余量）。
  const hardMs = asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
  run.timeoutTimer = setTimeout(() => {
    console.warn(`[gateway] subagent hard timeout (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
    // 修 3（2026-10-02）：逾时先落盘已累积的 partial 文字，再 error 收尾（不让已有工作不可追）。
    run.partialPersist = true
    finishRun(run, "error", partialBodyOf(run), `子代理超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
  }, hardMs)
  // D5（2026-10-02）：心跳 + 逾时前 2 分钟部分交付。
  armHeartbeat(run, hardMs)

  // 协作总线接线（P0）：派遣**前**登记，保证子会话第一次工具调用即可解析身份。
  // P2：同名成员已存在时用 `name#shortRun`，旧名未读消息不继承；旧 run 已结束时摘除
  // 旧名（仍有活 run 则保留其可寻址性）。登记失败不影响派遣，子会话将明确不可寻址。
  let mailboxMembership: { team: string; agent: string } | undefined
  try {
    const mailboxBaseName =
      (run.name ?? run.label.trim().replace(/\s+/g, "-")).slice(0, 64) || `worker-${run.id.slice(0, 8)}`
    const liveBaseNames = new Set(
      (byParent.get(parent.sessionId) ?? [])
        .filter((r) => r !== run && !r.stopped && (r.status === "running" || r.status === "interrupted" || r.status === "suspended"))
        .map((r) => r.mailboxName ?? ((r.name ?? r.label.trim().replace(/\s+/g, "-")).slice(0, 64) || `worker-${r.id.slice(0, 8)}`)),
    )
    const row = registerTeamMember(parent.sessionId, undefined, mailboxBaseName, expertId || null, {
      runId: run.id,
      uniquePerRun: true,
      replaceStale: !liveBaseNames.has(mailboxBaseName),
    })
    run.mailboxName = row.agent
    mailboxMembership = { team: row.team, agent: row.agent }
  } catch (e) {
    console.error("[gateway] mailbox member registration failed:", e)
  }

  // 投递任务书（第一次 attempt；后续上游错误换模重试走 retryWithNextModel）
  const failure = await dispatchAttempt(run)
  if (failure) {
    // 投递从未成功：撤销本次成员登记，避免名册留下不可达成员。
    if (mailboxMembership) {
      try {
        removeTeamMember(mailboxMembership.team, mailboxMembership.agent)
      } catch (e) {
        console.error("[gateway] mailbox member rollback failed:", e)
      }
    }
    // 投递失败：死因随 502 同步返回工具（主会话当场知道），R6 唤醒不再补发，
    // 避免同一失败双重注入。
    run.asyncMode = false
    finishRun(run, "error", "", `子代理${failure}`)
    return Response.json({ ok: false, error: `子代理${failure}` }, { status: 502 })
  }

  deps.emitToSession(parent, "subagent.started", { id: run.id, label: run.label })
  console.log(
    `[gateway] subagent dispatched: id=${run.id} label="${run.label}" parent=${parent.sessionId} child=${run.opencodeSessionId}${asyncMode ? " mode=async" : ""}`,
  )
  if (!asyncMode) {
    // R1（2026-09-11）：同步 dispatch 硬 deadline。到点先让主会话解锁（工具轮询
    // /internal/subagent/status 读 completed 即取件，实测 <30s 收到 ok:false/TIMEOUT），
    // **子代理 run 不杀**：翻 asyncMode 让它后台续跑，完成后走既有 wakeParent 回填。
    const deadlineMs = parseSyncDeadlineMs(run.prompt)
    // P2b：arm 时刻记一条，deadline 解析结果可被日志直接观测（V3 不必等 240s）。
    console.log(
      `[gateway] subagent sync deadline armed: id=${run.id} label="${run.label}" deadline=${Math.round(deadlineMs / 1000)}s prompt_head="${run.prompt.slice(0, 24).replace(/\n/g, "\\n")}"`,
    )
    run.deadlineTimer = setTimeout(() => {
      run.deadlineTimer = undefined
      if (run.status !== "running") return
      if (completed.has(run.id)) return
      if (typeof deps?.wakeParent === "function") run.asyncMode = true
      const human =
        deadlineMs < 60_000
          ? `子代理超过预定时间（${Math.round(deadlineMs / 1000)} 秒）未回，已放它后台续跑；你先看其他结果`
          : `子代理超过预定时间（${Math.round(deadlineMs / 60_000)} 分钟）未回，已放它后台续跑；你先看其他结果`
      completed.set(run.id, {
        status: "error",
        summary: "",
        error: human,
        finishedAt: Date.now(),
        label: run.label,
        partial: true,
        reason: "timeout",
        parent: run.parentGatewaySessionId,
      })
      // WP2（2026-10-14）：同步 dispatch 超时放行＝轮询方可观测的终态（done:true/timeout）——
      // 叫醒该 run 的长挂起 waiter，让工具端立即取件而非等满 wait_ms。
      notify(`subagent:${run.parentGatewaySessionId}:${run.id}`)
      // E 片（2026-09-12）：超时放行这一刻的事实也落盘（无正文 → 写死因事实）。此刻
      // 盘上不是交付物，**不挂「完整结果已落盘」指针**（挂了会误导）；run 后续真完成
      // 时 finishRun 用全文覆写同一档并带指针。
      const partialPersist = persistRunOutput(run, "timeout", "", human)
      if (partialPersist.relPath) {
        console.log(`[gateway] subagent partial persisted: id=${run.id} path=${partialPersist.relPath}`)
      }
      console.warn(
        `[gateway] subagent sync deadline hit: id=${run.id} label="${run.label}" deadline=${Math.round(deadlineMs / 1000)}s — 主会话已放行，子代理转后台续跑`,
      )
    }, deadlineMs)
  }
  if (asyncMode) {
    // R6 异步：投递成功立即返回，主会话 turn 可正常结束；完成后 wakeParent 唤醒。
    const asyncNote = syncDowngraded
      ? "你要求同步等待，但这一路不是快速事实查询，已按后台执行：现在返回的是已派出，不是结果。用户问起时要照实说「后台运行」。完成后会自动唤醒主会话汇总。注意 subagent_id 是网关派工 run id，**不是 opencode session id**——不要把它当 task_id 传给内置 task 工具（必被拒：Expected a string starting with \"ses\"）；要取回完整交付物就 read 唤醒摘要里的落盘文件路径，或用 subagent_status 工具。"
      : run.isFork ? FORK_STARTED_NOTICE : "后台运行中，完成后自动唤醒主会话汇总。结束本轮，不要轮询等待。注意 subagent_id 是网关派工 run id，**不是 opencode session id**——不要把它当 task_id 传给内置 task 工具（必被拒：Expected a string starting with \"ses\"）；要取回完整交付物就 read 唤醒摘要里的落盘文件路径，或用 subagent_status 工具。"
    return Response.json({
      ok: true,
      subagent_id: run.id,
      label: run.label,
      ...(run.name ? { name: run.name } : {}),
      ...(run.isFork ? { fork: true, model: "inherit" } : {}),
      status: "running",
      async: true,
      ...(syncDowngraded ? { sync_downgraded: true } : {}),
      // C1：席位能力预检命中时把提示行接在既有 note 之后（未命中 → 与接线前逐字相同）。
      note: seatNotice ? `${asyncNote} ${seatNotice}` : asyncNote,
      ...(inheritedCp ? { from_checkpoint: { run_id: inheritedCp.run_id, checkpoint_id: inheritedCp.id, stage: inheritedCp.stage } } : {}),
      // D2：显式 effort 时如实回报 variant 是否真的带上（不支持＝false，非安慰剂）。
      ...(run.effort ? { effort: run.effort, variant_applied: run.variantApplied === true } : {}),
    })
  }
  return Response.json({
    ok: true,
    subagent_id: run.id,
    ...(run.name ? { name: run.name } : {}),
    ...(run.isFork ? { fork: true, model: "inherit" } : {}),
    ...(run.effort ? { effort: run.effort, variant_applied: run.variantApplied === true } : {}),
    // C1：同步派工没有既有 note；只在预检命中时新增（干净 payload 形状不变）。
    ...(seatNotice ? { note: seatNotice } : {}),
    ...(inheritedCp ? { from_checkpoint: { run_id: inheritedCp.run_id, checkpoint_id: inheritedCp.id, stage: inheritedCp.stage } } : {}),
  })
}

