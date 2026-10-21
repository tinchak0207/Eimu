import { appendTranscript } from "./subagent-transcript.ts"
import { parseToolOutput, collectToolOutputMediaUrls, emitVideoDone, emitAudioDone, attachCanvasTask } from "./events-translate.ts"
import { saveDurableSubagentRun } from "./job-store"
import { shouldTriggerCriticPass, buildCriticPassSpec, CRITIC_PASS_MAX_TARGETS, DELIVERY_CONTRACTS, scrubSubagentPayload, CriticPassTarget } from "./delivery-gate"
import { markCriticPass, hasCriticPass, deleteCriticPass } from "./persistence"
import type { SubagentModelRef, SubagentRun } from "./subagent-types.ts"
import { SPEC_DEADLINE_LINE, MAX_ACTIVE_PER_PARENT, HARD_TIMEOUT_MS, ASYNC_HARD_TIMEOUT_MS, partialBodyOf, isInternalReviewRun, isOpenCodeSessionId } from "./subagent-types.ts"
import { fireSubagentHook, deps, byParent, byChildOc, completed, sessionScratchpads, sessionArtifactRegistries, pendingCriticTargets, criticDispatchedByParent, criticPassUsed, criticRetryQueue, parentStateOf, boundMap, boundSet } from "./subagent-runs.ts"
import { finishRun, armHeartbeat } from "./subagent-finish.ts"
import { summarizeChild } from "./subagent-liveness.ts"
import { dispatchAttempt, retryWithNextModel } from "./subagent-attempt.ts"
import { recordToolTimeline, writeLiveLog, ensureTranscript } from "./subagent-live.ts"
import { flushPendingChildMessages } from "./subagent-messages.ts"

