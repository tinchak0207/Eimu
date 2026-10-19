// timers-gw.ts —— 自 index.ts 第二阶段 Wave3 抽取：S6 异步心跳汇报制全家族
// （clearAckTimer/armAckTimer、N1 心跳 clearHeartbeatTimer/armHeartbeatTimer、
// R2-A watchdog clearWatchdogTimer/armWatchdogTimer、R5-C 中段停滞哨
// clearMidturnStallTimer/armMidturnStallTimer、R8-B question 心跳/代答
// clearQuestionHeartbeat/clearQuestionAssumeTimer/armQuestionAssumeTimer/
// autoAssumeQuestions/armQuestionHeartbeat/reconcilePendingQuestions、
// turnHasActivity、R4-A 错误停滞哨
// clearErrorStallTimer/armErrorStallTimer、emitTurnEndSummaryIfSilent/
// emitRecoveryClosingIfSilent/isInterrogativeMessage/releasePendingVideoWorkflows）
// （原 index.ts 5821–6368 行，逐行原样搬运）。
import type { SessionState } from "./types-gateway.ts"
import { ACK_DELAY_MS, HEARTBEAT_DELAY_MS, HEARTBEAT_DELAY_AFTER_ACK_MS, MIDTURN_STALL_MS, QUESTION_ASSUME_MS, QUESTION_HEARTBEAT_MS, TURN_WATCHDOG_MS, TURN_ERROR_WATCHDOG_MS, OPENCODE_URL } from "./constants-gateway.ts"
import { sessions, markDirty, isRestoredGatewayTurn } from "./sessions-core.ts"
import { emitToSession, stripStaleTurnTextFromReplay } from "./sse-core.ts"
import { personaPatienceMul } from "./sessions-http.ts"
import { opencodeHeaders, revertDeadTail } from "./opencode-client.ts"
import { workflowService, workflowOwnerBySession } from "./workflow-gw.ts"
import { emitAgentNotice } from "./emit-helpers.ts"
import { settleQuestion } from "./questions-gw.ts"
import { billingAutoApprovalEnabled } from "./charge-approval-policy.ts"
// 2026-10-04 W：看门狗/心跳等守卫家族固定文案的书写体镜像已整体拆除——一律简体。
// TODO(整合 Wave3)：以下符号仍住 index.ts 且未 export（本任务禁改 index.ts；bun build
// 对未 export 的 named import 报错，已实测 2026-09-19）。依第一阶段占位符法（记忆
// gateway-index-refactor-stage1-0919）：declare 占位可过 bun build；整合 subagent 统一换真 import。
// TODO(index.ts:1383) workflowService（WorkflowService 实例）
// TODO(index.ts:1513) workflowOwnerBySession
// TODO(index.ts:5752) emitAgentNotice
// TODO(settleQuestion 来自 questions-gw.ts，Wave3 同波在建) settleQuestion（现住 index.ts:5406）
/** 规格2：30s ack timer 的清理（发出或失效后都调用）。 */
export function clearAckTimer(state: SessionState): void {
  if (state.ackTimer) {
    clearTimeout(state.ackTimer)
    state.ackTimer = null
  }
}

/** 规格2：用户消息送达 opencode 后启动 30s ack 计时。
 *  罪状2 表现修复（2026-08-29）：ack 触发时不再发 message.delta 假助手文本
 *  （此前「收到，正在处理…」以正文身份污染转录），改走 emitAgentNotice 通知
 *  通道（前端 AgentNoticeRow 渲染路径，S8 进度汇报同款，该通道自带 turn.done
 *  收打字指示器；真实 turn 收尾时 idle 路径照常发 turn.done，前端幂等）。
 *  活动判定改用 turnHasActivity——思考期（reasoning.delta）不再被误判死寂。
 *  persona=thoughtful 时延迟 ×1.5（等待容忍窗，S7）。 */
export function armAckTimer(state: SessionState): void {
  clearAckTimer(state)
  state.ackSent = false
  const gen = state.turnGen ?? 0
  state.ackTimer = setTimeout(() => {
    state.ackTimer = null
    const cur = sessions.get(state.sessionId)
    // 只在「同一轮、turn 毫无动静（无正文无思维链无工具）、还没发过 ack」时补 ack。
    if (!cur || (cur.turnGen ?? 0) !== gen || turnHasActivity(cur) || cur.ackSent) {
      console.log(`[gateway] S6 ack skipped: session=${state.sessionId} gen=${gen} cur=${Boolean(cur)} turnText=${cur?.turnTextChars ?? "?"} turnReasoning=${cur?.turnReasoningChars ?? "?"} ackSent=${cur?.ackSent ?? "?"}`)
      return
    }
    cur.ackSent = true
    console.log(`[gateway] S6 ack sent (notice): session=${cur.sessionId} gen=${gen}`)
    emitToSession(cur, "turn.status", { text: "收到，模型思考中…" })
    // 通知通道自带 turn.done；此处不再额外发任何帧。
  }, ACK_DELAY_MS * personaPatienceMul(state))
}

