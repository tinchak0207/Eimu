import { TaskStatus } from "./types-gateway.ts"
import { notify } from "./internal-waiters.ts"
import { bindGenerationConsumer, generationParent, saveDurableSubagentRun } from "./job-store"
import { CriticPassTarget } from "./delivery-gate"
import { deleteReworkRecord } from "./persistence"
import { runHooksWithBudget } from "./hooks-http.ts"
import { setLiveChildCounter } from "./session-activity.ts"
import type { TypedArtifact, ScratchpadEntry, SubagentRun, SubagentResult, SubagentDeps } from "./subagent-types.ts"
import { COMPLETED_TTL_MS, SUBAGENT_SOFT_STOP_GRACE_MS, userFacingSubagentLabel, partialBodyOf, unrefTimer, isOpenCodeSessionId } from "./subagent-types.ts"
import { emitSubagentCompletedStatus } from "./subagent-finish.ts"
import { startLivenessWatch, persistRunOutput } from "./subagent-liveness.ts"
import { maybeDrainCriticQueue } from "./subagent-events.ts"
import { writeLiveLog, appendTranscriptEnd } from "./subagent-live.ts"
import { deliverChildTurn } from "./subagent-messages.ts"
import { checkPendingResumeQueue } from "./subagent-suspend.ts"

/** SubagentStart/SubagentStop 的统一发射点；调用方一律 `void`/不 await。 */
export function fireSubagentHook(
  event: "SubagentStart" | "SubagentStop",
  run: { id: string; label: string; agent?: string; parentGatewaySessionId: string },
  extra: Record<string, unknown> = {},
): void {
  void runHooksWithBudget(
    event,
    {
      hook_event_name: event,
      session_id: run.parentGatewaySessionId,
      agent_id: run.id,
      agent_type: run.agent ?? run.label,
      label: run.label,
      ...extra,
    },
    { timeoutMs: 60_000 },
  ).catch((e) => {
    console.warn(
      `[gateway] hooks ${event} failed run=${run.id}: ${e instanceof Error ? e.message : String(e)}`,
    )
  })
}
export let deps: SubagentDeps | undefined
// 父 gateway session id → 活跃子代理列表（dispatch 并发上限按此计）
export const byParent = new Map<string, SubagentRun[]>()
// 会话活性时钟的只读回调：仍在跑、未停止的子代理路数。
setLiveChildCounter(
  (parentGatewaySessionId) =>
    (byParent.get(parentGatewaySessionId) ?? []).filter((r) => r.status === "running" && !r.stopped).length,
)
// 子 opencode session id → run（全局 tap 按 sessionID 命中）
export const byChildOc = new Map<string, SubagentRun>()
// FIX-B（2026-10-02）：子会话→父会话映射的耐久性。byChildOc 在 run 收尾（finishRun/
// stopSubagentRun/换模）会被 delete，但 poller 可能在子代理结束后才把成品经 /internal/emit
// 用子会话 id 发出 → subagentParentState 解析不到父会话 → 404 → 卡丢失。于绑定点
// （dispatchAttempt）额外写一张有界（≤200）TTL（2h）表，byChildOc 未命中时回退查。
// **只在绑定处写**，不改任何 byChildOc.has()/delete() 语义（subagent_stop/status 依赖它们）。
const RECENT_CHILD_PARENT_CAP = 200
const RECENT_CHILD_PARENT_TTL_MS = 2 * 60 * 60 * 1000
const recentChildParent = new Map<
  string,
  { parentGatewaySessionId: string; parentOpencodeSessionId: string; at: number; memberName?: string }