/** 全局 tap 入口：子会话事件翻译成 subagent.* 帧发到父会话。 */
export function handleSubagentEvent(event: any, opencodeSessionId: string): void {
  if (!deps) return
  const run = byChildOc.get(opencodeSessionId)
  if (!run) return
  // 0920 停止闸：停止后子会话已 DELETE，残影事件一律丢弃（否则又推进卡片状态、
  // 甚至触发换模重投把 run 复活）。
  if (run.stopped) return
  // F8（断面 B）：任何子会话事件都刷新活性时间戳——这是活性检测「子会话仍在写入/
  // 仍在发事件」的唯一证据来源（含 part 增量、工具状态、session.idle 等）。
  run.lastActivityAt = Date.now()
  try {
    // 上游错误（session.error 或任意带 properties.error 的事件）→ 换模重试或 done error。
    const err = event?.properties?.error
    if (event?.type === "session.error" || err != null) {
      const msg = err != null ? deps.describeError(err) : "子代理上游错误"
      // 只有上游模型错误（opencode APIError 形状 {name, data:{message}}）才换模重试；
      // tool_error/Aborted 不是渠道问题，换模无意义，维持原语义直接收尾。
      const isUpstreamApiError =
        Boolean(err) && typeof err === "object" && typeof (err as { data?: { message?: unknown } }).data?.message === "string"
      if (isUpstreamApiError && !run.isFork && run.attempt < run.modelChain.length) {
        const nextAttempt = run.attempt + 1
        console.error(
          `[gateway] subagent upstream error (attempt ${run.attempt}/${run.modelChain.length}): id=${run.id} label="${run.label}" error=${msg} — 换模重投`,
        )
        run.attempt = nextAttempt
        // 旧子会话摘除 + best-effort 清理；per-child 映射重置，避免新会话被脏状态误判。
        byChildOc.delete(opencodeSessionId)
        // E 片（2026-09-12）缺陷二防御：ses 前缀不符就不拼 URL（跳过并记录）。
        if (isOpenCodeSessionId(opencodeSessionId)) {
          void fetch(`${deps.openCodeUrl}/session/${opencodeSessionId}`, {
            method: "DELETE",
            headers: deps.openCodeHeaders(),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {})
        } else {
          console.error(
            `[gateway] subagent cleanup skipped (retry): id=${run.id} reason=invalid opencode session id "${String(opencodeSessionId)}"`,
          )
        }
        run.messageRole.clear()
        run.partEmitted.clear()
        run.partKind.clear()
        run.suppressedParts.clear()
        void retryWithNextModel(run, msg)
        return
      }
      console.error(
        `[gateway] subagent failed: id=${run.id} label="${run.label}" attempt=${run.attempt}/${Math.max(run.modelChain.length, 1)} error=${msg}`,
      )
      // 0919 诚实归因（video-director 试产事故）：shuai 预扣费闸的「预扣费额度失败,
      // 用户剩余额度…」原文直出时，orchestrator 在 model-not-found 噪音里把欠费
      // 误读成「模型不可用」再转述给用户。欠费死因补一句归因：未提交、未扣费、
      // 无产物、充值前重试无效——错误分类给机器，因果说明给读它的模型。
      const deadAccountNote = /预扣费额度失败|insufficient[ _-]?(account[ _-]?)?(balance|credit)|余额不足|欠费/i.test(String(msg))
        ? "（归因：上游渠道账户余额不足即欠费，不是模型不可用；本次调用未提交、未扣费、无产物，充值前重试不会成功）"
        : ""
      finishRun(run, "error", "", `子代理出错：${String(msg)}${deadAccountNote}`)
      return
    }

    const parentState = parentStateOf(run)
    if (!parentState) return // 父会话已被回收：不再发帧，等 idle/超时收尾
    // 2026-10-04 F6：机器内审 run（critic pass）的推理/正文一律不上屏——内审正文对用户零价值，
    // 且是 R3 实测最大的外泄通道（subagent.delta 把子代理正文按帧流给父会话，实测含
    // evidence/qc/verdict/退回）。此处按 run 身份整体抑制；非内审子代理照常流，咽喉点再做 token 级兜底。
    const hideBody = isInternalReviewRun(run) || typeof run.goalEvaluator === "function"

    switch (event?.type) {
      case "message.updated": {
        const info = event?.properties?.info
        const mid = typeof info?.id === "string" ? info.id : undefined
        const role = typeof info?.role === "string" ? info.role : undefined
        // X6（2026-10-14）：当前回合标识。opencode 不暴露 turn id，用本回合第一条 assistant
        // 讯息 id 作诚实代理（idle／新投递时清零），供 steer{expected_turn_id} 校验与
        // status 快照回报；不确定时宁可不匹配（fail-closed），不假装知道。
        if (mid && role === "assistant" && run.currentTurnId === undefined) run.currentTurnId = mid
        if (mid && role) {
          run.messageRole.set(mid, role)
          boundMap(run.messageRole, 200)
        }
        // 压缩复读机修复（2026-10-02）：compaction 摘要讯息 role 也是 assistant，
        // 标成非 assistant 后 subagent.delta 不再把摘要草稿当子代理正文上屏。
        if (mid && role === "assistant" && info?.summary === true) {
          run.messageRole.set(mid, "compaction")
          boundMap(run.messageRole, 200)
        }
        break
      }
      case "message.part.delta": {
        const p = event.properties ?? {}
        // text 字段同一通道：正文与 reasoning 增量都转成 subagent.delta，
        // 前端只取最近一行，网关不裁。role 只认 assistant（防用户 prompt 回声）。
        if (p.field === "text" && typeof p.delta === "string" && p.delta.length > 0) {
          if (typeof p.messageID !== "string" || run.messageRole.get(p.messageID) !== "assistant") break
          if (typeof p.partID === "string" && run.suppressedParts.has(p.partID)) break
          // S3（2026-09-11）：reasoning 增量一并转发（跑马灯要让用户感知「子代理在
          // 工作」），用 kind 与正文区分；正文 payload 维持原样不带 kind（零回归）。
          const kind = typeof p.partID === "string" ? run.partKind.get(p.partID) : undefined
          // G3（2026-10-10）：reasoning 增量不再转发父会话——评测 A/B/C 数万～十几万
          // subagent.delta 主因是英文思考洪流；存活感已由 turn.status 心跳覆盖。正文 delta 照常。
          if (!hideBody && kind !== "reasoning") {
            deps.emitToSession(parentState, "subagent.delta", { id: run.id, text: p.delta })
            appendTranscript(run.id, { t: Date.now(), k: "text", s: scrubSubagentPayload(p.delta) })
          } else if (hideBody && kind !== "reasoning" && run.transcriptHideNoted !== true) {
            run.transcriptHideNoted = true
            appendTranscript(run.id, { t: Date.now(), k: "note", name: "internal", s: "（内部复核正文不外传）" })
          }
          if (typeof p.partID === "string") {
            run.partEmitted.set(p.partID, (run.partEmitted.get(p.partID) ?? 0) + p.delta.length)
            boundMap(run.partEmitted, 200)
          }
        }
        break
      }
      case "message.part.updated": {
        const part = event?.properties?.part
        if (!part) break
        // F8（断面 B）：工具在途登记/摘除。「有在途工具」时长期静默是正常的（长生成，
        // 如 music_gen 真生成 150-180s），活性检测据此放行、绝不误杀。
        if (part.type === "tool") {
          const callId = typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : ""
          const st = typeof part.state?.status === "string" ? part.state.status : ""
          if (callId && st) {
            if (st === "pending" || st === "running") {
              run.pendingTools.add(callId)
              boundSet(run.pendingTools, 200)
              if (!run.pendingToolSince) run.pendingToolSince = new Map()
              if (!run.pendingToolSince.has(callId)) run.pendingToolSince.set(callId, Date.now())
              if (!run.pendingToolInfo) run.pendingToolInfo = new Map()
              const toolName = typeof part.tool === "string" ? part.tool : ""
              const out = typeof part.state?.metadata?.output === "string" ? part.state.metadata.output : ""
              const info = run.pendingToolInfo.get(callId) ?? { name: toolName, outLen: 0, outAt: 0 }
              if (toolName) info.name = toolName
              if (out.length > info.outLen) { info.outLen = out.length; info.outAt = Date.now() }
              else if (!info.outAt && out.length > 0) info.outAt = Date.now()
              run.pendingToolInfo.set(callId, info)
            } else if (st === "completed" || st === "error") {
              run.pendingTools.delete(callId)
              run.pendingToolSince?.delete(callId)
              run.pendingToolInfo?.delete(callId)
            }
          }
          // 2026-10-05：向父会话发子代理工具状态帧。此前网关从不发这类帧 → 长工具
          // （音乐生成 150-180s）期间前端只看到一段可能空白的跑马灯，用户以为卡死。
          // 只在状态**变化**时发一次（同一 part 会多次 updated）；payload 契约与前端
          // agent-chat-types.ts 的 AgentSubagentTool 对齐：
          //   { id: 子代理 run id, call_id, tool, status: "running"|"ok"|"failed" }
          // 工具名原样送（前端用既有 toolDisplayName() 转人话），不在此造中文、
          // 不送 state.title/input（可能含内部路径与命令原文，属于泄漏面）。
          if (callId && st) {
            const frameStatus = st === "pending" || st === "running" ? "running" : st === "completed" ? "ok" : "failed"
            // 2026-10-14 协作总线（X8 工具三段）：工具时间线在有界表里就地维护
            // （Begin=首次见到该 callID，End=状态落终；同一 part 会多次 updated，故就地更新
            // 而不是追加），父模型不必再靠 SSE 帧拼装才知道子代理在跑什么工具。
            const toolName = typeof part.tool === "string" ? part.tool : "tool"
            recordToolTimeline(run, callId, toolName, frameStatus)
            if (run.toolStatusEmitted.get(callId) !== frameStatus) {
              run.toolStatusEmitted.set(callId, frameStatus)
              boundMap(run.toolStatusEmitted, 200)
              deps.emitToSession(parentState, "subagent.tool", {
                id: run.id,
                call_id: callId,
                tool: toolName,
                status: frameStatus,
              })
              appendTranscript(run.id, { t: Date.now(), k: "tool", id: callId, name: toolName, status: frameStatus })
              // C1：工具状态**变化**是实时工作日志档最有价值的时点——节流仍 ≥1000ms。
              writeLiveLog(run)
            }
          }
        }
        // FIX-A（2026-10-02）：子代理工具结果的媒体成品 → 父会话出卡。野兽模式下音乐/影片
        // 只能在 Expert 子代理里产生，而其 tool part 此前整类被丢弃 ⇒ 子代理做出的影片/音乐
        // 永远不出卡（暴君抱怨「影片／音乐不主动弹出」的真主因）。只认 completed；去重交给
        // emitVideoDone/emitAudioDone 的 state.announcedUrls（同一 part 可能多次 updated、
        // completed 可能重复触发）。刻意**不处理 image**：子代理（如 video-director）会产大量
        // 中间关键帧，一并发 image.done 会把聊天框灌爆——只放行成片类媒体，刻意的不对称。
        if (part.type === "tool" && part.state?.status === "completed") {
          const parsedOut = parseToolOutput(part.state.output)
          // 2026-10-05：子代理的生成任务必须登记进**父会话**任务表。此前这里只把媒体升格成
          // 卡片、task_id 整类丢弃 ⇒ 父模型用 image_get_result（读 /internal/session-tasks）
          // 查不到自己子代理提交过的任何 job（「每个预览卡都是成品、模型自己都不知道」）。
          // attachCanvasTask 只在 parentState.canvasUnitByCall 命中时才有画布副作用；子代理
          // 的 callID 不在父会话表里 ⇒ 此处等价于「只登记任务」。
          const childCallId =
            typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : ""
          if (parsedOut && typeof parsedOut.task_id === "string" && parsedOut.task_id) {
            attachCanvasTask(parentState, childCallId, parsedOut.task_id)
          }
          const media = collectToolOutputMediaUrls(parsedOut)
          for (const c of media.video) {
            if (!run.artifacts.some((a) => a.url === c.url)) {
              run.artifacts.push({ kind: "video", url: c.url, task_id: parsedOut?.task_id, cost_coins: c.cost_coins })
              appendTranscript(run.id, { t: Date.now(), k: "artifact", kind: "video", url: c.url, ...(parsedOut?.task_id ? { task_id: parsedOut.task_id } : {}) })
            }
            void emitVideoDone(parentState, c.url, c.cost_coins, undefined, "video")
          }
          for (const c of media.audio) {
            if (!run.artifacts.some((a) => a.url === c.url)) {
              run.artifacts.push({ kind: "audio", url: c.url, task_id: parsedOut?.task_id, cost_coins: c.cost_coins })
              appendTranscript(run.id, { t: Date.now(), k: "artifact", kind: "audio", url: c.url, ...(parsedOut?.task_id ? { task_id: parsedOut.task_id } : {}) })
            }
            void emitAudioDone(parentState, c.url, c.cost_coins, undefined, "audio", { title: c.title, cover: c.cover })
          }
        }
        if (part.type !== "text" && part.type !== "reasoning") {
          // step-start 与未知类型不可达前端：记 partID，其 delta 一并丢弃
          //（delta 事件自身不带类型，与主路径 suppressedParts 同语义）。
          const pid = typeof part.id === "string" ? part.id : ""
          if (pid) run.suppressedParts.add(pid)
          break
        }
        const id = typeof part.id === "string" ? part.id : ""
        if (!id) break
        // S3（2026-09-11）：part 建立那一刻（text 还是空串）就登记类型——空文本会走
        // 下面的早退分支，登记必须放在早退之前，否则其 delta 全部丢 kind（实弹实锤）。
        run.partKind.set(id, part.type)
        boundMap(run.partKind, 200)
        // 修 3：保存 text part 最新全文（part.updated 带完整 text），供逾时/中止 partial 落盘。
        if (part.type === "text" && typeof part.text === "string") {
          run.partText.set(id, part.text)
          boundMap(run.partText, 200)
          // C1：正文长出来了 ⇒ 刷新实时工作日志档（档内有节流，不会每个 delta 都 fsync）。
          writeLiveLog(run)
        }
        if (typeof part.text !== "string") break
        if (part.text.length === 0) break
        if (typeof part.messageID !== "string" || run.messageRole.get(part.messageID) !== "assistant") break
        const emittedLen = run.partEmitted.get(id) ?? 0
        if (part.text.length > emittedLen) {
          const suffix = part.text.slice(emittedLen)
          // G3：reasoning part 后缀不转发（同上）；正文照常。
          if (!hideBody && part.type !== "reasoning") {
            deps.emitToSession(parentState, "subagent.delta", { id: run.id, text: suffix })
            appendTranscript(run.id, { t: Date.now(), k: "text", s: scrubSubagentPayload(suffix) })
          } else if (hideBody && part.type !== "reasoning" && run.transcriptHideNoted !== true) {
            run.transcriptHideNoted = true
            appendTranscript(run.id, { t: Date.now(), k: "note", name: "internal", s: "（内部复核正文不外传）" })
          }
          run.partEmitted.set(id, part.text.length)
          boundMap(run.partEmitted, 200)
        }
        break
      }
      case "session.idle": {
        // X6（2026-10-14）：回合边界。currentTurnId 清零——上一轮的 id 不能拿来给下一轮
        // 的 `steer{expected_turn_id}` 当判据（否则误匹配）。
        run.currentTurnId = undefined
        // X6/QueueOnly（start_if_idle 在跑时排队的父→子消息）：回合边界正是投递点——
        // 有排队就投递并**不**收尾（该 run 继续跑），没有排队＝原行为逐字不变。
        if (run.pendingChildMessages.length > 0 && run.status === "running" && !run.stopped) {
          void flushPendingChildMessages(run)
          break
        }
        // 子会话 turn 结束：取最后一条 assistant 文本收尾（异步，不阻塞 tap）。
        void summarizeChild(run)
        break
      }
      default:
        break
    }
  } catch (e) {
    console.error(`[gateway] subagent event translation failed: type=${event?.type}`, e)
  } finally {
    // OC message DB is the canonical stream; snapshot bounded state, avoiding fsync for every token delta.
    // 2026-10-14：非终态 interrupted（soft stop 收尾窗）同样要快照——否则重启后这一段实况丢失。
    if ((run.status === "running" || run.status === "interrupted") && Date.now() - ((run as any).durableSnapshotAt || 0) >= 3000) {
      saveDurableSubagentRun(run)
      ;(run as any).durableSnapshotAt = Date.now()
    }
  }
}

// ── 刀 2（2026-09-15）：machine critic pass —— gateway 自己在收盘判定点派 critic ────────────
// 四轮实录：playbook 第 18 条「必须派 critic」四轮在场、orchestrator 四轮零派遣（r3c 逐字
// 「I won't re-dispatch anything…synthesis is my job」）。纯 prompt 路线已证死 → 不叫模型派。
//
// 挂点＝父会话 session.idle 正常收尾分支（index.ts），调本函数。设计铁律：
//   · 派遣轮子**复用 dispatchAttempt**（同 handleSubagentDispatch 范式：建子会话 + agent 栏
//     + 宪法头 + 契约栏注入 + modelChain），禁自造第二套派遣/轮询。
//   · async 语义沿用：终态由 finishRun → deps.wakeParent 回件（通过抑制唤醒、退回送判决）。
//   · 有界：每会话 ≤1 次（persistence.critic_passes 持久旗标 + 内存镜像）；critic run 自身
//     agent==="critic" 永不入待审清单（finishRun 登记侧已豁免）= 不递归。
//   · 零预算外泄：只在「本来就有 Expert 交付」时跑；同轮已有 critic 派遣 → 不重派。
//   · 并发上限让位：父会话已满 3 路（如 async 子代仍在跑）→ 本轮放弃、不记旗标，下轮 idle 再试。

/**
 * 收盘判定点呼叫：条件成立 → 机器派遣一次 critic pass。回 true = 已派出。
 * 幂等/有界全部在内部（见上方注解）。任何失败只留一行 log，绝不影响收盘路径。
 */
export function hasWorkflowCriticReview(parentId: string | undefined, targetId: string): boolean {
  if (!parentId) return false
  return (pendingCriticTargets.get(parentId) ?? []).some((target) => target.runId === targetId) ||
    (byParent.get(parentId) ?? []).some((run) => run.status === "running" && run.criticReviewed?.some((target) => target.runId === targetId))
}

/** Workflow QC shares the existing critic registry, queue and lifecycle; one request per current artifact. */
export function enqueueWorkflowCriticReview(parentState: any, targets: CriticPassTarget[]): boolean {
  if (!deps || !parentState?.sessionId || targets.length === 0) return false
  const parentId = String(parentState.sessionId)
  const queued = pendingCriticTargets.get(parentId) ?? []
  for (const target of targets) if (!queued.some((q) => q.runId === target.runId)) queued.push(target)
  pendingCriticTargets.set(parentId, queued)
  return maybeRunMachineCriticPass(parentState)
}

export function maybeRunMachineCriticPass(parentState: any, unreviewedDeclared = false): boolean {
  try {
    if (!deps || !parentState?.sessionId) return false

    // ① 待审清单（finishRun 对 Expert 正常终态登记）。空 → 零动作（非 beast/无 Expert 交付）。
    const parentId = String(parentState.sessionId)
    const allTargets = pendingCriticTargets.get(parentId) ?? []
    const workflowBatch = allTargets.some((target) => target.workflowReview)
    const targets = workflowBatch ? allTargets.filter((target) => target.workflowReview) : allTargets
    if (targets.length === 0) return false

    // ② 每会话 ≤1 次：内存镜像 or 持久旗标（重启后仍生效）。
    const alreadyPassed = criticPassUsed.has(parentId) || hasCriticPass(parentId)

    // ③ 纯函数判据（四态单测对象）。
    const ok = workflowBatch || shouldTriggerCriticPass({
      beastMode: deps.beastMode(parentState) === true,
      expertDeliveries: targets.length,
      criticDispatched: criticDispatchedByParent.get(parentId) === (parentState.turnGen ?? 0),
      unreviewedDeclared: unreviewedDeclared === true, // 逃生阀由呼叫端（index.ts 扫本轮正文）判定
      alreadyPassed,
    })
    if (!ok) return false

    // ④ 修 1（2026-10-02）：并发上限满时**不再丢弃**——待审目标入队（per-parent），
    // 任一子代理完成释放槽位时由 maybeDrainCriticQueue 补跑。此前 return false 直接
    // 丢弃（实锤：四次被挤掉；唯一一次跑到时 verdict 亦未回灌）。
    const list = byParent.get(parentId) ?? []
    const runningCount = list.filter((r) => r.status === "running").length
    if (runningCount >= MAX_ACTIVE_PER_PARENT) {
      criticRetryQueue.set(parentId, targets.slice(-CRITIC_PASS_MAX_TARGETS))
      boundMap(criticRetryQueue, 500)
      console.log(
        `[gateway] machine critic pass queued (parent at concurrency cap ${MAX_ACTIVE_PER_PARENT}, retry on slot release): session=${parentId}`,
      )
      return false
    }
    // 修 1：正常派出（槽位有余）时清残留队列，避免稍后 drain 重复派遣。
    criticRetryQueue.delete(parentId)

    // ⑤ spec：被审清单 + 各 Expert 契约栏（真源 DELIVERY_CONTRACTS）+ 固定审核指令。
    const batch = targets.slice(-CRITIC_PASS_MAX_TARGETS)
    const spec = buildCriticPassSpec(batch, DELIVERY_CONTRACTS)
    if (!spec) return false

    // ⑥ modelChain 同源（父会话 persona 主模型 + registry fallbacks）。
    let chain: SubagentModelRef[] = []
    try {
      chain = deps.subagentModelChain(parentState) ?? []
    } catch (e) {
      console.error(`[gateway] machine critic pass model chain failed (fallback to opencode default): session=${parentId}`, e)
    }

    const run: SubagentRun = {
      id: crypto.randomUUID(),
      parentGatewaySessionId: parentId,
      parentOpencodeSessionId: String(parentState.opencodeSessionId ?? ""),
      opencodeSessionId: "",
      label: "复核",
      startedAt: Date.now(),
      status: "running",
      // 首行补死线行（与 handleSubagentDispatch 同款；本 spec 首行非「预期 N」故会补）。
      prompt: SPEC_DEADLINE_LINE + spec,
      modelChain: chain,
      attempt: 1,
      reworkCount: 0,
      beastMode: true, // 已过 beastMode 判据
      agent: "critic",
      asyncMode: typeof deps.wakeParent === "function", // async 语义沿用；deps 未注入则降级同步
      machineCriticPass: true,
      // 2026-10-03：把被审的那批交付正文带进 run，供终态事后硬检抽取媒体 URL（见
      // applyMeasuredMediaVerdict）。此处 batch 即将被 pendingCriticTargets.delete 清掉。
      criticReviewed: batch,
      // 2026-10-14 协作总线（X3/X5/X6/X7/X8）：机器 critic run 与人类派工同一套字段，
      // 显式初始化（有界容器）——内审轮不在名册里自报身份，路径记为内审来源。
      childPath: `/root/critic-${crypto.randomUUID().slice(0, 8)}`,
      toolTimeline: [],
      pendingChildMessages: [],
      pendingParentNotes: [],
      pendingQuestions: [],
      submissionSeq: 0,
      messageRole: new Map(),
      partEmitted: new Map(),
      partKind: new Map(),
      suppressedParts: new Set(),
      partText: new Map(),
      lastActivityAt: Date.now(),
      pendingTools: new Set(),
      artifacts: [],
      toolStatusEmitted: new Map(),
      checkpoints: [],
    }

    // 注册进 byParent：与 handleSubagentDispatch 同语义——critic run 占一个并发位、
    // finishRun 的 removeFromRegistries 才能正确摘除本 run（否则残留注册表泄漏）。
    const parentRuns = byParent.get(parentId) ?? []
    parentRuns.push(run)
    byParent.set(parentId, parentRuns)
    // 机器 critic run 同样是子代理 run：建立成功即触发 SubagentStart。
    fireSubagentHook("SubagentStart", run, { purpose: "critic" })
    ensureTranscript(run)
    if (!workflowBatch) { criticPassUsed.add(parentId); markCriticPass(parentId) }
    criticDispatchedByParent.set(parentId, parentState.turnGen ?? 0)
    boundMap(criticDispatchedByParent, 500)
    // 已消耗：清待审清单（本会话不再有第二次 pass）。
    const remaining = allTargets.filter((target) => !batch.includes(target))
    if (workflowBatch && remaining.length) pendingCriticTargets.set(parentId, remaining)
    else pendingCriticTargets.delete(parentId)

    const asyncMode = run.asyncMode === true
    const hardMs = asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
    run.timeoutTimer = setTimeout(() => {
      console.warn(`[gateway] subagent hard timeout (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
      // 修 3（2026-10-02）：逾时先落盘已累积的 partial 文字，再 error 收尾（不让已有工作不可追）。
      run.partialPersist = true
      finishRun(run, "error", partialBodyOf(run), `子代理超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
    }, hardMs)
    // D5（2026-10-02）：机器 critic run 亦有心跳／逾时前部分交付。
    armHeartbeat(run, hardMs)

    // ⑦ 复用既有轮子投递（async 语义：立即返回，终态 wake）。
    void (async () => {
      const failure = await dispatchAttempt(run)
      if (failure) {
        if (!workflowBatch) criticPassUsed.delete(parentId)
        criticDispatchedByParent.delete(parentId)
        console.error(`[gateway] machine critic pass dispatch failed: session=${parentId} ${failure}`)
        // 回滚持久旗标：投递从未成功＝配额未消耗（不白吃唯一一次），清掉记录让下轮重试。
        if (!workflowBatch) deleteCriticPass(parentId)
        await finishRun(run, "error", "", failure)
        return
      }
      deps!.emitToSession(parentState, "subagent.started", { id: run.id, label: run.label })
      console.log(
        `[gateway] machine critic pass: session=${parentId} experts=${batch.length} dispatched critic_run=${run.id} child=${run.opencodeSessionId} agents=${batch.map((t) => t.agent).join(",")}`,
      )
    })()

    return true
  } catch (e) {
    console.error("[gateway] machine critic pass failed:", e)
    return false
  }
}

/**
 * CC 2.1.302 移植：目标验收派遣。复用 critic pass 的同一套轮子（byParent 注册 +
 * dispatchAttempt 建子会话 + modelChain + hard timeout/heartbeat），不新写模型客户端，
 * 也不走 handleSubagentDispatch 的 expert 校验。终态由 finishRun 的 goalEvaluator 回调
 * 交回调用方（只回最后一段 assistant 文本，不注入父会话、不发第二套 wake）。
 * 并发上限满／未注入 deps／投递失败 → 回 false，调用方下一回合再试。
 */
export function runGoalEvaluator(
  parentState: any,
  spec: { label?: string; prompt: string },
  onTerminal: (result: { status: "ok" | "error"; text: string; error?: string }) => void,
): boolean {
  try {
    if (!deps || !parentState?.sessionId) return false
    const prompt = typeof spec?.prompt === "string" ? spec.prompt : ""
    if (!prompt.trim() || typeof onTerminal !== "function") return false
    const parentId = String(parentState.sessionId)
    if ((byParent.get(parentId) ?? []).filter((r) => r.status === "running").length >= MAX_ACTIVE_PER_PARENT) {
      console.log(`[gateway] goal evaluator skipped (parent at concurrency cap ${MAX_ACTIVE_PER_PARENT}): session=${parentId}`)
      return false
    }
    let chain: SubagentModelRef[] = []
    try {
      chain = deps.subagentModelChain(parentState) ?? []
    } catch (e) {
      console.error(`[gateway] goal evaluator model chain failed (fallback to opencode default): session=${parentId}`, e)
    }
    const run: SubagentRun = {
      id: crypto.randomUUID(),
      parentGatewaySessionId: parentId,
      parentOpencodeSessionId: String(parentState.opencodeSessionId ?? ""),
      opencodeSessionId: "",
      label: spec.label ?? "目标验收",
      startedAt: Date.now(),
      status: "running",
      prompt: SPEC_DEADLINE_LINE + prompt,
      modelChain: chain,
      attempt: 1,
      reworkCount: 0,
      beastMode: false,
      agent: "critic",
      asyncMode: false,
      machineCriticPass: false,
      goalEvaluator: onTerminal,
      childPath: `/root/goal-${crypto.randomUUID().slice(0, 8)}`,
      toolTimeline: [],
      pendingChildMessages: [],
      pendingParentNotes: [],
      pendingQuestions: [],
      submissionSeq: 0,
      messageRole: new Map(),
      partEmitted: new Map(),
      partKind: new Map(),
      suppressedParts: new Set(),
      partText: new Map(),
      lastActivityAt: Date.now(),
      pendingTools: new Set(),
      artifacts: [],
      toolStatusEmitted: new Map(),
      checkpoints: [],
    }
    const parentRuns = byParent.get(parentId) ?? []
    parentRuns.push(run)
    byParent.set(parentId, parentRuns)
    // 目标验收 run 同样是子代理 run。
    fireSubagentHook("SubagentStart", run, { purpose: "goal_acceptance" })
    ensureTranscript(run)
    const hardMs = HARD_TIMEOUT_MS
    run.timeoutTimer = setTimeout(() => {
      console.warn(`[gateway] goal evaluator hard timeout (${Math.round(hardMs / 60000)}min): id=${run.id}`)
      run.partialPersist = true
      finishRun(run, "error", partialBodyOf(run), `目标验收超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
    }, hardMs)
    armHeartbeat(run, hardMs)
    void (async () => {
      const failure = await dispatchAttempt(run)
      if (failure) {
        console.error(`[gateway] goal evaluator dispatch failed: session=${parentId} ${failure}`)
        await finishRun(run, "error", "", failure)
        return
      }
      deps!.emitToSession(parentState, "subagent.started", { id: run.id, label: run.label })
      console.log(`[gateway] goal evaluator dispatched: session=${parentId} run=${run.id} child=${run.opencodeSessionId}`)
    })()
    return true
  } catch (e) {
    console.error("[gateway] goal evaluator failed:", e)
    return false
  }
}

/** 修 1：槽位释放后补跑被并发上限挤掉的 machine critic pass（per-parent 队列）。
 *  复用 maybeRunMachineCriticPass 的完整判据与派遣轮子（不另造第二套）。 */
export function maybeDrainCriticQueue(parentId: string): void {
  const queued = criticRetryQueue.get(parentId)
  if (!queued || queued.length === 0 || !deps) return
  if ((byParent.get(parentId) ?? []).filter((r) => r.status === "running").length >= MAX_ACTIVE_PER_PARENT) return
  const parentState = deps.resolveSession(parentId)
  if (!parentState?.sessionId) return
  criticRetryQueue.delete(parentId)
  if (maybeRunMachineCriticPass(parentState, false)) {
    console.log(`[gateway] machine critic pass drained from queue: session=${parentId} targets=${queued.length}`)
  } else {
    console.error(`[gateway] machine critic pass drain not dispatched: session=${parentId}`)
  }
}

/**
 * 会话拆除时清 machine critic pass 的内存状态（待审清单 / 派遣登记 / 内存已用旗标）。
 * 持久旗标（persistence.critic_passes）刻意不清：idle reap 后同 id revive 仍受「每会话 ≤1 次」
 * 约束；真删除时 row 随会话生命周期结束自然无害（无查询点）。
 */
export function forgetCriticPassState(parentId: string): void {
  if (!parentId) return
  pendingCriticTargets.delete(parentId)
  criticDispatchedByParent.delete(parentId)
  criticPassUsed.delete(parentId)
  criticRetryQueue.delete(parentId)
}

/** 会话拆除时按 sessionId 清共享工作区与 critic 已用标记。idle reap 也要清，避免 Map 无界。 */
export function forgetSessionWorkspaceState(sessionId: string): void {
  if (!sessionId) return
  sessionScratchpads.delete(sessionId)
  sessionArtifactRegistries.delete(sessionId)
  criticPassUsed.delete(sessionId)
}
/**
 * 刀 1（2026-09-19）：待审 Expert 交付快照（Jev 空壳栏初筛喂料）。
 * 只读镜像——不清空、不影响 machine critic pass 的消耗语义（浅拷贝阵列，
 * text 引用共享：呼叫方只读）。无待审 → 空阵列。
 */
export function snapshotPendingCriticTargets(parentId: string): Array<{ agent: string; label: string; runId: string; text: string }> {
  if (!parentId) return []
  return (pendingCriticTargets.get(parentId) ?? []).slice()
}
