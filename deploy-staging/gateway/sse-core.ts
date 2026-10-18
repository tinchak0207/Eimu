// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave1）：SSE 核心——serializeSse/isRevivalFrame/emitToSession（含 critic 逃生阀扫描）/N2 stripStaleTurnTextFromReplay/closeSessionStreams，
// 原 index.ts 1251–1376 行；openEventStream 原 index.ts 2668–2707 行。
import type { SessionState, SSEClient } from "./types-gateway.ts"
import { REPLAY_BUFFER_SIZE } from "./constants-gateway.ts"
import { declaresUnreviewed, scrubVisibleFrame } from "./delivery-gate"
import { markDirty } from "./sessions-core.ts"
import { encoder, corsOriginFor, corsHeaders } from "./auth-gw.ts"
import { trackTurnNodeTerminal } from "./events-translate.ts"
import { markTurnFirst } from "./metrics-gw.ts"
import { appendReplayFrame, MergedReplayFrame, isStrippableReplayEntry } from "./replay-frame.ts"
import { finishTurnMetrics } from "./metrics-gw.ts"
import { hydratePendingQuestions } from "./questions-gw.ts"
import { t2sVisibleData } from "./outbound-sanitize.ts"
// TODO(整合)：以下符号仍住 index.ts 且未 export（本任务禁改 index.ts；bun build 对未 export 的 named import 报错，已实测 2026-09-19）。
// 依第一阶段 subagent 占位符法（记忆 gateway-index-refactor-stage1-0919）：declare 占位可过 bun build；整合 subagent 统一换真 import 或于 index.ts 补 export。
// ---- SSE helpers (gateway -> frontend) ----

export function serializeSse(name: string, data: unknown, eventId: number): string {
  const payload = JSON.stringify({ ...(data as Record<string, unknown>), event_id: eventId })
  return `id: ${eventId}\nevent: ${name}\ndata: ${payload}\n\n`
}

/**
 * 2026-10-18：网关追加正文的统一换行闸（纯函数）。已发正文不以换行结尾时，在追加文字前补一个 \n。
 * 起因：plan-promise 收尾提示直接拼在模型结尾的「```」后面，闭合行变成「```本轮由我…」，
 * openui 围栏不闭合 → 前端解析 root=false → 整段 DSL 裸露显示（ses_eb38c6a61ffeBgJ6ViYriiPx0R）。
 */
export function withLeadingNewlineIfNeeded(lastChar: string | undefined, text: string): string {
  if (!text || !lastChar || lastChar === "\n" || text.startsWith("\n")) return text
  return `\n${text}`
}

/** 修 1（2026-09-01）：内容/产物帧 = 僵尸还魂的证据。watchdog 死亡宣告后，
 *  这些帧到达说明重投 retry 真的在产出——「后端无响应」是误判，必须撤回。 */
export function isRevivalFrame(name: string): boolean {
  return (
    name === "message.delta" ||
    name === "reasoning.delta" ||
    name === "image.done" ||
    name === "video.done" ||
    name.startsWith("tool.") ||
    name.startsWith("canvas.")
  )
}