>()
// 子代理 id → 结果（工具轮询取件；TTL 后清）
export const completed = new Map<string, SubagentResult>()
// X7/C4（2026-10-14）：接续索引。终态但仍在 resumeUntil 窗口内的 run 挂在这里（同时子会话
// 刻意不 DELETE）——给已终态的子代理发消息即由此复活续跑，不需重新派工（Y4）。
// 有界：TTL 到期由 livenessTick 回收；run 复活时移除。键＝run id。
export const resumable = new Map<string, SubagentRun>()
// G3（2026-10-14 竞态修复）：续跑**认领锁**（内存，键＝被续的旧 run id）。resumeTerminalRun
// 在**任何 await 之前**同步置入，与 `resumable.delete` 同一时刻——不但挡住「同一条旧 run 被
// 二次 resumeTerminalRun」，也让**并发第二条**在 handler 的终态分支就能如实回 `resume_in_flight`
// （此时它已从 resumable 摘除，靠 resumable 本身无法与之区分「窗口已过」与「正在投递」）。
export const resumeInFlight = new Set<string>()
// X5：软停／提问登记的到期扫描是既有 livenessTick 的顺手活；该 tick 只在 initSubagent
// 之后跑，未初始化时（纯函数测试／极端情况）任何新路径都不启动，零回归。

// ── 支柱 2/3/4：检查点／共享工作区／挂起恢复队列 ───────────────────────────
// 父会话 id → 共享工作区状态板（Scratchpad）
export const sessionScratchpads = new Map<string, Map<string, ScratchpadEntry>>()
// 父会话 id → 具型产物注册表（Workspace Registry）
export const sessionArtifactRegistries = new Map<string, Map<string, TypedArtifact>>()
// 父会话 id → 排队等待并发槽恢复的挂起子代理队列
export const pendingResumeQueue = new Map<string, Array<{ run: SubagentRun; payload: unknown; triggerSource: string; resumeText?: string; questionId?: string }>>()

// ── 刀 2（2026-09-15）：machine critic pass 状态 ─────────────────────────────────
// 待审交付：父 gateway session id → 本窗口内已终态的 Expert 交付（尚未送审）。
// 由 finishRun 在 Expert 正常终态时登记；machine pass 消耗后清空。纯内存（有界：
// 每次 pass 至多取 CRITIC_PASS_MAX_TARGETS；登记侧亦封顶）。
export const pendingCriticTargets = new Map<string, CriticPassTarget[]>()
// 本轮是否已有 critic 派遣（含在途）。值 = 登记时的父会话 turnGen。
// **语义钉死为「本轮」**：判据比较「登记 turnGen === 当前 turnGen」，新一轮自动失效
// ——避免 orchestrator 早轮派过一次 critic 就永久豁免机器兜底（本刀要的就是兜底常在）。
// orchestrator 自派（handleSubagentDispatch expert="critic"）与机器 pass 派遣皆登记于此。
// 有界 Map 防无界增长。
export const criticDispatchedByParent = new Map<string, number>()
// M2/M3（2026-10-02）：每父会话交付簿——music-first 前置断言（music 交付事件）＋
// 返工内容锁（上一份交付物落盘路径）。有界 Map，每父会话 ≤20 笔。
export const deliveredByParent = new Map<string, Array<{ agent: string; label: string; relPath: string; contractOk?: boolean }>>()
// 本会话是否已用掉 machine critic pass（内存镜像；权威在 persistence.critic_passes）。
export const criticPassUsed = new Set<string>()
const DURABLE_TERMINAL_RETRY_CAP = 64
const durableTerminalRetry = new Set<string>()

export function noteDurableTerminalRetry(runId: string): void {
  if (!runId || durableTerminalRetry.has(runId)) return
  if (durableTerminalRetry.size >= DURABLE_TERMINAL_RETRY_CAP) {
    const oldest = durableTerminalRetry.values().next().value
    if (oldest !== undefined) durableTerminalRetry.delete(oldest)
  }
  durableTerminalRetry.add(runId)
}

export const CRITIC_PENDING_CAP = 16
// 修 1（2026-10-02）：被并发上限挤掉的 critic 待审目标入队（per-parent）。
// 此前直接丢弃 → critic 从未跑；槽位释放时由 maybeDrainCriticQueue 补跑。有界。
export const criticRetryQueue = new Map<string, CriticPassTarget[]>()

