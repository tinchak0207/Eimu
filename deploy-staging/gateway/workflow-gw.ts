// workflow-gw.ts —— 自 index.ts 第二階段 Wave2 抽取：畫布工作流引擎（workflowService 單例＋5 hooks、stateForWorkflow、持久化鏡像 maps、recordWorkflowRefund、workflowWake 掃描器、workflowSnapshotOf/For、restoreWorkflowsFromSnapshot、F1 自動恢復 timer、assembleFilmNode、MODEL_STATUS_TTL/modelStatusCache/fetchModelStatusCached、resolveActiveModel、submitWorkflowNode、workflowServiceTemplates、生成管線、喚醒掃描 setInterval、handleWorkflowInternal），原 index.ts 1378–2666 行，逐行機械搬運。
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { WorkflowService } from "./workflow-service"
import { estimateTtsCoins } from "./pricing-and-validation"
import { compileShotPrompt, parseShotCandidate, shotOutputParams, type ShotJson } from "./video-prompt-schema"
import { loadUserSettings } from "./persistence"
import { sessions, dirtySessions, markDirty } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { opencodeHeaders } from "./opencode-client.ts"
import { catalogUnitCoins, estimateNodeCoins, priceCatalogCache, resolveNodeModel, videoTierPerSecondSync } from "./pricing-gateway.ts"
import { TTS_UPSTREAM, probeTtsUpstream, settleConfirm } from "./media-internal-routes.ts"
import { CONFIRM_THRESHOLD_COINS, CONFIRM_TIMEOUT_MS, OPENCODE_URL, PLATFORM_BASE, TTS_AUDIO_DIR, TTS_PUBLIC_BASE } from "./constants-gateway.ts"
import { jsonError } from "./gw-lib.ts"
import { normalizeUserSettings } from "./sessions-http.ts"
import { applyCanvasNodeUpdated } from "./canvas-cascade-state.ts"
import { humanMessageFor } from "./humanize-gw.ts"
import type { SessionState } from "./types-gateway.ts"
import { appendLedgerFor, emitQuotaChanged } from "./quota-ledger.ts"
import { armWatchdogTimer, isInterrogativeMessage } from "./timers-gw.ts"
import { beastAgentField } from "./session-lifecycle.ts"
import { emitAgentNotice, reportNodeTerminalState } from "./emit-helpers.ts"
import { emitVideoDone } from "./events-translate.ts"
// TODO(整合 Wave2): 以下為「仍住 index.ts 且未在 16 個 export 內」符號的 declare 佔位（stage1 記憶 subagent 佔位符法，bun build 不查名可過）。
// 整合階段換成真 import（bun build 硬查 named import，已實錘）。註：CommandResult 是 index.ts 既有基線錯誤（tsc-baseline-0919 第 12–18 行 TS2304 ×7），如實不補宣告。
// ─────────────────────────── 畫布工作流引擎（暴君策略 v2）
//
// Deepseek 透過 workflow_* 工具填內容（參數/提示詞），本服務展開節點流並執行。
// 執行提交（image/video）由 submitWorkflowNode 完成（帶 session key）。

