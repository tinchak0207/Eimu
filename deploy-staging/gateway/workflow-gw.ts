// workflow-gw.ts —— 自 index.ts 第二阶段 Wave2 抽取：画布工作流引擎（workflowService 单例＋5 hooks、stateForWorkflow、持久化镜像 maps、recordWorkflowRefund、workflowWake 扫描器、workflowSnapshotOf/For、restoreWorkflowsFromSnapshot、F1 自动恢复 timer、assembleFilmNode、MODEL_STATUS_TTL/modelStatusCache/fetchModelStatusCached、resolveActiveModel、submitWorkflowNode、workflowServiceTemplates、生成管线、唤醒扫描 setInterval、handleWorkflowInternal），原 index.ts 1378–2666 行，逐行机械搬运。
import { mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { WorkflowService } from "./workflow-service"
import { gateWorkflowMemory } from "./jev-gate"
import { estimateTtsCoins } from "./pricing-and-validation"
import { compileShotPrompt, normalizeShotCamera, parseShotCandidate, shotOutputParams, type ShotJson } from "./video-prompt-schema"
import { loadUserSettings, getCriticVerdictByRun } from "./persistence"
import { enqueueWorkflowCriticReview, hasWorkflowCriticReview } from "./subagent.ts"
import { VIDEO_MOTION_RECEIPT_POLICY } from "./delivery-gate.ts"
import { billingAutoApprovalEnabled } from "./charge-approval-policy.ts"
import { sessions, dirtySessions, markDirty } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { opencodeHeaders } from "./opencode-client.ts"
import { catalogUnitCoins, catalogVideoPerSecondCoins, estimateNodeCoins, resolveVideoSubmissionOptions, videoNodeCoinsSync, invalidateWorkflowPriceCatalog, priceCatalogCache, PRICE_CATALOG_TTL_MS, resolveNodeModel } from "./pricing-gateway.ts"
import { TTS_UPSTREAM, probeTtsUpstream, settleConfirm } from "./media-internal-routes.ts"
import { CONFIRM_THRESHOLD_COINS, CONFIRM_TIMEOUT_MS, OPENCODE_URL, PLATFORM_BASE, TTS_AUDIO_DIR, TTS_PUBLIC_BASE } from "./constants-gateway.ts"
import { jsonError } from "./gw-lib.ts"
import { VIDEO_FALLBACK_MODEL, pickVideoModel, rankVideoModels, videoDisqualifyReason, type ModelStatusEntryLike } from "./video-model-select.ts"
import { normalizeUserSettings } from "./sessions-http.ts"
import { applyCanvasNodeCreated, applyCanvasNodeConnected, applyCanvasNodeDisconnected, applyCanvasNodeUpdated } from "./canvas-cascade-state.ts"
import { humanMessageFor } from "./humanize-gw.ts"
import type { SessionState } from "./types-gateway.ts"
import type { TaskStatus } from "./types-gateway.ts"
import { appendLedgerFor, emitQuotaChanged } from "./quota-ledger.ts"
import { armWatchdogTimer, isInterrogativeMessage } from "./timers-gw.ts"
import { beastAgentField } from "./session-lifecycle.ts"
import { emitAgentNotice, reportNodeTerminalState } from "./emit-helpers.ts"
import { emitVideoDone } from "./events-translate.ts"

/** H11 补完：workflow 路径生成任务登记进 state.sessionTasks（与聊天路径 attachCanvasTask 同表）。 */
export function registerWorkflowTask(
  state: { sessionTasks?: SessionState["sessionTasks"] },
  taskId: string,
  label: string,
  status: "queued" | "succeeded" | "failed",
  url?: string,
): void {
  try {
    if (!taskId) return
    if (!state.sessionTasks) state.sessionTasks = new Map()
    const prev = state.sessionTasks.get(taskId)
    state.sessionTasks.set(taskId, {
      task_id: taskId,
      label: prev?.label ?? label,
      status,
      submitted_at: prev?.submitted_at ?? Date.now(),
      ...(url ? { url } : prev?.url ? { url: prev.url } : {}),
    })
  } catch { /* 登记失败不得影响生成 */ }
}
import { hasEntityToken, resolveEntityTokens, sanitizeEntityReferences } from "./entity-resolve.ts"
// TODO(整合 Wave2): 以下为「仍住 index.ts 且未在 16 个 export 内」符号的 declare 占位（stage1 记忆 subagent 占位符法，bun build 不查名可过）。
// 整合阶段换成真 import（bun build 硬查 named import，已实锤）。注：CommandResult 是 index.ts 既有基线错误（tsc-baseline-0919 第 12–18 行 TS2304 ×7），如实不补宣告。
// ─────────────────────────── 画布工作流引擎（暴君策略 v2）
//
// Deepseek 透过 workflow_* 工具填内容（参数/提示词），本服务展开节点流并执行。
// 执行提交（image/video）由 submitWorkflowNode 完成（带 session key）。

export const workflowService = new WorkflowService({
  emit: (state, name, data) => {
    const target = state as SessionState | undefined
    if (target) emitToSession(target, name, data)
    // 0920：画布事件同步落快照。此前这条出口只发 SSE 不写 canvasStates，
    // 前端刷新／重连后骨架全丢（GET /internal/canvas/snapshot 永远 has_state:false，
    // 实锤：模板判定即建骨架后快照仍空）。events-translate 的工具路径早有此写入，
    // workflow 路径漏了——同一写入函式，不另造轮子。
    // 2026-09-20 写穿收口：扩到 connected/disconnected/generating，全部 canvas.node.*
    // 帧发出即写穿（updated/generating 在快照无节点时静默跳过＝懒加载回灌兜底）。
    if (target) {
      try {
        if (name === "canvas.node.created") applyCanvasNodeCreated(target.sessionId, data)
        else if (name === "canvas.node.updated") applyCanvasNodeUpdated(target.sessionId, data)
        else if (name === "canvas.node.connected") applyCanvasNodeConnected(target.sessionId, data)
        else if (name === "canvas.node.disconnected") applyCanvasNodeDisconnected(target.sessionId, data)
        else if (name === "canvas.node.generating") {
          const g = (data ?? {}) as { node_id?: unknown; status?: unknown }
          if (typeof g.node_id === "string" && g.node_id) {
            applyCanvasNodeUpdated(target.sessionId, {
              node_id: g.node_id,
              patch: { status: typeof g.status === "string" ? g.status : "running" },
            })
          }
        }
      } catch (e) {
        console.error(`[gateway] canvas snapshot write failed on ${name}:`, e)
      }
    }
    // S6 规格1：节点终态（success/error）帧 → 60s 内面向用户的主动汇报。
    // 挂在 emit 转发处：generate/rerun 两条执行路径共用此出口，一钩全收。
    if (target && name === "canvas.node.updated") {
      // 修 2：节点失败 → 退款留痕先行（汇报文案读 billing 真值，须先记帐）。
      // 修 3：节点帧 = 进度打点，刷新唤醒登记表的停滞时钟。
      const d = (data ?? {}) as { unit_id?: unknown; patch?: { status?: unknown } }
      const wfid = typeof d.unit_id === "string" ? d.unit_id : ""
      // 2026-10-02 计费单一真源：节点失败不再在此「按报价全额退」记帐（会与控面实扣不符，
      // 评测实锤：harness 记退 390.005、控面零退款分录）。退款留痕改在工作流终态
      // （settleWorkflowCharges）按控面实扣差额记。
      if (wfid && workflowWake.has(wfid)) workflowWake.get(wfid)!.lastProgressAt = Date.now()
      try {
        reportNodeTerminalState(target, data as Parameters<typeof reportNodeTerminalState>[1])
      } catch (e) {
        console.error(`[gateway] S6 terminal report failed: ${e}`)
      }
    } else if (target && name.startsWith("canvas.") && workflowWake.size > 0) {
      // 修 3：canvas.node.generating 等非终态帧同样算进度（节点开跑也是推进）。
      const d = (data ?? {}) as { unit_id?: unknown }
      const wfid = typeof d.unit_id === "string" ? d.unit_id : ""
      if (wfid && workflowWake.has(wfid)) workflowWake.get(wfid)!.lastProgressAt = Date.now()
    }
  },
  // S5a：节点失败人话化挂点（errorDetails 原文 + human_message 中文短句）。
  humanize: humanMessageFor,
  // S4（2026-08-27）：整图币耗估价挂点——canvas.plan 的 cost_hint 用。
  // 同步签名：读快取目录；快取缺失时触发后台刷新，本次回 null（下个 plan 帧
  // 就有值），不阻塞工作流搭建。与 /workflow/generate 门槛估算同一价目
  //（image = 目录单价 × 1 张/节点，video = 档位价 5/10 币/秒（R5-C），model
  // 沿连线向上游 config 解析——与 estimateNodeCoins 完全同口径）。
  estimateGraphCoins: (graph) => {
    let total = 0
    let sawAny = false
    for (const n of graph.nodes) {
      if (n.kind === "text" || n.kind === "config") continue
      sawAny = true
      if (n.kind === "video") {
        const secs = typeof n.metadata.duration_seconds === "number" && n.metadata.duration_seconds > 0 ? n.metadata.duration_seconds : resolveConnectedVideoDuration(n.id, graph)
        if (typeof secs !== "number" || !(secs > 0)) return null
        const amount = videoNodeCoinsSync(n, graph, secs)
        if (amount === null) return null
        total += amount
        continue
      }
      if (n.kind !== "image") continue // audio/film 0 币
      const model = resolveNodeModel(n.id, n, graph)
      const v = priceCatalogCache && Date.now() - priceCatalogCache.at <= PRICE_CATALOG_TTL_MS ? priceCatalogCache.prices[model] : undefined
      if (typeof v !== "number") return null // 有估不出的节点：整图 null，不编数
      total += v
    }
    if (!sawAny) return null
    return Math.round(total * 1e6) / 1e6
  },
  // R8（2026-09-10 多镜展开修复）：可用视频模型动态选型挂点——大片 shotN_gen 不再
  // 写死 minimax-h3（当前不可用），start 时查 /v1/model-status 选可用视频模型
  //（轮子 = resolveActiveModel 同源判活；挑选逻辑与其 failover pool 同构：
  // media_type=video + available，按 24h 成功率排序取最优）。选不出回 null
  //（service 侧回退引擎默认，submit 前仍有 F2 failover 兜底）。
  pickDefaultVideoModel: async (owner?: unknown): Promise<string | null> => {
    const session = owner as SessionState | undefined
    const apiKey = session?.apiKey
    if (!apiKey) return null
    const models = await fetchModelStatusCached(apiKey)
    if (!models) return null
    // 2026-10-02 MODEL-SELECT：只选有真实交付且断路器非 open 者（video-model-select 单真源）。
    const picked = pickVideoModel(models as ModelStatusEntryLike[])
    if (!picked) return null
    console.log(`[gateway] R8 default video model picked: ${picked.id} (proven=${picked.proven})`)
    return picked.id
  },
  // 工作流持久化挂点（对齐 canvas 快照的 markDirty 模式）：状态每次变更
  // （start/addNode/connect/generate 逐节点）镜像进 owner session 并防抖落盘。
  onDirty: (wf) => {
    const owner = (wf.owner as SessionState | undefined) ?? null
    if (!owner || !owner.sessionId) return
    workflowOwnerBySession.set(owner.sessionId, wf.workflowId)
    owner.workflowSnapshot = workflowSnapshotOf(wf)
    markDirty(owner)
  },
  runNode: async (node, upstream, graph, owner) => {
    const session = owner as SessionState | undefined
    if (!session) return { nodeId: node.id, ok: false, error: "no active session" }
    if ((node.kind as string) === "director") {
      return { nodeId: node.id, ok: false, error: "预演节点不执行生图" }
    }
    // novel_film 配音环：真实 TTS 闭环（同步调用）；拼装（film）仍无上游。
    if (node.kind === "audio") {
      // 配音环：真实 TTS 闭环。取台词文本（node.metadata 或上游 text 节点），
      // 同步调 TTS 上游；上游缺失时诚实报错（不造假成功）。
      const meta = node.metadata as Record<string, unknown> | undefined
      const ttsText = String(meta?.text ?? meta?.content ?? meta?.prompt ?? "").trim()
      const probe = await probeTtsUpstream()
      if (!probe.available) {
        return { nodeId: node.id, ok: false, error: `配音（TTS）上游暂不可用：${probe.note}。此环节已编排入工作流，但无法真实生成音轨；请对用户如实说明。` }
      }
      const res = await fetch(`${TTS_UPSTREAM.base}${TTS_UPSTREAM.speechPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: TTS_UPSTREAM.model, input: ttsText || "（空台词）", voice: TTS_UPSTREAM.voice, response_format: "mp3" }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) return { nodeId: node.id, ok: false, error: `TTS upstream http_${res.status}` }
      const buf = await res.arrayBuffer()
      if (buf.byteLength < 64) return { nodeId: node.id, ok: false, error: "TTS upstream returned empty audio" }
      const id = `tts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
      const fileName = `${id}.mp3`
      await mkdir(TTS_AUDIO_DIR, { recursive: true })
      await Bun.write(path.join(TTS_AUDIO_DIR, fileName), buf)
      return { nodeId: node.id, ok: true, content: `${TTS_PUBLIC_BASE}/${fileName}`, costCoins: estimateTtsCoins("tts-zh", ttsText) }
    }
    if (node.kind === "film") {
      const r = await assembleFilmNode(node, upstream, graph, session)
      if (r.ok && r.content) void emitVideoDone(session, r.content, r.costCoins, node.id, "film")
      return r
    }
    const r = await submitWorkflowNode(session, node, upstream, graph)
    // 2026-10-02 MODEL-SELECT 回执：生成前若换过视频模型，结果带说明（metadata.model_swap 同步供 workflow_status 回显）。
    const swap = (node.metadata as Record<string, unknown>).model_swap as { from?: string; to?: string; reason?: string } | undefined
    if (swap && node.kind === "video") {
      ;(r as Record<string, unknown>).modelSwapNote = `视频模型已自动替换：${swap.from}（${swap.reason}）→ ${swap.to}`
      console.log(`[workflow] node ${node.id} ${(r as Record<string, unknown>).modelSwapNote}`)
    }
    if (r.ok && r.content && node.kind === "video") void emitVideoDone(session, r.content, r.costCoins, node.id, "video")
    return r
  },
  reviewBatch: async (wf, nodes) => {
    const state = (wf.owner as SessionState | null) ?? null
    const targets: import("./delivery-gate.ts").CriticPassTarget[] = []
    for (const node of nodes) {
      const artifact = wf.nodeContent[node.id]
      const binding = `workflow:${wf.workflowId}:${node.id}:${createHash("sha256").update(artifact).digest("hex")}`
      const old = node.metadata.quality_review as { artifact?: string; state?: string; criticRunId?: string; requested?: boolean } | undefined
      // Stored graph/canvas metadata alone cannot authorize continuation after restart or artifact changes.
      const verdict = old?.criticRunId ? getCriticVerdictByRun(old.criticRunId) : null
      let savedReceipt: any = null
      try {
        const line = verdict?.verdict_text?.split("\n").find((line: string) => line.startsWith("RECEIPT:"))
        if (line) savedReceipt = JSON.parse(line.slice(8))
      } catch { /* unverifiable remains partial */ }
      const videoReview = /\.(mp4|mov|mkv|webm)(?:[?#]|$)/i.test(artifact)
      const verified = verdict?.verdict === "pass" && savedReceipt?.ok === true && savedReceipt?.checked?.some((item: any) => item.runId === binding && item.artifact === artifact && (!videoReview || item.motion?.policy === VIDEO_MOTION_RECEIPT_POLICY))
      if (old?.artifact === artifact && verified) {
        workflowService.recordQualityReview(wf.workflowId, node.id, artifact, { ...old, state: "passed" })
        continue
      }
      if (old?.artifact === artifact && old.requested) {
        if (old.state === "pending" && !hasWorkflowCriticReview(state?.sessionId, binding)) workflowService.recordQualityReview(wf.workflowId, node.id, artifact, { ...old, state: "partial", reason: "审阅在重启/断线后未获得可信完成回执" })
        if (old.state === "passed") workflowService.recordQualityReview(wf.workflowId, node.id, artifact, { ...old, state: "partial", reason: "旧通过没有可信当前产物回执" })
        continue // same artifact is never charged/reviewed in an automatic loop
      }
      workflowService.recordQualityReview(wf.workflowId, node.id, artifact, { state: state ? "pending" : "partial", requested: true, reason: state ? "等待独立感知" : "没有可用审阅身份" })
      if (!state) continue
      targets.push({
        agent: node.kind === "image" ? "video-director" : "editor", label: node.title, runId: binding,
        text: `artifact: ${artifact}\n要求: ${String(node.metadata.gate ?? "按当前任务独立审阅")}\nworkflow:${wf.workflowId} node:${node.id}`,
        artifacts: [artifact], workflowReview: { workflowId: wf.workflowId, nodeId: node.id, artifact },
        mediaIntent: [{ artifact,
          ...(typeof node.metadata.prompt === "string" ? { prompt: node.metadata.prompt } : {}),
          camera: parseShotCandidate(node.metadata.shot)?.camera ?? node.metadata.camera ?? node.metadata.cam,
          ...(typeof node.metadata.duration_seconds === "number" ? { durationSeconds: node.metadata.duration_seconds } : {}),
        }],
        onReview: (result) => {
          if (wf.nodeContent[node.id] !== artifact) return // stale receipt never approves new content
          workflowService.recordQualityReview(wf.workflowId, node.id, artifact, { state: result.state, requested: true, criticRunId: result.criticRunId, receipt: result.receipt })
          if (result.state === "passed") workflowService.resumeAfterReview(wf.workflowId)
        },
      })
    }
    if (targets.length) enqueueWorkflowCriticReview(state, targets)
  },
  // 2026-09-24 协作确认闸挂点（详见本档 COLLABORATE_GATE_ROLES 节）。
  // 档位判定在 gateway（settings 是 gateway 的真源），engine 只收「停不停」。
  awaitingApproval: async (wf) => {
    const state = (wf.owner as SessionState | null) ?? null
    if (!state) return null
    // 只有协作档停（决策 1/2）。auto/preset：这里一句不问、零新增阻塞——护城河。
    if (await billingAutoApprovalEnabled(state) || normalizeUserSettings(loadUserSettings(state.apiKey)).interaction_mode !== "collaborate") return null
    const gate = resolveCollaborateGate(wf as Parameters<typeof resolveCollaborateGate>[0])
    if (!gate) return null
    if (!requestCollaborateApproval(state, wf, gate)) return null
    return collaboratePauseNotice(gate)
  },
})

// ── 跑批完成推送（2026-09-20 Phase 1）────────────────────────────────────
//
// 站点侧需要知道「这条 workflow 跑完了」才能把结果接回交付视角；此前完成只
// 活在 gateway 进程记忆体（WorkflowRunState 从不落盘），站点永远无从得知。
// 本函式是 gateway → 站点的单向推送出口。
//
// 设计取舍：
//   - 触发点挂 runWfGenerate 的 .then（generate 的终判出口），不挂
//     workflow-service 内——那会逼 engine 反向依赖 gateway 的 fetch/env；
//     service 已有 emit/onDirty 两个挂点，第三个纯为推送而设＝造轮子。
//   - 失败绝不阻塞主流程：整段 try/catch，catch 只记 log。推送是旁路，
//     站点挂掉不能让工作流收尾陪葬。
//   - 5s AbortSignal.timeout：站点慢时 gateway 不等。
//   - 只推 success/partial：未完成的状态推过去只会让站点把半成品当成品。
//   - 去重集合 workflowCompletionPushed：同一 workflowId 只推一次
//     （gateway 重启清空＝可接受，重启后状态已丢，本来就没得推）。
//   - 认证走 HARNESS_API_KEY（既有惯例：工具层打站点 /agent/v1/* 的 Bearer
//     闸门，见 music-tools-impl / memory_recall_impl）；未配置时记 log 不推，
//     不伪造请求。
export const SITE_COMPLETION_URL = (
  process.env.SITE_COMPLETION_URL || "https://image.tinchak0207.xyz/api/workflow-completion"
).trim()
/** 已推送过的 workflowId（含推送失败——不重试，避免站点挂掉时反覆打）。 */
export const workflowCompletionPushed = new Set<string>()

/**
 * 把工作流跑批完成投影并推送到站点。失败只记 log，永不抛。
 * state 必须是 workflow 的 owner session（要 sessionId 做关联键）。
 */
export async function pushWorkflowCompletion(state: SessionState): Promise<void> {
  try {
    const wfid = workflowOwnerBySession.get(state.sessionId)
    if (!wfid) return
    if (workflowCompletionPushed.has(wfid)) return
    const wf = workflowService.get(wfid)
    if (!wf) return
    const status = wf.status
    // 未完成（building/running/failed/paused）不推送——只推真交付出去的结果。
    if (status !== "success" && status !== "partial") return
    workflowCompletionPushed.add(wfid)
    // 投影：节点状态/产物/单节点币耗从 ActiveWorkflow 的三张旁表组回节点上
    //（WorkflowRunState 是 graph + nodeStatus/nodeContent/nodeCost 的组合视图）。
    const nodes = wf.graph.nodes.map((n) => ({
      id: n.id,
      role: n.role,
      kind: n.kind,
      title: n.title,
      status: wf.nodeStatus[n.id] ?? "pending",
      ...(wf.nodeContent[n.id] ? { content: wf.nodeContent[n.id] } : {}),
      ...(typeof wf.nodeCost[n.id] === "number" ? { costCoins: wf.nodeCost[n.id] } : {}),
      metadata: n.metadata,
    }))
    let totalCostCoins = 0
    for (const v of Object.values(wf.nodeCost)) if (typeof v === "number") totalCostCoins += v
    // Jev 闸门（`gateWorkflowMemory`）：判「这条跑批值不值得进记忆库」。
    // 为什么在 gateway 判而不是站点判：闸门分工（契约 §5）把判断层放在 gateway，
    // 且 `gateWorkflowMemory` 本来就住在 jev-gate.ts；站点只该收结论、不该持有
    // Jev 凭据。判完把结论放进 payload，站点据此决定要不要沉淀记忆（见站点
    // route 的 persistWorkflowMemory）。fail-open：Jev 挂掉回 true，不挡记忆。
    const memoryWorthPersisting = await gateWorkflowMemory({
      domain: "workflow",
      name: wf.templateId,
      // 判值只看「跑批的实质参数」：text 节点的提示词 + config 节点的参数。
      // 与站点侧 extractWorkflowRunConfig 同语义（两边都得从节点摊平里取，
      // 因为 gateway 没有单一 config 物件——参数是 expandTemplate 摊在节点上的）。
      config: (() => {
        const out: Record<string, unknown> = {}
        for (const n of wf.graph.nodes) {
          if (n.kind === "text" && typeof n.metadata?.content === "string" && !out.prompt) {
            out.prompt = n.metadata.content
          }
          if (n.kind === "config" && n.metadata) {
            for (const [k, v] of Object.entries(n.metadata)) {
              if (!(k in out)) out[k] = v
            }
          }
        }
        return out
      })(),
    })
    const payload = {
      workflowId: wfid,
      templateId: wf.templateId,
      sessionId: state.sessionId,
      status,
      nodes,
      connections: wf.graph.connections,
      totalCostCoins: Math.round(totalCostCoins * 1e6) / 1e6,
      completedAt: new Date().toISOString(),
      memoryWorthPersisting,
      // 记忆库 ownerKey：**必须是这位用户的**，否则写进去的记忆 agent 召不回来。
      //
      // 为什么要 gateway 算而不是站点自己推：站点只握有推送用的通用
      // HARNESS_API_KEY（平台级），hash 它得到的 ownerKey 与 agent 注入记忆时
      // 用的 per-user B key hash 不同 → 记忆落进一个谁都召不到的角落。
      // 而 `state.apiKey` 正是这位用户的派生 B key（站点
      // getOrCreateAgentKeyForUser 签发后带进建号请求），agent 侧
      // deriveMemoryOwnerKey 对同一把 key 做同一套 hash → 两端收敛。
      //
      // 送 hash 而非原 key：站点不需要（也不该拿到）明文凭据，ownerKey 本身
      // 就是公开可见的索引键（契约 §1）。算法与站点 hashMemoryOwnerKey 逐字
      // 相同：UTF-8 → SHA-256 → 前 12 bytes → 小写 hex（24 字元）。
      memoryOwnerKeyHash: createHash("sha256").update(state.apiKey, "utf8").digest().subarray(0, 12).toString("hex"),
    }
    const key = (process.env.HARNESS_API_KEY || "").trim()
    if (!key) {
      console.error("[gateway] workflow completion push skipped: HARNESS_API_KEY 未配置")
      return
    }
    const res = await fetch(SITE_COMPLETION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.error(`[gateway] workflow completion push failed: HTTP ${res.status} ${text.slice(0, 200)} wf=${wfid}`)
      return
    }
    console.log(`[gateway] workflow completion pushed: wf=${wfid} status=${status} nodes=${nodes.length} cost=${payload.totalCostCoins}`)
  } catch (e) {
    console.error(`[gateway] workflow completion push failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** @deprecated 生产路径禁止读取。仅保留导出，避免旧测试编译失败；业务只读参数或 wf.owner。 */
export let stateForWorkflow: SessionState | null = null

const WORKFLOW_SESSION_MAP_CAP = 2000
function capMap<K, V>(map: Map<K, V>, cap = WORKFLOW_SESSION_MAP_CAP): void {
  const orig = map.set.bind(map)
  map.set = ((key: K, value: V) => {
    if (!map.has(key) && map.size >= cap) {
      const oldest = map.keys().next().value as K | undefined
      if (oldest !== undefined) map.delete(oldest)
    }
    return orig(key, value)
  }) as typeof map.set
}
function capSet<T>(set: Set<T>, cap = WORKFLOW_SESSION_MAP_CAP): void {
  const orig = set.add.bind(set)
  set.add = ((value: T) => {
    if (!set.has(value) && set.size >= cap) {
      const oldest = set.keys().next().value as T | undefined
      if (oldest !== undefined) set.delete(oldest)
    }
    return orig(value)
  }) as typeof set.add
}
capSet(workflowCompletionPushed)

// ---- 工作流持久化（2026-08-27 修复，与 canvasSnapshot 同构）----
// 根因：workflow 状态只在内存 Map（workflowService.workflows），gateway 重启即丢，
// 跑到一半的 8 环流水线彻底失联；canvas 快照已持久化、工作流没有——不一致。
// 修复：ActiveWorkflow 的可恢复子集镜像进 owner session 的 workflowSnapshot
// 栏位（随 session 防抖落盘），重启懒加载时回灌 workflowService（running →
// error「服务重启中断」，不伪造还在跑）。单 session 只镜像最新工作流——
// 同 session 反覆 start 属异常路径，覆盖即止，不做多工作流列表。
// 前置声明：markDirty 引用 workflowOwnerBySession，const 提升安全（仅在请求
// 处理时执行，远晚于模组顶层求值）。
export const workflowOwnerBySession = new Map<string, string>() // sessionId -> workflowId
capMap(workflowOwnerBySession)
// F1（2026-08-31）断点续跑登记表：每进程每工作流只自动续跑一次，防循环重试。
export const autoResumedWorkflows = new Set<string>()
capSet(autoResumedWorkflows)

/**
 * H8（2026-10-02）：节点失败文案必须带 failure_class + 上游原文首句。
 * 旧文案把本地配置/解析错与上游错一律洗成「执行侧无可用供应商/上游渠道未能执行」，
 * orchestrator 据此对用户说「瓶颈不在我们这边」。现在 class 与原文原样外露，
 * 归因只准引用它们（见 AGENTS.md 4.8）。
 */
export function firstSentence(raw: unknown, max = 160): string {
  const t = String(raw ?? "").trim()
  if (!t) return ""
  const m = t.split(/[。！？!?\n]/)[0].trim()
  return (m || t).slice(0, max)
}
export function formatNodeFailure(failureClass: unknown, raw: unknown, lead: string, tail = ""): string {
  const cls = typeof failureClass === "string" && failureClass ? failureClass : "unknown"
  const first = firstSentence(raw)
  return `${lead} [failure_class=${cls}]${first ? `，原文：「${first}」` : "，原文：（无）"}${tail}`
}

// ── 修 2（2026-09-01）计费终态留痕 + billing 真值 ─────────────────────
// 实测实锤（会话 f340fcab/8b7dc1fd）：批量 confirm approved 25.001/75.001 币后
// 节点失败，ledger 零 refund 零 done，agent 却对用户说「未产生成功扣款」——
// 话术无帐本依据。本表记每工作流的批准/退款真值：
//   confirm approved 时记 confirmed；节点失败时照抄 emitImageFailed 的
//   event:"refunded" 轮子写 ledger 终态行 + 刷余额；workflow_status 工具结果
//   注入 billing 对象，agent 话术只许引用真值。
export interface WorkflowBillingTruth {
  confirmed_coins: number
  refunded_coins: number
  billing_status: "confirmed" | "refunded" | "settled"
  /** H13：逐次批准额明细（confirmed_coins = 其总和）。 */
  approvals?: number[]
  /** 2026-10-02：控面实扣币数（终态时由 settleWorkflowCharges 按控面 job 回填；单一真源）。 */
  charged_coins?: number
  /** 实扣 - 报价（正＝多扣；孤儿镜等）。 */
  deviation_coins?: number
}
export const workflowBilling = new Map<string, WorkflowBillingTruth>()
capMap(workflowBilling)

/**
 * H13（2026-10-02）：批准额累加而非覆写。旧版每次 approve 直接 set 覆写，同一 wf
 * 第二次 approve（1210.01）抹掉第一次（460），refund 只退最后一笔（750.005）→
 * 批准总额与退款不对称。现在逐次累加 confirmed_coins，并记 approvals 逐次明细；
 * 已退款的 wf 再批准新一笔时退款额保留、状态回 confirmed，终态再退「未退部分」。
 */
export function recordWorkflowApproval(wfid: string, amount: number): WorkflowBillingTruth {
  const prev = workflowBilling.get(wfid)
  const add = Number.isFinite(amount) && amount > 0 ? amount : 0
  const approvals = [...(prev?.approvals ?? []), add]
  const next: WorkflowBillingTruth = {
    confirmed_coins: Math.round(((prev?.confirmed_coins ?? 0) + add) * 1e6) / 1e6,
    refunded_coins: prev?.refunded_coins ?? 0,
    billing_status: "confirmed",
    approvals,
  }
  workflowBilling.set(wfid, next)
  return next
}

/** 修 2：节点失败 → 该工作流退款留痕（每工作流只记一次）+ 余额刷新。 */
export function recordWorkflowRefund(state: SessionState, wfid: string, chargedCoins = 0): void {
  const billing = workflowBilling.get(wfid)
  if (!billing) return
  // H13：只退「已批准但尚未退」的部分；累加后 refunded 与 approve 总额对称。
  // 2026-10-02：chargedCoins＝控面实扣（终态传入），退款＝批准额 − 实扣 − 已退；缺省 0＝旧语义（测试锁）。
  const toRefund = Math.round((billing.confirmed_coins - chargedCoins - billing.refunded_coins) * 1e6) / 1e6
  if (toRefund <= 0) return
  billing.refunded_coins = Math.round((billing.refunded_coins + toRefund) * 1e6) / 1e6
  billing.billing_status = "refunded"
  const wf = workflowService.get(wfid)
  void appendLedgerFor(state, {
    kind: "workflow",
    event: "refunded",
    task_id: wfid,
    model: `workflow:${wf?.templateId ?? "unknown"}`,
    cost_coins: toRefund,
  })
  void emitQuotaChanged(state)
  console.log(`[gateway] workflow refund recorded: wf=${wfid} coins=${toRefund} total_refunded=${billing.confirmed_coins} approvals=${JSON.stringify(billing.approvals ?? [])} session=${state.sessionId}`)
}

// ── 2026-10-02 e2e 成片评测三死线：控面为准的实扣结算 / 排队换道 / 孤儿镜取消 / 直推通报 ──
/** 每工作流提交过的上游 job（供终态向控面结算实扣、停滞/放弃时取消）。 */
export const workflowJobs = new Map<string, Map<string, { nodeId: string; kind: "video" | "image" }>>()
capMap(workflowJobs)
/** 排队超过此时长提示并尝试换同价通道（PM 死线：5 分钟）。 */
export const QUEUE_SWITCH_MS = Number.parseInt(process.env.WORKFLOW_QUEUE_SWITCH_MS || "300000", 10) || 300_000

export function wfidFromNodeId(nodeId: string): string {
  const m = nodeId.match(/^(.+)-[^-]+-\d+$/)
  return m ? m[1] : ""
}

/** 取消控面 job（排队/租约中全额退款，已在飞的由控面 reconcile 兜底）。永不抛。 */
export async function cancelPlatformJob(apiKey: string, taskId: string): Promise<{ cancelled: boolean; note: string }> {
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/generation-jobs/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => ({}))) as { previous_status?: string; refund?: unknown }
    const note = `http=${res.status} previous=${body.previous_status ?? "-"} refund=${JSON.stringify(body.refund ?? null)}`
    console.log(`[gateway] cancel platform job ${taskId}: ${note}`)
    return { cancelled: res.ok, note }
  } catch (e) {
    console.error(`[gateway] cancel platform job ${taskId} failed:`, e)
    return { cancelled: false, note: String((e as Error)?.message ?? e) }
  }
}

/** 同价位（每秒币价逐档不高于当前）且活的备选视频通道；无则 null（明确降级＝继续排队至预算耗尽后取消退款）。 */
export async function pickSamePriceVideoAlternative(model: string, apiKey: string, node: CanvasNode): Promise<string | null> {
  try {
    const models = await fetchModelStatusCached(apiKey)
    if (!models) return null
    const tried = new Set<string>(Array.isArray(node.metadata?.__triedModels) ? (node.metadata!.__triedModels as string[]) : [])
    tried.add(model)
    const cur = await catalogVideoPerSecondCoins(model, apiKey)
    if (!cur) return null
    for (const cand of rankVideoModels(models as ModelStatusEntryLike[], tried)) {
      const p = await catalogVideoPerSecondCoins(cand.id, apiKey)
      if (!p) continue
      const keys = Object.keys(p).filter((k) => k in cur)
      if (keys.length && keys.every((k) => p[k] <= cur[k])) return cand.id
    }
  } catch (e) {
    console.error("[gateway] pickSamePriceVideoAlternative failed:", e)
  }
  return null
}

export interface WorkflowChargeReport {
  quoted: number | null
  charged: number
  orphanCoins: number
  orphanJobs: string[]
  source: "control_plane" | "gateway_nodecost"
  /** 成功但控面帐本尚未落帐的 job 数（>0＝实扣为下限，结算中）。 */
  unresolved: number
}

/**
 * 计费单一真源：向控面逐 job 查实扣（succeeded 的 cost_coins＝account_ledger consumption），
 * 孤儿＝成功扣费但节点最终没用上的 job。回填 billing 真值并按「批准额 - 控面实扣」记退款留痕。
 */
export async function settleWorkflowCharges(state: SessionState, wfid: string): Promise<WorkflowChargeReport> {
  const wf = workflowService.get(wfid)
  const billing = workflowBilling.get(wfid)
  const jobs = workflowJobs.get(wfid)
  let charged = 0
  let orphanCoins = 0
  const orphanJobs: string[] = []
  let unresolved = 0
  let source: WorkflowChargeReport["source"] = "control_plane"
  if (jobs && jobs.size > 0) {
    for (const [taskId, j] of jobs) {
      try {
        // 控面帐本投影有秒级延迟：job 刚 succeeded 时 cost_coins 可能还是 null/0（实测 12:01:52 查到 0、35s 后 130）。
        // 对「成功但费用未落帐」的 job 重试至多 8 次×5s；仍未落帐＝结算中，不记退款、不伪造实扣。
        let d: { status?: string; cost_coins?: number | null } = {}
        for (let attempt = 0; attempt < 8; attempt++) {
          const r = await fetch(`${PLATFORM_BASE}/v1/${j.kind === "video" ? "videos" : "images"}/${encodeURIComponent(taskId)}`, {
            headers: { Authorization: `Bearer ${state.apiKey}` },
            signal: AbortSignal.timeout(10_000),
          })
          d = (await r.json().catch(() => ({}))) as typeof d
          if (d.status !== "succeeded" || (typeof d.cost_coins === "number" && d.cost_coins > 0)) break
          if (attempt < 7) await new Promise((res) => setTimeout(res, 5000))
        }
        if (d.status === "succeeded" && !(typeof d.cost_coins === "number" && d.cost_coins > 0)) unresolved++
        if (d.status === "succeeded" && typeof d.cost_coins === "number") {
          charged += d.cost_coins
          const node = wf?.graph.nodes.find((n) => n.id === j.nodeId)
          const used = node && node.metadata?.last_job_id === taskId && wf?.nodeStatus[j.nodeId] === "success"
          if (!used) {
            orphanCoins += d.cost_coins
            orphanJobs.push(taskId.slice(0, 8))
          }
        }
      } catch (e) {
        console.error(`[gateway] settle charge query failed job=${taskId}:`, e)
      }
    }
  } else if (wf) {
    source = "gateway_nodecost"
    for (const v of Object.values(wf.nodeCost)) if (typeof v === "number") charged += v
  }
  charged = Math.round(charged * 1e6) / 1e6
  orphanCoins = Math.round(orphanCoins * 1e6) / 1e6
  if (billing) {
    billing.charged_coins = charged
    billing.deviation_coins = Math.round((charged - billing.confirmed_coins) * 1e6) / 1e6
    // 有 job 实扣尚未落帐时不记退款（否则把「还没查到」当「没扣」，退款偏大）；下一次结算补记。
    if (unresolved === 0) recordWorkflowRefund(state, wfid, charged)
  }
  console.log(`[gateway] workflow charges settled: wf=${wfid} quoted=${billing?.confirmed_coins ?? "-"} charged=${charged} orphan=${orphanCoins}[${orphanJobs.join(",")}] source=${source}`)
  return { quoted: billing?.confirmed_coins ?? null, charged, orphanCoins, orphanJobs, source, unresolved }
}

/** 已直推过通报的 key（wfid:kind）。 */
export const workflowNoticeSent = new Set<string>()
capSet(workflowNoticeSent)

/**
 * 工作流终态/停滞直推通报（不经 LLM、不依赖 4096 唤醒）：SSE message.delta，含成片连结与控面实扣。
 * kind="final" 与 "stalled" 各发一次——停滞判死后仍跑完的工作流（评测 08:46 完成无人知）会再收到 final。
 */
export async function sendWorkflowNotice(state: SessionState, wfid: string, kind: "final" | "stalled"): Promise<void> {
  const key = `${wfid}:${kind}`
  if (workflowNoticeSent.has(key)) return
  workflowNoticeSent.add(key)
  try {
    const wf = workflowService.get(wfid)
    if (!wf) return
    const report = await settleWorkflowCharges(state, wfid)
    const status = wf.status as string
    const filmNode = wf.graph.nodes.find((n) => n.kind === "film" && wf.nodeContent[n.id])
    const videoUrls = wf.graph.nodes.filter((n) => n.kind === "video" && wf.nodeContent[n.id]).map((n) => wf.nodeContent[n.id])
    const failed = wf.graph.nodes.filter((n) => wf.nodeStatus[n.id] === "error").map((n) => n.title || n.id)
    const head =
      kind === "stalled"
        ? "工作流长时间无进度，已判定停滞并按失败处理"
        : status === "success"
          ? "工作流已完成"
          : status === "partial"
            ? "工作流部分完成"
            : "工作流未能完成"
    const lines = [`【${head}】`]
    if (filmNode) lines.push(`成片：${wf.nodeContent[filmNode.id]}`)
    else if (videoUrls.length) lines.push(`镜头产物：${videoUrls.join(" ")}`)
    else {
      const imageUrls = wf.graph.nodes.filter((n) => n.kind === "image" && wf.nodeContent[n.id]).map((n) => wf.nodeContent[n.id])
      if (imageUrls.length) lines.push(`图片产物：${imageUrls.join(" ")}`)
    }
    if (failed.length) lines.push(`失败节点：${failed.join("、")}`)
    const dev = report.quoted !== null ? Math.round((report.charged - report.quoted) * 1e6) / 1e6 : null
    lines.push(
      `费用（以控制面账本为准）：实扣 ${report.charged} 币` +
        (report.quoted !== null ? `，报价 ${report.quoted} 币，偏差 ${dev! > 0 ? "+" : ""}${dev} 币` : "") +
        (report.unresolved > 0 ? `；另有 ${report.unresolved} 个镜头的扣费仍在控制面结算中，此数为下限` : "") +
        (report.orphanCoins > 0 ? `；其中 ${report.orphanCoins} 币来自未被成片采用的镜头（job ${report.orphanJobs.join("/")}），可联系客服核退` : ""),
    )
    emitToSession(state, "message.delta", { text: lines.join("\n") + "\n" })
  } catch (e) {
    console.error(`[gateway] sendWorkflowNotice failed wf=${wfid}:`, e)
  }
}

// ── 修 3（2026-09-01）长任务交接：唤醒登记表 + 扫描器 ────��─────────��───
// workflow_generate 提交后 turn 诚实结束；工作流到终态或停滞（15 分钟无节点
// 进度）时向原会话投 resume 唤醒（轮子 = handleResumeSession 的 prompt_async
// 投递 + turn 状态重置）。扫描器是进程内唯一的 workflow 状态观察点——
// workflowService.generate 的 promise 在 runWfGenerate 手里，poller 摸不到
// 内存工作流状态，故挂 gateway 不挂 poller（最小改动路径）。
export const workflowWake = new Map<string, { sessionId: string; lastProgressAt: number }>()
capMap(workflowWake)
export const WORKFLOW_STALL_MS = Number.parseInt(process.env.WORKFLOW_STALL_MS || "360000", 10) || 360_000
export const WORKFLOW_WAKE_SCAN_MS = 60_000

/** execute_command 工具回应形状（waveform.ts/master.ts 同款；stage2 整合时改共用汇出）。 */
interface CommandResult { stdout: string; stderr: string; exit_code: number }

/** 画布节点的宽松形状（graph.nodes 是 unknown[]，消费端逐点收窄）。 */
type CanvasNode = { id?: unknown; kind?: unknown; metadata?: Record<string, unknown> }
/** 谓词收窄形状：graph.nodes 元素（id/role/kind/metadata）去除 undefined 的真子类型。 */
type VideoUpstream = { id: string; role: string; kind: string; metadata: Record<string, unknown> }
type AudioUpstream = VideoUpstream
type ImageUpstream = VideoUpstream

export type PersistableWorkflow = {
  workflowId: string
  templateId: string
  graph: { nodes: CanvasNode[]; connections: unknown[] }
  status: string
  nodeStatus: Record<string, string>
  nodeContent: Record<string, string>
  nodeCost: Record<string, number>
}

/** ActiveWorkflow → 可 JSON 化快照（Set 去重状态不持久——恢复后全部视为已发过，避免重启后重推前端）。 */
export function workflowSnapshotOf(wf: {
  workflowId: string
  templateId: string
  graph: { nodes: CanvasNode[]; connections: unknown[] }
  status: string
  nodeStatus: Record<string, string>
  nodeContent: Record<string, string>
  nodeCost: Record<string, number>
}): PersistableWorkflow {
  return {
    workflowId: wf.workflowId,
    templateId: wf.templateId,
    graph: { nodes: wf.graph.nodes, connections: wf.graph.connections },
    status: wf.status,
    nodeStatus: { ...wf.nodeStatus },
    nodeContent: { ...wf.nodeContent },
    nodeCost: { ...wf.nodeCost },
  }
}

/** markDirty 用：取该 session 当前工作流的最新快照；工作流已不在内存 → 保留旧镜像（清 null）。 */
export function workflowSnapshotFor(state: SessionState): Record<string, unknown> | undefined {
  const wfid = workflowOwnerBySession.get(state.sessionId)
  if (!wfid) return undefined
  const wf = workflowService.get(wfid)
  if (!wf) return state.workflowSnapshot // 已被清掉：保留最后已知状态
  return workflowSnapshotOf(wf)
}

/**
 * DB 快照 → ActiveWorkflow 回灌（hydrate 路径，对齐 canvasSnapshot → canvasStates）。
 * 语义：中断时正在 running 的节点标 error（reason「服务重启中断」）——重启后的
 * status 回应必须是真实状态，不伪造还在跑。emit 去重集合全量视为已发（重启后
 * generate 补发只走漏网兜底，不对已恢复节点重播）。
 */
export function restoreWorkflowsFromSnapshot(state: SessionState): void {
  const snap = state.workflowSnapshot
  if (!snap || typeof snap !== "object") return
  const s = snap as Partial<PersistableWorkflow>
  if (typeof s.workflowId !== "string" || !s.workflowId) return
  if (workflowService.get(s.workflowId)) {
    workflowOwnerBySession.set(state.sessionId, s.workflowId)
    return // 已回灌过（幂等）
  }
  const graph = s.graph && typeof s.graph === "object" && Array.isArray((s.graph as { nodes?: unknown[] }).nodes) ? (s.graph as { nodes: unknown[]; connections?: unknown[] }) : null
  if (!graph) return
  const nodeStatus: Record<string, "pending" | "running" | "success" | "error" | "skipped"> = {}
  const interrupted: string[] = []
  for (const [id, st] of Object.entries(s.nodeStatus ?? {})) {
    if (st === "running") {
      // 服务重启中断：执行循环已死，这个节点不可能还在跑——诚实标错，不伪造。
      nodeStatus[id] = "error"
      interrupted.push(id)
    } else if (st === "pending" || st === "success" || st === "error" || st === "skipped") {
      nodeStatus[id] = st
    }
  }
  const restored = {
    workflowId: s.workflowId,
    templateId: typeof s.templateId === "string" ? s.templateId : "custom",
    graph: { nodes: graph.nodes, connections: Array.isArray(graph.connections) ? graph.connections : [] },
    status: interrupted.length > 0 ? "failed" : (typeof s.status === "string" ? (s.status as "building" | "running" | "success" | "partial" | "failed") : "building"),
    nodeStatus,
    nodeContent: s.nodeContent && typeof s.nodeContent === "object" ? { ...s.nodeContent } : {},
    nodeCost: s.nodeCost && typeof s.nodeCost === "object" ? { ...s.nodeCost } : {},
    owner: state, // 重新绑定恢复后的 session 物件（旧 owner 已随重启消失）
    planEmitted: true,
    emittedNodes: new Set((graph.nodes as { id?: unknown }[]).map((n) => (typeof n?.id === "string" ? n.id : "")).filter(Boolean)),
    emittedConnections: new Set(((Array.isArray(graph.connections) ? graph.connections : []) as { from?: unknown; to?: unknown }[]).map((c) => `${c?.from}->${c?.to}`)),
  }
  // 同步镜像回 session：恢复后的快照（running→error 转换）也要落盘，
  // 否则下次重启又会把同一批 error 节点当 running 再转一次（结果幂等但状态漂移）。
  state.workflowSnapshot = workflowSnapshotOf(restored)
  workflowService.restore(restored as never)
  workflowOwnerBySession.set(state.sessionId, restored.workflowId)
  dirtySessions.add(state.sessionId) // 恢复后的镜像随防抖落盘（running→error 转换持久化）
  console.log(`[gateway] workflow restored from db: ${restored.workflowId} (${restored.templateId}, ${interrupted.length} interrupted node(s) -> error)`)
  // Q2/Q3（2026-08-27）：恢复不只写日志——中断节点逐一翻面（画布幽灵 running
  // → error）+ 一条面向用户的说明消息（含已成功产物 URL 清单与已扣费，孤儿
  // 产物捞回）。emit 走 replayBuffer（emitToSession），前端 Last-Event-ID 续传
  // 也能收到；不依赖任何人在线。
  if (interrupted.length > 0) {
    for (const nodeId of interrupted) {
      // 2026-10-02：重启中断的节点其上游 job 仍在控面排队/在飞；F1 续跑会另提交新 job，旧 job 日后成功
      // 就是孤儿镜（重复扣费）。先取消（排队中全额退款），并登记进 job 表，终态结算时如实对账。
      const interruptedMeta = (graph.nodes as { id?: unknown; kind?: unknown; metadata?: Record<string, unknown> }[]).find((n) => n?.id === nodeId)
      const oldJob = typeof interruptedMeta?.metadata?.last_job_id === "string" ? interruptedMeta.metadata.last_job_id : ""
      if (oldJob) {
        if (!workflowJobs.has(restored.workflowId)) workflowJobs.set(restored.workflowId, new Map())
        workflowJobs.get(restored.workflowId)!.set(oldJob, { nodeId, kind: interruptedMeta?.kind === "video" ? "video" : "image" })
        void cancelPlatformJob(state.apiKey, oldJob)
      }
      const interruptPatch = {
        status: "error" satisfies TaskStatus,
        errorDetails: "服务重启导致任务中断",
        human_message: "服务重启导致任务中断，中断节点未产生成功扣款；如已扣款以平台账单为准，可在画布上重试该节点。",
      }
      emitToSession(state, "canvas.node.updated", {
        node_id: nodeId,
        workflow_id: restored.workflowId,
        patch: interruptPatch,
      })
      // 2026-09-20 写穿：此处直发 emitToSession 绕过 workflowService emit hook，
      // 快照同步在此补上（同一 patch 物件，幂等 last-write-wins）。
      applyCanvasNodeUpdated(state.sessionId, { node_id: nodeId, patch: interruptPatch })
    }
    // 孤儿产物捞回：快照里 success 的 image/video 节点，产物 URL 聚合交付。
    const nodesById = new Map(
      (graph.nodes as { id?: unknown; kind?: unknown; title?: unknown }[]).map((n) => [
        typeof n?.id === "string" ? n.id : "",
        n,
      ]),
    )
    const delivered: string[] = []
    let chargedCoins = 0
    for (const [id, st] of Object.entries(nodeStatus)) {
      if (st !== "success") continue
      const content = restored.nodeContent[id]
      if (typeof content !== "string" || !/^https?:\/\//.test(content)) continue
      const n = nodesById.get(id)
      const kind = typeof n?.kind === "string" ? n.kind : ""
      if (kind !== "image" && kind !== "video" && kind !== "audio" && kind !== "film") continue
      const title = typeof n?.title === "string" && n.title ? n.title : id
      delivered.push(`「${title}」${content}`)
      chargedCoins += typeof restored.nodeCost[id] === "number" ? (restored.nodeCost[id] as number) : 0
    }
    const parts = [
      `【服务重启说明】服务经历过一次重启，工作流（${restored.templateId}）有 ${interrupted.length} 个节点被中断，已在画布上标记为失败，可重试。`,
      delivered.length > 0
        ? `中断前已完成的 ${delivered.length} 个产物如下（已扣费共约 ${chargedCoins} 币）：\n${delivered.join("\n")}`
        : "中断前没有已完成的产物。",
    ]
    emitToSession(state, "message.delta", { text: parts.join("\n") + "\n" })
  }
  // F1（2026-08-31）断点续跑：重启时工作流还在跑（节点被中断，或快照停在
  // running 但进程已死=僵尸 running）→ 恢复后自动续跑。generate() 自带 R5-B
  // 重用语义：success 节点沿用产物不重跑不重扣，只补跑 error/pending。
  // 每进程每工作流只触发一次（autoResumedWorkflows），失败不循环重试；延迟
  // 1.5s 等 hydrate/SSE 重连先完成。paused/building 不自动续（等用户决策）。
  const resumeWorthy = interrupted.length > 0 || restored.status === "running"
  if (resumeWorthy && !autoResumedWorkflows.has(restored.workflowId)) {
    autoResumedWorkflows.add(restored.workflowId)
    if (interrupted.length > 0) {
      emitToSession(state, "message.delta", {
        text: "【自动续跑】检测到上次执行被服务重启中断，正在从断点自动续跑：已成功的节点沿用产物不重跑、不重复扣费，仅补跑失败/未跑的节点。\n",
      })
    }
    const wfid = restored.workflowId
    setTimeout(() => {
      // runNode 读 restore 时绑定的 wf.owner，不写全局 session。
      // 2026-10-02：续跑与 runWfGenerate 同样登记唤醒 + 终态直推（此前 F1 续跑完成零通知——实测 wf_muqf0xbg_1）。
      workflowWake.set(wfid, { sessionId: state.sessionId, lastProgressAt: Date.now() })
      void workflowService
        .generate(wfid)
        .then((r) => {
          console.log(`[gateway] F1 auto-resume finished: ${wfid} -> ${r.status}`)
          void pushWorkflowCompletion(state)
          void sendWorkflowNotice(state, wfid, "final")
        })
        .catch((e) => console.error(`[gateway] F1 auto-resume failed: ${wfid}`, e))
    }, 1500)
    console.log(`[gateway] F1 auto-resume scheduled: ${wfid} (interrupted=${interrupted.length})`)
  }
}

// R7-F（2026-08-29）：成片环后端——Kunpeng composeEngine 轮（gateway/editor/，
// pengfeiqiao/kunpeng pin 872a58b，白名单记账见 repo vendor/kunpeng/PATCHES.md）。
// 沿连线收集上游 video 产物 → title 最前、shotN 升幂排序 → 下载 → setHarnessState
// 注入 clips（真实时长由 ffprobe 逐段探得）→ exportSelectedMainClips（归一化→
// concat copy）→ probeRenderedVideo 校验门 → 落公网目录。拼接本身不另计费
//（costCoins: 0），视频段费用已在各 shot 节点确认。
export async function assembleFilmNode(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  upstream: Map<string, string>,
  graph?: { nodes: { id: string; role: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
  session?: { sessionTitle?: string | null } | null,
): Promise<{ nodeId: string; ok: boolean; content?: string; costCoins?: number; message?: string; error?: string }> {
  const nodeId = (node as { id?: string }).id || ""
  const incoming = (graph?.connections ?? []).filter((c) => c.to === nodeId).map((c) => c.from)
  const allVideoUpstream = incoming
    .map((from) => graph?.nodes.find((n) => n.id === from))
    .filter((n): n is VideoUpstream => Boolean(n) && typeof n.id === "string" && n.kind === "video")
  const sources = allVideoUpstream
    .map((n) => ({ id: n.id, role: n.role, url: upstream.get(n.id) }))
    .filter((s): s is { id: string; role: string; url: string } => Boolean(s.url))
  // 配音混流素材：上游 audio 节点（TTS mp3）的内容 URL，成片后自动混入音轨。
  const audioList = incoming
    .map((from) => graph?.nodes.find((n) => n.id === from))
    .filter((n): n is AudioUpstream => Boolean(n) && typeof n.id === "string" && n.kind === "audio")
    .map((n) => upstream.get(n.id))
    .filter((u): u is string => Boolean(u))
  if (!sources.length) {
    return { nodeId, ok: false, error: "成片环没有已完成的镜头输入：请先完成各视频节点，再执行成片" }
  }
  // P0-B 硬闸门（2026-08-31）：宣告的镜头数（上游 video 节点总数）必须等于实际拿到
  // 产物的数量。缺一个都不能拼——修复本次事故「宣告4镜头、实际1镜头仍标success」。
  if (sources.length < allVideoUpstream.length) {
    const missing = allVideoUpstream.filter((n) => !upstream.get(n.id)).map((n) => n.id)
    return {
      nodeId,
      ok: false,
      error: `成片环镜头数量不足：宣告 ${allVideoUpstream.length} 个镜头，仅 ${sources.length} 个完成（缺：${missing.join("、")}）。请先完成全部镜头节点再执行成片`,
    }
  }
  const orderOf = (id: string): number => {
    if (id.includes("title")) return -1
    const m = id.match(/shot(\d+)/)
    return m ? Number(m[1]) : 900
  }
  sources.sort((a, b) => orderOf(a.id) - orderOf(b.id))

  const { setHarnessState, DEFAULT_EXPORT_SETTINGS } = await import("./editor/adapter/editorStore")
  const { exportSelectedMainClips, probeRenderedVideo } = await import("./editor/composeEngine")
  const { detectFfmpeg } = await import("./editor/canvas/videoCompose")
  const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`
  const { invoke } = await import("./editor/adapter/tauri-adapter")

  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) return { nodeId, ok: false, error: "未检测到 ffmpeg：成片拼接后端不可用" }

  const workDir = path.join(TTS_AUDIO_DIR, `film-src-${Date.now()}`)
  await mkdir(workDir, { recursive: true })
  try {
    const clipIds: string[] = []
    const clipSecs: number[] = []
    let totalInputSec = 0
    for (let i = 0; i < sources.length; i += 1) {
      const clipPath = path.join(workDir, `clip_${i}.mp4`)
      // 平台产物 URL 直接映射本盘路径（store.tinchak0207.xyz = image-data-api 的公网面，
      // VPS 内 fetch 公网回环慢且不稳）；非平台 URL 才走网络下载。
      const diskBase = "/opt/image-data-api/data"
      const m = sources[i].url.match(/^https:\/\/store\.tinchak0207\.xyz\/image-data\/files\/(.+)$/)
      if (m) {
        const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join(diskBase, m[1]))} ${shq(clipPath)}`, timeoutMs: 30000 })
        if (cp.exit_code !== 0) return { nodeId, ok: false, error: "成片环读取镜头素材失败（本地产物缺失）" }
      } else {
        const res = await fetch(sources[i].url, { signal: AbortSignal.timeout(120_000) })
        if (!res.ok) return { nodeId, ok: false, error: `成片环下载镜头素材失败（http ${res.status}）` }
        await Bun.write(clipPath, res)
      }
      const probe = await invoke<CommandResult>("execute_command", {
        command: `${ffmpeg.replace(/ffmpeg$/, "ffprobe")} -v error -show_entries format=duration -of csv=p=0 ${shq(clipPath)}`,
        timeoutMs: 15000,
      })
      const dur = Number.parseFloat((probe.stdout || "").trim())
      const sec = Number.isFinite(dur) && dur > 0 ? dur : 0
      if (sec <= 0) return { nodeId, ok: false, error: "成片环读不到镜头时长（ffprobe 失败），拒绝盲拼" }
      totalInputSec += sec
      clipIds.push(`h${i}`)
      clipSecs.push(sec)
    }
    // 字幕轨 + 标题字：台词时间只用已探到的 TTS/音频时长。没有真实时长不铺满镜头。
    // 标题单独占 0..titleEnd，不改台词的 startSec。
    const subTextOfShot = (videoRole: string): string => {
      const shotRole = videoRole.replace(/_video$/, "")
      const scriptNode = graph?.nodes.find((n) => n.role === shotRole && n.kind === "text")
      const md = scriptNode?.metadata
      const raw = typeof md?.content === "string" ? md.content : typeof md?.text === "string" ? md.text : typeof md?.prompt === "string" ? md.prompt : ""
      return raw.trim()
    }
    type StagedAudio = { path: string; durationSec: number | null }
    const stagedAudios: StagedAudio[] = []
    let audioStageError: string | null = null
    if (audioList.length > 0) {
      try {
        for (let i = 0; i < audioList.length; i += 1) {
          const aPath = path.join(workDir, `audio_${i}.mp3`)
          const mTts = audioList[i].match(/^https:\/\/store\.tinchak0207\.xyz\/agent\/v1\/audio\/([^/?#]+)$/)
          const mDisk = audioList[i].match(/^https:\/\/store\.tinchak0207\.xyz\/image-data\/files\/(.+)$/)
          if (mTts && !mTts[1].includes("..")) {
            const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join(TTS_AUDIO_DIR, mTts[1]))} ${shq(aPath)}`, timeoutMs: 30000 })
            if (cp.exit_code !== 0) throw new Error("平台音频本盘缺失")
          } else if (mDisk && !mDisk[1].includes("..")) {
            const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join("/opt/image-data-api/data", mDisk[1]))} ${shq(aPath)}`, timeoutMs: 30000 })
            if (cp.exit_code !== 0) throw new Error("平台音频本盘缺失")
          } else {
            const res = await fetch(audioList[i], { signal: AbortSignal.timeout(120_000) })
            if (!res.ok) throw new Error(`音频下载失败（http ${res.status}）`)
            await Bun.write(aPath, res)
          }
          const aProbe = await invoke<CommandResult>("execute_command", {
            command: `${ffmpeg.replace(/ffmpeg$/, "ffprobe")} -v error -show_entries format=duration -of csv=p=0 ${shq(aPath)}`,
            timeoutMs: 15000,
          })
          const aDur = Number.parseFloat((aProbe.stdout || "").trim())
          stagedAudios.push({ path: aPath, durationSec: Number.isFinite(aDur) && aDur > 0 ? aDur : null })
        }
      } catch (e) {
        audioStageError = String((e as Error).message ?? e).slice(0, 200)
        stagedAudios.length = 0
        console.log(`[workflow] assembleFilm audio stage deferred: ${audioStageError}`)
      }
    }
    const projectTitle = String(
      node.metadata?.project_title ?? session?.sessionTitle ?? "",
    ).trim()
    const subtitleCues: { id: string; startSec: number; endSec: number; text: string }[] = []
    {
      const dialogueIdx: number[] = []
      for (let i = 0; i < sources.length; i += 1) {
        if (subTextOfShot(sources[i].role)) dialogueIdx.push(i)
      }
      const pairByShot = stagedAudios.length === sources.length && sources.length > 0
      const pairByLine = !pairByShot && dialogueIdx.length > 0 && stagedAudios.length === dialogueIdx.length
      let cursor = 0
      let lineAudio = 0
      for (let i = 0; i < sources.length; i += 1) {
        const text = subTextOfShot(sources[i].role)
        let dur: number | null = null
        if (pairByShot) dur = stagedAudios[i]?.durationSec ?? null
        else if (pairByLine && text) dur = stagedAudios[lineAudio++]?.durationSec ?? null
        if (text && dur != null && dur > 0) {
          subtitleCues.push({ id: `sub_${i}`, startSec: cursor, endSec: cursor + dur, text })
        }
        cursor += clipSecs[i]
      }
      if (projectTitle) {
        const titleEnd = Math.min(3, Math.max(1, clipSecs[0] ?? 3))
        subtitleCues.unshift({ id: "title", startSec: 0, endSec: titleEnd, text: projectTitle })
      }
    }
    setHarnessState({
      clips: sources.map((_, i) => ({
        id: `h${i}`,
        path: path.join(workDir, `clip_${i}.mp4`),
        label: `seg${i}`,
        duration: clipSecs[i],
        inSec: 0,
        outSec: clipSecs[i],
        transitionAfter: { type: "none", duration: 0 },
      })),
      aspect: "16:9",
      exportSettings: { ...DEFAULT_EXPORT_SETTINGS, resolution: "720p", fps: 24 },
      subtitles: subtitleCues,
    })
    const outPath = await exportSelectedMainClips(clipIds)
    const probe = await probeRenderedVideo(ffmpeg, outPath)
    // 校验门：成片时长不得低于各段输入时长总和的 90%（归一化重编码允许微小误差）
    const minSec = Math.floor(totalInputSec * 0.9)
    if (probe.durationSec < minSec) {
      return { nodeId, ok: false, error: `成片校验未通过：成片 ${probe.durationSec}s 低于输入总长 ${totalInputSec}s 的 90%` }
    }
    // 配音混流（2026-08-30）：audioList 非空时把 TTS 音轨混进成片。禁 -shortest
    //（不准截断视频）；混流任何一步失败降级纯视频成片，message 注明，不整单报错。
    let mixedPath = outPath
    let mixNote = ""
    if (audioList.length > 0) {
      try {
        if (audioStageError || stagedAudios.length !== audioList.length) {
          throw new Error(audioStageError || "配音素材未齐")
        }
        const audioPaths = stagedAudios.map((a) => a.path)
        let totalAudioSec = 0
        for (const a of stagedAudios) {
          if (a.durationSec != null && a.durationSec > 0) totalAudioSec += a.durationSec
        }
        let trackPath = audioPaths[0]
        if (audioPaths.length > 1) {
          const listPath = path.join(workDir, "audio-list.txt")
          await Bun.write(listPath, audioPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n")
          trackPath = path.join(workDir, "audio-merged.m4a")
          const merged = await invoke<CommandResult>("execute_command", {
            command: `${ffmpeg} -y -f concat -safe 0 -i ${shq(listPath)} -c:a aac ${shq(trackPath)}`,
            timeoutMs: 120000,
          })
          if (merged.exit_code !== 0) throw new Error(`多轨合并失败: ${(merged.stderr || "").slice(-200)}`)
        }
        const mixedOut = path.join(workDir, "film-mixed.mp4")
        const mixed = await invoke<CommandResult>("execute_command", {
          command: `${ffmpeg} -y -i ${shq(outPath)} -i ${shq(trackPath)} -map 0:v -map 1:a -c:v copy -c:a aac -movflags +faststart ${shq(mixedOut)}`,
          timeoutMs: 300000,
        })
        if (mixed.exit_code !== 0) throw new Error(`混流失败: ${(mixed.stderr || "").slice(-200)}`)
        mixedPath = mixedOut
        // P0-B（2026-08-31）：配音时长明显短于成片时长 = 覆盖不足，本次事故音轨只有
        // 0.936 秒配 15.04 秒成片，混流「成功」但实质失能。不阻断交付（降级不是硬
        // 失败，跟现有「混流失败降级纯视频」的宽容度一致），仅把警讯写进 mixNote。
        if (totalAudioSec > 0 && totalAudioSec < probe.durationSec * 0.5) {
          mixNote = `配音时长（${totalAudioSec.toFixed(1)}s）明显短于成片时长（${probe.durationSec}s），已交付但音轨覆盖不足，请检查配音节点`
          console.log(`[workflow] assembleFilm audio too short: audio=${totalAudioSec}s film=${probe.durationSec}s`)
        }
      } catch (e) {
        mixNote = "配音混流失败，已交付无音轨版本"
        console.log(`[workflow] assembleFilm audio mix degraded: ${String((e as Error).message ?? e).slice(0, 200)}`)
      }
    }
    // 2026-10-02 成片质检门（e2e 评测：-38.5 LUFS 未正规化、结尾 1.3s 冻结照样导出）：
    // 响度正规化到 -16 LUFS + 修剪结尾冻结/黑帧；修不了则交付原片并在 message 如实注明。永不抛错。
    try {
      const { qcAndFixFilm } = await import("./film-qc")
      const qc = await qcAndFixFilm(ffmpeg, mixedPath, path.join(workDir, "film-qc.mp4"))
      mixedPath = qc.path
      if (qc.notes.length) mixNote = [mixNote, ...qc.notes].filter(Boolean).join("；")
      console.log(`[workflow] assembleFilm QC: changed=${qc.changed} lufs=${qc.before.lufs}->${qc.after?.lufs ?? "-"} dur=${qc.before.durationSec}->${qc.after?.durationSec ?? "-"} notes=${qc.notes.join("|").slice(0, 200)}`)
    } catch (e) {
      console.log(`[workflow] assembleFilm QC skipped: ${String((e as Error).message ?? e).slice(0, 160)}`)
    }
    const fileName = `film_${Date.now().toString(36)}.mp4`
    await mkdir(TTS_AUDIO_DIR, { recursive: true })
    await Bun.write(path.join(TTS_AUDIO_DIR, fileName), Bun.file(mixedPath))
    return { nodeId, ok: true, content: `${TTS_PUBLIC_BASE}/${fileName}`, costCoins: 0, ...(mixNote ? { message: mixNote } : {}) }
  } finally {
    const { rm } = await import("node:fs/promises")
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 提交单一节点生成：image → /v1/images/generations；video → /v1/videos/generations。
 * 非同步提交后轮询（202 → task_id → GET {id} → succeeded → result url）。
 * 回传 OpenAI 相容结果 {ok, content(url), costCoins?}。
 */
// INC-0830：沿连线找视频节点上游连接的视频 config 节点（kind=config 且 metadata.kind==="video"），
// 取其 duration_seconds——模板把时长配在 config 节点上，submit 时与 meta/shot 同为时长真源。
export function resolveConnectedVideoDuration(
  nodeId: string,
  graph?: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): number | undefined {
  if (!graph) return undefined
  const cfgIds = graph.connections.filter((c) => c.to === nodeId).map((c) => c.from)
  for (const cid of cfgIds) {
    const cfg = graph.nodes.find((n) => n.id === cid)
    if (cfg && cfg.kind === "config" && cfg.metadata.kind === "video") {
      const d = cfg.metadata.duration_seconds
      if (typeof d === "number" && d > 0) return d
    }
  }
  return undefined
}

// F2（2026-08-31）：model-status 15s TTL 快取——旧版每个节点提交前都重新打一次
// /v1/model-status，长 workflow 节点多时等于每节点多一次探测延迟+一次上游打扰。
export const MODEL_STATUS_TTL_MS = 15_000
export let modelStatusCache: { at: number; models: Array<Record<string, unknown>> } | null = null

export async function fetchModelStatusCached(apiKey: string): Promise<Array<Record<string, unknown>> | null> {
  const now = Date.now()
  if (modelStatusCache && now - modelStatusCache.at < MODEL_STATUS_TTL_MS) return modelStatusCache.models
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1/model-status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
    const data = await res.json().catch(() => null)
    const models = Array.isArray((data as { models?: unknown })?.models) ? ((data as { models: Array<Record<string, unknown>> }).models) : null
    if (models) {
      modelStatusCache = { at: now, models }
      return models
    }
  } catch {
    // 探测不可达：沿用旧快取（fail-open），完全没快取则回 null 由呼叫方决定
  }
  return modelStatusCache?.models ?? null
}

/** M4：近 24h 影片零交付判定（available>0 且 delivered>0 者为 0）。探测不可达回 null（fail-open）。 */
export async function videoZeroDelivery24h(apiKey: string): Promise<{ available: string[] } | null> {
  const models = await fetchModelStatusCached(apiKey)
  if (!models) return null
  const vids = (models as Array<{ id?: string; media_type?: string; availability?: string; last_24h?: { delivered?: unknown } }>).filter((m) => m.media_type === "video")
  const available = vids.filter((m) => m.availability === "available")
  if (available.length === 0) return null
  const proven = available.filter((m) => Number(m.last_24h?.delivered ?? 0) > 0)
  return proven.length === 0 ? { available: available.map((m) => String(m.id)) } : null
}

/**
 * F2（2026-08-31）路由单真源 + 强制跨 provider failover：原逻辑发现模型
 * unavailable 就直接报错要人手动换模型——这里改成主动在同 media_type、不同
 * channel_id 的候选里挑一个接著跑，找不到候选才诚实报错（不编造成功）。
 * node.metadata.__triedChannels 记录本节点已知死的渠道，跨重试/跨崩溃恢复
 * （随 workflow 快照持久化）都不会再选回去。
 */
export async function resolveActiveModel(
  model: string,
  kind: "image" | "video",
  apiKey: string,
  node: CanvasNode,
): Promise<{ model: string; switched: boolean; note?: string; exhausted?: boolean; error?: string }> {
  const models = await fetchModelStatusCached(apiKey)
  if (!models) return { model, switched: false } // 探测端不可达：fail-open，行为与旧版一致
  const entry = models.find((m) => (m as { id?: string }).id === model) as
    | { id: string; media_type?: string; availability?: string; channel_id?: string; note?: string; last_24h?: { success_rate?: number } }
    | undefined
  // 2026-10-02 MODEL-SELECT：视频不再只认 availability==="unavailable"——断路器 open、
  // 近 24h 足量单 0 交付也视为死模型，生成前换成 proven 最高者并留回执（node.metadata.model_swap）。
  if (kind === "video") {
    const reason = entry ? videoDisqualifyReason(entry as ModelStatusEntryLike) : "不在 model-status 目录（无可用路由证据）"
    if (!reason) return { model, switched: false }
    const triedModels = new Set<string>(Array.isArray(node.metadata.__triedModels) ? (node.metadata.__triedModels as string[]) : [])
    triedModels.add(model)
    const chosenV = pickVideoModel(models as ModelStatusEntryLike[], triedModels)
    node.metadata.__triedModels = [...triedModels]
    if (!chosenV) {
      return {
        model,
        switched: false,
        exhausted: true,
        error: formatNodeFailure(
          (entry as { failure_class?: unknown } | undefined)?.failure_class ?? "model_unavailable",
          typeof entry?.note === "string" ? entry.note : reason,
          `模型 ${model} 不可选（${reason}）`,
          "；且没有其他有真实交付证据的视频模型可自动切换。请稍后重试",
        ),
      }
    }
    const note = `[gateway] 视频模型自动替换：${model}（${reason}）→ ${chosenV.id}（${chosenV.proven ? "近 24h 有真实交付" : "无近期失败样本"}）`
    node.metadata.model_swap = { from: model, to: chosenV.id, reason, proven: chosenV.proven }
    return { model: chosenV.id, switched: true, note }
  }
  if (!entry || entry.availability !== "unavailable") return { model, switched: false }
  const tried = new Set<string>(Array.isArray(node.metadata.__triedChannels) ? (node.metadata.__triedChannels as string[]) : [])
  const currentChannel = typeof entry.channel_id === "string" ? entry.channel_id : undefined
  if (currentChannel) tried.add(currentChannel)
  const pool = (models as Array<{ id: string; media_type?: string; availability?: string; channel_id?: string; last_24h?: { success_rate?: number } }>)
    .filter((m) => m.media_type === kind && m.availability === "available")
    .filter((m) => !tried.has(typeof m.channel_id === "string" ? m.channel_id : `unknown:${m.id}`))
  if (pool.length === 0) {
    node.metadata.__triedChannels = [...tried]
    return {
      model,
      switched: false,
      exhausted: true,
      error: formatNodeFailure(
        (entry as { failure_class?: unknown }).failure_class ?? "model_unavailable",
        typeof entry.note === "string" ? entry.note : "渠道故障",
        `模型 ${model} 不可用`,
        "；且没有其他可用渠道可自动切换。请稍后重试或在画布上更换模型",
      ),
    }
  }
  pool.sort((a, b) => (b.last_24h?.success_rate ?? 0.5) - (a.last_24h?.success_rate ?? 0.5))
  const chosen = pool[0]
  tried.add(typeof chosen.channel_id === "string" ? chosen.channel_id : `unknown:${chosen.id}`)
  node.metadata.__triedChannels = [...tried]
  return {
    model: chosen.id,
    switched: true,
    note: `[gateway] F2 failover: ${model}(${currentChannel ?? "?"}) unavailable -> ${chosen.id}(${chosen.channel_id ?? "?"})`,
  }
}

export async function submitWorkflowNode(
  session: SessionState,
  node: CanvasNode & { id?: string },
  upstream: Map<string, string>,
  graph?: { nodes: { id: string; role: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): Promise<{ nodeId: string; ok: boolean; content?: string; costCoins?: number; error?: string; lastAttempt?: Record<string, unknown> }> {
  const nodeId = (node as { id?: string }).id || ""
  if ((node.kind as string) === "director") {
    return { nodeId, ok: false, error: "预演节点不执行生图" }
  }
  if (!node.metadata) node.metadata = {}
  const meta = node.metadata

  // 解析 prompt：优先 node.metadata，其次沿上游连线 BFS 找第一个有内容的 text 节点
  // （大片模板：角色描述 text → 四视图 config → 各视图 image；image 的 prompt 继承自角色描述）
  function collectUpstreamPrompt(startId: string, depth = 0): string {
    if (depth > 4) return ""
    const direct = graph?.connections.filter((c) => c.to === startId).map((c) => graph.nodes.find((n) => n.id === c.from)).filter(Boolean)
    for (const n of direct ?? []) {
      const content = typeof n.metadata.content === "string" ? n.metadata.content : typeof n.metadata.prompt === "string" ? n.metadata.prompt : ""
      if (content.trim()) return content
    }
    for (const n of direct ?? []) {
      const found = collectUpstreamPrompt(n.id, depth + 1)
      if (found) return found
    }
    return ""
  }
  // prompt 解析移到 model/size 之后（shot JSON 需要 model 做按族编译）

  // 模型解析三级：节点自身 metadata.model → 沿上游 config 节点链（与 estimateNodeCoins 报价同口径）→ 兜底。
  // 视频兜底必须是活路由模型（metaso/minimax-h3）；seedance-2.0 的唯一供应商 filmera 已 degraded，写死即死单。
  // 2026-10-12 暴君裁定：影片默认模型认知改为 minimax-h3（miaowuai 渠道上游 minimax-h3-max，稳定快速、约 45s 出片、单镜 5-15s、推荐 15s）。
  let model = typeof meta.model === "string" && meta.model ? meta.model : resolveNodeModel(nodeId, node, graph ?? { nodes: [], connections: [] })
  if (node.kind === "video" && (!model || model === "pixai-tsubaki2")) model = VIDEO_FALLBACK_MODEL // 2026-10-02：不再写死 minimax-h3（断路器 open）；resolveActiveModel 再按交付证据校正
  // F2（2026-08-31）：提交前主动查活性+跨 provider failover（取代旧的「探测到
  // unavailable 就报错」）。放在 shot 编译之前——编译要按实际会用的模型族来。
  const failoverResolved = await resolveActiveModel(model, node.kind === "video" ? "video" : "image", session.apiKey, node)
  if (failoverResolved.exhausted) {
    console.error(`[workflow] node ${nodeId} ${failoverResolved.error}`)
    return { nodeId: node.id, ok: false, error: failoverResolved.error! }
  }
  if (failoverResolved.switched) {
    console.log(failoverResolved.note)
    model = failoverResolved.model
    ;(node.metadata as Record<string, unknown>).model = model // 诚实纪律：后续重试/画布显示/计费都用实际路由到的模型
  }
  const size = typeof meta.size === "string" ? meta.size : "1024x1024"
  // 结构化 shot JSON 优先：video 节点 prompt 来自 shot JSON 时按模型族编译成模型最爱的格式。
  let prompt = meta.prompt || meta.content || collectUpstreamPrompt(nodeId) || ""
  let shotSize = size
  let payloadDurationHint: number | undefined = undefined
  const shotCandidate = (parseShotCandidate(meta.shot) ?? parseShotCandidate(prompt)) as ShotJson | null
  if (node.kind === "video" && shotCandidate) {
    try { prompt = compileShotPrompt(shotCandidate, model) }
    catch (error) { return { nodeId: node.id, ok: false, error: `invalid_shot: ${error instanceof Error ? error.message : String(error)}` } }
    const shotParams = shotOutputParams(shotCandidate)
    if (shotParams.duration_seconds !== undefined && typeof meta.duration_seconds !== "number") payloadDurationHint = shotParams.duration_seconds
    if (shotParams.aspect_ratio && typeof meta.size !== "string") shotSize = shotParams.aspect_ratio
  }

  if (node.kind === "video" && !shotCandidate && ["camera", "cam", "trajectory", "keyframes", "start", "end", "timing", "parallax", "cameraTrajectory", "camera_trajectory", "cameraStart", "camera_start", "startPosition", "start_position", "cameraEnd", "camera_end", "endPosition", "end_position", "cameraKeyframes", "camera_keyframes"].some(key => meta[key] !== undefined)) {
    try {
      const duration = typeof meta.duration_seconds === "number" ? meta.duration_seconds : undefined
      const camera = normalizeShotCamera(meta, duration)
      const motion = compileShotPrompt({ subject: "", action: "", camera, output: { duration_seconds: duration } }, model)
      const combined = `${prompt}\n${motion}`
      if (combined.length > 3800) throw new Error(`镜头提示词共 ${combined.length} 字超过 3800；未截断、未提交`)
      prompt = combined
    } catch (error) { return { nodeId: node.id, ok: false, error: `invalid_shot: ${error instanceof Error ? error.message : String(error)}` } }
  }

  // 参考图：上游中已完成且有 content 的 image 节点（角色图/场景图 → 影片参考）
  const refImages = graph
    ? graph.connections
        .filter((c) => c.to === nodeId)
        .map((c) => graph.nodes.find((n) => n.id === c.from))
        .filter((n): n is ImageUpstream => Boolean(n) && typeof n.id === "string" && n.kind === "image" && Boolean(upstream.get(n.id)))
        .map((n) => upstream.get(n.id)!)
    : []

  const endpoint = node.kind === "video" ? "/videos/generations" : "/images/generations"
  const payload: Record<string, unknown> = {
    prompt,
    model,
    size: shotSize,
    n: 1,
    response_format: "url",
  }
  if (node.kind === "video") {
    await catalogVideoPerSecondCoins(model, session.apiKey)
    const videoOptions = resolveVideoSubmissionOptions(
      { id: typeof node.id === "string" ? node.id : nodeId, metadata: node.metadata ?? undefined },
      graph,
      model,
    )
    if (videoOptions.error) return { nodeId: node.id, ok: false, error: videoOptions.error }
    payload.generate_audio = videoOptions.generateAudio
    // 当前API无resolution/quality输入；显式非默认档已拒绝，不提交会被静默忽略的字段。
    // INC-0830：时长三级解析 meta → shot → 连线的视频 config；全部缺失时拒绝提交。
    // 旧版静默 `?? 5` 是 5 秒片事故根因之一：暴君指定 15s、上游照 5s 出、按条统一价照收。
    const cfgDuration = resolveConnectedVideoDuration(nodeId, graph)
    const duration =
      typeof meta.duration_seconds === "number" && meta.duration_seconds > 0
        ? meta.duration_seconds
        : (payloadDurationHint ?? cfgDuration)
    if (typeof duration !== "number" || !(duration > 0)) {
      return {
        nodeId: node.id,
        ok: false,
        error:
          "视频节点缺少时长（duration_seconds）：节点参数、shot JSON output、连线的视频配置节点均未提供。上游按条统一计费（5s/15s 同价），缺时长会被按 5 秒出片。请在任一来源补上 duration_seconds 后重跑",
      }
    }
    payload.duration_seconds = duration
    // 显式关键帧优先，连线图片随后；保序传递整组，不再只发第一张。
    if (meta.reference_images !== undefined && !Array.isArray(meta.reference_images)) {
      return { nodeId: node.id, ok: false, error: "视频 reference_images 必须是图片 URL 数组。" }
    }
    if ([meta.first_frame_url, meta.last_frame_url, meta.reference].some((ref) => ref !== undefined && typeof ref !== "string")) {
      return { nodeId: node.id, ok: false, error: "视频起止帧及 reference 必须是图片 URL 字符串。" }
    }
    const explicitRefs = Array.isArray(meta.reference_images) ? meta.reference_images : []
    const orderedRefs = [
      ...(typeof meta.first_frame_url === "string" ? [meta.first_frame_url] : []),
      ...(typeof meta.last_frame_url === "string" ? [meta.last_frame_url] : []),
      ...explicitRefs,
      ...(typeof meta.reference === "string" ? [meta.reference] : []),
      ...refImages,
    ]
    const invalidRef = orderedRefs.some((ref) => typeof ref !== "string" || !/^https?:\/\//i.test(ref.trim()))
    if (invalidRef) return { nodeId: node.id, ok: false, error: "视频参考图必须是 http(s) URL；请先上传本地关键帧。" }
    // 首尾可以刻意使用同一张图；帧位置仍须保留，不能按 URL 去重抹掉止帧。
    const videoRefs = orderedRefs.map((ref) => (ref as string).trim())
    if (videoRefs.length) payload.reference_images = videoRefs
  } else if (refImages.length) {
    payload.reference = refImages[0]
  }

  // 2026-09-25：行内实体 tag（`@[种类:名称]`）展开——工作流节点提示词里的 token 到这里才被
  // 解析。此前闸道整包零 `reference_images` 通道，token 原封不动送上游＝「画布没有实体卡节点、
  // 四视图各生各的、脸不一致」的结构缺口。
  //
  // 插入点刻意选在**最终 prompt 定案之后、payload.reference 写入之后**：
  //   ① video 分支的 prompt 可能已被上方 `compileShotPrompt` 重编（本档 L866）——提早展开会被
  //      重编打散（编译器按模型族重排版面，token 片段会被当普通文本重排）；
  //   ② 合并规则要用到 `payload.reference`（连线上游 image 节点那张，上面 video/image 两分支
  //      才写入），在此处才能一次算完「卡参考图 ∪ 既有 reference」；
  //   ③ 放在 `if (!prompt)` 空提示词守卫之前：零 token 时本块整段跳过（原值、零 HTTP），
  //      空 prompt 走原守卫报错——既有语义逐字不变。
  //
  // 解析器是站点端点 `/api/biz/character-resolve` 的薄客户端（不重写解析）；零 token 零 HTTP；
  // 任何失败 fail-open（原 prompt + 空 refs），解析失败永不阻断生成。
  // meta.prompt/meta.content 是 unknown（payload 袋）→ token 判定前先收敛成字串。
  const promptForTokens = typeof prompt === "string" ? prompt : ""
  if (hasEntityToken(promptForTokens)) {
    // 解析用这位使用者的 key（`session.apiKey`，同下方提交用的 Bearer）：卡库按使用者隔离。
    const resolved = await resolveEntityTokens(promptForTokens, refImages, undefined, { apiKey: session.apiKey })
    payload.prompt = resolved.prompt
    // 视频关键帧在前，实体参考随后；不以实体解析器的 5 张上限截断视频输入。
    // 模型上限交给控制面校验，超限明确拒绝，不能静默丢帧。
    const mergedRefs = node.kind === "video"
      ? [
          ...(Array.isArray(payload.reference_images) ? payload.reference_images as string[] : []),
          ...resolved.reference_images.filter((ref) => !(Array.isArray(payload.reference_images) && payload.reference_images.includes(ref))),
        ]
      : sanitizeEntityReferences([
          ...resolved.reference_images,
          ...(typeof payload.reference === "string" ? [payload.reference] : []),
        ])
    if (mergedRefs.length) payload.reference_images = mergedRefs
  }

  if (!prompt) {
    console.error(`[workflow] node ${nodeId} (${node.kind}) has no prompt`)
    return { nodeId: node.id, ok: false, error: "缺少提示词：上游文本节点未填写内容" }
  }

  // F2（2026-08-31）：旧的「提交前探测 unavailable 就报错」后置检查已移到函式
  // 前段的 resolveActiveModel（主动 failover，不再是单纯报错）——此处不再重复探测。
  let taskSubmitted = false
  // INC-0830：轮询响应里的 attempts 明细（片A 加的 /v1/videos/{id} attempts 阵列）
  // 就地快取——失败时随节点错误回带，画布错误卡能看到真话（上游成没成、谁的锅）。
  // F1 修（2026-08-31）：声明必须在函式级——原困在 poll 分支块内，poll 预算耗尽后
  // 的 taskSubmitted 兜底引用它 → ReferenceError → 误判 non-retryable → 死错。
  let lastAttempt: Record<string, unknown> | undefined = undefined
  let submittedTaskId = ""
  let queuedSinceMs = 0
  let queueHinted = false
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, any>
    if (res.status === 202 || (res.ok && (data?.task_id || data?.id))) {
      taskSubmitted = true
      const taskId = data?.task_id ?? data?.id
      // INC-0830：把上游作业 id 记到节点 metadata.last_job_id——rerun 防重门与节点
      // error 真相都消费它，agent 不再盲跑重复扣费（事故根因之三）。
      try {
        ;(node.metadata as Record<string, unknown>).last_job_id = String(taskId)
      } catch {}
      submittedTaskId = String(taskId)
      {
        // 2026-10-02：登记进工作流 job 表——终态向控面结算实扣、放弃/停滞时据此取消。
        const jwf = workflowOwnerBySession.get(session.sessionId) ?? wfidFromNodeId(nodeId)
        if (jwf) {
          if (!workflowJobs.has(jwf)) workflowJobs.set(jwf, new Map())
          workflowJobs.get(jwf)!.set(submittedTaskId, { nodeId, kind: node.kind === "video" ? "video" : "image" })
        }
      }
      // H11 补完：workflow 生成任务同样登记进会话任务表（/internal/session-tasks、image_get_result 读它）。
      registerWorkflowTask(session, String(taskId), node.id, "queued")
      const pollEndpoint = node.kind === "video" ? `/videos/${taskId}` : `/images/${taskId}`
      // 轮询：间隔 3s；图最多 120s、影片最多 300s（seedance 5 秒片可能排队较久）
      // 2026-08-21（PM 要求）：预算按真实耗时放宽——实测 image 60-90s、kling 8s 影片 >300s
      // （Kling 标准模式约 2-6 分钟）。video 200 次=600s，image 60 次=180s。
      const pollBudget = node.kind === "video" ? 200 : 60
      const startedAtMs = Date.now()
      const etaSeconds = node.kind === "video" ? 360 : 120
      const wfIdMatch = nodeId.match(/^(.+)-[^-]+-\d+$/)
      for (let i = 0; i < pollBudget; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        // 进度条：每 15s 推一次 elapsed/ETA（percent 封顶 95%，成功事件才是 100%）
        if (i % 5 === 4) {
          const elapsedSec = Math.round((Date.now() - startedAtMs) / 1000)
          const percent = Math.min(95, Math.round((elapsedSec / etaSeconds) * 100))
          const patch = { status: "running" satisfies TaskStatus, progress: { elapsed_seconds: elapsedSec, eta_seconds: etaSeconds, percent } }
          emitToSession(session, "canvas.node.updated", {
            node_id: nodeId,
            ...(wfIdMatch ? { workflow_id: wfIdMatch[1] } : {}),
            patch,
          })
          // 2026-10-02：轮询打点直发 emitToSession 绕过 emit hook，停滞时钟不刷新 → 长排队被误判 stuck。
          {
            // 节点 id 形如 single_image-result-2（不含 wfid），故 wfIdMatch 对模板节点恒不命中；改按会话属主工作流刷新。
            const pw = workflowOwnerBySession.get(session.sessionId) ?? (wfIdMatch ? wfIdMatch[1] : "")
            if (pw && workflowWake.has(pw)) workflowWake.get(pw)!.lastProgressAt = Date.now()
          }
          applyCanvasNodeUpdated(session.sessionId, { node_id: nodeId, patch })
        }
        const poll = await fetch(`${PLATFORM_BASE}/v1${pollEndpoint}`, {
          headers: { Authorization: `Bearer ${session.apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        const pd = (await poll.json().catch(() => ({}))) as Record<string, any>
        const pdAttempts = (pd as { attempts?: unknown })?.attempts
        if (Array.isArray(pdAttempts) && pdAttempts.length > 0) lastAttempt = pdAttempts[pdAttempts.length - 1] as Record<string, unknown>
        // 2026-10-02：上游「并发/容量饱和」是可等待的背压（status 仍是 queued/running），不是硬失败。
        // 提前辨识，让下方排队换道块接手；只有超过换道门槛或明确硬失败才在后面翻面。
        const pdSig = pd as { failure_class?: unknown; failure_detail?: unknown; status?: unknown } | undefined
        const upstreamFailSignal =
          typeof pdSig?.failure_class === "string" && pdSig.failure_class
            ? pdSig.failure_class
            : typeof pdSig?.failure_detail === "string" && pdSig.failure_detail
              ? pdSig.failure_detail
              : ""
        const saturationSignal = /capacity|saturat|overload|concurr|too many/i.test(upstreamFailSignal)
        const queueLike = pd?.status === "queued" || (saturationSignal && pd?.status !== "succeeded" && pd?.status !== "failed")
        // 2026-10-02 排队超 5 分钟（或容量饱和同样视为排队）：提示 + 换同价位通道
        //（无则明确降级＝续等至预算耗尽后取消退款）。
        if (node.kind === "video" && queueLike) {
          if (!queuedSinceMs) queuedSinceMs = Date.now()
          if (!queueHinted && Date.now() - queuedSinceMs > QUEUE_SWITCH_MS) {
            queueHinted = true
            const qMin = Math.round(QUEUE_SWITCH_MS / 60000)
            const alt = (Number(meta.__queueSwitches ?? 0) < 1) ? await pickSamePriceVideoAlternative(model, session.apiKey, node) : null
            const hintPatch = {
              status: "running" satisfies TaskStatus,
              human_message: alt
                ? `上游通道排队已超过 ${qMin} 分钟，正在自动切换到同价位通道 ${alt}`
                : `上游通道排队已超过 ${qMin} 分钟（当前无同价位的可用备选通道），继续等待；超过上限将自动取消并全额退款`,
            }
            emitToSession(session, "canvas.node.updated", { node_id: nodeId, ...(wfIdMatch ? { workflow_id: wfIdMatch[1] } : {}), patch: hintPatch })
            applyCanvasNodeUpdated(session.sessionId, { node_id: nodeId, patch: hintPatch })
            console.log(`[workflow] node ${nodeId} queued >${qMin}min model=${model} alt=${alt ?? "none"}`)
            if (alt) {
              const c = await cancelPlatformJob(session.apiKey, submittedTaskId)
              if (c.cancelled) {
                registerWorkflowTask(session, submittedTaskId, node.id, "failed")
                const tried = new Set<string>(Array.isArray(meta.__triedModels) ? (meta.__triedModels as string[]) : [])
                tried.add(model)
                meta.__triedModels = [...tried]
                meta.__queueSwitches = Number(meta.__queueSwitches ?? 0) + 1
                meta.model = alt
                meta.model_swap = { from: model, to: alt, reason: `queued>${qMin}min`, proven: true }
                return await submitWorkflowNode(session, node, upstream, graph)
              }
            }
          }
        } else {
          queuedSinceMs = 0
        }
        if (pd?.status === "succeeded") {
          const rawUrl = pd?.data?.[0]?.url || pd?.result_url || pd?.url
          // 结果可能是相对 /v1/images/{id}/result，转成绝对公开 URL（沿用 resolveResultUrl 语义）
          const url = rawUrl
            ? /^https?:\/\//.test(rawUrl)
              ? rawUrl
              : `${PLATFORM_BASE}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
            : ""
          if (url) {
            registerWorkflowTask(session, String(taskId), node.id, "succeeded", url)
            return { nodeId: node.id, ok: true, content: url, costCoins: pd?.cost_coins }
          }
          break
        }
        if (pd?.status === "failed") {
          console.error(`[workflow] node ${nodeId} generation failed: ${pd?.error?.message}`)
          registerWorkflowTask(session, String(taskId), node.id, "failed")
          return { nodeId: node.id, ok: false, error: pd?.error?.message || "generation failed", lastAttempt }
        }
        // R7-A（2026-08-29）失败即翻面：供应商并发饱和时上游 job 会以 queued +
        // failure_detail（如 "capacity_saturated: ..."）反覆重试、迟迟不到终态 failed；
        // 旧逻辑只认 status==="failed"，明知上游已报失败信号仍继续发 running 进度帧，
        // 直到轮询预算耗尽才报假话术。收到失败信号立即翻面，不再空转。
        const pdFail = pdSig
        const failSignal = upstreamFailSignal
        if (failSignal && pdFail?.status !== "succeeded") {
          // 2026-10-02：容量/并发饱和是可等待背压——在 WORKFLOW_QUEUE_SWITCH_MS 换道窗口内
          // 不翻面，让上方排队块在门槛到达时「换同价位通道＋5 分钟提示」；超过窗口或已换过
          // 道仍饱和才 fail-fast（fail-fast 路径同样 cancelPlatformJob 全额退款，快速止损语义不变）。
          const withinSwitchWindow = queuedSinceMs > 0 && Date.now() - queuedSinceMs <= QUEUE_SWITCH_MS
          const alreadySwitched = Number(meta.__queueSwitches ?? 0) >= 1
          if (saturationSignal && withinSwitchWindow && !alreadySwitched) {
            console.warn(
              `[workflow] node ${nodeId} saturation backpressure within ${Math.round(QUEUE_SWITCH_MS / 1000)}s switch window (${pdFail?.status}): ${failSignal}`,
            )
            continue
          }
          console.error(`[workflow] node ${nodeId} upstream failure signal (${pdFail?.status}): ${failSignal}`)
          registerWorkflowTask(session, String(taskId), node.id, "failed")
          // 放弃即取消：否则 job 在控面继续排队、日后成功扣费＝孤儿镜（评测 4ea050fe 多扣 130 币根因）。
          if (pdFail?.status === "queued" || pdFail?.status === "running") await cancelPlatformJob(session.apiKey, String(taskId))
          return {
            nodeId: node.id,
            ok: false,
            error: formatNodeFailure(
              pdFail?.failure_class,
              pdFail?.failure_detail ?? failSignal,
              "生成失败：任务已提交但上游渠道未能执行",
              "；可在画布上稍后重试或更换模型。若已扣款以平台账单为准（归因以 failure_class 与原文为准，勿自行推断供应商并发满/排队超时）",
            ),
            lastAttempt,
          }
        }
        if (poll.status >= 400 && poll.status !== 404) {
          console.error(`[workflow] node ${nodeId} poll ${poll.status}: ${(pd as { error?: { message?: string } })?.error?.message}`)
          return { nodeId: node.id, ok: false, error: `poll ${poll.status}`, lastAttempt }
        }
      }
    }
    // 同步回图兜底
    const url = data?.data?.[0]?.url || data?.result_url || data?.url
    if (res.ok && url) return { nodeId: node.id, ok: true, content: url, costCoins: data?.cost_coins }
    if (taskSubmitted) {
      console.error(`[workflow] node ${nodeId} poll timeout`)
      // 放弃即取消（同上）：排队中的 job 全额退款，避免迟到成功成孤儿镜。
      if (submittedTaskId) await cancelPlatformJob(session.apiKey, submittedTaskId)
      return {
        nodeId: node.id,
        ok: false,
        error: "生成超时：任务已提交但上游渠道未能执行（供应商并发满或排队超时）；可在画布上稍后重试或更换模型。若已扣款以平台账单为准",
        lastAttempt,
      }
    }
    console.error(`[workflow] node ${nodeId} submit failed: ${JSON.stringify(data)}`)
    return { nodeId: node.id, ok: false, error: data?.error?.message || `submit ${res.status}` }
  } catch (e) {
    console.error(`[workflow] node ${nodeId} exception: ${(e as Error).message}`)
    return { nodeId: node.id, ok: false, error: (e as Error).message }
  }
}

// workflow 端点（不需 session）：列模板。
export function workflowServiceTemplates(): Response {
  return Response.json({ ok: true, templates: workflowService.templates() })
}

// S4（2026-08-27）：已批准批量执行的 workflow 记录（wfid → 批准时的估算额）。
// 语义：confirm 通过是「批准这一整批按此预算开跑」，workflow 内逐节点执行
// 不再重弹 confirm（预算单是事前告知，不取代逐笔扣费确认——但批量 confirm
// 已经是逐笔扣费确认的总闸门，双重弹卡反而是打扰）。workflow 删除/重跑
// 不清此记录：同批重跑金额通常下降，重弹只会造成倒挂复辟。
export const workflowGenerateApproved = new Map<string, { amount: number; nodes: number }>()
capMap(workflowGenerateApproved)

// 2026-08-29 整改（session 00c583ed 事故）：批量执行 confirm 的批准续跑注册表。
// 旧版 /workflow/generate 在 handler 内联 while 轮询等用户批准（最长
// CONFIRM_TIMEOUT_MS=15min），而 workflow_generate 工具层只有 10s AbortSignal——
// 用户批准慢于 10s 是常态，工具必报 workflow_unreachable，agent 误判「后端
// 不可达」弃模板转手动逐镜。改为非阻塞：弹卡 → 注册回调 → 立即回
// confirm_pending；settleConfirm(approved) 触发 runWfGenerate。
export const wfGenerateContinuations = new Map<string, { state: SessionState; wfid: string; nodes: number; amount: number }>()
capMap(wfGenerateContinuations)

// ── 2026-09-24 协作确认闸（collaborate 档专属：剧本批准／资产确认／分镜确认）────
//
// 要修的洞：模板 directive 早就写死「一步一确认」，但 `step.gate` 只是
// `metadata.gate` 字串 → 引擎在 expandTemplate 把它做成 `pipelineCard:"gate"` 的
// 衍生卡（workflow-engine.ts:226-239），执行期只被算尺寸（workflow-service
// emitNodeDelta），**没有任何节点在此暂停**——用户真话是「大哥你这个智能体，
// 连资产图都不让我们确认吗」。本闸把门禁卡从 prompt 装饰升级成机制：
// 交付物真的产出后，在批次间暂停并注册 pending confirm（轮子＝
// /internal/confirm-request 注册 → settleConfirm 落帐/emit → 续跑；不新建暂停系统）。
//
// 三条硬边界（决策定稿 2026-09-25 第 1/2/5 条）：
//   ① 只在 interaction_mode === "collaborate" 生效；auto/preset 两档零改动
//      （全自动＝一键一路跑完不问，护城河）。
//   ② 停点只有这三个；final_cut（成片验收）/promo 的门禁卡不在此列（决策第 1 条
//      「其余环节自动」），维持 prompt 层引导，不扩大硬闸范围。
//   ③ 确认不设超时（决策第 5 条：甲方核对一两周是常态）——挂起期间 watchdog 与
//      midturn-status 主动让路（timers-gw.ts:142/:330 的 pendingConfirms 让路），
//      这是既有合法暂停语义，不需要新的保活机制。
//
// 为什么判「交付物是否真的产出」而不是「门禁卡存在」：门禁卡在 start 就铺好了，
// 拿它当暂停条件＝建骨架当下就停，用户会被问一个还不存在的资产。判据：
//   - text/config 类交付（剧本/分镜）：metadata.content 非空且不是占位文案
//     （templatePlaceholderContent 铺的是「（待填：…）」——占位不是交付物，
//      拿它当「已产出」＝谎报可确认）。
//   - 可执行类（资产图）：nodeStatus === "success" 且有 nodeContent（真图 URL）。
//
// 为什么批准绑「交付物指纹」而不是布林：批准是对**某个具体交付物**的批准。用户
// 回跳改图／重生成资产后，指纹变 → 该门禁重新进入待批准（不让旧批准替新交付物
// 放行）。这同时就是决策 15「回跳后只重跑后续」的闸侧语义：网关既有的
// updateNode/rerunFrom 已把下游重置 pending＋清结果（workflow-service.ts:660-675、
// :957-966），不需新建作废机制。
export const COLLABORATE_GATE_ROLES: readonly string[] = ["script", "cast_card", "storyboard"]

/** 停点中文名（confirm 卡与暂停回执的用户可见前缀）。 */
export const COLLABORATE_GATE_LABELS: Record<string, string> = {
  script: "剧本批准",
  cast_card: "资产确认",
  storyboard: "分镜确认",
}

/**
 * 已批准的停点：wfid → (role → 交付物指纹)。刻意**不持久化**（与 workflowBilling
 * 同为进程内真值）：gateway 重启后重新问一次，宁可多问一次也不放过未确认的资产。
 */
export const workflowGateApprovals = new Map<string, Map<string, string>>()
capMap(workflowGateApprovals)

/**
 * 停点续跑注册表（request_id → 待续跑的 workflow）。**刻意与 wfGenerateContinuations
 * 分开**：那条链的 approved 分支会连带写 workflowGenerateApproved ＋ workflowBilling
 *（confirmed_coins ← 批准额、refunded_coins ← 0）——拿它载确认闸会把真实退款真值
 * 抹成 0，而 billing 真值正是 agent 对用户报帐的唯一依据（最恨被骗）。故另设一表，
 * settle 只触发续跑，一毛钱不碰帐。
 */
export const wfGateContinuations = new Map<string, { state: SessionState; wfid: string; role: string; gateNodeId: string }>()
capMap(wfGateContinuations)

/** 交付物指纹：内容前 16 位 sha256（内容可能含换行/中文，只取指纹比对，不外泄原文）。 */
function deliverableFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

/** 占位文案判定（templatePlaceholderContent 的产物＝未填，不是交付物）。 */
function isPlaceholderContent(content: string): boolean {
  return content.trim().startsWith("（待填：")
}

/**
 * 停点的交付物是否**真的产出**（可被用户确认）。false＝还没东西可确认，门禁不挡。
 */
export function deliverableProduced(
  wf: { nodeStatus: Record<string, string>; nodeContent: Record<string, string> },
  node: { id: string; kind: string; metadata?: Record<string, unknown> },
): { produced: boolean; fingerprint: string } {
  if (node.kind === "text" || node.kind === "config") {
    const text = typeof node.metadata?.content === "string" ? node.metadata.content.trim() : ""
    if (!text || isPlaceholderContent(text)) return { produced: false, fingerprint: "" }
    return { produced: true, fingerprint: deliverableFingerprint(text) }
  }
  const content = wf.nodeContent[node.id]
  if (wf.nodeStatus[node.id] !== "success" || typeof content !== "string" || !content) {
    return { produced: false, fingerprint: "" }
  }
  return { produced: true, fingerprint: deliverableFingerprint(content) }
}

/** 待批准的停点（按 COLLABORATE_GATE_ROLES 固定顺序＝剧本→资产→分镜，与图序无关）。 */
export function resolveCollaborateGate(wf: {
  workflowId: string
  graph: { nodes: { id: string; role: string; kind: string; metadata?: Record<string, unknown> }[] }
  nodeStatus: Record<string, string>
  nodeContent: Record<string, string>
}): { role: string; label: string; gateText: string; gateNodeId: string; nodeId: string; fingerprint: string } | null {
  const approved = workflowGateApprovals.get(wf.workflowId)
  for (const role of COLLABORATE_GATE_ROLES) {
    const main = wf.graph.nodes.find((n) => n.role === role)
    const gate = wf.graph.nodes.find((n) => n.role === `${role}__gate`)
    if (!main || !gate) continue
    const { produced, fingerprint } = deliverableProduced(wf, main)
    if (!produced) continue // 还没交付物可确认：不挡（门禁不是无条件硬闸）
    if (approved?.get(role) === fingerprint) continue // 这个交付物已批准
    const gateText = typeof gate.metadata?.content === "string" ? gate.metadata.content.trim() : ""
    return { role, label: COLLABORATE_GATE_LABELS[role] ?? role, gateText, gateNodeId: gate.id, nodeId: main.id, fingerprint }
  }
  return null
}

/** 暂停回执文案（runWfGenerate 的 !ok 分支会把它原样播给用户/agent，必须是人话）。 */
export function collaboratePauseNotice(gate: { label: string }): string {
  return `已暂停流程，等待你确认「${gate.label}」。协作模式下，确认后系统自动从断点续跑（已完成的节点沿用产物，不重跑、不重复扣费）。`
}

/**
 * 注册一次停点确认：pendingConfirms（让 watchdog 让路）＋续跑注册表＋确认卡＋
 * 画布门禁卡可操作标记。同一个 workflow 已有一张未决确认卡时**不重复发卡**
 *（F1 重启续跑可能再次呼叫 generate），仍回 true＝维持暂停。
 * 回 false＝无法注册（state 不存在），呼叫端不暂停（fail-open 不卡死流程）。
 */
export function requestCollaborateApproval(
  state: SessionState,
  wf: { workflowId: string },
  gate: { role: string; label: string; gateText: string; gateNodeId: string },
): boolean {
  for (const c of wfGateContinuations.values()) {
    if (c.wfid === wf.workflowId) return true // 已有未决卡：维持暂停，不重复弹
  }
  const requestId = `wfgate_${wf.workflowId}_${gate.role}_${Date.now().toString(36)}`
  // 无超时（决策 5）：timer 是 no-op——PendingConfirm.timer 是型别必需栏位，
  // settleConfirm 会 clearTimeout 它，故不能省（同 /internal/confirm-request 的
  // auto 分支形状）。ledger 刻意不带：这是「确认交付物」不是扣费，带 ledger 会
  // 写一笔 0 币帐目进帐本（假帐目）。
  state.pendingConfirms.set(requestId, { timer: setTimeout(() => {}, 0) })
  wfGateContinuations.set(requestId, { state, wfid: wf.workflowId, role: gate.role, gateNodeId: gate.gateNodeId })
  const description = `【协作确认·${gate.label}】${gate.gateText || "确认这一步的交付物后继续后续环节。"}`
  emitToSession(state, "confirm.request", { request_id: requestId, amount_coins: 0, description })
  markGateNodeState(state, wf.workflowId, gate.gateNodeId, { request_id: requestId, session_id: state.sessionId, status: "pending" })
  console.log(
    `[gateway] collaborate gate paused: wf=${wf.workflowId} gate=${gate.role} state=${state.sessionId} request=${requestId}`,
  )
  return true
}

/**
 * 画布门禁卡状态回写（直发路径绕过 workflowService 的 emit hook → 快照同步在此
 * 自补，同 events-translate/workflow-gw 既有直发点的写穿写法，幂等）。
 * 前端 NodeBody 据 metadata.gateConfirm 渲染「批准/退回」——门禁卡从纯文字变可操作。
 */
function markGateNodeState(
  state: SessionState,
  wfid: string,
  gateNodeId: string,
  gateConfirm: { request_id: string; session_id: string; status: "pending" | "approved" | "rejected" },
): void {
  const data = { unit_id: wfid, node_id: gateNodeId, patch: { gateConfirm } }
  emitToSession(state, "canvas.node.updated", data)
  try {
    applyCanvasNodeUpdated(state.sessionId, data)
  } catch (e) {
    console.error(`[gateway] gate node patch write-through failed: ${gateNodeId}`, e)
  }
}

/**
 * 停点裁决 → 解注册。批准的记指纹（这个交付物算过了）并续跑；驳回=停下等用户
 * 指定怎么改（决策 4：不擅自重生成、不擅自花钱），工作流停在暂停态。
 * 回 true 表示这个 request_id 属停点闸（呼叫端不需再看计费链）。
 */
export function resumeWorkflowGate(requestId: string, approved: boolean): boolean {
  const cont = wfGateContinuations.get(requestId)
  if (!cont) return false
  wfGateContinuations.delete(requestId)
  const wf = workflowService.get(cont.wfid)
  // 卡片状态回写：不管批准或驳回都要落地，否则画布门禁卡永远停在「待确认」。
  markGateNodeState(cont.state, cont.wfid, cont.gateNodeId, {
    request_id: requestId,
    session_id: cont.state.sessionId,
    status: approved ? "approved" : "rejected",
  })
  if (!approved) {
    console.log(`[gateway] collaborate gate denied: wf=${cont.wfid} gate=${cont.role}（停在该步等用户指定修改，不重生成）`)
    return true
  }
  const gate = wf ? resolveGateByRole(wf, cont.role) : null
  const approvedMap = workflowGateApprovals.get(cont.wfid) ?? new Map<string, string>()
  approvedMap.set(cont.role, gate?.fingerprint ?? "")
  workflowGateApprovals.set(cont.wfid, approvedMap)
  console.log(`[gateway] collaborate gate approved: wf=${cont.wfid} gate=${cont.role} → resume`)
  runWfGenerate(cont.state, cont.wfid) // 续跑轮子：generate 的 R5-B 语义只跑 pending/error 节点
  return true
}

/** 取该 role 交付物的当前指纹（批准当下记帐用）。 */
function resolveGateByRole(
  wf: { graph: { nodes: { id: string; role: string; kind: string; metadata?: Record<string, unknown> }[] }; nodeStatus: Record<string, string>; nodeContent: Record<string, string> },
  role: string,
): { fingerprint: string } | null {
  const main = wf.graph.nodes.find((n) => n.role === role)
  if (!main) return null
  const { produced, fingerprint } = deliverableProduced(wf, main)
  return produced ? { fingerprint } : null
}

// 批量执行启动器（含 S6 质询冻结检查）。两个入口：/workflow/generate 免
// confirm 直呼路径，与 wfGenerateContinuations 批准回调——冻结语义收拢在此，
// 两个入口行为一致。
export function runWfGenerate(state: SessionState, wfid: string): void {
  const wf = workflowService.get(wfid)
  if (!wf) return
  const hasVideoNode = wf.graph.nodes.some((n) => n.kind === "video")
  const interrogating =
    typeof state.lastUserMessage === "string" &&
    isInterrogativeMessage(state.lastUserMessage) &&
    state.ackTimer != null
  if (hasVideoNode && interrogating) {
    if (!state.pendingVideoWorkflows) state.pendingVideoWorkflows = []
    if (!state.pendingVideoWorkflows.includes(wfid)) state.pendingVideoWorkflows.push(wfid)
    console.log(`[gateway] S6 freeze: video workflow ${wfid} held during unanswered user question (session ${state.sessionId})`)
    return
  }
  // 修 3：登记唤醒——扫描器据此在终态/停滞时向原会话投 resume（长任务交接）。
  workflowWake.set(wfid, { sessionId: state.sessionId, lastProgressAt: Date.now() })
  void workflowService.generate(wfid).then((r) => {
    if (!r.ok) {
      // 预检拒绝/早退路径状态未必到终态（如余额预检拒绝时 status 仍是
      // building）——注销唤醒登记，拒绝原因已在上方 message.delta 如实播出。
      workflowWake.delete(wfid)
      console.warn(`[gateway] R5-C generate rejected: wf=${wfid} session=${state.sessionId} status=${r.status}`)
      const visible = /[\u4e00-\u9fff]/.test(r.status)
        ? r.status
        : `工作流未能启动（${r.status}）。请调整后重试。`
      emitToSession(state, "message.delta", { text: visible + "\n" })
      return
    }
    // 修 2：全节点成功 → billing 真值置 settled（帐实相符的终态）。
    if (r.status === "success") {
      const billing = workflowBilling.get(wfid)
      if (billing) billing.billing_status = "settled"
    }
    console.log(`[gateway] workflow ${wfid} finished ok`)
    // 2026-09-20 Phase 1：跑批完成推送站点。**这是 generate 的单一完成出口**
    //（success/partial/failed 三分支全在此），且 rerun 不走此路径（rerun 是
    // 局部重跑，非整批完成）。fire-and-forget：pushWorkflowCompletion 自带
    // try/catch 不抛，此处不 await，工作流收尾不受站点延迟影响。
    void pushWorkflowCompletion(state)
    // 2026-10-02：终态直推（成片连结 + 控面实扣），不经 LLM/4096 唤醒；停滞判死后才跑完的也会收到。
    void sendWorkflowNotice(state, wfid, "final")
    // 2026-10-02：停滞扫描判死时已 delete 唤醒登记（评测 08:36:36），工作流之后才自行
    // 跑完（08:46）时旧版只发 final 通报、不再唤 agent 收尾。重新登记，让扫描器下一轮
    // 以 final 唤醒 agent 补做汇报（sendWorkflowNotice 已去重，不会重复发 final 通报）。
    if (!workflowWake.has(wfid)) {
      workflowWake.set(wfid, { sessionId: state.sessionId, lastProgressAt: Date.now() })
      console.log(`[gateway] workflow ${wfid} finished after stall-declared; re-registered wake for agent wrap-up`)
    }
  })
}

/** 唤醒恢复等待上限：> 2026-10-02 实测 opencode-server OOM 后 85 秒恢复（08:36:33 挂、08:37:58 回）。 */
export const WAKE_RECOVERY_WAIT_MS = Number.parseInt(process.env.WORKFLOW_WAKE_RECOVERY_MS || "180000", 10) || 180_000

/** 连线被拒（opencode-server 重启/OOM 断线）判定——Bun fetch 抛 fetch failed 带 code，Node 带 cause.code。 */
export function isConnectionRefused(e: unknown): boolean {
  const err = e as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | undefined
  const code = typeof err?.code === "string" ? err.code : typeof err?.cause?.code === "string" ? err.cause.code : ""
  return code === "ECONNREFUSED" || /ECONNREFUSED|connection refused/i.test(String(err?.message ?? e))
}

/**
 * 2026-10-02：opencode-server 全域 OOM 断线（127.0.0.1:4096）时轮询 /config 至恢复。
 * 旧版唤醒退避总窗口仅 65 秒（0/5/15/45）< 实测 85 秒断线 → 唤醒全 miss 永久丢失。
 * 改为：遇 ECONNREFUSED 时轮询 /config 直到 200，上限 WAKE_RECOVERY_WAIT_MS（预设 180s）。
 */
export async function waitForOpencodeReady(maxMs = WAKE_RECOVERY_WAIT_MS, intervalMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + maxMs
  for (;;) {
    try {
      const res = await fetch(`${OPENCODE_URL}/config`, { headers: opencodeHeaders(), signal: AbortSignal.timeout(5_000) })
      if (res.ok) return true
    } catch {
      // 仍未起：继续轮询
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

function workflowWakeSessionBusy(state: SessionState): boolean {
  return state.ackTimer != null || state.turnMetrics != null || (state.lastTurnActiveAt ?? 0) > 0
}

/** 唤醒失败必须区分确定未提交与受理未知；后者绝不能盲目重投。 */
export class WorkflowWakeDispatchError extends Error {
  constructor(readonly code: "submission_unknown" | "not_submitted", message: string, readonly retryable = false) {
    super(message)
    this.name = "WorkflowWakeDispatchError"
  }
}

/** 单次唤醒投递；只在上游实际受理且仍属原回合时更新本地状态。 */
async function postWorkflowWake(state: SessionState, wfid: string, content: string, attempt: number, turnGen: number, ocId: string): Promise<void> {
  if (state.turnAborted || state.turnAbortSource === "user" || (state.turnGen ?? 0) !== turnGen || state.opencodeSessionId !== ocId) {
    throw new WorkflowWakeDispatchError("not_submitted", "wake cancelled because the session stopped or changed turns")
  }
  if (workflowWakeSessionBusy(state)) {
    throw new WorkflowWakeDispatchError("not_submitted", "session is processing an active turn", true)
  }
  const body = { ...beastAgentField(state), parts: [{ type: "text", text: content }] }
  let res: Response
  try {
    res = await fetch(`${OPENCODE_URL}/session/${ocId}/prompt_async`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
  } catch (error) {
    // 连接拒绝证明尚未发出HTTP请求；超时/断线可能发生在受理之后。
    if (isConnectionRefused(error)) throw error
    throw new WorkflowWakeDispatchError("submission_unknown", "wake submission outcome unknown; not retrying")
  }
  if (!res.ok) {
    const rejected = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(res.status)
    throw new WorkflowWakeDispatchError(rejected ? "not_submitted" : "submission_unknown", `wake prompt_async HTTP ${res.status}`)
  }
  // 已受理不能撤回；旧回执不得覆盖新回合或清掉用户停止状态。
  if (state.turnAborted || state.turnAbortSource === "user" || (state.turnGen ?? 0) !== turnGen || state.opencodeSessionId !== ocId) return
  state.lastPromptBody = body
  state.turnGen = turnGen + 1
  state.turnTextChars = 0
  state.turnReasoningChars = 0
  state.turnRetries = 0
  state.retryQueued = false
  state.turnUpstreamError = null
  state.turnToolStarted = false
  state.watchdogRetried = false
  state.questionAnsweredThisTurn = false
  state.deathDeclared = false
  state.lastTurnActiveAt = Date.now()
  markDirty(state)
  armWatchdogTimer(state)
  console.log(`[gateway] workflow wake resumed: session=${state.sessionId} wf=${wfid} attempt=${attempt + 1}`)
}

// 同一会话同时到期的wakeup/cron/workflow只能有一个在途提交。
const workflowWakeInFlight = new Set<string>()
capSet(workflowWakeInFlight)

/** 会话结束时清掉与该 session 绑定的表，以及能从 owner 反查到的 workflowId 表项。 */
export function releaseWorkflowSession(sessionId: string): void {
  if (!sessionId) return
  const wfids = new Set<string>()
  const owned = workflowOwnerBySession.get(sessionId)
  if (owned) wfids.add(owned)
  for (const [wfid, w] of workflowWake) {
    if (w.sessionId === sessionId) wfids.add(wfid)
  }
  for (const [key, c] of wfGenerateContinuations) {
    if (c.state?.sessionId === sessionId) {
      wfGenerateContinuations.delete(key)
      if (c.wfid) wfids.add(c.wfid)
    }
  }
  for (const [key, c] of wfGateContinuations) {
    if (c.state?.sessionId === sessionId) {
      wfGateContinuations.delete(key)
      if (c.wfid) wfids.add(c.wfid)
    }
  }
  workflowOwnerBySession.delete(sessionId)
  workflowWakeInFlight.delete(sessionId)
  for (const wfid of wfids) {
    workflowCompletionPushed.delete(wfid)
    autoResumedWorkflows.delete(wfid)
    workflowBilling.delete(wfid)
    workflowJobs.delete(wfid)
    workflowWake.delete(wfid)
    workflowGenerateApproved.delete(wfid)
    workflowGateApprovals.delete(wfid)
    for (const key of [...workflowNoticeSent]) {
      if (key === wfid || key.startsWith(`${wfid}:`)) workflowNoticeSent.delete(key)
    }
  }
}

/** 仅对明确的连接拒绝恢复重试；直发通报不是模型受理凭据。 */
export async function dispatchWorkflowWake(state: SessionState, wfid: string, content: string, kind: "final" | "stalled"): Promise<void> {
  if (workflowWakeInFlight.has(state.sessionId)) {
    throw new WorkflowWakeDispatchError("not_submitted", "another wake submission is in flight", true)
  }
  workflowWakeInFlight.add(state.sessionId)
  try {
    const turnGen = state.turnGen ?? 0
    const ocId = state.opencodeSessionId
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await postWorkflowWake(state, wfid, content, attempt, turnGen, ocId)
        return
      } catch (error) {
        lastError = error
        if (!isConnectionRefused(error) || attempt > 0) break
        if (!(await waitForOpencodeReady())) break
      }
    }
    if (lastError instanceof WorkflowWakeDispatchError && lastError.retryable) throw lastError
    // 保留原用户直发兜底，但不能把未唤醒伪装成成功，调用者据此记failed/unknown。
    try { await sendWorkflowNotice(state, wfid, kind) }
    catch (error) { console.error(`[gateway] workflow fallback notice failed: session=${state.sessionId} wf=${wfid}`, error) }
    if (lastError instanceof WorkflowWakeDispatchError) throw lastError
    throw new WorkflowWakeDispatchError("not_submitted", "opencode connection unavailable; wake was not submitted", true)
  } finally {
    workflowWakeInFlight.delete(state.sessionId)
  }
}

// ── 修 3：长任务唤醒扫描器（60s 一轮）────────────────────────────────
// 终态（success/failed/partial/paused_insufficient_quota）或停滞（15 分钟无
// 节点进度）→ 向原会话投 resume 唤醒，文案含各节点终态摘要 + billing 真值，
// 让 agent 开一轮诚实汇报后收尾。turn 在途（ackTimer 挂著）时让位——节点
// 事件正在直播，agent 自己会汇报；下一轮扫描再试。投递/状态重置逐行同
// handleResumeSession 的轮子（prompt_async + turn 重置 + 布哨）。
// 由 index.ts 调用 startWorkflowWakeScanner，模块加载时不启动。
let scanner: ReturnType<typeof setInterval> | null = null
export function startWorkflowWakeScanner(): void {
  if (scanner) return
  const timer = setInterval(() => {
  for (const [wfid, w] of workflowWake) {
    const state = sessions.get(w.sessionId)
    if (!state) {
      workflowWake.delete(wfid)
      continue
    }
    const wf = workflowService.get(wfid)
    if (!wf) {
      workflowWake.delete(wfid)
      continue
    }
    const wfStatus = wf.status as string
    const terminal = wfStatus !== "running" && wfStatus !== "building" && wfStatus !== "pending"
    const stalled = !terminal && Date.now() - w.lastProgressAt > WORKFLOW_STALL_MS
    if (!terminal && !stalled) continue
    // 2026-09-24：协作确认闸的暂停是**合法等待**（决策 5 不设超时），不是「跑完了」。
    // 唤醒 agent 只会逼它对用户谎报结果；批准后 runWfGenerate 会重新登记唤醒。
    if (wfStatus === "paused_awaiting_approval") continue
    if (workflowWakeSessionBusy(state)) continue // turn 在途让位，下一轮扫描再唤
    // 停滞判死：卡在 running 的节点 patch 成画布终态（error，与
    // workflow-service/emitImageFailed 的节点失败形状对称）+ 走修 2 退款留痕。
    if (stalled) {
      const stallMin = Math.max(1, Math.round(WORKFLOW_STALL_MS / 60000))
      console.warn(`[gateway] workflow stall: wf=${wfid} no progress for ${stallMin}min, declaring stuck nodes dead`)
      for (const n of wf.graph.nodes) {
        if (wf.nodeStatus[n.id] !== "running") continue
        // 判死的节点其上游 job 仍可能排队→日后成功扣费成孤儿镜：先取消（排队中全额退款）。
        const stuckJob = typeof n.metadata?.last_job_id === "string" ? n.metadata.last_job_id : ""
        if (stuckJob) void cancelPlatformJob(state.apiKey, stuckJob)
        const stallPatch = {
          status: "error" satisfies TaskStatus,
          errorDetails: `停滞超时：超过 ${stallMin} 分钟无任何进度推进，系统已按失败处理`,
          human_message: `渲染停滞超过 ${stallMin} 分钟无推进，系统已将卡住的节点判死并按失败处理`,
        }
        emitToSession(state, "canvas.node.updated", {
          unit_id: wfid,
          node_id: n.id,
          patch: stallPatch,
        })
        // 2026-09-20 写穿：直发路径绕过 emit hook，快照同步在此补上（幂等）。
        applyCanvasNodeUpdated(state.sessionId, { node_id: n.id, patch: stallPatch })
      }
      void sendWorkflowNotice(state, wfid, "stalled")
    }
    workflowWake.delete(wfid)
    void (async () => {
      // 先向控面结算实扣（单一真源），唤醒文案才读得到真值。
      await settleWorkflowCharges(state, wfid).catch(() => null)
      // 唤醒文案：节点终态摘要（用户可见名称）+ billing 真值，agent 只许照实转述。
      const money = workflowBilling.get(wfid)
      const moneyText = money
        ? `真实花费：报价 ${money.confirmed_coins} 币，控制面实扣 ${money.charged_coins ?? "未知"} 币${money.deviation_coins ? `（偏差 ${money.deviation_coins > 0 ? "+" : ""}${money.deviation_coins}）` : ""}，${money.refunded_coins > 0 ? `未使用部分已退 ${money.refunded_coins} 币` : "无退款"}（billing_status=${money.billing_status}）。`
        : "真实花费：本工作流未走批量扣费确认（billing_status=none）。"
      const nodeList = wf.graph.nodes
        .filter((n) => n.kind !== "text" && n.kind !== "config")
        .map((n) => `${n.title || n.kind}：${wf.nodeStatus[n.id] ?? "未知"}`)
        .join("；")
      const head = stalled
        ? "工作流停滞已判死，系统自动唤醒你收尾。"
        : "工作流已到终态，系统自动唤醒你汇报。"
      const content =
        `${head}各节点终态：${nodeList || "无可执行节点"}。${moneyText}` +
        `系统已向用户直发一条含成片链接与控制面实扣币数的通报；你只需简要补充结果与失败原因（一律引用上面的真实状态与 billing 真值，禁止编造，不要重复贴链接/币数），然后结束回合。禁止再用 bash sleep 或反复 workflow_status 轮询。`
      try {
        await dispatchWorkflowWake(state, wfid, content, stalled ? "stalled" : "final")
      } catch (error) {
        if (error instanceof WorkflowWakeDispatchError && error.retryable && !workflowWake.has(wfid)) workflowWake.set(wfid, w)
        console.error(`[gateway] workflow wake not confirmed: session=${state.sessionId} wf=${wfid}`, error)
      }
    })().catch((error) => console.error(`[gateway] workflow wake preparation failed: wf=${wfid}`, error))
  }
}, WORKFLOW_WAKE_SCAN_MS)
  timer.unref?.()
  scanner = timer
}

// workflow 内部端点（loopback）：Deepseek 的 workflow_* 工具呼叫。
export async function handleWorkflowInternal(req: Request, session: SessionState): Promise<Response> {
  // S4 修复（2026-08-27）：S6 质询冻结段引用了未定义的 `state`（本 handler
  // 的参数名是 `session`）——/workflow/generate 一进 S6 分支即 ReferenceError 500。
  // 别名对齐语义（session 即 SessionState），一行修复，不动 S6 逻辑本身。
  const state = session
  const url = new URL(req.url)
  const pathname = url.pathname
  let body: Record<string, unknown> = {}
  if (req.method === "POST") {
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return jsonError(400, "invalid json body", "bad_request", "bad_request")
    }
  }

  const wf = (id: unknown) => {
    const s = typeof id === "string" ? workflowService.get(id) : undefined
    return s
  }

  if (pathname.endsWith("/workflow/templates") && req.method === "GET") {
    return Response.json({ ok: true, templates: workflowService.templates() })
  }
  if (pathname.endsWith("/workflow/start") && req.method === "POST") {
    const templateId = typeof body.template_id === "string" ? body.template_id : (typeof url.searchParams.get("template_id") === "string" ? url.searchParams.get("template_id") : null)
    // P0 idempotent workflow_start（2026-08-31 卡片堆积事故）：gateway 重启 →
    // N1 redrive 重投上一条 prompt → agent 再次呼叫 workflow_start → 旧行为会
    // 新建第二套全新 id 的节点堆上画布（大量卡片重叠 + 连线乱麻 + 整屏闪烁）。
    // 本档既有设计已声明「单 session 只镜像最新工作流，反覆 start 属异常路径」，
    // 这里把它落成硬守卫：同 session 已有同模板且未 success 的工作流 → 复用，
    // 不新建、不重发节点、不发欢迎词；agent 据 reused/note 继续推进或 rerun。
    const ownedWfId = workflowOwnerBySession.get(state.sessionId)
    if (ownedWfId && templateId) {
      const owned = workflowService.get(ownedWfId)
      if (owned && owned.templateId === templateId && owned.status !== "success") {
        console.log(`[gateway] workflow_start reused: session=${state.sessionId} wf=${ownedWfId} status=${owned.status} (P0 idempotent guard)`)
        return Response.json({
          ok: true,
          workflowId: ownedWfId,
          reused: true,
          status: owned.status,
          note: `该会话已存在同模板工作流（workflow_id=${ownedWfId}，status=${owned.status}），本次调用已复用，未新建任何节点。请勿再次调用 workflow_start；失败节点用 workflow_rerun 重跑，推进生成用 workflow_generate。`,
        })
      }
    }
    // S4：start 即发 canvas.plan（cost_hint 需目录）——start 前同步预热目录
    //（带上限 5s，失败/超时照走：cost_hint 保守回 null，不挡搭建）。
    await Promise.race([
      catalogUnitCoins("pixai-tsubaki2", session.apiKey).catch(() => {}),
      new Promise((r) => setTimeout(r, 5000)),
    ])
    const rawContent = body.content && typeof body.content === "object" ? body.content : null
    const content = rawContent ?? (() => {
      // query 参数回退：?content={"role":{"content":"..."}}（URL-encoded JSON）
      const q = url.searchParams.get("content")
      if (!q) return {}
      try {
        const parsed = JSON.parse(q) as Record<string, unknown>
        return parsed && typeof parsed === "object" ? parsed : {}
      } catch {
        return null // 显式标记无效：走模板缺内容报错，不伪造空物件
      }
    })()
    if (content === null) return jsonError(400, "invalid content json (query or body)", "bad_request", "bad_request")
    // R8（2026-09-10）：start 改 async（shotN_gen 动态选可用视频模型需 await
    // model-status 探测）——必须 await，否则「error in r」对 Promise 恒 false，
    // 缺内容 400 守卫失效。
    const r = await workflowService.start(templateId, content as never, session)
    if ("error" in r) return jsonError(400, r.error, "missing_content", "missing_content")
    // R5-C（2026-08-28）：模板启动成功即 emit 零 LLM 欢迎词（毫秒级，不过模型）。
    // 暴君规格：零内部话术、简体、直接可执行。小说影视化模板用专属文案；
    // 其余模板用通用引导。走 emitAgentNotice（message 通道，前端零改动）。
    const wfId = typeof (r as { workflowId?: unknown }).workflowId === "string" ? (r as { workflowId: string }).workflowId : "?"
    const welcomeText =
      templateId === "novel_film"
        ? "欢迎你！这是「小说影视化」流水线：拆剧本 → 锁角色/场景资产 → 分镜关键帧 → 视频/配音/成片。请把小说文件发给我（txt / docx / pdf 都行），或直接粘贴文本。文件到手我会先列章节清单给你过目。\n"
        : "已为你搭好工作流画布。把素材或要求发给我，我会按环节推进，每个节点完成后逐条汇报。\n"
    emitAgentNotice(state, welcomeText)
    console.log(`[gateway] R5-C welcome emitted: template=${templateId} workflow=${wfId} session=${state.sessionId}`)
    return Response.json({ ok: true, ...r })
  }  if (pathname.endsWith("/workflow/node") && req.method === "POST") {
    const r = workflowService.addNode(
      typeof body.workflow_id === "string" ? body.workflow_id : "",
      typeof body.role === "string" ? body.role : "node",
      typeof body.kind === "string" ? body.kind : "image",
      typeof body.title === "string" ? body.title : "节点",
      body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {},
    )
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  if (pathname.endsWith("/workflow/connect") && req.method === "POST") {
    const r = workflowService.connect(typeof body.workflow_id === "string" ? body.workflow_id : "", typeof body.from === "string" ? body.from : "", typeof body.to === "string" ? body.to : "")
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  // workflow_disconnect 工具的 gateway 端路由（2026-08-30 补齐）——service 的
  // removeConnection（含 emittedConnections 去重清理 + canvas.node.disconnected
  // 广播 + dirty 持久化）早已存在，此前只缺这条分发路由，工具层一律 404，
  // agent 无法拆换 cfg 组合。轮子 = 紧邻的 connect 路由同构。
  if (pathname.endsWith("/workflow/disconnect") && req.method === "POST") {
    const r = workflowService.removeConnection(typeof body.workflow_id === "string" ? body.workflow_id : "", typeof body.from === "string" ? body.from : "", typeof body.to === "string" ? body.to : "")
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  // workflow_update_node 工具的 gateway 端路由——service 的 updateNode（含 BFS 下游
  // stale 标记 + canvas.node.updated 广播 + dirty 持久化）早已存在，此前只缺这条
  // 分发路由，工具层一律 404，agent 中期换模型不可得（2026-08-30 秦始皇北极熊
  // 事故根因之一：旧 cfg minimax-h3 按 resolveNodeModel 首个 config 优先压住新接
  // 的 seedance cfg，rerun 永远解析回 H3）。轮子 = 紧邻的 connect 路由同构。
  if (pathname.endsWith("/workflow/node/update") && req.method === "POST") {
    const r = workflowService.updateNode(
      typeof body.workflow_id === "string" ? body.workflow_id : "",
      typeof body.node_id === "string" ? body.node_id : "",
      body.patch && typeof body.patch === "object" ? (body.patch as Record<string, unknown>) : {},
    )
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  if (pathname.endsWith("/workflow/status") && req.method === "GET") {
    const wfid = url.searchParams.get("workflow_id") || (typeof body.workflow_id === "string" ? body.workflow_id : null)
    if (wfid && !workflowService.get(wfid) && state.workflowSnapshot && (state.workflowSnapshot as { workflowId?: unknown }).workflowId === wfid) {
      try {
        restoreWorkflowsFromSnapshot(state)
      } catch {
        // fall through：回灌失败按 not found 诚实回报
      }
    }
    const st = wf(wfid)
    if (!st) return jsonError(404, "workflow not found", "not_found", "not_found")
    // 2026-08-30：工具回显 resolved_model 依赖节点真实 metadata——service.status
    // 只回摘要（无 metadata），在此补上 graph 里的 metadata（工具层才能算出真实
    // 解析模型，AI 无法自欺）。不让 service 轮子动，gateway 端富化即可。
    const statusData = workflowService.status(wfid!) as { nodes: { id: string }[] }
    const metaMap = new Map<string, unknown>(st.graph.nodes.map((n: { id: string; metadata: unknown }) => [n.id, n.metadata ?? {}]))
    statusData.nodes = statusData.nodes.map((n) => ({ ...n, metadata: metaMap.get(n.id) ?? {} }))
    // 修 2：注入 billing 真值（批准额/退款额/状态）——agent 计费话术的唯一依据。
    const billing = workflowBilling.get(wfid!)
    return Response.json({ ok: true, workflow: statusData, ...(billing ? { billing } : {}) })
  }
  if (pathname.endsWith("/workflow/status") && req.method === "POST") {
    // 重启后恢复路径：session 刚 hydrate、workflow 尚未回灌时（快照在 session 上），
    // 先回灌再查——status 永远回真实状态，不因恢复顺序漏掉。
    const wfid = typeof body.workflow_id === "string" ? body.workflow_id : ""
    if (!workflowService.get(wfid) && state.workflowSnapshot && (state.workflowSnapshot as { workflowId?: unknown }).workflowId === wfid) {
      try {
        restoreWorkflowsFromSnapshot(state)
      } catch {
        // fall through：回灌失败按 not found 诚实回报
      }
    }
    const st = wf(wfid)
    if (!st) return jsonError(404, "workflow not found", "not_found", "not_found")
    const statusData = workflowService.status(wfid) as { nodes: { id: string }[] }
    const metaMap = new Map<string, unknown>(st.graph.nodes.map((n: { id: string; metadata: unknown }) => [n.id, n.metadata ?? {}]))
    statusData.nodes = statusData.nodes.map((n) => ({ ...n, metadata: metaMap.get(n.id) ?? {} }))
    // 修 2：同 GET 路径，注入 billing 真值。
    const billing = workflowBilling.get(wfid)
    return Response.json({ ok: true, workflow: statusData, ...(billing ? { billing } : {}) })
  }
  if (pathname.endsWith("/workflow/generate") && req.method === "POST") {
    const wfid = typeof body.workflow_id === "string" ? body.workflow_id : ""
    if (!workflowService.get(wfid)) return jsonError(404, "workflow not found", "not_found", "not_found")
    const wf = workflowService.get(wfid)!
    // H6（2026-10-02）：同步拒绝「已在跑」。旧世界 runWfGenerate 是后台 fire-and-forget，
    // 引擎回 already running 时路由早已回 ok:true running/approved，agent 被假成功误导
    //（01:24 的 10s 改价重跑根本没生效）。在弹确认卡/开跑之前如实回 ok:false。
    // 改价（如 460→750）要重估重确认，必须等当前批次结束或先暂停后再 generate。
    if (workflowService.isGenerating(wfid)) {
      return Response.json(
        {
          ok: false,
          status: "rejected",
          reason: "already_running",
          workflow_id: wfid,
          note: "工作流正在执行中，本次 generate 未生效（没有重新估价、没有新确认卡）。节点参数/价格的修改不会作用于进行中的批次；请等当前批次结束（workflow_status 复核终态）后再调用 workflow_generate，届时会按新价格重新确认。",
        },
        { status: 409 },
      )
    }
    // M4（2026-10-02）机器闸：近 24h 影片零真实交付（有 available 影片模型但无一有 delivered>0，
    // 与 video_quote.evidence_warning 同口径）时，含影片节点的工作流不得直接开跑付费生成，
    // 必须带 override_zero_delivery=true + override_reason（引用用户显式同意）。
    // 探测不可达（models=null）fail-open 与既有行为一致；无影片节点/已覆写则不拦。
    const hasVideoExec = wf.graph.nodes.some((n) => n.kind === "video")
    if (hasVideoExec) {
      const overrideOk = await billingAutoApprovalEnabled(state) || (body.override_zero_delivery === true && typeof body.override_reason === "string" && body.override_reason.trim().length > 0)
      if (!overrideOk) {
        const zd = await videoZeroDelivery24h(state.apiKey)
        if (zd) {
          return Response.json(
            {
              ok: false,
              status: "needs_override",
              reason: "zero_delivery_24h",
              workflow_id: wfid,
              available_video_models: zd.available,
              note: "近 24h 影片零真实交付（available 仅代表探测可达，无交付证据），付费生成未开跑。必须先向用户说明并取得其明确同意；同意后再次调用 workflow_generate 并带 override_zero_delivery=true 与 override_reason（引用用户原话）。用户未同意不得自行覆写。",
              override: { override_zero_delivery: true, override_reason: "<用户同意的原话>" },
            },
            { status: 409 },
          )
        }
      }
    }
    // S4 规格1（2026-08-27）：计费确认门槛改金额维度。旧世界 = 门槛倒挂：
    // 6.25 币的批量 workflow 零确认直接开跑，1 币的单笔重试反而弹卡——因为
    // confirm 只存在于工具层（image_* 单笔），workflow 批量执行完全绕过。
    // 目录coin报价≥门槛时沿用既有确认；缺报价明确409，不将未知价格计零放行。
    // full/auto由既有确认机制持续授权，不绕过报价真值或预算限制。
    invalidateWorkflowPriceCatalog()
    const executableNodes = wf.graph.nodes.filter((n) => n.kind !== "text" && n.kind !== "config" && (n.kind as string) !== "director")
    let estimatedTotal = 0
    for (const n of executableNodes) {
      const coins = await estimateNodeCoins(n, state.apiKey, wf.graph)
      if (coins === null) {
        const videoOptions = n.kind === "video" ? resolveVideoSubmissionOptions({ id: n.id, metadata: n.metadata ?? undefined }, wf.graph, resolveNodeModel(n.id, n, wf.graph)) : null
        return Response.json({ ok: false, code: "workflow_price_unknown", error: videoOptions?.error ?? "当前目录未返回该生成节点的币值价格，预算未知；尚未提交生成。", node_id: n.id, cost_hint: null }, { status: 409 })
      }
      estimatedTotal = Math.round((estimatedTotal + coins) * 1e6) / 1e6
    }
    // R9 扩计画重确认：节点数比上次批准的多（agent 中途加节点）= 新一笔帐，
    // 必须按新总价重弹 confirm——2026-08-29 事故：批准时估 25 币，中途长到
    // 5 支影片实扣 145 币无人再问。
    const approvedBatch = workflowGenerateApproved.get(wfid)
    // 2026-08-31 计费诚实修复：批准快照原本只比节点数不比金额——同一批节点数不变但
    // 参数改变（如时长/档位）导致估价暴涨时不会重新弹卡。金额较上次批准增长超 10%
    //（容差避免浮点误差/目录轻微波动误触发）同样视为需要重新确认。
    const amountGrew = approvedBatch != null && estimatedTotal > approvedBatch.amount * 1.1
    if (estimatedTotal >= CONFIRM_THRESHOLD_COINS && (!approvedBatch || executableNodes.length > approvedBatch.nodes || amountGrew)) {
      const requestId = `wfgen_${wfid}_${Date.now().toString(36)}`
      const growthNote = approvedBatch
        ? amountGrew && executableNodes.length <= approvedBatch.nodes
          ? `（预估金额较上次批准由 ${approvedBatch.amount} 币涨到 ${estimatedTotal} 币，重新确认）`
          : `（节点数较上次批准新增 ${executableNodes.length - approvedBatch.nodes} 个，重新确认）`
        : ""
      const description = `批量执行工作流（${executableNodes.length} 个生成节点，${wf.templateId}），预估花费 ${estimatedTotal} 币${growthNote}`
      // 注册后立即返回 confirm_pending（2026-08-29 整改：不再内联阻塞轮询——
      // 旧版等批准最长 15 分钟，工具层 10s 超时必炸，agent 据此误判后端死亡）。
      // 用户批准 → settleConfirm → runWfGenerate 续跑；拒绝/过期 → 卡片自收，
      // 工作流不动，agent 可用 workflow_status 复核后再议。
      const timer = setTimeout(() => {
        wfGenerateContinuations.delete(requestId)
        settleConfirm(state, requestId, "expired")
      }, CONFIRM_TIMEOUT_MS)
      state.pendingConfirms.set(requestId, {
        timer,
        ledger: { amount_coins: estimatedTotal, model: `workflow:${wf.templateId}` },
      })
      wfGenerateContinuations.set(requestId, { state, wfid, nodes: executableNodes.length, amount: estimatedTotal })
      // 互动模式=auto：批量扣费确认自动批准。wfGenerateContinuations.set 必须先于
      // settleConfirm——settle 的 approved 分支会读该 map 触发 runWfGenerate 续跑。
      // R9 扩计划重确认在 auto 档同样自动放行（同一分支覆盖）。
      if (await billingAutoApprovalEnabled(state)) {
        settleConfirm(state, requestId, "approved")
        return Response.json({ ok: true, status: "approved", request_id: requestId, note: `工作流已提交后台执行（workflow_id=${wfid}）。完成后系统会自动唤醒你汇报结果与真实花费。禁止用 bash sleep 或反复 workflow_status 等待；本轮现在总结已知状态并结束回合。` })
      }
      emitToSession(state, "confirm.request", { request_id: requestId, amount_coins: estimatedTotal, description })
      return Response.json({ ok: true, status: "confirm_pending", request_id: requestId, note: `已弹出批量扣费确认卡（预估 ${estimatedTotal} 币），用户批准后自动开跑。批准后系统会自动唤醒你汇报结果与真实花费；禁止用 bash sleep 或反复 workflow_status 等待，本轮现在总结已知状态并结束回合。` })
    }
    // S6 规格3：质询冻结——最后一条用户消息是质询类且 assistant 尚未回覆
    //（ack timer 还挂著 = turn 在途）期间，含视频节点的工作流不自动开跑
    //（图片小额不冻结）。回答完成（session.idle）时 releasePendingVideoWorkflows
    // 放行。冻结只挂 workflow generate 自动开跑；手动单节点 rerun 不拦。
    const hasVideoNode = wf.graph.nodes.some((n) => n.kind === "video")
    const interrogating =
      typeof state.lastUserMessage === "string" &&
      isInterrogativeMessage(state.lastUserMessage) &&
      state.ackTimer != null // turn 在途：尚未 idle
    if (hasVideoNode && interrogating) {
      if (!state.pendingVideoWorkflows) state.pendingVideoWorkflows = []
      if (!state.pendingVideoWorkflows.includes(wfid)) state.pendingVideoWorkflows.push(wfid)
      console.log(`[gateway] S6 freeze: video workflow ${wfid} held during unanswered user question (session ${state.sessionId})`)
      return Response.json({ ok: true, status: "frozen_pending_reply", note: "用户质询尚未答复，视频任务已暂缓；答复完成后自动继续" })
    }
    // 后台执行：立即回 running，每个节点结果以 canvas.* 事件推送到画布（agent 不阻塞等待）。
    // R5-C（2026-08-28）：preflightBudget 拒绝（余额缺口）时 generate 返回
    // {ok:false, status:缺口文字}，但工具层早已收到 running——拒绝落在后台
    // then 里无人传话，agent/用户两边都看不到。拒绝时把带缺口数字的 status
    // 文本经 message 通道直接 emit 给用户；工作流状态未动（预检在置 running
    // 之前），画布保持可重试。（R5-C emit 逻辑已收进 runWfGenerate，confirm
    // 批准回调共用同一条路径。）
    runWfGenerate(state, wfid)
    return Response.json({ ok: true, status: "running", note: `工作流已提交后台执行（workflow_id=${wfid}）。完成后系统会自动唤醒你汇报结果与真实花费。禁止用 bash sleep 或反复 workflow_status 等待；本轮现在总结已知状态并结束回合。` })
  }
  // S3（2026-08-27）：workflow_rerun_node 的 gateway 端处理器——此前根本不存在
  // 这条路由（工具层呼叫 /internal/workflow/node/rerun 直接落 404）。语义与
  // /workflow/generate 对齐：查快照回灌兜底 → 校验 workflow/节点存在 →
  // 后台重跑（节点+全部下游）→ 立即回 running。会话查找在 dispatcher 已完成
  //（resolveSession 支持 opencode id 与 gateway id 两种键）。
  if (pathname.endsWith("/workflow/node/rerun") && req.method === "POST") {
    const wfid = typeof body.workflow_id === "string" ? body.workflow_id : ""
    const rootNodeId = typeof body.node_id === "string" ? body.node_id : ""
    if (!wfid || !rootNodeId) {
      return jsonError(400, "workflow_id and node_id are required", "bad_request", "bad_request")
    }
    if (!workflowService.get(wfid) && state.workflowSnapshot && (state.workflowSnapshot as { workflowId?: unknown }).workflowId === wfid) {
      try {
        restoreWorkflowsFromSnapshot(state)
      } catch {
        // fall through：回灌失败按 not found 诚实回报
      }
    }
    if (!workflowService.get(wfid)) return jsonError(404, "workflow not found", "not_found", "not_found")
    const wf = workflowService.get(wfid)!
    if (!wf.graph.nodes.some((n) => n.id === rootNodeId)) {
      return jsonError(404, `node not found: ${rootNodeId}`, "not_found", "not_found")
    }
    const rootNode = wf.graph.nodes.find((n) => n.id === rootNodeId)!
    if (rootNode.kind === "text" || rootNode.kind === "config") {
      return jsonError(400, "text/config 节点是参考资料，无需重跑；请对 image/video/audio 节点调用 rerun", "bad_request", "bad_request")
    }
    // INC-0830 rerun 防重门：节点曾提交过上游作业（metadata.last_job_id）时，
    // 先查平台真相再决定放不放行——上游成功=拒绝重跑（除非 force:true 明示弃单），
    // 还在跑=拒绝；查不到真相（作业已删/查询失败）时放行并注明「真相不可得」。
    // 事故根因之三：agent 看不到 job 状态就 rerun，撞出 4 笔重复扣费。
    const prevJobId = typeof rootNode.metadata?.last_job_id === "string" ? rootNode.metadata.last_job_id : ""
    if (prevJobId && (rootNode.kind === "video" || rootNode.kind === "image")) {
      const forceRerun = body.force === true
      const ep = rootNode.kind === "video" ? `/videos/${prevJobId}` : `/images/${prevJobId}`
      let truth: { status?: string; url?: string } | null = null
      try {
        const tRes = await fetch(`${PLATFORM_BASE}/v1${ep}`, {
          headers: { Authorization: `Bearer ${session.apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        const tData = await tRes.json().catch(() => null)
        if (tRes.ok && tData && typeof tData === "object") truth = tData as { status?: string; url?: string }
      } catch {
        truth = null
      }
      if (truth) {
        if (truth.status === "succeeded" && !forceRerun) {
          return jsonError(
            409,
            `拒绝重跑：该节点上一次任务 ${prevJobId} 已在上游成功出片（成果未丢）。请先检查/引用已有结果；确认要放弃并重新生成时带 force:true 重试`,
            "rerun_blocked_previous_succeeded",
            "rerun_blocked_previous_succeeded",
          )
        }
        if (truth.status !== "succeeded" && truth.status !== "failed" && truth.status !== "cancelled" && truth.status !== "canceled" && !forceRerun) {
          return jsonError(
            409,
            `拒绝重跑：该节点上一次任务 ${prevJobId} 仍在执行中（status=${truth.status}），重复提交会重复扣费。等待其完成或带 force:true 明示放弃后重试`,
            "rerun_blocked_in_flight",
            "rerun_blocked_in_flight",
          )
        }
      } else if (!forceRerun) {
        console.warn(`[workflow] rerun guard: job ${prevJobId} truth unavailable for ${rootNodeId}, allowing with caveat`)
      }
    }
    // 后台执行（与 generate 同语义）：立即回 running，节点结果走 canvas.* 事件。
    // rerun 读 start/restore 时绑定的 wf.owner。
    const executionId = `rex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    void workflowService.rerun(wfid, rootNodeId).then((r) => {
      if (!r.ok) console.error(`[workflow] rerun ${wfid}/${rootNodeId} finished: ${r.status}`)
    })
    return Response.json({ ok: true, execution_id: executionId, root_node_id: rootNodeId, status: "running" })
  }
  return jsonError(404, "not found", "not_found", "not_found")
}