export function initSubagent(d: SubagentDeps): void {
  deps = d
  startLivenessWatch()
}

/** 全局 tap 用：该 opencode 会话是否是本运行时的子会话。 */
export function subagentHandlesSession(opencodeSessionId: string): boolean {
  return byChildOc.has(opencodeSessionId)
}

/**
 * P0：子会话 → 邮箱身份（派遣登记名）。mailbox HTTP 端用它做服务端身份解析：
 * 工具传来的 session_id 是子会话 id，from 一律由这里推导。
 * 机器 critic / goal evaluator 不登记成员，明确不可寻址（返回 null）。
 */
export function subagentMailboxMemberName(opencodeSessionId: string): string | null {
  const run = byChildOc.get(opencodeSessionId)
  if (run) {
    if (run.machineCriticPass === true || typeof run.goalEvaluator === "function") return null
    // 登记失败不能用猜出的label冒充已存在的同名成员。
    return run.mailboxName ?? null
  }
  // run 已收尾（byChildOc 已删）时回退 TTL 表：保留最后 2h 的邮箱身份。
  return recentChildParent.get(opencodeSessionId)?.memberName ?? null
}

/**
 * 死线③（片 AN，评测 REPORT S2）：子代理 opencode session 不在主 sessions 表，
 * /internal/session-key 查无记录 → 工具侧 resolveKey 全挂（「网关侧解析不到本
 * 会话的 API key」）。子会话仍活跃时经此继承父会话 apiKey（同一用户，计费口径
 * 不变）；父会话已被逐出/收尾则回 undefined，维持 404 原语义。
 */
export function subagentParentApiKey(opencodeSessionId: string): string | undefined {
  const state = subagentParentState(opencodeSessionId)
  const key = state?.apiKey
  return typeof key === "string" && key ? key : undefined
}

/**
 * 死线③同构（2026-09-19 片头曲 404 实锤）：子代理 opencode session 不在主
 * sessions 表，/internal/media/upload 等「session_id 解析」型端点查无记录 →
 * 工具侧上传全挂（音轨生成成功却 404 session not found）。子会话仍活跃时
 * 经此解析父会话 SessionState；父会话已被逐出/收尾则回 undefined，由呼叫方
 * 维持 404 原语义。uploadAudio 落盘归属父会话（同用户，存储口径不变）。
 */
export function subagentParentState(opencodeSessionId: string): any | undefined {
  const run = byChildOc.get(opencodeSessionId)
  if (run) {
    return (
      deps?.resolveSession(run.parentGatewaySessionId) ??
      deps?.findSessionByOpenCodeId(run.parentOpencodeSessionId)
    )
  }
  // FIX-B（2026-10-02）：run 已收尾（byChildOc 已删）但 poller 仍可能用子会话 id 晚到取件
  // → 回退查有界 TTL 表（lazy prune 过期项），解析方式与上面逐字相同。
  pruneRecentChildParent(Date.now())
  const rec = recentChildParent.get(opencodeSessionId)
  if (!rec) {
    const durable = generationParent(opencodeSessionId)
    return durable ? deps?.resolveSession(durable.parent_gw) ?? deps?.findSessionByOpenCodeId(durable.parent_oc) : undefined
  }
  return deps?.resolveSession(rec.parentGatewaySessionId) ?? deps?.findSessionByOpenCodeId(rec.parentOpencodeSessionId)
}

export function parentStateOf(run: SubagentRun): any {
  return (
    deps.resolveSession(run.parentGatewaySessionId) ??
    deps.findSessionByOpenCodeId(run.parentOpencodeSessionId)
  )
}