export const workflowService = new WorkflowService({
  emit: (state, name, data) => {
    const target = (state as SessionState | undefined) ?? stateForWorkflow
    if (target) emitToSession(target, name, data)
    // S6 規格1：節點終態（success/error）幀 → 60s 內面向用戶的主動匯報。
    // 掛在 emit 轉發處：generate/rerun 兩條執行路徑共用此出口，一鉤全收。
    if (target && name === "canvas.node.updated") {
      // 修 2：節點失敗 → 退款留痕先行（匯報文案讀 billing 真值，須先記帳）。
      // 修 3：節點幀 = 進度打點，刷新喚醒登記表的停滯時鐘。
      const d = (data ?? {}) as { unit_id?: unknown; patch?: { status?: unknown } }
      const wfid = typeof d.unit_id === "string" ? d.unit_id : ""
      if (wfid && d.patch?.status === "error") recordWorkflowRefund(target, wfid)
      if (wfid && workflowWake.has(wfid)) workflowWake.get(wfid)!.lastProgressAt = Date.now()
      try {
        reportNodeTerminalState(target, data as Parameters<typeof reportNodeTerminalState>[1])
      } catch (e) {
        console.error(`[gateway] S6 terminal report failed: ${e}`)
      }
    } else if (target && name.startsWith("canvas.") && workflowWake.size > 0) {
      // 修 3：canvas.node.generating 等非終態幀同樣算進度（節點開跑也是推進）。
      const d = (data ?? {}) as { unit_id?: unknown }
      const wfid = typeof d.unit_id === "string" ? d.unit_id : ""
      if (wfid && workflowWake.has(wfid)) workflowWake.get(wfid)!.lastProgressAt = Date.now()
    }
  },
  // S5a：節點失敗人話化掛點（errorDetails 原文 + human_message 中文短句）。
  humanize: humanMessageFor,
  // S4（2026-08-27）：整圖幣耗估價掛點——canvas.plan 的 cost_hint 用。
  // 同步簽名：讀快取目錄；快取缺失時觸發後台刷新，本次回 null（下個 plan 幀
  // 就有值），不阻塞工作流搭建。與 /workflow/generate 門檻估算同一價目
  //（image = 目錄單價 × 1 張/節點，video = 檔位價 5/10 幣/秒（R5-C），model
  // 沿連線向上游 config 解析——與 estimateNodeCoins 完全同口徑）。
  estimateGraphCoins: (graph) => {
    let total = 0
    let sawAny = false
    for (const n of graph.nodes) {
      if (n.kind === "text" || n.kind === "config") continue
      sawAny = true
      if (n.kind === "video") {
        const secs = typeof n.metadata.duration_seconds === "number" && n.metadata.duration_seconds > 0 ? n.metadata.duration_seconds : 5
        total += secs * videoTierPerSecondSync(n, graph)
        continue
      }
      if (n.kind !== "image") continue // audio/film 0 幣
      const model = resolveNodeModel(n.id, n, graph)
      const v = priceCatalogCache?.prices[model]
      if (typeof v !== "number") return null // 有估不出的節點：整圖 null，不編數
      total += v
    }
    if (!sawAny) return null
    return Math.round(total * 1e6) / 1e6
  },
  // R8（2026-09-10 多鏡展開修復）：可用視頻模型動態選型掛點——大片 shotN_gen 不再
  // 寫死 minimax-h3（當前不可用），start 時查 /v1/model-status 選可用視頻模型
  //（輪子 = resolveActiveModel 同源判活；挑選邏輯與其 failover pool 同構：
  // media_type=video + available，按 24h 成功率排序取最優）。選不出回 null
  //（service 側回退引擎默認，submit 前仍有 F2 failover 兜底）。
  pickDefaultVideoModel: async (): Promise<string | null> => {
    const session = stateForWorkflow
    const apiKey = session?.apiKey
    if (!apiKey) return null
    const models = await fetchModelStatusCached(apiKey)
    if (!models) return null
    const pool = (models as Array<{ id: string; media_type?: string; availability?: string; last_24h?: { success_rate?: number } }>)
      .filter((m) => m.media_type === "video" && m.availability === "available")
    if (pool.length === 0) return null
    pool.sort((a, b) => (b.last_24h?.success_rate ?? 0.5) - (a.last_24h?.success_rate ?? 0.5))
    console.log(`[gateway] R8 default video model picked: ${pool[0].id} (available video pool=${pool.length})`)
    return pool[0].id
  },
  // 工作流持久化掛點（對齊 canvas 快照的 markDirty 模式）：狀態每次變更
  // （start/addNode/connect/generate 逐節點）鏡像進 owner session 並防抖落盤。
  onDirty: (wf) => {
    const owner = (wf.owner as SessionState | undefined) ?? null
    if (!owner || !owner.sessionId) return
    workflowOwnerBySession.set(owner.sessionId, wf.workflowId)
    owner.workflowSnapshot = workflowSnapshotOf(wf)
    markDirty(owner)
  },
  runNode: async (node, upstream, graph) => {
    const session = stateForWorkflow
    if (!session) return { nodeId: node.id, ok: false, error: "no active session" }
    // novel_film 配音環：真實 TTS 閉環（同步調用）；拼装（film）仍無上游。
    if (node.kind === "audio") {
      // 配音環：真實 TTS 閉環。取台詞文本（node.metadata 或上游 text 節點），
      // 同步調 TTS 上游；上游缺失時誠實報錯（不造假成功）。
      const meta = node.metadata as Record<string, unknown> | undefined
      const ttsText = String(meta?.text ?? meta?.content ?? meta?.prompt ?? "").trim()
      const probe = await probeTtsUpstream()
      if (!probe.available) {
        return { nodeId: node.id, ok: false, error: `配音（TTS）上游暂不可用：${probe.note}。此环節已編排入工作流，但无法真实生成音轨；请对用户如实说明。` }
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
      const r = await assembleFilmNode(node, upstream, graph)
      if (r.ok && r.content) void emitVideoDone(session, r.content, r.costCoins, node.id, "film")
      return r
    }
    const r = await submitWorkflowNode(session, node, upstream, graph)
    if (r.ok && r.content && node.kind === "video") void emitVideoDone(session, r.content, r.costCoins, node.id, "video")
    return r
  },
})

// runNode 需要目前的 session（key）。workflow 端點都是帶 session 呼叫的，執行前設入。
export let stateForWorkflow: SessionState | null = null

// ---- 工作流持久化（2026-08-27 修復，與 canvasSnapshot 同構）----
// 根因：workflow 狀態只在內存 Map（workflowService.workflows），gateway 重啟即丟，
// 跑到一半的 8 環流水線徹底失聯；canvas 快照已持久化、工作流沒有——不一致。
// 修復：ActiveWorkflow 的可恢復子集鏡像進 owner session 的 workflowSnapshot
// 欄位（隨 session 防抖落盤），重啟懶加載時回灌 workflowService（running →
// error「服務重啟中斷」，不偽造還在跑）。單 session 只鏡像最新工作流——
// 同 session 反覆 start 屬異常路徑，覆蓋即止，不做多工作流列表。
// 前置聲明：markDirty 引用 workflowOwnerBySession，const 提升安全（僅在請求
// 處理時執行，遠晚於模組頂層求值）。
export const workflowOwnerBySession = new Map<string, string>() // sessionId -> workflowId
// F1（2026-08-31）斷點續跑登記表：每進程每工作流只自動續跑一次，防循環重試。
export const autoResumedWorkflows = new Set<string>()

// ── 修 2（2026-09-01）計費終態留痕 + billing 真值 ─────────────────────
// 實測實錘（會話 f340fcab/8b7dc1fd）：批量 confirm approved 25.001/75.001 幣後
// 節點失敗，ledger 零 refund 零 done，agent 卻對用戶說「未產生成功扣款」——
// 話術無帳本依據。本表記每工作流的批准/退款真值：
//   confirm approved 時記 confirmed；節點失敗時照抄 emitImageFailed 的
//   event:"refunded" 輪子寫 ledger 終態行 + 刷餘額；workflow_status 工具結果
//   注入 billing 對象，agent 話術只許引用真值。
export interface WorkflowBillingTruth {
  confirmed_coins: number
  refunded_coins: number
  billing_status: "confirmed" | "refunded" | "settled"
}
export const workflowBilling = new Map<string, WorkflowBillingTruth>()

/** 修 2：節點失敗 → 該工作流退款留痕（每工作流只記一次）+ 餘額刷新。 */
export function recordWorkflowRefund(state: SessionState, wfid: string): void {
  const billing = workflowBilling.get(wfid)
  if (!billing || billing.refunded_coins > 0 || billing.confirmed_coins <= 0) return
  billing.refunded_coins = billing.confirmed_coins
  billing.billing_status = "refunded"
  const wf = workflowService.get(wfid)
  void appendLedgerFor(state, {
    kind: "workflow",
    event: "refunded",
    task_id: wfid,
    model: `workflow:${wf?.templateId ?? "unknown"}`,
    cost_coins: billing.confirmed_coins,
  })
  void emitQuotaChanged(state)
  console.log(`[gateway] workflow refund recorded: wf=${wfid} coins=${billing.confirmed_coins} session=${state.sessionId}`)
}

// ── 修 3（2026-09-01）長任務交接：喚醒登記表 + 掃描器 ────��─────────��───
// workflow_generate 提交後 turn 誠實結束；工作流到終態或停滯（15 分鐘無節點
// 進度）時向原會話投 resume 喚醒（輪子 = handleResumeSession 的 prompt_async
// 投遞 + turn 狀態重置）。掃描器是進程內唯一的 workflow 狀態觀察點——
// workflowService.generate 的 promise 在 runWfGenerate 手裡，poller 摸不到
// 內存工作流狀態，故掛 gateway 不掛 poller（最小改動路徑）。
export const workflowWake = new Map<string, { sessionId: string; lastProgressAt: number }>()
export const WORKFLOW_STALL_MS = Number.parseInt(process.env.WORKFLOW_STALL_MS || "900000", 10) || 900_000
export const WORKFLOW_WAKE_SCAN_MS = 60_000

/** execute_command 工具回應形狀（waveform.ts/master.ts 同款；stage2 整合時改共用匯出）。 */
interface CommandResult { stdout: string; stderr: string; exit_code: number }

/** 畫布節點的寬鬆形狀（graph.nodes 是 unknown[]，消費端逐點收窄）。 */
type CanvasNode = { id?: unknown; kind?: unknown; metadata?: Record<string, unknown> }
/** 謂詞收窄形狀：graph.nodes 元素（id/role/kind/metadata）去除 undefined 的真子類型。 */
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

/** ActiveWorkflow → 可 JSON 化快照（Set 去重狀態不持久——恢復後全部視為已發過，避免重啟後重推前端）。 */
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

/** markDirty 用：取該 session 當前工作流的最新快照；工作流已不在內存 → 保留舊鏡像（清 null）。 */
export function workflowSnapshotFor(state: SessionState): Record<string, unknown> | undefined {
  const wfid = workflowOwnerBySession.get(state.sessionId)
  if (!wfid) return undefined
  const wf = workflowService.get(wfid)
  if (!wf) return state.workflowSnapshot // 已被清掉：保留最後已知狀態
  return workflowSnapshotOf(wf)
}

/**
 * DB 快照 → ActiveWorkflow 回灌（hydrate 路徑，對齊 canvasSnapshot → canvasStates）。
 * 語義：中斷時正在 running 的節點標 error（reason「服務重啟中斷」）——重啟後的
 * status 回應必須是真實狀態，不偽造還在跑。emit 去重集合全量視為已發（重啟後
 * generate 補發只走漏網兜底，不對已恢復節點重播）。
 */
export function restoreWorkflowsFromSnapshot(state: SessionState): void {
  const snap = state.workflowSnapshot
  if (!snap || typeof snap !== "object") return
  const s = snap as Partial<PersistableWorkflow>
  if (typeof s.workflowId !== "string" || !s.workflowId) return
  if (workflowService.get(s.workflowId)) {
    workflowOwnerBySession.set(state.sessionId, s.workflowId)
    return // 已回灌過（冪等）
  }
  const graph = s.graph && typeof s.graph === "object" && Array.isArray((s.graph as { nodes?: unknown[] }).nodes) ? (s.graph as { nodes: unknown[]; connections?: unknown[] }) : null
  if (!graph) return
  const nodeStatus: Record<string, "pending" | "running" | "success" | "error"> = {}
  const interrupted: string[] = []
  for (const [id, st] of Object.entries(s.nodeStatus ?? {})) {
    if (st === "running") {
      // 服務重啟中斷：執行循環已死，這個節點不可能還在跑——誠實標錯，不偽造。
      nodeStatus[id] = "error"
      interrupted.push(id)
    } else if (st === "pending" || st === "success" || st === "error") {
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
    owner: state, // 重新綁定恢復後的 session 物件（舊 owner 已隨重啟消失）
    planEmitted: true,
    emittedNodes: new Set((graph.nodes as { id?: unknown }[]).map((n) => (typeof n?.id === "string" ? n.id : "")).filter(Boolean)),
    emittedConnections: new Set(((Array.isArray(graph.connections) ? graph.connections : []) as { from?: unknown; to?: unknown }[]).map((c) => `${c?.from}->${c?.to}`)),
  }
  // 同步鏡像回 session：恢復後的快照（running→error 轉換）也要落盤，
  // 否則下次重啟又會把同一批 error 節點當 running 再轉一次（結果冪等但狀態漂移）。
  state.workflowSnapshot = workflowSnapshotOf(restored)
  workflowService.restore(restored as never)
  workflowOwnerBySession.set(state.sessionId, restored.workflowId)
  dirtySessions.add(state.sessionId) // 恢復後的鏡像隨防抖落盤（running→error 轉換持久化）
  console.log(`[gateway] workflow restored from db: ${restored.workflowId} (${restored.templateId}, ${interrupted.length} interrupted node(s) -> error)`)
  // Q2/Q3（2026-08-27）：恢復不只寫日誌——中斷節點逐一翻面（畫布幽靈 running
  // → error）+ 一條面向用戶的說明消息（含已成功產物 URL 清單與已扣費，孤兒
  // 產物撈回）。emit 走 replayBuffer（emitToSession），前端 Last-Event-ID 續傳
  // 也能收到；不依賴任何人在線。
  if (interrupted.length > 0) {
    for (const nodeId of interrupted) {
      emitToSession(state, "canvas.node.updated", {
        node_id: nodeId,
        workflow_id: restored.workflowId,
        patch: {
          status: "error",
          errorDetails: "服务重启导致任务中断",
          human_message: "服务重启导致任务中断，中断节点未产生成功扣款；如已扣款以平台账单为准，可在画布上重试该节点。",
        },
      })
    }
    // 孤兒產物撈回：快照裡 success 的 image/video 節點，產物 URL 聚合交付。
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
  // F1（2026-08-31）斷點續跑：重啟時工作流還在跑（節點被中斷，或快照停在
  // running 但進程已死=殭屍 running）→ 恢復後自動續跑。generate() 自帶 R5-B
  // 重用語義：success 節點沿用產物不重跑不重扣，只補跑 error/pending。
  // 每進程每工作流只觸發一次（autoResumedWorkflows），失敗不循環重試；延遲
  // 1.5s 等 hydrate/SSE 重連先完成。paused/building 不自動續（等用戶決策）。
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
      // F1 修（2026-08-31）：stateForWorkflow 由 /internal/workflow/* 請求入口賦值，
      // 離線恢復（重啟後無任何請求）時為 null → runNode 解析不到 session，image
      // 節點全滅 "no active session"。timer 內先補本 session 指針再續跑。
      stateForWorkflow = state
      void workflowService
        .generate(wfid)
        .then((r) => console.log(`[gateway] F1 auto-resume finished: ${wfid} -> ${r.status}`))
        .catch((e) => console.error(`[gateway] F1 auto-resume failed: ${wfid}`, e))
    }, 1500)
    console.log(`[gateway] F1 auto-resume scheduled: ${wfid} (interrupted=${interrupted.length})`)
  }
}

