import { createHash } from "node:crypto"
import { WorkflowService } from "./workflow-service"
import { estimateTtsCoins } from "./pricing-and-validation"
import { loadUserSettings, getCriticVerdictByRun } from "./persistence"
import { enqueueWorkflowCriticReview, hasWorkflowCriticReview } from "./subagent.ts"
import { VIDEO_MOTION_RECEIPT_POLICY } from "./delivery-gate.ts"
import { billingAutoApprovalEnabled } from "./charge-approval-policy.ts"
import { sessions, markDirty } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { opencodeHeaders } from "./opencode-client.ts"
import { videoNodeCoinsSync, resolveNodeModel, priceCatalogCache, PRICE_CATALOG_TTL_MS } from "./pricing-gateway.ts"
import { TTS_UPSTREAM, probeTtsUpstream } from "./media-internal-routes.ts"
import { OPENCODE_URL, TTS_AUDIO_DIR, TTS_PUBLIC_BASE, PLATFORM_BASE } from "./constants-gateway.ts"
import { pickVideoModel, type ModelStatusEntryLike } from "./video-model-select.ts"
import { normalizeUserSettings } from "./sessions-http.ts"
import { applyCanvasNodeCreated, applyCanvasNodeConnected, applyCanvasNodeDisconnected, applyCanvasNodeUpdated } from "./canvas-cascade-state.ts"
import { humanMessageFor } from "./humanize-gw.ts"
import type { SessionState, TaskStatus } from "./types-gateway.ts"
import { appendLedgerFor, emitQuotaChanged } from "./quota-ledger.ts"
import { armWatchdogTimer } from "./timers-gw.ts"
import { beastAgentField } from "./session-lifecycle.ts"
import { emitAgentNotice, reportNodeTerminalState } from "./emit-helpers.ts"
import { emitVideoDone } from "./events-translate.ts"
import { parseShotCandidate } from "./video-prompt-schema"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { resolveConnectedVideoDuration, fetchModelStatusCached, submitWorkflowNode, workflowSnapshotOf, cancelPlatformJob } from "./workflow-gw-submit.ts"
import { assembleFilmNode } from "./workflow-gw-assemble.ts"
import type { WorkflowBillingTruth } from "./workflow-gw-state.ts"
import { workflowOwnerBySession, workflowWake, workflowBilling, workflowJobs, workflowWakeInFlight, workflowNoticeSent, workflowGateApprovals, wfGateContinuations, wfGenerateContinuations, workflowCompletionPushed, autoResumedWorkflows, workflowGenerateApproved } from "./workflow-gw-state.ts"

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
export const WORKFLOW_STALL_MS = Number.parseInt(process.env.WORKFLOW_STALL_MS || "360000", 10) || 360_000
export const WORKFLOW_WAKE_SCAN_MS = 60_000
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
export function markGateNodeState(
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
  // 函数入口 `=== "user"` 的窄化会跨越 fetch 残留成 "system"，这里重新读取并显式取宽类型。
  const abortSource = state.turnAbortSource as SessionState["turnAbortSource"]
  if (state.turnAborted || abortSource === "user" || (state.turnGen ?? 0) !== turnGen || state.opencodeSessionId !== ocId) return
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
