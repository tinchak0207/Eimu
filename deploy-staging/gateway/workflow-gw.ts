import { catalogUnitCoins, estimateNodeCoins, resolveVideoSubmissionOptions, resolveNodeModel, invalidateWorkflowPriceCatalog } from "./pricing-gateway.ts"
import { CONFIRM_THRESHOLD_COINS, CONFIRM_TIMEOUT_MS, PLATFORM_BASE } from "./constants-gateway.ts"
import { settleConfirm } from "./media-internal-routes.ts"
import { billingAutoApprovalEnabled } from "./charge-approval-policy.ts"
import { sessions, dirtySessions, markDirty } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { jsonError } from "./gw-lib.ts"
import { emitAgentNotice } from "./emit-helpers.ts"
import { applyCanvasNodeUpdated } from "./canvas-cascade-state.ts"
import { isInterrogativeMessage } from "./timers-gw.ts"
import type { SessionState, TaskStatus } from "./types-gateway.ts"
import { workflowOwnerBySession, workflowJobs, workflowWake, autoResumedWorkflows, workflowBilling, workflowGenerateApproved, wfGenerateContinuations } from "./workflow-gw-state.ts"
import { cancelPlatformJob, workflowSnapshotOf, videoZeroDelivery24h, type PersistableWorkflow } from "./workflow-gw-submit.ts"
import { workflowService, sendWorkflowNotice } from "./workflow-gw-service.ts"
import { pushWorkflowCompletion, runWfGenerate } from "./workflow-gw-completion.ts"
export { workflowCompletionPushed, stateForWorkflow, workflowOwnerBySession, autoResumedWorkflows, workflowBilling, workflowJobs, workflowNoticeSent, workflowWake, workflowGenerateApproved, wfGenerateContinuations, workflowGateApprovals, wfGateContinuations } from "./workflow-gw-state.ts"
export { registerWorkflowTask, firstSentence, formatNodeFailure, QUEUE_SWITCH_MS, wfidFromNodeId, cancelPlatformJob, pickSamePriceVideoAlternative, workflowSnapshotOf, resolveConnectedVideoDuration, MODEL_STATUS_TTL_MS, modelStatusCache, fetchModelStatusCached, videoZeroDelivery24h, resolveActiveModel, submitWorkflowNode } from "./workflow-gw-submit.ts"
export { assembleFilmNode } from "./workflow-gw-assemble.ts"
export { workflowService, recordWorkflowApproval, recordWorkflowRefund, settleWorkflowCharges, sendWorkflowNotice, WORKFLOW_STALL_MS, WORKFLOW_WAKE_SCAN_MS, COLLABORATE_GATE_ROLES, COLLABORATE_GATE_LABELS, deliverableProduced, resolveCollaborateGate, collaboratePauseNotice, requestCollaborateApproval, WAKE_RECOVERY_WAIT_MS, isConnectionRefused, waitForOpencodeReady, WorkflowWakeDispatchError, releaseWorkflowSession, dispatchWorkflowWake, startWorkflowWakeScanner } from "./workflow-gw-service.ts"
export { SITE_COMPLETION_URL, pushWorkflowCompletion, resumeWorkflowGate, runWfGenerate } from "./workflow-gw-completion.ts"
export type { PersistableWorkflow } from "./workflow-gw-submit.ts"
export type { WorkflowBillingTruth } from "./workflow-gw-state.ts"
export type { WorkflowChargeReport } from "./workflow-gw-service.ts"

// workflow-gw.ts —— 自 index.ts 第二阶段 Wave2 抽取：画布工作流引擎（workflowService 单例＋5 hooks、stateForWorkflow、持久化镜像 maps、recordWorkflowRefund、workflowWake 扫描器、workflowSnapshotOf/For、restoreWorkflowsFromSnapshot、F1 自动恢复 timer、assembleFilmNode、MODEL_STATUS_TTL/modelStatusCache/fetchModelStatusCached、resolveActiveModel、submitWorkflowNode、workflowServiceTemplates、生成管线、唤醒扫描 setInterval、handleWorkflowInternal），原 index.ts 1378–2666 行，逐行机械搬运。
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
// workflow 端点（不需 session）：列模板。
export function workflowServiceTemplates(): Response {
  return Response.json({ ok: true, templates: workflowService.templates() })
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
        settleConfirm(state, requestId, "approved", { auto: true })
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