// R7-F（2026-08-29）：成片環後端——Kunpeng composeEngine 輪（gateway/editor/，
// pengfeiqiao/kunpeng pin 872a58b，白名單記賬見 repo vendor/kunpeng/PATCHES.md）。
// 沿連線收集上游 video 產物 → title 最前、shotN 升冪排序 → 下載 → setHarnessState
// 注入 clips（真實時長由 ffprobe 逐段探得）→ exportSelectedMainClips（歸一化→
// concat copy）→ probeRenderedVideo 校驗門 → 落公網目錄。拼接本身不另計費
//（costCoins: 0），視頻段費用已在各 shot 節點確認。
export async function assembleFilmNode(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  upstream: Map<string, string>,
  graph?: { nodes: { id: string; role: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): Promise<{ nodeId: string; ok: boolean; content?: string; costCoins?: number; message?: string; error?: string }> {
  const nodeId = (node as { id?: string }).id || ""
  const incoming = (graph?.connections ?? []).filter((c) => c.to === nodeId).map((c) => c.from)
  const allVideoUpstream = incoming
    .map((from) => graph?.nodes.find((n) => n.id === from))
    .filter((n): n is VideoUpstream => Boolean(n) && typeof n.id === "string" && n.kind === "video")
  const sources = allVideoUpstream
    .map((n) => ({ id: n.id, url: upstream.get(n.id) }))
    .filter((s): s is { id: string; url: string } => Boolean(s.url))
  // 配音混流素材：上游 audio 節點（TTS mp3）的內容 URL，成片後自動混入音軌。
  const audioList = incoming
    .map((from) => graph?.nodes.find((n) => n.id === from))
    .filter((n): n is AudioUpstream => Boolean(n) && typeof n.id === "string" && n.kind === "audio")
    .map((n) => upstream.get(n.id))
    .filter((u): u is string => Boolean(u))
  if (!sources.length) {
    return { nodeId, ok: false, error: "成片环没有已完成的镜头输入：请先完成各视频节点，再执行成片" }
  }
  // P0-B 硬閘門（2026-08-31）：宣告的鏡頭數（上游 video 節點總數）必須等於實際拿到
  // 產物的數量。缺一個都不能拼——修復本次事故「宣告4鏡頭、實際1鏡頭仍標success」。
  if (sources.length < allVideoUpstream.length) {
    const missing = allVideoUpstream.filter((n) => !upstream.get(n.id)).map((n) => n.id)
    return {
      nodeId,
      ok: false,
      error: `成片环鏡頭數量不足：宣告 ${allVideoUpstream.length} 個鏡頭，僅 ${sources.length} 個完成（缺：${missing.join("、")}）。请先完成全部鏡頭節點再执行成片`,
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
      // 平台產物 URL 直接映射本盤路徑（store.tinchak0207.xyz = image-data-api 的公網面，
      // VPS 內 fetch 公網回環慢且不穩）；非平台 URL 才走網絡下載。
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
    })
    const outPath = await exportSelectedMainClips(clipIds)
    const probe = await probeRenderedVideo(ffmpeg, outPath)
    // 校驗門：成片時長不得低於各段輸入時長總和的 90%（歸一化重編碼允許微小誤差）
    const minSec = Math.floor(totalInputSec * 0.9)
    if (probe.durationSec < minSec) {
      return { nodeId, ok: false, error: `成片校验未通过：成片 ${probe.durationSec}s 低于输入总长 ${totalInputSec}s 的 90%` }
    }
    // 配音混流（2026-08-30）：audioList 非空時把 TTS 音軌混進成片。禁 -shortest
    //（不准截斷視頻）；混流任何一步失敗降級純視頻成片，message 註明，不整單報錯。
    let mixedPath = outPath
    let mixNote = ""
    if (audioList.length > 0) {
      try {
        const audioPaths: string[] = []
        let totalAudioSec = 0
        for (let i = 0; i < audioList.length; i += 1) {
          const aPath = path.join(workDir, `audio_${i}.mp3`)
          // 平台產物 URL 直接映射本盤路徑（同鏡頭素材 fast-path 口徑）；其餘走網絡下載。
          const mTts = audioList[i].match(/^https:\/\/store\.tinchak0207\.xyz\/agent\/v1\/audio\/([^/?#]+)$/)
          const mDisk = audioList[i].match(/^https:\/\/store\.tinchak0207\.xyz\/image-data\/files\/(.+)$/)
          if (mTts && !mTts[1].includes("..")) {
            const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join(TTS_AUDIO_DIR, mTts[1]))} ${shq(aPath)}`, timeoutMs: 30000 })
            if (cp.exit_code !== 0) throw new Error("平台音頻本盤缺失")
          } else if (mDisk && !mDisk[1].includes("..")) {
            const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join("/opt/image-data-api/data", mDisk[1]))} ${shq(aPath)}`, timeoutMs: 30000 })
            if (cp.exit_code !== 0) throw new Error("平台音頻本盤缺失")
          } else {
            const res = await fetch(audioList[i], { signal: AbortSignal.timeout(120_000) })
            if (!res.ok) throw new Error(`音頻下載失敗（http ${res.status}）`)
            await Bun.write(aPath, res)
          }
          audioPaths.push(aPath)
          const aProbe = await invoke<CommandResult>("execute_command", {
            command: `${ffmpeg.replace(/ffmpeg$/, "ffprobe")} -v error -show_entries format=duration -of csv=p=0 ${shq(aPath)}`,
            timeoutMs: 15000,
          })
          const aDur = Number.parseFloat((aProbe.stdout || "").trim())
          if (Number.isFinite(aDur) && aDur > 0) totalAudioSec += aDur
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
          if (merged.exit_code !== 0) throw new Error(`多軌合併失敗: ${(merged.stderr || "").slice(-200)}`)
        }
        const mixedOut = path.join(workDir, "film-mixed.mp4")
        const mixed = await invoke<CommandResult>("execute_command", {
          command: `${ffmpeg} -y -i ${shq(outPath)} -i ${shq(trackPath)} -map 0:v -map 1:a -c:v copy -c:a aac -movflags +faststart ${shq(mixedOut)}`,
          timeoutMs: 300000,
        })
        if (mixed.exit_code !== 0) throw new Error(`混流失敗: ${(mixed.stderr || "").slice(-200)}`)
        mixedPath = mixedOut
        // P0-B（2026-08-31）：配音時長明顯短於成片時長 = 覆蓋不足，本次事故音軌只有
        // 0.936 秒配 15.04 秒成片，混流「成功」但實質失能。不阻斷交付（降級不是硬
        // 失敗，跟現有「混流失敗降級純視頻」的寬容度一致），僅把警訊寫進 mixNote。
        if (totalAudioSec > 0 && totalAudioSec < probe.durationSec * 0.5) {
          mixNote = `配音时长（${totalAudioSec.toFixed(1)}s）明显短于成片时长（${probe.durationSec}s），已交付但音轨覆盖不足，请检查配音节点`
          console.log(`[workflow] assembleFilm audio too short: audio=${totalAudioSec}s film=${probe.durationSec}s`)
        }
      } catch (e) {
        mixNote = "配音混流失敗，已交付無音軌版本"
        console.log(`[workflow] assembleFilm audio mix degraded: ${String((e as Error).message ?? e).slice(0, 200)}`)
      }
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
 * 提交單一節點生成：image → /v1/images/generations；video → /v1/videos/generations。
 * 非同步提交後輪詢（202 → task_id → GET {id} → succeeded → result url）。
 * 回傳 OpenAI 相容結果 {ok, content(url), costCoins?}。
 */
// INC-0830：沿連線找視頻節點上游連接的視頻 config 節點（kind=config 且 metadata.kind==="video"），
// 取其 duration_seconds——模板把時長配在 config 節點上，submit 時與 meta/shot 同為時長真源。
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

// F2（2026-08-31）：model-status 15s TTL 快取——舊版每個節點提交前都重新打一次
// /v1/model-status，長 workflow 節點多時等於每節點多一次探測延遲+一次上游打擾。
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
    // 探測不可達：沿用舊快取（fail-open），完全沒快取則回 null 由呼叫方決定
  }
  return modelStatusCache?.models ?? null
}

/**
 * F2（2026-08-31）路由單真源 + 強制跨 provider failover：原邏輯發現模型
 * unavailable 就直接報錯要人手動換模型——這裡改成主動在同 media_type、不同
 * channel_id 的候選裡挑一個接著跑，找不到候選才誠實報錯（不編造成功）。
 * node.metadata.__triedChannels 記錄本節點已知死的渠道，跨重試/跨崩潰恢復
 * （隨 workflow 快照持久化）都不會再選回去。
 */
export async function resolveActiveModel(
  model: string,
  kind: "image" | "video",
  apiKey: string,
  node: CanvasNode,
): Promise<{ model: string; switched: boolean; note?: string; exhausted?: boolean; error?: string }> {
  const models = await fetchModelStatusCached(apiKey)
  if (!models) return { model, switched: false } // 探測端不可達：fail-open，行為與舊版一致
  const entry = models.find((m) => (m as { id?: string }).id === model) as
    | { id: string; media_type?: string; availability?: string; channel_id?: string; note?: string; last_24h?: { success_rate?: number } }
    | undefined
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
      error: `模型 ${model} 不可用（${typeof entry.note === "string" ? entry.note : "渠道故障"}），且没有其他可用渠道可自动切换。请稍后重试或在画布上更换模型`,
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
  const meta = node.metadata
  const nodeId = (node as { id?: string }).id || ""

  // 解析 prompt：優先 node.metadata，其次沿上游連線 BFS 找第一個有內容的 text 節點
  // （大片模板：角色描述 text → 四視圖 config → 各視圖 image；image 的 prompt 繼承自角色描述）
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
  // prompt 解析移到 model/size 之後（shot JSON 需要 model 做按族編譯）

  // 模型解析三級：節點自身 metadata.model → 沿上游 config 節點鏈（與 estimateNodeCoins 報價同口徑）→ 兜底。
  // 視頻兜底必須是活路由模型（metaso/minimax-h3）；seedance-2.0 的唯一供應商 filmera 已 degraded，寫死即死單。
  let model = typeof meta.model === "string" && meta.model ? meta.model : resolveNodeModel(nodeId, node, graph ?? { nodes: [], connections: [] })
  if (node.kind === "video" && (!model || model === "pixai-tsubaki2")) model = "minimax-h3"
  // F2（2026-08-31）：提交前主動查活性+跨 provider failover（取代舊的「探測到
  // unavailable 就報錯」）。放在 shot 編譯之前——編譯要按實際會用的模型族來。
  const failoverResolved = await resolveActiveModel(model, node.kind === "video" ? "video" : "image", session.apiKey, node)
  if (failoverResolved.exhausted) {
    console.error(`[workflow] node ${nodeId} ${failoverResolved.error}`)
    return { nodeId: node.id, ok: false, error: failoverResolved.error! }
  }
  if (failoverResolved.switched) {
    console.log(failoverResolved.note)
    model = failoverResolved.model
    ;(node.metadata as Record<string, unknown>).model = model // 誠實紀律：後續重試/畫布顯示/計費都用實際路由到的模型
  }
  const size = typeof meta.size === "string" ? meta.size : "1024x1024"
  // 結構化 shot JSON 優先：video 節點 prompt 來自 shot JSON 時按模型族編譯成模型最愛的格式。
  let prompt = meta.prompt || meta.content || collectUpstreamPrompt(nodeId) || ""
  let shotSize = size
  let payloadDurationHint: number | undefined = undefined
  const shotCandidate = (parseShotCandidate(meta.shot) ?? parseShotCandidate(prompt)) as ShotJson | null
  if (node.kind === "video" && shotCandidate) {
    prompt = compileShotPrompt(shotCandidate, model)
    const shotParams = shotOutputParams(shotCandidate)
    if (shotParams.duration_seconds !== undefined && typeof meta.duration_seconds !== "number") payloadDurationHint = shotParams.duration_seconds
    if (shotParams.aspect_ratio && typeof meta.size !== "string") shotSize = shotParams.aspect_ratio
  }

  // 參考圖：上游中已完成且有 content 的 image 節點（角色圖/場景圖 → 影片參考）
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
    // INC-0830：時長三級解析 meta → shot → 連線的視頻 config；全部缺失時拒絕提交。
    // 舊版靜默 `?? 5` 是 5 秒片事故根因之一：暴君指定 15s、上游照 5s 出、按條統一價照收。
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
    if (refImages.length) payload.reference = refImages[0]
  } else if (refImages.length) {
    payload.reference = refImages[0]
  }

  if (!prompt) {
    console.error(`[workflow] node ${nodeId} (${node.kind}) has no prompt`)
    return { nodeId: node.id, ok: false, error: "缺少提示词：上游文本节点未填写内容" }
  }

  // F2（2026-08-31）：舊的「提交前探測 unavailable 就報錯」後置檢查已移到函式
  // 前段的 resolveActiveModel（主動 failover，不再是單純報錯）——此處不再重複探測。
  let taskSubmitted = false
  // INC-0830：輪詢響應裡的 attempts 明細（片A 加的 /v1/videos/{id} attempts 陣列）
  // 就地快取——失敗時隨節點錯誤回帶，畫布錯誤卡能看到真話（上游成沒成、誰的鍋）。
  // F1 修（2026-08-31）：聲明必須在函式級——原困在 poll 分支塊內，poll 預算耗盡後
  // 的 taskSubmitted 兜底引用它 → ReferenceError → 誤判 non-retryable → 死錯。
  let lastAttempt: Record<string, unknown> | undefined = undefined
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
      // INC-0830：把上游作業 id 記到節點 metadata.last_job_id——rerun 防重門與節點
      // error 真相都消費它，agent 不再盲跑重複扣費（事故根因之三）。
      try {
        ;(node.metadata as Record<string, unknown>).last_job_id = String(taskId)
      } catch {}
      const pollEndpoint = node.kind === "video" ? `/videos/${taskId}` : `/images/${taskId}`
      // 輪詢：間隔 3s；圖最多 120s、影片最多 300s（seedance 5 秒片可能排隊較久）
      // 2026-08-21（PM 要求）：預算按真實耗時放寬——實測 image 60-90s、kling 8s 影片 >300s
      // （Kling 標準模式約 2-6 分鐘）。video 200 次=600s，image 60 次=180s。
      const pollBudget = node.kind === "video" ? 200 : 60
      const startedAtMs = Date.now()
      const etaSeconds = node.kind === "video" ? 360 : 120
      const wfIdMatch = nodeId.match(/^(.+)-[^-]+-\d+$/)
      for (let i = 0; i < pollBudget; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        // 進度條：每 15s 推一次 elapsed/ETA（percent 封頂 95%，成功事件才是 100%）
        if (i % 5 === 4) {
          const elapsedSec = Math.round((Date.now() - startedAtMs) / 1000)
          const percent = Math.min(95, Math.round((elapsedSec / etaSeconds) * 100))
          const patch = { status: "running", progress: { elapsed_seconds: elapsedSec, eta_seconds: etaSeconds, percent } }
          emitToSession(session, "canvas.node.updated", {
            node_id: nodeId,
            ...(wfIdMatch ? { workflow_id: wfIdMatch[1] } : {}),
            patch,
          })
          applyCanvasNodeUpdated(session.sessionId, { node_id: nodeId, patch })
        }
        const poll = await fetch(`${PLATFORM_BASE}/v1${pollEndpoint}`, {
          headers: { Authorization: `Bearer ${session.apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        const pd = (await poll.json().catch(() => ({}))) as Record<string, any>
        const pdAttempts = (pd as { attempts?: unknown })?.attempts
        if (Array.isArray(pdAttempts) && pdAttempts.length > 0) lastAttempt = pdAttempts[pdAttempts.length - 1] as Record<string, unknown>
        if (pd?.status === "succeeded") {
          const rawUrl = pd?.data?.[0]?.url || pd?.result_url || pd?.url
          // 結果可能是相對 /v1/images/{id}/result，轉成絕對公開 URL（沿用 resolveResultUrl 語義）
          const url = rawUrl
            ? /^https?:\/\//.test(rawUrl)
              ? rawUrl
              : `${PLATFORM_BASE}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
            : ""
          if (url) return { nodeId: node.id, ok: true, content: url, costCoins: pd?.cost_coins }
          break
        }
        if (pd?.status === "failed") {
          console.error(`[workflow] node ${nodeId} generation failed: ${pd?.error?.message}`)
          return { nodeId: node.id, ok: false, error: pd?.error?.message || "generation failed", lastAttempt }
        }
        // R7-A（2026-08-29）失敗即翻面：供應商並發飽和時上游 job 會以 queued +
        // failure_detail（如 "capacity_saturated: ..."）反覆重試、遲遲不到終態 failed；
        // 舊邏輯只認 status==="failed"，明知上游已報失敗信號仍繼續發 running 進度幀，
        // 直到輪詢預算耗盡才報假話術。收到失敗信號立即翻面，不再空轉。
        const pdFail = pd as { failure_class?: unknown; failure_detail?: unknown; status?: unknown } | undefined
        const failSignal =
          typeof pdFail?.failure_class === "string" && pdFail.failure_class
            ? pdFail.failure_class
            : typeof pdFail?.failure_detail === "string" && pdFail.failure_detail
              ? pdFail.failure_detail
              : ""
        if (failSignal && pdFail?.status !== "succeeded") {
          console.error(`[workflow] node ${nodeId} upstream failure signal (${pdFail?.status}): ${failSignal}`)
          return {
            nodeId: node.id,
            ok: false,
            error: "生成失败：任务已提交但上游渠道未能执行（供应商并发满或排队超时）；可在画布上稍后重试或更换模型。若已扣款以平台账单为准",
            lastAttempt,
          }
        }
        if (poll.status >= 400 && poll.status !== 404) {
          console.error(`[workflow] node ${nodeId} poll ${poll.status}: ${(pd as { error?: { message?: string } })?.error?.message}`)
          return { nodeId: node.id, ok: false, error: `poll ${poll.status}`, lastAttempt }
        }
      }
    }
    // 同步回圖兜底
    const url = data?.data?.[0]?.url || data?.result_url || data?.url
    if (res.ok && url) return { nodeId: node.id, ok: true, content: url, costCoins: data?.cost_coins }
    if (taskSubmitted) {
      console.error(`[workflow] node ${nodeId} poll timeout`)
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

// workflow 端點（不需 session）：列模板。
export function workflowServiceTemplates(): Response {
  return Response.json({ ok: true, templates: workflowService.templates() })
}

// S4（2026-08-27）：已批准批量執行的 workflow 記錄（wfid → 批准時的估算額）。
// 語義：confirm 通過是「批准這一整批按此預算開跑」，workflow 內逐節點執行
// 不再重彈 confirm（預算單是事前告知，不取代逐筆扣費確認——但批量 confirm
// 已經是逐筆扣費確認的總閘門，雙重彈卡反而是打擾）。workflow 刪除/重跑
// 不清此記錄：同批重跑金額通常下降，重彈只會造成倒掛復辟。
export const workflowGenerateApproved = new Map<string, { amount: number; nodes: number }>()

// 2026-08-29 整改（session 00c583ed 事故）：批量執行 confirm 的批准續跑註冊表。
// 舊版 /workflow/generate 在 handler 內聯 while 輪詢等用戶批准（最長
// CONFIRM_TIMEOUT_MS=15min），而 workflow_generate 工具層只有 10s AbortSignal——
// 用戶批准慢於 10s 是常態，工具必報 workflow_unreachable，agent 誤判「後端
// 不可達」棄模板轉手動逐鏡。改為非阻塞：彈卡 → 註冊回調 → 立即回
// confirm_pending；settleConfirm(approved) 觸發 runWfGenerate。
export const wfGenerateContinuations = new Map<string, { state: SessionState; wfid: string; nodes: number; amount: number }>()

// 批量執行啟動器（含 S6 質詢凍結檢查）。兩個入口：/workflow/generate 免
// confirm 直呼路徑，與 wfGenerateContinuations 批准回調——凍結語義收攏在此，
// 兩個入口行為一致。
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
  // 修 3：登記喚醒——掃描器據此在終態/停滯時向原會話投 resume（長任務交接）。
  workflowWake.set(wfid, { sessionId: state.sessionId, lastProgressAt: Date.now() })
  void workflowService.generate(wfid).then((r) => {
    if (!r.ok) {
      // 預檢拒絕/早退路徑狀態未必到終態（如餘額預檢拒絕時 status 仍是
      // building）——註銷喚醒登記，拒絕原因已在上方 message.delta 如實播出。
      workflowWake.delete(wfid)
      console.warn(`[gateway] R5-C generate rejected: wf=${wfid} session=${state.sessionId} status=${r.status}`)
      const visible = /[\u4e00-\u9fff]/.test(r.status)
        ? r.status
        : `工作流未能启动（${r.status}）。请调整后重试。`
      emitToSession(state, "message.delta", { text: visible + "\n" })
      return
    }
    // 修 2：全節點成功 → billing 真值置 settled（帳實相符的終態）。
    if (r.status === "success") {
      const billing = workflowBilling.get(wfid)
      if (billing) billing.billing_status = "settled"
    }
    console.log(`[gateway] workflow ${wfid} finished ok`)
  })
}

// ── 修 3：長任務喚醒掃描器（60s 一輪）────────────────────────────────
// 終態（success/failed/partial/paused_insufficient_quota）或停滯（15 分鐘無
// 節點進度）→ 向原會話投 resume 喚醒，文案含各節點終態摘要 + billing 真值，
// 讓 agent 開一輪誠實匯報後收尾。turn 在途（ackTimer 掛著）時讓位——節點
// 事件正在直播，agent 自己會匯報；下一輪掃描再試。投遞/狀態重置逐行同
// handleResumeSession 的輪子（prompt_async + turn 重置 + 布哨）。
setInterval(() => {
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
    if (state.ackTimer != null) continue // turn 在途讓位，下一輪掃描再喚
    // 停滯判死：卡在 running 的節點 patch 成畫布終態（error，與
    // workflow-service/emitImageFailed 的節點失敗形狀對稱）+ 走修 2 退款留痕。
    if (stalled) {
      console.warn(`[gateway] workflow stall: wf=${wfid} no progress for ${(WORKFLOW_STALL_MS / 60000) | 0}min, declaring stuck nodes dead`)
      for (const n of wf.graph.nodes) {
        if (wf.nodeStatus[n.id] !== "running") continue
        emitToSession(state, "canvas.node.updated", {
          unit_id: wfid,
          node_id: n.id,
          patch: {
            status: "error",
            errorDetails: "停滞超时：超过 15 分钟无任何进度推进，系统已按失败处理",
            human_message: "渲染停滞超过 15 分钟无推进，系统已将卡住的节点判死并按失败处理",
          },
        })
      }
      recordWorkflowRefund(state, wfid)
    }
    workflowWake.delete(wfid)
    // 喚醒文案：節點終態摘要（用戶可見名稱）+ billing 真值，agent 只許照實轉述。
    const money = workflowBilling.get(wfid)
    const moneyText = money
      ? `真实花费：已批准扣费 ${money.confirmed_coins} 币，${money.refunded_coins > 0 ? `失败部分已全额退回 ${money.refunded_coins} 币` : "无退款"}（billing_status=${money.billing_status}）。`
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
      `请立即向用户汇报本次工作流的最终结果（成功产物、失败原因、真实花费与退款情况——一律引用上面的真实状态与 billing 真值，禁止编造），然后结束回合。禁止再用 bash sleep 或反复 workflow_status 轮询。`
    fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ ...beastAgentField(state), parts: [{ type: "text", text: content }] }),
      signal: AbortSignal.timeout(10000),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        state.lastPromptBody = { ...beastAgentField(state), parts: [{ type: "text", text: content }] }
        state.turnGen = (state.turnGen ?? 0) + 1
        state.turnTextChars = 0
        state.turnReasoningChars = 0
        state.turnRetries = 0
        state.turnAborted = false
        state.retryQueued = false
        state.turnUpstreamError = null
        state.turnToolStarted = false
        state.watchdogRetried = false
        state.questionAnsweredThisTurn = false
        state.deathDeclared = false
        armWatchdogTimer(state)
        console.log(`[gateway] workflow wake resumed: session=${state.sessionId} wf=${wfid}`)
      })
      .catch((e: unknown) => {
        console.error(`[gateway] workflow wake dispatch failed: session=${state.sessionId} wf=${wfid}:`, e)
      })
  }
}, WORKFLOW_WAKE_SCAN_MS)