// ── N1 规格1（2026-08-27）：30s 心跳提示——死寂窗口的中段补口 ──
// 语义与 S6 ack 不同：ack 是「收到你的消息」（30s），心跳是「模型还在憋、
// 没吐字也没开工具」（ack 之后再等一轮）。错峰规则：ack 尚未发 → 心跳在
// HEARTBEAT_DELAY_MS(30s) 起跳；ack 已发 → 顺延到 HEARTBEAT_DELAY_AFTER_ACK_MS
// (45s)，避免同一时刻双发。每 turn 最多 1 条；模型开口（吐字/开工具）即失效。
export function clearHeartbeatTimer(state: SessionState): void {
  if (state.heartbeatTimer) {
    clearTimeout(state.heartbeatTimer)
    state.heartbeatTimer = null
  }
}

export function armHeartbeatTimer(state: SessionState): void {
  clearHeartbeatTimer(state)
  state.heartbeatSent = false
  const gen = state.turnGen ?? 0
  state.heartbeatTimer = setTimeout(() => {
    state.heartbeatTimer = null
    const cur = sessions.get(state.sessionId)
    // 只在「同一轮、turn 完全没动静（无字无工具）、本轮还没发过心跳」时补一条。
    if (!cur || (cur.turnGen ?? 0) !== gen || turnHasActivity(cur) || cur.heartbeatSent) {
      return
    }
    // 错峰：S6 ack 在同一时刻刚发过（30s 边界撞车）→ 心跳顺延一轮再判。
    if (cur.ackTimer || (cur.ackSent === true && Date.now() - (cur.lastUserAt ?? 0) < HEARTBEAT_DELAY_AFTER_ACK_MS)) {
      const deferMs = Math.max(1000, HEARTBEAT_DELAY_AFTER_ACK_MS - HEARTBEAT_DELAY_MS)
      cur.heartbeatTimer = setTimeout(() => {
        cur.heartbeatTimer = null
        const c2 = sessions.get(cur.sessionId)
        if (!c2 || (c2.turnGen ?? 0) !== gen || turnHasActivity(c2) || c2.heartbeatSent) return
        c2.heartbeatSent = true
        console.log(`[gateway] N1 heartbeat sent (post-ack): session=${c2.sessionId} gen=${gen}`)
        emitToSession(c2, "turn.status", {
          text: "仍在等待模型响应，请稍候…",
        })
      }, deferMs)
      return
    }
    cur.heartbeatSent = true
    console.log(`[gateway] N1 heartbeat sent: session=${cur.sessionId} gen=${gen}`)
    emitToSession(cur, "turn.status", {
      text: "仍在等待模型响应，请稍候…",
    })
    // 不发 turn.done：turn 仍在途，前端维持输入中。
    // S7：persona=thoughtful 时本延迟 ×1.5（投递时按 settings 计算，不改全局常量）。
  }, HEARTBEAT_DELAY_MS * personaPatienceMul(state))
}

// ── R2-A（2026-08-27）：turn 启动看门狗 ─────────────────────────────
// 评测实锤：批准重跑后 prompt_async 202，但 295s 零 tool.invoke 零
// message.delta——turn 在压缩后的长会话上静默死亡，连 session.idle 都
// 不发，抖动重试（挂在 idle 上）永远等不到。看门狗直接以「turn 动静」为
// 准：90s 无动静 → 诚实告警 + 防重复检查后自动重投一次；再 90s 无动静
// → 判会话损坏，建议新开。工具开跑或模型吐字即视为活著（turnToolStarted
// / turnTextChars 任一非零）。
export function clearWatchdogTimer(state: SessionState): void {
  if (state.watchdogTimer) {
    clearTimeout(state.watchdogTimer)
    state.watchdogTimer = null
  }
}

// ── R5-C（2026-08-28）：中段停滞哨 ─────────────────────────────────
// 覆盖启动看门狗管不到的格：turn 已启动（有过 tool/正文/任何帧）后中段冻结。
// 判定 = turnLastFrameAt（emitToSession 全量刷新）起算 90s 零新帧。第一咬：
// 诚实告警 + 单次重投 lastPromptBody（防风暴，midturnStallRetried 锁）；第二咬
// （重投后仍零帧）：如实收尾 + turn.done。turnHasActivity=false 时静默退出
//（那格归启动看门狗），idle 撤哨。
export function clearMidturnStallTimer(state: SessionState): void {
  if (state.midturnStallTimer) {
    clearTimeout(state.midturnStallTimer)
    state.midturnStallTimer = null
  }
}

