// 從 index.ts 無損抽取（2026-09-19 第一階段）：Sessions HTTP 業務區段。
// 遷出區間：原 index.ts 4928–4972（L0 畫像 onboarding＋S7 用戶級 Settings）、
// 6320–6365（handleGetSession）、6371–6503（P1-E1 歷史讀取輔助＋handleGetSessionMessages）。
// 依賴說明：
//  - jsonError：import 自 ./gw-lib.ts
//  - loadUserSettings：import 自 ./persistence（照抄 index.ts 頭部 import 符號）
//  - gzipSync：import 自 node:zlib（照抄 index.ts 頭部 import 語句）
//  - SessionState：TODO types-gateway.ts 未建（B 路任務），整合時改
//    `import type { SessionState } from "./types-gateway.ts"`；本檔先以結構佔位型別（只用 apiKey）
//  - getOwnedSession / opencodeHeaders / OPENCODE_URL / TAIL_PAYLOAD_MARKER：仍定義在
//    index.ts（≈1352/1119/462/5394 行），以 declare 佔位（bun build 只轉譯不查名），
//    整合階段接線時替換為正式 import
import { gzipSync } from "node:zlib"
import { loadUserSettings } from "./persistence"
import { jsonError } from "./gw-lib.ts"
import type { SessionState } from "./types-gateway.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { TAIL_PAYLOAD_MARKER } from "./messages-gw.ts"
import { opencodeFetch } from "./opencode-client.ts"

// L0 畫像 onboarding：賬戶還沒有任何確認過的畫像時，引導 agent 用 question 工具
// 以選擇題採集畫像（PM 原則：別讓用戶動腦寫表單）。答案存 pendingProfile，
// 下次建會話時作為臨時畫像注入（站點 DB 落庫前的過渡方案）。
export const PROFILE_ONBOARDING_DIRECTIVE = [
  "這個賬戶還沒有畫像記錄。開場簡短歡迎一句，先問用戶今天想做什麼。",
  "畫像信息（行業/常做素材/風格偏好）在對話中自然了解即可，不要用 question 工具刻意採集，更不要一次問多道題。",
  "若用戶直接說出任務，直接開工，別問畫像。",
].join("\n")

// ── S7（2026-08-29）：用戶級 Settings（罪狀6 網關側真實 Adapt）─────────────
// 存 sessions.db user_settings 表（key 維度，owner_key 與 sessions 表同一 key、
// 同一歸一化方式），重啟不丟。GET 無記錄回默認值；POST 部分更新、非法值 400。
// Adapt 兩條腿：
//   1. system 指令：persona/cost_mode 每輪注入 promptBody.system（不是只首輪；
//      balanced 不注入成本線）。
//   2. 等待容忍窗：persona=thoughtful 時 ack/心跳延遲 ×1.5（思考本來就久，
//      30s 就說「收到」是騷擾）；實現為投遞時按 settings 計算延遲，不改全局常量。
// 模型思考強度（cost_mode → 真實模型切換）本期不落地，如實原因見任務報告：
// opencode.jsonc 無第二個可用模型、有效配置 small_model 與主模型相同
// （b-ai/glm-5.3-flash），PATCH /session/:id 200 但 model 無落地證據。
const DEFAULT_USER_SETTINGS: UserSettingsShape = { interrupt_mode: "steer", persona: "efficient", cost_mode: "balanced", interaction_mode: "preset" }
// 野獸模式開關（MOE 改革，2026-09-08）：settings 布林欄，缺省=false（零回歸）。
// 不入 USER_SETTINGS_ENUMS（那是枚舉字串欄白名單）；POST 專門放行本欄（僅接受
// 真布林），sanitize 顯式列出欄位、缺欄=保持現值。
export type UserSettingsShape = { interrupt_mode: string; persona: string; cost_mode: string; interaction_mode: string; beast_mode?: boolean }
export const USER_SETTINGS_ENUMS: Record<Exclude<keyof UserSettingsShape, "beast_mode">, readonly string[]> = {
  interrupt_mode: ["steer", "queue"],
  persona: ["efficient", "thoughtful"],
  cost_mode: ["economy", "balanced", "premium"],
  interaction_mode: ["collaborate", "preset", "auto"],
}

