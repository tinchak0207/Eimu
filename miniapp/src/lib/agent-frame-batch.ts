// SSE 帧并批器：把「纯文字追加」类高频帧合成一次渲染提交。
//
// 真源逐行照搬 src/lib/agent-chat-frame-batch.ts（125 行）。小程序没有 React
// 的自动批次跨任务边界：串流期每个 message.delta / reasoning.delta 都会触发
// 一次 setData → 整棵对话面板重渲染，长会话里按钮回应会明显变慢。本模块只并
// 批纯追加文字帧，其余帧语义一字不动。
//
// 设计：
//   * leading edge 立即 apply —— 距上次渲染已过 window 的帧不延迟，首字零延迟。
//   * 同 window 内的后续文字帧入列，window 到期一次 apply。
//   * 非并批帧（tool.result / turn.done / image.done / confirm.request /
//     session.* / canvas.* …）先同步 flush 缓冲再 apply 自己——这些帧带状态
//     语义，必须看到与它之前所有文字帧相同的顺序。
//
// 纯函数：时钟 / 排程器可注入，不碰 React / DOM。

import type { AgentSseEvent } from './agent'

/** 并批窗口：50ms ≈ 3 帧 @60Hz，肉眼无感但足以把一串 delta 折成一次渲染。 */
export const DEFAULT_FRAME_BATCH_WINDOW_MS = 50

export interface FrameBatcherOptions {
  /** 单帧落地出口 —— 通常就是页面的 applyEvent。 */
  apply: (evt: AgentSseEvent) => void
  /** 并批判准覆盖口（默认 shouldCoalesceAgentFrame）。 */
  shouldCoalesce?: (evt: AgentSseEvent) => boolean
  windowMs?: number
  now?: () => number
  schedule?: (cb: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

export interface FrameBatcher {
  push(evt: AgentSseEvent): void
  flush(): void
  drop(): void
  pendingCount(): number
}

/**
 * 只并批「纯文字追加」三帧（后一帧只 append 文字，最终状态逐字相同）。
 * tool.invoke/tool.result 会改条目结构，image.done / turn.done / session.closed
 * 是状态收尾，confirm.request 是用户要立刻看到的裁决卡 —— 一律直通。
 */
export function shouldCoalesceAgentFrame(evt: AgentSseEvent): boolean {
  return evt.name === 'message.delta' || evt.name === 'reasoning.delta' || evt.name === 'subagent.delta'
}

export function createFrameBatcher(options: FrameBatcherOptions): FrameBatcher {
  const apply = options.apply
  const shouldCoalesce = options.shouldCoalesce ?? shouldCoalesceAgentFrame
  const windowMs = options.windowMs ?? DEFAULT_FRAME_BATCH_WINDOW_MS
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let queue: AgentSseEvent[] = []
  let timer: unknown = null
  // 上次真正落地渲染的时刻。初值 -Infinity ⇒ 第一条帧必走 leading edge。
  let lastAppliedAt = Number.NEGATIVE_INFINITY

  function applyNow(evt: AgentSseEvent): void {
    apply(evt)
    lastAppliedAt = now()
  }

  function flush(): void {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
    if (queue.length === 0) return
    const frames = queue
    queue = []
    // 按入列顺序逐帧 apply：顺序即语义，并批绝不重排。
    for (const frame of frames) apply(frame)
    lastAppliedAt = now()
  }

  function push(evt: AgentSseEvent): void {
    if (!shouldCoalesce(evt)) {
      // 先让缓冲里的文字帧落地，再放这一帧 —— 非并批帧绝不能插到它们前面。
      flush()
      applyNow(evt)
      return
    }
    const t = now()
    if (queue.length === 0 && t - lastAppliedAt >= windowMs) {
      // leading edge：距离上次渲染已出一个窗口，立即落地（首字零延迟）。
      applyNow(evt)
      return
    }
    queue.push(evt)
    if (timer === null) {
      // 窗口按「距上次渲染的剩余时间」补齐，而不是每帧重开一个整窗口。
      const delay = Math.max(0, windowMs - (t - lastAppliedAt))
      timer = schedule(() => {
        timer = null
        flush()
      }, delay)
    }
  }

  function drop(): void {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
    queue = []
    // 归零时间锚：换了一条生命，新生命的第一条 delta 该立刻见字。
    lastAppliedAt = Number.NEGATIVE_INFINITY
  }

  return { push, flush, drop, pendingCount: () => queue.length }
}
