import type { SessionState } from "./types-gateway"
import { generationStepDrainRequested, queueLegacyGenerationWake, generationWorkControl } from "./job-store"
import { persistSessionNow } from "./sessions-core"
import { opencodeFetch } from "./opencode-client"
import { emitToSession } from "./sse-core"

const pausing=new WeakSet<SessionState>()
/** 仅在已持久化工具终态/模型步骤边界进入，运行中的外部工具绝不中断。 */
export function pauseAtDeploymentStepBoundary(state: SessionState): boolean {
  if(!generationStepDrainRequested() || !(state.lastTurnActiveAt??0) || state.turnAborted || state.toolRunningCalls?.size || pausing.has(state)) return false
  pausing.add(state)
  const generation=state.turnGen??0
  // 先记稳定通知身份再停。发布重启和重复终态事件均复用既有耐久inbox，禁止重放用户原文。
  const delivery=queueLegacyGenerationWake(state.opencodeSessionId,
    `发布已在步骤边界暂停此任务。沿用当前会话和项目：先game_project status读取最近检查点与付费operation_id，从未完成步骤接续；不得重新生成已完成资产，不重复扣费。turn_generation=${state.turnGen??0}`,
    state.sessionId,state.opencodeSessionId,generationWorkControl(state.sessionId).version)
  state.turnAborted=true
  state.turnAbortSource="system"
  state.retryQueued=true
  if(!persistSessionNow(state)) {
    state.turnAborted=false; state.retryQueued=false; state.lastTurnActiveAt=Date.now()
    pausing.delete(state)
    return false
  }
  void opencodeFetch(`/session/${state.opencodeSessionId}/abort`,{method:"POST",timeoutMs:5000}).then(response=>{
    if(!response.ok) throw new Error(`HTTP ${response.status}`)
    if((state.turnGen??0)!==generation) return
    // 请求发出不等于已停；收到执行端成功响应后才耐久发布空闲事实。
    state.lastTurnActiveAt=0
    if(!persistSessionNow(state)) throw new Error("step drain idle checkpoint not durable")
    emitToSession(state,"turn.status",{text:"当前步骤已保存，更新完成后从这里继续。",delivery_id:delivery.task_id})
  }).catch(error=>{
    // 未确认停止不能假装空闲：恢复在途打点，让发布闸拒绝重启。
    if((state.turnGen??0)===generation) {
      state.lastTurnActiveAt=Date.now();state.turnAborted=false;state.retryQueued=false
      persistSessionNow(state)
    }
    console.error(`[gateway] step drain abort unconfirmed: ${String(error)}`)
  }).finally(()=>pausing.delete(state))
  return true
}
