// internal-waiters.ts — 进程内「长挂起」waiter 注册表（WP2 网关侧，2026-10-14）。
//
// 目的：把工具端对两个内部端点的**固定轮询**（subagent 4s、confirm 2s）换成事件驱动
// 即时返回。端点收到可选 body 栏位 `wait_ms`（0～60000，缺省 0）> 0 且当前非终态时，
// handler 在此登记一个 waiter，由**状态落定点** notify 唤醒；等满 wait_ms 则超时返回。
//
// 契约（极小、无依赖、纯进程内）：
//   register(key) -> Promise<void>   登记一个 waiter，状态变化时由 notify 解析。
//   notify(key)   -> void            状态落定点调用；无 waiter 时 no-op。
//
// 语义保证：
//   - notify 是**广播**：同一 key 的所有等待者一起解析（同一 run／confirm 可能被多个在途
//     轮询同时挂着）。
//   - notify 只负责「叫醒」；**状态本身必须由 handler 重新读一次**（本模组不携带任何状态，
//     避免把「已变更」误当成「值是什么」）。
//   - waiter 不会永久泄漏：handler 用 waitFor() 的 AbortController 在超时/竞态后注销自己。
//   - key 必须含 request_id / subagent_id 避碰（同一会话可能有多笔在途 confirm / 多个 run）。

type Resolver = () => void

const waiters = new Map<string, Set<Resolver>>()

/** 登记一个 waiter；回传的 promise 在 notify(key) 或 signal abort 时解析。不 reject。 */
export function register(key: string, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    let set = waiters.get(key)
    if (!set) {
      set = new Set()
      waiters.set(key, set)
    }
    const bucket = set
    const done = () => {
      bucket.delete(done)
      if (bucket.size === 0 && waiters.get(key) === bucket) waiters.delete(key)
      resolve()
    }
    bucket.add(done)
    if (signal) signal.addEventListener("abort", done, { once: true })
  })
}

/** 状态落定点：叫醒该 key 下所有 waiter。无 waiter 时 no-op。 */
export function notify(key: string): void {
  const set = waiters.get(key)
  if (!set) return
  // 复制一份再迭代——done() 会就地删除自己。
  for (const done of [...set]) done()
}

/** 解析 body.wait_ms：非法/负/非数字 → 0（＝现行为）；上限 60000ms。 */
export function parseWaitMs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 0
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.floor(n), 60_000)
}

/**
 * handler 侧便捷封装：race(register(key), sleep(wait_ms))。返回后 handler **必须重新读一次
 * 真实状态**再回传（本函式不携带状态）。wait_ms<=0 时立即返回（零回归）。
 * 竞态结束后 abort 注销自身 waiter、并 clearTimeout 尚未到点的 sleep timer（不留空转 timer）。
 */
export async function waitFor(key: string, waitMs: number): Promise<void> {
  if (waitMs <= 0) return
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const sleepP = new Promise<void>((r) => {
    timer = setTimeout(r, waitMs)
  })
  await Promise.race([register(key, ctrl.signal), sleepP])
  if (timer !== undefined) clearTimeout(timer)
  ctrl.abort()
}
