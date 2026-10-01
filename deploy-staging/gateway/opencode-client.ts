// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave1）：opencode client——opencodeHeaders/會話摘要標題鏈 fetchOpencodeTitle/scheduleTitleFetch（原 index.ts 431–497 行）＋connectOpencode 全局 SSE 讀循環（原 index.ts 4087–4137 行）。
import { OPENCODE_PASSWORD, OPENCODE_URL } from "./constants-gateway.ts"
import { sleep } from "./gw-lib.ts"
import type { SessionState } from "./types-gateway.ts"
import { sessions, markDirty } from "./sessions-core.ts"
import { handleOpencodeEvent } from "./opencode-event-handler.ts"
// TODO(整合)：以下符號仍住 index.ts 且未 export（本任務禁改 index.ts；bun build 對未 export 的 named import 報錯，已實測 2026-09-19）。
// 依第一階段 subagent 佔位符法（記憶 gateway-index-refactor-stage1-0919）：declare 佔位可過 bun build；整合 subagent 統一換真 import 或於 index.ts 補 export。
// ---- opencode client helpers ----

export function opencodeHeaders(): Record<string, string> {
  return {
    Authorization: "Basic " + btoa("opencode:" + OPENCODE_PASSWORD),
    "Content-Type": "application/json",
  }
}

// 呼叫層統一入口（2026-09-20 接縫收口）：拼 OPENCODE_URL + opencodeHeaders + 預設
// 30s timeout（timeoutMs 可逐點覆蓋，各呼叫點原 timeout 值逐點保留）。僅替代
// 拼URL/headers/timeout 三件事；res.ok 判定與錯誤處理結構仍由呼叫端持有。
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

// opencodeFetch + res.ok 檢查（!ok 拋錯，訊息帶 status 與 path）+ res.json()。
export async function opencodeJson<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await opencodeFetch(path, init)
  if (!res.ok) throw new Error(`opencode ${path} failed: HTTP ${res.status}`)
  return (await res.json()) as T
}

// ── 重試前撤死尾（2026-10-01 重複 user 訊息事故）─────────────────────
// 重試出口（failover/jitter/watchdog/midturn-stall/idle-step）用 prompt_async 重投時，
// opencode 會「新增」一條 user 訊息，上一次失敗的那條（及其後零產出的 assistant）仍留在
// 歷史裡：E2E 實錘續寫提示 2s 內疊兩條、零正文抖動重投 40s 內同一 user 訊息疊 5 條。
// 修法：重投前找最後一條 user 訊息 U；U 之後的 assistant 全部零產出（無非空 text、
// 無 tool、無其他未知 part；reasoning/step-start/step-finish/retry 不算產出）→
// POST /session/{id}/revert {messageID: U}，opencode 於下一次 prompt 時 cleanup 掉
// U 與其後全部訊息（2026-10-01 一次性會話實測 /message 與 /prompt_async 兩路皆生效）。
// U 之後已有產出（工具已跑/正文已出）→ 不動（保留部分輸出，續寫提示接在其後）。
// 全程短 timeout；任何失敗回 false 只記 log，絕不擋重試（失敗＝退回原行為）。
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
    if (ui < 0) return false // 窗口內無 user（尾部 assistant 過長）＝必有產出，不動
    const u = msgs[ui]
    const uid = u.info?.id
    if (!uid) return false
    // compaction 摘要觸發訊息不撤（撤了等於丟壓縮）。
    if ((u.parts ?? []).some((p) => p?.type === "compaction")) return false
    for (const m of msgs.slice(ui + 1)) {
      for (const p of m.parts ?? []) {
        const t = p?.type ?? ""
        if (t === "text") {
          if ((p.text ?? "").trim()) return false
          continue
        }
        if (DEAD_TAIL_NON_OUTPUT_PARTS.has(t)) continue
        return false // tool / patch / file / 未知類型一律視為產出
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

// ── 會話摘要標題（2026-09-12）────────────────────────────────────
// opencode 在首條用戶消息後異步生成 session.title（真會話實測「戴帽橘猫水彩插画」
// 級別；零消息會話是 "New session - <時間戳>" 佔位）。網關讀輪子不造輪子：
// 抓取、佔位歸一化、落盤都在這一条鏈，目錄端點透傳 title 供前端歷史清單顯示。
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
    // 佔位標題歸一化的全網關唯一判定點：idle 鉤子與目錄回填共用此函數。
    if (trimmed.startsWith("New session -")) return null
    return trimmed
  } catch {
    return null // 404/網路錯/超時一律 null，呼叫端靜默降級
  }
}

// session.idle 正常收尾路徑掛鉤：起一次性重試鏈（2s→8s→20s）抓標題，拿到即停
// 並 markDirty 隨防抖落盤。question-pending 凍結分支不掛（turn 未結束，標題多半
// 未生成，下一輪 idle 自然補）。殭屍安全：回調先查 state 仍是 map 中現役物件
// 才寫標記（flushDirtySessions 對不在 map 的 id 本就靜默跳過，雙保險）。
export function scheduleTitleFetch(state: SessionState): void {
  if (state.sessionTitle) return
  // 冪等重建：每次 idle 重排一條新鏈（先清舊殘留計時器，任何時刻至多 3 個在飛）。
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
            if (state.sessionTitle) return // 更早結果已填上
            if (sessions.get(state.sessionId) !== state) return // 會話已拆除/被新狀態替換
            const title = await fetchOpencodeTitle(state.opencodeSessionId)
            if (!title) return
            if (state.sessionTitle) return
            if (sessions.get(state.sessionId) !== state) return
            state.sessionTitle = title
            markDirty(state)
          } catch {
            // 靜默：抓不到標題只影響顯示，絕不打扰會話主鏈
          }
        })()
      }, delay),
    )
  }
}
// opencode /event 每 ~10s 發一次 server.heartbeat（2026-09-28 實測 75s 內 7 次）。
// 30s 收不到任何位元組＝連線已死（opencode-server 重啟後的半開 socket），主動 abort 重連。
// 沒有這道看門狗時要等 Bun fetch 預設逾時：journal 09-28 06:37:26 斷線 → 06:42:28 才
// TimeoutError 重連，5 分鐘盲窗內所有 delta 全丟——這就是「只重啟 opencode-server
// 會讓網關 SSE 懸掛數分鐘」的根因，修掉後兩個服務不必再綁在一起重啟。
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