export function armMidturnStallTimer(state: SessionState): void {
  if (isRestoredGatewayTurn(state)) return
  clearMidturnStallTimer(state)
  const gen = state.turnGen ?? 0
  state.midturnStallTimer = setTimeout(() => {
    state.midturnStallTimer = null
    const cur = sessions.get(state.sessionId)
    if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted) return
    if (!turnHasActivity(cur)) return // turn 未启动：启动看门狗管，不重叠
    // R8-B 工单 #3：question pending 期间静默属预期（等用户答覆），
    // 心跳接管用户可见性；此处重投只会打断挂起的 question 工具。
    if (cur.pendingQuestions.size > 0 || cur.pendingConfirms.size > 0) return
    const last = cur.turnLastFrameAt ?? 0
    if (!(last > 0 && Date.now() - last >= MIDTURN_STALL_MS)) {
      armMidturnStallTimer(cur) // 还有帧进来：滚动续盯，直到 idle 撤哨
      return
    }
    if (!cur.midturnStallRetried) {
      // ── 第一咬：告警 + 单次重投（复用 watchdog 模式）──
      cur.midturnStallRetried = true
      cur.recoveryRound = true
      console.warn(`[gateway] R5-C midturn-stall: zero frames for ${Math.round((Date.now() - last) / 1000)}s (gen=${gen}), alerting + single re-dispatch — session=${cur.sessionId}`)
      emitToSession(cur, "turn.status", {
        text: "处理似乎卡住了，我重新尝试一下，请稍候",
      })
      const body = cur.lastPromptBody
      if (!body) {
        armMidturnStallTimer(cur)
        return
      }
      // 2026-10-01 去重：清僵尸后撤零产出死尾（revertDeadTail 内部吞错，永不挡重投）。
      clearZombieBusyRun(cur).catch(() => false).then(() => revertDeadTail(cur.opencodeSessionId)).then(() => fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      }))
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`)
          console.log(`[gateway] R5-C midturn-stall: re-dispatch sent — session=${cur.sessionId} gen=${gen}`)
          stripStaleTurnTextFromReplay(cur)
          cur.turnLastFrameAt = Date.now()
          armMidturnStallTimer(cur) // 续盯第二轮判定
        })
        .catch((e: unknown) => {
          console.error(`[gateway] R5-C midturn-stall re-dispatch failed: session=${cur.sessionId}:`, e)
          armMidturnStallTimer(cur)
        })
      return
    }
    // ── 第二咬：重投后仍零帧——如实收尾 ──
    console.warn(`[gateway] R5-C midturn-stall: still frozen after re-dispatch (gen=${gen}), closing turn honestly — session=${cur.sessionId}`)
    emitToSession(cur, "message.delta", {
      text: "重新尝试后仍没有进展，我先停止等待。刚才完成的部分不会丢，稍后重新发送消息即可继续。\n",
    })
    emitToSession(cur, "turn.done", {})
    cur.lastTurnActiveAt = 0
    markDirty(cur)
  }, MIDTURN_STALL_MS)
}

// ── R8-B 工单 #3（2026-08-29）：question pending 心跳 ──
// pending 期间每 30s 一帧用户可见心跳（message 通道直发，不带 turn.done——
// turn 还挂著等答覆）。答覆/拒绝/会话拆除时撤哨。
export function clearQuestionHeartbeat(state: SessionState): void {
  if (state.questionHeartbeatTimer) {
    clearTimeout(state.questionHeartbeatTimer)
    state.questionHeartbeatTimer = null
  }
  // 片AJ：assume 代答哨与心跳同生共死——既有全部答覆/跳过/拆除路径已调本函数。
  clearQuestionAssumeTimer(state)
}

// ── 片AJ（2026-09-07）：question 卡 3 分钟超时自动应答 ──
// 背景（片AB 评测 T4 实锤）：无人值守跑批时 question 卡在确认门前无限挂死。
// 语义（2026-10-06 缺陷 A2 修正）：超时自动应答**不得**充当「照第一项执行」的
// 授权。旧实现取各题第一选项拼成「已代答第一项继续：〈label〉」，读起来就是
// 「照第一项做」——而 agent 自建的「开工确认」卡首项恰恰是付费开工（实测首项
// ＝「按计划开跑（推荐）」，代答后子代理真跑了付费 music_gen，未经用户同意）。
// 旧注释「confirm（花钱决策）不在此列」只覆盖 platform 侧 kind:"confirm" 的卡，
// agent 自建确认卡走 question 通道照旧走到这里，该假设不成立——限权必须落在本
// 函数内。现在超时投递一段**限权指令**：如实声明用户未回复并标 assumed，禁止在
// 无用户同意下启动任何付费生成／上传／下单，只允许继续不花钱的步骤；选项仅作
// 参考并列且不构成授权。仍要 settle（不能挂住 turn，这正是本机制存在的理由），
// 转发核心复用 settleQuestion（双 URL 兜底 + ok 后记账 + question.replied 前端
// 变已决）。best-effort：上游失败照 settleQuestion 既有形态收尾，不重试不抛出
//（reconcile/新消息路径接管）。
export function clearQuestionAssumeTimer(state: SessionState): void {
  if (state.questionAssumeTimer) {
    clearTimeout(state.questionAssumeTimer)
    state.questionAssumeTimer = null
  }
}

export function armQuestionAssumeTimer(state: SessionState): void {
  clearQuestionAssumeTimer(state)
  state.questionAssumeTimer = setTimeout(() => {
    state.questionAssumeTimer = null
    const cur = sessions.get(state.sessionId)
    if (!cur || cur.pendingQuestions.size === 0) return
    void autoAssumeQuestions(cur)
  }, QUESTION_ASSUME_MS)
}

export async function autoAssumeQuestions(state: SessionState): Promise<void> {
  if (state.pendingQuestions.size === 0) return
  // 只取首项是为了拼「照第一项做」的旧语义；现在只作参考列出，故如实收全部
  // 选项，避免只列首项＝变相把首项打成「唯一/推荐项」。
  const labels: string[] = []
  for (const pending of state.pendingQuestions.values()) {
    for (const q of pending.questions) {
      for (const opt of q.options ?? []) {
        if (opt.label) labels.push(opt.label)
      }
    }
  }
  // 2026-10-06 缺陷 A2 根因：旧话术「已代答第一项继续：〈label〉」把首项 label
  // 拼成「照第一项做」的授权，而首项完全可能是付费开工（实测首项＝「按计划开跑
  //（推荐）」）——代答一出，子代理真去跑了付费 music_gen。话术必须是一段限权
  // 指令：声明用户未回复、标 assumed、禁止未获同意就启动付费动作，只许继续不花
  // 钱的事；选项只作参考列出并明示「未选择任何一项」，不再构成授权。
  const optionsNote = labels.length
    ? `原卡提供的选项（仅列出供你了解用户可选的方向，本次没有选择其中任何一项、不构成授权）：${labels.join("；")}。`
    : "原卡没有提供可选项。"
  const autonomousAuthorized = await billingAutoApprovalEnabled(state)
  const answerText = autonomousAuthorized
    ? "（用户 3 分钟未回复，本条为超时自动续接，不是用户选择某个选项的答复，assumed。）网关核实完全访问或自动模式的持续授权仍有效：当前任务内扣费、必要返工、换模及可合理判断的制作选择直接继续，不再问开工或扣费；本条没有新增授权，也没有改变用户明确的预算、禁止生成、取消或方案须确认要求。若原问题缺少无法合理推断的关键输入，或用户明确要求亲自选定方案，则保持该决策待用户答复；其它已有授权的步骤继续。" + optionsNote
    :
    "（用户 3 分钟未回复，本条为超时自动代答，不是用户同意的答复，assumed。）限权指令：" +
    "① 在用户明确同意之前，不得启动任何付费生成、付费上传、下单或其他会产生费用的动作；" +
    "② 可以继续不花钱的步骤（读资料、整理方案、给出分析或草稿结论）；" +
    "③ 若继续推进必须依赖付费动作，请停下，把当前结论与待办列清楚，等用户回来决定。" +
    optionsNote
  const count = state.pendingQuestions.size
  for (const requestId of [...state.pendingQuestions.keys()]) {
    try {
      await settleQuestion(state, requestId, answerText)
    } catch (err) {
      console.error(`[gateway] auto-assume question failed: ${requestId} — session=${state.sessionId}:`, err)
      state.pendingQuestions.delete(requestId)
    }
  }
  state.pendingQuestions.clear()
  clearQuestionHeartbeat(state)
  console.log(`[session] auto-assumed ${count} pending question(s) after ${QUESTION_ASSUME_MS}ms — session=${state.sessionId}`)
}

export function armQuestionHeartbeat(state: SessionState): void {
  clearQuestionHeartbeat(state)
  const tick = (): void => {
    state.questionHeartbeatTimer = null
    const cur = sessions.get(state.sessionId)
    if (!cur || cur.pendingQuestions.size === 0 || cur.turnAborted) return
    // R9-1：心跳走服务端事件（heartbeat），不再复制成 message.delta 消息泡——
    // 前端 reducer 对未知事件只推 lastEventId、不产生新条目，复读机根治。
    // question 卡本身已是「等待选择」的视觉锚点，心跳只是维持「后端还活著」。
    emitToSession(cur, "heartbeat", { type: "question_pending", pendingAt: Date.now() })
    // R8-B 验收实录：opencode 侧 question 会静默过期（上游 /question 清单变空、
    // reply 端点回 QuestionNotFoundError），gateway 若不知情 = 心跳永久循环 +
    // turn 永久冻结。每拍对账一次，过期即摘除并解除冻结，交还既有哨兵接管。
    void reconcilePendingQuestions(cur)
    cur.questionHeartbeatTimer = setTimeout(tick, QUESTION_HEARTBEAT_MS)
  }
  state.questionHeartbeatTimer = setTimeout(tick, QUESTION_HEARTBEAT_MS)
}

/** question pending 对账：上游已不存在的 request 摘除；全部摘完时解除冻结。 */
export async function reconcilePendingQuestions(state: SessionState): Promise<void> {
  if (state.pendingQuestions.size === 0) return
  let liveIds: Set<string> | null = null
  try {
    const res = await fetch(`${OPENCODE_URL}/question`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const arr = (await res.json()) as Array<Record<string, unknown>>
      liveIds = new Set(arr.filter((r) => typeof r?.id === "string").map((r) => r.id as string))
    }
  } catch {
    return // 查不到就不动：下一拍再对账
  }
  if (!liveIds) return
  for (const requestId of [...state.pendingQuestions.keys()]) {
    if (!liveIds.has(requestId)) {
      state.pendingQuestions.delete(requestId)
      emitToSession(state, "question.expired", { request_id: requestId, reason: "upstream_expired" })
      console.log(`[gateway] R8-B question expired upstream: ${requestId} — session=${state.sessionId}`)
    }
  }
  if (state.pendingQuestions.size === 0) {
    clearQuestionHeartbeat(state)
    state.turnFrozenByQuestion = false
    state.turnLastFrameAt = Date.now()
    state.lastUserVisibleAt = Date.now()
    emitToSession(state, "message.delta", { text: "（选择卡片已过期。如仍要继续，请回复或重新发送消息。）\n" })
    // 冻结期间哨兵全撤过：恢复段重新布防，让启动看门狗/停滞哨接管收尾或重投。
    armWatchdogTimer(state)
  }
}

/**
 * 重投前清僵尸 run（2026-09-28 漫剧工作室评测实锤）：opencode-server 被重启时，重启前在飞的
 * run 在 opencode 侧永远停在 busy（进程已死、状态没清），此后每条 prompt 都排在僵尸后面——
 * 会话永久变砖：看门狗两咬都咬空，用户只看到「后端无响应」。实测 POST /session/{id}/abort
 * 清掉后同一会话立刻恢复应答（会话 dea89da6，变砖 48 分钟后一次 abort 即活）。
 * 只在两处重投前呼叫（本 turn 已零动静才会走到），opencode 报 busy 才 abort；查询失败不挡重投。
 */
async function clearZombieBusyRun(st: SessionState): Promise<boolean> {
  const res = await fetch(`${OPENCODE_URL}/session/status`, { headers: opencodeHeaders(), signal: AbortSignal.timeout(5000) })
  if (!res.ok) return false
  const status = (await res.json().catch(() => null)) as Record<string, { type?: string }> | null
  if (status?.[st.opencodeSessionId]?.type !== "busy") return false
  const aborted = await fetch(`${OPENCODE_URL}/session/${st.opencodeSessionId}/abort`, {
    method: "POST",
    headers: opencodeHeaders(),
    signal: AbortSignal.timeout(5000),
  })
  if (aborted.ok) console.warn(`[gateway] cleared zombie busy run before re-dispatch — session=${st.sessionId}`)
  return aborted.ok
}

/** turn 是否有任何「已启动」的证据：模型吐过字（正文或思维链），或工具开跑过。
 *  罪状2 根因修复（2026-08-29）：思维链（reasoning.delta）也是模型活著的证据——
 *  此前只看正文与工具，思考型模型整段推理期间被 ack/心跳/看门狗/停滞哨误判死寂。
 *  ack/心跳/看门狗/中段停滞哨全部经此函数继承该语义。 */
export function turnHasActivity(st: SessionState): boolean {
  return (st.turnTextChars ?? 0) > 0 || (st.turnReasoningChars ?? 0) > 0 || st.turnToolStarted === true
}

/** 用户消息/resume 送达后布哨；每次触发后自续（第二轮触发=终局判定）。 */
export function armWatchdogTimer(state: SessionState): void {
  if (isRestoredGatewayTurn(state)) return
  clearWatchdogTimer(state)
  // R5-C：中段停滞哨与启动看门狗同点布防/重布（含重投轮），撤哨走 idle。
  armMidturnStallTimer(state)
  const gen = state.turnGen ?? 0
  state.watchdogTimer = setTimeout(() => {
    state.watchdogTimer = null
    const cur = sessions.get(state.sessionId)
    // 会话已拆 / 已进入下一轮 / turn 已有动静 → 哨兵静默退出。
    if (!cur || (cur.turnGen ?? 0) !== gen || turnHasActivity(cur) || cur.turnAborted) {
      return
    }
    // 等用户决策（confirm/question 挂起）是合法暂停，不是 LLM 无响应——
    // 挂起期间零帧流动，此前被误判死寂：重投 prompt 造出重复回合 + 诬陷后端。
    // 静默续哨：决策落地后活动恢复自然撤哨；卡片过期后若 turn 真死，下一轮照咬。
    if (cur.pendingConfirms.size > 0 || cur.pendingQuestions.size > 0) {
      armWatchdogTimer(cur)
      return
    }
    if (!cur.watchdogRetried) {
      // ── 第一次咬：诚实告警 + 自动重投一次 ──
      cur.watchdogRetried = true
      cur.recoveryRound = true // R5-C：恢复轮标记，收尾兜底结语用
      console.warn(`[gateway] watchdog: turn not started (gen=${gen}), notifying user and retrying once — session=${cur.sessionId}`)
      emitToSession(cur, "turn.status", {
        text: "处理似乎卡住了，我重新尝试一下，请稍候",
      })
      // 防重复：重投前实时核对 turn 仍零动静（告警帧发送期间模型可能恰好开口）。
      if (turnHasActivity(cur)) return
      const body = cur.lastPromptBody
      if (!body) return
      // 2026-10-01 去重：清僵尸后撤零产出死尾（revertDeadTail 内部吞错，永不挡重投）。
      clearZombieBusyRun(cur).catch(() => false).then(() => revertDeadTail(cur.opencodeSessionId)).then(() => fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      }))
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`)
          console.log(`[gateway] watchdog: retry dispatched for session=${cur.sessionId} gen=${gen}`)
          // N2：重投轮开始——剥掉旧 turn 的文本帧（含 watchdog 自己的告警帧），
          // 避免重连/后续 idle 补发路径把它们整段重放。
          stripStaleTurnTextFromReplay(cur)
          // 重投已出发：重新布哨等第二轮判定（cur 仍零动静才会咬）。
          if ((cur.turnGen ?? 0) === gen && !turnHasActivity(cur)) armWatchdogTimer(cur)
        })
        .catch((e: unknown) => {
          console.error(`[gateway] watchdog: retry dispatch failed for session=${cur.sessionId}:`, e)
          // 重投发不出去：这轮已无恢复手段，进入终局话术（Q3：如实三句式，
          // 不再诬陷「会话损坏」、不再建议必然失败的「新开一个」）。
          if ((cur.turnGen ?? 0) === gen && !turnHasActivity(cur)) {
            // 修 1：死亡宣告置位——此后若仍有内容帧到达（上游慢复活），
            // emitToSession 会先发撤回帧。
            emitToSession(cur, "message.delta", {
              text: "自动重试后 LLM 后端仍无响应（服务端问题，不是你的操作）。已停止等待。请稍后重试发送同一条消息，若持续失败请联系管理员。\n",
            })
            // N1 规格2：终局之后补一条明确指引（一次性；此路径每 turn 只进一次）。
            emitToSession(cur, "message.delta", {
              text: "你刚才的消息可能未处理完成，稍后重新发送即可继续。\n",
            })
            emitToSession(cur, "turn.done", {})
            // 2026-10-02 steer 误判修复：终局宣告＝本轮真的结束，清 in-flight 打点。
            // 不清会留下「假在途」（受理闸照收引导、却永远等不到投递）；此路径是本轮
            // 唯一出口（没有 idle 会再来），所以清点必须落在这里。
            cur.lastTurnActiveAt = 0
            markDirty(cur)
            // 置位必须在终局话术发完之后（2026-09-28 评测实锤：先置位＝自己的死亡宣告被当成
            // 「还魂帧」，紧接著发「刚才是误判，已自动恢复」，两句互相打脸）。
            cur.deathDeclared = true
          }
        })
      return
    }
    // ── 第二次咬：重投也没唤醒——LLM 后端无响应，如实告知（Q3 去误导） ──
    console.warn(`[gateway] watchdog: turn still dead after retry (gen=${gen}), backend unresponsive — session=${cur.sessionId}`)
    // 修 1：死亡宣告置位——重投的 retry 若之后开始产出（僵尸还魂实录：
    // 宣告死亡 10 秒后 retry 输出照灌），第一条内容帧触发撤回帧，用户明确
    // 知道刚才是误判、任务已恢复；「宣告死亡 + 静默还魂」不再并存。
    emitToSession(cur, "message.delta", {
      text: "自动重试后 LLM 后端仍无响应（服务端问题，不是你的操作）。已停止等待。请稍后重试发送同一条消息，若持续失败请联系管理员。\n",
    })
    // N1 规格2：终局之后补一条明确指引（一次性；第二咬每 turn ��进一次）。
    emitToSession(cur, "message.delta", {
      text: "你刚才的消息可能未处理完成，稍后重新发送即可继续。\n",
    })
    emitToSession(cur, "turn.done", {}) // 收尾：别让前端永远挂著「输入中」
    cur.deathDeclared = true // 同上：终局话术发完才置位，避免自己的宣告触发撤回帧
  }, TURN_WATCHDOG_MS)
}