/**
 * S4（2026-10-14 FIX-G2 修复）：四个 `/internal/subagent/{dispatch,status,stop,message}` 端点的
 * `session_id` 解析链。命中任一即视为「已知会话」：gateway 会话（`resolveSession` 已含
 * `findSessionByOpenCodeId` 段）／已知子代理会话（`subagentParentState`：byChildOc→recentChildParent
 * →durable 三层）。三者全空即未知会话 ⇒ 呼叫端必须回 404 `unknown_session`——**绝不**把原始
 * 字符串回退当父键（旧式 `parent?.sessionId ?? sid` 让任意伪造 id 也能冒充一个「父会话」地址，
 * H3 据此完成跨会话 message/stop/notify 的可达性）。已知子代理会话仍放行（子代理可派孙代理、
 * 可查自己这一路）。回父 SessionState；解析不到回 undefined。
 * 诚实边界：共享主机＋共享文件系统＋loopback 信任是平台级缺口——本函数只能挡「伪造 id」这一档；
 * 拿着**真实**会话 id 的 loopback 呼叫方仍可达（不引入 per-session 令牌无法根治，见 spec §5）。
 */
export function resolveParentSession(sid: string): any | undefined {
  if (typeof sid !== "string" || !sid) return undefined
  const state = deps?.resolveSession(sid) ?? deps?.findSessionByOpenCodeId(sid) ?? subagentParentState(sid)
  return state && typeof state.sessionId === "string" && state.sessionId ? state : undefined
}

/** S4：session_id 解析不到任何已知会话时的统一回执（四端点共用；不泄漏任何暗示「该 id 存在」的内容）。 */
export function unknownSessionResponse(sid: string): Response {
  return Response.json(
    {
      ok: false,
      code: "unknown_session",
      error: `session_id 解析不到任何已知会话（既不是 gateway 会话，也不是已知的子代理会话）：${sid ? sid.slice(0, 64) : "（空）"}。请传你自己的 gateway session id 或 opencode 会话 id。`,
    },
    { status: 404 },
  )
}

/**
 * P2（2026-10-18 同级越权修复）：`subagent_message/stop/resume/suspend` 只允许两种调用方：
 *   ① 主会话/orchestrator（`sid` 不在 byChildOc 里）——可控制本会话全部子代理；
 *   ② 子代理自身（`sid` 是它的 opencode 会话 id）——只允许控制**它自己派出的子 run**
 *      （`parentSubagentId` 或 `forkRequesterRunId` 指向它）。
 * 其余一律 403 `sibling_forbidden`：旧实现让任一子代理凭真实会话 id 操作兄弟 run，等于没有隔离。
 * 诚实边界：这是应用层归属闸，不是 per-session 令牌（见 S4 注释的平台级缺口）。
 */
export function callerCanControlRun(sid: string, target: { parentSubagentId?: string; forkRequesterRunId?: string }): boolean {
  const caller = byChildOc.get(sid)
  if (!caller) return true // 主会话/orchestrator
  return target.parentSubagentId === caller.id || target.forkRequesterRunId === caller.id
}

export function siblingForbiddenResponse(): Response {
  return Response.json(
    {
      ok: false,
      code: "sibling_forbidden",
      error: "子代理默认不能操作兄弟子代理（同级越权）：只能控制自己派出的子 run；需要停止/续跑兄弟请回报 orchestrator，由主会话处理。",
    },
    { status: 403 },
  )
}

// ── 0920 暴君裁定：子代理停止闸（此前「一出就刹不住车」）─────────────────────
// 病灶（三处结构性缺失，全在本次修复）：
//   ① 用户终止按钮打 /agent/v1/sessions/:id/abort → 只杀**主会话**在途 turn，
//      子代理（各自独立子会话）完全不受影响，跑完照样 wakeParent 把父会话**重新
//      唤起来**——用户视角＝「按了终止，它又自己活了」。
//   ② orchestrator 没有任何停止子代理的工具（只有 dispatch/status）。
//   ③ 换模重试（retryWithNextModel）与交付闸门重派（startRework）都会另建子会话，
//      没有「已停止」这道闸，停止后仍会被重投路径复活。
// 本闸：stopped 一置，所有事件处理与重投路径早退，finishRun 归属 "stopped" 且不唤醒。

