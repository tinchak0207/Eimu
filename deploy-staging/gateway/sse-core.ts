// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave1）：SSE 核心——serializeSse/isRevivalFrame/emitToSession（含 critic 逃生閥掃描）/N2 stripStaleTurnTextFromReplay/closeSessionStreams，
// 原 index.ts 1251–1376 行；openEventStream 原 index.ts 2668–2707 行。
import type { SessionState, SSEClient } from "./types-gateway.ts"
import { REPLAY_BUFFER_SIZE } from "./constants-gateway.ts"
import { declaresUnreviewed } from "./delivery-gate"
import { markDirty } from "./sessions-core.ts"
import { encoder, corsOriginFor, corsHeaders } from "./auth-gw.ts"
import { trackTurnNodeTerminal } from "./events-translate.ts"
import { markTurnFirst } from "./metrics-gw.ts"
import { appendReplayFrame, MergedReplayFrame, isStrippableReplayEntry } from "./replay-frame.ts"
import { finishTurnMetrics } from "./metrics-gw.ts"
import { hydratePendingQuestions } from "./questions-gw.ts"
import { sessionUserScript } from "./outbound-sanitize.ts"
// TODO(整合)：以下符號仍住 index.ts 且未 export（本任務禁改 index.ts；bun build 對未 export 的 named import 報錯，已實測 2026-09-19）。
// 依第一階段 subagent 佔位符法（記憶 gateway-index-refactor-stage1-0919）：declare 佔位可過 bun build；整合 subagent 統一換真 import 或於 index.ts 補 export。
// ---- SSE helpers (gateway -> frontend) ----

export function serializeSse(name: string, data: unknown, eventId: number): string {
  const payload = JSON.stringify({ ...(data as Record<string, unknown>), event_id: eventId })
  return `id: ${eventId}\nevent: ${name}\ndata: ${payload}\n\n`
}

/** 修 1（2026-09-01）：內容/產物幀 = 殭屍还魂的證據。watchdog 死亡宣告後，
 *  這些幀到達說明重投 retry 真的在產出——「後端無響應」是誤判，必須撤回。 */
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
  // 修 1（2026-09-01）：死亡宣告可撤回。deathDeclared 期間第一條內容幀到達
  // → 先發一次性撤回幀（turn.status，與 watchdog 告警同通道，前端零改動），
  // 立即清位（防重複撤回/防遞歸），再放行原內容幀。
  if (state.deathDeclared && isRevivalFrame(name)) {
    state.deathDeclared = false
    console.log(`[gateway] death declaration retracted: revival frame ${name} arrived — session=${state.sessionId}`)
    // 2026-10-04 T2 語言鏡像：撤回宣告屬守衛家族固定文案，依會話黏性書寫體出對應版本。
    emitToSession(state, "turn.status", {
      text:
        sessionUserScript(state) === "hant"
          ? "剛才的「後端無回應」是誤判，任務已自動恢復，請繼續等待本輪結果"
          : "刚才的「后端无响应」是误判，任务已自动恢复，请继续等待本轮结果",
    })
  }
  // Agent-produced output counts as activity: a long generate with no client
  // polling must not look idle to the reaper while it is still working.
  state.lastActivityAt = Date.now()
  if (name === "subagent.started") state.turnSubagentStarts = (state.turnSubagentStarts ?? 0) + 1
  // R4-A S3①：turn 進度打點——錯誤停滯看門狗判定「錯誤後 turn 是否還活著」
  // 的依據。只認模型/工具幀（正文、工具出入參）；canvas 等狀態幀不算進度。
  if (name === "message.delta" || name === "reasoning.delta" || name === "tool.invoke" || name === "tool.result") {
    state.turnProgressAt = Date.now()
  }
  // R5-C 中段停滯哨：任何幀都算「還活著」的證據（canvas/confirm 狀態幀也算
  // ——只對連幀都沒有的凍結告警，長工具執行有進度幀就不誤殺）。
  state.turnLastFrameAt = Date.now()
  // 刀 2（2026-09-15）：機器 critic pass 逃生閥掃描。本輪正文出現「未經獨立審核」自簽聲明
  // （playbook 第一節末：critic 派遣失敗時允許自簽兜底且須註明）→ 本輪不觸發機器 pass。
  // 成本 O(增量)：只在未命中時拼 32 字滾動尾巴，命中即置位不再算。
  if (name === "message.delta" && state.criticUnreviewedDeclared !== true) {
    const dtxt = (data as { text?: unknown })?.text
    if (typeof dtxt === "string" && dtxt) {
      const tail = (state.criticEscapeTail ?? "") + dtxt
      if (declaresUnreviewed(tail)) state.criticUnreviewedDeclared = true
      else state.criticEscapeTail = tail.slice(-32)
    }
  }
  // 刀 1（2026-09-19）：Jev 測謊閘餵料——本輪正文尾段累積（有界 4k，與
  // criticEscapeTail 同款 O(增量)；session.idle 收盤消費後清空）。
  if (name === "message.delta") {
    const dtxt = (data as { text?: unknown })?.text
    if (typeof dtxt === "string" && dtxt) {
      state.jevBriefTail = ((state.jevBriefTail ?? "") + dtxt).slice(-4000)
    }
  }
  // R4-A S8：本 turn 內到達終態的節點採集——中央出口掛鉤，service.emit 與
  // 直接 emit 兩條 canvas.node.updated 路徑（成功+失敗）全收，兼容兩種載荷形狀。
  if (name === "canvas.node.updated") trackTurnNodeTerminal(state, data)
  state.eventCounter += 1
  const frame = encoder.encode(serializeSse(name, data, state.eventCounter))
  // 2026-10-02：只有模型產生的文字幀可被 N2 strip 剝除（見 stripStaleTurnTextFromReplay）。
  // 網關主動發出的 message.delta（工作流終態通報、進度匯報、誠實收尾等）默認耐久，
  // 必須能被晚重連的 client 取回——它們只是與模型正文共用事件名，不是模型輸出。
  // reasoning.delta 只可能來自模型，維持可剝。
  const strippable = opts?.strippable ?? name === "reasoning.delta"
  // 2026-10-01：文字幀在 replay 層合併（見 replay-frame.ts），直播仍逐幀。
  appendReplayFrame(state.replayBuffer, name, data, state.eventCounter, frame, strippable)
  if (state.replayBuffer.length > REPLAY_BUFFER_SIZE) {
    state.replayBuffer.splice(0, state.replayBuffer.length - REPLAY_BUFFER_SIZE)
  }
  markDirty(state) // 防抖落盤：重啟後 replayBuffer 可供前端 Last-Event-ID 續傳
  for (const client of state.clients) {
    try {
      client.controller.enqueue(frame)
    } catch {
      state.clients.delete(client)
    }
  }
  // ── Phase 0 觀測（2026-09-18）：首幀打點 + 收檔 ──────────────────────
  // 幀名唯一性：reasoning.delta / tool.invoke 只有模型路徑會發；message.delta
  // 另有非模型出口（「文件已找到」提示等），故正文首幀改在 emitSanitizedDelta
  // 內打點，不在此處。放在幀入列之後＝t_done 為 turn.done 實際送出時刻。
  if (state.turnMetrics) {
    if (name === "reasoning.delta") markTurnFirst(state, "reasoning")
    else if (name === "tool.invoke") markTurnFirst(state, "tool")
    else if (name === "turn.done") finishTurnMetrics(state, "done")
  }
}