// ── R4-A S3①（2026-08-28）：上游错误后停滞看门狗 ───────────────────
// R4 实锤两个根因：1) 启动看门狗只守「turn 从未启动」（turnHasActivity 即
// 静默退出），APIError 前模型已吐过字 → 哨兵瞎了；2) 抖动重试耗尽后 idle
// 直接静默 turn.done，零话术。此哨补第一格：emitSessionError（非 tool_error）
// 布哨 → 90s 内 turn 未收尾 → 诚实告警（每 turn 一条）并续盯（重投由抖动
// 重试机制接手）；告警后再 90s 仍零进度 → 明确收尾话术 + turn.done。
// TURN_ERROR_WATCHDOG_MS 环境变量可覆盖。
export function clearErrorStallTimer(state: SessionState): void {
  if (state.errorStallTimer) {
    clearTimeout(state.errorStallTimer)
    state.errorStallTimer = null
  }
}

export function armErrorStallTimer(state: SessionState): void {
  if (isRestoredGatewayTurn(state)) return
  clearErrorStallTimer(state)
  const gen = state.turnGen ?? 0
  state.errorStallTimer = setTimeout(() => {
    state.errorStallTimer = null
    const cur = sessions.get(state.sessionId)
    // 会话已拆 / 已进入下一轮 / 已中止 → 静默退出（idle 收尾路径会撤哨）。
    if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted) return
    if (!cur.errorStallAlerted) {
      // ── 第一咬：诚实告警（每 turn 一条），续盯。
      cur.errorStallAlerted = true
      console.warn(`[gateway] error-stall watchdog: upstream error, turn unfinished after ${TURN_ERROR_WATCHDOG_MS}ms (gen=${gen}) — session=${cur.sessionId}`)
      emitToSession(cur, "turn.status", {
        text: "上游刚才报错了，我还在盯着处理；若持续没有进展，我会告诉你并停止等待",
      })
      if ((cur.turnGen ?? 0) === gen && !cur.turnAborted) armErrorStallTimer(cur)
      return
    }
    // ── 第二咬：告警后有进度 = turn 活著 → 静默续盯，不再出帧打扰。
    const progressAt = cur.turnProgressAt ?? 0
    if (progressAt > 0 && Date.now() - progressAt < TURN_ERROR_WATCHDOG_MS) {
      armErrorStallTimer(cur)
      return
    }
    console.warn(`[gateway] error-stall watchdog: still stalled after alert (gen=${gen}), closing turn honestly — session=${cur.sessionId}`)
    emitToSession(cur, "message.delta", {
      text: "上游连续报错且自动重试未能恢复，我停止等待了。请稍后重新发送上一条消息即可继续；若内容较长，建议让我分章/分段处理。\n",
    })
    emitToSession(cur, "turn.done", {}) // 收尾：别让前端永远挂著「输入中」
  }, TURN_ERROR_WATCHDOG_MS)
}