/** 停止单一 run：标记 + abort/DELETE 子会话 + 摘注册表 + 记 completed（工具轮询可解锁）。
 *  X4（2026-10-14）：新增 `mode`。`hard`（缺省）＝现有行为**逐字不变**（abort＋DELETE＋
 *  立即终态 stopped）；`soft` ＝优雅收尾保成果——abort 当前轮＋投「立即收尾并写全当前成果」
 *  指令，等下一次 idle 走 summarizeChild 正常收尾（终态带 reason＋起止），90s 未收尾则落
 *  partial 后按 stopped 收尾。取消是**尽力而为**（Y1）：已终态由呼叫端回 not_cancelable。
 *  G4（2026-10-14 修复）：改回 `boolean`——真停到＝true，已 stopped／已终态＝false（呼叫端
 *  据此不再伪报 stopped:1）。hard 亦接受**非终态 interrupted**（软停收尾中的 run 必须能被硬停
 *  清场），并先撤掉软停优雅期计时器（否则它事后还会动这条 run）。 */
export function stopSubagentRun(run: SubagentRun, by: "user" | "orchestrator", reason: string, mode: "soft" | "hard" = "hard"): boolean {
  if (mode === "soft") {
    return stopSubagentRunSoft(run, by, reason)
  }
  if (run.stopped || run.status === "stopped" || run.status === "ok" || run.status === "error") return false
  if (run.status !== "running" && run.status !== "interrupted" && run.status !== "suspended") return false
  // G4(b)：硬停软停收尾中的 run——先撤优雅期计时器与软停态，否则计时器到点还会动这条 run。
  if (run.softStopping) {
    if (run.softStopping.timer) clearTimeout(run.softStopping.timer)
    run.softStopping = undefined
  }
  if (run.suspension?.timer) {
    clearTimeout(run.suspension.timer)
    run.suspension.timer = undefined
  }
  run.stopped = true
  run.stoppedBy = by
  run.stoppedAt = Date.now()
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
  if (run.deadlineTimer) clearTimeout(run.deadlineTimer)
  // G9(b)：hard 停时若有排队未投的父→子消息，如实带出（不静默丢）。
  const droppedQueued = run.pendingChildMessages?.length ?? 0
  let text = reason || `已停止子代理「${run.label}」`
  if (droppedQueued > 0) {
    text = `${text}；另有 ${droppedQueued} 条排队消息未投递（因子代理已停止，这些消息已丢弃）`
    run.pendingChildMessages = []
  }
  // 修 3（2026-10-02）：中止＝先落盘 partial（已累积文字，档名规则同终态），再做
  // stopped 收尾——此前中止零产物、工作全丢（实锤：C2 与查重代理被一并杀掉）。
  run.partialPersist = true
  const persist = persistRunOutput(run, "timeout", partialBodyOf(run), text)
  const summary = persist.relPath ? `${persist.pointer}${text}` : text
  // 先落一条 done（不经 finishRun——那条路会走交付闸门/唤醒，停止语义不适用）。
  // 0920 停止闸：人工／orchestrator 停止不是失败，标 "stopped"，前端的 "已中止"。
  run.status = "stopped" satisfies TaskStatus
  run.error = text
  run.summary = summary
  removeFromRegistries(run)
  // 硬停是另一条终态路径（不经 finishRun）→ 同样触发 SubagentStop。
  fireSubagentHook("SubagentStop", run, { status: "stopped", stopped_by: by, reason: text.slice(0, 2000) })
  // 修 1：停止也释放槽位——补跑被挤掉的 critic 与挂起队列。
  maybeDrainCriticQueue(run.parentGatewaySessionId)
  checkPendingResumeQueue(run.parentGatewaySessionId)
  deleteReworkRecord(run.id)
  const stoppedResult = { status: "stopped" as const, summary, error: text, finishedAt: Date.now(), label: run.label, parent: run.parentGatewaySessionId, stopped_by: by, stoppedAt: run.stoppedAt, ...(droppedQueued > 0 ? { dropped_queued_messages: droppedQueued } : {}) }
  saveDurableSubagentRun(run, stoppedResult)
  completed.set(run.id, stoppedResult)
  // WP2（2026-10-14）：终态落点——叫醒 /internal/subagent/status 上该 run 的长挂起 waiter。
  notify(`subagent:${run.parentGatewaySessionId}:${run.id}`)
  const state = parentStateOf(run)
  if (state && deps) {
    try {
      deps.emitToSession(state, "subagent.done", { id: run.id, status: "stopped" satisfies TaskStatus, summary, stopped: true, stopped_by: by, ...(droppedQueued > 0 ? { dropped_queued_messages: droppedQueued } : {}) })
    } catch (e) {
      console.error(`[gateway] subagent stop emit failed: id=${run.id}`, e)
    }
    // G3：停止也给人话状态行（本路已停止＋剩余兄弟）。
    emitSubagentCompletedStatus(run, "stopped")
    // 刻意**不唤醒**父会话：停止＝结束，不是新任务。唤醒会让 orchestrator 又起一轮
    // （并可能再派新 subagent），正是用户抱怨的「刹不住」。
  }
  // 转录终态与会话是否还在无关：会话已摘除时照样落 end（一次性标记防双写）。
  appendTranscriptEnd(run, "stopped", summary)
  if (isOpenCodeSessionId(run.opencodeSessionId) && deps) {
    void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}/abort`, {
      method: "POST",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
    void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}`, {
      method: "DELETE",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  console.log(
    `[gateway] subagent stopped: id=${run.id} label="${run.label}" by=${by} parent=${run.parentGatewaySessionId} reason=${text}`,
  )
  return true
}

/**
 * X4（2026-10-14）：soft stop ——「收尾而保留成果」，对应 Codex `Op::Interrupt`（而非硬杀）。
 * 与 hard 的关键差别（也是设计意图）：
 *   ① 子会话**不 DELETE**：历史与在途产物原地保留，成果不丢；
 *   ② 不直接写终态 stopped：abort 当前轮后投一句「立即收尾并写全当前成果」，
 *      等下一次 idle 走既有 summarizeChild → finishRun 正常收尾（可能产出可交付正文）；
 *   ③ 状态先进**非终态 interrupted**（X2：可再收输入），status 工具据此与三种终态区分；
 *   ④ 优雅期（SUBAGENT_SOFT_STOP_GRACE_MS）内未收尾 → 落 partial 后按 stopped 诚实收尾。
 * 明确的「用户手动停」语义（Y4「你自己停的」）仍归 hard／stopped：那些 run 不给续跑。
 */
function stopSubagentRunSoft(run: SubagentRun, by: "user" | "orchestrator", reason: string): boolean {
  if (run.status !== "running" && run.status !== "interrupted" && run.status !== "suspended") return false
  if (run.stopped) return false
  // P2（2026-10-18）：连续 soft stop 会覆盖 run.softStopping 而旧 grace timer 仍活着
  // ⇒ 旧 timer 到点用旧闭包把 run 硬停（计时器泄漏 + 语义错乱）。覆盖前先撤旧 timer。
  if (run.softStopping?.timer) clearTimeout(run.softStopping.timer)
  if (run.suspension?.timer) {
    clearTimeout(run.suspension.timer)
    run.suspension.timer = undefined
  }
  const text = reason || `已请子代理「${run.label}」收尾`
  run.softStopping = { at: Date.now(), reason: text, by }
  // X2：非终态 interrupted——当前回合被打断，仍可再收输入（收尾指令就是它的下一条输入）。
  run.status = "interrupted" satisfies TaskStatus
  // 心跳继续（interrupted 不是终态，父会话需要继续知道它活着直到收尾落地）。
  const state = parentStateOf(run)
  if (state && deps) {
    try {
      deps.emitToSession(state, "subagent.tool", { id: run.id, call_id: `soft-stop:${run.id}`, tool: "subagent_stop", status: "ok" })
      deps.emitToSession(state, "turn.status", { text: `子代理「${userFacingSubagentLabel(run.label)}」正在收尾（成果保留）…` })
    } catch {
      /* 状态帧失败不影响收尾 */
    }
  }
  writeLiveLog(run, true)
  if (isOpenCodeSessionId(run.opencodeSessionId) && deps) {
    // 先 abort 当前轮：不给在途长任务无限续命（X4 的取消 token），但**不 DELETE**子会话。
    void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}/abort`, {
      method: "POST",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
    // 再投「立即收尾」指令：abort 之后的下一个 idle 会走 summarizeChild 正常收尾。
    void deliverChildTurn(run, `【发起方指令·立即收尾】${text}。请立刻停止开新工作，把当前已完成的部分写清楚（成品链接/路径/结论/未完成项），写完即结束本轮。`, "soft_stop", true)
  }
  if (run.softStopping.timer) clearTimeout(run.softStopping.timer)
  run.softStopping.timer = setTimeout(() => {
    // 优雅期用尽：落 partial 后按既有 stopped 路径诚实收尾（不无限等、不伪称成果已收齐）。
    const cur = run.softStopping
    run.softStopping = undefined
    if (!cur || run.status === "stopped" || completed.has(run.id)) return
    console.warn(`[gateway] subagent soft stop grace expired (${Math.round(SUBAGENT_SOFT_STOP_GRACE_MS / 1000)}s): id=${run.id} label="${run.label}" — 落 partial 后按 stopped 收尾`)
    run.status = "running" // 交回硬停路径的状态前置（其守卫要求 running）
    // `by` 用本次 soft stop 的真实发起者（不是硬编码 "orchestrator"）。
    stopSubagentRun(run, cur.by, `${text}（收尾超时，已按部分结果结束）`, "hard")
  }, SUBAGENT_SOFT_STOP_GRACE_MS)
  unrefTimer(run.softStopping.timer)
  console.log(`[gateway] subagent soft stop requested: id=${run.id} label="${run.label}" by=${by} parent=${run.parentGatewaySessionId} reason=${text}`)
  return true
}

/** 停止一个父会话名下全部在跑子代理（用户终止按钮 / orchestrator 一键清场）。回**真正停掉**几个。
 *  G4(d)/G9(a)（2026-10-14 修复）：把非终态 `interrupted`（软停收尾中）的 run 也纳入清场集合，
 *  计数只算真停到的（靠 stopSubagentRun 的布尔返回），不再出现「stopped:0 却列了该 run」的不诚实回执。 */
export function stopSubagentsForParent(parentGatewaySessionId: string, by: "user" | "orchestrator", reason = ""): number {
  const list = byParent.get(parentGatewaySessionId) ?? []
  // P1（2026-10-18）：stop-all 必须包含 suspended——挂起只是让出并发槽，run 仍在注册表里，
  // 用户按停止就是要它停；漏掉会让「已停止」的回执与实况不符。
  const running = list.filter((r) => (r.status === "running" || r.status === "interrupted" || r.status === "suspended") && !r.stopped)
  let stopped = 0
  for (const r of running) if (stopSubagentRun(r, by, reason)) stopped += 1
  return stopped
}

/** X4（2026-10-14）：按 id／label 前缀找**任意在途**（running／interrupted／suspended）run——软停、
 *  挂起与非终态可寻址需要它；`findRunningRun` 只认 running（既有语义不动，保持兼容）。 */
export function findLiveRun(parentGatewaySessionId: string, idOrLabel: string): SubagentRun | undefined {
    const list = (byParent.get(parentGatewaySessionId) ?? []).filter(
    (r) => (r.status === "running" || r.status === "interrupted" || r.status === "suspended") && !r.stopped,
  )
  const exact = list.find((r) => r.id === idOrLabel)
  if (exact) return exact
  // CC 2.1.302：name 是可直接寻址的稳定标识（subagent_message 按名字寻址）。
  const named = list.find((r) => r.name === idOrLabel)
  if (named) return named
  return list.find((r) => r.label.startsWith(idOrLabel))
}

/** 停止或恢复单一 run（orchestrator 工具用；id 可为 gateway run id 或 label 前缀）。回 run 或 undefined。 */
export function findRunningRun(parentGatewaySessionId: string, idOrLabel: string): SubagentRun | undefined {
  const list = (byParent.get(parentGatewaySessionId) ?? []).filter((r) => r.status === "running" && !r.stopped)
  const exact = list.find((r) => r.id === idOrLabel)
  if (exact) return exact
  const named = list.find((r) => r.name === idOrLabel)
  if (named) return named
  const byLabel = list.filter((r) => r.label.startsWith(idOrLabel))
  return byLabel[0]
}

export function boundMap<T>(map: Map<string, T>, max: number): void {
  if (map.size <= max) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

export function boundSet<T>(set: Set<T>, max: number): void {
  if (set.size <= max) return
  const oldest = set.values().next().value
  if (oldest !== undefined) set.delete(oldest)
}

export function pruneCompleted(): void {
  const now = Date.now()
  for (const [id, rec] of completed) {
    if (now - rec.finishedAt > COMPLETED_TTL_MS) completed.delete(id)
  }
}

// FIX-B：记住子会话→父会话绑定（有界）；byChildOc 收尾删除后仍能解析父 state 供晚到取件。
export function rememberChildParent(childId: string, run: SubagentRun): void {
  bindGenerationConsumer(childId, run.parentGatewaySessionId, run.parentOpencodeSessionId, run.agent)
  recentChildParent.set(childId, {
    parentGatewaySessionId: run.parentGatewaySessionId,
    parentOpencodeSessionId: run.parentOpencodeSessionId,
    at: Date.now(),
    memberName: run.mailboxName,
  })
  while (recentChildParent.size > RECENT_CHILD_PARENT_CAP) {
    const oldest = recentChildParent.keys().next().value
    if (oldest === undefined) break
    recentChildParent.delete(oldest)
  }
}

// FIX-B：lazy prune 过期项（TTL 2h），随每次回退查询顺手清（只在 subagentParentState miss 时呼叫）。
function pruneRecentChildParent(now: number): void {
  for (const [k, v] of recentChildParent) {
    if (now - v.at > RECENT_CHILD_PARENT_TTL_MS) recentChildParent.delete(k)
  }
}

export function removeFromRegistries(run: SubagentRun): void {
  byChildOc.delete(run.opencodeSessionId)
  const list = byParent.get(run.parentGatewaySessionId)
  if (list) {
    const idx = list.indexOf(run)
    if (idx >= 0) list.splice(idx, 1)
    if (list.length === 0) byParent.delete(run.parentGatewaySessionId)
  }
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
  if (run.deadlineTimer) clearTimeout(run.deadlineTimer)
  if (run.heartbeatTimer) clearInterval(run.heartbeatTimer)
  if (run.earlyPartialTimer) clearTimeout(run.earlyPartialTimer)
  // F7（P2·计时器泄漏修复）：挂起时臂上的 timer 此前不在此清——摘注册表（stop/终态回收）后
  // 挂起 timer 仍会到点尝试唤醒已回收的 run。与上面四个计时器同处清理。
  if (run.suspension?.timer) {
    clearTimeout(run.suspension.timer)
    run.suspension.timer = undefined
  }
}