export function emitToSession(state: SessionState, name: string, data: unknown, opts?: { strippable?: boolean }): void {
  // 2026-10-18：所有网关主动追加的正文（非 strippable＝非模型输出：plan-promise、emit-helpers、
  // timers-gw、workflow-gw、messages-gw、sessions-core 等）统一在此单一出口补前导换行。
  if (name === "message.delta") {
    const raw = (data as { text?: unknown })?.text
    if (typeof raw === "string" && raw) {
      if (!(opts?.strippable ?? false)) {
        const fixed = withLeadingNewlineIfNeeded(state.messageDeltaLastChar, raw)
        if (fixed !== raw) data = { ...(data as Record<string, unknown>), text: fixed }
      }
      state.messageDeltaLastChar = raw.slice(-1)
    }
  } else if (name === "turn.done") {
    state.messageDeltaLastChar = undefined
  }
  // 修 1（2026-09-01）：死亡宣告可撤回。deathDeclared 期间第一条内容帧到达
  // → 先发一次性撤回帧（turn.status，与 watchdog 告警同通道，前端零改动），
  // 立即清位（防重复撤回/防递归），再放行原内容帧。
  if (state.deathDeclared && isRevivalFrame(name)) {
    state.deathDeclared = false
    console.log(`[gateway] death declaration retracted: revival frame ${name} arrived — session=${state.sessionId}`)
    // 2026-10-04 W：撤回宣告属守卫家族固定文案，一律简体（书写体镜像已拆）。
    emitToSession(state, "turn.status", {
      text: "刚才的「后端无响应」是误判，任务已自动恢复，请继续等待本轮结果",
    })
  }
  // Agent-produced output counts as activity: a long generate with no client
  // polling must not look idle to the reaper while it is still working.
  state.lastActivityAt = Date.now()
  if (name === "subagent.started") state.turnSubagentStarts = (state.turnSubagentStarts ?? 0) + 1
  // R4-A S3①：turn 进度打点——错误停滞看门狗判定「错误后 turn 是否还活著」
  // 的依据。只认模型/工具帧（正文、工具出入参）；canvas 等状态帧不算进度。
  if (name === "message.delta" || name === "reasoning.delta" || name === "tool.invoke" || name === "tool.result") {
    state.turnProgressAt = Date.now()
  }
  // R5-C 中段停滞哨：任何帧都算「还活著」的证据（canvas/confirm 状态帧也算
  // ——只对连帧都没有的冻结告警，长工具执行有进度帧就不误杀）。
  state.turnLastFrameAt = Date.now()
  // 刀 2（2026-09-15）：机器 critic pass 逃生阀扫描。本轮正文出现「未经独立审核」自签声明
  // （playbook 第一节末：critic 派遣失败时允许自签兜底且须注明）→ 本轮不触发机器 pass。
  // 成本 O(增量)：只在未命中时拼 32 字滚动尾巴，命中即置位不再算。
  if (name === "message.delta" && state.criticUnreviewedDeclared !== true) {
    const dtxt = (data as { text?: unknown })?.text
    if (typeof dtxt === "string" && dtxt) {
      const tail = (state.criticEscapeTail ?? "") + dtxt
      if (declaresUnreviewed(tail)) state.criticUnreviewedDeclared = true
      else state.criticEscapeTail = tail.slice(-32)
    }
  }
  // 刀 1（2026-09-19）：Jev 测谎闸喂料——本轮正文尾段累积（有界 4k，与
  // criticEscapeTail 同款 O(增量)；session.idle 收盘消费后清空）。
  if (name === "message.delta") {
    const dtxt = (data as { text?: unknown })?.text
    if (typeof dtxt === "string" && dtxt) {
      state.jevBriefTail = ((state.jevBriefTail ?? "") + dtxt).slice(-4000)
    }
  }
  // R4-A S8：本 turn 内到达终态的节点采集——中央出口挂钩，service.emit 与
  // 直接 emit 两条 canvas.node.updated 路径（成功+失败）全收，兼容两种载荷形状。
  if (name === "canvas.node.updated") trackTurnNodeTerminal(state, data)
  state.eventCounter += 1
  // 2026-10-04 F5：出站文字单一咽喉点——凡用户可见文字在离开进程前过一次 T2S。
  // 模型正文两条路径（emitSanitizedDelta / R9-B 尾行）已带 strippable 且在
  // stripOutboundFeed/stripOutboundFlush 里过一次 T2S，此处跳过以免对代码栅栏
  // 二次转换；其余全部（reasoning.delta、网关固定文案、结构化帧白名单字段、
  // subagent/timers/messages 等所有经本函数出口的帧）在此收口为简体。
  const sanitized = name === "message.delta" && (opts?.strippable ?? false) ? data : t2sVisibleData(data)
  // 2026-10-04 F6：用户可见帧的单一咽喉点——按帧名剥离内审/契约内部文字（subagent.done 摘要、
  // subagent.delta 正文）。同类剥离已在源头（subagent.ts run.summary）与唤醒路径（index.ts）做过，
  // 此处是任何漏网帧的最后一道收口；非目标帧原样返回（零误伤、零额外分配）。
  const outData = scrubVisibleFrame(name, sanitized)
  const frame = encoder.encode(serializeSse(name, outData, state.eventCounter))
  // 2026-10-02：只有模型产生的文字帧可被 N2 strip 剥除（见 stripStaleTurnTextFromReplay）。
  // 网关主动发出的 message.delta（工作流终态通报、进度汇报、诚实收尾等）默认耐久，
  // 必须能被晚重连的 client 取回——它们只是与模型正文共用事件名，不是模型输出。
  // reasoning.delta 只可能来自模型，维持可剥。
  const strippable = opts?.strippable ?? name === "reasoning.delta"
  // 2026-10-01：文字帧在 replay 层合并（见 replay-frame.ts），直播仍逐帧。
  appendReplayFrame(state.replayBuffer, name, outData, state.eventCounter, frame, strippable)
  if (state.replayBuffer.length > REPLAY_BUFFER_SIZE) {
    state.replayBuffer.splice(0, state.replayBuffer.length - REPLAY_BUFFER_SIZE)
  }
  markDirty(state) // 防抖落盘：重启后 replayBuffer 可供前端 Last-Event-ID 续传
  for (const client of state.clients) {
    try {
      client.controller.enqueue(frame)
    } catch {
      state.clients.delete(client)
    }
  }
  // ── Phase 0 观测（2026-09-18）：首帧打点 + 收档 ──────────────────────
  // 帧名唯一性：reasoning.delta / tool.invoke 只有模型路径会发；message.delta
  // 另有非模型出口（「文件已找到」提示等），故正文首帧改在 emitSanitizedDelta
  // 内打点，不在此处。放在帧入列之后＝t_done 为 turn.done 实际送出时刻。
  if (state.turnMetrics) {
    if (name === "reasoning.delta") markTurnFirst(state, "reasoning")
    else if (name === "tool.invoke") markTurnFirst(state, "tool")
    else if (name === "turn.done") finishTurnMetrics(state, "done")
  }
}

