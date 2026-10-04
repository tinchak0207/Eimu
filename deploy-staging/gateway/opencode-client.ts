// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave1）：opencode client——opencodeHeaders/会话摘要标题链 fetchOpencodeTitle/scheduleTitleFetch（原 index.ts 431–497 行）＋connectOpencode 全局 SSE 读循环（原 index.ts 4087–4137 行）。
import { OPENCODE_PASSWORD, OPENCODE_URL } from "./constants-gateway.ts"
import { sleep } from "./gw-lib.ts"
import type { SessionState } from "./types-gateway.ts"
import { sessions, markDirty } from "./sessions-core.ts"
import { handleOpencodeEvent } from "./opencode-event-handler.ts"
// TODO(整合)：以下符号仍住 index.ts 且未 export（本任务禁改 index.ts；bun build 对未 export 的 named import 报错，已实测 2026-09-19）。
// 依第一阶段 subagent 占位符法（记忆 gateway-index-refactor-stage1-0919）：declare 占位可过 bun build；整合 subagent 统一换真 import 或于 index.ts 补 export。
// ---- opencode client helpers ----

export function opencodeHeaders(): Record<string, string> {
  return {
    Authorization: "Basic " + btoa("opencode:" + OPENCODE_PASSWORD),
    "Content-Type": "application/json",
  }
}

// 呼叫层统一入口（2026-09-20 接缝收口）：拼 OPENCODE_URL + opencodeHeaders + 预设
// 30s timeout（timeoutMs 可逐点覆盖，各呼叫点原 timeout 值逐点保留）。仅替代
// 拼URL/headers/timeout 三件事；res.ok 判定与错误处理结构仍由呼叫端持有。
export async function opencodeFetch(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs = 30000, ...rest } = init ?? {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(`${OPENCODE_URL}${path}`, {
      ...rest,
      headers: opencodeHeaders(),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

// opencodeFetch + res.ok 检查（!ok 抛错，讯息带 status 与 path）+ res.json()。
export async function opencodeJson<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await opencodeFetch(path, init)
  if (!res.ok) throw new Error(`opencode ${path} failed: HTTP ${res.status}`)
  return (await res.json()) as T
}

// ── 重试前撤死尾（2026-10-01 重复 user 讯息事故）─────────────────────
// 重试出口（failover/jitter/watchdog/midturn-stall/idle-step）用 prompt_async 重投时，
// opencode 会「新增」一条 user 讯息，上一次失败的那条（及其后零产出的 assistant）仍留在
// 历史里：E2E 实锤续写提示 2s 内叠两条、零正文抖动重投 40s 内同一 user 讯息叠 5 条。
// 修法：重投前找最后一条 user 讯息 U；U 之后的 assistant 全部零产出（无非空 text、
// 无 tool、无其他未知 part；reasoning/step-start/step-finish/retry 不算产出）→
// POST /session/{id}/revert {messageID: U}，opencode 于下一次 prompt 时 cleanup 掉
// U 与其后全部讯息（2026-10-01 一次性会话实测 /message 与 /prompt_async 两路皆生效）。
// U 之后已有产出（工具已跑/正文已出）→ 不动（保留部分输出，续写提示接在其后）。
// 全程短 timeout；任何失败回 false 只记 log，绝不挡重试（失败＝退回原行为）。
const DEAD_TAIL_NON_OUTPUT_PARTS = new Set(["reasoning", "step-start", "step-finish", "retry"])
export async function revertDeadTail(opencodeSessionId: string): Promise<boolean> {
  if (!opencodeSessionId) return false
  const sid = encodeURIComponent(opencodeSessionId)
  try {
    const res = await opencodeFetch(`/session/${sid}/message?limit=30`, { timeoutMs: 5000 })
    if (!res.ok) {
      console.log(`[gateway] revertDeadTail: list messages HTTP ${res.status} — oc=${opencodeSessionId}`)
      return false
    }
    type OcPart = { type?: string; text?: string }
    type OcMsg = { info?: { id?: string; role?: string }; parts?: OcPart[] }
    const msgs = (await res.json().catch(() => null)) as OcMsg[] | null
    if (!Array.isArray(msgs) || msgs.length === 0) return false
    let ui = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.info?.role === "user") {
        ui = i
        break
      }
    }
    if (ui < 0) return false // 窗口内无 user（尾部 assistant 过长）＝必有产出，不动
    const u = msgs[ui]
    const uid = u.info?.id
    if (!uid) return false
    // compaction 摘要触发讯息不撤（撤了等于丢压缩）。
    if ((u.parts ?? []).some((p) => p?.type === "compaction")) return false
    for (const m of msgs.slice(ui + 1)) {
      for (const p of m.parts ?? []) {
        const t = p?.type ?? ""
        if (t === "text") {
          if ((p.text ?? "").trim()) return false
          continue
        }
        if (DEAD_TAIL_NON_OUTPUT_PARTS.has(t)) continue
        return false // tool / patch / file / 未知类型一律视为产出
      }
    }
    const rv = await opencodeFetch(`/session/${sid}/revert`, {
      method: "POST",
      body: JSON.stringify({ messageID: uid }),
      timeoutMs: 5000,
    })
    if (!rv.ok) {
      console.log(`[gateway] revertDeadTail: revert HTTP ${rv.status} — oc=${opencodeSessionId} msg=${uid}`)
      return false
    }
    console.log(
      `[gateway] revertDeadTail: reverted dead tail (user msg + ${msgs.length - ui - 1} empty assistant) — oc=${opencodeSessionId} msg=${uid}`,
    )
    return true
  } catch (e) {
    console.log(`[gateway] revertDeadTail failed (ignored) — oc=${opencodeSessionId}: ${e}`)
    return false
  }
}

