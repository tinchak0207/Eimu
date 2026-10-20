import type { SessionState } from "./types-gateway.ts"

/** 已推送过的 workflowId（含推送失败——不重试，避免站点挂掉时反覆打）。 */
export const workflowCompletionPushed = new Set<string>()
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
// ── 2026-10-02 e2e 成片评测三死线：控面为准的实扣结算 / 排队换道 / 孤儿镜取消 / 直推通报 ──
/** 每工作流提交过的上游 job（供终态向控面结算实扣、停滞/放弃时取消）。 */
export const workflowJobs = new Map<string, Map<string, { nodeId: string; kind: "video" | "image" }>>()
capMap(workflowJobs)
/** 已直推过通报的 key（wfid:kind）。 */
export const workflowNoticeSent = new Set<string>()
capSet(workflowNoticeSent)
// ── 修 3（2026-09-01）长任务交接：唤醒登记表 + 扫描器 ────��─────────��───
// workflow_generate 提交后 turn 诚实结束；工作流到终态或停滞（15 分钟无节点
// 进度）时向原会话投 resume 唤醒（轮子 = handleResumeSession 的 prompt_async
// 投递 + turn 状态重置）。扫描器是进程内唯一的 workflow 状态观察点——
// workflowService.generate 的 promise 在 runWfGenerate 手里，poller 摸不到
// 内存工作流状态，故挂 gateway 不挂 poller（最小改动路径）。
export const workflowWake = new Map<string, { sessionId: string; lastProgressAt: number }>()
capMap(workflowWake)
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
// 同一会话同时到期的wakeup/cron/workflow只能有一个在途提交。
export const workflowWakeInFlight = new Set<string>()
capSet(workflowWakeInFlight)