// ── N2（2026-08-27）：turn 重试不重放旧 turn 的文本帧 ──
// 根因（复测实锤 17:43:02）：watchdog/抖动重试重发 prompt 后，opencode 把
// 旧 turn 的 message.part.updated 全量补发（part.text 是累积全文），delta
// 路径的 partTextEmitted 在 session.idle 已被清空 → 前缀当「新后缀」全部
// 重发，且这些重放帧进了 replayBuffer——SSE 断线重连（Last-Event-ID）时
// 又整段重放一次（event 101-108+ 闪回）。
// 修法：重投 prompt 成功后，把 replayBuffer 里本轮 gen 标记之前的
// **模型** message.delta / reasoning.delta 文本帧过滤掉（保留 canvas.* /
// confirm.* / tool.* / quota.* 等状态类事件——它们幂等且前端靠它们恢复画布），
// 并同步 persist 的 DB 行。新 turn 的文本从零开始计，断线重连不会再看到旧文案。
// 2026-10-02：网关主动发出的耐久帧（strippable=false，工作流终态通报等）不剥
// ——它们与模型正文共用事件名，但不是模型输出；剥掉就等于用「防重放」误杀通报
//（wf_muqfkhw7_1 事故根因）。判定收在 replay-frame.isStrippableReplayEntry（纯函数）。
export function stripStaleTurnTextFromReplay(state: SessionState): void {
  const before = state.replayBuffer.length
  state.replayBuffer = state.replayBuffer.filter((f) => !isStrippableReplayEntry(f))
  if (state.replayBuffer.length !== before) {
    console.log(
      `[gateway] N2: stripped ${before - state.replayBuffer.length} stale text frame(s) from replay buffer before retry — session=${state.sessionId}`,
    )
    markDirty(state)
  }
}

export function closeSessionStreams(state: SessionState): void {
  for (const client of state.clients) {
    try {
      client.controller.close()
    } catch {
      // already closed
    }
  }
  state.clients.clear()
}

export function openEventStream(state: SessionState, lastEventId?: number, req?: Request): Response {
  let client: SSEClient | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = { controller }
      state.clients.add(client)
      controller.enqueue(encoder.encode(`event: connected\ndata: {"ok":true}\n\n`))
      if (typeof lastEventId === "number" && !Number.isNaN(lastEventId)) {
        for (const frame of state.replayBuffer) {
          if (frame.id > lastEventId) {
            // Last-Event-ID 落在合并段中间 → 只补其后的段，不重字。
            if (frame instanceof MergedReplayFrame && frame.firstId <= lastEventId) {
              controller.enqueue(frame.suffixFrame(lastEventId))
            } else {
              controller.enqueue(frame.frame.slice())
            }
          }
        }
      }
      // R4-A S3②：重启恢复时暂存的中断告知——SSE 接入即补投（一次性）。
      // R4 实锤：恢复瞬间无人在线，告知帧凭空蒸发，用户视角「说了话，它死了」。
      const pendingNotice = state.pendingRestoreNotice
      if (pendingNotice) {
        state.pendingRestoreNotice = undefined
        emitToSession(state, "message.delta", { text: pendingNotice.text })
        // R9-4：restore 路径与 question 冻结语义对齐——pending 期间不发 turn.done。
        if (state.pendingQuestions.size === 0) emitToSession(state, "turn.done", {})
      }
      void hydratePendingQuestions(state)
    },
    cancel() {
      if (client) state.clients.delete(client)
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
      ...corsHeaders(corsOriginFor(req?.headers.get("origin") ?? null)),
    },
  })
}