// ── 会话摘要标题（2026-09-12）────────────────────────────────────
// opencode 在首条用户消息后异步生成 session.title（真会话实测「戴帽橘猫水彩插画」
// 级别；零消息会话是 "New session - <时间戳>" 占位）。网关读轮子不造轮子：
// 抓取、占位归一化、落盘都在这一条链，目录端点透传 title 供前端历史清单显示。
export async function fetchOpencodeTitle(opencodeSessionId: string): Promise<string | null> {
  if (!opencodeSessionId) return null
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${encodeURIComponent(opencodeSessionId)}`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as { title?: unknown } | null
    const t = json?.title
    if (typeof t !== "string") return null
    const trimmed = t.trim()
    if (!trimmed) return null
    // 占位标题归一化的全网关唯一判定点：idle 钩子与目录回填共用此函数。
    if (trimmed.startsWith("New session -")) return null
    return trimmed
  } catch {
    return null // 404/网路错/超时一律 null，呼叫端静默降级
  }
}

// session.idle 正常收尾路径挂钩：起一次性重试链（2s→8s→20s）抓标题，拿到即停
// 并 markDirty 随防抖落盘。question-pending 冻结分支不挂（turn 未结束，标题多半
// 未生成，下一轮 idle 自然补）。僵尸安全：回调先查 state 仍是 map 中现役物件
// 才写标记（flushDirtySessions 对不在 map 的 id 本就静默跳过，双保险）。
export function scheduleTitleFetch(state: SessionState): void {
  if (state.sessionTitle) return
  // 幂等重建：每次 idle 重排一条新链（先清旧残留计时器，任何时刻至多 3 个在飞）。
  if (state.titleFetchTimers) {
    for (const t of state.titleFetchTimers) clearTimeout(t)
  }
  const timers: ReturnType<typeof setTimeout>[] = []
  state.titleFetchTimers = timers
  for (const delay of [2000, 8000, 20000]) {
    timers.push(
      setTimeout(() => {
        void (async () => {
          try {
            if (state.sessionTitle) return // 更早结果已填上
            if (sessions.get(state.sessionId) !== state) return // 会话已拆除/被新状态替换
            const title = await fetchOpencodeTitle(state.opencodeSessionId)
            if (!title) return
            if (state.sessionTitle) return
            if (sessions.get(state.sessionId) !== state) return
            state.sessionTitle = title
            markDirty(state)
          } catch {
            // 静默：抓不到标题只影响显示，绝不打扰会话主链
          }
        })()
      }, delay),
    )
  }
}
// opencode /event 每 ~10s 发一次 server.heartbeat（2026-09-28 实测 75s 内 7 次）。
// 30s 收不到任何位元组＝连线已死（opencode-server 重启后的半开 socket），主动 abort 重连。
// 没有这道看门狗时要等 Bun fetch 预设逾时：journal 09-28 06:37:26 断线 → 06:42:28 才
// TimeoutError 重连，5 分钟盲窗内所有 delta 全丢——这就是「只重启 opencode-server
// 会让网关 SSE 悬挂数分钟」的根因，修掉后两个服务不必再绑在一起重启。
const OPENCODE_SSE_IDLE_MS = 30_000
export function connectOpencode(): void {
  const url = `${OPENCODE_URL}/event`
  void (async () => {
    while (true) {
      const controller = new AbortController()
      let lastByteAt = Date.now()
      const watchdog = setInterval(() => {
        if (Date.now() - lastByteAt > OPENCODE_SSE_IDLE_MS) {
          console.error(`[gateway] opencode SSE idle > ${OPENCODE_SSE_IDLE_MS}ms, reconnecting`)
          controller.abort()
        }
      }, 5_000)
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: "Basic " + btoa("opencode:" + OPENCODE_PASSWORD),
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          console.error(`[gateway] opencode SSE connect failed: status=${res.status}`)
          await sleep(2000)
          continue
        }
        console.log(`[gateway] opencode SSE connected: ${url}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          lastByteAt = Date.now()
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
          let sep: number
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            let dataStr = ""
            for (const line of chunk.split("\n")) {
              const t = line.trim()
              if (t.startsWith("data:")) {
                dataStr += (dataStr ? "\n" : "") + t.slice(5).replace(/^ /, "")
              }
            }
            if (!dataStr || dataStr === "[DONE]") continue
            try {
              handleOpencodeEvent(JSON.parse(dataStr))
            } catch {
              // malformed event, skip
            }
          }
        }
        console.error(`[gateway] opencode SSE stream ended`)
      } catch (e) {
        console.error(`[gateway] opencode SSE error: ${e}`)
      } finally {
        clearInterval(watchdog)
      }
      await sleep(2000)
    }
  })()
}