/** R4-A S8（2026-08-28）：turn 收尾兜底汇报——本轮有节点落终态但零主动汇报
 *  时补一帧中文总结（R4 实锤：第一轮 5 成功+1 失败零汇报悄悄收工）。环名
 *  来源 = workflow graph 节点的模板预置 title（如「角色卡」），取不到才用
 *  节点 id 尾段。花费只汇总工作流里真实存在的数字，没有就不编。 */
export function emitTurnEndSummaryIfSilent(state: SessionState): void {
  const nodes = state.turnTerminalNodes ?? []
  if (nodes.length === 0 || state.turnNoticeSent || state.turnAborted) return
  state.turnNoticeSent = true
  const wfid = workflowOwnerBySession.get(state.sessionId)
  const wf = wfid ? workflowService.get(wfid) : undefined
  const titleById = new Map<string, string>()
  const costById = new Map<string, number>()
  if (wf) {
    const w = wf as unknown as {
      graph?: { nodes?: Array<{ id?: unknown; title?: unknown }> }
      nodeCost?: Record<string, unknown>
    }
    for (const n of w.graph?.nodes ?? []) {
      if (typeof n?.id === "string" && typeof n?.title === "string") titleById.set(n.id, n.title)
    }
    for (const [k, v] of Object.entries(w.nodeCost ?? {})) {
      if (typeof v === "number") costById.set(k, v)
    }
  }
  const labelOf = (id: string): string => titleById.get(id) || (id.includes("-") ? id.slice(id.lastIndexOf("-") + 1) : id)
  const okList = nodes.filter((n) => n.status === "success").map((n) => labelOf(n.id))
  const badList = nodes.filter((n) => n.status === "error").map((n) => labelOf(n.id))
  if (okList.length === 0 && badList.length === 0) return
  let spent = 0
  let anyCost = false
  for (const n of nodes) {
    if (n.status !== "success") continue
    const c = costById.get(n.id)
    if (typeof c === "number") {
      spent += c
      anyCost = true
    }
  }
  const lines: string[] = ["【本轮小结】"]
  lines.push(okList.length > 0 ? `已完成 ${okList.length} 个环节：${okList.join("、")}。` : "本轮没有完成的环节。")
  if (badList.length > 0) lines.push(`失败 ${badList.length} 个环节：${badList.join("、")}。失败节点可在画布上重试。`)
  if (anyCost) lines.push(`本轮已完成环节共花费 ${Math.round(spent * 100) / 100} 币。`)
  lines.push(badList.length > 0 ? "下一步：可重试失败节点，或告诉我接下来怎么调整。" : "下一步：可继续推进后续环节，或让我检查已完成环节的产出。")
  emitToSession(state, "message.delta", { text: lines.join("\n") + "\n" })
  console.log(`[gateway] S8 turn-end fallback summary: ${okList.length} ok / ${badList.length} failed — session=${state.sessionId}`)
}