// workflow 內部端點（loopback）：Deepseek 的 workflow_* 工具呼叫。
export async function handleWorkflowInternal(req: Request, session: SessionState): Promise<Response> {
  // S4 修復（2026-08-27）：S6 質詢凍結段引用了未定義的 `state`（本 handler
  // 的參數名是 `session`）——/workflow/generate 一進 S6 分支即 ReferenceError 500。
  // 別名對齊語義（session 即 SessionState），一行修復，不動 S6 邏輯本身。
  const state = session
  const url = new URL(req.url)
  const pathname = url.pathname
  stateForWorkflow = session
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
    // P0 idempotent workflow_start（2026-08-31 卡片堆積事故）：gateway 重啟 →
    // N1 redrive 重投上一條 prompt → agent 再次呼叫 workflow_start → 舊行為會
    // 新建第二套全新 id 的節點堆上畫布（大量卡片重疊 + 連線亂麻 + 整屏閃爍）。
    // 本檔既有設計已聲明「單 session 只鏡像最新工作流，反覆 start 屬異常路徑」，
    // 這裡把它落成硬守衛：同 session 已有同模板且未 success 的工作流 → 復用，
    // 不新建、不重發節點、不發歡迎詞；agent 據 reused/note 繼續推進或 rerun。
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
    // S4：start 即發 canvas.plan（cost_hint 需目錄）——start 前同步預熱目錄
    //（帶上限 5s，失敗/超時照走：cost_hint 保守回 null，不擋搭建）。
    await Promise.race([
      catalogUnitCoins("pixai-tsubaki2", session.apiKey).catch(() => {}),
      new Promise((r) => setTimeout(r, 5000)),
    ])
    const rawContent = body.content && typeof body.content === "object" ? body.content : null
    const content = rawContent ?? (() => {
      // query 參數回退：?content={"role":{"content":"..."}}（URL-encoded JSON）
      const q = url.searchParams.get("content")
      if (!q) return {}
      try {
        const parsed = JSON.parse(q) as Record<string, unknown>
        return parsed && typeof parsed === "object" ? parsed : {}
      } catch {
        return null // 顯式標記無效：走模板缺內容報錯，不偽造空物件
      }
    })()
    if (content === null) return jsonError(400, "invalid content json (query or body)", "bad_request", "bad_request")
    // R8（2026-09-10）：start 改 async（shotN_gen 動態選可用視頻模型需 await
    // model-status 探測）——必須 await，否則「error in r」對 Promise 恆 false，
    // 缺內容 400 守衛失效。
    const r = await workflowService.start(templateId, content as never, session)
    if ("error" in r) return jsonError(400, r.error, "missing_content", "missing_content")
    // R5-C（2026-08-28）：模板啟動成功即 emit 零 LLM 歡迎詞（毫秒級，不過模型）。
    // 暴君規格：零內部話術、簡體、直接可執行。小說影視化模板用專屬文案；
    // 其餘模板用通用引導。走 emitAgentNotice（message 通道，前端零改動）。
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
  // workflow_disconnect 工具的 gateway 端路由（2026-08-30 補齊）——service 的
  // removeConnection（含 emittedConnections 去重清理 + canvas.node.disconnected
  // 廣播 + dirty 持久化）早已存在，此前只缺這條分發路由，工具層一律 404，
  // agent 無法拆換 cfg 組合。輪子 = 緊鄰的 connect 路由同構。
  if (pathname.endsWith("/workflow/disconnect") && req.method === "POST") {
    const r = workflowService.removeConnection(typeof body.workflow_id === "string" ? body.workflow_id : "", typeof body.from === "string" ? body.from : "", typeof body.to === "string" ? body.to : "")
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  // workflow_update_node 工具的 gateway 端路由——service 的 updateNode（含 BFS 下游
  // stale 標記 + canvas.node.updated 廣播 + dirty 持久化）早已存在，此前只缺這條
  // 分發路由，工具層一律 404，agent 中期換模型不可得（2026-08-30 秦始皇北極熊
  // 事故根因之一：舊 cfg minimax-h3 按 resolveNodeModel 首個 config 優先壓住新接
  // 的 seedance cfg，rerun 永遠解析回 H3）。輪子 = 緊鄰的 connect 路由同構。
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
        // fall through：回灌失敗按 not found 誠實回報
      }
    }
    const st = wf(wfid)
    if (!st) return jsonError(404, "workflow not found", "not_found", "not_found")
    // 2026-08-30：工具回顯 resolved_model 依賴節點真實 metadata——service.status
    // 只回摘要（無 metadata），在此補上 graph 裡的 metadata（工具層才能算出真實
    // 解析模型，AI 無法自欺）。不讓 service 輪子動，gateway 端富化即可。
    const statusData = workflowService.status(wfid!) as { nodes: { id: string }[] }
    const metaMap = new Map<string, unknown>(st.graph.nodes.map((n: { id: string; metadata: unknown }) => [n.id, n.metadata ?? {}]))
    statusData.nodes = statusData.nodes.map((n) => ({ ...n, metadata: metaMap.get(n.id) ?? {} }))
    // 修 2：注入 billing 真值（批准額/退款額/狀態）——agent 計費話術的唯一依據。
    const billing = workflowBilling.get(wfid!)
    return Response.json({ ok: true, workflow: statusData, ...(billing ? { billing } : {}) })
  }
  if (pathname.endsWith("/workflow/status") && req.method === "POST") {
    // 重啟後恢復路徑：session 剛 hydrate、workflow 尚未回灌時（快照在 session 上），
    // 先回灌再查——status 永遠回真實狀態，不因恢復順序漏掉。
    const wfid = typeof body.workflow_id === "string" ? body.workflow_id : ""
    if (!workflowService.get(wfid) && state.workflowSnapshot && (state.workflowSnapshot as { workflowId?: unknown }).workflowId === wfid) {
      try {
        restoreWorkflowsFromSnapshot(state)
      } catch {
        // fall through：回灌失敗按 not found 誠實回報
      }
    }
    const st = wf(wfid)
    if (!st) return jsonError(404, "workflow not found", "not_found", "not_found")
    const statusData = workflowService.status(wfid) as { nodes: { id: string }[] }
    const metaMap = new Map<string, unknown>(st.graph.nodes.map((n: { id: string; metadata: unknown }) => [n.id, n.metadata ?? {}]))
    statusData.nodes = statusData.nodes.map((n) => ({ ...n, metadata: metaMap.get(n.id) ?? {} }))
    // 修 2：同 GET 路徑，注入 billing 真值。
    const billing = workflowBilling.get(wfid)
    return Response.json({ ok: true, workflow: statusData, ...(billing ? { billing } : {}) })
  }
  if (pathname.endsWith("/workflow/generate") && req.method === "POST") {
    const wfid = typeof body.workflow_id === "string" ? body.workflow_id : ""
    if (!workflowService.get(wfid)) return jsonError(404, "workflow not found", "not_found", "not_found")
    const wf = workflowService.get(wfid)!
    // S4 規格1（2026-08-27）：計費確認門檻改金額維度。舊世界 = 門檻倒掛：
    // 6.25 幣的批量 workflow 零確認直接開跑，1 幣的單筆重試反而彈卡——因為
    // confirm 只存在於工具層（image_* 單筆），workflow 批量執行完全繞過。
    // 統一基準：估算總價 ≥ CONFIRM_THRESHOLD_COINS（默認 5 幣）→ gateway
    // 直接向用戶彈 confirm.request，批准前不開跑（真拒絕窗口，不是同回合
    // 報價）；< 門檻免擾自動跑。估算口徑與 quote_bundle / cost_hint 同源
    //（目錄單價 × 數量 + 影片檔位價 5/10 幣/秒（R5-C））。估不出單價的節點計 0（目錄
    // 不可達時寧可放行小額，也不無限期卡死工作流——單筆扣費仍有工具層
    // confirm 兜底）。金額與本次估算寫回 workflow 記錄，避免重複批准：
    // 批准後 workflowGenerateApproved.set(wfid)，同批執行不二次彈卡。
    const executableNodes = wf.graph.nodes.filter((n) => n.kind !== "text" && n.kind !== "config")
    let estimatedTotal = 0
    for (const n of executableNodes) {
      const coins = await estimateNodeCoins(n, state.apiKey, wf.graph)
      if (coins !== null) estimatedTotal = Math.round((estimatedTotal + coins) * 1e6) / 1e6
    }
    // R9 擴計畫重確認：節點數比上次批准的多（agent 中途加節點）= 新一筆帳，
    // 必須按新總價重彈 confirm——2026-08-29 事故：批准時估 25 幣，中途長到
    // 5 支影片實扣 145 幣無人再問。
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
      // 註冊後立即返回 confirm_pending（2026-08-29 整改：不再內聯阻塞輪詢——
      // 舊版等批准最長 15 分鐘，工具層 10s 超時必炸，agent 據此誤判後端死亡）。
      // 用戶批准 → settleConfirm → runWfGenerate 續跑；拒絕/過期 → 卡片自收，
      // 工作流不動，agent 可用 workflow_status 复核後再議。
      emitToSession(state, "confirm.request", { request_id: requestId, amount_coins: estimatedTotal, description })
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
      if (normalizeUserSettings(loadUserSettings(state.apiKey)).interaction_mode === "auto") {
        settleConfirm(state, requestId, "approved")
        return Response.json({ ok: true, status: "approved", request_id: requestId, note: `工作流已提交后台执行（workflow_id=${wfid}）。完成后系统会自动唤醒你汇报结果与真实花费。禁止用 bash sleep 或反复 workflow_status 等待；本轮现在总结已知状态并结束回合。` })
      }
      return Response.json({ ok: true, status: "confirm_pending", request_id: requestId, note: `已弹出批量扣费确认卡（预估 ${estimatedTotal} 币），用户批准后自动开跑。批准后系统会自动唤醒你汇报结果与真实花费；禁止用 bash sleep 或反复 workflow_status 等待，本轮现在总结已知状态并结束回合。` })
    }
    // S6 規格3：質詢凍結——最後一條用戶消息是質詢類且 assistant 尚未回覆
    //（ack timer 還掛著 = turn 在途）期間，含視頻節點的工作流不自動開跑
    //（圖片小額不凍結）。回答完成（session.idle）時 releasePendingVideoWorkflows
    // 放行。凍結只掛 workflow generate 自動開跑；手動單節點 rerun 不攔。
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
    // 後台執行：立即回 running，每個節點結果以 canvas.* 事件推送到畫布（agent 不阻塞等待）。
    // R5-C（2026-08-28）：preflightBudget 拒絕（餘額缺口）時 generate 返回
    // {ok:false, status:缺口文字}，但工具層早已收到 running——拒絕落在後台
    // then 裡無人傳話，agent/用戶兩邊都看不到。拒絕時把帶缺口數字的 status
    // 文本經 message 通道直接 emit 給用戶；工作流狀態未動（預檢在置 running
    // 之前），畫布保持可重試。（R5-C emit 邏輯已收進 runWfGenerate，confirm
    // 批准回調共用同一條路徑。）
    runWfGenerate(state, wfid)
    return Response.json({ ok: true, status: "running", note: `工作流已提交后台执行（workflow_id=${wfid}）。完成后系统会自动唤醒你汇报结果与真实花费。禁止用 bash sleep 或反复 workflow_status 等待；本轮现在总结已知状态并结束回合。` })
  }
  // S3（2026-08-27）：workflow_rerun_node 的 gateway 端處理器——此前根本不存在
  // 這條路由（工具層呼叫 /internal/workflow/node/rerun 直接落 404）。語義與
  // /workflow/generate 對齊：查快照回灌兜底 → 校驗 workflow/節點存在 →
  // 後台重跑（節點+全部下游）→ 立即回 running。會話查找在 dispatcher 已完成
  //（resolveSession 支持 opencode id 與 gateway id 兩種鍵）。
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
        // fall through：回灌失敗按 not found 誠實回報
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
    // INC-0830 rerun 防重門：節點曾提交過上游作業（metadata.last_job_id）時，
    // 先查平台真相再決定放不放行——上游成功=拒絕重跑（除非 force:true 明示棄單），
    // 還在跑=拒絕；查不到真相（作業已刪/查詢失敗）時放行並註明「真相不可得」。
    // 事故根因之三：agent 看不到 job 狀態就 rerun，撞出 4 筆重複扣費。
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
    // 後台執行（與 generate 同語義）：立即回 running，節點結果走 canvas.* 事件。
    // stateForWorkflow 已在 handleWorkflowInternal 開頭設為本次 session。
    const executionId = `rex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    void workflowService.rerun(wfid, rootNodeId).then((r) => {
      if (!r.ok) console.error(`[workflow] rerun ${wfid}/${rootNodeId} finished: ${r.status}`)
    })
    return Response.json({ ok: true, execution_id: executionId, root_node_id: rootNodeId, status: "running" })
  }
  return jsonError(404, "not found", "not_found", "not_found")
}