/** 任意輸入 → 合法 settings（非法欄位值一律回落默認，寫入路徑另有 400 校驗）。 */
export function normalizeUserSettings(raw: unknown): UserSettingsShape {
  const s: UserSettingsShape = { ...DEFAULT_USER_SETTINGS }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    for (const k of Object.keys(USER_SETTINGS_ENUMS) as Exclude<keyof UserSettingsShape, "beast_mode">[]) {
      const v = r[k]
      if (typeof v === "string" && USER_SETTINGS_ENUMS[k].includes(v)) s[k] = v
    }
  }
  return s
}

/** 性格 → 等待容忍倍率：thoughtful ×1.5，efficient（及未知值）默認 1。 */
export function personaPatienceMul(state: SessionState): number {
  return loadUserSettings(state.apiKey)?.persona === "thoughtful" ? 1.5 : 1
}

// GET /agent/v1/sessions/:id — 會話恢復端點（重啟後歷史仍在的讀取路徑）。
// 歷史從 opencode（權威存儲）讀取；getOwnedSession 內含 DB lazy reload，
// 因此進程重啟後仍可解析。只讀，不改任何狀態、不動 CORS/SSE/ticket 行為。
export async function handleGetSession(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  try {
    const res = await opencodeFetch(`/session/${state.opencodeSessionId}/message`, {
      timeoutMs: 15_000,
    })
    if (!res.ok) {
      // upstream opencode session 已不在（被外部清理等）：仍回會話元數據，標記歷史不可用。
      return Response.json({
        session_id: id,
        opencode_session_id: state.opencodeSessionId,
        history_available: false,
        message_count: 0,
        messages: [],
      })
    }
    const msgs = (await res.json()) as Array<{
      info?: { role?: string; time?: { created?: number } }
      parts?: Array<{ type?: string; text?: string }>
    }>
    const messages = (Array.isArray(msgs) ? msgs : []).map((m) => ({
      role: m.info?.role ?? "unknown",
      created_at: m.info?.time?.created ?? null,
      text: (m.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .slice(0, 20_000),
      has_tool_parts: (m.parts ?? []).some((p) => p.type === "tool"),
    }))
    return Response.json({
      session_id: id,
      opencode_session_id: state.opencodeSessionId,
      history_available: true,
      message_count: messages.length,
      messages,
    })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
}

// P1-E1：對話 transcript 端點。真源是 opencode（gateway 不另存 messages，
// 見 L3496 註釋——那是第二份會漂移的歷史副本）。返回輕量結構：每條 message
// 只保留 role + text/tool parts，tool part 帶完整 input（prompt/lora/model/
// size 在此），供前端「存為資產」提取真配方。輸出/圖片等重 payload 一律不帶。
// GET /agent/v1/sessions/:id/messages — 全量歷史端點（2026-09-12 永久保留改造）。
// 鑑權與 GET /agent/v1/sessions/:id 完全同構：Bearer 閘門 + getOwnedSession（owner 校驗 +
// DB lazy hydrate，reaped/重啟後的 row 可讀）。返回帶游標的物件（前端契約）：
//   { messages: <opencode 消息瘦身陣列（同構 [{info,parts}]，欄位白名單）>, event_counter: <當前計數器>,
//     replay_first_id: <replayBuffer 最舊幀 id，無緩衝則 null> }
// event_counter 給前端做 SSE 續傳游標：restore 全史後 openConnection(counter) 只接增量。
// 上游不可達/非 2xx/會話無 messages → 200 且附 fallback:"replay_only"（前端退回回放兜底）。
// 瘦身：前端唯一消費者 normalizeOpenCodeMessages 只讀 info.role + text/reasoning/tool/file
// 四类 part 的少數欄位（實測 tool.state.output/metadata 與 info 冗餘欄位佔 payload ~80%），
// 白名單外欄位一率刪除；輸出保持 [{info,parts}] 同構契約，未知 part 型別整塊丟棄。
// 防呆：讀路徑寧跳不炸——任何單則/單 part 處理異常只丟棄該項，函數永不拋錯。
/** 0918：剝掉網關注入的 user 訊息尾端 payload（野獸幀等，見
 *  appendSystemPayloadToTurnTail）。只用在顯示讀路徑（slimHistoryMessages）；
 *  模型上下文由 opencode 持有、不經此函式，故不影響模型看到的內容。
 *  找不到標記＝原樣返回（零回歸）。 */
function stripTailInjectedPayload(text: string): string {
  const marker = TAIL_PAYLOAD_MARKER.trim()
  const i = text.indexOf(marker)
  return i >= 0 ? text.slice(0, i).trimEnd() : text
}

function slimHistoryMessages(msgs: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const rawMsg of msgs) {
    try {
      if (rawMsg === null || typeof rawMsg !== "object" || Array.isArray(rawMsg)) continue
      const msg = rawMsg as Record<string, unknown>
      const infoSrc = msg.info !== null && typeof msg.info === "object" && !Array.isArray(msg.info)
        ? (msg.info as Record<string, unknown>)
        : null
      const info: Record<string, unknown> = {}
      if (infoSrc) {
        if (typeof infoSrc.id === "string") info.id = infoSrc.id
        if (typeof infoSrc.role === "string") info.role = infoSrc.role
      }
      const partsSrc = Array.isArray(msg.parts) ? (msg.parts as unknown[]) : []
      const parts: unknown[] = []
      for (const rawPart of partsSrc) {
        try {
          if (rawPart === null || typeof rawPart !== "object" || Array.isArray(rawPart)) continue
          const part = rawPart as Record<string, unknown>
          const type = part.type
          if (type === "text" || type === "reasoning") {
            // 0918：歷史端點是「顯示」通道——剝掉網關附在 user 訊息尾端的注入
            // payload（野獸幀等，見 appendSystemPayloadToTurnTail），否則用戶
            // 氣泡會被 17.2k 字的派遣協議正文灌爆。模型上下文由 opencode 持有、
            // 不經本函式，故剝除不改變模型看到的內容（純顯示層過濾）。
            if (type === "text" && info.role === "user" && typeof part.text === "string") {
              parts.push({ ...part, text: stripTailInjectedPayload(part.text) })
              continue
            }
            parts.push(part)
            continue
          }
          if (type === "file") {
            const f: Record<string, unknown> = { type: "file" }
            for (const k of ["url", "mime", "filename", "size"] as const) {
              if (part[k] !== undefined) f[k] = part[k]
            }
            parts.push(f)
            continue
          }
          if (type === "tool") {
            const stSrc = part.state !== null && typeof part.state === "object" && !Array.isArray(part.state)
              ? (part.state as Record<string, unknown>)
              : null
            const st: Record<string, unknown> = {}
            if (stSrc) {
              if (stSrc.status !== undefined) st.status = stSrc.status
              if (stSrc.input !== undefined) {
                let s: string
                try {
                  s = typeof stSrc.input === "string" ? stSrc.input : JSON.stringify(stSrc.input)
                } catch {
                  s = ""
                }
                if (s.length > 500) s = s.slice(0, 500)
                st.input = s
              }
              if (typeof stSrc.error === "string") {
                if (stSrc.error.length > 0) st.error = stSrc.error
              } else if (stSrc.error !== null && typeof stSrc.error === "object" && !Array.isArray(stSrc.error)) {
                const em = (stSrc.error as Record<string, unknown>).message
                if (typeof em === "string") st.error = { message: em }
              }
            }
            const tool: Record<string, unknown> = { type: "tool", state: st }
            const name = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : undefined
            if (name !== undefined) tool.tool = name
            parts.push(tool)
            continue
          }
          // step-start / step-finish / compaction / patch / snapshot / 未知型別：丟棄。
        } catch { /* 單 part 壞數據：跳過 */ }
      }
      out.push({ info, parts })
    } catch { /* 單則壞數據：跳過 */ }
  }
  return out
}

export async function handleGetSessionMessages(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const cursor = {
    event_counter: state.eventCounter,
    replay_first_id: state.replayBuffer.length > 0 ? state.replayBuffer[0].id : null,
  }
  try {
    const res = await opencodeFetch(`/session/${state.opencodeSessionId}/message`, {
      timeoutMs: 30_000,
    })
    if (!res.ok) {
      return Response.json({ messages: [], ...cursor, fallback: "replay_only" })
    }
    const msgs: unknown = await res.json()
    if (!Array.isArray(msgs) || msgs.length === 0) {
      return Response.json({ messages: [], ...cursor, fallback: "replay_only" })
    }
    // 成功路徑體積大（實測單會話 452KB），瘦身後再 gzip 傳輸；降級路徑體積小維持原樣。
    const payload = { messages: slimHistoryMessages(msgs), ...cursor }
    return new Response(gzipSync(Buffer.from(JSON.stringify(payload))), {
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    })
  } catch {
    return Response.json({ messages: [], ...cursor, fallback: "replay_only" })
  }
}
