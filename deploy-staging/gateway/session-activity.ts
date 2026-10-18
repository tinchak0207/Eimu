// 会话活性时钟（2026-10-18）。
//
// 由来：网关重启时在途回合的计时器全部随进程消失，接管逻辑（sessions-core 的
// reconcileRestoredGatewayTurn）只能问 opencode「还忙吗」。opencode 一旦回到 busy 或
// 留下一条永不 completed 的 assistant 消息，接管就永远等下去——用户看到的是「运行中」，
// 平台既不告警也不交还，会话从此卡死（生产实测 5 个会话卡 2.4 小时，其中 3 个在
// opencode 里连一条消息都没有）。
//
// 本模块只提供两个纯计数事实，供接管判断「这一轮到底还有没有在动」：
//   ① 任何 opencode 事件到达的时间（含子代理会话）——有事件＝还活着；
//   ② 某父会话名下仍在跑的子代理路数——子代理在跑＝父回合合法地静默。
// 不做任何决定，也不发帧。

const lastOcEventAt = new Map<string, number>()
const MAX_TRACKED = 4000

/** 记录一次 opencode 事件（任意 type）。热路径：只写 Map，不读盘、不分配对象。 */
export function markOcActivity(opencodeSessionId: string | undefined | null): void {
  if (!opencodeSessionId) return
  lastOcEventAt.set(opencodeSessionId, Date.now())
  if (lastOcEventAt.size > MAX_TRACKED) {
    // 粗略修剪：删掉最早放进来的四分之一（Map 保持插入序）。
    let drop = Math.floor(MAX_TRACKED / 4)
    for (const key of lastOcEventAt.keys()) {
      lastOcEventAt.delete(key)
      if (--drop <= 0) break
    }
  }
}

/** 最近一次事件时间；0 = 本进程从未见过该会话的事件。 */
export function lastOcActivityAt(opencodeSessionId: string): number {
  return lastOcEventAt.get(opencodeSessionId) ?? 0
}

// 子代理存活数：真源是 subagent.ts 的 byParent 注册表，本模块只持有一个只读回调，
// 避免 sessions-core ↔ subagent 的直接 import 环。subagent.ts 在模块初始化时注册。
let liveCounter: ((parentGatewaySessionId: string) => number) | null = null

export function setLiveChildCounter(fn: (parentGatewaySessionId: string) => number): void {
  liveCounter = fn
}

/** 父会话名下仍在跑的子代理路数；未注册（如测试）时为 0。 */
export function liveChildCount(parentGatewaySessionId: string): number {
  try {
    return liveCounter ? liveCounter(parentGatewaySessionId) : 0
  } catch {
    return 0
  }
}