/** R5-C（2026-08-28）：恢复轮强制结语——watchdog 重投/redrive/中段哨重投的
 *  恢复轮（recoveryRound=true）收尾时，若 S8 节点小结不触发（零终态节点）且
 *  零主动汇报、且本轮有正文输出（零文本路径已有自己的诚实收尾），兜底补一条
 *  用户可见结语，杜绝恢复轮悄悄收工。N 取当前工作流可执行节点数，取不到不编。 */
export function emitRecoveryClosingIfSilent(state: SessionState): void {
  if (!state.recoveryRound || state.turnAborted || state.turnNoticeSent) return
  // R8-B 工单 #4（2026-08-29）：本轮答覆过 question → 用户语义已在模型上下文，
  // 模型自己会执行/收尾。补「要继续跑吗」= 刚关的门自己又拉开（R8 拒单实锤：
  // 用户答「先不生成，就到这」后被 5125.1 帧自我推翻），让位。
  if (state.questionAnsweredThisTurn) return
  if ((state.turnTerminalNodes ?? []).length > 0) return // S8 小结已覆盖
  if ((state.turnTextChars ?? 0) === 0) return // 零文本路径已有专属收尾话术
  let n = 0
  const wfid = workflowOwnerBySession.get(state.sessionId)
  const wf = wfid ? workflowService.get(wfid) : undefined
  if (wf) {
    const g = (wf as unknown as { graph?: { nodes?: Array<{ kind?: string }> } }).graph
    n = (g?.nodes ?? []).filter((x) => x.kind !== "text" && x.kind !== "config").length
  }
  const text =
    n > 0
      ? `恢复完成：已重建 ${n} 个节点配置。要继续跑吗？\n`
      : "恢复完成：刚才中断的处理已经接上。要继续跑吗？\n"
  emitToSession(state, "message.delta", { text })
  console.log(`[gateway] R5-C recovery closing emitted: nodes=${n} — session=${state.sessionId}`)
}

/** 规格3：质询样式识别——问句/追责类关键词（结案提问「为什么/退款/剩什么」命中）。 */
export function isInterrogativeMessage(text: string): boolean {
  return /为什么|为何|怎么回事|怎么回|咋|退钱|退款|失败|死了|还剩|剩什么|什么情况|啥情况|怎么办|赔|投诉|号|？|\?/.test(text)
}

/** 规格3：turn 结束（回覆完成）时放行被冻结的视频工作流。 */
export function releasePendingVideoWorkflows(state: SessionState): void {
  const pending = state.pendingVideoWorkflows
  if (!pending || pending.length === 0) {
    state.pendingVideoWorkflows = []
    return
  }
  state.pendingVideoWorkflows = []
  emitAgentNotice(state, `已收到你的追问并答复完毕。此前暂缓的视频任务（${pending.length} 个）现在继续执行，节点完成后我会逐条汇报。`)
  for (const wfid of pending) {
    void workflowService.generate(wfid).then((r) => {
      if (!r.ok) console.error(`[workflow] ${wfid} resumed-after-question finished: ${r.status}`)
    })
  }
}
