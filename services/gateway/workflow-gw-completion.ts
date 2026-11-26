import { createHash } from "node:crypto"
import { gateWorkflowMemory } from "./jev-gate"
import { emitToSession } from "./sse-core.ts"
import { isInterrogativeMessage } from "./timers-gw.ts"
import type { SessionState } from "./types-gateway.ts"
import { workflowService, sendWorkflowNotice, markGateNodeState, deliverableProduced } from "./workflow-gw-service.ts"
import { workflowOwnerBySession, workflowCompletionPushed, workflowBilling, workflowWake, workflowGateApprovals, wfGateContinuations } from "./workflow-gw-state.ts"

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