// ── N2（2026-08-27）：turn 重試不重放舊 turn 的文本幀 ──
// 根因（複測實錘 17:43:02）：watchdog/抖動重試重發 prompt 後，opencode 把
// 舊 turn 的 message.part.updated 全量補發（part.text 是累積全文），delta
// 路徑的 partTextEmitted 在 session.idle 已被清空 → 前綴當「新後綴」全部
// 重發，且這些重放幀進了 replayBuffer——SSE 斷線重連（Last-Event-ID）時
// 又整段重放一次（event 101-108+ 閃回）。
// 修法：重投 prompt 成功後，把 replayBuffer 裡本輪 gen 標記之前的
// **模型** message.delta / reasoning.delta 文本幀過濾掉（保留 canvas.* /
// confirm.* / tool.* / quota.* 等狀態類事件——它們冪等且前端靠它們恢復畫布），
// 並同步 persist 的 DB 行。新 turn 的文本從零開始計，斷線重連不會再看到舊文案。
// 2026-10-02：網關主動發出的耐久幀（strippable=false，工作流終態通報等）不剝
// ——它們與模型正文共用事件名，但不是模型輸出；剝掉就等於用「防重放」誤殺通報
//（wf_muqfkhw7_1 事故根因）。判定收在 replay-frame.isStrippableReplayEntry（純函數）。
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
            // Last-Event-ID 落在合併段中間 → 只補其後的段，不重字。
            if (frame instanceof MergedReplayFrame && frame.firstId <= lastEventId) {
              controller.enqueue(frame.suffixFrame(lastEventId))
            } else {
              controller.enqueue(frame.frame.slice())
            }
          }
        }
      }
      // R4-A S3②：重啟恢復時暫存的中斷告知——SSE 接入即補投（一次性）。
      // R4 實錘：恢復瞬間無人在線，告知幀憑空蒸發，用戶視角「說了話，它死了」。
      const pendingNotice = state.pendingRestoreNotice
      if (pendingNotice) {
        state.pendingRestoreNotice = undefined
        emitToSession(state, "message.delta", { text: pendingNotice.text })
        // R9-4：restore 路徑與 question 凍結語義對齊——pending 期間不發 turn.done。
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

