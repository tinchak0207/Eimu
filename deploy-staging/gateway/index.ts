// 生產 gateway 唯一真源快照（2026-09-15 拉回，8306 行）。勿以 .gateway-work/ 下舊目錄為準（PRD D7）。
import { appendFile, mkdir, rm } from "node:fs/promises"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { gzipSync } from "node:zlib"
import path from "node:path"
import { resolveVideoPerSecond, WorkflowService } from "./workflow-service"
import { estimateTtsCoins } from "./pricing-and-validation"
import {
  getTimeline,
  applyOps,
  listVersions,
  diffVersions,
  restoreVersion,
  getLog,
  totalDurationSec,
  TimelineBlockedError,
  TimelineValidationError,
  TimelineNotFoundError,
  type TimelineOp,
} from "./timeline"
import { analyzeRhythm } from "./rhythm"
import { lintTimeline } from "./lint"
import { handleDirectorRoutes, setDirectorEmitter, setDirectorSessionResolver } from "./director"
import { analyzeMix, applyMix } from "./mix"
import { styleCatalog, subtitlesAss, findStylePreset, findTransitionPreset, STYLE_PRESETS } from "./style"
import { masterCheck, masterExport, MASTER_PRESETS, type MasterPresetId } from "./master"
import { compileShotPrompt, parseShotCandidate, shotOutputParams, type ShotJson } from "./video-prompt-schema"
import {
  initPersistence,
  saveSession,
  loadSessionById,
  loadSessionByOpencodeId,
  listSessionRows,
  deleteSessionRow,
  setRowTitle,
  hydrateRow,
  sweepStaleRows,
  loadUserSettings,
  saveUserSettings,
} from "./persistence"
import {
  initSubagent,
  subagentHandlesSession,
  subagentParentApiKey,
  handleSubagentEvent,
  handleSubagentDispatch,
  handleSubagentStatus,
} from "./subagent"
// ── PRD P0-4 全局記憶接線（2026-09-15，契約 MEMORY-INTERFACES.md §3.5/§4/§7/§8）──
// memory-gate/memory-batch/memory-recall 三模組已落位且邏輯凍結（單測 50 綠），本檔只 import 接線。
import {
  createMemoryBatch,
  signMemoryBytes,
  signEmptyMemoryBody,
  MEMORY_SIGNATURE_HEADER,
  type MemorySessionRecord,
} from "./memory-batch"
import {
  CorpusCache,
  recallTop,
  buildRecallQuery,
  renderRecallPrefix,
  type RecallableDoc,
} from "./memory-recall"

/**
 * agent-gateway — Bun TypeScript gateway between frontend clients and opencode serve.
 *
 * Port 8081. Public API is key-authenticated (Bearer sk-biz-*), validated against
 * the platform's OpenAI-compatible endpoint (cached 5 min). Internal API is
 * loopback-only and drives the billing confirmation flow.
 *
 * Connects once to opencode's global /event SSE stream and fans events out to the
 * matching frontend SSE streams, translating opencode event shapes into
 * frontend-friendly event names.
 */

// OpenCode 1.18.x /event payloads are loosely-typed JSON whose shape varies per
// event type. The old strict OpencodeEvent/OpencodePart interfaces encoded a
// guessed schema (part.toolName, part.state as a string, part.result) that does
// not match the wire format and is now dead. Translation uses `any`-shaped
// objects with safe optional access instead.

interface PendingConfirm {
  timer: ReturnType<typeof setTimeout>
  ledger?: { amount_coins: number; task_id?: string; model?: string }
}

interface PendingQuestion {
  requestId: string
  callId: string
  questions: Array<{
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
  }>
}

// Outcome of a confirm that is no longer pending. Kept around deliberately:
// the tool polls for the answer, so if a resolved request vanished from memory
// the poller's next tick would see "unknown" and read it as a denial —
// silently cancelling work the user had already approved.
type ConfirmOutcome = "approved" | "denied" | "expired"

interface ResolvedConfirm {
  outcome: ConfirmOutcome
  resolvedAt: number
}

interface SSEClient {
  controller: ReadableStreamDefaultController<Uint8Array>
}

/** 契約 §4 memory_docs 元素：AgentMemoryDoc 駝峰原樣的注入必需子集（repo 直送，欄位防呆讀取）。 */
interface MemoryDocLite {
  id?: string
  domain?: string
  slug?: string
  description?: string
  body?: string
  [k: string]: unknown
}

interface SessionState {
  sessionId: string
  apiKey: string
  opencodeSessionId: string
  clients: Set<SSEClient>
  pendingConfirms: Map<string, PendingConfirm>
  pendingQuestions: Map<string, PendingQuestion>
  resolvedConfirms: Map<string, ResolvedConfirm>
  eventCounter: number
  replayBuffer: { id: number; frame: Uint8Array }[]
  // Touched by every lookup and every emitted event; drives the idle reaper.
  lastActivityAt: number
  // Per-session translation state for the /event fan-out. All bounded below.
  partTextEmitted: Map<string, { emittedLen: number }>
  // S2b（2026-08-27）：出站文本內部框架段剝離器的逐 part 狀態
  //（pending = 扣住的未完成行；suppress = 正處於內部段中）。生命週期同
  // partTextEmitted：session.idle 時 flush 並清空。
  partStripState: Map<string, { pending: string; suppress: boolean }>
  announcedUrls: Set<string>
  toolStatusSeen: Set<string>
  toolInvokeSeen: Set<string>
  stepCostLogged: Set<string>
  messageRole: Map<string, string>
  suppressedParts: Set<string>
  // 畫布摘要：前端每次發訊息時上送的最新畫布狀態（節點/連線/預算），
  // 供前端接續畫布/稽核用。deepseek 不讀這個——它完全不知道畫布存在。
  canvasSummary?: unknown
  canvasSummaryAt?: number
  // 畫布持久快照（2026-08-27）：canvas.node.* 事件套用後的完整節點/連線狀態。
  // 隨 session 防抖落盤；重啟懶加載時回灌 canvasStates，支撐 /internal/canvas/snapshot。
  canvasSnapshot?: { nodes?: unknown[]; connections?: unknown[]; [k: string]: unknown }
  // 工作流持久快照（2026-08-27，與 canvasSnapshot 同構）：workflow 狀態變更時
  // 由 WorkflowService.onDirty 鏡像進 session（防抖落盤）；重啟懶加載時回灌
  // workflowService 的 workflows Map——畫布能恢復、工作流也能，行為一致。
  workflowSnapshot?: Record<string, unknown>
  // 自動製畫布：opencode image_* 工具的活躍單元追蹤。
  // deepseek 只提交生圖/改圖請求，gateway 攔截其參數自動建畫布：
  //   工具 callID → 畫布單元 id（running 階段建立）
  //   task_id    → 畫布單元 id（submit 完成後掛取，供完成事件關聯）
  canvasUnitByCall: Map<string, string>
  canvasUnitByTask: Map<string, string>
  // 0831：本輪生成任務登記（權威 task_id 來源，供 /internal/session-tasks 讀）。
  sessionTasks: Map<string, { task_id: string; label?: string; status: string; url?: string; submitted_at: number }>
  // 意圖審查政策只在 session 首次 send 時注入（system 欄位），之後不再重複，
  // 避免每次訊息都帶同一段 system 造成 token 膨脹。
  // D1 修復（2026-09-15 PRD P0-4）：本旗標同時是 L0/L1 記憶塊的注入閘——
  // memory-patch 到達時重置為 false，下一回合按最新記憶重建 system。
  // 原 memoryInjected「死旗標」（只寫不讀、真閘是這裡）已從型別與全部寫入點移除。
  vettingInjected: boolean
  // L0 账户级记忆：本站会话创建时上送的 user_profile + lessons，加上 2026-09-15
  // 契約 §4 擴充的 memory_docs（私有 active docs ≤8）與 memory_index_md（共享索引行）。
  // 首条消息时拼进 system 注入，之后不再重复，避免 token 膨胀。
  // 兩個新欄位是 userMemory 物件內的額外鍵：persistence 白名單整包透傳 userMemory，
  // 重啟 revive 不丟（memoryInjected 欄位刪除對 persistence 亦無感）。
  userMemory?: {
    user_profile: Record<string, unknown>
    lessons: string[]
    /** 契約 §1 AgentMemoryDoc 的駝峰原樣子集（repo payload 直送）。 */
    memory_docs?: MemoryDocLite[]
    /** 契約 §4 L1 共享索引行（≤800 字元）。 */
    memory_index_md?: string
  }
  /** 賬戶無畫像：開場用選擇題採集（question 工具）。 */
  profileOnboardingPending: boolean
  // 2026-08-25 模板隱形注入：站點點模板卡時上送的引導指示，隨首條訊息 system 注入。
  // 不進 transcript、用戶不可見；注入一次即棄（directiveInjected），換模板可覆蓋重注。
  sessionDirective?: string
  directiveInjected?: boolean
  // 滾動摘要壓縮水位：上次 opencode summarize 後的訊息數與時間（持久化）。
  // 觸發條件 = 訊息數 ≥ SESSION_COMPACT_THRESHOLD 且自上次壓縮新增 ≥ 半個閾值。
  compact?: { lastCount: number; at: number }
  // ── PRD P0-4（2026-09-15）記憶 trace 與召回輔助（皆 volatile，不入持久化白名單）──
  /** §3.6 形狀：注入trace，供 GET /agent/v1/sessions/:id/memory-trace（R2 尺觀測點）。
   *  重啟即丟屬已知限制（持久化白名單在 persistence.ts，非本片工作對象）。 */
  memoryTrace?: {
    private_docs: string[]
    shared_recalled: string[]
    shared_index_chars: number
    injected_at: string
  }
  /** §7 召回 query 的「上一輪 assistant 文本」：只留前 200 字元，turn 起點重置。 */
  turnAssistantHead?: string
  // 抖動重試（2026-08-22）：turn 結束但零文本輸出 = 上游模型抖動死亡的特徵，
  // gateway 自動重發同一條 prompt（上限 TURN_MAX_RETRIES）。volatile，不持久化；
  // revive 後為 undefined，讀取處一律帶 ?? 預設值。
  lastPromptBody?: { parts: { type: string; text: string }[]; system?: string; model?: { providerID: string; modelID: string } } | null
  turnGen?: number
  turnTextChars?: number
  // 罪狀2 根因修復（2026-08-29）：思維鏈字數。模型推理期間 reasoning.delta
  // 持續到達，此前不計入任何活動判定 → ack/心跳/看門狗/停滯哨在思考期誤判死寂。
  // 與 turnTextChars 同點重置；只進 turnHasActivity，不進零文本抖動重試判定。
  turnReasoningChars?: number
  turnRetries?: number
  turnAborted?: boolean
  retryQueued?: boolean
  // ── P2b（2026-09-11）：空轉止損（全部 volatile，不持久化）──
  /** 本 turn 連續空 step 計數。 */
  idleSteps?: number
  /** 當前是否處於一個未收尾的 step（step-start 置位 / step-finish 清位）。 */
  stepOpen?: boolean
  /** 當前 step 是否出現過 tool part。 */
  stepHasTool?: boolean
  /** 當前 step 是否出現過非空正文 text part。 */
  stepHasText?: boolean
  /** 當前 step 是否出現過非空（trim 後）reasoning 文字。 */
  stepHasReasoning?: boolean
  /** 本 turn 是否已因空轉中止並補發動作導向提示（同 turn 僅一次）。 */
  idleNudgeSent?: boolean
  // 2026-08-31 failover：本轮上游模型错误原文（非 tool_error/非 Aborted）。
  // emitSessionError 记入，turn 起点清空；idle 收尾时非空即接管换模重试
  //（jitter 只管零正文轮，mid-turn 断线此前无人接手）。volatile，不持久化。
  turnUpstreamError?: string | null
  // ── N1（2026-08-27）：死寂窗口補口 ─────────────────────────────
  // 規格1：30s 心跳提示（「模型在憋大招」，與 S6 ack 的「收到」錯峰）。
  // 每 turn 最多 1 條，volatile。
  heartbeatSent?: boolean
  heartbeatTimer?: ReturnType<typeof setTimeout> | null
  // 規格3：重啟斬 turn 重投——turn 開始時打點（持久化，重啟後判斷
  // 「重啟前是否有 in-flight turn」的唯一依據；turn 正常結束（idle 正常路徑
  // 發出 turn.done）時清零）。持久化欄位 → persistence.ts 需同步。
  lastTurnActiveAt?: number
  // ── S6（2026-08-27）：異步心跳匯報制 ─────────────────────────────
  // 規格2：用戶消息 30s ack。prompt_async 送達後啟動 timer；30s 內 turn
  // 沒產出任何文本 delta（turnTextChars 停 0）就先發一條短 ack。volatile。
  ackTimer?: ReturnType<typeof setTimeout> | null
  ackSent?: boolean
  // ── R2-A（2026-08-27）：turn 啟動看門狗 ──────────────────────────
  // 用戶消息送達後 turn 必須「動起來」（tool.invoke 或 message.delta 二選一）。
  // 評測實錘：壓縮後的長會話 prompt_async 202 但 turn 永不啟動，上游連
  // session.idle 都不發——抖動重試（只掛在 idle 上）永遠等不到。看門狗以
  // 「turn 有無動靜」為準，覆蓋 idle 永不到達的死亡路徑。volatile。
  watchdogTimer?: ReturnType<typeof setTimeout> | null
  /** 本輪 turn 是否出現過 tool.invoke（handleToolPartUpdate 置位）。volatile。 */
  turnToolStarted?: boolean
  /** 看門狗是否已重投過一次（只重投一次，防風暴）。volatile。 */
  watchdogRetried?: boolean
  /** 修 1（2026-09-01）：watchdog 已宣告死亡（道歉 + turn.done）。volatile。
   *  置位後若內容幀仍到達（重投 retry 開始產出 = 殭屍还魂），emitToSession
   *  統一通道會先發一條一次性撤回幀（「後端無響應是誤判」）再放行內容幀，
   *  用戶不再看到「宣告死亡 + 靜默还魂」並存。新 turn 起點（發消息/resume）
   *  與撤回發出時清位。 */
  deathDeclared?: boolean
  // ── R5-C（2026-08-28）：中段停滯哨 + 恢復輪標記（全部 volatile）──
  /** turn 內最後一次任意幀打點（emitToSession 全量刷新），中段凍結判定依據。 */
  turnLastFrameAt?: number
  /** 中段停滯哨 timer。volatile。 */
  midturnStallTimer?: ReturnType<typeof setTimeout> | null
  /** 中段停滯哨是否已重投過一次（防風暴，每 turn 一次）。volatile。 */
  midturnStallRetried?: boolean
  /** 本輪是否為恢復輪（watchdog 重投/redrive/中段哨重投）——收尾兜底結語用。 */
  recoveryRound?: boolean
  // ── R4-A（2026-08-28）：三死線修復的新增狀態（全部 volatile，不進持久化白名單）──
  // S3①：上游錯誤後停滯看門狗。emitSessionError 布哨、session.idle 撤哨。
  errorStallTimer?: ReturnType<typeof setTimeout> | null
  /** S3①：錯誤後告警幀是否已發（每 turn 一條，防刷屏）。 */
  errorStallAlerted?: boolean
  /** S3①：turn 內最後一次進度打點（message.delta / tool 幀刷新），停滯判定依據。 */
  turnProgressAt?: number
  /** S1：本 turn 是否已發過「英文內部思考已略去」提示（每 turn 一條）。 */
  englishNoticeSent?: boolean
  /** S8：本 turn 內到達終態的節點清單（id+status 去重，上限 64）。 */
  turnTerminalNodes?: { id: string; status: string }[]
  /** S8：本 turn 是否已發過任何主動匯報幀（emitAgentNotice 置位）。 */
  turnNoticeSent?: boolean
  /** S3②：重啟恢復時暫存的中斷告知——恢復瞬間常無 SSE 客戶端，等接入時補投。 */
  pendingRestoreNotice?: { text: string; at: number }
  // 規格3：質詢期間凍結大額自動開跑。最後一條用戶消息命中質詢樣式且
  // assistant 尚未回覆（turn 未結束）期間，視頻類 workflow generate 掛起。
  // volatile；pendingVideoWorkflows 記錄被凍結的 workflowId（回覆完成後放行）。
  lastUserMessage?: string
  lastUserAt?: number
  pendingVideoWorkflows?: string[]
  // 規格1：節點終態匯報去重（同一節點同一終態只匯報一次，rerun 後會再觸發）。
  nodeTerminalReported?: Set<string>
  // ── R8-B（2026-08-29）工單 #2/#3/#4/#5 新增狀態（全部 volatile）──
  /** 工單 #3：question pending 心跳 timer（每 30s 一幀用戶可見心跳）。 */
  questionHeartbeatTimer?: ReturnType<typeof setTimeout> | null
  /** 片AJ：question 3 分鐘超時代答 timer（手動答覆/跳過/會話拆除時清）。 */
  questionAssumeTimer?: ReturnType<typeof setTimeout> | null
  /** 工單 #5：中段靜默通知 timer（>45s 無 message.delta 補進度幀，此後每 45s 續發）。 */
  quietNoticeTimer?: ReturnType<typeof setTimeout> | null
  /** 工單 #5：turn 內最後一次模型正文（message.delta）打點——靜默通知判定依據。 */
  lastUserVisibleAt?: number
  /** 工單 #9：session.idle 在 question pending 期間到達 → 凍結旗標（答覆後復位）。 */
  turnFrozenByQuestion?: boolean
  /** 工單 #4：本 turn 是否答覆過 question（恢復輪結語讓位，防「要繼續跑嗎」自我推翻）。 */
  questionAnsweredThisTurn?: boolean
  // ── 會話摘要標題（2026-09-12）──
  /** opencode 在首條用戶消息後異步生成的會話標題；null/undef=尚未生成。
   *  session.idle 鉤子經 fetchOpencodeTitle 抓取，佔位標題（"New session - …"）
   *  不落入此欄。隨防抖落盤（persistence.serialize → data.title）。 */
  sessionTitle?: string | null
  /** idle 標題抓取的一次性重試計時器（2s/8s/20s，拿到即全部 clear）。 */
  titleFetchTimers?: ReturnType<typeof setTimeout>[]
}

// 抖動重試參數：免費上游模型約三至四成 turn 異常早死（finish=unknown、零文本）。
const TURN_MAX_RETRIES = Number.parseInt(process.env.TURN_MAX_RETRIES || "4", 10) || 4
const TURN_RETRY_DELAY_MS = Number.parseInt(process.env.TURN_RETRY_DELAY_MS || "1500", 10) || 1500
// ── P2b（2026-09-11）刀2：空轉止損 ────────────────────────────────
// 連續 N 個「空 step」（該 step 期間無 tool part、無非空正文 text part、
// reasoning 文字空/全空白）視為模型空轉：中止本 turn 並同一輪補一次動作
// 導向重發（僅一次，不循環）。出現 tool/非空正文/非空 reasoning/turn 結束
// → 計數歸零。
const IDLE_STEP_ABORT_THRESHOLD = 3
const IDLE_STEP_NUDGE =
  "\n\n（系统提示：上一次生成空转被中止。请立刻发出工具调用开始动作，不要再展开推理。）"
// S6 規格2：用戶消息 ack 上限。R4 實測 30s 檔 ack 落地 33-40s+（timer 30s 起
// 算於 prompt_async 投遞後，再疊加投遞/事件轉譯延遲）——壓到 15s，保證含
// 鏈路延遲也在 30s 線內。環境變量可覆蓋。
const ACK_DELAY_MS = Number.parseInt(process.env.ACK_DELAY_MS || "15000", 10) || 15_000
// R2-A 看門狗：prompt_async 送達後 TURN_WATCHDOG_MS 內無 tool.invoke 且無
// message.delta = turn 沒啟動（評測：295s 零幀）。先誠實告警再自動重投一次；
// 再等一輪仍無動靜則判會話損壞，建議新開。環境變量可覆蓋（CI 可調短）。
const TURN_WATCHDOG_MS = Number.parseInt(process.env.TURN_WATCHDOG_MS || "90000", 10) || 90_000
// R4-A S3①：上游錯誤（session.error 非 tool_error）後的停滯看門狗。R4 實錘：
// compaction+APIError "Input token exceed" 後 turn 空轉 5 分鐘零告警——啟動
// 看門狗因 turn 已有動靜（turnHasActivity）靜默退出，覆蓋不到「中途死亡」。
// 錯誤發生 90s 內 turn 未收尾且無進度 → 告警 + 依抖動重試兜底；再 90s 仍停滯
// → 明確收尾話術 + turn.done。環境變量可覆蓋。
const TURN_ERROR_WATCHDOG_MS = Number.parseInt(process.env.TURN_ERROR_WATCHDOG_MS || "90000", 10) || 90_000
// N1 規格1：心跳提示延遲——turn 開始後 HEARTBEAT_DELAY_MS 仍無任何
// message.delta 也無 tool.invoke（模型連字都沒吐）時補一條「仍在等待模型响应」。
// 與 S6 ack（30s「收到，正在处理」）錯峰：ack 已發則心跳順延到 45s；每 turn
// 最多 1 條，不刷屏。watchdog（90s）之前的中段窗口由這條填補。
const HEARTBEAT_DELAY_MS = Number.parseInt(process.env.HEARTBEAT_DELAY_MS || "30000", 10) || 30_000
const HEARTBEAT_DELAY_AFTER_ACK_MS = Number.parseInt(process.env.HEARTBEAT_DELAY_AFTER_ACK_MS || "45000", 10) || 45_000
// R5-C（2026-08-28）中段停滯哨：turn 已啟動（有過 tool/正文活動）之後，
// MIDTURN_STALL_MS 內零任何新幀（連進度幀都沒有）= 中段凍結。誠實告警 +
// 防風暴單次重投（復用 watchdogRetried 模式）；重投後仍零幀 → 如實收尾 +
// turn.done。時間戳 turnLastFrameAt 由 emitToSession 全量刷新——長工具執行
// 只要有任何幀（tool.result/canvas/文本）就不誤殺，只咬連幀都沒有的凍結。
const MIDTURN_STALL_MS = Number.parseInt(process.env.MIDTURN_STALL_MS || "90000", 10) || 90_000
// R8-B 工單 #3（2026-08-29）：question pending 心跳週期——pending 期間每 30s
// 一幀用戶可見心跳（R8 實錘：question 卡後 129s 零幀死寂）。
const QUESTION_HEARTBEAT_MS = Number.parseInt(process.env.QUESTION_HEARTBEAT_MS || "30000", 10) || 30_000
// 片AJ（2026-09-07）：question 卡 3 分鐘無人回覆 → 按推薦方案（各題第一選項）代答繼續，
// 答覆文案標注 assumed——無人值守跑批不再掛死（T4 實錘 question 卡挂死 15+ 分鐘）。
const QUESTION_ASSUME_MS = Number.parseInt(process.env.QUESTION_ASSUME_MS || "180000", 10) || 180_000
// R8-B 工單 #5：中段靜默通知閾值——turn 進行中 >45s 無正文（message.delta）
// 補一幀用戶可見進度，此後每 45s 續發。與 R5-C 中段停滯哨（90s 零「任何」幀）
// 並存：停滯哨管「全幀死亡」，本通知管「模型活著但用戶看不見」（長推理段）。
const QUIET_NOTICE_MS = Number.parseInt(process.env.QUIET_NOTICE_MS || "45000", 10) || 45_000

const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "")
const OPENCODE_PASSWORD = process.env.OPENCODE_PASSWORD || ""
const PORT = Number.parseInt(process.env.GATEWAY_PORT || "8081", 10) || 8081
const PLATFORM_BASE = (process.env.PLATFORM_BASE || "https://image.tinchak0207.xyz").replace(/\/+$/, "")
const QUOTA_URL = process.env.QUOTA_URL || `${PLATFORM_BASE}/v1/quota`
// ── 全局記憶 env（契約 §8 八條，默認值照表）──────────────────────────────
// 語義解析（envBool/envInt）與 memory-batch.ts 內部保持一致，避免兩側漂移。
function memoryEnvBool(raw: string | undefined, fallback: boolean): boolean {
  const v = String(raw ?? "").trim().toLowerCase()
  if (v === "") return fallback
  return v === "1" || v === "true" || v === "yes" || v === "on"
}
// HMAC 密鑰（§8 必填側 VPS；缺失時批次拒絕送出、召回拉取 fail-fast，誠實報錯不裸奔）。
const MEMORY_INGEST_SECRET = process.env.MEMORY_INGEST_SECRET || ""
// 批次總開關（§8 默認 false：先驗通再接；false 時 ticker 不觸發，手動跑只准 dry_run）。
const MEMORY_BATCH_ENABLED = memoryEnvBool(process.env.MEMORY_BATCH_ENABLED, false)
// 批次觸發時（UTC 小時；§8 默認 20 = UTC+8 04:00）。
const MEMORY_BATCH_HOUR_UTC = (() => {
  const n = Number.parseInt(process.env.MEMORY_BATCH_HOUR_UTC ?? "20", 10)
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 20
})()
// 共享庫總開關（§8 默認 true；false → 共享目錄零注入、召回零讀、召回路由零命中）。
const MEMORY_SHARED_ENABLED = memoryEnvBool(process.env.MEMORY_SHARED_ENABLED, true)
// 召回門檻與開關（§7/§8）。
const MEMORY_RECALL_MIN_SCORE = (() => {
  const n = Number.parseFloat(process.env.MEMORY_RECALL_MIN_SCORE ?? "1.0")
  return Number.isFinite(n) ? n : 1.0
})()
const MEMORY_RECALL_ENABLED = memoryEnvBool(process.env.MEMORY_RECALL_ENABLED, true)
// G8 verifier 與 PRD §5.6 oracle 抽檢模型（`provider/model`，契約 §5「換模型」；
// §8 之外的 P1-1 新增 env）。未配置＝該閘跳過，批次報告誠實記 g8_skipped／sampling.skipped。
const MEMORY_VERIFIER_MODEL = (process.env.MEMORY_VERIFIER_MODEL || "").trim()
const MEMORY_ORACLE_MODEL = (process.env.MEMORY_ORACLE_MODEL || "").trim()
// 【契約外新增】批次/召回打 Vercel repo 端點（/api/agent/memory/*）的前綴。契約 §8 沒有
// 這條（§3 端點只在 repo 側定義）；默認值與 PLATFORM_BASE 同構，屬本片新增接線參數。
const MEMORY_INGEST_BASE_URL = (process.env.MEMORY_INGEST_BASE_URL || "https://image.tinchak0207.xyz").replace(/\/+$/, "")
// How long a spend confirmation stays answerable. 15 minutes, not 90 seconds:
// the user may be reading the parameter card, checking their balance, or simply
// away from the tab, and a spend prompt that silently expires under them is
// worse than one that waits. This is NO LONGER bounded by the HTTP layer —
// /internal/confirm-request returns immediately and the tool polls, precisely
// because a request cannot block this long (Bun's idleTimeout maxes at 255s
// and the caller aborts at 150s).
const CONFIRM_TIMEOUT_MS = Number.parseInt(process.env.CONFIRM_TIMEOUT_MS || "900000", 10) || 900_000
// Keep answered confirmations addressable well past the poll interval so a
// poller that ticks right after resolution still reads the real outcome.
const CONFIRM_RESOLVED_TTL_MS = 5 * 60 * 1000
const CONFIRM_RESOLVED_CAP = 200
// S4（2026-08-27）計費確認門檻改金額維度：估算總價 ≥ 此幣數的批量執行
//（workflow generate）必須先過 confirm.request 批准；低於門檻免擾自動跑。
// 舊門檻「單筆工具 >0.1 幣就彈卡」由工具層自帶（image_* 工具），門檻倒掛
//（6.25 幣批量零確認、1 幣重試反而彈卡）正是兩套門檻各管一段造成——
// 統一基準：估算金額。env CONFIRM_THRESHOLD_COINS 可覆蓋。
const CONFIRM_THRESHOLD_COINS = Number.parseFloat(process.env.CONFIRM_THRESHOLD_COINS || "5") || 5
// R5-C（2026-08-28）影片估價改價目表檔位（暴君欽定：價目表 100% 權威，代碼與
// 價目表衝突 = 代碼錯）：MiniMax H3 720P = 5 幣/秒、1080P = 10 幣/秒。舊 S4
// 0.05 幣/秒估算口徑廢除；目錄 /v1/models 的視頻價是 0.25 RMB 混幣髒價，
// 禁止回落目錄。
// 2026-08-30 双账本收敛：檔位單價不再在此另立常量——統一由 workflow-service 的
// resolveVideoPerSecond（锚点 unit_price_per_second 优先、档位价 5/10 兜底）提供，
// 與 service 側 preflightBudget/midBatchBudgetGate/cost_hint 同一把尺。
// S4 cost_hint 目錄快取：GET /v1/models 的 x_coins_per_image，TTL 10 分鐘
//（與工具層 loadCatalog 同口徑）。估不出單價的模型回 null（不許編數）。
const PRICE_CATALOG_TTL_MS = 10 * 60 * 1000
let priceCatalogCache: { at: number; prices: Record<string, number> } | null = null

/**
 * S4：查平台目錄單價（幣/張）。權威來源 = GET /v1/models 的 x_coins_per_image，
 * 與工具層 loadCatalog / quote_bundle 完全同一數據源（不許第二個價格宇宙）。
 * 取不到回 null——cost_hint 與門檻估算都寧缺勿編。
 */
async function catalogUnitCoins(model: string, apiKey: string): Promise<number | null> {
  const now = Date.now()
  if (!priceCatalogCache || now - priceCatalogCache.at > PRICE_CATALOG_TTL_MS) {
    try {
      const res = await fetch(`${PLATFORM_BASE}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
        const prices: Record<string, number> = {}
        for (const m of body.data ?? []) {
          const id = typeof m.id === "string" ? m.id : null
          if (!id) continue
          const raw = m.x_coins_per_image
          if (typeof raw === "number") prices[id] = raw
          else if (raw && typeof raw === "object") {
            const o = raw as Record<string, unknown>
            const v = typeof o.standard === "number" ? o.standard : typeof o.hd === "number" ? o.hd : null
            if (v !== null) prices[id] = v
          }
        }
        if (Object.keys(prices).length > 0) priceCatalogCache = { at: now, prices }
      }
    } catch {
      // 目錄不可達：沿用舊快取；完全沒有 → 呼叫方拿到 null（不編數）
    }
  }
  const v = priceCatalogCache?.prices[model]
  return typeof v === "number" ? v : null
}

// S4 姊妹快取：查平台目錄視頻秒價（幣/秒）。權威來源 = GET /v1/models 的
// x_coins_per_second，與 catalogUnitCoins（x_coins_per_image）同一份目錄回應、
// 同一 10 分鐘 TTL——本次事故修復：seedance-2.0 等無 MiniMax 硬編碼檔位的模型，
// 從目錄同源取（與扣費同一函式 generationCoins），不再落錯誤兜底檔位。
let priceCatalogPerSecondCache: { at: number; table: Record<string, Record<string, number>> } | null = null
async function catalogVideoPerSecondCoins(model: string, apiKey: string): Promise<Record<string, number> | null> {
  const now = Date.now()
  if (!priceCatalogPerSecondCache || now - priceCatalogPerSecondCache.at > PRICE_CATALOG_TTL_MS) {
    try {
      const res = await fetch(`${PLATFORM_BASE}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
        const table: Record<string, Record<string, number>> = {}
        for (const m of body.data ?? []) {
          const id = typeof m.id === "string" ? m.id : null
          if (!id) continue
          const raw = m.x_coins_per_second
          if (raw && typeof raw === "object") {
            const entry: Record<string, number> = {}
            for (const [res_, v] of Object.entries(raw as Record<string, unknown>)) {
              if (typeof v === "number") entry[res_] = v
            }
            if (Object.keys(entry).length) table[id] = entry
          }
        }
        if (Object.keys(table).length > 0) priceCatalogPerSecondCache = { at: now, table }
      }
    } catch {
      // 目錄不可達：沿用舊快取
    }
  }
  return priceCatalogPerSecondCache?.table[model] ?? null
}

// 同步變體：estimateGraphCoins（canvas.plan 熱路徑，同步簽名不可 await）專用。
// 只讀已warm的目錄快取（不發網路請求）；快取未warm時等同舊行為（純錨點/檔位兜底）。
function videoTierPerSecondSync(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  graph?: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): number {
  const model =
    typeof node.metadata.model === "string" && node.metadata.model
      ? node.metadata.model
      : graph
        ? resolveNodeModel((node as { id?: string }).id ?? "", node, graph)
        : "minimax-h3"
  const catalogTable = priceCatalogPerSecondCache?.table[model] ?? null
  return resolveVideoPerSecond(
    node as never,
    graph as never,
    catalogTable ? (tier: "720p" | "1080p") => catalogTable[tier] ?? null : undefined,
  )
}

/**
 * S4：沿連線向上游 config 節點解析 image 節點的實際執行參數（model）。
 * 模板結構：text → config(帶 model/size/count) → image*（image 節點
 * metadata 通常為空，model 在上游 config 上——submitWorkflowNode 也是
 * 這樣預設的：image 缺 model 時用 pixai-tsubaki2）。最多回看 2 層。
 */
function resolveNodeModel(
  nodeId: string,
  node: { kind: string; metadata: Record<string, unknown> },
  graph: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): string {
  if (typeof node.metadata.model === "string" && node.metadata.model) return node.metadata.model
  const upstreamIds = graph.connections.filter((c) => c.to === nodeId).map((c) => c.from)
  // 2026-08-30 事故修复：多 config 时模型跟随最新 cfg，旧 cfg 不再抢先——
  // 旧逻辑按 connections 数组顺序取第一个带 model 的 config，先连的旧 cfg
  //（minimax-h3）永远压住后接的 seedance cfg，rerun 永远解析回旧模型。
  // 改为：遍历入边所有 config 节点，剔除无 model 的，取 graph.nodes 里 index
  // 最大的那个（= 最后创建/最新接的 config）。递归兜底与 pixai-tsubaki2
  // 默认不变，只改这一处选择逻辑。
  let bestConfig: { node: (typeof graph.nodes)[number]; idx: number } | null = null
  for (const uid of upstreamIds) {
    const un = graph.nodes.find((n) => n.id === uid)
    if (un && un.kind === "config" && typeof un.metadata.model === "string" && un.metadata.model) {
      const idx = graph.nodes.findIndex((n) => n.id === un.id)
      if (!bestConfig || idx > bestConfig.idx) bestConfig = { node: un, idx }
    }
  }
  if (bestConfig) return bestConfig.node.metadata.model as string
  for (const uid of upstreamIds) {
    const un = graph.nodes.find((n) => n.id === uid)
    if (un) {
      const m = resolveNodeModel(uid, un, graph)
      if (m !== "pixai-tsubaki2") return m
    }
  }
  return "pixai-tsubaki2"
}

/**
 * R5-C：影片檔位單價（幣/秒）——2026-08-30 双账本收敛：改由 workflow-service 的
 * 共享 resolveVideoPerSecond 提供（锚点 unit_price_per_second 优先、档位价 5/10
 * 兜底），与 service 侧 preflightBudget/midBatchBudgetGate/cost_hint 同一把尺。
 * 此處保留薄封装以不改動既有调用点签名。
 */
async function videoTierPerSecond(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  graph: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] } | undefined,
  apiKey: string,
): Promise<number> {
  const model =
    typeof node.metadata.model === "string" && node.metadata.model
      ? node.metadata.model
      : graph
        ? resolveNodeModel((node as { id?: string }).id ?? "", node, graph)
        : "minimax-h3"
  // catalog 快取：先查一次目錄（同一 apiKey 10 分鐘快取，見 catalogVideoPerSecondCoins）——
  // 本次事故修復：seedance-2.0 等無 MiniMax 硬編碼檔位的模型，從 /v1/models 的
  // x_coins_per_second 同源取（與扣費同一函式 generationCoins），不再被錯誤套用
  // MiniMax 5/10 幣/秒檔位價。resolveVideoPerSecond 優先序：錨點價 → catalogLookup → 檔位 5/10 兜底。
  const catalogTable = await catalogVideoPerSecondCoins(model, apiKey)
  return resolveVideoPerSecond(
    node as never,
    graph as never,
    catalogTable ? (tier: "720p" | "1080p") => catalogTable[tier] ?? null : undefined,
  )
}

/**
 * S4：估算單一可執行節點的幣耗。優先級：節點自帶價 → 平台目錄單價 → null。
 * video 按價目表檔位價（R5-C：720P=5 / 1080P=10 幣/秒）；image 按目錄單價 × 1
 *（submitWorkflowNode 對 workflow 節點固定 n:1，count 在 config 上只是參考標注，
 * 不放大節點張數）。回 null 表示估不出（目錄不可達且模型不在目錄）——上層保持
 * null / 保守策略。
 */
async function estimateNodeCoins(
  node: { kind: string; metadata: Record<string, unknown> },
  apiKey: string,
  graph?: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): Promise<number | null> {
  if (node.kind === "video") {
    const nodeId = (node as { id?: string }).id ?? ""
    const cfgDuration = graph ? resolveConnectedVideoDuration(nodeId, graph) : undefined
    const secs =
      typeof node.metadata.duration_seconds === "number" && node.metadata.duration_seconds > 0
        ? node.metadata.duration_seconds
        : cfgDuration
    if (typeof secs !== "number" || !(secs > 0)) return null // 拒絕編數：與 submitWorkflowNode 的「缺時長拒絕提交」同口徑
    const perSec = await videoTierPerSecond(node, graph, apiKey)
    return Math.round(secs * perSec * 100) / 100
  }
  if (node.kind !== "image") return 0 // audio/film 現行 0 幣（TTS 定價 0）
  const nodeId = (node as { id?: string }).id ?? ""
  const model =
    typeof node.metadata.model === "string" && node.metadata.model
      ? node.metadata.model
      : graph
        ? resolveNodeModel(nodeId, node, graph)
        : "pixai-tsubaki2"
  const unit = await catalogUnitCoins(model, apiKey)
  if (unit === null) return null
  return Math.round(unit * 1e6) / 1e6
}
const KEY_CACHE_TTL_MS = 5 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 20_000
const REPLAY_BUFFER_SIZE = 1000
const IMAGE_URL_DEDUP_CAP = 100
const PART_TEXT_TRACK_CAP = 200
const TOOL_STATUS_DEDUP_CAP = 500
const STEP_COST_LOG_CAP = 1000
const MESSAGE_ROLE_CAP = 400
const SUPPRESSED_PART_CAP = 500
// Reaper thresholds. A session with no SSE clients and no activity for this
// long is assumed abandoned (closed tab / lost network) and freed.
// 2026-09-12 永久保留改造：默認 TTL 從 30 分鐘放寬到 30 天。reap（keepRow=true）只清內存、
// 不刪數據也不再發 session.closed（見 teardownSession）；正常使用週期內會話基本不會被 reap，
// 內存熱度回收能力保留。env 為逃生口（毫秒）。
const SESSION_IDLE_TTL_MS = Number.parseInt(process.env.SESSION_IDLE_TTL_MS || "2592000000", 10) || 2_592_000_000
// 2026-09-12 永久保留：7 天 stale sweep（刪 DB row + opencode 會話 + uploads）默認關閉。
// 未設/0 = 永不刪；>0 恢復舊的「N 天未更新即連根刪」能力（env 逃生口）。
const SESSION_SWEEP_DAYS = Number.parseInt(process.env.SESSION_SWEEP_DAYS || "0", 10) || 0
const SESSION_REAP_INTERVAL_MS = 60_000
const LEDGER_PATH = process.env.LEDGER_PATH || "/opt/agent-harness/ledger.jsonl"
// 畫布事件白名單：opencode canvas_* 工具透過 emitEvent 推送的畫布動作/成果事件。
// 這組事件由前端 reducer 接住，驅動畫布渲染（建節點/連線/顯示圖片/預算）。
const CANVAS_EMIT_ALLOWED = new Set([
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.deleted",
  "canvas.node.generating",
  "canvas.derive.started",
  "canvas.budget.updated",
])

const INTERNAL_EMIT_ALLOWED = new Set(["image.done", "video.done", "image.failed", "session.error", "quota.changed", "tool.result", "tool.progress"])

const WORKSPACE_DIR = "/opt/agent-harness/workspace"
const UPLOADS_DIR = path.join(WORKSPACE_DIR, "uploads")
// TTS 音頻落盤與對外 URL 基址：文件存 gateway 本地靜態目錄，
// 公網走 nginx 已有的 /agent/ 反代（store.tinchak0207.xyz/agent/* → 本網關）。
const TTS_AUDIO_DIR = path.join(WORKSPACE_DIR, "tts-audio")
const TTS_PUBLIC_BASE = (process.env.TTS_PUBLIC_BASE || "https://store.tinchak0207.xyz/agent/v1/audio").replace(/\/+$/, "")
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024 // 4MB per file
const VIDEO_UPLOAD_MAX_BYTES = 100 * 1024 * 1024 // 100MB per file（瀏覽器原片直傳）
const VIDEO_UPLOAD_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v"])
const ALLOWED_UPLOAD_EXTS = new Set([
  ".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".json",
  ".csv", ".xml", ".yaml", ".yml", ".png", ".jpg", ".jpeg",
  ".webp", ".gif", ".mp4", ".mov", ".m4v", ".webm", ".zip",
])

function sanitizeUploadName(raw: string): string | null {
  const base = path.basename(raw).normalize("NFC")
  const safe = base.replace(/[^\w.\- ]/g, "_").replace(/_{2,}/g, "_").slice(0, 200)
  const ext = path.extname(safe).toLowerCase()
  if (!ALLOWED_UPLOAD_EXTS.has(ext)) return null
  return safe
}

/** 附件靜態讀路由的 Content-Type 映射（按擴展名；未收錄一律 octet-stream）。 */
function contentTypeForExt(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".opus": "audio/opus",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".json": "application/json",
    ".csv": "text/csv",
    ".zip": "application/zip",
  }
  return map[ext] ?? "application/octet-stream"
}

/** zip 內容安檢（紅隊加固 2026-08-22）：路徑穿越／絕對路徑／條目過多／解壓炸彈／嵌套 zip 一律拒。回 null=通過。 */
function zipProbe(dest: string): string | null {
  const names = Bun.spawnSync(["unzip", "-Z1", dest], { stdout: "pipe", stderr: "ignore" })
  if (names.exitCode !== 0) return "invalid zip archive"
  const entries = names.stdout.toString().split("\n").filter((l) => l.length > 0)
  if (entries.length > 200) return `too many entries (${entries.length})`
  for (const e of entries) {
    if (e.startsWith("/") || e.includes("..") || e.includes("\\") || /^[a-zA-Z]:/.test(e)) return "unsafe entry path"
    if (e.toLowerCase().endsWith(".zip")) return "nested zip"
  }
  const sizes = Bun.spawnSync(["unzip", "-lv", dest], { stdout: "pipe", stderr: "ignore" })
  if (sizes.exitCode !== 0) return "invalid zip listing"
  let total = 0
  for (const line of sizes.stdout.toString().split("\n")) {
    const m = line.match(/^\s*(\d+)\s+\d+\s/)
    if (m) total += Number(m[1])
  }
  if (total > 32 * 1024 * 1024) return `uncompressed size too large (${Math.round(total / 1048576)}MB)`
  return null
}

async function handleAttachmentUpload(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const ct = req.headers.get("content-type") || ""
  if (!ct.includes("multipart/form-data")) {
    return jsonError(400, "multipart/form-data required", "bad_request", "bad_request")
  }
  try {
    const form = await req.formData()
    const files = form.getAll("file") as File[]
    if (files.length === 0) return jsonError(400, "no file field", "bad_request", "bad_request")
    const uploadDir = path.join(UPLOADS_DIR, state.sessionId)
    await mkdir(uploadDir, { recursive: true })
    const results: { name: string; path: string; size: number }[] = []
    for (const file of files) {
      if (file.size > UPLOAD_MAX_BYTES) {
        return jsonError(413, "file exceeds 4MB limit", "payload_too_large", "payload_too_large")
      }
      const safeName = sanitizeUploadName(file.name)
      if (!safeName) {
        return jsonError(400, `disallowed file type: ${path.extname(file.name)}`, "bad_request", "bad_request")
      }
      const dest = path.join(uploadDir, safeName)
      if (!path.resolve(dest).startsWith(path.resolve(UPLOADS_DIR))) {
        return jsonError(400, "invalid path", "bad_request", "bad_request")
      }
      await Bun.write(dest, await file.arrayBuffer())
      if (safeName.toLowerCase().endsWith(".zip")) {
        const probe = zipProbe(dest)
        if (probe !== null) {
          await rm(dest, { force: true })
          return jsonError(400, `zip rejected: ${probe}`, "bad_request", "bad_request")
        }
      }
      results.push({ name: safeName, path: `uploads/${state.sessionId}/${safeName}`, size: file.size })
    }
    return Response.json({ attachments: results })
  } catch (e) {
    console.error("[gateway] upload error:", e)
    return jsonError(500, "upload failed", "server_error", "server_error")
  }
}

// SSE tickets. The browser EventSource API cannot set an Authorization header
// (its only option is withCredentials), so a page written the way §7 shows it
// cannot authenticate the event stream at all. Rather than accept the sk-biz-*
// key in the query string — where it lands in nginx access logs, Referer
// headers and browser history, and where it would still be a key that can spend
// money — a ticket is minted by an authenticated POST and scoped to exactly one
// session, read-only, with a short TTL.
//
// Deliberately reusable until it expires: EventSource reconnects on its own and
// replays Last-Event-ID, so a one-shot ticket would break §9-5 resume on the
// first network blip.
const SSE_TICKET_TTL_MS = Number.parseInt(process.env.SSE_TICKET_TTL_MS || "600000", 10) || 600_000
const sseTickets = new Map<string, { sessionId: string; apiKey: string; expiresAt: number }>()

// ── 附件靜態讀票據（2026-08-29，罪狀1 網關側）─────────────────────────────
// 前端 <img>/<video> 標籤帶不了 Authorization 頭，與 SSE ticket 同構：認證 POST
// 換一張只讀、單會話、TTL 1 小時的票據，公開 GET 路由憑票直讀 UPLOADS_DIR 下文件。
const UPLOAD_TICKET_TTL_MS = Number.parseInt(process.env.UPLOAD_TICKET_TTL_MS || "3600000", 10) || 3_600_000
const uploadTickets = new Map<string, { sessionId: string; expiresAt: number }>()

function issueUploadTicket(sessionId: string): string {
  const ticket = `ut_${crypto.randomUUID().replace(/-/g, "")}`
  uploadTickets.set(ticket, { sessionId, expiresAt: Date.now() + UPLOAD_TICKET_TTL_MS })
  return ticket
}

/** 只驗票據有效（未過期）且與會話匹配，不驗 key（GET 方是瀏覽器標籤）。
 *  過期順手刪條目；無效/過期/會話不匹配回 false，呼叫端一律 404 不泄露存在性。 */
function redeemUploadTicket(ticket: string, sessionId: string): boolean {
  const rec = uploadTickets.get(ticket)
  if (!rec) return false
  if (rec.expiresAt <= Date.now()) {
    uploadTickets.delete(ticket)
    return false
  }
  return rec.sessionId === sessionId
}

// ---- 服務端會話持久化（bun:sqlite，見 persistence.ts）----
// 進程重啟不再丟會話：session row 落在 sessions.db；getOwnedSession 與事件
// fan-out ���內存 miss 時 lazy reload。訊息歷史的權威存儲是 opencode（重啟不丟），
// DB 只保存 gateway 自有的那部分狀態（身分映射 / replayBuffer / 去重集合 / 注入標記）。
initPersistence()
const sessions = new Map<string, SessionState>()

// dirty 標記 + 防抖 flush：emitToSession 等高頻變更只標記，每 3 秒統一落盤；
// 建立/刪除走同步寫。重啟最多丟 3 秒內的 replay 幀，訊息本身永遠安全在 opencode。
const dirtySessions = new Set<string>()
const PERSIST_FLUSH_INTERVAL_MS = 3000

function markDirty(state: SessionState): void {
  // 畫布快照同步：落盤前把 canvasStates 的最新快照抄回 session（單一事實來源
  // 在 canvasStates，DB 欄位只是它的鏡像，重啟後回灌用）。
  const snap = canvasStates.get(state.sessionId)
  if (snap && snap.state && typeof snap.state === "object") {
    state.canvasSnapshot = snap.state as SessionState["canvasSnapshot"]
  }
  // 工作流快照同步（同構）：單一事實來源在 workflowService 的 Map，
  // session.workflowSnapshot 只是鏡像，重啟後回灌用。
  if (workflowOwnerBySession.get(state.sessionId)) {
    state.workflowSnapshot = workflowSnapshotFor(state)
  }
  dirtySessions.add(state.sessionId)
}

function flushDirtySessions(): void {
  if (dirtySessions.size === 0) return
  const ids = [...dirtySessions]
  dirtySessions.clear()
  for (const id of ids) {
    const st = sessions.get(id)
    if (st) saveSession(st)
  }
}

setInterval(flushDirtySessions, PERSIST_FLUSH_INTERVAL_MS)

// systemd restart（SIGTERM）前補一次 flush，把最後 ≤3s 的 replay 幀也保住。
process.on("SIGTERM", () => {
  try {
    flushDirtySessions()
  } catch {
    // best-effort：flush 失敗不阻止退出
  }
  process.exit(0)
})

const keyCache = new Map<string, { ok: boolean; expiresAt: number }>()
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jsonError(status: number, message: string, type: string, code: string): Response {
  return Response.json({ error: { message, type, code } }, { status })
}

function getBearer(req: Request): string | null {
  const auth = req.headers.get("authorization")
  if (!auth) return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

// ---- auth validation (cached 5 minutes) ----

async function validateApiKey(key: string): Promise<boolean> {
  const now = Date.now()
  const cached = keyCache.get(key)
  if (cached && cached.expiresAt > now) return cached.ok
  let ok = false
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000), // 2026-09-12 刀2：miss RTT 實測 24–125ms，5s 上限收斂為 2s 尾延遲保護
    })
    ok = res.ok
  } catch {
    ok = false
  }
  keyCache.set(key, { ok, expiresAt: now + KEY_CACHE_TTL_MS })
  return ok
}

// ---- canonical identity (R6): raw B key -> owner derived key ----

// 正典化缓存：正 10 分钟（派生 key 稳定），负 60 秒（站点抖动防风暴）。
// 任何失败（超时/非 200/形状不符）一律 fallback 回 rawKey。
const CANON_KEY_TTL_MS = 10 * 60 * 1000
const CANON_KEY_NEG_TTL_MS = 60 * 1000
const canonKeyCache = new Map<string, { key: string | null; expiresAt: number }>()

async function resolveCanonicalKey(rawKey: string): Promise<string> {
  const now = Date.now()
  const cached = canonKeyCache.get(rawKey)
  if (cached && cached.expiresAt > now) return cached.key ?? rawKey
  let canonical: string | null = null
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/agent/biz/resolve-owner`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}` },
      signal: AbortSignal.timeout(2000), // 2026-09-12 刀2：miss RTT 實測 95–533ms，負緩存 60s 防風暴下 2s 足夠
    })
    if (res.ok) {
      const data = (await res.json()) as { canonical_key?: unknown }
      if (typeof data.canonical_key === "string" && data.canonical_key.startsWith("sk-biz-")) {
        canonical = data.canonical_key
      }
    }
  } catch {
    // fall through: fallback to rawKey
  }
  canonKeyCache.set(rawKey, {
    key: canonical,
    expiresAt: now + (canonical ? CANON_KEY_TTL_MS : CANON_KEY_NEG_TTL_MS),
  })
  return canonical ?? rawKey
}

async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// ---- opencode client helpers ----

function opencodeHeaders(): Record<string, string> {
  return {
    Authorization: "Basic " + btoa("opencode:" + OPENCODE_PASSWORD),
    "Content-Type": "application/json",
  }
}

// ── 會話摘要標題（2026-09-12）────────────────────────────────────
// opencode 在首條用戶消息後異步生成 session.title（真會話實測「戴帽橘猫水彩插画」
// 級別；零消息會話是 "New session - <時間戳>" 佔位）。網關讀輪子不造輪子：
// 抓取、佔位歸一化、落盤都在這一条鏈，目錄端點透傳 title 供前端歷史清單顯示。
async function fetchOpencodeTitle(opencodeSessionId: string): Promise<string | null> {
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
function scheduleTitleFetch(state: SessionState): void {
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

// ── 能力斷路（MOE 評測死線1，2026-09-08）：野獸模式 ON 時主會話跑 orchestrator
// agent（opencode.json agent.orchestrator.tools 把 blender_exec/blender_render/
// blender_export_gltf/music_gen 從工具表物理移除）→ 主會話無法直調域工具，只能
// subagent_dispatch 派發 Expert。OFF 不帶 agent 欄＝default build agent＝零變化。
function beastAgentField(state: SessionState): Record<string, string> {
  try {
    if (loadUserSettings(state.apiKey)?.beast_mode === true) return { agent: "orchestrator" }
  } catch {}
  return {}
}

// ── N1 規格3（2026-08-27）：重啟斬 turn 的自動重投 ──────────────────
// 評測實錘：opencode-server 重啟斬殺 in-flight turn（無 idle、無 turn.done），
// 用戶端純 ping 靜默。重啟後 session 從 DB 恢復時，若 lastTurnActiveAt
//（turn 開始時打點、正常結束時清零的持久化欄位）非零且距 now 在窗口內 =
// 重啟前有 in-flight turn → 自動重投 lastPromptBody（完整檔）。
// 冪等保護（三重）：
//   1. 重投前確認 turnGen 未變（恢復期間沒有新消息進來）
//   2. 重投前確認 lastTurnActiveAt 仍非零（turn 未正常結束）
//   3. 進程級 Set 防同一 session 重複觸發（fan-out + lazy 兩條恢復路徑）
// 重投失敗（opencode 不可達等）→ 誠實告知「服務重啟過，上一條消息被中斷」，
// 絕不靜默。老會話（超過窗口）不追溯重投——避免殭屍會話甦醒刷屏。
const TURN_REPROMPT_WINDOW_MS = Number.parseInt(process.env.TURN_REPROMPT_WINDOW_MS || "600000", 10) || 600_000
const repromptedSessions = new Set<string>()

/** R4-A S3②：中斷告知幀補投暫存。恢復瞬間常無 SSE 客戶端（R4 實錘：幀
 *  發出時無人在線，重連又不帶 Last-Event-ID → 用戶永遠看不到），有客戶端
 *  在線則即時可達、不暫存；無客戶端則掛到 state，openEventStream 接入時補投。 */
function stashOrEmitRestoreNotice(state: SessionState, text: string): void {
  emitToSession(state, "message.delta", { text })
  if (state.clients.size === 0) {
    state.pendingRestoreNotice = { text, at: Date.now() }
    console.log(`[gateway] N1 restore notice stashed for next SSE attach — session=${state.sessionId}`)
  }
}

/** R4-A S3②：重投被斬 turn 的共用投遞體（原 maybeReprompInterruptedTurn 內聯邏輯）。 */
function dispatchInterruptedTurn(state: SessionState, body: NonNullable<SessionState["lastPromptBody"]>, gen: number): void {
  fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
    method: "POST",
    headers: opencodeHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`status ${res.status}`)
      const cur = sessions.get(state.sessionId)
      if (!cur || (cur.turnGen ?? 0) !== gen) return // 新消息已進來，本條讓位
      console.log(`[gateway] N1 reprompt dispatched: session=${cur.sessionId} gen=${gen}`)
      // N2：重投輪從零文本開始——剝掉舊 turn 文本幀，避免重連重放。
      stripStaleTurnTextFromReplay(cur)
      // 重投輪視為新 turn 活動：重置計數、重新布哨（watchdog/ack/心跳）。
      cur.turnTextChars = 0
      cur.turnReasoningChars = 0
      cur.turnUpstreamError = null
      cur.turnToolStarted = false
      cur.watchdogRetried = false
      cur.ackSent = true // 告知幀已發（上面那句），不再補 ack
      cur.lastTurnActiveAt = Date.now()
      cur.recoveryRound = true // R5-C：redrive 屬恢復輪
      markDirty(cur)
      armWatchdogTimer(cur)
      armHeartbeatTimer(cur)
    })
    .catch((e: unknown) => {
      console.error(`[gateway] N1 reprompt dispatch failed for ${state.sessionId}:`, e)
      const cur = sessions.get(state.sessionId)
      if (!cur || (cur.turnGen ?? 0) !== gen) return
      stashOrEmitRestoreNotice(cur, "自动重提失败（后端暂时不可达）。请稍后重新发送上一条消息即可继续。\n")
      emitToSession(cur, "turn.done", {})
      cur.lastTurnActiveAt = 0
      markDirty(cur)
    })
}

/**
 * R4-A S3②：lastPromptBody 不在持久化白名單（persistence.ts 只存白名單欄位，
 * R4 實錘：恢復後 body=undefined，重投降級成一句「请重新发送」且幀無人在線
 * 收不到——13 分鐘懸死）。從 opencode 權威歷史重推導：最後一條 user 消息即
 * 被斬 turn 的原文，重建 prompt 體重投。取不到 → 誠實降級 + turn.done 收尾。
 */
async function redriveInterruptedTurn(state: SessionState, gen: number): Promise<void> {
  let text = ""
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const msgs = (await res.json()) as Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>
      if (Array.isArray(msgs)) {
        const lastUser = [...msgs].reverse().find((m) => m?.info?.role === "user")
        text = (lastUser?.parts ?? [])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n")
          .trim()
      }
    }
  } catch (e) {
    console.error(`[gateway] N1 redrive: history fetch failed for ${state.sessionId}:`, e)
  }
  const cur = sessions.get(state.sessionId)
  if (!cur || (cur.turnGen ?? 0) !== gen) return // 用戶已發新消息，本條讓位
  if (!text) {
    // 重推導也失敗：誠實降級收尾（要求允許的「建議重發 + turn.done」出口）。
    console.warn(`[gateway] N1 redrive: could not re-derive prompt, honest fallback — session=${state.sessionId}`)
    stashOrEmitRestoreNotice(cur, "服务重启中断了上一条消息的处理，且无法自动重提。请重新发送一次即可继续。\n")
    emitToSession(cur, "turn.done", {})
    cur.lastTurnActiveAt = 0
    markDirty(cur)
    return
  }
  console.log(`[gateway] N1 redrive: re-derived interrupted prompt from opencode history (${text.length} chars), re-dispatching — session=${cur.sessionId}`)
  const body = { parts: [{ type: "text", text }] } as NonNullable<SessionState["lastPromptBody"]>
  body.model = personaModel(cur)
  cur.lastPromptBody = body // 補回投遞體：後續看門狗/抖動重試才有彈藥
  dispatchInterruptedTurn(cur, body, gen)
}

function maybeReprompInterruptedTurn(state: SessionState): void {
  const at = state.lastTurnActiveAt ?? 0
  if (!at || Date.now() - at > TURN_REPROMPT_WINDOW_MS) return
  if (repromptedSessions.has(state.sessionId)) return // 已處理過（雙恢復路徑）
  repromptedSessions.add(state.sessionId)
  const body = state.lastPromptBody
  const gen = state.turnGen ?? 0
  console.log(`[gateway] N1 reprompt: in-flight turn detected at restore (gen=${gen}, ${Math.round((Date.now() - at) / 1000)}s ago) — session=${state.sessionId}`)
  // 誠實告知先行（無論重投成敗，用戶都該知道發生過中斷）；無在線客戶端時
  // 暫存待 SSE 接入補投（R4-A S3②）。
  stashOrEmitRestoreNotice(state, "服务刚经历过一次重启，你上一条消息的处理被中断了。正在为你自动重新提交…\n")
  if (!body) {
    // R4 實錘缺口：lastPromptBody 未持久化 → 舊路徑在這裡只發一句降級話術
    // 就收工（且幀常無人在線收不到）。改為從 opencode 歷史重推導並重投。
    void redriveInterruptedTurn(state, gen)
    return
  }
  dispatchInterruptedTurn(state, body, gen)
}

// 內存 miss 時從 DB lazy reload（進程重啟後的會話恢復路徑）。
// 選 lazy 而非啟動全量載入：冷會話佔多數，lazy 免付啟動成本、不把殭屍
// session 釘在內存，且 reaper 的 idle 規則照常生效。
function hydrateFromDb(id: string): SessionState | null {  const row = loadSessionById(id)
  if (!row) return null
  const state = hydrateRow(row) as unknown as SessionState
  // 0831：hydrateRow（persistence.ts，本檔不改）不認得 sessionTasks，重啟恢復的 session
  // 該欄為 undefined；此處補空 Map，令所有下游 state.sessionTasks.* 存取安全（在途閘自然放行）。
  if (!state.sessionTasks) state.sessionTasks = new Map()
  sessions.set(state.sessionId, state)
  // 畫布快照回灌：DB 鏡像 → canvasStates，重啟後 /internal/canvas/snapshot
  // 仍能讀到完整節點/連線（TTL 重新起算，行為等同活躍畫布）。
  if (state.canvasSnapshot && typeof state.canvasSnapshot === "object") {
    canvasStates.set(state.sessionId, { state: state.canvasSnapshot, updatedAt: Date.now() })
  }
  // 工作流快照回灌（對齊 canvas 快照）：DB 鏡像 → workflowService，重啟後
  // /internal/workflow/status 仍能讀到該工作流的真實狀態。
  try {
    restoreWorkflowsFromSnapshot(state)
  } catch (e) {
    console.error(`[gateway] workflow restore failed for ${state.sessionId}:`, e)
  }
  console.log(`[gateway] session restored from db: ${state.sessionId} (opencode ${state.opencodeSessionId})`)
  maybeReprompInterruptedTurn(state)
  return state
}

function getOwnedSession(key: string, id: string): SessionState | null {
  const state = sessions.get(id) ?? hydrateFromDb(id)
  if (!state || state.apiKey !== key) return null
  state.lastActivityAt = Date.now()
  return state
}

// Mint an SSE ticket for a session the caller already owns.
function issueSseTicket(key: string, sessionId: string): string {
  const ticket = `st_${crypto.randomUUID().replace(/-/g, "")}`
  sseTickets.set(ticket, { sessionId, apiKey: key, expiresAt: Date.now() + SSE_TICKET_TTL_MS })
  return ticket
}

// Redeem a ticket for its session. Expiry is checked here rather than by a
// sweeper alone so a stale entry can never authenticate a stream.
function redeemSseTicket(ticket: string, sessionId: string): SessionState | null {
  const rec = sseTickets.get(ticket)
  if (!rec) return null
  if (rec.expiresAt <= Date.now()) {
    sseTickets.delete(ticket)
    return null
  }
  // Scoped to one session: a ticket for session A must not open session B.
  if (rec.sessionId !== sessionId) return null
  return getOwnedSession(rec.apiKey, sessionId)
}

function revokeSseTicketsFor(sessionId: string): void {
  for (const [ticket, rec] of sseTickets) {
    if (rec.sessionId === sessionId) sseTickets.delete(ticket)
  }
}

function findSessionByOpenCodeId(opencodeSessionId: string): SessionState | undefined {
  for (const state of sessions.values()) {
    if (state.opencodeSessionId === opencodeSessionId) return state
  }
  // 內存 miss：重啟後 opencode 事件 fan-out 仍能透過 DB 恢復 session 狀態，
  // 在途回合的後續事件照常進 replayBuffer。
  const row = loadSessionByOpencodeId(opencodeSessionId)
  if (!row) return undefined
  const state = hydrateRow(row) as unknown as SessionState
  // 0831：hydrateRow（persistence.ts，本檔不改）不認得 sessionTasks，重啟恢復的 session
  // 該欄為 undefined；此處補空 Map，令所有下游 state.sessionTasks.* 存取安全（在途閘自然放行）。
  if (!state.sessionTasks) state.sessionTasks = new Map()
  sessions.set(state.sessionId, state)
  if (state.canvasSnapshot && typeof state.canvasSnapshot === "object") {
    canvasStates.set(state.sessionId, { state: state.canvasSnapshot, updatedAt: Date.now() })
  }
  try {
    restoreWorkflowsFromSnapshot(state)
  } catch (e) {
    console.error(`[gateway] workflow restore failed for ${state.sessionId}:`, e)
  }
  console.log(`[gateway] session restored from db (event fan-out): ${state.sessionId}`)
  maybeReprompInterruptedTurn(state)
  return state
}

function resolveSession(id: string): SessionState | undefined {
  // 三段解析：內存 → opencode id（fan-out 路徑）→ gateway id（DB 懶加載）。
  // 第三段是 2026-08-27 畫布快照修復的一部分：重啟後用 gateway session id
  // 查 /internal/canvas/snapshot 也要能觸發 DB 恢復（含 canvasStates 回灌），
  // 否則只有 opencode id 形式的查詢能恢復。
  const state = sessions.get(id) ?? findSessionByOpenCodeId(id) ?? hydrateFromDb(id)
  if (state) state.lastActivityAt = Date.now()
  return state
}

// ─── S2b（2026-08-27）：出站文本內部框架段剝離 ───
// 評測實錘：assistant 出站文本反覆出現 ## Objective / ## Work State /
// ## Next Move / ## Relevant Files 四個內部框架段——這是 agent 大腦的工作
// 狀態骨架，不是給用戶的正文。在出站路徑（message.delta 發射前）按行剝離：
// 標題行起刪，直到下一個非內部 markdown 標題或文本結束。行級狀態機 + 尾行
// 扣留（未見換行不外發），保證不切爛正文句子、也不因 delta 邊界拆漏標題。
// R2-C①（2026-08-27）：內部框架段擴到第二批——## Important Details /
// ### Completed / ### Active / ### Blocked（評測 event 208 起實錘泄漏）。
// 全部是 ASCII 詞組精確匹配 + 行尾錨定，中文字節永不命中 \w 詞表，不誤傷中文標題。
const INTERNAL_SECTION_HEADING_RE = /^#{1,6}[ \t]*(objective|work state|next move|relevant files|important details|completed|active|blocked)[ \t]*:?[ \t]*$/i
const ANY_HEADING_RE = /^#{1,6}[ \t]/
type PartStripState = { pending: string; suppress: boolean; fence: boolean; sawEnglish: boolean }

// ── R4-A S1（2026-08-28）：英文正文守門 ──
// R4 實錘（死線一）：message.delta 出現成段英文 reasoning（event 5180 "The
// Chapter 1 narrative begins at line 97…"、5540-5543 "Let me check…"）。
// 硬要求：中文內容不丟、不調 LLM 重寫、代碼塊與引文不誤傷。取最小可信方案：
// 行級檢測（複用 S2b 行狀態機，長行同樣等 \n 完整再判）——無 CJK、非引文
//（> 開頭）、非鏈接、非表格行，且英文詞數達標（≥5 詞且句末有標點，或 ≥8 詞）
// 判為英文成句正文 → 整行壓制，發一幀一次性中文提示替代。書名/章節列表行
//（無句末標點）與代碼柵欄內容直通。短行（術語/標識符/型號）永不命中。
function isEnglishProseLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/[\u4e00-\u9fff]/.test(t)) return false // 任何中文 → 放行（硬要求：中文不丟）
  if (t.startsWith(">")) return false // markdown 引文 → 放行
  if (t.startsWith("|")) return false // 表格行 → 放行
  if (/https?:\/\//.test(t)) return false // 鏈接行 → 放行
  const words = t.match(/[A-Za-z]{2,}/g)
  const n = words ? words.length : 0
  if (n < 5) return false
  if (n >= 8) return true
  return /[.!?…]["')\]]?$/.test(t) // 5-7 詞僅在成句（句末標點收尾）時判定
}

// ── R5-C（2026-08-28）：繁體正文轉簡體守門 ──
// 站點文案一律簡體是硬規範。正文行（非柵欄/引文/表格/鏈接——這些在上游已
// 放行不進轉換）檢出繁體常用字 → 按高频繁简映射表逐字轉換。VPS/本機均無
// opencc（已核實 gateway node_modules），按規格用精簡高頻表；(繁,简) 二字
// 一組串接；未收錄的罕用字原樣保留，不猜測不誤轉。
const T2S_PAIRS =
  "這这裡里裏里後后時时間间會会來来對对開开關关門门電电話话說说請请謝谢應应該该當当處处動动靜静聽听寫写讀读學学練练體体飛飞車车馬马鳥鸟魚鱼龍龙鳳凤樹树葉叶華华國国圖图書书畫画藝艺術术醫医藥药錢钱銀银買买賣卖貴贵質质費费資资億亿遠远運运進进過过達达選选邊边還还鄉乡長长麼么麗丽義义樂乐橋桥樣样檔档機机構构業业歷历歸归歲岁殘残湯汤溫温無无為为烏乌燒烧热热愛爱親亲個个價价儀仪兒儿內内冊册幾几廠厂廣广強强復复複复徵征憶忆懷怀戲戏掛挂揚扬揮挥擊击據据擴扩攝摄數数斷断舊旧顯显條条標标檢检欄栏權权歐欧濟济營营環环發发髮发眾众優优傳传傷伤僅仅儘尽務务勝胜匯汇區区協协單单嚴严圓圆壓压廢废從从執执場场塊块壯壮夢梦奮奋婦妇媽妈孫孙實实寧宁寶宝專专導导層层屬属島岛幣币幹干廳厅張张彈弹彎弯徑径戰战擔担擁拥攔拦敵敌於于顧顾鏡镜頭头繼继續续閒闲額额語语譯译課课論论護护議议訊讯記记講讲認认訓训設设訪访評评詞词試试詩诗調调談谈誠诚誤误誰谁諾诺變变讓让讚赞計计財财貨货貧贫賽赛贈赠跡迹軍军輕轻較较載载輸输辦办辭辞遲迟適适郵邮鄰邻鋼钢錄录錯错鍵键鎮镇鏈链鎖锁難难霧雾響响項项順顺須须領领頻频題题顏颜願愿類类顆颗風风飯饭養养館馆駐驻驗验鬆松鬧闹鳴鸣麥麦麵面點点黨党龜龟給给紐纽級级約约結结絕绝經经統统維维網网綜综線线緊紧總总縮缩織织紅红綠绿縣县紀纪純纯紙纸綱纲縱纵紛纷紹绍備备準准溝沟滅灭滾滚漢汉漸渐潔洁潑泼灑洒灣湾爺爷爾尔牆墙獲获獨独獸兽猶犹獻献產产畢毕殺杀殼壳毀毁滿满潛潜爛烂狀状獎奖禮礼筆笔稅税監监盡尽礙碍禍祸種种稱称穀谷穩稳窮穷竄窜節节範范簡简簽签籌筹糧粮臟脏與与艙舱萬万萊莱蓋盖蔣蒋蕭萧薦荐藍蓝蠻蛮褲裤視视覺觉覽览觸触誇夸誼谊誦诵諸诸謀谋謂谓謙谦謹谨證证豈岂貓猫賓宾賈贾賊贼賠赔賦赋賭赌賴赖贏赢趙赵趕赶躍跃軌轨軒轩軟软軸轴輛辆輩辈輪轮輯辑轉转農农迴回連连週周遊游遷迁遺遗遼辽醜丑釀酿釋释鐘钟鋪铺鍋锅鐵铁鑽钻閃闪閉闭闆板隊队際际隨随隱隐雖虽雙双雜杂雞鸡離离靈灵韓韩頂顶頃顷預预頑顽頒颁頗颇顛颠飄飘飲饮饅馒餅饼餓饿餘余餵喂饋馈饒饶驅驱驚惊鬍胡鬥斗魯鲁鮮鲜兩两嚇吓櫃柜桿杆棄弃極极榮荣樓楼橫横補补裝装製制臺台颱台隻只誌志嘆叹團团圍围壞坏聲声妝妆尋寻幫帮慶庆彌弥徹彻態态懼惧掃扫擬拟攏拢擇择擋挡報报堅坚壇坛爾尔榮荣團团"
const T2S_MAP = new Map<string, string>()
for (let i = 0; i + 1 < T2S_PAIRS.length; i += 2) T2S_MAP.set(T2S_PAIRS[i]!, T2S_PAIRS[i + 1]!)
const T2S_RE = new RegExp(`[${Array.from(T2S_MAP.keys()).join("")}]`, "g")

/** 正文行繁→簡轉換：無映射命中原樣返回；有轉換時留 journal 證據行。 */
function t2sLine(line: string): string {
  if (!line) return line
  let converted = false
  const out = line.replace(T2S_RE, (c) => {
    converted = true
    return T2S_MAP.get(c) ?? c
  })
  if (converted) console.log(`[gateway] R5-C t2s: line converted: ${out.slice(0, 60)}`)
  return out
}

// ── R4-A S2（2026-08-28）：內部條款編號剝離 ──
// R4 實錘：正文出現「按 §3.8.3」「按 §3.8.2 默認使用…」——內部手冊編號不得
// 直達用戶。剝編號留語義：§\d+(\.\d+)* 整體替換為「内部规定」。
const SECTION_REF_RE = /按\s*§\s?\d+(?:\.\d+)*/g
const SECTION_TOKEN_RE = /§\s?\d+(?:\.\d+)*/g

/** 餵入一個 chunk，回傳可安全外發的文本（行未完整時扣留，可能回空串）。 */
function stripOutboundFeed(st: PartStripState, chunk: string): string {
  if (!chunk) return ""
  const lines = (st.pending + chunk).split("\n")
  st.pending = lines.pop() ?? "" // 最後一段是未完成行（無換行終結），扣留待判
  let out = ""
  for (const line of lines) {
    // 代碼柵欄：柵欄內容直通（S1 硬要求：代碼塊不誤傷）。
    if (st.fence) {
      out += line + "\n"
      if (/^\s*(```|~~~)/.test(line)) st.fence = false
      continue
    }
    if (/^\s*(```|~~~)/.test(line)) {
      st.fence = true
      out += line + "\n"
      continue
    }
    if (st.suppress) {
      // 內部段到下一個「非內部」標題為止；下一個內部段標題繼續吞
      if (ANY_HEADING_RE.test(line) && !INTERNAL_SECTION_HEADING_RE.test(line)) {
        st.suppress = false
        out += t2sLine(line) + "\n" // R5-C：正文行繁→簡
      }
      continue
    }
    if (INTERNAL_SECTION_HEADING_RE.test(line)) {
      st.suppress = true
      continue
    }
    // S1：成段英文正文 → 整行壓制，記錄待發中文提示。
    if (isEnglishProseLine(line)) {
      st.sawEnglish = true
      continue
    }
    // S2：內部條款編號剝離（留語義）+ R5-C 繁→簡守門。
    out += t2sLine(line.replace(SECTION_REF_RE, "按内部规定").replace(SECTION_TOKEN_RE, "内部规定")) + "\n"
  }
  return out
}

/** 回合/部件結束：殘留尾行按當前抑制狀態一次性判定（無換行終結，不再扣留）。 */
function stripOutboundFlush(st: PartStripState): string {
  const line = st.pending
  st.pending = ""
  if (!line) return ""
  if (st.fence) return line // 柵欄未閉合：尾部原樣吐出
  if (st.suppress) {
    if (ANY_HEADING_RE.test(line) && !INTERNAL_SECTION_HEADING_RE.test(line)) {
      st.suppress = false
      return t2sLine(line) // R5-C：正文行繁→簡
    }
    return ""
  }
  if (INTERNAL_SECTION_HEADING_RE.test(line)) {
    st.suppress = true
    return ""
  }
  if (isEnglishProseLine(line)) {
    st.sawEnglish = true
    return ""
  }
  return t2sLine(line.replace(SECTION_REF_RE, "按内部规定").replace(SECTION_TOKEN_RE, "内部规定"))
}

/** 統一出口：經剝離器後發 message.delta（無安全文本時靜默）。 */
function emitSanitizedDelta(state: SessionState, partId: string | undefined, chunk: string): void {
  const pid = typeof partId === "string" && partId ? partId : "_turn"
  let st = state.partStripState.get(pid)
  if (!st) {
    st = { pending: "", suppress: false, fence: false, sawEnglish: false }
    state.partStripState.set(pid, st)
    boundMap(state.partStripState, PART_TEXT_TRACK_CAP)
  }
  const safe = stripOutboundFeed(st, chunk)
  // S1：英文正文被壓制時，以一幀中文提示替代（每 turn 一次，不刷屏）。
  if (st.sawEnglish && !state.englishNoticeSent) {
    state.englishNoticeSent = true
    emitToSession(state, "turn.status", { text: "已自动略去一段英文内部思考，中文回复不受影响" })
  }
  if (safe) {
    emitToSession(state, "message.delta", { text: safe })
    // R8-B 工單 #5：模型正文到達 = 用戶可見輸出刷新（靜默通知判定依據）。
    state.lastUserVisibleAt = Date.now()
  }
}

// ─── S5a（2026-08-27）：供應商/上游錯誤人話化 ───
// 原文欄位（message 等）一律保留不刪；映射命中時在出站載荷加 human_message
// 中文短句。映射表按序匹配，第一條命中為準。
const SUPPLIER_ERROR_HUMANIZERS: Array<{ test: RegExp; human: string }> = [
  {
    // 2026-08-31：shuai（Cloudflare 前置）间歇性下发不完整证书链，Bun 报
    // "unable to verify the first certificate"；此类 TLS/连接抖动 failover 会
    // 自动换渠道重试，话术陈述已存在的自动行为。
    test: /unable to verify (?:the )?(?:first )?certificate|self signed certificate|socket connection was closed|unable to verify leaf signature|ERR_TLS/i,
    human: "上游模型服务的网络连接不稳定（证书校验/连接中断），系统已自动换渠道重试，无需你做任何操作。",
  },
  {
    test: /task\s*(?:was\s*)?not\s*found/i,
    human: "这个任务 ID 在平台查不到（ID 不完整或已过期）。不要凭记忆猜 ID：调用 image_get_result 不带参数即可取回本轮全部真实任务 ID 与 URL。",
  },
  {
    // R4 實錘（15:08:51）：14 萬字整段入上下文 → APIError "Input token exceed
    // the limit"，session.error 原文直出零中文。compaction 在 idle 自動觸發
    //（maybeCompactSession），此話術只陳述已存在的自動行為，不編造承諾。
    test: /input tokens? exceed/i,
    human: "输入内容太长，超出了模型单次可读的上限。我会在本轮结束后自动压缩上下文再继续；若反复出现，建议让我分章/分段处理。",
  },
  {
    test: /no enabled supplier capability matches/i,
    human: "该模型当前没有可用上游供给（可能不支持此尺寸或比例），请更换模型或调整尺寸后重试",
  },
  { test: /\b(time[ -]?out|timed[ -]?out|timeout)\b/i, human: "上游响应超时，请稍后重试" },
  // R5-C（2026-08-28）：真實上游原因條目。poll 類失敗（輪詢超時/502 網關）
  // 此前落入通用 timeout 或「执行失败，请重试或换一种方式」空話——用戶看不到
  // 真實原因。poll 條目必須排在通用 timeout 條目之前（"poll timeout" 含
  // timeout 詞會被通用條目搶先匹配）。
  {
    test: /\bpoll\b[^\n]{0,40}\b502\b|\b502\b[^\n]{0,40}\bpoll\b/i,
    human: "上游画图服务超时（poll 502），节点可在画布上重试",
  },
  {
    test: /\bpoll\b[^\n]{0,40}\b50[34]\b|\b50[34]\b[^\n]{0,40}\bpoll\b/i,
    human: "上游画图服务异常（poll 503/504），节点可在画布上重试",
  },
  {
    test: /\bpoll\b[^\n]{0,40}(time[ -]?out|timed[ -]?out)|(time[ -]?out|timed[ -]?out)[^\n]{0,40}\bpoll\b/i,
    human: "上游画图服务超时（poll 超时），节点可在画布上重试",
  },
  {
    // 0913 誠實歸因：附件本地路徑被 fetch 拒（“fetch() URL is invalid”）曾被兜底
    // 包成「上游原因：…請重試」，參數錯誤誤標上游故障、誘發模型盲目重試連環燒 turn。
    test: /url is invalid|failed to parse url/i,
    human: "图片地址无效（既不是可抓取的 URL，也不是可读的本地文件），属参数问题而非上游故障，重试无效：请传 http(s)/data URL、本地绝对路径或 media: 图片 ID。",
  },
  { test: /\bbad[ -]?gateway\b|\bhttp_?502\b/i, human: "上游网关错误（502 Bad Gateway），请稍后重试" },
  { test: /\bservice[ -]?unavailable\b|\bhttp_?503\b/i, human: "上游服务暂不可用（503），请稍后重试" },
  { test: /\bgateway[ -]?timeout\b|\bhttp_?504\b/i, human: "上游网关超时（504），请稍后重试" },
  { test: /\b(fetch failed|econnreset|econnrefused|socket hang[ -]?up|network error)\b/i, human: "上游连接中断（网络错误），请稍后重试" },
  {
    test: /\b(overload|overloaded|capacity[_ -]?saturated|rate[ -]?limit|too many requests|http_?429|429)\b/i,
    human: "上游过载或限流，请稍后重试",
  },
  { test: /\b(insufficient[ _-]?(account[ _-]?)?(balance|credit)|quota exceeded|余额不足|欠费)\b/i, human: "上游余额或配额不足，请联系维护方" },
  { test: /\b(unauthorized|forbidden|invalid api key|authentication failed|http_?401|http_?403)\b/i, human: "上游供给认证失败，请联系维护方" },
  // R8-C（2026-08-29）：用戶主動中止（opencode 回 "Tool execution aborted" /
  // "Aborted"）不是失敗，此前漏映射 → 原樣包成「执行失败（上游原因：…）」英文
  // 黑話甩給用戶。補專屬人話：中止 ≠ 失敗。
  { test: /\b(aborted|cancel(?:led|ed) by user|interrupted by user)\b/i, human: "已按你的要求中止本轮" },
]

/** 英文供應商錯誤 → 中文短句；未命中回空串。 */
function humanizeSupplierError(message: string): string {
  if (!message) return ""
  for (const h of SUPPLIER_ERROR_HUMANIZERS) if (h.test.test(message)) return h.human
  return ""
}

/** 必得中文短句：映射命中 → 映射文；本身就是中文 → 原文；否則帶真實上游
 *  原因原文（截斷）——R5-C：兜底禁止只剩「执行失败，请重试或换一种方式」空話。 */
function humanMessageFor(message: string, code?: string): string {
  // 0831 誠實歸因：本站自己的 404 曾被兜底包成「上游原因」，誤導用戶與模型連環重試。
  if (code === "task_not_found") {
    return "这个任务 ID 在平台查不到（ID 不完整或已过期）。不要凭记忆猜 ID：调用 image_get_result 不带参数即可取回本轮全部真实任务 ID 与 URL。"
  }
  if (code === "result_not_ready") {
    return "任务仍在生成中，harness 会自动续接，无需重复查询。"
  }
  // 已是中文人話（工具/站點自己寫的 hint）不再套「上游原因」外殼。
  if (/[\u4e00-\u9fff]/.test(message)) return message
  const mapped = humanizeSupplierError(message)
  if (mapped) return mapped
  if (/[\u4e00-\u9fff]/.test(message)) return message
  const brief = message.length > 160 ? message.slice(0, 160) + "…" : message
  return `执行失败（上游原因：${brief}）。请重试或换一种方式`
}

function summarizeArgs(args?: unknown): string {
  if (!args) return ""
  if (typeof args !== "object") {
    const t = String(args)
    return t.length > 500 ? t.slice(0, 500) + "…" : t
  }
  if (Object.keys(args as Record<string, unknown>).length === 0) return ""
  let s: string
  try {
    s = JSON.stringify(args)
  } catch {
    s = String(args)
  }
  return s.length > 500 ? s.slice(0, 500) + "…" : s
}

// ---- SSE helpers (gateway -> frontend) ----

function serializeSse(name: string, data: unknown, eventId: number): string {
  const payload = JSON.stringify({ ...(data as Record<string, unknown>), event_id: eventId })
  return `id: ${eventId}\nevent: ${name}\ndata: ${payload}\n\n`
}

/** 修 1（2026-09-01）：內容/產物幀 = 殭屍还魂的證據。watchdog 死亡宣告後，
 *  這些幀到達說明重投 retry 真的在產出——「後端無響應」是誤判，必須撤回。 */
function isRevivalFrame(name: string): boolean {
  return (
    name === "message.delta" ||
    name === "reasoning.delta" ||
    name === "image.done" ||
    name === "video.done" ||
    name.startsWith("tool.") ||
    name.startsWith("canvas.")
  )
}

function emitToSession(state: SessionState, name: string, data: unknown): void {
  // 修 1（2026-09-01）：死亡宣告可撤回。deathDeclared 期間第一條內容幀到達
  // → 先發一次性撤回幀（turn.status，與 watchdog 告警同通道，前端零改動），
  // 立即清位（防重複撤回/防遞歸），再放行原內容幀。
  if (state.deathDeclared && isRevivalFrame(name)) {
    state.deathDeclared = false
    console.log(`[gateway] death declaration retracted: revival frame ${name} arrived — session=${state.sessionId}`)
    emitToSession(state, "turn.status", { text: "刚才的「后端无响应」是误判，任务已自动恢复，请继续等待本轮结果" })
  }
  // Agent-produced output counts as activity: a long generate with no client
  // polling must not look idle to the reaper while it is still working.
  state.lastActivityAt = Date.now()
  // R4-A S3①：turn 進度打點——錯誤停滯看門狗判定「錯誤後 turn 是否還活著」
  // 的依據。只認模型/工具幀（正文、工具出入參）；canvas 等狀態幀不算進度。
  if (name === "message.delta" || name === "reasoning.delta" || name === "tool.invoke" || name === "tool.result") {
    state.turnProgressAt = Date.now()
  }
  // R5-C 中段停滯哨：任何幀都算「還活著」的證據（canvas/confirm 狀態幀也算
  // ——只對連幀都沒有的凍結告警，長工具執行有進度幀就不誤殺）。
  state.turnLastFrameAt = Date.now()
  // R4-A S8：本 turn 內到達終態的節點採集——中央出口掛鉤，service.emit 與
  // 直接 emit 兩條 canvas.node.updated 路徑（成功+失敗）全收，兼容兩種載荷形狀。
  if (name === "canvas.node.updated") trackTurnNodeTerminal(state, data)
  state.eventCounter += 1
  const frame = encoder.encode(serializeSse(name, data, state.eventCounter))
  state.replayBuffer.push({ id: state.eventCounter, frame })
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
}

// ── N2（2026-08-27）：turn 重試不重放舊 turn 的文本幀 ──
// 根因（複測實錘 17:43:02）：watchdog/抖動重試重發 prompt 後，opencode 把
// 舊 turn 的 message.part.updated 全量補發（part.text 是累積全文），delta
// 路徑的 partTextEmitted 在 session.idle 已被清空 → 前綴當「新後綴」全部
// 重發，且這些重放幀進了 replayBuffer——SSE 斷線重連（Last-Event-ID）時
// 又整段重放一次（event 101-108+ 閃回）。
// 修法：重投 prompt 成功後，把 replayBuffer 裡本輪 gen 標記之前的
// message.delta / reasoning.delta 文本幀過濾掉（保留 canvas.* / confirm.* /
// tool.* / quota.* 等狀態類事件——它們冪等且前端靠它們恢復畫布），並同步
// persist 的 DB 行。新 turn 的文本從零開始計，斷線重連不會再看到舊文案。
function stripStaleTurnTextFromReplay(state: SessionState): void {
  const before = state.replayBuffer.length
  state.replayBuffer = state.replayBuffer.filter((f) => {
    // 幀文本形如 "id: N\nevent: NAME\ndata: {...}\n\n"——事件名在第二行。
    const head = decoder.decode(f.frame.subarray(0, Math.min(f.frame.length, 64)))
    const evMatch = head.match(/^id: \d+\nevent: ([a-z.]+)\n/)
    if (!evMatch) return true
    const ev = evMatch[1]
    if (ev === "message.delta" || ev === "reasoning.delta") return false
    return true
  })
  if (state.replayBuffer.length !== before) {
    console.log(
      `[gateway] N2: stripped ${before - state.replayBuffer.length} stale text frame(s) from replay buffer before retry — session=${state.sessionId}`,
    )
    markDirty(state)
  }
}

function closeSessionStreams(state: SessionState): void {
  for (const client of state.clients) {
    try {
      client.controller.close()
    } catch {
      // already closed
    }
  }
  state.clients.clear()
}

// ─────────────────────────── 畫布工作流引擎（暴君策略 v2）
//
// Deepseek 透過 workflow_* 工具填內容（參數/提示詞），本服務展開節點流並執行。
// 執行提交（image/video）由 submitWorkflowNode 完成（帶 session key）。

const workflowService = new WorkflowService({
  emit: (state, name, data) => {
    const target = (state as SessionState | undefined) ?? stateForWorkflow
    if (target) emitToSession(target, name, data)
    // S6 規格1：節點終態（success/error）幀 → 60s 內面向用戶的主動匯報。
    // 掛在 emit 轉發處：generate/rerun 兩條執行路徑共用此出口，一鉤全收。
    if (target && name === "canvas.node.updated") {
      // 修 2：節點失敗 → 退款留痕先行（匯報文案讀 billing 真值，須先記帳）。
      // 修 3：節點幀 = 進度打點，刷新喚醒登記表的停滯時鐘。
      const d = (data ?? {}) as { unit_id?: unknown; patch?: { status?: unknown } }
      const wfid = typeof d.unit_id === "string" ? d.unit_id : ""
      if (wfid && d.patch?.status === "error") recordWorkflowRefund(target, wfid)
      if (wfid && workflowWake.has(wfid)) workflowWake.get(wfid)!.lastProgressAt = Date.now()
      try {
        reportNodeTerminalState(target, data as Parameters<typeof reportNodeTerminalState>[1])
      } catch (e) {
        console.error(`[gateway] S6 terminal report failed: ${e}`)
      }
    } else if (target && name.startsWith("canvas.") && workflowWake.size > 0) {
      // 修 3：canvas.node.generating 等非終態幀同樣算進度（節點開跑也是推進）。
      const d = (data ?? {}) as { unit_id?: unknown }
      const wfid = typeof d.unit_id === "string" ? d.unit_id : ""
      if (wfid && workflowWake.has(wfid)) workflowWake.get(wfid)!.lastProgressAt = Date.now()
    }
  },
  // S5a：節點失敗人話化掛點（errorDetails 原文 + human_message 中文短句）。
  humanize: humanMessageFor,
  // S4（2026-08-27）：整圖幣耗估價掛點——canvas.plan 的 cost_hint 用。
  // 同步簽名：讀快取目錄；快取缺失時觸發後台刷新，本次回 null（下個 plan 幀
  // 就有值），不阻塞工作流搭建。與 /workflow/generate 門檻估算同一價目
  //（image = 目錄單價 × 1 張/節點，video = 檔位價 5/10 幣/秒（R5-C），model
  // 沿連線向上游 config 解析——與 estimateNodeCoins 完全同口徑）。
  estimateGraphCoins: (graph) => {
    let total = 0
    let sawAny = false
    for (const n of graph.nodes) {
      if (n.kind === "text" || n.kind === "config") continue
      sawAny = true
      if (n.kind === "video") {
        const secs = typeof n.metadata.duration_seconds === "number" && n.metadata.duration_seconds > 0 ? n.metadata.duration_seconds : 5
        total += secs * videoTierPerSecondSync(n, graph)
        continue
      }
      if (n.kind !== "image") continue // audio/film 0 幣
      const model = resolveNodeModel(n.id, n, graph)
      const v = priceCatalogCache?.prices[model]
      if (typeof v !== "number") return null // 有估不出的節點：整圖 null，不編數
      total += v
    }
    if (!sawAny) return null
    return Math.round(total * 1e6) / 1e6
  },
  // R8（2026-09-10 多鏡展開修復）：可用視頻模型動態選型掛點——大片 shotN_gen 不再
  // 寫死 minimax-h3（當前不可用），start 時查 /v1/model-status 選可用視頻模型
  //（輪子 = resolveActiveModel 同源判活；挑選邏輯與其 failover pool 同構：
  // media_type=video + available，按 24h 成功率排序取最優）。選不出回 null
  //（service 側回退引擎默認，submit 前仍有 F2 failover 兜底）。
  pickDefaultVideoModel: async (): Promise<string | null> => {
    const session = stateForWorkflow
    const apiKey = session?.apiKey
    if (!apiKey) return null
    const models = await fetchModelStatusCached(apiKey)
    if (!models) return null
    const pool = (models as Array<{ id: string; media_type?: string; availability?: string; last_24h?: { success_rate?: number } }>)
      .filter((m) => m.media_type === "video" && m.availability === "available")
    if (pool.length === 0) return null
    pool.sort((a, b) => (b.last_24h?.success_rate ?? 0.5) - (a.last_24h?.success_rate ?? 0.5))
    console.log(`[gateway] R8 default video model picked: ${pool[0].id} (available video pool=${pool.length})`)
    return pool[0].id
  },
  // 工作流持久化掛點（對齊 canvas 快照的 markDirty 模式）：狀態每次變更
  // （start/addNode/connect/generate 逐節點）鏡像進 owner session 並防抖落盤。
  onDirty: (wf) => {
    const owner = (wf.owner as SessionState | undefined) ?? null
    if (!owner || !owner.sessionId) return
    workflowOwnerBySession.set(owner.sessionId, wf.workflowId)
    owner.workflowSnapshot = workflowSnapshotOf(wf)
    markDirty(owner)
  },
  runNode: async (node, upstream, graph) => {
    const session = stateForWorkflow
    if (!session) return { nodeId: node.id, ok: false, error: "no active session" }
    // novel_film 配音環：真實 TTS 閉環（同步調用）；拼装（film）仍無上游。
    if (node.kind === "audio") {
      // 配音環：真實 TTS 閉環。取台詞文本（node.metadata 或上游 text 節點），
      // 同步調 TTS 上游；上游缺失時誠實報錯（不造假成功）。
      const meta = node.metadata as Record<string, unknown> | undefined
      const ttsText = String(meta?.text ?? meta?.content ?? meta?.prompt ?? "").trim()
      const probe = await probeTtsUpstream()
      if (!probe.available) {
        return { nodeId: node.id, ok: false, error: `配音（TTS）上游暂不可用：${probe.note}。此环節已編排入工作流，但无法真实生成音轨；请对用户如实说明。` }
      }
      const res = await fetch(`${TTS_UPSTREAM.base}${TTS_UPSTREAM.speechPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: TTS_UPSTREAM.model, input: ttsText || "（空台词）", voice: TTS_UPSTREAM.voice, response_format: "mp3" }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) return { nodeId: node.id, ok: false, error: `TTS upstream http_${res.status}` }
      const buf = await res.arrayBuffer()
      if (buf.byteLength < 64) return { nodeId: node.id, ok: false, error: "TTS upstream returned empty audio" }
      const id = `tts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
      const fileName = `${id}.mp3`
      await mkdir(TTS_AUDIO_DIR, { recursive: true })
      await Bun.write(path.join(TTS_AUDIO_DIR, fileName), buf)
      return { nodeId: node.id, ok: true, content: `${TTS_PUBLIC_BASE}/${fileName}`, costCoins: estimateTtsCoins("tts-zh", ttsText) }
    }
    if (node.kind === "film") {
      const r = await assembleFilmNode(node, upstream, graph)
      if (r.ok && r.content) void emitVideoDone(session, r.content, r.costCoins, node.id, "film")
      return r
    }
    const r = await submitWorkflowNode(session, node, upstream, graph)
    if (r.ok && r.content && node.kind === "video") void emitVideoDone(session, r.content, r.costCoins, node.id, "video")
    return r
  },
})

// runNode 需要目前的 session（key）。workflow 端點都是帶 session 呼叫的，執行前設入。
let stateForWorkflow: SessionState | null = null

// ---- 工作流持久化（2026-08-27 修復，與 canvasSnapshot 同構）----
// 根因：workflow 狀態只在內存 Map（workflowService.workflows），gateway 重啟即丟，
// 跑到一半的 8 環流水線徹底失聯；canvas 快照已持久化、工作流沒有——不一致。
// 修復：ActiveWorkflow 的可恢復子集鏡像進 owner session 的 workflowSnapshot
// 欄位（隨 session 防抖落盤），重啟懶加載時回灌 workflowService（running →
// error「服務重啟中斷」，不偽造還在跑）。單 session 只鏡像最新工作流——
// 同 session 反覆 start 屬異常路徑，覆蓋即止，不做多工作流列表。
// 前置聲明：markDirty 引用 workflowOwnerBySession，const 提升安全（僅在請求
// 處理時執行，遠晚於模組頂層求值）。
const workflowOwnerBySession = new Map<string, string>() // sessionId -> workflowId
// F1（2026-08-31）斷點續跑登記表：每進程每工作流只自動續跑一次，防循環重試。
const autoResumedWorkflows = new Set<string>()

// ── 修 2（2026-09-01）計費終態留痕 + billing 真值 ─────────────────────
// 實測實錘（會話 f340fcab/8b7dc1fd）：批量 confirm approved 25.001/75.001 幣後
// 節點失敗，ledger 零 refund 零 done，agent 卻對用戶說「未產生成功扣款」——
// 話術無帳本依據。本表記每工作流的批准/退款真值：
//   confirm approved 時記 confirmed；節點失敗時照抄 emitImageFailed 的
//   event:"refunded" 輪子寫 ledger 終態行 + 刷餘額；workflow_status 工具結果
//   注入 billing 對象，agent 話術只許引用真值。
interface WorkflowBillingTruth {
  confirmed_coins: number
  refunded_coins: number
  billing_status: "confirmed" | "refunded" | "settled"
}
const workflowBilling = new Map<string, WorkflowBillingTruth>()

/** 修 2：節點失敗 → 該工作流退款留痕（每工作流只記一次）+ 餘額刷新。 */
function recordWorkflowRefund(state: SessionState, wfid: string): void {
  const billing = workflowBilling.get(wfid)
  if (!billing || billing.refunded_coins > 0 || billing.confirmed_coins <= 0) return
  billing.refunded_coins = billing.confirmed_coins
  billing.billing_status = "refunded"
  const wf = workflowService.get(wfid)
  void appendLedgerFor(state, {
    kind: "workflow",
    event: "refunded",
    task_id: wfid,
    model: `workflow:${wf?.templateId ?? "unknown"}`,
    cost_coins: billing.confirmed_coins,
  })
  void emitQuotaChanged(state)
  console.log(`[gateway] workflow refund recorded: wf=${wfid} coins=${billing.confirmed_coins} session=${state.sessionId}`)
}

// ── 修 3（2026-09-01）長任務交接：喚醒登記表 + 掃描器 ──────────────────
// workflow_generate 提交後 turn 誠實結束；工作流到終態或停滯（15 分鐘無節點
// 進度）時向原會話投 resume 喚醒（輪子 = handleResumeSession 的 prompt_async
// 投遞 + turn 狀態重置）。掃描器是進程內唯一的 workflow 狀態觀察點——
// workflowService.generate 的 promise 在 runWfGenerate 手裡，poller 摸不到
// 內存工作流狀態，故掛 gateway 不掛 poller（最小改動路徑）。
const workflowWake = new Map<string, { sessionId: string; lastProgressAt: number }>()
const WORKFLOW_STALL_MS = Number.parseInt(process.env.WORKFLOW_STALL_MS || "900000", 10) || 900_000
const WORKFLOW_WAKE_SCAN_MS = 60_000

type PersistableWorkflow = {
  workflowId: string
  templateId: string
  graph: { nodes: unknown[]; connections: unknown[] }
  status: string
  nodeStatus: Record<string, string>
  nodeContent: Record<string, string>
  nodeCost: Record<string, number>
}

/** ActiveWorkflow → 可 JSON 化快照（Set 去重狀態不持久——恢復後全部視為已發過，避免重啟後重推前端）。 */
function workflowSnapshotOf(wf: {
  workflowId: string
  templateId: string
  graph: { nodes: unknown[]; connections: unknown[] }
  status: string
  nodeStatus: Record<string, string>
  nodeContent: Record<string, string>
  nodeCost: Record<string, number>
}): PersistableWorkflow {
  return {
    workflowId: wf.workflowId,
    templateId: wf.templateId,
    graph: { nodes: wf.graph.nodes, connections: wf.graph.connections },
    status: wf.status,
    nodeStatus: { ...wf.nodeStatus },
    nodeContent: { ...wf.nodeContent },
    nodeCost: { ...wf.nodeCost },
  }
}

/** markDirty 用：取該 session 當前工作流的最新快照；工作流已不在內存 → 保留舊鏡像（清 null）。 */
function workflowSnapshotFor(state: SessionState): Record<string, unknown> | undefined {
  const wfid = workflowOwnerBySession.get(state.sessionId)
  if (!wfid) return undefined
  const wf = workflowService.get(wfid)
  if (!wf) return state.workflowSnapshot // 已被清掉：保留最後已知狀態
  return workflowSnapshotOf(wf)
}

/**
 * DB 快照 → ActiveWorkflow 回灌（hydrate 路徑，對齊 canvasSnapshot → canvasStates）。
 * 語義：中斷時正在 running 的節點標 error（reason「服務重啟中斷」）——重啟後的
 * status 回應必須是真實狀態，不偽造還在跑。emit 去重集合全量視為已發（重啟後
 * generate 補發只走漏網兜底，不對已恢復節點重播）。
 */
function restoreWorkflowsFromSnapshot(state: SessionState): void {
  const snap = state.workflowSnapshot
  if (!snap || typeof snap !== "object") return
  const s = snap as Partial<PersistableWorkflow>
  if (typeof s.workflowId !== "string" || !s.workflowId) return
  if (workflowService.get(s.workflowId)) {
    workflowOwnerBySession.set(state.sessionId, s.workflowId)
    return // 已回灌過（冪等）
  }
  const graph = s.graph && typeof s.graph === "object" && Array.isArray((s.graph as { nodes?: unknown[] }).nodes) ? (s.graph as { nodes: unknown[]; connections?: unknown[] }) : null
  if (!graph) return
  const nodeStatus: Record<string, "pending" | "running" | "success" | "error"> = {}
  const interrupted: string[] = []
  for (const [id, st] of Object.entries(s.nodeStatus ?? {})) {
    if (st === "running") {
      // 服務重啟中斷：執行循環已死，這個節點不可能還在跑——誠實標錯，不偽造。
      nodeStatus[id] = "error"
      interrupted.push(id)
    } else if (st === "pending" || st === "success" || st === "error") {
      nodeStatus[id] = st
    }
  }
  const restored = {
    workflowId: s.workflowId,
    templateId: typeof s.templateId === "string" ? s.templateId : "custom",
    graph: { nodes: graph.nodes, connections: Array.isArray(graph.connections) ? graph.connections : [] },
    status: interrupted.length > 0 ? "failed" : (typeof s.status === "string" ? (s.status as "building" | "running" | "success" | "partial" | "failed") : "building"),
    nodeStatus,
    nodeContent: s.nodeContent && typeof s.nodeContent === "object" ? { ...s.nodeContent } : {},
    nodeCost: s.nodeCost && typeof s.nodeCost === "object" ? { ...s.nodeCost } : {},
    owner: state, // 重新綁定恢復後的 session 物件（舊 owner 已隨重啟消失）
    planEmitted: true,
    emittedNodes: new Set((graph.nodes as { id?: unknown }[]).map((n) => (typeof n?.id === "string" ? n.id : "")).filter(Boolean)),
    emittedConnections: new Set(((Array.isArray(graph.connections) ? graph.connections : []) as { from?: unknown; to?: unknown }[]).map((c) => `${c?.from}->${c?.to}`)),
  }
  // 同步鏡像回 session：恢復後的快照（running→error 轉換）也要落盤，
  // 否則下次重啟又會把同一批 error 節點當 running 再轉一次（結果冪等但狀態漂移）。
  state.workflowSnapshot = workflowSnapshotOf(restored)
  workflowService.restore(restored as never)
  workflowOwnerBySession.set(state.sessionId, restored.workflowId)
  dirtySessions.add(state.sessionId) // 恢復後的鏡像隨防抖落盤（running→error 轉換持久化）
  console.log(`[gateway] workflow restored from db: ${restored.workflowId} (${restored.templateId}, ${interrupted.length} interrupted node(s) -> error)`)
  // Q2/Q3（2026-08-27）：恢復不只寫日誌——中斷節點逐一翻面（畫布幽靈 running
  // → error）+ 一條面向用戶的說明消息（含已成功產物 URL 清單與已扣費，孤兒
  // 產物撈回）。emit 走 replayBuffer（emitToSession），前端 Last-Event-ID 續傳
  // 也能收到；不依賴任何人在線。
  if (interrupted.length > 0) {
    for (const nodeId of interrupted) {
      emitToSession(state, "canvas.node.updated", {
        node_id: nodeId,
        workflow_id: restored.workflowId,
        patch: {
          status: "error",
          errorDetails: "服务重启导致任务中断",
          human_message: "服务重启导致任务中断，中断节点未产生成功扣款；如已扣款以平台账单为准，可在画布上重试该节点。",
        },
      })
    }
    // 孤兒產物撈回：快照裡 success 的 image/video 節點，產物 URL 聚合交付。
    const nodesById = new Map(
      (graph.nodes as { id?: unknown; kind?: unknown; title?: unknown }[]).map((n) => [
        typeof n?.id === "string" ? n.id : "",
        n,
      ]),
    )
    const delivered: string[] = []
    let chargedCoins = 0
    for (const [id, st] of Object.entries(nodeStatus)) {
      if (st !== "success") continue
      const content = restored.nodeContent[id]
      if (typeof content !== "string" || !/^https?:\/\//.test(content)) continue
      const n = nodesById.get(id)
      const kind = typeof n?.kind === "string" ? n.kind : ""
      if (kind !== "image" && kind !== "video" && kind !== "audio" && kind !== "film") continue
      const title = typeof n?.title === "string" && n.title ? n.title : id
      delivered.push(`「${title}」${content}`)
      chargedCoins += typeof restored.nodeCost[id] === "number" ? (restored.nodeCost[id] as number) : 0
    }
    const parts = [
      `【服务重启说明】服务经历过一次重启，工作流（${restored.templateId}）有 ${interrupted.length} 个节点被中断，已在画布上标记为失败，可重试。`,
      delivered.length > 0
        ? `中断前已完成的 ${delivered.length} 个产物如下（已扣费共约 ${chargedCoins} 币）：\n${delivered.join("\n")}`
        : "中断前没有已完成的产物。",
    ]
    emitToSession(state, "message.delta", { text: parts.join("\n") + "\n" })
  }
  // F1（2026-08-31）斷點續跑：重啟時工作流還在跑（節點被中斷，或快照停在
  // running 但進程已死=殭屍 running）→ 恢復後自動續跑。generate() 自帶 R5-B
  // 重用語義：success 節點沿用產物不重跑不重扣，只補跑 error/pending。
  // 每進程每工作流只觸發一次（autoResumedWorkflows），失敗不循環重試；延遲
  // 1.5s 等 hydrate/SSE 重連先完成。paused/building 不自動續（等用戶決策）。
  const resumeWorthy = interrupted.length > 0 || restored.status === "running"
  if (resumeWorthy && !autoResumedWorkflows.has(restored.workflowId)) {
    autoResumedWorkflows.add(restored.workflowId)
    if (interrupted.length > 0) {
      emitToSession(state, "message.delta", {
        text: "【自动续跑】检测到上次执行被服务重启中断，正在从断点自动续跑：已成功的节点沿用产物不重跑、不重复扣费，仅补跑失败/未跑的节点。\n",
      })
    }
    const wfid = restored.workflowId
    setTimeout(() => {
      // F1 修（2026-08-31）：stateForWorkflow 由 /internal/workflow/* 請求入口賦值，
      // 離線恢復（重啟後無任何請求）時為 null → runNode 解析不到 session，image
      // 節點全滅 "no active session"。timer 內先補本 session 指針再續跑。
      stateForWorkflow = state
      void workflowService
        .generate(wfid)
        .then((r) => console.log(`[gateway] F1 auto-resume finished: ${wfid} -> ${r.status}`))
        .catch((e) => console.error(`[gateway] F1 auto-resume failed: ${wfid}`, e))
    }, 1500)
    console.log(`[gateway] F1 auto-resume scheduled: ${wfid} (interrupted=${interrupted.length})`)
  }
}

// R7-F（2026-08-29）：成片環後端——Kunpeng composeEngine 輪（gateway/editor/，
// pengfeiqiao/kunpeng pin 872a58b，白名單記賬見 repo vendor/kunpeng/PATCHES.md）。
// 沿連線收集上游 video 產物 → title 最前、shotN 升冪排序 → 下載 → setHarnessState
// 注入 clips（真實時長由 ffprobe 逐段探得）→ exportSelectedMainClips（歸一化→
// concat copy）→ probeRenderedVideo 校驗門 → 落公網目錄。拼接本身不另計費
//（costCoins: 0），視頻段費用已在各 shot 節點確認。
async function assembleFilmNode(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  upstream: Map<string, string>,
  graph?: { nodes: { id: string; role: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): Promise<{ nodeId: string; ok: boolean; content?: string; costCoins?: number; message?: string; error?: string }> {
  const nodeId = (node as { id?: string }).id || ""
  const incoming = (graph?.connections ?? []).filter((c) => c.to === nodeId).map((c) => c.from)
  const allVideoUpstream = incoming
    .map((from) => graph?.nodes.find((n) => n.id === from))
    .filter((n): n is { id: string; kind: string; metadata: Record<string, unknown> } => Boolean(n) && n.kind === "video")
  const sources = allVideoUpstream
    .map((n) => ({ id: n.id, url: upstream.get(n.id) }))
    .filter((s): s is { id: string; url: string } => Boolean(s.url))
  // 配音混流素材：上游 audio 節點（TTS mp3）的內容 URL，成片後自動混入音軌。
  const audioList = incoming
    .map((from) => graph?.nodes.find((n) => n.id === from))
    .filter((n): n is { id: string; kind: string; metadata: Record<string, unknown> } => Boolean(n) && n.kind === "audio")
    .map((n) => upstream.get(n.id))
    .filter((u): u is string => Boolean(u))
  if (!sources.length) {
    return { nodeId, ok: false, error: "成片环没有已完成的镜头输入：请先完成各视频节点，再执行成片" }
  }
  // P0-B 硬閘門（2026-08-31）：宣告的鏡頭數（上游 video 節點總數）必須等於實際拿到
  // 產物的數量。缺一個都不能拼——修復本次事故「宣告4鏡頭、實際1鏡頭仍標success」。
  if (sources.length < allVideoUpstream.length) {
    const missing = allVideoUpstream.filter((n) => !upstream.get(n.id)).map((n) => n.id)
    return {
      nodeId,
      ok: false,
      error: `成片环鏡頭數量不足：宣告 ${allVideoUpstream.length} 個鏡頭，僅 ${sources.length} 個完成（缺：${missing.join("、")}）。请先完成全部鏡頭節點再执行成片`,
    }
  }
  const orderOf = (id: string): number => {
    if (id.includes("title")) return -1
    const m = id.match(/shot(\d+)/)
    return m ? Number(m[1]) : 900
  }
  sources.sort((a, b) => orderOf(a.id) - orderOf(b.id))

  const { setHarnessState, DEFAULT_EXPORT_SETTINGS } = await import("./editor/adapter/editorStore")
  const { exportSelectedMainClips, probeRenderedVideo } = await import("./editor/composeEngine")
  const { detectFfmpeg } = await import("./editor/canvas/videoCompose")
  const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`
  const { invoke } = await import("./editor/adapter/tauri-adapter")

  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) return { nodeId, ok: false, error: "未检测到 ffmpeg：成片拼接后端不可用" }

  const workDir = path.join(TTS_AUDIO_DIR, `film-src-${Date.now()}`)
  await mkdir(workDir, { recursive: true })
  try {
    const clipIds: string[] = []
    const clipSecs: number[] = []
    let totalInputSec = 0
    for (let i = 0; i < sources.length; i += 1) {
      const clipPath = path.join(workDir, `clip_${i}.mp4`)
      // 平台產物 URL 直接映射本盤路徑（store.tinchak0207.xyz = image-data-api 的公網面，
      // VPS 內 fetch 公網回環慢且不穩）；非平台 URL 才走網絡下載。
      const diskBase = "/opt/image-data-api/data"
      const m = sources[i].url.match(/^https:\/\/store\.tinchak0207\.xyz\/image-data\/files\/(.+)$/)
      if (m) {
        const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join(diskBase, m[1]))} ${shq(clipPath)}`, timeoutMs: 30000 })
        if (cp.exit_code !== 0) return { nodeId, ok: false, error: "成片环读取镜头素材失败（本地产物缺失）" }
      } else {
        const res = await fetch(sources[i].url, { signal: AbortSignal.timeout(120_000) })
        if (!res.ok) return { nodeId, ok: false, error: `成片环下载镜头素材失败（http ${res.status}）` }
        await Bun.write(clipPath, res)
      }
      const probe = await invoke<CommandResult>("execute_command", {
        command: `${ffmpeg.replace(/ffmpeg$/, "ffprobe")} -v error -show_entries format=duration -of csv=p=0 ${shq(clipPath)}`,
        timeoutMs: 15000,
      })
      const dur = Number.parseFloat((probe.stdout || "").trim())
      const sec = Number.isFinite(dur) && dur > 0 ? dur : 0
      if (sec <= 0) return { nodeId, ok: false, error: "成片环读不到镜头时长（ffprobe 失败），拒绝盲拼" }
      totalInputSec += sec
      clipIds.push(`h${i}`)
      clipSecs.push(sec)
    }
    setHarnessState({
      clips: sources.map((_, i) => ({
        id: `h${i}`,
        path: path.join(workDir, `clip_${i}.mp4`),
        label: `seg${i}`,
        duration: clipSecs[i],
        inSec: 0,
        outSec: clipSecs[i],
        transitionAfter: { type: "none", duration: 0 },
      })),
      aspect: "16:9",
      exportSettings: { ...DEFAULT_EXPORT_SETTINGS, resolution: "720p", fps: 24 },
    })
    const outPath = await exportSelectedMainClips(clipIds)
    const probe = await probeRenderedVideo(ffmpeg, outPath)
    // 校驗門：成片時長不得低於各段輸入時長總和的 90%（歸一化重編碼允許微小誤差）
    const minSec = Math.floor(totalInputSec * 0.9)
    if (probe.durationSec < minSec) {
      return { nodeId, ok: false, error: `成片校验未通过：成片 ${probe.durationSec}s 低于输入总长 ${totalInputSec}s 的 90%` }
    }
    // 配音混流（2026-08-30）：audioList 非空時把 TTS 音軌混進成片。禁 -shortest
    //（不准截斷視頻）；混流任何一步失敗降級純視頻成片，message 註明，不整單報錯。
    let mixedPath = outPath
    let mixNote = ""
    if (audioList.length > 0) {
      try {
        const audioPaths: string[] = []
        let totalAudioSec = 0
        for (let i = 0; i < audioList.length; i += 1) {
          const aPath = path.join(workDir, `audio_${i}.mp3`)
          // 平台產物 URL 直接映射本盤路徑（同鏡頭素材 fast-path 口徑）；其餘走網絡下載。
          const mTts = audioList[i].match(/^https:\/\/store\.tinchak0207\.xyz\/agent\/v1\/audio\/([^/?#]+)$/)
          const mDisk = audioList[i].match(/^https:\/\/store\.tinchak0207\.xyz\/image-data\/files\/(.+)$/)
          if (mTts && !mTts[1].includes("..")) {
            const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join(TTS_AUDIO_DIR, mTts[1]))} ${shq(aPath)}`, timeoutMs: 30000 })
            if (cp.exit_code !== 0) throw new Error("平台音頻本盤缺失")
          } else if (mDisk && !mDisk[1].includes("..")) {
            const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join("/opt/image-data-api/data", mDisk[1]))} ${shq(aPath)}`, timeoutMs: 30000 })
            if (cp.exit_code !== 0) throw new Error("平台音頻本盤缺失")
          } else {
            const res = await fetch(audioList[i], { signal: AbortSignal.timeout(120_000) })
            if (!res.ok) throw new Error(`音頻下載失敗（http ${res.status}）`)
            await Bun.write(aPath, res)
          }
          audioPaths.push(aPath)
          const aProbe = await invoke<CommandResult>("execute_command", {
            command: `${ffmpeg.replace(/ffmpeg$/, "ffprobe")} -v error -show_entries format=duration -of csv=p=0 ${shq(aPath)}`,
            timeoutMs: 15000,
          })
          const aDur = Number.parseFloat((aProbe.stdout || "").trim())
          if (Number.isFinite(aDur) && aDur > 0) totalAudioSec += aDur
        }
        let trackPath = audioPaths[0]
        if (audioPaths.length > 1) {
          const listPath = path.join(workDir, "audio-list.txt")
          await Bun.write(listPath, audioPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n")
          trackPath = path.join(workDir, "audio-merged.m4a")
          const merged = await invoke<CommandResult>("execute_command", {
            command: `${ffmpeg} -y -f concat -safe 0 -i ${shq(listPath)} -c:a aac ${shq(trackPath)}`,
            timeoutMs: 120000,
          })
          if (merged.exit_code !== 0) throw new Error(`多軌合併失敗: ${(merged.stderr || "").slice(-200)}`)
        }
        const mixedOut = path.join(workDir, "film-mixed.mp4")
        const mixed = await invoke<CommandResult>("execute_command", {
          command: `${ffmpeg} -y -i ${shq(outPath)} -i ${shq(trackPath)} -map 0:v -map 1:a -c:v copy -c:a aac -movflags +faststart ${shq(mixedOut)}`,
          timeoutMs: 300000,
        })
        if (mixed.exit_code !== 0) throw new Error(`混流失敗: ${(mixed.stderr || "").slice(-200)}`)
        mixedPath = mixedOut
        // P0-B（2026-08-31）：配音時長明顯短於成片時長 = 覆蓋不足，本次事故音軌只有
        // 0.936 秒配 15.04 秒成片，混流「成功」但實質失能。不阻斷交付（降級不是硬
        // 失敗，跟現有「混流失敗降級純視頻」的寬容度一致），僅把警訊寫進 mixNote。
        if (totalAudioSec > 0 && totalAudioSec < probe.durationSec * 0.5) {
          mixNote = `配音时长（${totalAudioSec.toFixed(1)}s）明显短于成片时长（${probe.durationSec}s），已交付但音轨覆盖不足，请检查配音节点`
          console.log(`[workflow] assembleFilm audio too short: audio=${totalAudioSec}s film=${probe.durationSec}s`)
        }
      } catch (e) {
        mixNote = "配音混流失敗，已交付無音軌版本"
        console.log(`[workflow] assembleFilm audio mix degraded: ${String((e as Error).message ?? e).slice(0, 200)}`)
      }
    }
    const fileName = `film_${Date.now().toString(36)}.mp4`
    await mkdir(TTS_AUDIO_DIR, { recursive: true })
    await Bun.write(path.join(TTS_AUDIO_DIR, fileName), Bun.file(mixedPath))
    return { nodeId, ok: true, content: `${TTS_PUBLIC_BASE}/${fileName}`, costCoins: 0, ...(mixNote ? { message: mixNote } : {}) }
  } finally {
    const { rm } = await import("node:fs/promises")
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 提交單一節點生成：image → /v1/images/generations；video → /v1/videos/generations。
 * 非同步提交後輪詢（202 → task_id → GET {id} → succeeded → result url）。
 * 回傳 OpenAI 相容結果 {ok, content(url), costCoins?}。
 */
// INC-0830：沿連線找視頻節點上游連接的視頻 config 節點（kind=config 且 metadata.kind==="video"），
// 取其 duration_seconds——模板把時長配在 config 節點上，submit 時與 meta/shot 同為時長真源。
function resolveConnectedVideoDuration(
  nodeId: string,
  graph?: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): number | undefined {
  if (!graph) return undefined
  const cfgIds = graph.connections.filter((c) => c.to === nodeId).map((c) => c.from)
  for (const cid of cfgIds) {
    const cfg = graph.nodes.find((n) => n.id === cid)
    if (cfg && cfg.kind === "config" && cfg.metadata.kind === "video") {
      const d = cfg.metadata.duration_seconds
      if (typeof d === "number" && d > 0) return d
    }
  }
  return undefined
}

// F2（2026-08-31）：model-status 15s TTL 快取——舊版每個節點提交前都重新打一次
// /v1/model-status，長 workflow 節點多時等於每節點多一次探測延遲+一次上游打擾。
const MODEL_STATUS_TTL_MS = 15_000
let modelStatusCache: { at: number; models: Array<Record<string, unknown>> } | null = null

async function fetchModelStatusCached(apiKey: string): Promise<Array<Record<string, unknown>> | null> {
  const now = Date.now()
  if (modelStatusCache && now - modelStatusCache.at < MODEL_STATUS_TTL_MS) return modelStatusCache.models
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1/model-status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
    const data = await res.json().catch(() => null)
    const models = Array.isArray((data as { models?: unknown })?.models) ? ((data as { models: Array<Record<string, unknown>> }).models) : null
    if (models) {
      modelStatusCache = { at: now, models }
      return models
    }
  } catch {
    // 探測不可達：沿用舊快取（fail-open），完全沒快取則回 null 由呼叫方決定
  }
  return modelStatusCache?.models ?? null
}

/**
 * F2（2026-08-31）路由單真源 + 強制跨 provider failover：原邏輯發現模型
 * unavailable 就直接報錯要人手動換模型——這裡改成主動在同 media_type、不同
 * channel_id 的候選裡挑一個接著跑，找不到候選才誠實報錯（不編造成功）。
 * node.metadata.__triedChannels 記錄本節點已知死的渠道，跨重試/跨崩潰恢復
 * （隨 workflow 快照持久化）都不會再選回去。
 */
async function resolveActiveModel(
  model: string,
  kind: "image" | "video",
  apiKey: string,
  node: { metadata: Record<string, unknown> },
): Promise<{ model: string; switched: boolean; note?: string; exhausted?: boolean; error?: string }> {
  const models = await fetchModelStatusCached(apiKey)
  if (!models) return { model, switched: false } // 探測端不可達：fail-open，行為與舊版一致
  const entry = models.find((m) => (m as { id?: string }).id === model) as
    | { id: string; media_type?: string; availability?: string; channel_id?: string; note?: string; last_24h?: { success_rate?: number } }
    | undefined
  if (!entry || entry.availability !== "unavailable") return { model, switched: false }
  const tried = new Set<string>(Array.isArray(node.metadata.__triedChannels) ? (node.metadata.__triedChannels as string[]) : [])
  const currentChannel = typeof entry.channel_id === "string" ? entry.channel_id : undefined
  if (currentChannel) tried.add(currentChannel)
  const pool = (models as Array<{ id: string; media_type?: string; availability?: string; channel_id?: string; last_24h?: { success_rate?: number } }>)
    .filter((m) => m.media_type === kind && m.availability === "available")
    .filter((m) => !tried.has(typeof m.channel_id === "string" ? m.channel_id : `unknown:${m.id}`))
  if (pool.length === 0) {
    node.metadata.__triedChannels = [...tried]
    return {
      model,
      switched: false,
      exhausted: true,
      error: `模型 ${model} 不可用（${typeof entry.note === "string" ? entry.note : "渠道故障"}），且没有其他可用渠道可自动切换。请稍后重试或在画布上更换模型`,
    }
  }
  pool.sort((a, b) => (b.last_24h?.success_rate ?? 0.5) - (a.last_24h?.success_rate ?? 0.5))
  const chosen = pool[0]
  tried.add(typeof chosen.channel_id === "string" ? chosen.channel_id : `unknown:${chosen.id}`)
  node.metadata.__triedChannels = [...tried]
  return {
    model: chosen.id,
    switched: true,
    note: `[gateway] F2 failover: ${model}(${currentChannel ?? "?"}) unavailable -> ${chosen.id}(${chosen.channel_id ?? "?"})`,
  }
}

async function submitWorkflowNode(
  session: SessionState,
  node: { kind: string; metadata: Record<string, unknown> },
  upstream: Map<string, string>,
  graph?: { nodes: { id: string; role: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): Promise<{ nodeId: string; ok: boolean; content?: string; costCoins?: number; error?: string; lastAttempt?: Record<string, unknown> }> {
  const meta = node.metadata
  const nodeId = (node as { id?: string }).id || ""

  // 解析 prompt：優先 node.metadata，其次沿上游連線 BFS 找第一個有內容的 text 節點
  // （大片模板：角色描述 text → 四視圖 config → 各視圖 image；image 的 prompt 繼承自角色描述）
  function collectUpstreamPrompt(startId: string, depth = 0): string {
    if (depth > 4) return ""
    const direct = graph?.connections.filter((c) => c.to === startId).map((c) => graph.nodes.find((n) => n.id === c.from)).filter(Boolean)
    for (const n of direct ?? []) {
      const content = typeof n.metadata.content === "string" ? n.metadata.content : typeof n.metadata.prompt === "string" ? n.metadata.prompt : ""
      if (content.trim()) return content
    }
    for (const n of direct ?? []) {
      const found = collectUpstreamPrompt(n.id, depth + 1)
      if (found) return found
    }
    return ""
  }
  // prompt 解析移到 model/size 之後（shot JSON 需要 model 做按族編譯）

  // 模型解析三級：節點自身 metadata.model → 沿上游 config 節點鏈（與 estimateNodeCoins 報價同口徑）→ 兜底。
  // 視頻兜底必須是活路由模型（metaso/minimax-h3）；seedance-2.0 的唯一供應商 filmera 已 degraded，寫死即死單。
  let model = typeof meta.model === "string" && meta.model ? meta.model : resolveNodeModel(nodeId, node, graph ?? { nodes: [], connections: [] })
  if (node.kind === "video" && (!model || model === "pixai-tsubaki2")) model = "minimax-h3"
  // F2（2026-08-31）：提交前主動查活性+跨 provider failover（取代舊的「探測到
  // unavailable 就報錯」）。放在 shot 編譯之前——編譯要按實際會用的模型族來。
  const failoverResolved = await resolveActiveModel(model, node.kind === "video" ? "video" : "image", session.apiKey, node)
  if (failoverResolved.exhausted) {
    console.error(`[workflow] node ${nodeId} ${failoverResolved.error}`)
    return { nodeId: node.id, ok: false, error: failoverResolved.error! }
  }
  if (failoverResolved.switched) {
    console.log(failoverResolved.note)
    model = failoverResolved.model
    ;(node.metadata as Record<string, unknown>).model = model // 誠實紀律：後續重試/畫布顯示/計費都用實際路由到的模型
  }
  const size = typeof meta.size === "string" ? meta.size : "1024x1024"
  // 結構化 shot JSON 優先：video 節點 prompt 來自 shot JSON 時按模型族編譯成模型最愛的格式。
  let prompt = meta.prompt || meta.content || collectUpstreamPrompt(nodeId) || ""
  let shotSize = size
  let payloadDurationHint: number | undefined = undefined
  const shotCandidate = (parseShotCandidate(meta.shot) ?? parseShotCandidate(prompt)) as ShotJson | null
  if (node.kind === "video" && shotCandidate) {
    prompt = compileShotPrompt(shotCandidate, model)
    const shotParams = shotOutputParams(shotCandidate)
    if (shotParams.duration_seconds !== undefined && typeof meta.duration_seconds !== "number") payloadDurationHint = shotParams.duration_seconds
    if (shotParams.aspect_ratio && typeof meta.size !== "string") shotSize = shotParams.aspect_ratio
  }

  // 參考圖：上游中已完成且有 content 的 image 節點（角色圖/場景圖 → 影片參考）
  const refImages = graph
    ? graph.connections
        .filter((c) => c.to === nodeId)
        .map((c) => graph.nodes.find((n) => n.id === c.from))
        .filter((n): n is { id: string; kind: string; metadata: Record<string, unknown> } => Boolean(n) && n.kind === "image" && Boolean(upstream.get(n.id)))
        .map((n) => upstream.get(n.id)!)
    : []

  const endpoint = node.kind === "video" ? "/videos/generations" : "/images/generations"
  const payload: Record<string, unknown> = {
    prompt,
    model,
    size: shotSize,
    n: 1,
    response_format: "url",
  }
  if (node.kind === "video") {
    // INC-0830：時長三級解析 meta → shot → 連線的視頻 config；全部缺失時拒絕提交。
    // 舊版靜默 `?? 5` 是 5 秒片事故根因之一：暴君指定 15s、上游照 5s 出、按條統一價照收。
    const cfgDuration = resolveConnectedVideoDuration(nodeId, graph)
    const duration =
      typeof meta.duration_seconds === "number" && meta.duration_seconds > 0
        ? meta.duration_seconds
        : (payloadDurationHint ?? cfgDuration)
    if (typeof duration !== "number" || !(duration > 0)) {
      return {
        nodeId: node.id,
        ok: false,
        error:
          "视频节点缺少时长（duration_seconds）：节点参数、shot JSON output、连线的视频配置节点均未提供。上游按条统一计费（5s/15s 同价），缺时长会被按 5 秒出片。请在任一来源补上 duration_seconds 后重跑",
      }
    }
    payload.duration_seconds = duration
    if (refImages.length) payload.reference = refImages[0]
  } else if (refImages.length) {
    payload.reference = refImages[0]
  }

  if (!prompt) {
    console.error(`[workflow] node ${nodeId} (${node.kind}) has no prompt`)
    return { nodeId: node.id, ok: false, error: "缺少提示词：上游文本节点未填写内容" }
  }

  // F2（2026-08-31）：舊的「提交前探測 unavailable 就報錯」後置檢查已移到函式
  // 前段的 resolveActiveModel（主動 failover，不再是單純報錯）——此處不再重複探測。
  let taskSubmitted = false
  // INC-0830：輪詢響應裡的 attempts 明細（片A 加的 /v1/videos/{id} attempts 陣列）
  // 就地快取——失敗時隨節點錯誤回帶，畫布錯誤卡能看到真話（上游成沒成、誰的鍋）。
  // F1 修（2026-08-31）：聲明必須在函式級——原困在 poll 分支塊內，poll 預算耗盡後
  // 的 taskSubmitted 兜底引用它 → ReferenceError → 誤判 non-retryable → 死錯。
  let lastAttempt: Record<string, unknown> | undefined = undefined
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 202 || (res.ok && (data?.task_id || data?.id))) {
      taskSubmitted = true
      const taskId = data?.task_id ?? data?.id
      // INC-0830：把上游作業 id 記到節點 metadata.last_job_id——rerun 防重門與節點
      // error 真相都消費它，agent 不再盲跑重複扣費（事故根因之三）。
      try {
        ;(node.metadata as Record<string, unknown>).last_job_id = String(taskId)
      } catch {}
      const pollEndpoint = node.kind === "video" ? `/videos/${taskId}` : `/images/${taskId}`
      // 輪詢：間隔 3s；圖最多 120s、影片最多 300s（seedance 5 秒片可能排隊較久）
      // 2026-08-21（PM 要求）：預算按真實耗時放寬——實測 image 60-90s、kling 8s 影片 >300s
      // （Kling 標準模式約 2-6 分鐘）。video 200 次=600s，image 60 次=180s。
      const pollBudget = node.kind === "video" ? 200 : 60
      const startedAtMs = Date.now()
      const etaSeconds = node.kind === "video" ? 360 : 120
      const wfIdMatch = nodeId.match(/^(.+)-[^-]+-\d+$/)
      for (let i = 0; i < pollBudget; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        // 進度條：每 15s 推一次 elapsed/ETA（percent 封頂 95%，成功事件才是 100%）
        if (i % 5 === 4) {
          const elapsedSec = Math.round((Date.now() - startedAtMs) / 1000)
          const percent = Math.min(95, Math.round((elapsedSec / etaSeconds) * 100))
          const patch = { status: "running", progress: { elapsed_seconds: elapsedSec, eta_seconds: etaSeconds, percent } }
          emitToSession(session, "canvas.node.updated", {
            node_id: nodeId,
            ...(wfIdMatch ? { workflow_id: wfIdMatch[1] } : {}),
            patch,
          })
          applyCanvasNodeUpdated(session.sessionId, { node_id: nodeId, patch })
        }
        const poll = await fetch(`${PLATFORM_BASE}/v1${pollEndpoint}`, {
          headers: { Authorization: `Bearer ${session.apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        const pd = await poll.json().catch(() => ({}))
        const pdAttempts = (pd as { attempts?: unknown })?.attempts
        if (Array.isArray(pdAttempts) && pdAttempts.length > 0) lastAttempt = pdAttempts[pdAttempts.length - 1] as Record<string, unknown>
        if (pd?.status === "succeeded") {
          const rawUrl = pd?.data?.[0]?.url || pd?.result_url || pd?.url
          // 結果可能是相對 /v1/images/{id}/result，轉成絕對公開 URL（沿用 resolveResultUrl 語義）
          const url = rawUrl
            ? /^https?:\/\//.test(rawUrl)
              ? rawUrl
              : `${PLATFORM_BASE}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
            : ""
          if (url) return { nodeId: node.id, ok: true, content: url, costCoins: pd?.cost_coins }
          break
        }
        if (pd?.status === "failed") {
          console.error(`[workflow] node ${nodeId} generation failed: ${pd?.error?.message}`)
          return { nodeId: node.id, ok: false, error: pd?.error?.message || "generation failed", lastAttempt }
        }
        // R7-A（2026-08-29）失敗即翻面：供應商並發飽和時上游 job 會以 queued +
        // failure_detail（如 "capacity_saturated: ..."）反覆重試、遲遲不到終態 failed；
        // 舊邏輯只認 status==="failed"，明知上游已報失敗信號仍繼續發 running 進度幀，
        // 直到輪詢預算耗盡才報假話術。收到失敗信號立即翻面，不再空轉。
        const pdFail = pd as { failure_class?: unknown; failure_detail?: unknown; status?: unknown } | undefined
        const failSignal =
          typeof pdFail?.failure_class === "string" && pdFail.failure_class
            ? pdFail.failure_class
            : typeof pdFail?.failure_detail === "string" && pdFail.failure_detail
              ? pdFail.failure_detail
              : ""
        if (failSignal && pdFail?.status !== "succeeded") {
          console.error(`[workflow] node ${nodeId} upstream failure signal (${pdFail?.status}): ${failSignal}`)
          return {
            nodeId: node.id,
            ok: false,
            error: "生成失败：任务已提交但上游渠道未能执行（供应商并发满或排队超时）；可在画布上稍后重试或更换模型。若已扣款以平台账单为准",
            lastAttempt,
          }
        }
        if (poll.status >= 400 && poll.status !== 404) {
          console.error(`[workflow] node ${nodeId} poll ${poll.status}: ${(pd as { error?: { message?: string } })?.error?.message}`)
          return { nodeId: node.id, ok: false, error: `poll ${poll.status}`, lastAttempt }
        }
      }
    }
    // 同步回圖兜底
    const url = data?.data?.[0]?.url || data?.result_url || data?.url
    if (res.ok && url) return { nodeId: node.id, ok: true, content: url, costCoins: data?.cost_coins }
    if (taskSubmitted) {
      console.error(`[workflow] node ${nodeId} poll timeout`)
      return {
        nodeId: node.id,
        ok: false,
        error: "生成超时：任务已提交但上游渠道未能执行（供应商并发满或排队超时）；可在画布上稍后重试或更换模型。若已扣款以平台账单为准",
        lastAttempt,
      }
    }
    console.error(`[workflow] node ${nodeId} submit failed: ${JSON.stringify(data)}`)
    return { nodeId: node.id, ok: false, error: data?.error?.message || `submit ${res.status}` }
  } catch (e) {
    console.error(`[workflow] node ${nodeId} exception: ${(e as Error).message}`)
    return { nodeId: node.id, ok: false, error: (e as Error).message }
  }
}

// workflow 端點（不需 session）：列模板。
function workflowServiceTemplates(): Response {
  return Response.json({ ok: true, templates: workflowService.templates() })
}

// S4（2026-08-27）：已批准批量執行的 workflow 記錄（wfid → 批准時的估算額）。
// 語義：confirm 通過是「批准這一整批按此預算開跑」，workflow 內逐節點執行
// 不再重彈 confirm（預算單是事前告知，不取代逐筆扣費確認——但批量 confirm
// 已經是逐筆扣費確認的總閘門，雙重彈卡反而是打擾）。workflow 刪除/重跑
// 不清此記錄：同批重跑金額通常下降，重彈只會造成倒掛復辟。
const workflowGenerateApproved = new Map<string, { amount: number; nodes: number }>()

// 2026-08-29 整改（session 00c583ed 事故）：批量執行 confirm 的批准續跑註冊表。
// 舊版 /workflow/generate 在 handler 內聯 while 輪詢等用戶批准（最長
// CONFIRM_TIMEOUT_MS=15min），而 workflow_generate 工具層只有 10s AbortSignal——
// 用戶批准慢於 10s 是常態，工具必報 workflow_unreachable，agent 誤判「後端
// 不可達」棄模板轉手動逐鏡。改為非阻塞：彈卡 → 註冊回調 → 立即回
// confirm_pending；settleConfirm(approved) 觸發 runWfGenerate。
const wfGenerateContinuations = new Map<string, { state: SessionState; wfid: string; nodes: number; amount: number }>()

// 批量執行啟動器（含 S6 質詢凍結檢查）。兩個入口：/workflow/generate 免
// confirm 直呼路徑，與 wfGenerateContinuations 批准回調——凍結語義收攏在此，
// 兩個入口行為一致。
function runWfGenerate(state: SessionState, wfid: string): void {
  const wf = workflowService.get(wfid)
  if (!wf) return
  const hasVideoNode = wf.graph.nodes.some((n) => n.kind === "video")
  const interrogating =
    typeof state.lastUserMessage === "string" &&
    isInterrogativeMessage(state.lastUserMessage) &&
    state.ackTimer != null
  if (hasVideoNode && interrogating) {
    if (!state.pendingVideoWorkflows) state.pendingVideoWorkflows = []
    if (!state.pendingVideoWorkflows.includes(wfid)) state.pendingVideoWorkflows.push(wfid)
    console.log(`[gateway] S6 freeze: video workflow ${wfid} held during unanswered user question (session ${state.sessionId})`)
    return
  }
  // 修 3：登記喚醒——掃描器據此在終態/停滯時向原會話投 resume（長任務交接）。
  workflowWake.set(wfid, { sessionId: state.sessionId, lastProgressAt: Date.now() })
  void workflowService.generate(wfid).then((r) => {
    if (!r.ok) {
      // 預檢拒絕/早退路徑狀態未必到終態（如餘額預檢拒絕時 status 仍是
      // building）——註銷喚醒登記，拒絕原因已在上方 message.delta 如實播出。
      workflowWake.delete(wfid)
      console.warn(`[gateway] R5-C generate rejected: wf=${wfid} session=${state.sessionId} status=${r.status}`)
      const visible = /[\u4e00-\u9fff]/.test(r.status)
        ? r.status
        : `工作流未能启动（${r.status}）。请调整后重试。`
      emitToSession(state, "message.delta", { text: visible + "\n" })
      return
    }
    // 修 2：全節點成功 → billing 真值置 settled（帳實相符的終態）。
    if (r.status === "success") {
      const billing = workflowBilling.get(wfid)
      if (billing) billing.billing_status = "settled"
    }
    console.log(`[gateway] workflow ${wfid} finished ok`)
  })
}

// ── 修 3：長任務喚醒掃描器（60s 一輪）────────────────────────────────
// 終態（success/failed/partial/paused_insufficient_quota）或停滯（15 分鐘無
// 節點進度）→ 向原會話投 resume 喚醒，文案含各節點終態摘要 + billing 真值，
// 讓 agent 開一輪誠實匯報後收尾。turn 在途（ackTimer 掛著）時讓位——節點
// 事件正在直播，agent 自己會匯報；下一輪掃描再試。投遞/狀態重置逐行同
// handleResumeSession 的輪子（prompt_async + turn 重置 + 布哨）。
setInterval(() => {
  for (const [wfid, w] of workflowWake) {
    const state = sessions.get(w.sessionId)
    if (!state) {
      workflowWake.delete(wfid)
      continue
    }
    const wf = workflowService.get(wfid)
    if (!wf) {
      workflowWake.delete(wfid)
      continue
    }
    const terminal = wf.status !== "running" && wf.status !== "building" && wf.status !== "pending"
    const stalled = !terminal && Date.now() - w.lastProgressAt > WORKFLOW_STALL_MS
    if (!terminal && !stalled) continue
    if (state.ackTimer != null) continue // turn 在途讓位，下一輪掃描再喚
    // 停滯判死：卡在 running 的節點 patch 成畫布終態（error，與
    // workflow-service/emitImageFailed 的節點失敗形狀對稱）+ 走修 2 退款留痕。
    if (stalled) {
      console.warn(`[gateway] workflow stall: wf=${wfid} no progress for ${(WORKFLOW_STALL_MS / 60000) | 0}min, declaring stuck nodes dead`)
      for (const n of wf.graph.nodes) {
        if (wf.nodeStatus[n.id] !== "running") continue
        emitToSession(state, "canvas.node.updated", {
          unit_id: wfid,
          node_id: n.id,
          patch: {
            status: "error",
            errorDetails: "停滞超时：超过 15 分钟无任何进度推进，系统已按失败处理",
            human_message: "渲染停滞超过 15 分钟无推进，系统已将卡住的节点判死并按失败处理",
          },
        })
      }
      recordWorkflowRefund(state, wfid)
    }
    workflowWake.delete(wfid)
    // 喚醒文案：節點終態摘要（用戶可見名稱）+ billing 真值，agent 只許照實轉述。
    const money = workflowBilling.get(wfid)
    const moneyText = money
      ? `真实花费：已批准扣费 ${money.confirmed_coins} 币，${money.refunded_coins > 0 ? `失败部分已全额退回 ${money.refunded_coins} 币` : "无退款"}（billing_status=${money.billing_status}）。`
      : "真实花费：本工作流未走批量扣费确认（billing_status=none）。"
    const nodeList = wf.graph.nodes
      .filter((n) => n.kind !== "text" && n.kind !== "config")
      .map((n) => `${n.title || n.kind}：${wf.nodeStatus[n.id] ?? "未知"}`)
      .join("；")
    const head = stalled
      ? "工作流停滞已判死，系统自动唤醒你收尾。"
      : "工作流已到终态，系统自动唤醒你汇报。"
    const content =
      `${head}各节点终态：${nodeList || "无可执行节点"}。${moneyText}` +
      `请立即向用户汇报本次工作流的最终结果（成功产物、失败原因、真实花费与退款情况——一律引用上面的真实状态与 billing 真值，禁止编造），然后结束回合。禁止再用 bash sleep 或反复 workflow_status 轮询。`
    fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ ...beastAgentField(state), parts: [{ type: "text", text: content }] }),
      signal: AbortSignal.timeout(10000),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        state.lastPromptBody = { ...beastAgentField(state), parts: [{ type: "text", text: content }] }
        state.turnGen = (state.turnGen ?? 0) + 1
        state.turnTextChars = 0
        state.turnReasoningChars = 0
        state.turnRetries = 0
        state.turnAborted = false
        state.retryQueued = false
        state.turnUpstreamError = null
        state.turnToolStarted = false
        state.watchdogRetried = false
        state.questionAnsweredThisTurn = false
        state.deathDeclared = false
        armWatchdogTimer(state)
        console.log(`[gateway] workflow wake resumed: session=${state.sessionId} wf=${wfid}`)
      })
      .catch((e: unknown) => {
        console.error(`[gateway] workflow wake dispatch failed: session=${state.sessionId} wf=${wfid}:`, e)
      })
  }
}, WORKFLOW_WAKE_SCAN_MS)

// workflow 內部端點（loopback）：Deepseek 的 workflow_* 工具呼叫。
async function handleWorkflowInternal(req: Request, session: SessionState): Promise<Response> {
  // S4 修復（2026-08-27）：S6 質詢凍結段引用了未定義的 `state`（本 handler
  // 的參數名是 `session`）——/workflow/generate 一進 S6 分支即 ReferenceError 500。
  // 別名對齊語義（session 即 SessionState），一行修復，不動 S6 邏輯本身。
  const state = session
  const url = new URL(req.url)
  const pathname = url.pathname
  stateForWorkflow = session
  let body: Record<string, unknown> = {}
  if (req.method === "POST") {
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return jsonError(400, "invalid json body", "bad_request", "bad_request")
    }
  }

  const wf = (id: unknown) => {
    const s = typeof id === "string" ? workflowService.get(id) : undefined
    return s
  }

  if (pathname.endsWith("/workflow/templates") && req.method === "GET") {
    return Response.json({ ok: true, templates: workflowService.templates() })
  }
  if (pathname.endsWith("/workflow/start") && req.method === "POST") {
    const templateId = typeof body.template_id === "string" ? body.template_id : (typeof url.searchParams.get("template_id") === "string" ? url.searchParams.get("template_id") : null)
    // P0 idempotent workflow_start（2026-08-31 卡片堆積事故）：gateway 重啟 →
    // N1 redrive 重投上一條 prompt → agent 再次呼叫 workflow_start → 舊行為會
    // 新建第二套全新 id 的節點堆上畫布（大量卡片重疊 + 連線亂麻 + 整屏閃爍）。
    // 本檔既有設計已聲明「單 session 只鏡像最新工作流，反覆 start 屬異常路徑」，
    // 這裡把它落成硬守衛：同 session 已有同模板且未 success 的工作流 → 復用，
    // 不新建、不重發節點、不發歡迎詞；agent 據 reused/note 繼續推進或 rerun。
    const ownedWfId = workflowOwnerBySession.get(state.sessionId)
    if (ownedWfId && templateId) {
      const owned = workflowService.get(ownedWfId)
      if (owned && owned.templateId === templateId && owned.status !== "success") {
        console.log(`[gateway] workflow_start reused: session=${state.sessionId} wf=${ownedWfId} status=${owned.status} (P0 idempotent guard)`)
        return Response.json({
          ok: true,
          workflowId: ownedWfId,
          reused: true,
          status: owned.status,
          note: `该会话已存在同模板工作流（workflow_id=${ownedWfId}，status=${owned.status}），本次调用已复用，未新建任何节点。请勿再次调用 workflow_start；失败节点用 workflow_rerun 重跑，推进生成用 workflow_generate。`,
        })
      }
    }
    // S4：start 即發 canvas.plan（cost_hint 需目錄）——start 前同步預熱目錄
    //（帶上限 5s，失敗/超時照走：cost_hint 保守回 null，不擋搭建）。
    await Promise.race([
      catalogUnitCoins("pixai-tsubaki2", session.apiKey).catch(() => {}),
      new Promise((r) => setTimeout(r, 5000)),
    ])
    const rawContent = body.content && typeof body.content === "object" ? body.content : null
    const content = rawContent ?? (() => {
      // query 參數回退：?content={"role":{"content":"..."}}（URL-encoded JSON）
      const q = url.searchParams.get("content")
      if (!q) return {}
      try {
        const parsed = JSON.parse(q) as Record<string, unknown>
        return parsed && typeof parsed === "object" ? parsed : {}
      } catch {
        return null // 顯式標記無效：走模板缺內容報錯，不偽造空物件
      }
    })()
    if (content === null) return jsonError(400, "invalid content json (query or body)", "bad_request", "bad_request")
    // R8（2026-09-10）：start 改 async（shotN_gen 動態選可用視頻模型需 await
    // model-status 探測）——必須 await，否則「error in r」對 Promise 恆 false，
    // 缺內容 400 守衛失效。
    const r = await workflowService.start(templateId, content as never, session)
    if ("error" in r) return jsonError(400, r.error, "missing_content", "missing_content")
    // R5-C（2026-08-28）：模板啟動成功即 emit 零 LLM 歡迎詞（毫秒級，不過模型）。
    // 暴君規格：零內部話術、簡體、直接可執行。小說影視化模板用專屬文案；
    // 其餘模板用通用引導。走 emitAgentNotice（message 通道，前端零改動）。
    const wfId = typeof (r as { workflowId?: unknown }).workflowId === "string" ? (r as { workflowId: string }).workflowId : "?"
    const welcomeText =
      templateId === "novel_film"
        ? "欢迎你！这是「小说影视化」流水线：拆剧本 → 锁角色/场景资产 → 分镜关键帧 → 视频/配音/成片。请把小说文件发给我（txt / docx / pdf 都行），或直接粘贴文本。文件到手我会先列章节清单给你过目。\n"
        : "已为你搭好工作流画布。把素材或要求发给我，我会按环节推进，每个节点完成后逐条汇报。\n"
    emitAgentNotice(state, welcomeText)
    console.log(`[gateway] R5-C welcome emitted: template=${templateId} workflow=${wfId} session=${state.sessionId}`)
    return Response.json({ ok: true, ...r })
  }  if (pathname.endsWith("/workflow/node") && req.method === "POST") {
    const r = workflowService.addNode(
      typeof body.workflow_id === "string" ? body.workflow_id : "",
      typeof body.role === "string" ? body.role : "node",
      typeof body.kind === "string" ? body.kind : "image",
      typeof body.title === "string" ? body.title : "节点",
      body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {},
    )
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  if (pathname.endsWith("/workflow/connect") && req.method === "POST") {
    const r = workflowService.connect(typeof body.workflow_id === "string" ? body.workflow_id : "", typeof body.from === "string" ? body.from : "", typeof body.to === "string" ? body.to : "")
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  // workflow_disconnect 工具的 gateway 端路由（2026-08-30 補齊）——service 的
  // removeConnection（含 emittedConnections 去重清理 + canvas.node.disconnected
  // 廣播 + dirty 持久化）早已存在，此前只缺這條分發路由，工具層一律 404，
  // agent 無法拆換 cfg 組合。輪子 = 緊鄰的 connect 路由同構。
  if (pathname.endsWith("/workflow/disconnect") && req.method === "POST") {
    const r = workflowService.removeConnection(typeof body.workflow_id === "string" ? body.workflow_id : "", typeof body.from === "string" ? body.from : "", typeof body.to === "string" ? body.to : "")
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  // workflow_update_node 工具的 gateway 端路由——service 的 updateNode（含 BFS 下游
  // stale 標記 + canvas.node.updated 廣播 + dirty 持久化）早已存在，此前只缺這條
  // 分發路由，工具層一律 404，agent 中期換模型不可得（2026-08-30 秦始皇北極熊
  // 事故根因之一：舊 cfg minimax-h3 按 resolveNodeModel 首個 config 優先壓住新接
  // 的 seedance cfg，rerun 永遠解析回 H3）。輪子 = 緊鄰的 connect 路由同構。
  if (pathname.endsWith("/workflow/node/update") && req.method === "POST") {
    const r = workflowService.updateNode(
      typeof body.workflow_id === "string" ? body.workflow_id : "",
      typeof body.node_id === "string" ? body.node_id : "",
      body.patch && typeof body.patch === "object" ? (body.patch as Record<string, unknown>) : {},
    )
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  if (pathname.endsWith("/workflow/status") && req.method === "GET") {
    const wfid = url.searchParams.get("workflow_id") || (typeof body.workflow_id === "string" ? body.workflow_id : null)
    if (wfid && !workflowService.get(wfid) && state.workflowSnapshot && (state.workflowSnapshot as { workflowId?: unknown }).workflowId === wfid) {
      try {
        restoreWorkflowsFromSnapshot(state)
      } catch {
        // fall through：回灌失敗按 not found 誠實回報
      }
    }
    const st = wf(wfid)
    if (!st) return jsonError(404, "workflow not found", "not_found", "not_found")
    // 2026-08-30：工具回顯 resolved_model 依賴節點真實 metadata——service.status
    // 只回摘要（無 metadata），在此補上 graph 裡的 metadata（工具層才能算出真實
    // 解析模型，AI 無法自欺）。不讓 service 輪子動，gateway 端富化即可。
    const statusData = workflowService.status(wfid!) as { nodes: { id: string }[] }
    const metaMap = new Map<string, unknown>(st.graph.nodes.map((n: { id: string; metadata: unknown }) => [n.id, n.metadata ?? {}]))
    statusData.nodes = statusData.nodes.map((n) => ({ ...n, metadata: metaMap.get(n.id) ?? {} }))
    // 修 2：注入 billing 真值（批准額/退款額/狀態）——agent 計費話術的唯一依據。
    const billing = workflowBilling.get(wfid!)
    return Response.json({ ok: true, workflow: statusData, ...(billing ? { billing } : {}) })
  }
  if (pathname.endsWith("/workflow/status") && req.method === "POST") {
    // 重啟後恢復路徑：session 剛 hydrate、workflow 尚未回灌時（快照在 session 上），
    // 先回灌再查——status 永遠回真實狀態，不因恢復順序漏掉。
    const wfid = typeof body.workflow_id === "string" ? body.workflow_id : ""
    if (!workflowService.get(wfid) && state.workflowSnapshot && (state.workflowSnapshot as { workflowId?: unknown }).workflowId === wfid) {
      try {
        restoreWorkflowsFromSnapshot(state)
      } catch {
        // fall through：回灌失敗按 not found 誠實回報
      }
    }
    const st = wf(wfid)
    if (!st) return jsonError(404, "workflow not found", "not_found", "not_found")
    const statusData = workflowService.status(wfid) as { nodes: { id: string }[] }
    const metaMap = new Map<string, unknown>(st.graph.nodes.map((n: { id: string; metadata: unknown }) => [n.id, n.metadata ?? {}]))
    statusData.nodes = statusData.nodes.map((n) => ({ ...n, metadata: metaMap.get(n.id) ?? {} }))
    // 修 2：同 GET 路徑，注入 billing 真值。
    const billing = workflowBilling.get(wfid)
    return Response.json({ ok: true, workflow: statusData, ...(billing ? { billing } : {}) })
  }
  if (pathname.endsWith("/workflow/generate") && req.method === "POST") {
    const wfid = typeof body.workflow_id === "string" ? body.workflow_id : ""
    if (!workflowService.get(wfid)) return jsonError(404, "workflow not found", "not_found", "not_found")
    const wf = workflowService.get(wfid)!
    // S4 規格1（2026-08-27）：計費確認門檻改金額維度。舊世界 = 門檻倒掛：
    // 6.25 幣的批量 workflow 零確認直接開跑，1 幣的單筆重試反而彈卡——因為
    // confirm 只存在於工具層（image_* 單筆），workflow 批量執行完全繞過。
    // 統一基準：估算總價 ≥ CONFIRM_THRESHOLD_COINS（默認 5 幣）→ gateway
    // 直接向用戶彈 confirm.request，批准前不開跑（真拒絕窗口，不是同回合
    // 報價）；< 門檻免擾自動跑。估算口徑與 quote_bundle / cost_hint 同源
    //（目錄單價 × 數量 + 影片檔位價 5/10 幣/秒（R5-C））。估不出單價的節點計 0（目錄
    // 不可達時寧可放行小額，也不無限期卡死工作流——單筆扣費仍有工具層
    // confirm 兜底）。金額與本次估算寫回 workflow 記錄，避免重複批准：
    // 批准後 workflowGenerateApproved.set(wfid)，同批執行不二次彈卡。
    const executableNodes = wf.graph.nodes.filter((n) => n.kind !== "text" && n.kind !== "config")
    let estimatedTotal = 0
    for (const n of executableNodes) {
      const coins = await estimateNodeCoins(n, state.apiKey, wf.graph)
      if (coins !== null) estimatedTotal = Math.round((estimatedTotal + coins) * 1e6) / 1e6
    }
    // R9 擴計畫重確認：節點數比上次批准的多（agent 中途加節點）= 新一筆帳，
    // 必須按新總價重彈 confirm——2026-08-29 事故：批准時估 25 幣，中途長到
    // 5 支影片實扣 145 幣無人再問。
    const approvedBatch = workflowGenerateApproved.get(wfid)
    // 2026-08-31 计费诚实修复：批准快照原本只比节点数不比金额——同一批节点数不变但
    // 参数改变（如时长/档位）导致估价暴涨时不会重新弹卡。金额较上次批准增长超 10%
    //（容差避免浮点误差/目录轻微波动误触发）同样视为需要重新确认。
    const amountGrew = approvedBatch != null && estimatedTotal > approvedBatch.amount * 1.1
    if (estimatedTotal >= CONFIRM_THRESHOLD_COINS && (!approvedBatch || executableNodes.length > approvedBatch.nodes || amountGrew)) {
      const requestId = `wfgen_${wfid}_${Date.now().toString(36)}`
      const growthNote = approvedBatch
        ? amountGrew && executableNodes.length <= approvedBatch.nodes
          ? `（预估金额较上次批准由 ${approvedBatch.amount} 币涨到 ${estimatedTotal} 币，重新确认）`
          : `（节点数较上次批准新增 ${executableNodes.length - approvedBatch.nodes} 个，重新确认）`
        : ""
      const description = `批量执行工作流（${executableNodes.length} 个生成节点，${wf.templateId}），预估花费 ${estimatedTotal} 币${growthNote}`
      // 註冊後立即返回 confirm_pending（2026-08-29 整改：不再內聯阻塞輪詢——
      // 舊版等批准最長 15 分鐘，工具層 10s 超時必炸，agent 據此誤判後端死亡）。
      // 用戶批准 → settleConfirm → runWfGenerate 續跑；拒絕/過期 → 卡片自收，
      // 工作流不動，agent 可用 workflow_status 复核後再議。
      emitToSession(state, "confirm.request", { request_id: requestId, amount_coins: estimatedTotal, description })
      const timer = setTimeout(() => {
        wfGenerateContinuations.delete(requestId)
        settleConfirm(state, requestId, "expired")
      }, CONFIRM_TIMEOUT_MS)
      state.pendingConfirms.set(requestId, {
        timer,
        ledger: { amount_coins: estimatedTotal, model: `workflow:${wf.templateId}` },
      })
      wfGenerateContinuations.set(requestId, { state, wfid, nodes: executableNodes.length, amount: estimatedTotal })
      // 互动模式=auto：批量扣费确认自动批准。wfGenerateContinuations.set 必须先于
      // settleConfirm——settle 的 approved 分支会读该 map 触发 runWfGenerate 续跑。
      // R9 扩计划重确认在 auto 档同样自动放行（同一分支覆盖）。
      if (normalizeUserSettings(loadUserSettings(state.apiKey)).interaction_mode === "auto") {
        settleConfirm(state, requestId, "approved")
        return Response.json({ ok: true, status: "approved", request_id: requestId, note: `工作流已提交后台执行（workflow_id=${wfid}）。完成后系统会自动唤醒你汇报结果与真实花费。禁止用 bash sleep 或反复 workflow_status 等待；本轮现在总结已知状态并结束回合。` })
      }
      return Response.json({ ok: true, status: "confirm_pending", request_id: requestId, note: `已弹出批量扣费确认卡（预估 ${estimatedTotal} 币），用户批准后自动开跑。批准后系统会自动唤醒你汇报结果与真实花费；禁止用 bash sleep 或反复 workflow_status 等待，本轮现在总结已知状态并结束回合。` })
    }
    // S6 規格3：質詢凍結——最後一條用戶消息是質詢類且 assistant 尚未回覆
    //（ack timer 還掛著 = turn 在途）期間，含視頻節點的工作流不自動開跑
    //（圖片小額不凍結）。回答完成（session.idle）時 releasePendingVideoWorkflows
    // 放行。凍結只掛 workflow generate 自動開跑；手動單節點 rerun 不攔。
    const hasVideoNode = wf.graph.nodes.some((n) => n.kind === "video")
    const interrogating =
      typeof state.lastUserMessage === "string" &&
      isInterrogativeMessage(state.lastUserMessage) &&
      state.ackTimer != null // turn 在途：尚未 idle
    if (hasVideoNode && interrogating) {
      if (!state.pendingVideoWorkflows) state.pendingVideoWorkflows = []
      if (!state.pendingVideoWorkflows.includes(wfid)) state.pendingVideoWorkflows.push(wfid)
      console.log(`[gateway] S6 freeze: video workflow ${wfid} held during unanswered user question (session ${state.sessionId})`)
      return Response.json({ ok: true, status: "frozen_pending_reply", note: "用户质询尚未答复，视频任务已暂缓；答复完成后自动继续" })
    }
    // 後台執行：立即回 running，每個節點結果以 canvas.* 事件推送到畫布（agent 不阻塞等待）。
    // R5-C（2026-08-28）：preflightBudget 拒絕（餘額缺口）時 generate 返回
    // {ok:false, status:缺口文字}，但工具層早已收到 running——拒絕落在後台
    // then 裡無人傳話，agent/用戶兩邊都看不到。拒絕時把帶缺口數字的 status
    // 文本經 message 通道直接 emit 給用戶；工作流狀態未動（預檢在置 running
    // 之前），畫布保持可重試。（R5-C emit 邏輯已收進 runWfGenerate，confirm
    // 批准回調共用同一條路徑。）
    runWfGenerate(state, wfid)
    return Response.json({ ok: true, status: "running", note: `工作流已提交后台执行（workflow_id=${wfid}）。完成后系统会自动唤醒你汇报结果与真实花费。禁止用 bash sleep 或反复 workflow_status 等待；本轮现在总结已知状态并结束回合。` })
  }
  // S3（2026-08-27）：workflow_rerun_node 的 gateway 端處理器——此前根本不存在
  // 這條路由（工具層呼叫 /internal/workflow/node/rerun 直接落 404）。語義與
  // /workflow/generate 對齊：查快照回灌兜底 → 校驗 workflow/節點存在 →
  // 後台重跑（節點+全部下游）→ 立即回 running。會話查找在 dispatcher 已完成
  //（resolveSession 支持 opencode id 與 gateway id 兩種鍵）。
  if (pathname.endsWith("/workflow/node/rerun") && req.method === "POST") {
    const wfid = typeof body.workflow_id === "string" ? body.workflow_id : ""
    const rootNodeId = typeof body.node_id === "string" ? body.node_id : ""
    if (!wfid || !rootNodeId) {
      return jsonError(400, "workflow_id and node_id are required", "bad_request", "bad_request")
    }
    if (!workflowService.get(wfid) && state.workflowSnapshot && (state.workflowSnapshot as { workflowId?: unknown }).workflowId === wfid) {
      try {
        restoreWorkflowsFromSnapshot(state)
      } catch {
        // fall through：回灌失敗按 not found 誠實回報
      }
    }
    if (!workflowService.get(wfid)) return jsonError(404, "workflow not found", "not_found", "not_found")
    const wf = workflowService.get(wfid)!
    if (!wf.graph.nodes.some((n) => n.id === rootNodeId)) {
      return jsonError(404, `node not found: ${rootNodeId}`, "not_found", "not_found")
    }
    const rootNode = wf.graph.nodes.find((n) => n.id === rootNodeId)!
    if (rootNode.kind === "text" || rootNode.kind === "config") {
      return jsonError(400, "text/config 节点是参考资料，无需重跑；请对 image/video/audio 节点调用 rerun", "bad_request", "bad_request")
    }
    // INC-0830 rerun 防重門：節點曾提交過上游作業（metadata.last_job_id）時，
    // 先查平台真相再決定放不放行——上游成功=拒絕重跑（除非 force:true 明示棄單），
    // 還在跑=拒絕；查不到真相（作業已刪/查詢失敗）時放行並註明「真相不可得」。
    // 事故根因之三：agent 看不到 job 狀態就 rerun，撞出 4 筆重複扣費。
    const prevJobId = typeof rootNode.metadata?.last_job_id === "string" ? rootNode.metadata.last_job_id : ""
    if (prevJobId && (rootNode.kind === "video" || rootNode.kind === "image")) {
      const forceRerun = body.force === true
      const ep = rootNode.kind === "video" ? `/videos/${prevJobId}` : `/images/${prevJobId}`
      let truth: { status?: string; url?: string } | null = null
      try {
        const tRes = await fetch(`${PLATFORM_BASE}/v1${ep}`, {
          headers: { Authorization: `Bearer ${session.apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        const tData = await tRes.json().catch(() => null)
        if (tRes.ok && tData && typeof tData === "object") truth = tData as { status?: string; url?: string }
      } catch {
        truth = null
      }
      if (truth) {
        if (truth.status === "succeeded" && !forceRerun) {
          return jsonError(
            409,
            `拒绝重跑：该节点上一次任务 ${prevJobId} 已在上游成功出片（成果未丢）。请先检查/引用已有结果；确认要放弃并重新生成时带 force:true 重试`,
            "rerun_blocked_previous_succeeded",
            "rerun_blocked_previous_succeeded",
          )
        }
        if (truth.status !== "succeeded" && truth.status !== "failed" && truth.status !== "cancelled" && truth.status !== "canceled" && !forceRerun) {
          return jsonError(
            409,
            `拒绝重跑：该节点上一次任务 ${prevJobId} 仍在执行中（status=${truth.status}），重复提交会重复扣费。等待其完成或带 force:true 明示放弃后重试`,
            "rerun_blocked_in_flight",
            "rerun_blocked_in_flight",
          )
        }
      } else if (!forceRerun) {
        console.warn(`[workflow] rerun guard: job ${prevJobId} truth unavailable for ${rootNodeId}, allowing with caveat`)
      }
    }
    // 後台執行（與 generate 同語義）：立即回 running，節點結果走 canvas.* 事件。
    // stateForWorkflow 已在 handleWorkflowInternal 開頭設為本次 session。
    const executionId = `rex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    void workflowService.rerun(wfid, rootNodeId).then((r) => {
      if (!r.ok) console.error(`[workflow] rerun ${wfid}/${rootNodeId} finished: ${r.status}`)
    })
    return Response.json({ ok: true, execution_id: executionId, root_node_id: rootNodeId, status: "running" })
  }
  return jsonError(404, "not found", "not_found", "not_found")
}

function openEventStream(state: SessionState, lastEventId?: number, req?: Request): Response {
  let client: SSEClient | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = { controller }
      state.clients.add(client)
      controller.enqueue(encoder.encode(`event: connected\ndata: {"ok":true}\n\n`))
      if (typeof lastEventId === "number" && !Number.isNaN(lastEventId)) {
        for (const frame of state.replayBuffer) {
          if (frame.id > lastEventId) {
            controller.enqueue(frame.frame.slice())
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

// ---- opencode event translation -> frontend events ----

// sessionID lives in different properties depending on event type:
//   session.*            -> properties.sessionID
//   message.updated      -> properties.sessionID AND properties.info.sessionID
//   message.part.updated -> properties.part.sessionID (NO properties.sessionID)
//   message.part.delta   -> properties.sessionID
function eventSessionId(event: any): string | undefined {
  const p = event?.properties
  return p?.sessionID ?? p?.part?.sessionID ?? p?.info?.sessionID
}

function boundMap<T>(map: Map<string, T>, max: number): void {
  if (map.size <= max) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

function boundSet<T>(set: Set<T>, max: number): void {
  if (set.size <= max) return
  const oldest = set.values().next().value
  if (oldest !== undefined) set.delete(oldest)
}

// Text parts carry no role, so the only way to tell the assistant's reply from
// the user's own prompt is the messageID -> role map built from message.updated.
// Unknown messageID => false: message.updated for a message always precedes its
// parts, so an unknown id means something is off and dropping is the safe side.
function isAssistantMessage(state: SessionState, messageID: unknown): boolean {
  if (typeof messageID !== "string" || messageID.length === 0) return false
  return state.messageRole.get(messageID) === "assistant"
}

// tool state.output arrives as a JSON string (e.g. an HTTP 401 with ok:false).
// Parse defensively; malformed/absent output yields null so callers fall back to
// ok:false instead of throwing.
function parseToolOutput(
  output: unknown,
): { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown } | null {
  if (typeof output === "string") {
    try {
      const parsed: unknown = JSON.parse(output)
      if (parsed && typeof parsed === "object") {
        return parsed as { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown }
      }
      return null
    } catch {
      return null
    }
  }
  if (output && typeof output === "object") {
    return output as { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown }
  }
  return null
}

// Shared image.done emission path, deduped per session by url (bounded Set, cap
// 100, evict oldest). Both the opencode tool-result translation and the
// /internal/emit entry point go through here, so the same image can never be
// announced twice to the frontend in one session.
// The platform hands back /v1/images/<id>/result — relative, Bearer-authed, and
// a 302 to a public store.tinchak0207.xyz .webp. An <img src> can send neither a
// host nor an auth header, and the frontend must never hold a backend key, so
// that URL is unrenderable as-is. Resolve the redirect here, server-side, and
// publish the terminal public URL instead.
//
// Verified 2026-08-07: GET the result path with the session key -> 302; Location
// is an unsigned, query-less, publicly readable image/webp (200 without auth).
// Because it carries no signature there is nothing to expire or leak.
async function resolveResultUrl(rawUrl: string, key: string): Promise<string> {
  if (!rawUrl) return rawUrl
  // Already a public asset URL (poller/tool may hand one over directly).
  if (/^https?:\/\//i.test(rawUrl) && !/\/v1\/images\/[^/]+\/result\/?$/.test(rawUrl)) return rawUrl
  const absolute = /^https?:\/\//i.test(rawUrl) ? rawUrl : `${PLATFORM_BASE}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
  // 平台 /v1/images/{id}/result 預設回 JSON，帶 ?format=redirect 才 302 到公開 blob URL。
  const target = /\/v1\/images\/[^/]+\/result\/?$/.test(absolute) ? absolute + "?format=redirect" : absolute
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    })
    const loc = res.headers.get("location")
    if (loc && /^https?:\/\//i.test(loc)) return loc
    // Some deployments may serve the bytes directly instead of redirecting; the
    // absolute URL is then still wrong for the frontend, but it is the best we
    // have and at least names the right host.
    return absolute
  } catch {
    return absolute
  }
}

async function emitImageDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  recipe?: { prompt?: string; model?: string; size?: string; lora?: string },
): Promise<void> {
  if (!url) return
  // Dedup on the RAW url: the same task resolved twice yields two different
  // public URLs only if the platform regenerates, but the raw form is stable.
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  const publicUrl = await resolveResultUrl(url, state.apiKey)
  emitToSession(state, "image.done", { url: publicUrl, cost_coins, task_id, ...(recipe ? { recipe } : {}) })
  // 自動製畫布：task 掛過 unit 就更新該 unit 的結果圖片節點。
  if (task_id) {
    emitCanvasResult(state, task_id, publicUrl, cost_coins)
  }
  void appendLedgerFor(state, {
    kind: "image",
    event: "done",
    task_id,
    cost_coins,
    result_url: publicUrl,
  })
  void emitQuotaChanged(state)
}

async function emitVideoDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  media_kind?: "video" | "film",
): Promise<void> {
  if (!url) return
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  // 影片/成片 content 已是絕對公開 URL，無需 resolveResultUrl（它只重寫 /v1/images/.../result 形態）。
  emitToSession(state, "video.done", { url, cost_coins, task_id, media_kind })
  void appendLedgerFor(state, {
    kind: "video",
    event: "done",
    task_id,
    cost_coins,
    result_url: url,
  })
  void emitQuotaChanged(state)
}

async function emitAudioDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  media_kind?: "audio",
): Promise<void> {
  if (!url) return
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  // 音頻 content 已是絕對公開 URL（平台 uploads），無需 resolveResultUrl（它只重寫 /v1/images/.../result 形態）。
  emitToSession(state, "audio.done", { url, cost_coins, task_id, media_kind })
  void appendLedgerFor(state, {
    kind: "audio",
    event: "done",
    task_id,
    cost_coins,
    result_url: url,
  })
  void emitQuotaChanged(state)
}

// ---- 自動製畫布（Auto Canvas Builder） ----
//
// 暴君立場：deepseek 不「思考」畫布的事。它只提交生圖/改圖請求，
// gateway 攔截每個 image_* 工具的參數與結果，自動在畫布上重現：
//   文本節點(prompt) → 配置節點(model/size/n) → [執行] → 圖片節點(結果)
// 每次請求建立一個「畫布單元」(unit)，unit 內節點用相同 unit_id 前綴，
// 前端以 unit_id 關聯成組；task_id 掛在同一 unit 上，完成時更新該組。

function canvasUnitId(): string {
  return `cu_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
}

function summarizeCanvasTitle(model: string, prompt: string): string {
  const m = model || "生成"
  const p = prompt.trim().slice(0, 18)
  return p ? `${m} · ${p}${prompt.trim().length > 18 ? "…" : ""}` : m
}

// 從工具 input 抽取生成參數（deepseek 送哪欄就用哪欄，缺失給安全預設）。
function readGenerateInput(input: unknown): {
  prompt: string
  model: string
  size: string
  n: number
  kind: string
  quality?: string
  image?: string // edit/upscale 的來源 mediaId/URL
  lora?: string // P1-E1：聊天「存為資產」帶真 LoRA（loraModelVersionIds 首位）
} {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const prompt =
    typeof obj.prompt === "string"
      ? obj.prompt
      : typeof obj.content === "string"
        ? obj.content
        : ""
  const model = typeof obj.model === "string" && obj.model ? obj.model : "gpt-image-2"
  const size = typeof obj.size === "string" && obj.size ? obj.size : "1024x1024"
  const nNum = typeof obj.n === "number" ? obj.n : typeof obj.count === "number" ? obj.count : 1
  const n = Number.isFinite(nNum) ? Math.max(1, Math.min(15, Math.floor(nNum))) : 1
  const kind = typeof obj.kind === "string" && obj.kind === "video" ? "video" : "image"
  const quality = typeof obj.quality === "string" ? obj.quality : undefined
  const image = typeof obj.image === "string" && obj.image ? obj.image : undefined
  const loraRaw = obj.loraModelVersionIds ?? obj.lora ?? obj.lora_id
  const lora =
    typeof loraRaw === "string" && loraRaw
      ? loraRaw
      : Array.isArray(loraRaw) && loraRaw.length > 0
        ? String(loraRaw[0])
        : undefined
  return { prompt, model, size, n, kind, quality, image, lora }
}

// 建立一個畫布單元並 emit 節點/連線事件。回傳 unit id。
// S4：cost_hint 需查平台目錄（async），函數簽名改 async；兩處呼叫點
//（tool status running / completed 補發）均改 await，行為語義不變。
async function autoCreateCanvasUnit(
  state: SessionState,
  toolName: string,
  input: unknown,
  callID: string,
): Promise<string> {
  const cfg = readGenerateInput(input)
  const unitId = canvasUnitId()

  // 計畫卡：一句話讓暴君知道他會被怎麼對待。
  const planLabel =
    toolName === "image_edit"
      ? "改圖（圖生圖）"
      : toolName === "image_upscale"
        ? "放大"
        : toolName === "image_generate"
          ? cfg.kind === "video"
            ? "生影片"
            : "生圖"
          : "生成"
  // S4 規格2（2026-08-27）：cost_hint 從 null 改為真實估算（幣）。估算鏈：
  // ① 工具 input 自帶 cost_coins（上游工具已按目錄算好，最準）→
  // ② 平台目錄單價 × 數量（image）/ 檔位價 5/10 幣每秒（video，R5-C）→
  // ③ 兩者都取不到保持 null（不許編數）。
  let costHint: number | null = null
  if (input && typeof input === "object") {
    const inline = (input as Record<string, unknown>).cost_coins
    if (typeof inline === "number" && Number.isFinite(inline)) costHint = inline
    else if (typeof inline === "string" && inline && Number.isFinite(Number(inline))) costHint = Number(inline)
  }
  if (costHint === null) {
    const inputObj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const estimated = await estimateNodeCoins(
      {
        kind: cfg.kind,
        metadata: {
          model: cfg.model,
          count: cfg.n,
          ...(cfg.quality ? { quality: cfg.quality } : {}),
          ...(typeof inputObj.duration_seconds === "number" ? { duration_seconds: inputObj.duration_seconds } : {}),
        },
      },
      state.apiKey,
    )
    if (estimated !== null) costHint = estimated
  }
  emitToSession(state, "canvas.plan", {
    unit_id: unitId,
    tool: toolName,
    label: planLabel,
    prompt: cfg.prompt,
    model: cfg.model,
    size: cfg.size,
    count: cfg.n,
    kind: cfg.kind,
    source_image: cfg.image ?? null,
    cost_hint: costHint,
  })

  // 文本節點：承載 prompt（source_image 存在時併���提示，編輯語義）。
  const textNode = {
    id: `${unitId}-text`,
    type: "text",
    title: summarizeCanvasTitle(cfg.model, cfg.prompt),
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: {
      content: cfg.prompt,
      status: "idle",
      source_image: cfg.image ?? (toolName === "image_edit" || toolName === "image_upscale" ? cfg.image ?? null : null),
    },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: textNode })
  applyCanvasNodeCreated(state.sessionId, { node: textNode })

  // 配置節點：model/size/n/kind。
  const configNode = {
    id: `${unitId}-config`,
    type: "config",
    title: `${cfg.model} · ${cfg.size}`,
    position: { x: 0, y: 0 },
    width: 440,
    height: 240,
    metadata: {
      content: "",
      status: "idle",
      model: cfg.model,
      size: cfg.size,
      count: cfg.n,
      kind: cfg.kind,
      ...(cfg.quality ? { quality: cfg.quality } : {}),
    },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: configNode })
  applyCanvasNodeCreated(state.sessionId, { node: configNode })

  // 連線：文本 → 配置。
  emitToSession(state, "canvas.node.connected", {
    unit_id: unitId,
    connection: { id: `${unitId}-c1`, fromNodeId: textNode.id, toNodeId: configNode.id },
  })
  applyCanvasNodeConnected(state.sessionId, { connection: { id: `${unitId}-c1`, fromNodeId: textNode.id, toNodeId: configNode.id } })

  // 預留圖片節點（結果落地時更新同一節點）。
  const imageNode = {
    id: `${unitId}-image`,
    type: "image",
    title: "生成中…",
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { content: "", status: "loading" },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: imageNode, target_kind: "result" })
  applyCanvasNodeCreated(state.sessionId, { node: imageNode })
  // 連線：配置 → 圖片。
  emitToSession(state, "canvas.node.connected", {
    unit_id: unitId,
    connection: { id: `${unitId}-c2`, fromNodeId: configNode.id, toNodeId: imageNode.id },
    target_kind: "result",
  })
  applyCanvasNodeConnected(state.sessionId, { connection: { id: `${unitId}-c2`, fromNodeId: configNode.id, toNodeId: imageNode.id } })

  state.canvasUnitByCall.set(callID, unitId)
  boundMap(state.canvasUnitByCall, TOOL_STATUS_DEDUP_CAP)
  markDirty(state) // 畫布快照已套用：隨 session 防抖落盤，重啟後可恢復
  return unitId
}

// 為已建立的 unit 掛上 task_id（submit 完成階段），供結果更新。
function attachCanvasTask(state: SessionState, callID: string, taskId: string, unitId?: string): void {
  const target = unitId ?? state.canvasUnitByCall.get(callID)
  // 0831：本輪任務登記（權威 task_id 來源 + 壓縮在途閘依據）。置於 unit 判斷之前：
  // 即使畫布 unit 尚未就緒（autoCreateCanvasUnit 異步），已提交的 task 也必須被追蹤，
  // 否則在途閘漏放 → 壓縮照樣踩中摘要 tool-call 死鎖。
  if (taskId) {
    state.sessionTasks.set(taskId, { task_id: taskId, status: "queued", submitted_at: Date.now() })
  }
  if (!target || !taskId) return
  state.canvasUnitByTask.set(taskId, target)
  boundMap(state.canvasUnitByTask, TOOL_STATUS_DEDUP_CAP)
}

// task_id → unit 存在時，emit 完成事件；返回命中與否。
function emitCanvasResult(
  state: SessionState,
  taskId: string,
  url: string,
  cost_coins?: number,
): boolean {
  // 0831：任務終態登記（成功）。置於 unit 判斷前：無畫布 unit 也要如實記 succeeded+url。
  const t = state.sessionTasks.get(taskId)
  if (t) {
    t.status = "succeeded"
    t.url = url
  }
  const unitId = state.canvasUnitByTask.get(taskId)
  if (!unitId) return false
  const patch = { status: "success", content: url, ...(typeof cost_coins === "number" ? { cost_coins } : {}) }
  emitToSession(state, "canvas.node.updated", {
    unit_id: unitId,
    node_id: `${unitId}-image`,
    patch,
    url,
    cost_coins,
  })
  applyCanvasNodeUpdated(state.sessionId, { node_id: `${unitId}-image`, patch })
  return true
}

/**
 * S2a：從結構化工具輸出抽失敗載荷，組出三欄位錯誤合同
 * {code, message, human_message}。兼容三種輸入形態：
 *  - 工具層 fail()：{error:{code,hint}}
 *  - gateway jsonError 透傳：{error:{message,type,code}}（code 可能被工具層
 *    塞成物件——workflow_rerun 舊裂縫的實際形態）
 *  - 純字串/無 error：fallback message。
 */
function toolErrorPayload(
  parsed: { error?: unknown } | null,
  fallbackMessage: string,
): { code: string; message: string; human_message: string } {
  let code = "tool_failed"
  let message = fallbackMessage
  const e = parsed && typeof parsed === "object" ? parsed.error : null
  if (typeof e === "string" && e) {
    message = e
  } else if (e && typeof e === "object") {
    const o = e as { code?: unknown; message?: unknown; hint?: unknown }
    if (o.code && typeof o.code === "object") {
      const inner = o.code as { message?: unknown; code?: unknown }
      if (typeof inner.message === "string" && inner.message) message = inner.message
      if (typeof inner.code === "string" && inner.code) code = inner.code
    } else {
      if (typeof o.message === "string" && o.message) message = o.message
      else if (typeof o.hint === "string" && o.hint) message = o.hint
      if (typeof o.code === "string" && o.code) code = o.code
    }
  }
  return { code, message, human_message: humanMessageFor(message, code) }
}

// ── R8-B 工單 #2（2026-08-29）：拒單報因 ──
// R8 實錘：grep BRE 交替 \| 撞 deny 的 *|* 被拒，報錯不說命中哪條規則，
// 模型花 78s 人肉逆向權限表。修法：被拒 bash 命令對 permission.bash 的
// deny glob 求匹配，error 幀附 matched_pattern + 一句替代寫法。
let bashDenyCache: { at: number; patterns: string[] } | null = null
function loadBashDenyPatterns(): string[] {
  const now = Date.now()
  if (bashDenyCache && now - bashDenyCache.at < 60_000) return bashDenyCache.patterns
  let patterns: string[] = []
  try {
    const raw = readFileSync(path.join(WORKSPACE_DIR, ".opencode", "opencode.json"), "utf-8")
    const cfg = JSON.parse(raw) as { permission?: { bash?: Record<string, string> } }
    patterns = Object.entries(cfg.permission?.bash ?? {})
      .filter(([, v]) => v === "deny")
      .map(([k]) => k)
  } catch {
    // 配置讀不到就不歸因——報錯退回短句，不阻塞工具錯誤透傳
  }
  bashDenyCache = { at: now, patterns }
  return patterns
}

/** deny glob → RegExp（* 通配任意字元含換行，其餘按字面量）。 */
function denyGlobToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*")
  return new RegExp(`^${body}$`)
}

/** 替代寫法提示（按命中規則類型給一句可操作的話；出站文案一律簡體）。 */
function denyHintFor(pattern: string): string {
  if (pattern === "*|*") return "BRE 交替 \\| 含禁止符 |。改用宽匹配后自行筛选（如 grep -n \"第.*章\"），或改用 run_py 工具写脚本处理"
  if (pattern === "*&&*" || pattern === "*||*" || pattern === "*;*") return "执行环境只允许单条命令。拆成多次单命令调用，或改用 run_py 工具写脚本一次完成"
  if (pattern === "*>*" || pattern === "*>>*" || pattern === "*<*") return "执行环境禁止重定向/输入改向。拆成多次单命令调用，或改用 run_py 工具写脚本一次完成"
  return "请改用允许的命令（ls/cat/grep/sed -n/awk/find 等），或改用 run_py 工具写脚本"
}

/** 對 deny glob 求匹配；命中多條時取最具體的（非 * 字面量最長者），跳過全捕 *。 */
function bashDenyAttribution(cmd: string): { pattern: string; hint: string } | null {
  if (!cmd) return null
  let best: { pattern: string; score: number } | null = null
  for (const p of loadBashDenyPatterns()) {
    if (p === "*") continue // 全捕規則不報因（零信息量）
    if (!denyGlobToRegExp(p).test(cmd)) continue
    const score = p.replace(/\*/g, "").length
    if (!best || score > best.score) best = { pattern: p, score }
  }
  if (!best) return null
  return { pattern: best.pattern, hint: denyHintFor(best.pattern) }
}

/** R8-B 工單 #5：uploads 目錄遞歸找同名文件，取 mtime 最新者。 */
function findUploadsByBasename(basename: string): string | null {
  let found: string | null = null
  let foundMtime = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean }>
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1)
        continue
      }
      if (e.name === basename || e.name.toLowerCase() === basename.toLowerCase()) {
        try {
          const m = statSync(p).mtimeMs
          if (m > foundMtime) {
            foundMtime = m
            found = p
          }
        } catch {
          // stat 失敗的文件跳過
        }
      }
    }
  }
  walk(UPLOADS_DIR, 0)
  return found
}

// R8-B 工單 #5：消息文本裡的絕對路徑 token（≥2 段，含 /tmp/daming-book.pdf 形態）。
const ABS_PATH_RE = /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g

/** R8-B 工單 #5：用戶給的路徑在沙箱視圖（workspace）不存在但 uploads/** 有同名
 *  文件 → 返回系統注文本（拼進送模型的 message 前面）；解析不到回 null。 */
function resolveInvisibleUploadPaths(content: string): string | null {
  const candidates = new Set(content.match(ABS_PATH_RE) ?? [])
  const notes: string[] = []
  for (const raw of candidates) {
    const p = raw.replace(/[.,;:!?)）】"'，。；：]+$/, "")
    if (p.startsWith(WORKSPACE_DIR)) continue // 沙箱視圖內本來就可見
    const basename = p.split("/").pop() ?? ""
    if (!basename) continue
    const hit = findUploadsByBasename(basename)
    if (hit) notes.push(`[系统] 路径 ${p} 执行环境不可见，同名文件已解析到 ${hit}，后续操作请使用解析后的路径`)
  }
  return notes.length > 0 ? notes.join("\n") : null
}

/** R4-A S10：被拒操作的可讀標籤——bash 取命令前綴（截 80 字符），其他工具取工具名。 */
function deniedOperationLabel(toolName: string, input: unknown): string {
  let op = ""
  if (input && typeof input === "object") {
    const cmd = (input as { command?: unknown }).command
    if (typeof cmd === "string" && cmd.trim()) {
      const firstLine = cmd.trim().split("\n")[0] ?? ""
      op = `bash 命令 "${firstLine.slice(0, 80)}${firstLine.length > 80 ? "…" : ""}"`
    }
  }
  if (!op) op = toolName || "未知操作"
  return `（被拒操作：${op}）`
}

/** R4-A S8：採集本 turn 內到達終態的節點（emitToSession 中央出口調用）。 */
function trackTurnNodeTerminal(state: SessionState, data: unknown): void {
  const d = (data ?? {}) as {
    node_id?: unknown
    nodeId?: unknown
    id?: unknown
    patch?: { status?: unknown }
    status?: unknown
  }
  const nodeId =
    typeof d.node_id === "string" ? d.node_id : typeof d.nodeId === "string" ? d.nodeId : typeof d.id === "string" ? d.id : ""
  const status = typeof d.patch?.status === "string" ? d.patch.status : typeof d.status === "string" ? d.status : ""
  if (!nodeId || (status !== "success" && status !== "error")) return
  if (!state.turnTerminalNodes) state.turnTerminalNodes = []
  const key = `${nodeId}:${status}`
  if (state.turnTerminalNodes.some((n) => `${n.id}:${n.status}` === key)) return
  state.turnTerminalNodes.push({ id: nodeId, status })
  if (state.turnTerminalNodes.length > 64) state.turnTerminalNodes.shift()
}

/** 修 4（2026-09-01）：workflow_start 載荷形狀示例。opencode 工具層把 gateway
 *  400 丟成裸「tool failed」，模型只能拿用戶的幣和時間盲猜形狀（實測連錯 2 張
 *  失敗卡才中）。從模板註冊表取該模板 text role 的真實欄位，回一段可照抄的
 *  緊湊 JSON 示例；註冊表不可得時用 single_video 的 canonical 形狀兜底。 */
function workflowStartSchemaHint(input: unknown): string {
  const templateId =
    input && typeof input === "object" && typeof (input as { template_id?: unknown }).template_id === "string"
      ? (input as { template_id: string }).template_id
      : ""
  const roles: string[] = []
  if (templateId) {
    try {
      const tpl = (workflowService.templates() as Array<{ id?: unknown; nodes?: { role?: unknown; kind?: unknown }[] }>).find(
        (t) => t.id === templateId,
      )
      for (const n of tpl?.nodes ?? []) {
        if (n.kind === "text" && typeof n.role === "string") roles.push(n.role)
      }
    } catch {
      // 註冊表不可得：走通用示例兜底
    }
  }
  const contentShape = roles.length
    ? JSON.stringify(Object.fromEntries(roles.map((r) => [r, { content: "…" }])))
    : '{"shot":{"content":"…"}}'
  return (
    `workflow_start 载荷形状不对（参数被拒，不是上游故障）。content 必须按「文本角色名 → {content: 提示词文本}」组织` +
    `${templateId ? `（模板 ${templateId} 的文本角色：${roles.length ? roles.join("、") : "未知"}）` : ""}。` +
    `照此形状重试一次即可：{"template_id":"${templateId || "single_video"}","content":${contentShape}}`
  )
}

function handleToolPartUpdate(state: SessionState, part: any): void {
  const toolName = typeof part?.tool === "string" ? part.tool : ""
  const callId = typeof part?.callID === "string" ? part.callID : ""
  const st = part?.state
  if (!st || typeof st !== "object") return
  const status = typeof st.status === "string" ? st.status : ""
  if (!callId || !status) return

  // Dedup by callID + status so a repeated identical status does not re-emit.
  const dedupKey = `${callId}:${status}`
  if (state.toolStatusSeen.has(dedupKey)) return
  state.toolStatusSeen.add(dedupKey)
  boundSet(state.toolStatusSeen, TOOL_STATUS_DEDUP_CAP)

  // R2-A 看門狗：工具真實開跑 = turn 已啟動，餵狗。（question 工具的
  // pending 也要算——它在等用戶回答，turn 顯然活著。）
  if (status === "pending" || status === "running" || status === "completed") {
    state.turnToolStarted = true
  }

if (status === "pending" || status === "running") {
    // question is not a generic running tool. The agent is blocked on a
    // que_* request; emit question.request so the frontend can reply.
    if (toolName === "question") {
      void emitQuestionRequest(state, callId, st.input)
      return
    }
    // 只在拿到工具輸入後才發 invoke。opencode 的 pending 狀態常只有
    // {status:"pending"} 而沒有 input；等 running（input 完整）再發，
    // 前端工具卡才顯示得出「在做什麼」，不是黑盒。
    const argsSummary = summarizeArgs(st.input)
    if (state.toolInvokeSeen.has(callId)) return
    if (!argsSummary && status === "pending") return
    state.toolInvokeSeen.add(callId)
    boundSet(state.toolInvokeSeen, TOOL_STATUS_DEDUP_CAP)
    emitToSession(state, "tool.invoke", {
      tool: toolName,
      args_summary: argsSummary,
    })
    // 自動製畫布：image_* 工具首次建立畫布單元。deepseek 完全不知道——
    // 它只是提交請求，gateway 攔截參數自動建文本/配置/圖片節點。
    if (toolName.startsWith("image_") && !state.canvasUnitByCall.has(callId) && st.input != null) {
      void autoCreateCanvasUnit(state, toolName, st.input, callId)
    }
  } else if (status === "completed") {
    // 若 running 階段因 input 缺失沒發過 invoke，這裡補發一次（completed 的
    // input 一定完整），確保前端工具卡必定有說明、不黑盒。
    if (!state.toolInvokeSeen.has(callId) && st.input != null) {
      state.toolInvokeSeen.add(callId)
      boundSet(state.toolInvokeSeen, TOOL_STATUS_DEDUP_CAP)
      emitToSession(state, "tool.invoke", {
        tool: toolName,
        args_summary: summarizeArgs(st.input),
      })
      // 同上：跑到 completed 才見到 input 的工具（理論上不會，但保險起見）。
      if (toolName.startsWith("image_") && !state.canvasUnitByCall.has(callId)) {
        void autoCreateCanvasUnit(state, toolName, st.input, callId)
      }
    }
    const parsed = parseToolOutput(st.output)
    // 只認明確帶 ok 欄位的結構化輸出；沒有 ok 欄位（原生工具文字輸出）一律視為成功。
    const hasOkFlag = parsed !== null && typeof parsed === "object" && typeof (parsed as { ok?: unknown }).ok === "boolean"
    const ok = hasOkFlag ? (parsed as { ok: boolean }).ok === true : true
    // S2a（2026-08-27）：ok 語義收緊為「已執行且成功」。失敗必落
    // {ok:false, error:{code,message,human_message}}——human_message 中文短句必填。
    // 舊代碼非 image_ 工具無條件回 ok:true，導致 workflow_rerun_node 等失敗工具
    // 在 SSE 上偽成功（評測 event 687-690 實錘）。
    const toolErr = !ok ? toolErrorPayload(parsed, "tool failed") : null
    if (toolName.startsWith("image_")) {
      // 自動製畫布：submit 完成後把 task_id 掛回 unit，完成事件才夠關聯。
      if (ok && typeof parsed?.task_id === "string" && parsed.task_id) {
        attachCanvasTask(state, callId, parsed.task_id)
      }
      emitToSession(state, "tool.result", {
        tool: toolName,
        ok,
        ...(toolErr ? { error: toolErr } : {}),
        cost_coins: typeof parsed?.cost_coins === "number" ? parsed.cost_coins : undefined,
      })
      if (ok && typeof parsed?.url === "string" && parsed.url.length > 0) {
        // P1-E1：image.done 附帶真實配方（prompt/model/size/lora），前端
        // 「存為資產」直接拿，不必再從 transcript 對應。
        const cfg = st.input != null ? readGenerateInput(st.input) : undefined
        void emitImageDone(state, parsed.url, parsed.cost_coins, parsed.task_id, cfg ? { prompt: cfg.prompt, model: cfg.model, size: cfg.size, lora: cfg.lora } : undefined)
      }
    } else {
      // R1（2026-09-11）刀4：非 image_ 工具的 tool.result 補回填載荷。評測實錘 10 條
      // result 全為 {tool,ok,event_id} 空殼（前端契約的 cost_coins / error.human_message
      // / summary 全部拿不到）。有成本數字就帶 cost_coins（quote/generate 類）；報價類
      // 工具再帶一句 summary 短文案；同步子代理 deadline 超時補 partial/reason。
      const parsedObj =
        parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
      const costCoins =
        parsedObj && typeof parsedObj.cost_coins === "number"
          ? parsedObj.cost_coins
          : parsedObj && typeof parsedObj.total_coins === "number"
            ? parsedObj.total_coins
            : parsedObj && typeof parsedObj.confirmed_subtotal_coins === "number"
              ? parsedObj.confirmed_subtotal_coins
              : undefined
      let quoteSummary: string | undefined
      if (parsedObj && /quote/i.test(toolName)) {
        if (typeof parsedObj.summary === "string" && parsedObj.summary) {
          quoteSummary = parsedObj.summary
        } else {
          const bits: string[] = []
          if (typeof parsedObj.total_coins === "number") bits.push(`合计 ${parsedObj.total_coins} 币`)
          else if (typeof parsedObj.confirmed_subtotal_coins === "number")
            bits.push(`已定价小计 ${parsedObj.confirmed_subtotal_coins} 币`)
          if (typeof parsedObj.unknown_price_count === "number" && parsedObj.unknown_price_count > 0)
            bits.push(`${parsedObj.unknown_price_count} 项待确认`)
          if (Array.isArray(parsedObj.available_models)) bits.push(`可用模型 ${parsedObj.available_models.length} 个`)
          if (bits.length) quoteSummary = bits.join("，")
        }
      }
      const subagentTimeout = toolName === "subagent_dispatch" && !ok && /超过预定时间/.test(toolErr?.message ?? "")
      emitToSession(state, "tool.result", {
        tool: toolName,
        ok,
        ...(toolErr ? { error: toolErr } : {}),
        ...(typeof costCoins === "number" ? { cost_coins: costCoins } : {}),
        ...(quoteSummary ? { summary: quoteSummary } : {}),
        ...(subagentTimeout ? { partial: true, reason: "timeout" } : {}),
      })
      // 原生工具（bash 等）可能回傳的是「含圖片 URL 的 JSON」——例如引擎用
      // bash 呼叫 kotone-bridge 生圖，輸出 {text, images:[{url,...}]}。這類
      // 結果也要送 image.done，前端右側展示框才會顯示圖片（否則只有泡泡文字）。
      if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { images?: unknown }).images)) {
        const imgs = (parsed as { images: { url?: string; width?: number; height?: number }[] }).images
        for (const im of imgs) {
          if (typeof im?.url === "string" && im.url.length > 0) {
            void emitImageDone(state, im.url)
          }
        }
      }
      // 影片安全網（2026-08-31）：任何非 image_ 工具結果帶平台影片 URL（video_upload 回
      // {ok,url,content_type:video/*}、run_py 裁後上傳、workflow 工具回 {url} 為影片）→ 發
      // video.done，聊天框出影片卡。對稱於上面 image.done；dedup 由 emitVideoDone 的
      // announcedUrls 兜底，與 film 節點 runNode 出口不重複。
      if (parsed !== null && typeof parsed === "object") {
        const isVideoUrl = (u: unknown): u is string =>
          typeof u === "string" && u.length > 0 && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u)
        const vidUrls: string[] = []
        if (isVideoUrl((parsed as { url?: unknown }).url)) vidUrls.push((parsed as { url: string }).url)
        if (isVideoUrl((parsed as { video_url?: unknown }).video_url)) vidUrls.push((parsed as { video_url: string }).video_url)
        if (Array.isArray((parsed as { videos?: unknown }).videos)) {
          for (const v of (parsed as { videos: { url?: unknown }[] }).videos) if (isVideoUrl(v?.url)) vidUrls.push(v.url as string)
        }
        for (const vu of vidUrls) void emitVideoDone(state, vu, typeof parsed?.cost_coins === "number" ? parsed.cost_coins : undefined, undefined, "video")
      }
      // 音頻安全網（2026-09-11）：任何非 image_ 工具結果帶平台音頻 URL（music_gen 回
      // {ok,url:...m4a}、video_upload 收 audio/* 後回 {url}、TTS 落盤 URL）→ 發
      // audio.done，聊天框出音頻卡。與上面影片安全網逐字對稱（同一 dedup 集合
      // announcedUrls，由 emitAudioDone 兜底，不與其他出口重複）。
      if (parsed !== null && typeof parsed === "object") {
        const isAudioUrl = (u: unknown): u is string =>
          typeof u === "string" && u.length > 0 && /\.(m4a|mp3|wav|aac|ogg|flac|opus)(\?|$)/i.test(u)
        const audUrls: string[] = []
        if (isAudioUrl((parsed as { url?: unknown }).url)) audUrls.push((parsed as { url: string }).url)
        if (isAudioUrl((parsed as { audio_url?: unknown }).audio_url)) audUrls.push((parsed as { audio_url: string }).audio_url)
        if (Array.isArray((parsed as { audios?: unknown }).audios)) {
          for (const a of (parsed as { audios: { url?: unknown }[] }).audios) if (isAudioUrl(a?.url)) audUrls.push(a.url as string)
        }
        for (const au of audUrls) void emitAudioDone(state, au, typeof parsed?.cost_coins === "number" ? parsed.cost_coins : undefined, undefined, "audio")
      }
    }
  } else if (status === "error") {
    const err = st.error
    let message =
      typeof err === "string"
        ? err
        : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : "tool failed"
    // 修 4：workflow_start 的裸「tool failed」→ 帶期望 schema 的可照抄報錯。
    // 工具層不透傳 gateway 400 body，模型此前只能盲猜載荷形狀；命中條件 =
    // workflow_start + 報錯無任何中文（真實中文報錯如「缺少必要內容」不覆蓋）。
    if (toolName === "workflow_start" && !/[\u4e00-\u9fff]/.test(message)) {
      message = workflowStartSchemaHint(st.input)
    }
    // 2026-08-22：opencode 的 deny 消息自帶完整權限規則表（120+ 條 JSON），
    // 原樣透傳=防禦清單直接送給任何用戶（偵察面）。權限攔截一律換成短句。
    // R4-A S10（2026-08-28）：R4 實錘「此操作不在允许范围内，已跳过」×7 不說
    // 是哪個操作——補上被拒操作（bash 命令前綴，非 bash 工具補工具名）。
    // R8-B 工單 #2（2026-08-29）：再補命中規則（matched_pattern）與替代寫法——
    // R8 實錘模型花 78s 人肉逆向 deny 表，報因後此段歸零。
    let denyInfo: { pattern: string; hint: string } | null = null
    if (/specified a rule which prevents|relevant rules/i.test(message)) {
      const cmd =
        st.input && typeof st.input === "object" && typeof (st.input as { command?: unknown }).command === "string"
          ? (st.input as { command: string }).command
          : ""
      denyInfo = bashDenyAttribution(cmd)
      message = `此操作不在允许范围内，已跳过${deniedOperationLabel(toolName, st.input)}${
        denyInfo ? `。命中规则：${denyInfo.pattern}；替代写法：${denyInfo.hint}` : ""
      }`
    }
    // S2a：error 態的 tool.result 同樣補齊三欄位錯誤合同。
    emitToSession(state, "tool.result", {
      tool: toolName,
      ok: false,
      error: {
        code: "tool_error",
        message,
        human_message: humanMessageFor(message, undefined),
        ...(denyInfo ? { matched_pattern: denyInfo.pattern, hint: denyInfo.hint } : {}),
      },
    })
    emitSessionError(state, "tool_error", message)
  }
}

// ── P2b（2026-09-11）刀2：空轉止損 ──────────────────────────────────
// step 結算：無 tool、無非空正文、無非空 reasoning = 空 step。空 step 連續累計；
// 任一活動歸零。達閾值且 turn 活躍 → 中止 + 同輪補一次動作導向 nudge。
function finalizeIdleStep(state: SessionState): void {
  const empty = !state.stepHasTool && !state.stepHasText && !state.stepHasReasoning
  state.stepHasTool = false
  state.stepHasText = false
  state.stepHasReasoning = false
  if (!empty) {
    state.idleSteps = 0
    return
  }
  state.idleSteps = (state.idleSteps ?? 0) + 1
  if (
    state.idleSteps >= IDLE_STEP_ABORT_THRESHOLD &&
    !state.idleNudgeSent &&
    !state.turnAborted &&
    (state.lastTurnActiveAt ?? 0) > 0 &&
    state.lastPromptBody
  ) {
    triggerIdleStepBreaker(state)
  }
}

function triggerIdleStepBreaker(state: SessionState): void {
  const body = state.lastPromptBody
  if (!body) return
  state.idleNudgeSent = true
  const gen = state.turnGen ?? 0
  const nudgeBody = {
    ...body,
    parts: [...body.parts.map((pt) => ({ ...pt })), { type: "text", text: IDLE_STEP_NUDGE }],
  }
  console.warn(
    `[gateway] idle-step breaker: ${IDLE_STEP_ABORT_THRESHOLD} empty steps, abort+nudge — session=${state.sessionId} gen=${gen}`,
  )
  // ① 中止當前 turn（與用戶中止同一後端路徑）。
  void fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/abort`, {
    method: "POST",
    headers: opencodeHeaders(),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
  state.turnAborted = true
  stripStaleTurnTextFromReplay(state)
  // 中止輪的 session.idle 不得再觸發抖動/failover 二次重投：retryQueued 佔位。
  // 本輪的重投就是下面的 nudge；再空轉保持佔位 = 不循環，讓它自然失敗。
  state.retryQueued = true
  // ② 同一 turn 週期僅一次：原樣重發最後一條用戶消息，尾端附動作導向提示。
  setTimeout(async () => {
    const cur = sessions.get(state.sessionId)
    if (!cur || (cur.turnGen ?? 0) !== gen) return
    try {
      const res = await fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify(nudgeBody),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      cur.turnAborted = false
      cur.idleSteps = 0
      cur.stepOpen = false
      cur.stepHasTool = false
      cur.stepHasText = false
      cur.stepHasReasoning = false
      cur.turnTextChars = 0
      cur.turnToolStarted = false
      cur.lastTurnActiveAt = Date.now()
      stripStaleTurnTextFromReplay(cur)
      armWatchdogTimer(cur)
      console.log(`[gateway] idle-step breaker: nudge resend dispatched — session=${cur.sessionId}`)
    } catch (e) {
      console.error(`[gateway] idle-step breaker: nudge resend failed:`, e)
      cur.turnAborted = false
      emitToSession(cur, "turn.done", {})
    }
  }, TURN_RETRY_DELAY_MS)
}

function handleOpencodeEvent(event: any): void {
  try {
    const opencodeSessionId = eventSessionId(event)
    if (!opencodeSessionId) return
    // 子代理运行时：子 opencode 会话的事件翻译成 subagent.* 帧发到父会话，
    // 不进入常规翻译（常规路径按 opencode id 查 sessions，子会话查不到会直接丢）。
    if (subagentHandlesSession(opencodeSessionId)) {
      handleSubagentEvent(event, opencodeSessionId)
      return
    }
    const state = findSessionByOpenCodeId(opencodeSessionId)
    if (!state) return

    // session.error (if it ever appears) or any event carrying properties.error.
    const err = event?.properties?.error
    if (event?.type === "session.error" || err != null) {
      emitSessionError(state, opencodeErrorCode(err), opencodeErrorMessage(err))
      return
    }

    switch (event?.type) {
      case "message.updated": {
        // The ONLY place a role appears. message.part.updated carries no role at
        // all (verified: part keys are id/messageID/sessionID/text/type), so
        // without this map the user's own prompt — which arrives as a text part
        // on a user-role message — gets echoed back as assistant output.
        const info = event?.properties?.info
        const mid = typeof info?.id === "string" ? info.id : undefined
        const role = typeof info?.role === "string" ? info.role : undefined
        if (mid && role) {
          state.messageRole.set(mid, role)
          boundMap(state.messageRole, MESSAGE_ROLE_CAP)
        }
        break
      }
      case "message.part.delta": {
        // 中止殘響（2026-09-02）：用戶中止後 opencode 排隊中的遲到 delta 全丟，
        // 直到下一輪 prompt 起點重置（turnAborted L4165）。
        if (state.turnAborted) break
        const p = event.properties ?? {}
        // A delta says nothing about its part's type, and reasoning parts also
        // append to a "text" field — so field==="text" alone would stream chain
        // of thought to the UI. suppressedParts is populated from the
        // message.part.updated that always precedes a part's deltas (verified by
        // raw capture: part.updated -> delta -> delta).
        // NOTE 2026-08-11: 產品要顯示思維鏈，reasoning part 不再丟棄 —— 改發
        // reasoning.delta 事件（同 shape，前端 reducer 累積到 assistant.reasoning）。
        if (p.field === "text" && typeof p.delta === "string" && p.delta.length > 0 && isAssistantMessage(state, p.messageID)) {
          if (typeof p.partID === "string" && state.suppressedParts.has(p.partID)) {
            emitToSession(state, "reasoning.delta", { text: p.delta })
            // 罪狀2 根因修復（2026-08-29）：思維鏈字數計入 turn 活動——
            // 讓 ack/心跳/看門狗/停滯哨（turnHasActivity）知道模型活著。
            state.turnReasoningChars = (state.turnReasoningChars ?? 0) + p.delta.length
            // P2b 刀2：非空 reasoning 文字 = 本 step 不空（trim 後才算）。
            if (p.delta.trim().length > 0) state.stepHasReasoning = true
            break
          }
          // S2b：出站文本先過內部框架段剝離器（## Objective 等四段）。
          // turnTextChars 仍按原文計——剝到零輸出代表模型確實說過話，不觸發抖動重試。
          emitSanitizedDelta(state, p.partID, p.delta)
          state.turnTextChars = (state.turnTextChars ?? 0) + p.delta.length
          // §7 召回輔助：留本輪正文頭部（buildRecallQuery 只需前 200 字元）。
          noteAssistantHeadForRecall(state, p.delta)
          // P2b 刀2：非空正文 delta = 本 step 不空。
          if (p.delta.trim().length > 0) state.stepHasText = true
          if (typeof p.partID === "string") {
            const rec = state.partTextEmitted.get(p.partID)
            if (rec) {
              rec.emittedLen += p.delta.length
            } else {
              state.partTextEmitted.set(p.partID, { emittedLen: p.delta.length })
              boundMap(state.partTextEmitted, PART_TEXT_TRACK_CAP)
            }
          }
        }
        break
      }
      case "message.part.updated": {
        const part = event?.properties?.part
        if (!part || typeof part !== "object") break
        switch (part.type) {
          case "text": {
            // 中止殘響（2026-09-02）：part.text 是累積全文，partTextEmitted 在 idle
            // 已清——中止輪的補發會整段當「新後綴」重發（N2 同場景根因），丟棄。
            if (state.turnAborted) break
            const full = typeof part.text === "string" ? part.text : ""
            const id = typeof part.id === "string" ? part.id : ""
            if (full.length === 0 || !id) break
            // Drop unless we know this belongs to an assistant message. Losing a
            // frame is recoverable; echoing the user's own prompt back as AI
            // output is not.
            if (!isAssistantMessage(state, part.messageID)) break
            // P2b 刀2：非空正文 text part = 本 step 不空。
            if (full.trim().length > 0) state.stepHasText = true
            const rec = state.partTextEmitted.get(id) ?? { emittedLen: 0 }
            // part.text is the cumulative full text; deltas already covered the
            // prefix, so only emit the un-emitted suffix. A part that never
            // produced deltas has emittedLen 0 and emits its full text once.
            if (full.length > rec.emittedLen) {
              // S2b：part.updated 補發的後綴同樣過剝離器（與 delta 路徑共用逐 part 狀態）。
              emitSanitizedDelta(state, id, full.slice(rec.emittedLen))
              state.turnTextChars = (state.turnTextChars ?? 0) + (full.length - rec.emittedLen)
              // §7 召回輔助：補發後綴同樣入正文頭部（無 delta 的單幀 part 靠這條）。
              noteAssistantHeadForRecall(state, full.slice(rec.emittedLen))
              rec.emittedLen = full.length
              state.partTextEmitted.set(id, rec)
              boundMap(state.partTextEmitted, PART_TEXT_TRACK_CAP)
            }
            break
          }
          case "tool":
            handleToolPartUpdate(state, part)
            // P2b 刀2：出現 tool = 本 step 不空。
            state.stepHasTool = true
            break
          case "step-finish": {
            const cost = typeof part.cost === "number" ? part.cost : 0
            const msgId = typeof part.messageID === "string" ? part.messageID : undefined
            if (cost > 0 && msgId && !state.stepCostLogged.has(msgId)) {
              state.stepCostLogged.add(msgId)
              boundSet(state.stepCostLogged, STEP_COST_LOG_CAP)
              // Agent-model cost — never surfaced to the user as a charge.
              console.debug(`[gateway] step-finish: agent cost ${cost} (message ${msgId})`)
            }
            // P2b 刀2：step 收尾結算——空 step 累計，任一活動歸零；達閾值即止損。
            finalizeIdleStep(state)
            state.stepOpen = false
            break
          }
          case "reasoning":
          default: {
            // reasoning/step-start and unknown part types never reach the
            // frontend. Record the partID so its deltas are dropped too — the
            // delta event carries no type of its own.
            const pid = typeof part.id === "string" ? part.id : ""
            // P2b 刀2：step-start = 新 step 起點（上一 step 若無 step-finish 先結算）。
            if (part.type === "step-start") {
              if (state.stepOpen) finalizeIdleStep(state)
              state.stepOpen = true
              state.stepHasTool = false
              state.stepHasText = false
              state.stepHasReasoning = false
            } else if (
              part.type === "reasoning" &&
              typeof part.text === "string" &&
              part.text.trim().length > 0
            ) {
              state.stepHasReasoning = true
            }
            if (pid) {
              state.suppressedParts.add(pid)
              boundSet(state.suppressedParts, SUPPRESSED_PART_CAP)
            }
            break
          }
        }
        break
      }
      case "session.idle": {
        // R8-B 工單 #3/#9（2026-08-29）：question pending 期間 turn 凍結——
        // 不發 turn.done、不觸發抖動重試/壓縮/視頻放行。R8 實錘：turn.done
        // 4604.8 早於 question.replied 4634.5（死而復生型狀態）。等待期用戶
        // 可見性由 question 心跳（armQuestionHeartbeat，30s/幀）接管。
        if (state.pendingQuestions.size > 0) {
          console.log(
            `[gateway] R8-B turn frozen: question pending (x${state.pendingQuestions.size}) — skip turn.done — session=${state.sessionId}`,
          )
          state.turnFrozenByQuestion = true
          clearWatchdogTimer(state)
          clearHeartbeatTimer(state)
          clearAckTimer(state)
          clearErrorStallTimer(state)
          clearMidturnStallTimer(state)
          clearQuietNoticeTimer(state)
          break
        }
        // 會話摘要標題（2026-09-12）：正常收尾路徑（非 question 凍結分支）掛
        // 一次性抓取鏈——首條消息後 opencode 異步生成標題，idle 即回合結束，
        // 2s/8s/20s 重試覆蓋生成滯後；已有標題則空轉返回（冪等）。
        scheduleTitleFetch(state)
        // End-of-turn signal: stop the frontend typing indicator and drop the
        // per-partID delta tracking for this turn to bound memory.
        // messageRole and toolInvokeSeen are deliberately NOT cleared: a late
        // part or duplicate status for this turn would otherwise be treated as
        // unknown-role (dropped) or as a fresh call (re-emitted). Both are
        // capped, so they stay bounded without clearing.
        // S2b：回合結束——把各 part 剝離器扣住的最後一行安全文本吐出
        //（在 turn.done 之前，前端收幀順序不亂），再清狀態。
        // 中止窗口不吐剝離器尾巴（2026-09-02）：用戶叫停後再冒一句=沒停乾淨。
        if (!state.turnAborted) {
          for (const [, stripSt] of state.partStripState) {
            const tail = stripOutboundFlush(stripSt)
            if (tail) emitToSession(state, "message.delta", { text: tail })
          }
        }
        // S1 補口（2026-08-29，smoke agent_text 根因）：一次性「英文已略去」提示
        // 此前只在流式路徑（emitSanitizedDelta）發——單行英文回覆（無尾換行）
        // 整段扣在 pending、idle 時被 flush 壓掉 → 零 message.delta 靜默 turn.done
        // （實錘：同英文 prompt 四輪，模型三輪回英文，md-count 全為 0）。
        // flush 後補發同一條提示，避免整段回覆無聲消失。
        if (!state.englishNoticeSent) {
          for (const [, stripSt] of state.partStripState) {
            if (stripSt.sawEnglish) {
              state.englishNoticeSent = true
              emitToSession(state, "turn.status", { text: "已自动略去一段英文内部思考，中文回复不受影响" })
              break
            }
          }
        }
        // P2b 刀2：turn 結束——未收尾的 step 先結算，再清空轉止損狀態
        //（idleNudgeSent 刻意不清：同 turn 週期只補一次，下一輪起點才重置）。
        if (state.stepOpen) finalizeIdleStep(state)
        state.stepOpen = false
        state.idleSteps = 0
        state.stepHasTool = false
        state.stepHasText = false
        state.stepHasReasoning = false
        state.partStripState.clear()
        state.partTextEmitted.clear()
        state.stepCostLogged.clear()
        // R2-A 看門狗：turn 正常結束（idle 到達），撤哨。
        clearWatchdogTimer(state)
        // N1 規格1：心跳 timer 撤銷（turn 已結束，不再補心跳）。
        clearHeartbeatTimer(state)
        // R4-A S3①：錯誤停滯看門狗同撤（turn 已收尾，不再追錯誤後的停滯）。
        clearErrorStallTimer(state)
        // R5-C：中段停滯哨同撤（turn 已收尾）。
        clearMidturnStallTimer(state)
        // R8-B 工單 #5：中段靜默通知同撤（turn 已收尾）。
        clearQuietNoticeTimer(state)
        // N1 規格3：turn 正常結束（turn.done 即將發出）——清 in-flight 打點。
        state.lastTurnActiveAt = 0
        markDirty(state)
        // §7 prefetch（2026-09-15 PRD P0-4）：回合收尾後台預算下一回合的召回候選
        //（用戶路徑零新增延遲；query = 本回合用戶消息 + 本輪 assistant 頭部）。
        void scheduleMemoryRecallPrefetch(state)
        // 抖動重試：本輪零文本輸出 = 上游模型抖動早死（finish=unknown）。
        // 不發 turn.done（前端維持輸入中狀態），延遲後重放同一條 prompt。
        // 注意（2026-08-29 罪狀2 修復時明確保留）：這裡及下面兩處重試判定刻意
        // 只看 turnTextChars、不含 turnReasoningChars——思維鏈是「活著」的證據
        // （歸 turnHasActivity 管），但「零正文」仍是抖動死亡的唯一特徵；
        // 把 reasoning 算進來會讓「只思考不說話」的 turn 免於重投，禁止改回。
        // 2026-08-31：上游模型错误 failover（每轮断线事故：shuai TLS 抖动 mid-turn 断）。
        // jitter 重试刻意只覆盖「零正文」轮——正文/工具已流动的中途断线此前无人接手，
        // turn 直接死。这里接管：零输出→重投原任务书；已有输出→注入续读指令
        //（opencode 历史里有 partial assistant 消息，模型从中断点继续，不重复已完成步骤）。
        // 取模与 jitter 同源：personaModelForAttempt 走 [persona 主模型, ...fallbacks]。
        if (
          state.turnUpstreamError &&
          !state.turnAborted &&
          (state.turnRetries ?? 0) < TURN_MAX_RETRIES
        ) {
          if (state.retryQueued) break // 重试已排队（jitter/failover），等它接手
          state.retryQueued = true
          const upstreamErr = state.turnUpstreamError
          state.turnUpstreamError = null
          const gen = state.turnGen ?? 0
          const attempt = (state.turnRetries ?? 0) + 1
          const hadOutput = (state.turnTextChars ?? 0) > 0 || Boolean(state.turnToolStarted)
          const baseBody = state.lastPromptBody
          // 2026-09-13 刀1（b-ai 餘額歸零事故教訓）：確定性「賬戶死」類錯誤（credit/balance/
          // quota 耗盡）不是瞬態抖動——backoff＋整 turn 重投只會白等並繼續鞭打死賬戶。
          // 命中即：給該 provider 打 60s 降權＋零退避＋直接進鏈上下一个活 provider
          //（personaModelForAttempt 已過濾降權者，取鏈首即第一个活家）。429/過載/TLS
          // 斷線等瞬態一律不動，仍走原 backoff 鏈。
          const deadAccount = isDeadAccountError(upstreamErr)
          if (deadAccount && baseBody?.model?.providerID) {
            markProviderDegraded(baseBody.model.providerID, upstreamErr.slice(0, 120))
          }
          const retryBody: NonNullable<SessionState["lastPromptBody"]> =
            hadOutput || !baseBody
              ? { parts: [{ type: "text", text: "（系统提示：上一轮回复因上游模型错误中断，请从中断处继续完成任务，不要重复已完成的步骤或工具调用）" }] }
              : { ...baseBody, parts: baseBody.parts.map((pt) => ({ ...pt })) }
          console.log(
            `[gateway] turn failover: upstream error, schedule retry #${attempt} (hadOutput=${hadOutput} deadAccount=${deadAccount}) — session=${state.sessionId} error=${upstreamErr.slice(0, 160)}`,
          )
          setTimeout(async () => {
            const cur = sessions.get(state.sessionId)
            // 不看 turnTextChars（旧轮文本已计入，作让位条件会自杀）：
            // 只看会话拆除/进入下一轮/用户打断三种让位。
            if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted) return
            try {
              // 刀1：死賬戶取「降權過濾後鏈首」＝下一個活 provider（attempt=1 → pool[0]，
              // 剛被打死的一家已不在 pool）；一般錯誤維持原取模輪轉。
              const attemptModel = deadAccount
                ? personaModelForAttempt(cur, 1)
                : personaModelForAttempt(cur, attempt)
              retryBody.model = attemptModel
              const res = await fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
                method: "POST",
                headers: opencodeHeaders(),
                body: JSON.stringify(retryBody),
                signal: AbortSignal.timeout(10000),
              })
              if (!res.ok) throw new Error(`status ${res.status}`)
              cur.turnRetries = attempt
              cur.retryQueued = false
              console.log(
                `[gateway] turn failover #${attempt} dispatched model=${attemptModel.providerID}/${attemptModel.modelID} — session=${cur.sessionId}`,
              )
              // N2 同款：剥掉旧轮文本帧，断线重连不整段重放旧文案。
              stripStaleTurnTextFromReplay(cur)
              cur.turnToolStarted = false
              armWatchdogTimer(cur)
            } catch (e) {
              console.error(`[gateway] turn failover #${attempt} failed:`, e)
              cur.retryQueued = false
              emitToSession(cur, "turn.done", {}) // 重试发不出去：放弃，别留前端挂着
            }
          }, deadAccount ? 0 : TURN_RETRY_DELAY_MS)
          break // 不发 turn.done：重试轮结束自然会发
        }
        if (
          (state.turnTextChars ?? 0) === 0 &&
          !state.turnAborted &&
          state.lastPromptBody &&
          (state.turnRetries ?? 0) < TURN_MAX_RETRIES
        ) {
          if (state.retryQueued) break // 重試已排隊，等它接手
          state.retryQueued = true
          const gen = state.turnGen ?? 0
          const attempt = (state.turnRetries ?? 0) + 1
          const body = state.lastPromptBody
          console.log(`[gateway] turn jitter: schedule retry #${attempt} for ${state.sessionId}`)
          setTimeout(async () => {
            const cur = sessions.get(state.sessionId)
            // 只看 turnTextChars（語義保留見上方注釋）：重投窗口內模型開口說正文才讓位。
            if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted || (cur.turnTextChars ?? 0) > 0) return
            try {
              // 跨渠道 failover（2026-08-29）：重投前按 attempt 從鏈
              // [persona 主模型, ...registry.bindings.fallbacks[persona]] 取模換模型，
              // 根治「主/備模同源全死」事故。registry 異常時鏈只有主模型（行為=現狀）。
              const attemptModel = personaModelForAttempt(cur, attempt)
              const prevModel = body.model
              if (
                !prevModel ||
                attemptModel.providerID !== prevModel.providerID ||
                attemptModel.modelID !== prevModel.modelID
              ) {
                console.log(
                  `[gateway] turn retry #${attempt} failover model=${attemptModel.providerID}/${attemptModel.modelID} — session=${cur.sessionId}`,
                )
              }
              body.model = attemptModel
              const res = await fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
                method: "POST",
                headers: opencodeHeaders(),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10000),
              })
              if (!res.ok) throw new Error(`status ${res.status}`)
              cur.turnRetries = attempt
              cur.retryQueued = false
              console.log(`[gateway] turn retry #${attempt} dispatched for ${cur.sessionId}`)
              // N2：重試輪開始——把舊 turn 累積的文本幀從 replayBuffer 剝掉，
              // 斷線重連不再整段重放舊文案（canvas/confirm 等狀態幀保留）。
              stripStaleTurnTextFromReplay(cur)
              // R2-A：重投輪同樣可能 turn 不啟動——重置標記並重新布哨。
              cur.turnToolStarted = false
              armWatchdogTimer(cur)
            } catch (e) {
              console.error(`[gateway] turn retry #${attempt} failed:`, e)
              cur.retryQueued = false
              emitToSession(cur, "turn.done", {}) // 重試發不出去：放棄，別讓前端掛著
            }
          }, TURN_RETRY_DELAY_MS)
          break // 不發 turn.done：重試輪結束時自然會發
        }
        state.retryQueued = false
        // R4-A S3①：抖動重試已耗盡且本輪全程零文本零工具 = 上游連續報錯/空轉，
        // 舊路徑直接靜默 turn.done（R4 實錘：APIError 後 turn 空轉 5 分鐘無一句
        // 中文解釋）——補誠實收尾話術再交棒。
        // （下方判定同樣只看 turnTextChars——語義保留理由見抖動重試處注釋。）
        if (
          (state.turnTextChars ?? 0) === 0 &&
          !state.turnToolStarted &&
          !state.turnAborted &&
          (state.turnRetries ?? 0) >= TURN_MAX_RETRIES
        ) {
          emitToSession(state, "message.delta", {
            text: "连续几次自动重试都没能完成回复（上游持续报错）。你上一条消息可能没有处理成功，请重新发送一次即可继续；若内容较长，建议让我分章/分段处理。\n",
          })
          console.warn(`[gateway] S3① jitter retries exhausted with zero output, closing turn honestly — session=${state.sessionId}`)
        }
        // R4-A S8：turn 收尾兜底匯報——本輪有節點落終態但零主動匯報時，
        // 發一幀環名制中文總結（成功清單/失敗清單/下一步），杜絕悄悄收工。
        emitTurnEndSummaryIfSilent(state)
        // R5-C：恢復輪零小結零匯報時補強制結語（S8 讓位條件見函數註釋）。
        emitRecoveryClosingIfSilent(state)
        emitToSession(state, "turn.done", {})
        // S6 規格2：turn 正常結束，ack timer 不再需要。
        clearAckTimer(state)
        // S6 規格3：質詢回覆完成 → 放行被凍結的視頻工作流（先釋放再壓縮）。
        releasePendingVideoWorkflows(state)
        // 回合結束是滾動摘要壓縮的觸發點：此刻無在途生成、訊息數穩定。
        void maybeCompactSession(state)
        break
      }
      default:
        // session.updated / session.status / session.diff / session.created /
        // server.heartbeat / server.connected -> no frontend event
        break
    }
  } catch (e) {
    // Never let one malformed event kill the SSE reader loop. Log the event type
    // only — never the payload (tool inputs may contain user prompts).
    console.error(`[gateway] opencode event translation failed: type=${event?.type}`)
  }
}

function connectOpencode(): void {
  const url = `${OPENCODE_URL}/event`
  void (async () => {
    while (true) {
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: "Basic " + btoa("opencode:" + OPENCODE_PASSWORD),
            Accept: "text/event-stream",
          },
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
      }
      await sleep(2000)
    }
  })()
}

// ---- public handlers ----

async function handleCreateSession(key: string, req: Request): Promise<Response> {
  // L0 账户级记忆：编辑层在本站读取 user_profiles/agent_lessons 后随创建上送，
  // 网关只负责暂存，首条消息时注入 system。
  // 契約 §4（2026-09-15 PRD P0-4）：payload 追加 memory_docs（私有 active docs ≤8）
  // 與 memory_index_md（共享索引行）兩欄，駝峰原樣入 state.userMemory。
  let memoryBody: {
    user_profile?: Record<string, unknown>
    lessons?: string[]
    memory_empty?: boolean
    memory_docs?: MemoryDocLite[]
    memory_index_md?: string
  } = {}
  try {
    const raw = (await req.json()) as typeof memoryBody | null
    if (raw && typeof raw === "object") memoryBody = raw
  } catch {
    memoryBody = {}
  }
  const memoryDocsIncoming = Array.isArray(memoryBody.memory_docs) ? memoryBody.memory_docs.slice(0, MEMORY_PRIVATE_DOCS_MAX) : []
  const memoryIndexIncoming = typeof memoryBody.memory_index_md === "string" ? memoryBody.memory_index_md : ""
  const memoryProfileIncoming =
    memoryBody.user_profile && typeof memoryBody.user_profile === "object" ? memoryBody.user_profile : undefined
  const memoryIncoming =
    (memoryProfileIncoming && Object.keys(memoryProfileIncoming).length > 0) ||
    memoryDocsIncoming.length > 0 ||
    memoryIndexIncoming.trim().length > 0
      ? {
          user_profile: memoryProfileIncoming ?? {},
          lessons: memoryBody.lessons ?? [],
          memory_docs: memoryDocsIncoming,
          memory_index_md: memoryIndexIncoming,
        }
      : undefined

  let res: Response
  try {
    res = await fetch(`${OPENCODE_URL}/session`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  if (!res.ok) {
    return jsonError(502, `opencode create session failed: ${res.status}`, "backend_error", "backend_error")
  }
  let body: { id?: string }
  try {
    body = (await res.json()) as { id?: string }
  } catch {
    return jsonError(502, "opencode returned an invalid create-session response", "backend_error", "backend_error")
  }
  if (!body.id) {
    return jsonError(502, "opencode did not return a session id", "backend_error", "backend_error")
  }
  const sessionId = crypto.randomUUID()
  const state: SessionState = {
    sessionId,
    apiKey: key,
    opencodeSessionId: body.id,
    clients: new Set(),
    pendingConfirms: new Map(),
    pendingQuestions: new Map(),
    resolvedConfirms: new Map(),
    eventCounter: 0,
    replayBuffer: [],
    lastActivityAt: Date.now(),
    partTextEmitted: new Map(),
    partStripState: new Map(),
    announcedUrls: new Set(),
    toolStatusSeen: new Set(),
    toolInvokeSeen: new Set(),
    stepCostLogged: new Set(),
    messageRole: new Map(),
    suppressedParts: new Set(),
    canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(),
    sessionTasks: new Map(),
    canvasSnapshot: undefined,
    workflowSnapshot: undefined,
    vettingInjected: false,
    userMemory: memoryIncoming,
    // memoryInjected 死旗標已刪（D1，2026-09-15 PRD P0-4）：真閘是 vettingInjected。
    profileOnboardingPending: memoryBody.memory_empty === true,
    lastPromptBody: null,
    turnGen: 0,
    turnTextChars: 0,
    turnReasoningChars: 0,
    turnRetries: 0,
    turnAborted: false,
    retryQueued: false,
  }
  sessions.set(sessionId, state)
  saveSession(state) // 建立即同步落盤：重啟後 getOwnedSession 可恢復
  const user_id = await hashKey(key)
  console.log(`[gateway] session created: ${sessionId} (opencode ${body.id})`)
  return Response.json({ session_id: sessionId, user_id })
}

// L0 畫像 onboarding：賬戶還沒有任何確認過的畫像時，引導 agent 用 question 工具
// 以選擇題採集畫像（PM 原則：別讓用戶動腦寫表單）。答案存 pendingProfile，
// 下次建會話時作為臨時畫像注入（站點 DB 落庫前的過渡方案）。
const PROFILE_ONBOARDING_DIRECTIVE = [
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
type UserSettingsShape = { interrupt_mode: string; persona: string; cost_mode: string; interaction_mode: string }
// 野獸模式開關（MOE 改革，2026-09-08）：settings 布林欄，缺省=false（零回歸）。
// 不入 USER_SETTINGS_ENUMS（那是枚舉字串欄白名單）；POST 專門放行本欄（僅接受
// 真布林），sanitize 顯式列出欄位、缺欄=保持現值。
type UserSettingsShape = { interrupt_mode: string; persona: string; cost_mode: string; interaction_mode: string; beast_mode?: boolean }
const USER_SETTINGS_ENUMS: Record<Exclude<keyof UserSettingsShape, "beast_mode">, readonly string[]> = {
  interrupt_mode: ["steer", "queue"],
  persona: ["efficient", "thoughtful"],
  cost_mode: ["economy", "balanced", "premium"],
  interaction_mode: ["collaborate", "preset", "auto"],
}

/** 任意輸入 → 合法 settings（非法欄位值一律回落默認，寫入路徑另有 400 校驗）。 */
function normalizeUserSettings(raw: unknown): UserSettingsShape {
  const s: UserSettingsShape = { ...DEFAULT_USER_SETTINGS }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    for (const k of Object.keys(USER_SETTINGS_ENUMS) as (keyof UserSettingsShape)[]) {
      const v = r[k]
      if (typeof v === "string" && USER_SETTINGS_ENUMS[k].includes(v)) s[k] = v
    }
  }
  return s
}

/** 性格 → 等待容忍倍率：thoughtful ×1.5，efficient（及未知值）默認 1。 */
function personaPatienceMul(state: SessionState): number {
  return loadUserSettings(state.apiKey)?.persona === "thoughtful" ? 1.5 : 1
}

// Persona 綁模型（2026-08-29）：高效 → deepseek-v4-flash-vision-exp（零思考直答，快），
// 沉穩 → glm-5.3-flash（reasoningEffort=high 在 opencode.json 模型級 options 配置）。
// 每輪把 model 覆蓋塞進 promptBody（opencode prompt schema 的 model 欄位，per-message 生效，
// 實測同一 session 內兩條消息可用不同模型）。所有重試/重放路徑共用 lastPromptBody，model 隨體重放。
// max 檔不配置 = 天然禁用。opencode 1.18 的 variants 機制對 openai-compatible 渠道不透傳 options，棄用。
// Agent model registry（單一真源，2026-08-29）：/opt/agent-harness/agent-models.json
// 承載 providers + bindings（persona 主模型、跨渠道 fallbacks）。
// gen-opencode.ts 從它生成 opencode.json 的 provider/model/small_model；
// 本檔讀它決定 persona 主模型與抖動重試的 failover 鏈。按 mtime 緩存，變了才重讀。
type AgentModelRef = { providerID: string; modelID: string }
type AgentModelRegistry = {
  providers: Record<string, unknown>
  bindings: {
    default?: string
    small_model?: string
    persona?: Record<string, string>
    fallbacks?: Record<string, string[]>
  }
}
const AGENT_MODEL_REGISTRY_PATH = process.env.AGENT_MODEL_REGISTRY || "/opt/agent-harness/agent-models.json"
let agentModelRegistryCache: { mtimeMs: number; data: AgentModelRegistry } | null = null
let agentModelRegistryWarned = false

function loadAgentModelRegistry(): AgentModelRegistry | null {
  try {
    const st = statSync(AGENT_MODEL_REGISTRY_PATH)
    if (agentModelRegistryCache && agentModelRegistryCache.mtimeMs === st.mtimeMs) {
      return agentModelRegistryCache.data
    }
    const data = JSON.parse(readFileSync(AGENT_MODEL_REGISTRY_PATH, "utf8")) as AgentModelRegistry
    agentModelRegistryCache = { mtimeMs: st.mtimeMs, data }
    agentModelRegistryWarned = false
    return data
  } catch (e) {
    agentModelRegistryCache = null
    if (!agentModelRegistryWarned) {
      agentModelRegistryWarned = true
      console.warn(
        `[gateway] agent model registry unavailable (${AGENT_MODEL_REGISTRY_PATH}), using hardcoded fallbacks:`,
        e instanceof Error ? e.message : e,
      )
    }
    return null
  }
}

/** "prov/model" → { providerID, modelID }；無 "/" 或格式錯返回 null。 */
function bindingRef(ref: unknown): AgentModelRef | null {
  if (typeof ref !== "string") return null
  const idx = ref.indexOf("/")
  if (idx <= 0 || idx === ref.length - 1 || ref.slice(idx + 1).includes("/")) return null
  return { providerID: ref.slice(0, idx), modelID: ref.slice(idx + 1) }
}

// registry 缺失時的安全回退（2026-08-29 原硬編碼值，與 registry 生成前恆等）。
const PERSONA_MODEL_EFFICIENT = { providerID: "minimax-relay", modelID: "MiniMax-M3" }
const PERSONA_MODEL_THOUGHTFUL = { providerID: "hublinuxdo", modelID: "deepseek-v4-flash" }

function personaModel(state: SessionState): AgentModelRef {
  const persona = normalizeUserSettings(loadUserSettings(state.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
  const fromRegistry = bindingRef(loadAgentModelRegistry()?.bindings?.persona?.[persona])
  if (fromRegistry) return fromRegistry
  // registry 缺失時的安全回退：回到原硬編碼值，行為與 2026-08-29 之前恆等。
  return persona === "thoughtful" ? PERSONA_MODEL_THOUGHTFUL : PERSONA_MODEL_EFFICIENT
}

// ---- 2026-09-13 刀1：credit/賬戶死類錯誤 → provider 60s 降權 ----
// 進程內 Map＋到期時間戳（同檔 keyCache/canonKeyCache 同款寫法），過期自動放開；
// 不跨重啟持久——重啟時事故早已翻篇，要的就是最輕的恢復。
const PROVIDER_DEGRADE_TTL_MS = 60_000
const providerDegradeUntil = new Map<string, number>()

function markProviderDegraded(providerID: string, reason: string): void {
  providerDegradeUntil.set(providerID, Date.now() + PROVIDER_DEGRADE_TTL_MS)
  console.log(`[gateway] provider degraded 60s: ${providerID} — reason=${reason}`)
}

function isProviderDegraded(providerID: string): boolean {
  const until = providerDegradeUntil.get(providerID)
  if (until === undefined) return false
  if (until <= Date.now()) {
    providerDegradeUntil.delete(providerID)
    return false
  }
  return true
}

// 確定性「賬戶死」指紋：語義對齊 humanizer「上游余额或配额不足」條目＋事故 spec
// （credit insufficient|balance=0|quota 類）。與 429/限流/過載嚴格區分——那些瞬態、
// 仍走 backoff 重投。寬匹配 `quota` 的誤傷代價只是跳過退避換一家（60s 後放開），
// 遠低於漏判真賬戶死導致整 turn backoff 重投 2–3 次（09-13 b-ai 事故實錘）。
const DEAD_ACCOUNT_ERROR_RE =
  /credit[ _-]?insufficient|insufficient[ _-]?(account[ _-]?)?(balance|credit|quota)|balance\s*[=:]\s*0\b|\bquota\b|余额不足|欠费/i

function isDeadAccountError(msg: string | null | undefined): boolean {
  return DEAD_ACCOUNT_ERROR_RE.test(msg ?? "")
}

/** 抖動重試第 attempt 次應用的模型：鏈 = [主模型, ...registry fallbacks（跨渠道）]，
 *  去重後取模回捲（2026-09-13 刀2：primary 與 fallback 同值不佔兩格）；
 *  刀1：60s 降權中的 provider 跳過，全降權時退回全鏈（總比沒得重試強）。 */
function personaModelForAttempt(state: SessionState, attempt: number): AgentModelRef {
  const primary = personaModel(state)
  const persona = normalizeUserSettings(loadUserSettings(state.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
  const fallbacks = (loadAgentModelRegistry()?.bindings?.fallbacks?.[persona] ?? [])
    .map(bindingRef)
    .filter((r): r is AgentModelRef => r !== null)
  const chain: AgentModelRef[] = []
  for (const ref of [primary, ...fallbacks]) {
    if (!chain.some((c) => c.providerID === ref.providerID && c.modelID === ref.modelID)) chain.push(ref)
  }
  const usable = chain.filter((c) => !isProviderDegraded(c.providerID))
  const pool = usable.length > 0 ? usable : chain
  return pool[(attempt - 1) % pool.length] ?? pool[0] ?? primary
}

async function handleSendMessage(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { content?: string; canvas_state?: unknown; session_directive?: string }
  try {
    body = (await req.json()) as { content?: string; canvas_state?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const content = typeof body.content === "string" ? body.content.trim() : ""
  if (!content) return jsonError(400, "content is required", "bad_request", "bad_request")
  // R9-2（2026-08-30）：question 卡 pending 時用戶直接發新消息 —— opencode 當前
  // turn 卡在 question tool call 上，新 prompt 排隊等 turn 結束，而 question 永遠
  // 等不到回答 → 會話掛死（smoke 實錘 14 分鐘零推進）。進入 turn 流程前先用
  // 「跳過」語義 settle 全部 pending questions，解放 turn，再走正常新消息流程。
  // 每個 settle 帶 try/catch：單個失敗不擋其餘、不擋新消息。confirm 語義是花錢
  // 決策，不能替用戶決定，pendingConfirms 不在此處動。
  if (state.pendingQuestions.size > 0) {
    const skipCount = state.pendingQuestions.size
    for (const requestId of [...state.pendingQuestions.keys()]) {
      try {
        await settleQuestion(state, requestId)
      } catch (err) {
        console.error(`[gateway] auto-settle question failed: ${requestId} — session=${state.sessionId}:`, err)
      }
    }
    state.pendingQuestions.clear()
    clearQuestionHeartbeat(state)
    console.log(`[session] auto-skipped ${skipCount} pending question(s) on new user message`)
  }
  // R8-B 工單 #5（2026-08-29）：用戶給的絕對路徑在沙箱視圖（workspace）不可見、
  // 但 uploads/** 有同名文件時，生成系統注拼在 message 前面（R8 實錘：
  // /tmp/daming-book.pdf 靜默失效 25 分鐘 + 2 次 find 燒往返）。
  const pathNote = resolveInvisibleUploadPaths(content)
  // 前端附帶的畫布摘要：存入 session，供 canvas_summary 工具讀取。
  // 同一 session 的畫布狀態隨每次新訊息更新；摘要本身不進 opencode 歷史，
  // 避免 token 膨脹——agent 需要時才透過工具讀。
  if (body.canvas_state !== undefined) {
    state.canvasSummary = body.canvas_state
    state.canvasSummaryAt = Date.now()
    markDirty(state) // 畫布摘要持久化：重啟後 canvas 工具仍讀得到
  }
  // prompt_async returns 204 immediately and the reply arrives over the /event
  // SSE stream. POST /session/:id/message is SYNCHRONOUS — it blocks until the
  // model finishes (30s+), which blew the 10s timeout and made this handler
  // return 502 even though the agent had actually run.
  // 首次訊息時夾帶 system 欄位注入「意圖審查」政策：要求 agent 對用戶意圖
  // 信度不足時先反覆驗證、主動用 question 工具澄清，不可擅自揣測意圖產出。
  // system 欄位會記入 opencode user message 的 info.system，實際影響模型輸出。
  const promptBody: { parts: { type: string; text: string }[]; system?: string; model?: { providerID: string; modelID: string } } = {
    parts: [{ type: "text", text: pathNote ? `${pathNote}\n\n${content}` : content }],
  }
  // ── 契約 §4/§7 每回合召回前綴（2026-09-15 PRD P0-4）─────────────────────
  // 取上一回合 session.idle 預算好的候選（用戶路徑零新增延遲）；miss 則本回合
  // 不注入、順手排一次異步補算（此刻 lastUserMessage/turnAssistantHead 仍是
  // 上一輪值）。前綴走 parts[0].text 不走 system——保住首回合 system 的 prompt
  // caching（PRD §6.1）。此處在 lastPromptBody 落盤之前，抖動重試重放天然含前綴。
  {
    const recall = takeMemoryRecallPrefix(state.sessionId)
    if (recall === null) {
      void scheduleMemoryRecallPrefetch(state)
    } else if (recall.prefix) {
      promptBody.parts[0].text = `${recall.prefix}\n\n${promptBody.parts[0].text}`
      appendMemoryRecallTrace(state, recall.docRefs)
    }
  }
  // 2026-08-25 模板隱形注入：站點隨訊息上送 session_directive（點模板卡產生）。
  // 存進 state：抖動重試 lastPromptBody 重放時 directive 已在 system 裡；注入後棄置。
  if (typeof body.session_directive === "string" && body.session_directive.trim().length > 0) {
    state.sessionDirective = body.session_directive.slice(0, 4000)
  }
  if (!state.vettingInjected) {
        const vettingLines = [
      "這是圖像影片製作助手。用戶可能描述不清楚，但與其反覆追問，不如先拿出可反饋的產出。",
      "執行原則：",
      "1. 先開工：先給出初步方案（大綱/骨架/場次表/分鏡框架），讓用戶有具體東西可看、可改。",
      "2. 只在最關鍵參數完全缺失（如尺寸/主體/數量/風格全無且無合理默認）時，才用 question 工具確認；一次只問一個最要緊的問題，不要一次問多道。",
      "3. 已問過的問題不要重複問：用戶答過就按答案走，除非新證據推翻。",
      "4. 執行中若發現與用戶描述衝突，停下來確認，不要自己硬接。",
    ].join("\n")
    // L0 账户级记忆：首条消息带上用户画像 + 教训，模型开聊就认识用户。
    // 契約 §4（2026-09-15 PRD P0-4）：L0 = 既有 profile/lessons + memory_docs，
    // 2400 字元硬上限；L1 共享目錄 = memory_index_md，800 字元（MEMORY_SHARED_ENABLED
    // 為 false 時零注入）；字符預算 assert 與 trace 記錄在 buildMemoryInjectionBlocks 內。
    const memory = buildMemoryInjectionBlocks(state.userMemory, MEMORY_SHARED_ENABLED)
    const memoryLines = memory.lines
    if (memoryLines.length > 0) {
      const trace = ensureMemoryTrace(state)
      trace.private_docs = memory.trace.private_docs
      trace.shared_index_chars = memory.trace.shared_index_chars
      trace.injected_at = new Date().toISOString()
    }
    const onboardingLines = state.profileOnboardingPending ? [PROFILE_ONBOARDING_DIRECTIVE] : []
    // 模板引導：一次性注入（directiveInjected 防重複），不佔用戶視野。
    const directiveLines = state.sessionDirective && !state.directiveInjected ? [state.sessionDirective] : []
    promptBody.system = [vettingLines, ...(memoryLines.length > 0 ? memoryLines : []), ...onboardingLines, ...directiveLines].join("\n\n")
    if (directiveLines.length > 0) state.directiveInjected = true
    state.vettingInjected = true
    markDirty(state) // 注入標記持久化：重啟後不重複注入 system（避免 token 膨脹）
  }
  // S7：persona/cost_mode 指令每輪注入（不是只首輪）——settings 是用戶級偏好，
  // 每條 prompt 投遞都要生效；抖動重試 lastPromptBody 重放時已含本輪指令。
  // balanced 不注入成本線（默認行為，不造假約束）。
  {
    const userSettings = normalizeUserSettings(loadUserSettings(key))
    promptBody.model = personaModel(state)
    const adaptLines: string[] = [
      userSettings.persona === "thoughtful"
        ? "【回复风格】沉稳模式：先充分推理再行动，重要决定前给完整分析；宁可多想一步，不要抢答。"
        : "【回复风格】高效模式：结论先行、直接执行，思考保持精简，不铺陈过程。",
    ]
    if (userSettings.cost_mode === "economy") {
      adaptLines.push("【成本纪律】经济模式：默认单图低成本方案，禁止自动放大（upscale）与多候选并跑，能少花钱就少花钱。")
    } else if (userSettings.cost_mode === "premium") {
      adaptLines.push("【成本纪律】高质模式：允许 2-4 候选对比、允许高清放大，优先质量，花销由确认卡把关。")
    }
    if (userSettings.interaction_mode === "auto") {
      adaptLines.push("【互动模式】自动模式：完全自主推进，从理解需求到出图/出片一轮做完，用户通常只需发一条消息。分镜、剧情、构图、工作流参数全部自己决定，不要征询确认；不要调用 question 工具提问，不要等待任何扣费确认（系统会自动放行扣费确认卡）；仅当完全无法理解用户意图时才允许提问。")
    } else if (userSettings.interaction_mode === "preset") {
      adaptLines.push("【互动模式】预设模式：少问多干。先制定完整工作流计划，然后一次性整包请求授权（合并为一次扣费确认，不要把计划拆成多笔分散确认）；扣费与关键原则性决策仍须用户批准，但把要问的问题集中到尽量少的轮次一次性问完。")
    }
    // collaborate = 现状行为，不注入。
    promptBody.system = [promptBody.system, ...adaptLines].filter(Boolean).join("\n\n")
    // ── 野獸模式（MOE 改革，2026-09-08）：Orchestrator 派工協議注入 ──────────
    // settings.beast_mode（布林，缺=false）ON 時：把派遣手冊全文＋Expert 註冊表
    // 摘要（靜態檔 gateway/expert/registry-digest.txt，本地 buildExpertRegistryDigest
    // 生成上傳）注入主 agent system prompt，Orchestrator 從全能工匠變導演
    // （定位目標/寫 spec/派遣/收結果/驗收，本體不內聯動手）。手冊檔不可讀/空檔
    // 時結構化報錯拒絕裸奔（假 ON = 誠實鐵律禁止）。OFF 或缺欄：一個字不多。
    // 註冊表摘要聲明「能力斷路」：域外工具不存在於該 Expert 的工具表（現階段
    // gateway 無 per-subagent 工具白名單掛點，物理斷路留樁，先靠 prompt 約束）。
    {
      const beastMode = loadUserSettings(key)?.beast_mode === true
      if (beastMode === true) {
        let playbook = ""
        let digest = ""
        let frameError = ""
        try {
          playbook = readFileSync(`${import.meta.dir}/expert/orchestrator-dispatch-playbook.md`, "utf8")
          digest = readFileSync(`${import.meta.dir}/expert/registry-digest.txt`, "utf8")
        } catch (e) {
          frameError = e instanceof Error ? e.message : String(e)
        }
        // R7（2026-09-10）：剝離檔頭開發者元數據（HTML 註釋 version/source/gate）
        // ——gate 聲明原樣進 prompt 會讓模型反推「無處聲明當前 BEAST_MODE=ON」→
        // 合理懷疑 gate 未滿足 → 走保守路徑（09-10 暴君實測思維鏈實錘）。剝後
        // 空檔同樣視為不可用（拒裸奔）。當前狀態聲明由 gateway 動態生成，不進檔案。
        const stripProvenanceHeader = (text: string): string =>
          text.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trimStart()
        const playbookBody = stripProvenanceHeader(playbook).trimEnd()
        const digestBody = stripProvenanceHeader(digest).trimEnd()
        // R8 修復片2（2026-09-10）：能力斷路·物理事實——R7 狀態聲明之上的補丁句
        // （R7 遺留#2 的宣告升級）。orchestrator agent 工具表已物理裁剪
        // （opencode.json agent.orchestrator.tools），digest 的「能力断路」聲明
        // 由此升級為物理事實；subagent_dispatch（帶 expert 欄）是域工具唯一通路。
        const capabilityCutoffFact =
          "【能力斷路·物理事實】上列註冊表宣告的域工具不在你的工具表裡（orchestrator agent 工具表已物理裁剪，轉移調用會直接失敗）。經 subagent_dispatch（帶 expert 欄）派遣對應 Expert 是執行它們的唯一通路。AGENTS.md 路由表中對應這些工具的行，由你派遣的 Expert 代為執行；其餘工具（image_generate 等）的直調路由仍按 AGENTS.md 執行。"
        // R5 修復片（2026-09-11）：優先序聲明——野獸幀＋派遣手冊優先於 workspace/AGENTS.md，
        // 消除「你負責擴寫／親自操作 workflow_*」（AGENTS.md）vs「你本人不產出任何內容」
        // （派遣手冊第〇節）的語義分歧（R8 審計 E7；1204 秒零工具調用病灶實證）。
        const beastPrecedenceFact =
          "【優先序·野獸模式】本幀與《派遣手冊》優先於 workspace/AGENTS.md。AGENTS.md 中「你負責擴寫／你親自寫 prompt／你親自操作 workflow_* 工具」等指示，在野獸模式下由你派遣的 Expert 執行；內容生產（寫分鏡 prompt、生成圖片影片）你一律不親手做。你的動作只有：拆解任務 → subagent_dispatch（必帶 expert 欄，async:true 為常態）→ 派出後立刻用一句正文向用戶簡報 → 收完工通知後匯總回報。AGENTS.md 的安全紅線與文案規範繼續有效。"
        if (!playbookBody || !digestBody) {
          return jsonError(
            503,
            `野獸模式已開但派遣手冊或註冊表摘要不可讀（gateway/expert/）：${frameError || "檔案為空"}。拒绝裸奔主 prompt，请修复部署或暂时关闭 beast_mode。`,
            "beast_frame_unavailable",
            "beast_frame_unavailable",
          )
        }
        promptBody.system = [
          "【野獸模式：已啟用】以下派遣手冊與 Expert 註冊表由系統注入，這是當前系統的真實狀態：BEAST_MODE 現在就是 ON，以下全部條款立即生效，無需質疑、無需再確認任何 gate 條件。",
          playbookBody,
          digestBody,
          beastPrecedenceFact,
          capabilityCutoffFact,
          "---",
          promptBody.system,
        ]
          .filter(Boolean)
          .join("\n\n")
        // 能力斷路：ON 輪主會話掛 orchestrator agent（域工具已從工具表物理移除，
        // playbook prompt 聲明＋工具表移除雙保險；見 opencode.json agent.orchestrator）。
        promptBody.agent = "orchestrator"
      }
    }
  }
  // R8-C（2026-08-29）：steer 打斷語義——上一輪被用戶中止後緊接的新消息，
  // 明確告知模型「被打斷、直接回應、別重複開場白」。消除同一句開場白反覆
  // 出現（用戶視角像 agent 沒記憶、原地踏步）。turnAborted 在此尚未被重置，
  // 取值即上一輪中止狀態；此 block 在 lastPromptBody 落盤之前，重試會沿用。
  if (state.turnAborted) {
    promptBody.system = [
      promptBody.system,
      "【打断提示】上一轮你的执行被用户中止。直接回应这条新消息：不要重复上一轮已说过的话，不要重新开场或重新规划，即刻按要求干活。",
    ].filter(Boolean).join("\n\n")
  }
  // R2-A 根因修復（壓縮競態）：summarize 在途時 prompt_async 可能被
  // opencode 靜默丟棄——壓縮寫盤中途收到新 turn 是「turn 永不啟動」的
  // 高危窗口（評測會話三次壓縮後實錘）。壓縮在途 → 202 先回，記賬先落，
  // prompt 待壓縮落地後再投（期間用戶若發下一條，本條讓位）；計時器在
  // 實際投遞成功後才布，看門狗全程兜底。不在途 → 原路直投。
  const compactionJob = compactionJobs.get(state.sessionId)
  // 抖動重試記賬：本輪起點。零文本結束時用 lastPromptBody 重放。
  state.lastPromptBody = promptBody
  state.turnGen = (state.turnGen ?? 0) + 1
  state.turnTextChars = 0
  state.turnReasoningChars = 0
  state.turnAssistantHead = "" // §7 召回：本輪 assistant 正文頭部從零累積（idle prefetch 取用時恰為本輪完整頭部）
  state.turnRetries = 0
  state.turnAborted = false
  state.retryQueued = false
  state.turnUpstreamError = null
  // R2-A 看門狗：本輪起點重置啟動標記，重新布哨。
  state.turnToolStarted = false
  state.watchdogRetried = false
  // 修 1：用戶主動開新輪 = 舊 turn 的死亡宣告作廢，撤回幀不該嫁接到新輪。
  state.deathDeclared = false
  // R4-A：新輪起點重置語言守門/兜底匯報/錯誤停滯旗標（S1/S3①/S8）。
  state.englishNoticeSent = false
  state.turnNoticeSent = false
  state.turnTerminalNodes = []
  state.errorStallAlerted = false
  state.turnProgressAt = Date.now()
  // R5-C：中段停滯哨起點重置 + 任意幀時間戳起點。
  state.midturnStallRetried = false
  state.recoveryRound = false
  state.turnLastFrameAt = Date.now()
  clearErrorStallTimer(state)
  state.pendingRestoreNotice = undefined // 用戶已主動發新消息，過期中斷告知不再補投
  // N1 規格3：turn 打點（持久化）——重啟後判斷「重啟前是否有 in-flight turn」
  // 的唯一依據；turn 正常結束（idle 正常路徑）時清零。
  state.lastTurnActiveAt = Date.now()
  markDirty(state)
  // P2b 刀2：本輪起點重置空轉止損（含 idleNudgeSent，新 turn 可再補一次）。
  state.idleSteps = 0
  state.stepOpen = false
  state.stepHasTool = false
  state.stepHasText = false
  state.stepHasReasoning = false
  state.idleNudgeSent = false
  // R1（2026-09-11）刀2：回合起始 ack。評測 P0：發送後 45 秒才出現第一個事件、
  // 651 秒死寂期正文 0 字。turn 起點即應一聲，用戶 5 秒內有反饋。
  emitToSession(state, "turn.status", { text: "已收到，正在解析任務…" })
  // S6 規格3：記錄最後一條用戶消息文本與時間（質詢判定 + turn 結束時放行視頻）。
  state.lastUserMessage = content
  state.lastUserAt = Date.now()
  // R8-B 工單 #4：新輪起點重置 question 答覆標記（讓位語義只限答覆當輪）。
  state.questionAnsweredThisTurn = false
  state.turnFrozenByQuestion = false
  if (pathNote) {
    // R9-5：原始路徑解析資訊（含 /tmp/... 與 uploads/... 技術細節）只進 debug 日誌，
    // 用戶可見文字改成人話——不再把後端 raw log 當回答吐給用戶。
    console.debug(`[gateway] R9-5 path resolution: session=${state.sessionId} ${pathNote}`)
    emitToSession(state, "message.delta", { text: "（文件已找到，正在分析…）\n" })
  }
  if (compactionJob) {
    console.log(`[gateway] prompt deferred behind compaction: session=${state.sessionId} gen=${state.turnGen}`)
    const gen = state.turnGen
    void compactionJob
      .catch(() => {}) // 壓縮失敗也要投遞：壓縮是優化，消息是主線
      .then(async () => {
        const cur = sessions.get(state.sessionId)
        if (!cur || (cur.turnGen ?? 0) !== gen) return // 用戶已發下一條，本條讓位
        try {
          const res = await fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
            method: "POST",
            headers: opencodeHeaders(),
            body: JSON.stringify(promptBody),
            signal: AbortSignal.timeout(10000),
          })
          if (!res.ok) throw new Error(`status ${res.status}`)
          console.log(`[gateway] deferred prompt dispatched: session=${cur.sessionId} gen=${gen}`)
          armWatchdogTimer(cur)
          // S6 規格2：30s ack——實際投遞後才起算。
          armAckTimer(cur)
          // N1 規格1：心跳提示同起點布防。
          armHeartbeatTimer(cur)
        } catch (e) {
          console.error(`[gateway] deferred prompt dispatch failed: session=${cur.sessionId}:`, e)
          emitToSession(cur, "message.delta", { text: "消息投递失败（后端正忙），请稍后重发。\n" })
          // R9-4：deferred 失敗路徑同樣尊重 question 凍結，pending 期間不發 turn.done。
          if (cur.pendingQuestions.size === 0) emitToSession(cur, "turn.done", {})
        }
      })
    return Response.json({ session_id: id }, { status: 202 })
  }
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify(promptBody),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode send message failed: ${res.status}`, "backend_error", "backend_error")
    }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  armWatchdogTimer(state)
  // S6 規格2：30s ack——模型沒開口前閘門先替它應一聲。
  armAckTimer(state)
  // N1 規格1：30s 心跳提示（與 ack 內部錯峰：ack 已發則順延到 45s）。
  armHeartbeatTimer(state)
  return Response.json({ session_id: id }, { status: 202 })
}

// ---- 滾動摘要壓縮（rolling summary via opencode native summarize）----
// 訊息歷史的 owner 是 opencode：壓縮直接用它的 AI compaction 端點
// POST /session/:id/summarize（已實測：生成 summary 訊息 + compaction part，
// 模型後續上下文以摘要為準；舊訊息仍留在存儲供前端展示與 GET history 端點讀取）。
// 不在 gateway 另存一份 messages —— 那是第二份會漂移的歷史副本。
// 防抖兩層：in-memory in-flight Set（一次壓縮完成前不重複觸發）+ 持久化水位
// compact.lastCount（自上次壓縮新增不足半個閾值不觸發，重啟後水位仍在）。
const SESSION_COMPACT_THRESHOLD = Number.parseInt(process.env.SESSION_COMPACT_THRESHOLD || "40", 10) || 40
const SESSION_COMPACT_MIN_NEW = Math.max(4, Math.floor(SESSION_COMPACT_THRESHOLD / 2))
const SESSION_COMPACT_TIMEOUT_MS = 180_000
// R2-A 根因修復：in-flight 從 Set 升級為可等待的 Map——handleSendMessage
// 能感知「壓縮在途」並把 prompt 投遞推遲到壓縮落地之後，消除
// 「summarize 寫盤中途收到新 turn → turn 靜默死亡」的時序競態。
const compactionJobs = new Map<string, Promise<void>>()

async function maybeCompactSession(state: SessionState): Promise<void> {
  if (compactionJobs.has(state.sessionId)) return
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return
    const msgs = (await res.json()) as Array<{
      info?: { role?: string; model?: { providerID?: string; modelID?: string } }
    }>
    if (!Array.isArray(msgs)) return
    const count = msgs.length
    if (count < SESSION_COMPACT_THRESHOLD) return
    // 0831 競態根治：opencode binary 對摘要訊息硬擋 tool call（"Tool call not allowed
    // while generating summary"）。摘要模型若看到「還有任務待查」就會吐 tool call →
    // 整條摘要作廢、session 無聲 idle。壓縮前必須無在途生成任務。
    // 註：state.sessionTasks 在網關重啟後為空（hydrate 補空 Map）→ 在途閘自然放行，可接受。
    const inflight = [...state.sessionTasks.values()].filter(
      (t) => t.status === "queued" || t.status === "running",
    )
    if (inflight.length > 0) {
      console.log(`[gateway] compact deferred: ${state.sessionId} has ${inflight.length} in-flight task(s)`)
      return
    }
    const lastCount = state.compact?.lastCount ?? 0
    if (count - lastCount < SESSION_COMPACT_MIN_NEW) return
    // summarize 需要 providerID+modelID：取最近一條帶 model 資訊的訊息（與該會話實際模型一致）。
    let providerID: string | undefined
    let modelID: string | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]?.info?.model
      if (m?.providerID && m?.modelID) {
        providerID = m.providerID
        modelID = m.modelID
        break
      }
    }
    if (!providerID || !modelID) {
      console.warn(`[gateway] compact skipped: no model info in session ${state.sessionId}`)
      return
    }
    compactionJobs.set(
      state.sessionId,
      (async () => {
        const r = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/summarize`, {
          method: "POST",
          headers: opencodeHeaders(),
          body: JSON.stringify({ providerID, modelID }),
          signal: AbortSignal.timeout(SESSION_COMPACT_TIMEOUT_MS),
        })
        if (!r.ok) {
          console.warn(`[gateway] session compact failed: ${state.sessionId} status=${r.status}`)
          return
        }
        // 0831 假成功誠實化：/summarize 回 HTTP 200 不等於摘要成功。opencode binary 對
        // 摘要訊息硬擋 tool call，摘要模型若吐 image_get_result → 整條摘要帶 error、
        // session 無聲 idle，但 HTTP 仍 200。舊碼據 200 就推進水位 = 假成功。
        // 故 200 後再取一次訊息列表，若 summary/compaction 訊息自帶 error 即判失敗、不推進水位。
        let verifyMsgs: Array<{ info?: { summary?: boolean; mode?: string; error?: unknown } }>
        try {
          const vr = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
            headers: opencodeHeaders(),
            signal: AbortSignal.timeout(10_000),
          })
          if (!vr.ok) {
            console.warn(`[gateway] session compact UNVERIFIED (status=${vr.status}), 水位不推進: ${state.sessionId}`)
            return
          }
          const vj = (await vr.json()) as Array<{ info?: { summary?: boolean; mode?: string; error?: unknown } }>
          if (!Array.isArray(vj)) {
            console.warn(`[gateway] session compact UNVERIFIED (bad payload), 水位不推進: ${state.sessionId}`)
            return
          }
          verifyMsgs = vj
        } catch (e) {
          console.warn(`[gateway] session compact UNVERIFIED (fetch error: ${e}), 水位不推進: ${state.sessionId}`)
          return
        }
        const badSummary = verifyMsgs.find(
          (m) => (m?.info?.summary === true || m?.info?.mode === "compaction") && m?.info?.error,
        )
        if (badSummary) {
          console.warn(
            `[gateway] session compact FAILED (summary errored, 水位不推進): ${state.sessionId} err=${JSON.stringify(badSummary.info?.error)}`,
          )
          return
        }
        state.compact = { lastCount: count, at: Date.now() }
        markDirty(state)
        console.log(
          `[gateway] session compacted: ${state.sessionId} (${count} messages -> summary, now ${verifyMsgs.length} msgs)`,
        )
      })(),
    )
    try {
      await compactionJobs.get(state.sessionId)
    } finally {
      compactionJobs.delete(state.sessionId)
    }
  } catch (e) {
    console.warn(`[gateway] session compact error for ${state.sessionId}: ${e}`)
  }
}

function handleEventStream(key: string, id: string, req: Request): Response {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let lastEventId: number | undefined
  const raw = req.headers.get("last-event-id") || new URL(req.url).searchParams.get("last_event_id")
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (!Number.isNaN(n)) lastEventId = n
  }
  return openEventStream(state, lastEventId, req)
}

async function handleConfirm(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { request_id?: string; approved?: boolean }
  try {
    body = (await req.json()) as { request_id?: string; approved?: boolean }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const requestId = body.request_id
  if (!requestId) return jsonError(400, "request_id is required", "bad_request", "bad_request")
  // 404, not 200 {ok:false}: an unknown request_id means the confirm already
  // expired, was already answered, or never existed. Returning 200 made those
  // indistinguishable from success, so a frontend that lost the race would
  // show "confirmed" while the tool had actually been cancelled.
  if (!state.pendingConfirms.has(requestId)) {
    return jsonError(404, "confirm request unknown or already resolved", "not_found", "confirm_expired")
  }
  // settleConfirm emits confirm.resolved, writes the ledger and refreshes quota.
  // The tool learns the answer from its own poll, not from this response.
  settleConfirm(state, requestId, body.approved ? "approved" : "denied")
  return Response.json({ ok: true })
}

function normalizeQuestionOptions(raw: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ label: string; description?: string }> = []
  for (const opt of raw) {
    if (!opt || typeof opt !== "object") continue
    const rec = opt as Record<string, unknown>
    const label = typeof rec.label === "string" ? rec.label.trim() : ""
    if (!label) continue
    const description = typeof rec.description === "string" ? rec.description : undefined
    out.push(description ? { label, description } : { label })
  }
  return out
}

function normalizeQuestionItems(raw: unknown): PendingQuestion["questions"] {
  if (!Array.isArray(raw)) return []
  const out: PendingQuestion["questions"] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const question = typeof rec.question === "string" ? rec.question.trim() : ""
    if (!question) continue
    const header = typeof rec.header === "string" ? rec.header : undefined
    const options = normalizeQuestionOptions(rec.options)
    out.push(header ? { question, header, options } : { question, options })
  }
  return out
}

function isQuestionAnswers(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string" && cell.length > 0))
}

async function lookupOpencodeQuestion(state: SessionState, callId: string): Promise<{ id: string; questions: PendingQuestion["questions"] } | null> {
  const urls = [
    `${OPENCODE_URL}/api/session/${encodeURIComponent(state.opencodeSessionId)}/question`,
    `${OPENCODE_URL}/question`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: opencodeHeaders(),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) continue
      const payload = await res.json()
      const list = Array.isArray(payload) ? payload : []
      for (const item of list) {
        if (!item || typeof item !== "object") continue
        const rec = item as Record<string, unknown>
        const id = typeof rec.id === "string" ? rec.id : ""
        if (!id.startsWith("que")) continue
        const tool = rec.tool && typeof rec.tool === "object" ? (rec.tool as Record<string, unknown>) : null
        const toolCallId = typeof tool?.callID === "string" ? tool.callID : ""
        if (toolCallId && toolCallId !== callId) continue
        // 2026-08-31: 移除 sessionID 過濾——opencode question record 的
        // sessionID 常是幽靈 session（不存在於 session 清單），會濾掉全部卡片。
        // tool.callID 已全域唯一，無跨 session 誤配風險。
        const questions = normalizeQuestionItems(rec.questions)
        if (questions.length === 0) continue
        return { id, questions }
      }
    } catch {
      // try the next lookup path
    }
  }
  return null
}

async function emitQuestionRequest(state: SessionState, callId: string, input: unknown): Promise<void> {
  if (!callId) return
  for (const pending of state.pendingQuestions.values()) {
    if (pending.callId === callId) return
  }
  let lookedUp = await lookupOpencodeQuestion(state, callId)
  for (let attempt = 0; attempt < 8 && !lookedUp?.id; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    lookedUp = await lookupOpencodeQuestion(state, callId)
  }
  const fallbackQuestions = normalizeQuestionItems((input as { questions?: unknown } | null)?.questions)
  const requestId = lookedUp?.id ?? ""
  const questions = lookedUp?.questions?.length ? lookedUp.questions : fallbackQuestions
  if (!requestId || questions.length === 0) {
    console.warn(`[gateway] question tool ${callId} has no que_* request yet`)
    if (state.toolStatusSeen.has(`${callId}:running`)) state.toolStatusSeen.delete(`${callId}:running`)
    if (state.toolStatusSeen.has(`${callId}:pending`)) state.toolStatusSeen.delete(`${callId}:pending`)
    return
  }
  if (state.pendingQuestions.has(requestId)) return
  state.pendingQuestions.set(requestId, { requestId, callId, questions })
  emitToSession(state, "question.request", { request_id: requestId, questions })
  // R8-B 工單 #3：pending 期間 30s 心跳接管用戶可見性（R8 實錘 129s 零幀死寂）。
  armQuestionHeartbeat(state)
  // 片AJ：3 分鐘無人回覆按推薦方案代答繼續（assumed）。
  armQuestionAssumeTimer(state)
}

async function hydratePendingQuestions(state: SessionState): Promise<void> {
  const urls = [
    `${OPENCODE_URL}/api/session/${encodeURIComponent(state.opencodeSessionId)}/question`,
    `${OPENCODE_URL}/question`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: opencodeHeaders(),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) continue
      const payload = await res.json()
      const list = Array.isArray(payload) ? payload : []
      for (const item of list) {
        if (!item || typeof item !== "object") continue
        const rec = item as Record<string, unknown>
        const id = typeof rec.id === "string" ? rec.id : ""
        if (!id.startsWith("que")) continue
        const sessionID = typeof rec.sessionID === "string" ? rec.sessionID : ""
        // 2026-08-31: 同 lookupOpencodeQuestion，移除 sessionID 過濾（幽靈 session 誤殺）
        const questions = normalizeQuestionItems(rec.questions)
        if (questions.length === 0) continue
        if (state.pendingQuestions.has(id)) continue
        const tool = rec.tool && typeof rec.tool === "object" ? (rec.tool as Record<string, unknown>) : null
        const callId = typeof tool?.callID === "string" ? tool.callID : ""
        state.pendingQuestions.set(id, { requestId: id, callId, questions })
        emitToSession(state, "question.request", { request_id: id, questions })
        // R8-B 工單 #3：hydrate 出的 pending question 同樣布心跳。
        armQuestionHeartbeat(state)
        // 片AJ：hydrate 的 pending 同樣布 3 分鐘代答哨。
        armQuestionAssumeTimer(state)
      }
      return
    } catch {
      // try the next lookup path
    }
  }
}

async function rejectOpencodeQuestion(requestId: string, sessionId: string): Promise<void> {
  const urls = [
    `${OPENCODE_URL}/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reject`,
    `${OPENCODE_URL}/question/${encodeURIComponent(requestId)}/reject`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: opencodeHeaders(),
        body: "{}",
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok || res.status === 404) return
    } catch {
      // best-effort
    }
  }
}

async function handleQuestion(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { request_id?: string; answers?: unknown }
  try {
    body = (await req.json()) as { request_id?: string; answers?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const requestId = typeof body.request_id === "string" ? body.request_id.trim() : ""
  if (!requestId || !requestId.startsWith("que")) {
    return jsonError(400, "request_id is required", "bad_request", "bad_request")
  }
  if (!isQuestionAnswers(body.answers)) {
    return jsonError(400, "answers is required", "bad_request", "bad_request")
  }
  if (!state.pendingQuestions.has(requestId)) {
    return jsonError(404, "question request unknown or already resolved", "not_found", "question_expired")
  }
  const urls = [
    `${OPENCODE_URL}/api/session/${encodeURIComponent(state.opencodeSessionId)}/question/${encodeURIComponent(requestId)}/reply`,
    `${OPENCODE_URL}/question/${encodeURIComponent(requestId)}/reply`,
  ]
  let lastStatus = 0
  let lastText = ""
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify({ answers: body.answers }),
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        state.pendingQuestions.delete(requestId)
        const answerText = body.answers.flat().find((cell) => cell.length > 0) ?? ""
        // R8-B 工單 #4：記錄答覆語義。opencode 的 reply 端點會把 answers 作為
        // question 工具結果回灌模型上下文（R8 實錘模型正確執行「先看第三章」
        // /「就地打住」）；gateway 側職責 = 不再用兜底結語「要繼續跑嗎」自我推翻
        //（emitRecoveryClosingIfSilent 讓位），並把哨兵打點刷新到恢復段起點。
        state.questionAnsweredThisTurn = true
        state.turnFrozenByQuestion = false
        if (state.pendingQuestions.size === 0) clearQuestionHeartbeat(state)
        state.turnLastFrameAt = Date.now()
        state.turnProgressAt = Date.now()
        state.lastUserVisibleAt = Date.now()
        // 恢復段重新布哨：若答覆後 opencode 未續跑，中段停滯哨 90s 兜底；
        // pending 期間停滯哨會讓位（見 armMidturnStallTimer），此處已清空 pending。
        armMidturnStallTimer(state)
        armQuietNoticeTimer(state)
        emitToSession(state, "question.replied", { request_id: requestId, answer: answerText })
        return Response.json({ ok: true })
      }
      lastStatus = res.status
      lastText = await res.text().catch(() => "")
      if (res.status !== 404) break
    } catch (err) {
      lastText = err instanceof Error ? err.message : "upstream unreachable"
    }
  }
  return jsonError(lastStatus >= 400 ? lastStatus : 502, lastText || "failed to reply to question", "backend_error", "backend_error")
}

// R9-2（2026-08-30）：question pending 時新消息入口的自動跳過代答。轉發核心
// 逐行複製 handleQuestion 的 reply 鏈路（雙 URL 兜底 + ok 後同款記賬），只換
// answer 內容為跳過語義；best-effort——上游失敗不拋出，由調用方清 Map 並照常
// 發新消息。
async function settleQuestion(state: SessionState, requestId: string, answerOverride?: string): Promise<void> {
  const answerText = answerOverride ?? "（用户已转向新话题，本问题自动跳过）"
  // reply 端點要求 answers 為 string[][] 且每格非空（isQuestionAnswers 同款），
  // 一行對應一道 question：逐題填充同一句跳過文案。
  const pending = state.pendingQuestions.get(requestId)
  const answers = Array.from({ length: Math.max(pending?.questions.length ?? 1, 1) }, () => [answerText])
  const urls = [
    `${OPENCODE_URL}/api/session/${encodeURIComponent(state.opencodeSessionId)}/question/${encodeURIComponent(requestId)}/reply`,
    `${OPENCODE_URL}/question/${encodeURIComponent(requestId)}/reply`,
  ]
  let replied = false
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify({ answers }),
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        replied = true
        break
      }
      if (res.status !== 404) break
    } catch {
      // best-effort
    }
  }
  state.pendingQuestions.delete(requestId)
  if (replied) {
    // ok 後記賬同 handleQuestion：答覆語義標記 + 時間戳刷新。此處布的中段哨/
    // 靜默哨捕獲舊 turnGen，handleSendMessage 隨後 bump turnGen，tick 因 gen
    // 不匹配自行失效，無殘留（見 armMidturnStallTimer/armQuietNoticeTimer 守衛）。
    state.questionAnsweredThisTurn = true
    state.turnFrozenByQuestion = false
    if (state.pendingQuestions.size === 0) clearQuestionHeartbeat(state)
    state.turnLastFrameAt = Date.now()
    state.turnProgressAt = Date.now()
    state.lastUserVisibleAt = Date.now()
    armMidturnStallTimer(state)
    armQuietNoticeTimer(state)
  }
  // 無論上游成敗都按既有形態 emit：前端 question 卡必須變已決，否則永遠 pending。
  emitToSession(state, "question.replied", { request_id: requestId, answer: answerText })
}

// Best-effort upstream cleanup. Shared by the explicit DELETE route and the
// idle reaper so a reaped session never leaves an orphan opencode session
// behind (each one holds its own message history on disk).
async function deleteOpencodeSession(opencodeSessionId: string): Promise<void> {
  try {
    await fetch(`${OPENCODE_URL}/session/${opencodeSessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // best-effort: an orphan upstream session is not worth failing a request over
  }
}

// Drop a session from the map, resolve anything still waiting on it, and close
// its streams. Shared teardown for DELETE and the reaper.
function teardownSession(id: string, state: SessionState, reason: string, keepRow = false): void {
  sessions.delete(id)
  dirtySessions.delete(id)
  // 工作流擁有權清理：session 已拆，內存工作流一併摘除（idle reap 保留 row 時，
  // 快照仍在 DB，revive 後可再恢復）。
  const wfid = workflowOwnerBySession.get(id)
  if (wfid) {
    workflowOwnerBySession.delete(id)
    const wf = workflowService.get(wfid)
    if (wf && wf.owner === state) workflowService.forget(wfid)
  }
  // idle reaper keeps the sqlite row: lazy reload can revive the session later.
  // Only explicit DELETE removes the durable record.
  if (!keepRow) deleteSessionRow(id) // 持久化鏡像：teardown（DELETE / idle reap）同步刪 row
  revokeSseTicketsFor(id) // a ticket must not outlive the session it names
  repromptedSessions.delete(id) // N1：重投去重集合隨會話拆除回收，防記憶體緩漲
  memoryRecallPrefetch.delete(id) // §7 召回預取緩存隨會話銷毀清理（2026-09-15 PRD P0-4）
  memoryRecallInflight.delete(id)
  // A pending spend must never auto-approve on teardown. Record the denial
  // rather than just dropping it: a tool still polling has to be able to read
  // the answer, and after teardown this state object is all that is left.
  for (const [requestId, pending] of state.pendingConfirms) {
    clearTimeout(pending.timer)
    state.resolvedConfirms.set(requestId, { outcome: "denied", resolvedAt: Date.now() })
    emitToSession(state, "confirm.resolved", { request_id: requestId, approved: false })
  }
  state.pendingConfirms.clear()
  for (const [requestId] of state.pendingQuestions) {
    emitToSession(state, "question.rejected", { request_id: requestId, reason: reason || "session_closed" })
    void rejectOpencodeQuestion(requestId, state.opencodeSessionId)
  }
  state.pendingQuestions.clear()
  clearAckTimer(state) // S6：會話拆了，ack timer 不得再觸發（發了也沒人收）
  clearWatchdogTimer(state) // R2-A：看門狗同撤，不得對死會話重投
  clearQuestionHeartbeat(state) // R8-B：question 心跳同撤
  clearQuietNoticeTimer(state) // R8-B：靜默通知同撤
  state.pendingVideoWorkflows = [] // 凍結的工作流隨會話一併作廢
  // 2026-09-12：idle reap（keepRow=true）是內存回收不是會話死亡。emitToSession 會把 closed 幀
  // 寫進 replayBuffer 並落盤，之後任何 Last-Event-ID=0 的回放都會帶上它 → 前端按合同把會話
  // 判死，永久鎖死。只有真刪除（keepRow=false：用戶 end()/DELETE）才宣告 session.closed。
  if (!keepRow) emitToSession(state, "session.closed", { reason })
  closeSessionStreams(state)
}

async function handleDeleteSession(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  teardownSession(id, state, "deleted")
  await deleteOpencodeSession(state.opencodeSessionId)
  const delUploadDir = path.join(UPLOADS_DIR, state.sessionId)
  if (existsSync(delUploadDir)) {
    void rm(delUploadDir, { recursive: true, force: true }).catch((e: unknown) => {
      console.error(`[gateway] upload cleanup error for ${id}:`, e)
    })
  }
  console.log(`[gateway] session deleted: ${id}`)
  return Response.json({ ok: true })
}

// GET /agent/v1/sessions/:id — 會話恢復端點（重啟後歷史仍在的讀取路徑）。
// 歷史從 opencode（權威存儲）讀取；getOwnedSession 內含 DB lazy reload，
// 因此進程重啟後仍可解析。只讀，不改任何狀態、不動 CORS/SSE/ticket 行為。
async function handleGetSession(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(15_000),
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

// Force-stop the in-flight assistant turn on the opencode side. This is a real
// system-level cancel (not a soft "please stop" prompt): the running turn is
// terminated immediately, no further tools run, no more money is spent.

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

async function handleGetSessionMessages(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const cursor = {
    event_counter: state.eventCounter,
    replay_first_id: state.replayBuffer.length > 0 ? state.replayBuffer[0].id : null,
  }
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(30_000),
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

async function handleTranscript(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let limit = 200
  try {
    const n = Number(new URL(req.url).searchParams.get("limit"))
    if (Number.isFinite(n) && n > 0) limit = Math.min(500, Math.floor(n))
  } catch { /* 預設 200 */ }
  let msgs: unknown = null
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return jsonError(502, "upstream unavailable", "upstream_error", "upstream_error")
    msgs = await res.json()
  } catch {
    return jsonError(502, "upstream unavailable", "upstream_error", "upstream_error")
  }
  const out: Array<{ role: string; parts: Array<{ type: "text"; text: string } | { type: "tool"; tool: string; input: unknown }> }> = []
  if (Array.isArray(msgs)) {
    const tail = msgs.slice(-limit)
    for (const m of tail) {
      const role = m?.info?.role === "user" ? "user" : "assistant"
      const parts: Array<{ type: "text"; text: string } | { type: "tool"; tool: string; input: unknown }> = []
      if (Array.isArray(m?.parts)) {
        for (const p of m.parts) {
          if (p?.type === "text" && typeof p.text === "string") {
            parts.push({ type: "text", text: p.text })
          } else if (p?.type === "tool" && typeof p.tool === "string") {
            parts.push({ type: "tool", tool: p.tool, input: p.state?.input ?? null })
          }
        }
      }
      if (parts.length > 0) out.push({ role, parts })
    }
  }
  return Response.json({ messages: out })
}

async function handleAbortSession(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/abort`, {
      method: "POST",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode abort failed: ${res.status}`, "backend_error", "backend_error")
    }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  state.turnAborted = true // 用戶主動中止：不觸發抖動重試
  // N2 同款（2026-09-02）：用戶中止即剝掉本輪文本幀——SSE 斷線重連不再整段
  // 重放被中止輪的舊文案（stale delta 閃回根治）。
  stripStaleTurnTextFromReplay(state)
  return Response.json({ ok: true })
}

function extractBalance(data: unknown): number | null {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    for (const k of ["balance_coins", "balance", "coins", "credit"]) {
      if (typeof obj[k] === "number") return obj[k]
    }
    if (obj.data && typeof obj.data === "object") return extractBalance(obj.data)
  }
  return null
}

// The platform exposes no balance endpoint yet (/v1/quota, /v1/balance,
// /v1/credits, /v1/me, /v1/usage, /v1/account all 404 with an HTML body as of
// 2026-08-07 — it is PRD part 1 work). Returning 0 here would be a lie that
// renders in the UI as "you have no coins" and would block the purchase flow.
// So: null means "unknown", and `available:false` tells the frontend to hide the
// balance chip rather than render a zero. When the platform ships the endpoint,
// set QUOTA_URL and this starts returning real numbers with no other change.
let quotaUnavailableLogged = false

async function fetchBalance(key: string): Promise<number | null> {
  try {
    const res = await fetch(QUOTA_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      if (!quotaUnavailableLogged) {
        console.warn(`[gateway] balance endpoint unavailable (${QUOTA_URL} -> ${res.status}); reporting balance as unknown`)
        quotaUnavailableLogged = true
      }
      return null
    }
    const ct = res.headers.get("content-type") ?? ""
    if (!ct.includes("json")) {
      if (!quotaUnavailableLogged) {
        console.warn(`[gateway] balance endpoint returned ${ct || "unknown content-type"}, not json; reporting balance as unknown`)
        quotaUnavailableLogged = true
      }
      return null
    }
    return extractBalance(await res.json())
  } catch {
    return null
  }
}

function quotaPayload(balance: number | null): Record<string, unknown> {
  return balance === null
    ? { balance_coins: null, currency: "coins", available: false, reason: "platform_balance_endpoint_missing" }
    : { balance_coins: balance, currency: "coins", available: true }
}

async function handleQuota(key: string): Promise<Response> {
  return Response.json(quotaPayload(await fetchBalance(key)))
}

async function emitQuotaChanged(state: SessionState): Promise<void> {
  try {
    const balance = await fetchBalance(state.apiKey)
    // Don't fire a quota.changed carrying "unknown" — a frontend that renders it
    // would flash the balance chip to blank on every image. Stay silent instead.
    if (balance === null) return
    emitToSession(state, "quota.changed", quotaPayload(balance))
  } catch (e) {
    console.error(`[gateway] quota.changed emit failed: ${e}`)
  }
}

/**
 * opencode errors are shaped { name, data: { message } } -- NOT { code, message }.
 * Reading .message straight off the object yields undefined, which is how every
 * real failure ("Invalid API Key", a whisper audio model driven as chat) reached
 * the browser as the useless literal "session error".
 * Order matters: data.message is the human reason, name is the class.
 */
function opencodeErrorMessage(err: unknown): string {
  if (typeof err === "string" && err.length > 0) return err
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; name?: unknown; data?: { message?: unknown } }
    const nested = e.data?.message
    if (typeof nested === "string" && nested.length > 0) return nested
    if (typeof e.message === "string" && e.message.length > 0) return e.message
    if (typeof e.name === "string" && e.name.length > 0) return e.name
  }
  return "session error"
}

function opencodeErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; name?: unknown }
    if (typeof e.code === "string" && e.code.length > 0) return e.code
    if (typeof e.name === "string" && e.name.length > 0) return e.name
  }
  return "backend_error"
}

function emitSessionError(state: SessionState, code: string, message: string): void {
  // Always log: a session.error that only exists in the browser costs a VPS dig
  // to diagnose. Codes/messages here are model-provider text, never credentials.
  console.error(`[gateway] session.error code=${code} message=${message}`)
  // 2026-09-02：用戶中止（MessageAbortedError / Tool execution aborted）不是錯誤——
  // 此前每個被殺工具都彈一條紅色「已按你的要求中止本轮」notice（一次中止 3-4 連彈），
  // MessageAbortedError 還會誤布錯誤停滯哨（中止後又彈「上游刚才报错了」）。
  // 中止的 UI 收尾由 turn.done 表達；這裡只留日誌，不發幀、不記上游錯、不布哨。
  if (code === "MessageAbortedError" || /abort/i.test(message)) return
  // 2026-08-31：上游模型错误（TLS 断链/输出审核 400/欠费 403 等）记入 flag，
  // idle 收尾走 failover 换模重投；tool_error 是工具拒绝、Aborted 是用户打断，
  // 都不是渠道问题，不记。
  if (code !== "tool_error" && code !== "MessageAbortedError") state.turnUpstreamError = message
  // S5a：供應商/上游錯誤人話化——原文 message 保留，映射命中時加 human_message。
  const human = humanizeSupplierError(message)
    // 2026-08-27 代理池轮换：LLM 上游的 RegionError/FreeUsageLimit 是瞬态错误
  // （轮换 IP 命中被地区屏蔽/限流的节点），下一次请求大概率换节点就好了。
  // 归零 turnTextChars 让 session.idle 的抖动重试路径自动重发 prompt。
  if (/not available in your country|RegionError|FreeUsageLimit|Rate limit exceeded/i.test(message)) {
    if ((state.turnTextChars ?? 0) === 0 && state.lastPromptBody && (state.turnRetries ?? 0) < TURN_MAX_RETRIES) {
      state.turnTextChars = 0 // 保持零文本，抖动重试会接手
    }
  }
  emitToSession(state, "session.error", { code, message, ...(human ? { human_message: human } : {}) })
  // R4-A S3①：上游/LLM 錯誤（非工具拒絕）後布停滯哨——R4 實錘 APIError 後
  // turn 空轉 5 分鐘零告警。tool_error 是工具被拒，turn 照常走，不布哨。
  if (code !== "tool_error") armErrorStallTimer(state)
}

// ─────────────────────────────────────────────────────────────────────────────
// S6（2026-08-27）：異步心跳匯報制——「承諾逐條匯報」的兌現層。
// 三件事全在 gateway 做（agent 模型靠不住，閘門自己開口）：
//   1) 節點終態 60s 內主動匯報（成功含花費；失敗含中文短句與退款事實）
//   2) 用戶消息 30s 無回應先發短 ack
//   3) 質詢類消息未答覆期間凍結視頻類工作流自動開跑（agent 回覆完才放行）
// 匯報幀走 message 通道：事件名 message.delta + turn.done，前端現有
// reducer 直接渲染成 agent 消息——零前端改動的最小破壞實現。

/** S6 匯報專用：以 agent 口吻經 message 通道發一條完整短訊（delta + turn.done）。 */
function emitAgentNotice(state: SessionState, text: string): void {
  if (!text) return
  // R4-A S8：本輪已有主動匯報 → turn 收尾兜底匯報讓位。
  state.turnNoticeSent = true
  emitToSession(state, "message.delta", { text })
  emitToSession(state, "turn.done", {})
}

/**
 * 規格1：節點終態匯報。workflow-service 每個節點落終態後都會 emit
 * canvas.node.updated（success/error）；在 index.ts 端掛鉤子（不動
 * workflow-service 的 emit 契約）：終態幀 → 節點元資訊 + 資金事實 → 60s
 * 立即匯報（實測為同步緊跟，遠小於 60s 預算）。資金事實來源：
 *   - 花費：終態幀自帶 cost_coins（成功路徑上游 poll 結果）
 *   - 退款：工作流視頻失敗路徑無退款憑證可查——誠實說「退款狀態查不到，
 *     已產生的扣款以平台帳單為準」，絕不口頭宣稱已退（I 罪狀反義詞）。
 */
function reportNodeTerminalState(
  state: SessionState,
  payload: {
    unit_id?: string
    node_id?: string
    patch?: { status?: string; cost_coins?: number; errorDetails?: string; human_message?: string }
    cost_coins?: number
  },
): void {
  const nodeId = typeof payload.node_id === "string" ? payload.node_id : ""
  const status = payload.patch?.status
  if (!nodeId || (status !== "success" && status !== "error")) return
  // 去重：同一節點同一終態只匯報一次（rerun 會先置 running 清鍵，可再觸發）。
  if (!state.nodeTerminalReported) state.nodeTerminalReported = new Set()
  const key = `${nodeId}:${status}`
  if (state.nodeTerminalReported.has(key)) return
  state.nodeTerminalReported.add(key)
  boundSet(state.nodeTerminalReported, 400)

  // 節點顯示名：標題不可得時用 node_id 尾段（role-序號）。
  const shortId = nodeId.includes("-") ? nodeId.slice(nodeId.lastIndexOf("-") + 1) : nodeId
  const kindLabel = nodeId.includes("video") ? "视频节点" : nodeId.includes("image") ? "图片节点" : "节点"
  const label = `${kindLabel} ${shortId}`
  const cost = typeof payload.patch?.cost_coins === "number"
    ? payload.patch.cost_coins
    : typeof payload.cost_coins === "number"
      ? payload.cost_coins
      : undefined

  if (status === "success") {
    const costText = typeof cost === "number" ? `，花费 ${cost} 币` : "（费用以平台账单为准）"
    emitAgentNotice(state, `【进度汇报】${label} 已完成${costText}。结果已同步到画布，可随时查看。`)
    return
  }
  // 失敗：中文短句優先（S5a human_message），否則錯誤原文；資金話術只引用
  // billing 真值（修 2）——實測實錄節點失敗後 confirm approved 25.001/75.001 幣
  // 零 refund，舊文案「本次失败未产生成功扣款」無帳本依據（欺君）。有批准額
  // 且已退款留痕 → 如實講退款；無批准額 → 如實講未走批量扣費。
  const reason = payload.patch?.human_message || payload.patch?.errorDetails || "未知原因"
  const wfBilling = payload.unit_id ? workflowBilling.get(payload.unit_id) : undefined
  const moneyText = wfBilling
    ? wfBilling.refunded_coins > 0
      ? `本次工作流已批准扣费 ${wfBilling.confirmed_coins} 币，失败部分已全额退回 ${wfBilling.refunded_coins} 币（账本已留痕，余额已刷新）。`
      : `本次工作流已批准扣费 ${wfBilling.confirmed_coins} 币，失败部分的退款以平台账单为准。`
    : "本节点所在工作流未走批量扣费确认，失败未产生新增扣费。"
  emitAgentNotice(
    state,
    `【进度汇报】${label} 失败：${reason}。${moneyText}可在画布上重试该节点。`,
  )
}

/** 規格2：30s ack timer 的清理（發出或失效後都調用）。 */
function clearAckTimer(state: SessionState): void {
  if (state.ackTimer) {
    clearTimeout(state.ackTimer)
    state.ackTimer = null
  }
}

/** 規格2：用戶消息送達 opencode 後啟動 30s ack 計時。
 *  罪狀2 表現修復（2026-08-29）：ack 觸發時不再發 message.delta 假助手文本
 *  （此前「收到，正在处理…」以正文身份污染轉錄），改走 emitAgentNotice 通知
 *  通道（前端 AgentNoticeRow 渲染路徑，S8 進度匯報同款，該通道自帶 turn.done
 *  收打字指示器；真實 turn 收尾時 idle 路徑照常發 turn.done，前端冪等）。
 *  活動判定改用 turnHasActivity——思考期（reasoning.delta）不再被誤判死寂。
 *  persona=thoughtful 時延遲 ×1.5（等待容忍窗，S7）。 */
function armAckTimer(state: SessionState): void {
  clearAckTimer(state)
  state.ackSent = false
  const gen = state.turnGen ?? 0
  state.ackTimer = setTimeout(() => {
    state.ackTimer = null
    const cur = sessions.get(state.sessionId)
    // 只在「同一輪、turn 毫無動靜（無正文無思維鏈無工具）、還沒發過 ack」時補 ack。
    if (!cur || (cur.turnGen ?? 0) !== gen || turnHasActivity(cur) || cur.ackSent) {
      console.log(`[gateway] S6 ack skipped: session=${state.sessionId} gen=${gen} cur=${Boolean(cur)} turnText=${cur?.turnTextChars ?? "?"} turnReasoning=${cur?.turnReasoningChars ?? "?"} ackSent=${cur?.ackSent ?? "?"}`)
      return
    }
    cur.ackSent = true
    console.log(`[gateway] S6 ack sent (notice): session=${cur.sessionId} gen=${gen}`)
    emitToSession(cur, "turn.status", { text: "收到，模型思考中…" })
    // 通知通道自帶 turn.done；此處不再額外發任何幀。
  }, ACK_DELAY_MS * personaPatienceMul(state))
}

// ── N1 規格1（2026-08-27）：30s 心跳提示——死寂窗口的中段補口 ──
// 語義與 S6 ack 不同：ack 是「收到你的消息」（30s），心跳是「模型還在憋、
// 沒吐字也沒開工具」（ack 之後再等一輪）。錯峰規則：ack 尚未發 → 心跳在
// HEARTBEAT_DELAY_MS(30s) 起跳；ack 已發 → 順延到 HEARTBEAT_DELAY_AFTER_ACK_MS
// (45s)，避免同一時刻雙發。每 turn 最多 1 條；模型開口（吐字/開工具）即失效。
function clearHeartbeatTimer(state: SessionState): void {
  if (state.heartbeatTimer) {
    clearTimeout(state.heartbeatTimer)
    state.heartbeatTimer = null
  }
}

function armHeartbeatTimer(state: SessionState): void {
  clearHeartbeatTimer(state)
  state.heartbeatSent = false
  const gen = state.turnGen ?? 0
  state.heartbeatTimer = setTimeout(() => {
    state.heartbeatTimer = null
    const cur = sessions.get(state.sessionId)
    // 只在「同一輪、turn 完全沒動靜（無字無工具）、本輪還沒發過心跳」時補一條。
    if (!cur || (cur.turnGen ?? 0) !== gen || turnHasActivity(cur) || cur.heartbeatSent) {
      return
    }
    // 錯峰：S6 ack 在同一時刻剛發過（30s 邊界撞車）→ 心跳順延一輪再判。
    if (cur.ackTimer || (cur.ackSent === true && Date.now() - (cur.lastUserAt ?? 0) < HEARTBEAT_DELAY_AFTER_ACK_MS)) {
      const deferMs = Math.max(1000, HEARTBEAT_DELAY_AFTER_ACK_MS - HEARTBEAT_DELAY_MS)
      cur.heartbeatTimer = setTimeout(() => {
        cur.heartbeatTimer = null
        const c2 = sessions.get(cur.sessionId)
        if (!c2 || (c2.turnGen ?? 0) !== gen || turnHasActivity(c2) || c2.heartbeatSent) return
        c2.heartbeatSent = true
        console.log(`[gateway] N1 heartbeat sent (post-ack): session=${c2.sessionId} gen=${gen}`)
        emitToSession(c2, "turn.status", { text: "仍在等待模型响应，请稍候…" })
      }, deferMs)
      return
    }
    cur.heartbeatSent = true
    console.log(`[gateway] N1 heartbeat sent: session=${cur.sessionId} gen=${gen}`)
    emitToSession(cur, "turn.status", { text: "仍在等待模型响应，请稍候…" })
    // 不發 turn.done：turn 仍在途，前端維持輸入中。
    // S7：persona=thoughtful 時本延遲 ×1.5（投遞時按 settings 計算，不改全局常量）。
  }, HEARTBEAT_DELAY_MS * personaPatienceMul(state))
}

// ── R2-A（2026-08-27）：turn 啟動看門狗 ─────────────────────────────
// 評測實錘：批准重跑後 prompt_async 202，但 295s 零 tool.invoke 零
// message.delta——turn 在壓縮後的長會話上靜默死亡，連 session.idle 都
// 不發，抖動重試（掛在 idle 上）永遠等不到。看門狗直接以「turn 動靜」為
// 準：90s 無動靜 → 誠實告警 + 防重複檢查後自動重投一次；再 90s 無動靜
// → 判會話損壞，建議新開。工具開跑或模型吐字即視為活著（turnToolStarted
// / turnTextChars 任一非零）。
function clearWatchdogTimer(state: SessionState): void {
  if (state.watchdogTimer) {
    clearTimeout(state.watchdogTimer)
    state.watchdogTimer = null
  }
}

// ── R5-C（2026-08-28）：中段停滯哨 ─────────────────────────────────
// 覆蓋啟動看門狗管不到的格：turn 已啟動（有過 tool/正文/任何幀）後中段凍結。
// 判定 = turnLastFrameAt（emitToSession 全量刷新）起算 90s 零新幀。第一咬：
// 誠實告警 + 單次重投 lastPromptBody（防風暴，midturnStallRetried 鎖）；第二咬
// （重投後仍零幀）：如實收尾 + turn.done。turnHasActivity=false 時靜默退出
//（那格歸啟動看門狗），idle 撤哨。
function clearMidturnStallTimer(state: SessionState): void {
  if (state.midturnStallTimer) {
    clearTimeout(state.midturnStallTimer)
    state.midturnStallTimer = null
  }
}

function armMidturnStallTimer(state: SessionState): void {
  clearMidturnStallTimer(state)
  const gen = state.turnGen ?? 0
  state.midturnStallTimer = setTimeout(() => {
    state.midturnStallTimer = null
    const cur = sessions.get(state.sessionId)
    if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted) return
    if (!turnHasActivity(cur)) return // turn 未啟動：啟動看門狗管，不重疊
    // R8-B 工單 #3：question pending 期間靜默屬預期（等用戶答覆），
    // 心跳接管用戶可見性；此處重投只會打斷掛起的 question 工具。
    if (cur.pendingQuestions.size > 0 || cur.pendingConfirms.size > 0) return
    const last = cur.turnLastFrameAt ?? 0
    if (!(last > 0 && Date.now() - last >= MIDTURN_STALL_MS)) {
      armMidturnStallTimer(cur) // 還有幀進來：滾動續盯，直到 idle 撤哨
      return
    }
    if (!cur.midturnStallRetried) {
      // ── 第一咬：告警 + 單次重投（復用 watchdog 模式）──
      cur.midturnStallRetried = true
      cur.recoveryRound = true
      console.warn(`[gateway] R5-C midturn-stall: zero frames for ${Math.round((Date.now() - last) / 1000)}s (gen=${gen}), alerting + single re-dispatch — session=${cur.sessionId}`)
      emitToSession(cur, "turn.status", { text: "处理似乎卡住了，我重新尝试一下，请稍候" })
      const body = cur.lastPromptBody
      if (!body) {
        armMidturnStallTimer(cur)
        return
      }
      fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`)
          console.log(`[gateway] R5-C midturn-stall: re-dispatch sent — session=${cur.sessionId} gen=${gen}`)
          stripStaleTurnTextFromReplay(cur)
          cur.turnLastFrameAt = Date.now()
          armMidturnStallTimer(cur) // 續盯第二輪判定
        })
        .catch((e: unknown) => {
          console.error(`[gateway] R5-C midturn-stall re-dispatch failed: session=${cur.sessionId}:`, e)
          armMidturnStallTimer(cur)
        })
      return
    }
    // ── 第二咬：重投後仍零幀——如實收尾 ──
    console.warn(`[gateway] R5-C midturn-stall: still frozen after re-dispatch (gen=${gen}), closing turn honestly — session=${cur.sessionId}`)
    emitToSession(cur, "message.delta", {
      text: "重新尝试后仍没有进展，我先停止等待。刚才完成的部分不会丢，稍后重新发送消息即可继续。\n",
    })
    emitToSession(cur, "turn.done", {})
    cur.lastTurnActiveAt = 0
    markDirty(cur)
  }, MIDTURN_STALL_MS)
}

// ── R8-B 工單 #3（2026-08-29）：question pending 心跳 ──
// pending 期間每 30s 一幀用戶可見心跳（message 通道直發，不帶 turn.done——
// turn 還掛著等答覆）。答覆/拒絕/會話拆除時撤哨。
function clearQuestionHeartbeat(state: SessionState): void {
  if (state.questionHeartbeatTimer) {
    clearTimeout(state.questionHeartbeatTimer)
    state.questionHeartbeatTimer = null
  }
  // 片AJ：assume 代答哨與心跳同生共死——既有全部答覆/跳過/拆除路徑已調本函數。
  clearQuestionAssumeTimer(state)
}

// ── 片AJ（2026-09-07）：question 卡 3 分鐘超時按推薦方案代答 ──
// 背景（片AB 評測 T4 實錘）：無人值守跑批時 question 卡在確認門前無限掛死。
// 語義：3 分鐘未回覆 → 各題取第一選項（agent 約定推薦選項放第一位）組成代答
// 文案並標注 assumed，轉發核心復用 settleQuestion（雙 URL 兜底 + ok 後記賬 +
// question.replied 前端變已決）。best-effort：上游失敗照 settleQuestion 既有
// 形態收尾，不重試不拋出（reconcile/新消息路徑接管）。confirm（花錢決策）不在此列。
function clearQuestionAssumeTimer(state: SessionState): void {
  if (state.questionAssumeTimer) {
    clearTimeout(state.questionAssumeTimer)
    state.questionAssumeTimer = null
  }
}

function armQuestionAssumeTimer(state: SessionState): void {
  clearQuestionAssumeTimer(state)
  state.questionAssumeTimer = setTimeout(() => {
    state.questionAssumeTimer = null
    const cur = sessions.get(state.sessionId)
    if (!cur || cur.pendingQuestions.size === 0) return
    void autoAssumeQuestions(cur)
  }, QUESTION_ASSUME_MS)
}

async function autoAssumeQuestions(state: SessionState): Promise<void> {
  if (state.pendingQuestions.size === 0) return
  const labels: string[] = []
  for (const pending of state.pendingQuestions.values()) {
    for (const q of pending.questions) {
      const label = q.options?.[0]?.label
      if (label) labels.push(label)
    }
  }
  const answerText = `（用户 3 分钟未回复，系统按推荐方案继续：${labels.length ? labels.join("；") : "采用默认方案"}。后续结果请标注 assumed）`
  const count = state.pendingQuestions.size
  for (const requestId of [...state.pendingQuestions.keys()]) {
    try {
      await settleQuestion(state, requestId, answerText)
    } catch (err) {
      console.error(`[gateway] auto-assume question failed: ${requestId} — session=${state.sessionId}:`, err)
      state.pendingQuestions.delete(requestId)
    }
  }
  state.pendingQuestions.clear()
  clearQuestionHeartbeat(state)
  console.log(`[session] auto-assumed ${count} pending question(s) after ${QUESTION_ASSUME_MS}ms — session=${state.sessionId}`)
}

function armQuestionHeartbeat(state: SessionState): void {
  clearQuestionHeartbeat(state)
  const tick = (): void => {
    state.questionHeartbeatTimer = null
    const cur = sessions.get(state.sessionId)
    if (!cur || cur.pendingQuestions.size === 0 || cur.turnAborted) return
    // R9-1：心跳走服務端事件（heartbeat），不再複製成 message.delta 消息泡——
    // 前端 reducer 對未知事件只推 lastEventId、不產生新條目，復讀機根治。
    // question 卡本身已是「等待選擇」的視覺錨點，心跳只是維持「後端還活著」。
    emitToSession(cur, "heartbeat", { type: "question_pending", pendingAt: Date.now() })
    // R8-B 驗收實錄：opencode 側 question 會靜默過期（上游 /question 清單變空、
    // reply 端點回 QuestionNotFoundError），gateway 若不知情 = 心跳永久循環 +
    // turn 永久凍結。每拍對賬一次，過期即摘除並解除凍結，交還既有哨兵接管。
    void reconcilePendingQuestions(cur)
    cur.questionHeartbeatTimer = setTimeout(tick, QUESTION_HEARTBEAT_MS)
  }
  state.questionHeartbeatTimer = setTimeout(tick, QUESTION_HEARTBEAT_MS)
}

/** question pending 對賬：上游已不存在的 request 摘除；全部摘完時解除凍結。 */
async function reconcilePendingQuestions(state: SessionState): Promise<void> {
  if (state.pendingQuestions.size === 0) return
  let liveIds: Set<string> | null = null
  try {
    const res = await fetch(`${OPENCODE_URL}/question`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const arr = (await res.json()) as Array<Record<string, unknown>>
      liveIds = new Set(arr.filter((r) => typeof r?.id === "string").map((r) => r.id as string))
    }
  } catch {
    return // 查不到就不動：下一拍再對賬
  }
  if (!liveIds) return
  for (const requestId of [...state.pendingQuestions.keys()]) {
    if (!liveIds.has(requestId)) {
      state.pendingQuestions.delete(requestId)
      emitToSession(state, "question.expired", { request_id: requestId, reason: "upstream_expired" })
      console.log(`[gateway] R8-B question expired upstream: ${requestId} — session=${state.sessionId}`)
    }
  }
  if (state.pendingQuestions.size === 0) {
    clearQuestionHeartbeat(state)
    state.turnFrozenByQuestion = false
    state.turnLastFrameAt = Date.now()
    state.lastUserVisibleAt = Date.now()
    emitToSession(state, "message.delta", { text: "（选择卡片已过期。如仍要继续，请回复或重新发送消息。）\n" })
    // 凍結期間哨兵全撤過：恢復段重新布防，讓啟動看門狗/停滯哨接管收尾或重投。
    armWatchdogTimer(state)
  }
}

// ── R8-B 工單 #5（2026-08-29）：中段靜默通知 ──
// turn 進行中 >45s 無模型正文（message.delta）→ 補一幀用戶可見進度，此後每
// 45s 續發。與 R5-C 停滯哨並存：停滯哨以「零任何幀」判定（reasoning/tool 幀
// 都算活著），本通知以「零正文」判定（長推理段用戶側黑屏 ≤45s）。與 R7 啟動
// 看門狗（turn 未啟動）三層各管一段，判定域互斥不衝突。
function clearQuietNoticeTimer(state: SessionState): void {
  if (state.quietNoticeTimer) {
    clearTimeout(state.quietNoticeTimer)
    state.quietNoticeTimer = null
  }
}

function armQuietNoticeTimer(state: SessionState): void {
  clearQuietNoticeTimer(state)
  state.lastUserVisibleAt = Date.now()
  const gen = state.turnGen ?? 0
  const tick = (): void => {
    state.quietNoticeTimer = null
    const cur = sessions.get(state.sessionId)
    if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted) return
    // question pending 期間心跳接管（避免兩路同時補幀刷屏）。
    if (cur.pendingQuestions.size === 0 && cur.pendingConfirms.size === 0) {
      const silentMs = Date.now() - (cur.lastUserVisibleAt ?? 0)
      if (silentMs >= QUIET_NOTICE_MS) {
        // R1（2026-09-11）刀3：空轉文案動作導向——舊文案資訊量零（評測 P0 唯一送達
        // 用戶的字 ×19）且自曝無正文，改為告知仍在跑；>90s 給可執行的中斷指引。
        const sec = Math.round(silentMs / 1000)
        emitToSession(cur, "turn.status", {
          text:
            sec >= 90
              ? `處理中（已 ${sec}s）：可繼續等待；若想中斷，按停止後改派更小範圍。`
              : `處理中（已 ${sec}s）：工具與子代理仍在執行。`,
        })
      }
    }
    cur.quietNoticeTimer = setTimeout(tick, QUIET_NOTICE_MS)
  }
  state.quietNoticeTimer = setTimeout(tick, QUIET_NOTICE_MS)
}

/** turn 是否有任何「已啟動」的證據：模型吐過字（正文或思維鏈），或工具開跑過。
 *  罪狀2 根因修復（2026-08-29）：思維鏈（reasoning.delta）也是模型活著的證據——
 *  此前只看正文與工具，思考型模型整段推理期間被 ack/心跳/看門狗/停滯哨誤判死寂。
 *  ack/心跳/看門狗/中段停滯哨全部經此函數繼承該語義。 */
function turnHasActivity(st: SessionState): boolean {
  return (st.turnTextChars ?? 0) > 0 || (st.turnReasoningChars ?? 0) > 0 || st.turnToolStarted === true
}

/** 用戶消息/resume 送達後布哨；每次觸發後自續（第二輪觸發=終局判定）。 */
function armWatchdogTimer(state: SessionState): void {
  clearWatchdogTimer(state)
  // R8-B 工單 #5：中段靜默通知同點布防（重投輪重布），撤哨走 idle。
  armQuietNoticeTimer(state)
  // R5-C：中段停滯哨與啟動看門狗同點布防/重布（含重投輪），撤哨走 idle。
  armMidturnStallTimer(state)
  const gen = state.turnGen ?? 0
  state.watchdogTimer = setTimeout(() => {
    state.watchdogTimer = null
    const cur = sessions.get(state.sessionId)
    // 會話已拆 / 已進入下一輪 / turn 已有動靜 → 哨兵靜默退出。
    if (!cur || (cur.turnGen ?? 0) !== gen || turnHasActivity(cur) || cur.turnAborted) {
      return
    }
    // 等用戶決策（confirm/question 掛起）是合法暫停，不是 LLM 無響應——
    // 掛起期間零幀流動，此前被誤判死寂：重投 prompt 造出重複回合 + 誣陷後端。
    // 靜默續哨：決策落地後活動恢復自然撤哨；卡片過期後若 turn 真死，下一輪照咬。
    if (cur.pendingConfirms.size > 0 || cur.pendingQuestions.size > 0) {
      armWatchdogTimer(cur)
      return
    }
    if (!cur.watchdogRetried) {
      // ── 第一次咬：誠實告警 + 自動重投一次 ──
      cur.watchdogRetried = true
      cur.recoveryRound = true // R5-C：恢復輪標記，收尾兜底結語用
      console.warn(`[gateway] watchdog: turn not started (gen=${gen}), notifying user and retrying once — session=${cur.sessionId}`)
      emitToSession(cur, "turn.status", { text: "处理似乎卡住了，我重新尝试一下，请稍候" })
      // 防重複：重投前實時核對 turn 仍零動靜（告警幀發送期間模型可能恰好開口）。
      if (turnHasActivity(cur)) return
      const body = cur.lastPromptBody
      if (!body) return
      fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`)
          console.log(`[gateway] watchdog: retry dispatched for session=${cur.sessionId} gen=${gen}`)
          // N2：重投輪開始——剝掉舊 turn 的文本幀（含 watchdog 自己的告警幀），
          // 避免重連/後續 idle 補發路徑把它們整段重放。
          stripStaleTurnTextFromReplay(cur)
          // 重投已出發：重新布哨等第二輪判定（cur 仍零動靜才會咬）。
          if ((cur.turnGen ?? 0) === gen && !turnHasActivity(cur)) armWatchdogTimer(cur)
        })
        .catch((e: unknown) => {
          console.error(`[gateway] watchdog: retry dispatch failed for session=${cur.sessionId}:`, e)
          // 重投發不出去：這輪已無恢復手段，進入終局話術（Q3：如實三句式，
          // 不再誣陷「會話損壞」、不再建議必然失敗的「新開一個」）。
          if ((cur.turnGen ?? 0) === gen && !turnHasActivity(cur)) {
            // 修 1：死亡宣告置位——此後若仍有內容幀到達（上游慢復活），
            // emitToSession 會先發撤回幀。
            cur.deathDeclared = true
            emitToSession(cur, "message.delta", {
              text: "自动重试后 LLM 后端仍无响应（服务端问题，不是你的操作）。已停止等待。请稍后重试发送同一条消息，若持续失败请联系管理员。\n",
            })
            // N1 規格2：終局之後補一條明確指引（一次性；此路徑每 turn 只進一次）。
            emitToSession(cur, "message.delta", {
              text: "你刚才的消息可能未处理完成，稍后重新发送即可继续。\n",
            })
            emitToSession(cur, "turn.done", {})
          }
        })
      return
    }
    // ── 第二次咬：重投也沒喚醒——LLM 後端無響應，如實告知（Q3 去誤導） ──
    console.warn(`[gateway] watchdog: turn still dead after retry (gen=${gen}), backend unresponsive — session=${cur.sessionId}`)
    // 修 1：死亡宣告置位——重投的 retry 若之後開始產出（殭屍还魂實錄：
    // 宣告死亡 10 秒後 retry 輸出照灌），第一條內容幀觸發撤回幀，用戶明確
    // 知道剛才是誤判、任務已恢復；「宣告死亡 + 靜默还魂」不再並存。
    cur.deathDeclared = true
    emitToSession(cur, "message.delta", {
      text: "自动重试后 LLM 后端仍无响应（服务端问题，不是你的操作）。已停止等待。请稍后重试发送同一条消息，若持续失败请联系管理员。\n",
    })
    // N1 規格2：終局之後補一條明確指引（一次性；第二咬每 turn ��進一次）。
    emitToSession(cur, "message.delta", {
      text: "你刚才的消息可能未处理完成，稍后重新发送即可继续。\n",
    })
    emitToSession(cur, "turn.done", {}) // 收尾：別讓前端永遠掛著「輸入中」
  }, TURN_WATCHDOG_MS)
}

// ── R4-A S3①（2026-08-28）：上游錯誤後停滯看門狗 ───────────────────
// R4 實錘兩個根因：1) 啟動看門狗只守「turn 從未啟動」（turnHasActivity 即
// 靜默退出），APIError 前模型已吐過字 → 哨兵瞎了；2) 抖動重試耗盡後 idle
// 直接靜默 turn.done，零話術。此哨補第一格：emitSessionError（非 tool_error）
// 布哨 → 90s 內 turn 未收尾 → 誠實告警（每 turn 一條）並續盯（重投由抖動
// 重試機制接手）；告警後再 90s 仍零進度 → 明確收尾話術 + turn.done。
// TURN_ERROR_WATCHDOG_MS 環境變量可覆蓋。
function clearErrorStallTimer(state: SessionState): void {
  if (state.errorStallTimer) {
    clearTimeout(state.errorStallTimer)
    state.errorStallTimer = null
  }
}

function armErrorStallTimer(state: SessionState): void {
  clearErrorStallTimer(state)
  const gen = state.turnGen ?? 0
  state.errorStallTimer = setTimeout(() => {
    state.errorStallTimer = null
    const cur = sessions.get(state.sessionId)
    // 會話已拆 / 已進入下一輪 / 已中止 → 靜默退出（idle 收尾路徑會撤哨）。
    if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted) return
    if (!cur.errorStallAlerted) {
      // ── 第一咬：誠實告警（每 turn 一條），續盯。
      cur.errorStallAlerted = true
      console.warn(`[gateway] error-stall watchdog: upstream error, turn unfinished after ${TURN_ERROR_WATCHDOG_MS}ms (gen=${gen}) — session=${cur.sessionId}`)
      emitToSession(cur, "turn.status", { text: "上游刚才报错了，我还在盯着处理；若持续没有进展，我会告诉你并停止等待" })
      if ((cur.turnGen ?? 0) === gen && !cur.turnAborted) armErrorStallTimer(cur)
      return
    }
    // ── 第二咬：告警後有進度 = turn 活著 → 靜默續盯，不再出幀打擾。
    const progressAt = cur.turnProgressAt ?? 0
    if (progressAt > 0 && Date.now() - progressAt < TURN_ERROR_WATCHDOG_MS) {
      armErrorStallTimer(cur)
      return
    }
    console.warn(`[gateway] error-stall watchdog: still stalled after alert (gen=${gen}), closing turn honestly — session=${cur.sessionId}`)
    emitToSession(cur, "message.delta", {
      text: "上游连续报错且自动重试未能恢复，我停止等待了。请稍后重新发送上一条消息即可继续；若内容较长，建议让我分章/分段处理。\n",
    })
    emitToSession(cur, "turn.done", {}) // 收尾：別讓前端永遠掛著「輸入中」
  }, TURN_ERROR_WATCHDOG_MS)
}

/** R4-A S8（2026-08-28）：turn 收尾兜底匯報——本輪有節點落終態但零主動匯報
 *  時補一幀中文總結（R4 實錘：第一輪 5 成功+1 失敗零匯報悄悄收工）。環名
 *  來源 = workflow graph 節點的模板預置 title（如「角色卡」），取不到才用
 *  節點 id 尾段。花費只匯總工作流裡真實存在的數字，沒有就不編。 */
function emitTurnEndSummaryIfSilent(state: SessionState): void {
  const nodes = state.turnTerminalNodes ?? []
  if (nodes.length === 0 || state.turnNoticeSent || state.turnAborted) return
  state.turnNoticeSent = true
  const wfid = workflowOwnerBySession.get(state.sessionId)
  const wf = wfid ? workflowService.get(wfid) : undefined
  const titleById = new Map<string, string>()
  const costById = new Map<string, number>()
  if (wf) {
    const w = wf as unknown as {
      graph?: { nodes?: Array<{ id?: unknown; title?: unknown }> }
      nodeCost?: Record<string, unknown>
    }
    for (const n of w.graph?.nodes ?? []) {
      if (typeof n?.id === "string" && typeof n?.title === "string") titleById.set(n.id, n.title)
    }
    for (const [k, v] of Object.entries(w.nodeCost ?? {})) {
      if (typeof v === "number") costById.set(k, v)
    }
  }
  const labelOf = (id: string): string => titleById.get(id) || (id.includes("-") ? id.slice(id.lastIndexOf("-") + 1) : id)
  const okList = nodes.filter((n) => n.status === "success").map((n) => labelOf(n.id))
  const badList = nodes.filter((n) => n.status === "error").map((n) => labelOf(n.id))
  if (okList.length === 0 && badList.length === 0) return
  let spent = 0
  let anyCost = false
  for (const n of nodes) {
    if (n.status !== "success") continue
    const c = costById.get(n.id)
    if (typeof c === "number") {
      spent += c
      anyCost = true
    }
  }
  const lines: string[] = ["【本轮小结】"]
  lines.push(okList.length > 0 ? `已完成 ${okList.length} 个环节：${okList.join("、")}。` : "本轮没有完成的环节。")
  if (badList.length > 0) lines.push(`失败 ${badList.length} 个环节：${badList.join("、")}。失败节点可在画布上重试。`)
  if (anyCost) lines.push(`本轮已完成环节共花费 ${Math.round(spent * 100) / 100} 币。`)
  lines.push(badList.length > 0 ? "下一步：可重试失败节点，或告诉我接下来怎么调整。" : "下一步：可继续推进后续环节，或让我检查已完成环节的产出。")
  emitToSession(state, "message.delta", { text: lines.join("\n") + "\n" })
  console.log(`[gateway] S8 turn-end fallback summary: ${okList.length} ok / ${badList.length} failed — session=${state.sessionId}`)
}

/** R5-C（2026-08-28）：恢復輪強制結語——watchdog 重投/redrive/中段哨重投的
 *  恢復輪（recoveryRound=true）收尾時，若 S8 節點小結不觸發（零終態節點）且
 *  零主動匯報、且本輪有正文輸出（零文本路徑已有自己的誠實收尾），兜底補一條
 *  用戶可見結語，杜絕恢復輪悄悄收工。N 取當前工作流可執行節點數，取不到不編。 */
function emitRecoveryClosingIfSilent(state: SessionState): void {
  if (!state.recoveryRound || state.turnAborted || state.turnNoticeSent) return
  // R8-B 工單 #4（2026-08-29）：本輪答覆過 question → 用戶語義已在模型上下文，
  // 模型自己會執行/收尾。補「要繼續跑嗎」= 剛關的門自己又拉開（R8 拒單實錘：
  // 用戶答「先不生成，就到這」後被 5125.1 幀自我推翻），讓位。
  if (state.questionAnsweredThisTurn) return
  if ((state.turnTerminalNodes ?? []).length > 0) return // S8 小結已覆蓋
  if ((state.turnTextChars ?? 0) === 0) return // 零文本路徑已有專屬收尾話術
  let n = 0
  const wfid = workflowOwnerBySession.get(state.sessionId)
  const wf = wfid ? workflowService.get(wfid) : undefined
  if (wf) {
    const g = (wf as unknown as { graph?: { nodes?: Array<{ kind?: string }> } }).graph
    n = (g?.nodes ?? []).filter((x) => x.kind !== "text" && x.kind !== "config").length
  }
  const text =
    n > 0
      ? `恢复完成：已重建 ${n} 个节点配置。要继续跑吗？\n`
      : "恢复完成：刚才中断的处理已经接上。要继续跑吗？\n"
  emitToSession(state, "message.delta", { text })
  console.log(`[gateway] R5-C recovery closing emitted: nodes=${n} — session=${state.sessionId}`)
}

/** 規格3：質詢樣式識別——問句/追責類關鍵詞（結案提問「為什麼/退款/剩什麼」命中）。 */
function isInterrogativeMessage(text: string): boolean {
  return /为什么|为何|怎么回事|怎么回|咋|退钱|退款|失败|死了|还剩|剩什么|什么情况|啥情况|怎么办|赔|投诉|号|？|\?/.test(text)
}

/** 規格3：turn 結束（回覆完成）時放行被凍結的視頻工作流。 */
function releasePendingVideoWorkflows(state: SessionState): void {
  const pending = state.pendingVideoWorkflows
  if (!pending || pending.length === 0) {
    state.pendingVideoWorkflows = []
    return
  }
  state.pendingVideoWorkflows = []
  emitAgentNotice(state, `已收到你的追问并答复完毕。此前暂缓的视频任务（${pending.length} 个）现在继续执行，节点完成后我会逐条汇报。`)
  for (const wfid of pending) {
    void workflowService.generate(wfid).then((r) => {
      if (!r.ok) console.error(`[workflow] ${wfid} resumed-after-question finished: ${r.status}`)
    })
  }
}

// ---- internal handlers (loopback only) ----

interface LedgerEntry {
  ts: string
  user_id: string
  session_id: string
  opencode_session_id: string
  task_id?: string
  model?: string
  cost_coins?: number
  result_url?: string
  kind: string
  event: string
}

async function appendLedger(entry: LedgerEntry): Promise<void> {
  try {
    await appendFile(LEDGER_PATH, JSON.stringify(entry) + "\n", "utf-8")
  } catch (e) {
    console.error(`[gateway] ledger append failed: ${e}`)
  }
}

async function appendLedgerFor(state: SessionState, overrides: Partial<LedgerEntry>): Promise<void> {
  try {
    await appendLedger({
      ts: new Date().toISOString(),
      user_id: await hashKey(state.apiKey),
      session_id: state.sessionId,
      opencode_session_id: state.opencodeSessionId,
      ...overrides,
    })
  } catch (e) {
    console.error(`[gateway] ledger append failed: ${e}`)
  }
}

function isLoopback(ip: string | null): boolean {
  if (!ip) return false
  if (ip === "127.0.0.1" || ip === "::1") return true
  return ip.startsWith("127.") || ip.startsWith("::ffff:127.")
}

// 畫布摘要讀取：opencode 的 canvas_summary 工具用 session_id（opencode 或
// gateway 任一 id 皆可）查當前畫布狀態。GET only、loopback only。
// 摘要 = 前端最後一次發訊息時附帶的 canvas_state（節點/連線/預算），
// 純透傳不加工；前端在每輪訊息都會更新，所以這裡永遠是最新。
async function handleCanvasStateRead(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get("session_id")
  if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
  const state = resolveSession(sessionId)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  return Response.json({
    ok: true,
    canvas_state: state.canvasSummary ?? null,
    updated_at: state.canvasSummaryAt ?? null,
  })
}

// ─────────────────────────── Wave C：Agent 操作畫布（canvas.ops 下發/回執）
//
// 兩條通道，核心共用：
//  1) 快照上行：前端（經站點代理）POST /agent/v1/sessions/:id/canvas/state 存壓縮
//     快照；loopback 等價端點 POST /internal/canvas/state（body 帶 session_id）。
//     opencode 的 canvas_get_state 工具經 GET /internal/canvas/snapshot 讀取。
//     注意：既有 GET /internal/canvas/state（讀隨訊息上送的 canvasSummary）語義不動。
//  2) ops 下發：工具 POST /internal/canvas/dispatch-ops → 經該 session 的 SSE 發
//     canvas.ops 事件 { request_id, ops, label? }，掛起等前端回執；前端執行後
//     POST /agent/v1/sessions/:id/canvas/ops-result（loopback 等價 /internal/canvas/ops-result）
//     resolve 對應 pending。逾時（預設 30s）回 OPS_TIMEOUT。

const CANVAS_STATE_MAX_BYTES = 512 * 1024
const CANVAS_STATE_TTL_MS = 24 * 60 * 60 * 1000 // 2026-08-29：30min → 24h（保存線對齊「至少 24h」；重啟另有 DB 鏡像回灌）
const CANVAS_OPS_TIMEOUT_MS = Number.parseInt(process.env.CANVAS_OPS_TIMEOUT_MS || "30000", 10) || 30_000
const CANVAS_OPS_MAX = 100
const CANVAS_OP_TYPES = new Set([
  "add_node",
  "update_node",
  "delete_nodes",
  "connect_nodes",
  "delete_connections",
  "select_nodes",
  "set_viewport",
  "run_generation",
])

interface CanvasSnapshotEntry {
  state: unknown
  updatedAt: number
}

// 畫布快照存放。key 統一收斂到 gateway sessionId（session 可解析時），
// 讓 opencode session id / gateway session id 兩種呼叫方命中同一份。
// 前置聲明：markDirty（早於本行定義）引用 canvasStates，const 提升安全
// （markDirty 只在請求處理時執行，遠晚於模組頂層求值）。
const canvasStates = new Map<string, CanvasSnapshotEntry>()

function canvasKeyFor(sessionId: string): string {
  const state = resolveSession(sessionId)
  return state ? state.sessionId : sessionId
}

// 惰性 TTL 清理：每次讀寫順手掃（條目數 = 活躍畫布數，量級小）。
function sweepCanvasStates(): void {
  const now = Date.now()
  for (const [k, v] of canvasStates) {
    if (now - v.updatedAt > CANVAS_STATE_TTL_MS) canvasStates.delete(k)
  }
}

function storeCanvasState(
  sessionId: string,
  stateValue: unknown,
): { ok: true; bytes: number; updatedAt: number } | { ok: false; status: number; message: string } {
  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify(stateValue), "utf-8")
  } catch {
    return { ok: false, status: 400, message: "state is not serializable" }
  }
  if (bytes > CANVAS_STATE_MAX_BYTES) {
    return { ok: false, status: 413, message: `state exceeds ${CANVAS_STATE_MAX_BYTES} bytes` }
  }
  sweepCanvasStates()
  const updatedAt = Date.now()
  canvasStates.set(canvasKeyFor(sessionId), { state: stateValue, updatedAt })
  return { ok: true, bytes, updatedAt }
}

// 工具/內部讀取最新快照；無快照回 null。
function getCanvasState(sessionId: string): CanvasSnapshotEntry | null {
  sweepCanvasStates()
  return canvasStates.get(canvasKeyFor(sessionId)) ?? null
}

// ---- 畫布事件持久化（2026-08-27 修復）----
// 斷鏈根因：autoCreateCanvasUnit / emitCanvasResult 只對 SSE 發 canvas.node.* 事件，
// 從不寫 canvasStates，導致 GET /internal/canvas/snapshot 永遠 has_state:false，
// 前端刷新後畫布全丟。修復：事件發生的同一瞬間，把它套用到該 session 的快照
// state（節點 upsert / 連線 upsert），並隨 session 防抖落盤（canvasSnapshot
// 欄位），gateway 重啟後懶加載時回灌 canvasStates。
// 前端若已上行過自己的完整 state（storeCanvasState），之後的事件疊加其上——
// 同一 data 語義，不衝突。

interface PersistableCanvasState {
  nodes?: Record<string, unknown>
  connections?: Record<string, unknown>
  [k: string]: unknown
}

// 讀（無則建）該 session 的可變快照形狀；盡量沿用前端上行 state 的既有欄位
// （如 nodes/connections 陣列），缺什麼補什麼，不覆蓋前端已有資料。
function mutableCanvasStateOf(sessionId: string): PersistableCanvasState {
  const key = canvasKeyFor(sessionId)
  const snap = canvasStates.get(key)
  if (snap && snap.state && typeof snap.state === "object") {
    return snap.state as PersistableCanvasState
  }
  const fresh: PersistableCanvasState = { nodes: {}, connections: {} }
  canvasStates.set(key, { state: fresh, updatedAt: Date.now() })
  return fresh
}

function nodesArray(cs: PersistableCanvasState): Record<string, unknown>[] {
  if (!Array.isArray(cs.nodes)) cs.nodes = []
  return cs.nodes as Record<string, unknown>[]
}

function connectionsArray(cs: PersistableCanvasState): Record<string, unknown>[] {
  if (!Array.isArray(cs.connections)) cs.connections = []
  return cs.connections as Record<string, unknown>[]
}

function touchCanvasSnapshot(sessionId: string, cs: PersistableCanvasState): void {
  canvasStates.set(canvasKeyFor(sessionId), { state: cs, updatedAt: Date.now() })
}

// canvas.node.created → 節點 upsert（以 node.id 為鍵，重放安全）。
function applyCanvasNodeCreated(sessionId: string, payload: unknown): void {
  const node = (payload as { node?: unknown })?.node
  if (!node || typeof node !== "object") return
  const id = (node as { id?: unknown }).id
  if (typeof id !== "string" || !id) return
  const cs = mutableCanvasStateOf(sessionId)
  const arr = nodesArray(cs)
  const idx = arr.findIndex((n) => n && n.id === id)
  if (idx >= 0) arr[idx] = node as Record<string, unknown>
  else arr.push(node as Record<string, unknown>)
  touchCanvasSnapshot(sessionId, cs)
}

// canvas.node.connected → 連線 upsert（以 connection.id 為鍵，重放安全）。
function applyCanvasNodeConnected(sessionId: string, payload: unknown): void {
  const conn = (payload as { connection?: unknown })?.connection
  if (!conn || typeof conn !== "object") return
  const id = (conn as { id?: unknown }).id
  if (typeof id !== "string" || !id) return
  const cs = mutableCanvasStateOf(sessionId)
  const arr = connectionsArray(cs)
  const idx = arr.findIndex((c) => c && c.id === id)
  if (idx >= 0) arr[idx] = conn as Record<string, unknown>
  else arr.push(conn as Record<string, unknown>)
  touchCanvasSnapshot(sessionId, cs)
}

// canvas.node.updated → 對目標節點做 metadata 淺合併（patch 套用到 metadata）。
// 淺合併即可：現有 patch 欄位（status/content/cost_coins/progress）皆為純量或
// 獨立小物件，覆寫語義正確。
function applyCanvasNodeUpdated(sessionId: string, payload: unknown): void {
  const p = (payload ?? {}) as { node_id?: unknown; patch?: unknown }
  if (typeof p.node_id !== "string" || !p.node_id) return
  if (!p.patch || typeof p.patch !== "object") return
  const key = canvasKeyFor(sessionId)
  const snap = canvasStates.get(key)
  if (!snap || !snap.state || typeof snap.state !== "object") return
  const cs = snap.state as PersistableCanvasState
  const arr = Array.isArray(cs.nodes) ? (cs.nodes as Record<string, unknown>[]) : []
  const node = arr.find((n) => n && n.id === p.node_id)
  if (!node) return
  const md = node.metadata && typeof node.metadata === "object" ? (node.metadata as Record<string, unknown>) : (node.metadata = {})
  Object.assign(md, p.patch)
  touchCanvasSnapshot(sessionId, cs)
}

// canvas.node.deleted → 從快照移除節點（若有）。
function applyCanvasNodeDeleted(sessionId: string, payload: unknown): void {
  const p = (payload ?? {}) as { node_id?: unknown; node_ids?: unknown }
  const ids = new Set<string>()
  if (typeof p.node_id === "string") ids.add(p.node_id)
  if (Array.isArray(p.node_ids)) for (const x of p.node_ids) if (typeof x === "string") ids.add(x)
  if (ids.size === 0) return
  const key = canvasKeyFor(sessionId)
  const snap = canvasStates.get(key)
  if (!snap || !snap.state || typeof snap.state !== "object") return
  const cs = snap.state as PersistableCanvasState
  if (Array.isArray(cs.nodes)) {
    cs.nodes = (cs.nodes as Record<string, unknown>[]).filter((n) => !(n && typeof n.id === "string" && ids.has(n.id)))
  }
  if (Array.isArray(cs.connections)) {
    cs.connections = (cs.connections as Record<string, unknown>[]).filter(
      (c) => !(c && ((typeof c.fromNodeId === "string" && ids.has(c.fromNodeId)) || (typeof c.toNodeId === "string" && ids.has(c.toNodeId)))),
    )
  }
  touchCanvasSnapshot(sessionId, cs)
}

interface CanvasOpsResult {
  ok: boolean
  error?: string
  created_node_ids?: string[]
}

interface PendingCanvasOps {
  sessionKey: string
  settle: (result: CanvasOpsResult) => void
}

const pendingCanvasOps = new Map<string, PendingCanvasOps>()

function validateCanvasOps(ops: unknown): { ok: true; ops: unknown[] } | { ok: false; message: string } {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, message: "ops must be a non-empty array" }
  if (ops.length > CANVAS_OPS_MAX) return { ok: false, message: `too many ops (max ${CANVAS_OPS_MAX})` }
  for (const op of ops) {
    const type = op && typeof op === "object" ? (op as { type?: unknown }).type : undefined
    if (typeof type !== "string" || !CANVAS_OP_TYPES.has(type)) {
      return { ok: false, message: `invalid op type: ${String(type)}` }
    }
  }
  return { ok: true, ops }
}

// 下發一批畫布操作：經 SSE 對該 session 發 canvas.ops，掛起等前端回執。
// 前端暫時斷線也照發（事件進 replay buffer，重連即補），靠逾時兜底。
function dispatchCanvasOps(
  state: SessionState,
  ops: unknown[],
  label?: string,
  timeoutMs: number = CANVAS_OPS_TIMEOUT_MS,
): Promise<{ request_id: string; result: CanvasOpsResult }> {
  const request_id = `cop_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCanvasOps.delete(request_id)
      reject(Object.assign(new Error("canvas ops timeout"), { code: "OPS_TIMEOUT", request_id }))
    }, timeoutMs)
    pendingCanvasOps.set(request_id, {
      sessionKey: state.sessionId,
      settle: (result) => {
        clearTimeout(timer)
        pendingCanvasOps.delete(request_id)
        resolve({ request_id, result })
      },
    })
    emitToSession(state, "canvas.ops", { request_id, ops, ...(label ? { label } : {}) })
  })
}

function resolveCanvasOps(sessionId: string, requestId: string, result: CanvasOpsResult): boolean {
  const pending = pendingCanvasOps.get(requestId)
  if (!pending) return false
  if (pending.sessionKey !== canvasKeyFor(sessionId)) return false
  pending.settle(result)
  return true
}

function sanitizeOpsResult(body: Record<string, unknown>): CanvasOpsResult {
  const created = Array.isArray(body.created_node_ids)
    ? (body.created_node_ids.filter((v) => typeof v === "string") as string[]).slice(0, 100)
    : undefined
  return {
    ok: body.ok === true,
    ...(typeof body.error === "string" && body.error ? { error: body.error.slice(0, 400) } : {}),
    ...(created && created.length > 0 ? { created_node_ids: created } : {}),
  }
}

// POST /internal/canvas/state — loopback 快照寫入（body 帶 session_id）。
async function handleCanvasStateWrite(req: Request): Promise<Response> {
  let body: { session_id?: unknown; state?: unknown }
  try {
    body = (await req.json()) as { session_id?: unknown; state?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (typeof body.session_id !== "string" || !body.session_id) {
    return jsonError(400, "session_id is required", "bad_request", "bad_request")
  }
  if (body.state === null || body.state === undefined || typeof body.state !== "object") {
    return jsonError(400, "state (object) is required", "bad_request", "bad_request")
  }
  const stored = storeCanvasState(body.session_id, body.state)
  if (!stored.ok) {
    const code = stored.status === 413 ? "payload_too_large" : "bad_request"
    return jsonError(stored.status, stored.message, code, code)
  }
  return Response.json({ ok: true, bytes: stored.bytes, updated_at: stored.updatedAt })
}

// GET /internal/canvas/snapshot — 工具讀最新快照（與既有 GET /internal/canvas/state 分開）。
async function handleCanvasSnapshotRead(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get("session_id")
  if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
  const snap = getCanvasState(sessionId)
  return Response.json({
    ok: true,
    has_state: snap !== null,
    state: snap?.state ?? null,
    updated_at: snap?.updatedAt ?? null,
  })
}

// POST /internal/media/upload — agent 素材入庫：服務端下載外部影片/音頻 URL →
// 平台存儲（image-data uploads 目錄，公網面 store.tinchak0207.xyz/image-data/files/）。
// 外部 URL 直連常被 Cloudflare 403 挑戰攔截、/v1/uploads 拒收 video——
// 影片/音頻素材一律先經此端點入庫取得平台 URL，再注入工作流節點。
// 鑑權同其他 session 類 internal 路由：分發層 loopback 門 + session_id 解析。
async function handleMediaUpload(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get("session_id")
  if (!sessionId) return Response.json({ ok: false, error: "session_id is required" }, { status: 400 })
  const session = resolveSession(sessionId)
  if (!session) return Response.json({ ok: false, error: "session not found" }, { status: 404 })
  let body: { url?: unknown; path_b64?: unknown; filename?: unknown }
  try {
    body = (await req.json()) as { url?: unknown; path_b64?: unknown; filename?: unknown }
  } catch {
    return Response.json({ ok: false, error: "invalid json body" }, { status: 400 })
  }
  const MAX_BYTES = 200 * 1024 * 1024
  let buf: Buffer
  let total = 0
  let contentType = ""
  let outExt: string
  // 本地成片以 base64 位元組上傳：video_upload 工具跑在 opencode-server 沙箱（PrivateTmp=yes）內，
  // 讀得到 agent 寫進私有 /tmp 的成片；網關進程（PrivateTmp=no）讀不到該私有 /tmp，故由工具讀檔傳
  // 位元組、網關不碰 agent FS。仍校驗大小/視頻音頻圖片擴展名，保持「僅媒體」契約。
  if (typeof body.path_b64 === "string" && body.path_b64.trim()) {
    buf = Buffer.from(body.path_b64, "base64")
    total = buf.length
    if (total === 0) return Response.json({ ok: false, error: "上传内容为空" }, { status: 400 })
    if (total > MAX_BYTES) {
      return Response.json({ ok: false, error: `file too large (${total} bytes, limit 200MB)` }, { status: 413 })
    }
    const fname = typeof body.filename === "string" ? body.filename : ""
    const srcExt = path.extname(fname).toLowerCase() || ".mp4"
    contentType = contentTypeForExt(srcExt)
    if (!contentType.startsWith("video/") && !contentType.startsWith("audio/") && !contentType.startsWith("image/")) {
      return Response.json({ ok: false, error: `不支持的文件类型 "${srcExt}"（仅接受视频/音频/图片）` }, { status: 415 })
    }
    outExt = srcExt.replace(/^\./, "")
  } else if (typeof body.url === "string" && body.url.trim()) {
    const src = body.url.trim()
    let upstream: Response
    try {
      upstream = await fetch(src, { signal: AbortSignal.timeout(120_000), redirect: "follow" })
    } catch (e) {
      return Response.json({ ok: false, error: `download failed: ${(e as Error).message}` }, { status: 502 })
    }
    if (!upstream.ok) {
      return Response.json({ ok: false, error: `upstream responded http ${upstream.status}` }, { status: 502 })
    }
    contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
    if (!contentType.startsWith("video/") && !contentType.startsWith("audio/") && !contentType.startsWith("image/")) {
      return Response.json({ ok: false, error: `unsupported content-type "${contentType || "none"}"（仅接受 video/*、audio/* 或 image/*）` }, { status: 415 })
    }
    const contentLength = Number(upstream.headers.get("content-length") || "0")
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
      return Response.json({ ok: false, error: `file too large (${contentLength} bytes, limit 200MB)` }, { status: 413 })
    }
    const reader = upstream.body?.getReader()
    if (!reader) return Response.json({ ok: false, error: "upstream returned empty body" }, { status: 502 })
    const chunks: Buffer[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {})
        return Response.json({ ok: false, error: "file too large (limit 200MB)" }, { status: 413 })
      }
      chunks.push(Buffer.from(value))
    }
    if (total === 0) return Response.json({ ok: false, error: "upstream returned empty body" }, { status: 502 })
    outExt = contentType.startsWith("video/")
      ? "mp4"
      : contentType.startsWith("audio/")
        ? "mp3"
        : contentType.includes("jpeg")
          ? "jpg"
          : contentType.includes("webp")
            ? "webp"
            : contentType.includes("gif")
              ? "gif"
              : "png"
    buf = Buffer.concat(chunks)
  } else {
    return Response.json({ ok: false, error: "url or path_b64 (string) is required" }, { status: 400 })
  }
  const name = `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${outExt}`
  const outDir = "/opt/image-data-api/data/uploads"
  try {
    const { writeFile } = await import("node:fs/promises")
    await mkdir(outDir, { recursive: true })
    await writeFile(path.join(outDir, name), buf)
  } catch (e) {
    console.error("[gateway] media upload persist failed:", e)
    return Response.json({ ok: false, error: "failed to persist media file" }, { status: 500 })
  }
  const publicUrl = `https://store.tinchak0207.xyz/image-data/files/uploads/${name}`
  console.log(`[gateway] media upload: session=${sessionId} bytes=${total} type=${contentType} -> ${publicUrl}`)
  return Response.json({ ok: true, url: publicUrl, bytes: total, content_type: contentType })
}

// POST /internal/canvas/dispatch-ops — opencode canvas_* 工具的下發入口。
// 阻塞至前端回執或逾時；timeout_ms 僅供測試縮短，上限即預設值。
async function handleCanvasDispatchOps(req: Request): Promise<Response> {
  let body: { session_id?: unknown; ops?: unknown; label?: unknown; timeout_ms?: unknown }
  try {
    body = (await req.json()) as { session_id?: unknown; ops?: unknown; label?: unknown; timeout_ms?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (typeof body.session_id !== "string" || !body.session_id) {
    return jsonError(400, "session_id is required", "bad_request", "bad_request")
  }
  const state = resolveSession(body.session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const v = validateCanvasOps(body.ops)
  if (!v.ok) return jsonError(400, v.message, "bad_request", "bad_request")
  const label = typeof body.label === "string" && body.label ? body.label.slice(0, 200) : undefined
  const rawTimeout = typeof body.timeout_ms === "number" && Number.isFinite(body.timeout_ms) ? body.timeout_ms : CANVAS_OPS_TIMEOUT_MS
  const timeoutMs = Math.max(1_000, Math.min(CANVAS_OPS_TIMEOUT_MS, rawTimeout))
  try {
    const { request_id, result } = await dispatchCanvasOps(state, v.ops, label, timeoutMs)
    return Response.json({ ok: true, request_id, result })
  } catch (e) {
    const err = e as { code?: string; request_id?: string }
    if (err?.code === "OPS_TIMEOUT") {
      return Response.json(
        { ok: false, code: "OPS_TIMEOUT", request_id: err.request_id ?? null, error: "前端未在時限內回執畫布操作結果" },
        { status: 504 },
      )
    }
    console.error("[gateway] canvas dispatch-ops error:", e)
    return jsonError(500, "canvas ops dispatch failed", "server_error", "server_error")
  }
}

// POST /internal/canvas/ops-result — loopback 回執（body 帶 session_id）。
async function handleCanvasOpsResultInternal(req: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const sessionId = typeof body.session_id === "string" ? body.session_id : ""
  const requestId = typeof body.request_id === "string" ? body.request_id : ""
  if (!sessionId || !requestId) {
    return jsonError(400, "session_id and request_id are required", "bad_request", "bad_request")
  }
  if (typeof body.ok !== "boolean") {
    return jsonError(400, "ok (boolean) is required", "bad_request", "bad_request")
  }
  const matched = resolveCanvasOps(sessionId, requestId, sanitizeOpsResult(body))
  return Response.json({ ok: true, matched })
}

// POST /agent/v1/sessions/:id/canvas/state — 前端（經站點代理）快照上行。
async function handleCanvasStatePublic(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { state?: unknown }
  try {
    body = (await req.json()) as { state?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (body.state === null || body.state === undefined || typeof body.state !== "object") {
    return jsonError(400, "state (object) is required", "bad_request", "bad_request")
  }
  const stored = storeCanvasState(state.sessionId, body.state)
  if (!stored.ok) {
    const code = stored.status === 413 ? "payload_too_large" : "bad_request"
    return jsonError(stored.status, stored.message, code, code)
  }
  return Response.json({ ok: true, bytes: stored.bytes, updated_at: stored.updatedAt })
}

// GET /agent/v1/sessions/:id/canvas/state — 前端（經站點代理）快照下行。
// 2026-08-29 修復：站點路由 GET /api/agent/sessions/:id/canvas-state 代理到這裡，
// 但本網關此前只有 POST 沒有 GET → 刷新/恢復會話必然 404。語義對齊
// GET /internal/canvas/snapshot；getOwnedSession 內含 DB 懶恢復（canvasStates 回灌），
// 進程重啟/閒置回收後照樣讀得到。
async function handleCanvasStatePublicGet(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const snap = getCanvasState(state.sessionId)
  return Response.json({
    ok: true,
    has_state: snap !== null,
    state: snap?.state ?? null,
    updated_at: snap?.updatedAt ?? null,
  })
}

// POST /agent/v1/sessions/:id/canvas/ops-result — 前端（經站點代理）回執。
async function handleCanvasOpsResultPublic(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const requestId = typeof body.request_id === "string" ? body.request_id : ""
  if (!requestId) return jsonError(400, "request_id is required", "bad_request", "bad_request")
  if (typeof body.ok !== "boolean") {
    return jsonError(400, "ok (boolean) is required", "bad_request", "bad_request")
  }
  const matched = resolveCanvasOps(state.sessionId, requestId, sanitizeOpsResult(body))
  return Response.json({ ok: true, matched })
}

// ─────────────────────────── TTS（配音）工具支持
//
// 背景：novel_film 8 環承諾裡的「配音」環此前是牆上菜單——劇本表按 4.5 字/秒
// 折算了秒數但整條鏈路沒有任何 TTS 消費方。此端點把配音變成真實可調用的
// 最小閉環：同步快速調用（不走 poller），輸入台詞文本，產出音頻 URL。
//
// 誠實原則（honest-error）：2026-08-30 起 TTS_UPSTREAM 指向本機 edge-tts-proxy(127.0.0.1:8893，
// /opt/edge-tts/，Microsoft edge-tts 免 key 中文音色)；此前 Groq playai-tts 已下架、orpheus 被 org 條款鎖死：
// - Groq playai-tts 已 decommissioned；canopylabs/orpheus-* 需 org 條款接受
//   且只有英文/阿拉伯文音色，無中文；
// - 平台 image.tinchak0207.xyz /v1/models 無任何 TTS 條目（seed_audio、
//   qwen_audio_tts、text2speech_v2 只存在於 higgsfield 快照文檔，未上線）；
// - new-api 渠道表只有 gpt-image-2 / nano-banana-pro，無 TTS 渠道。
// 所以本端點的上游調用路徑是「探測 → 上游不存在 → 誠實報錯」，不接任何
// 不穩定的外部免費 API 湊數。上游接入後只需改 TTS_UPSTREAM 一處。

const TTS_UPSTREAM = {
  // Groq audio proxy（VPS 本機 8892，透傳 api.groq.com，KEY 在 .env）
  base: process.env.TTS_UPSTREAM_BASE || "http://127.0.0.1:8892",
  speechPath: "/openai/v1/audio/speech",
  model: process.env.TTS_UPSTREAM_MODEL || "canopylabs/orpheus-v1-english",
  voice: process.env.TTS_UPSTREAM_VOICE || "tara",
}

interface TtsProbeResult {
  available: boolean
  note: string
}

/** 探測 TTS 上游是否真的能產中文音頻（帶 60s 負緩存避免反覆打壞渠道）。 */
let ttsProbeCache: { at: number; result: TtsProbeResult } | null = null
async function probeTtsUpstream(signal?: AbortSignal): Promise<TtsProbeResult> {
  if (ttsProbeCache && Date.now() - ttsProbeCache.at < 60_000) return ttsProbeCache.result
  let result: TtsProbeResult
  try {
    const res = await fetch(`${TTS_UPSTREAM.base}${TTS_UPSTREAM.speechPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TTS_UPSTREAM.model,
        input: "测",
        voice: TTS_UPSTREAM.voice,
        response_format: "mp3",
      }),
      signal: signal ?? AbortSignal.timeout(20_000),
    })
    if (res.ok) {
      const buf = await res.arrayBuffer()
      const head = new Uint8Array(buf.slice(0, 3))
      const looksLikeAudio = buf.byteLength > 64 && (head[0] === 0x49 || head[0] === 0x52 || head[0] === 0xff)
      result = looksLikeAudio
        ? { available: true, note: "上游可用" }
        : { available: false, note: "上游返回 200 但載荷不是音頻" }
    } else {
      const bodyText = await res.text().catch(() => "")
      let msg = bodyText.slice(0, 200)
      try {
        const j = JSON.parse(bodyText)
        msg = (j?.error?.message || msg).slice(0, 200)
      } catch { /* keep raw */ }
      result = { available: false, note: `上游 HTTP ${res.status}: ${msg}` }
    }
  } catch (e) {
    result = { available: false, note: `上游不可達: ${e instanceof Error ? e.message : String(e)}` }
  }
  ttsProbeCache = { at: Date.now(), result }
  return result
}

/**
 * POST /agent/v1/tts { text, voice?, session 帶 Bearer key }
 * 同步調用：成功 → { ok, url, cost_coins, chars }；上游不可用 → 503 誠實錯誤。
 * 定價一律走 pricing-and-validation.ts 的 estimateTtsCoins（工具側不硬編碼）。
 */
async function handleTts(key: string, req: Request): Promise<Response> {
  let body: { text?: string; voice?: string }
  try {
    body = (await req.json()) as { text?: string; voice?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!text) return jsonError(400, "text is required", "bad_request", "bad_request")
  if (text.length > 2000) return jsonError(400, "text too long (max 2000 chars)", "bad_request", "bad_request")

  const probe = await probeTtsUpstream()
  if (!probe.available) {
    return jsonError(
      503,
      `配音（TTS）上游暂不可用：${probe.note}。台词已收到，但当前无法真实生成音轨；请如实告知用户，勿编造音频链接。`,
      "tts_unavailable",
      "tts_unavailable",
    )
  }

  // 上游可用路徑（目前現實中走不到，保留完整閉環以便上游接入後即刻生效）
  try {
    const res = await fetch(`${TTS_UPSTREAM.base}${TTS_UPSTREAM.speechPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TTS_UPSTREAM.model,
        input: text,
        voice: body.voice || TTS_UPSTREAM.voice,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      const msg = (await res.text().catch(() => "")).slice(0, 200)
      return jsonError(502, `TTS upstream error: ${msg}`, "tts_upstream_error", "tts_upstream_error")
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 64) {
      return jsonError(502, "TTS upstream returned empty audio", "tts_empty_audio", "tts_empty_audio")
    }
    const id = `tts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const fileName = `${id}.mp3`
    await mkdir(TTS_AUDIO_DIR, { recursive: true })
    await Bun.write(path.join(TTS_AUDIO_DIR, fileName), buf)
    const cost_coins = estimateTtsCoins("tts-zh", text)
    const url = `${TTS_PUBLIC_BASE}/${fileName}`
    return Response.json({ ok: true, url, chars: text.length, cost_coins, format: "mp3" })
  } catch (e) {
    return jsonError(502, `TTS upstream error: ${e instanceof Error ? e.message : String(e)}`, "tts_upstream_error", "tts_upstream_error")
  }
}

/**
 * 時間線端點族（B1，2026-08-31）：REQ-EDIT-01 可計算時間線 + REQ-EDIT-05 版本/決策日誌。
 * session_id 一律走 query——Bun Request body 只能讀一次（workflow 家族同款模式）。
 * 鑑權 = 過上方 Bearer sk-biz 閘門 + getOwnedSession 防跨 key 越權（與 workflow rerun 同款）。
 * 錯誤映射：locked→409 {blocked, reason:"locked"}；非法 op→400；版本不存在→404。
 */
async function handleTimelineRoutes(key: string, req: Request, pathname: string): Promise<Response> {
  const url = new URL(req.url)
  let sid = url.searchParams.get("session_id") || ""
  if (!sid) return jsonError(400, "session_id (query) is required", "bad_request", "bad_request")
  // B2 修復（08-31）：opencode 工具傳的是 opencode session id，getOwnedSession 只認 gateway UUID。
  // 收斂到 canvasKeyFor 同款三段解析（resolveSession），並收攏 canonical id 防雙目錄。
  const tlState = resolveSession(sid)
  if (!tlState || tlState.apiKey !== key) return jsonError(404, "session not found", "not_found", "not_found")
  sid = tlState.sessionId
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  try {
    if (req.method === "GET" && pathname === "/agent/v1/timeline") {
      const tl = await getTimeline(sid)
      return Response.json({ ...tl, total_duration_sec: r3(totalDurationSec(tl)) })
    }
    if (req.method === "POST" && pathname === "/agent/v1/timeline/ops") {
      const body = (await req.json().catch(() => null)) as { ops?: TimelineOp[]; reason?: string } | null
      if (!body || !Array.isArray(body.ops)) return jsonError(400, "body.ops must be an array", "bad_request", "bad_request")
      const res = await applyOps(sid, body.ops, typeof body.reason === "string" ? body.reason : "")
      return Response.json({ diff: res.diff, version: res.version, total_duration_sec: res.total_duration_sec, affected_clips: res.affected_clips })
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/versions") {
      return Response.json({ versions: await listVersions(sid) })
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/diff") {
      const a = Number(url.searchParams.get("a"))
      const b = Number(url.searchParams.get("b"))
      if (!Number.isInteger(a) || !Number.isInteger(b)) return jsonError(400, "a and b (query) must be integers", "bad_request", "bad_request")
      return Response.json({ a, b, diff: await diffVersions(sid, a, b) })
    }
    if (req.method === "POST" && pathname === "/agent/v1/timeline/restore") {
      const body = (await req.json().catch(() => null)) as { version?: number } | null
      if (!body || !Number.isInteger(body.version)) return jsonError(400, "body.version must be an integer", "bad_request", "bad_request")
      const res = await restoreVersion(sid, body.version as number)
      return Response.json({ version: res.version, restored_from: body.version, diff: res.diff, total_duration_sec: res.total_duration_sec })
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/log") {
      return Response.json({ entries: await getLog(sid) })
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/rhythm") {
      const bgm = url.searchParams.get("bgm") || undefined
      return Response.json(await analyzeRhythm(sid, bgm ? { bgmPath: bgm } : {}))
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/lint") {
      return Response.json(await lintTimeline(sid))
    }
    // B5 音畫混合（REQ-EDIT-06）：GET 只量測不落盤；POST 渲染落盤 mix.wav
    if (req.method === "GET" && pathname === "/agent/v1/timeline/mix") {
      return Response.json(await analyzeMix(sid))
    }
    if (req.method === "POST" && pathname === "/agent/v1/timeline/mix") {
      return Response.json(await applyMix(sid))
    }
    // B7 風格貨架（REQ-EDIT-08）：目錄 / 套用（presetId→四滑桿翻譯成 set_style；transition 翻譯成既有 set_transition op）/ 字卡 ASS
    if (req.method === "GET" && pathname === "/agent/v1/timeline/style") {
      const tl = await getTimeline(sid)
      return Response.json(styleCatalog(tl))
    }
    if (req.method === "POST" && pathname === "/agent/v1/timeline/style") {
      const body = (await req.json().catch(() => null)) as {
        clipId?: string
        presetId?: string
        filter?: { brightness?: number; contrast?: number; saturation?: number; temperature?: number }
        transition?: { presetId?: string; durationSec?: number }
        reason?: string
      } | null
      if (!body || typeof body.clipId !== "string" || !body.clipId) return jsonError(400, "body.clipId is required", "bad_request", "bad_request")
      const ops: TimelineOp[] = []
      if (body.presetId !== undefined) {
        const p = findStylePreset(body.presetId)
        if (!p) return jsonError(400, `unknown presetId: ${body.presetId}（可選：${STYLE_PRESETS.map((x) => x.id).join("/")}）`, "bad_request", "bad_request")
        ops.push({ type: "set_style", clipId: body.clipId, filter: { preset: p.id, ...p.values } })
      } else if (body.filter) {
        ops.push({
          type: "set_style",
          clipId: body.clipId,
          filter: {
            brightness: Number(body.filter.brightness ?? 0),
            contrast: Number(body.filter.contrast ?? 0),
            saturation: Number(body.filter.saturation ?? 0),
            temperature: Number(body.filter.temperature ?? 0),
          },
        })
      }
      if (body.transition?.presetId !== undefined) {
        const t = findTransitionPreset(body.transition.presetId)
        if (!t) return jsonError(400, `unknown transition presetId: ${body.transition.presetId}`, "bad_request", "bad_request")
        ops.push({ type: "set_transition", clipId: body.clipId, transition: { type: t.xfade, duration: body.transition.durationSec ?? t.defaultDuration } })
      }
      if (!ops.length) return jsonError(400, "body requires presetId / filter / transition.presetId", "bad_request", "bad_request")
      const res = await applyOps(sid, ops, typeof body.reason === "string" ? body.reason : "set_style")
      return Response.json({ version: res.version, applied: res.affected_clips, diff: res.diff })
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/style/subtitles.ass") {
      const tl = await getTimeline(sid)
      return new Response(subtitlesAss(tl), { headers: { "content-type": "text/plain; charset=utf-8" } })
    }
    // B6 母帶檢查+導出閘（REQ-EDIT-07）：GET 聚合報告；POST blockers 非空拒導（TimelineValidationError→400）
    if (req.method === "GET" && pathname === "/agent/v1/timeline/master") {
      return Response.json(await masterCheck(sid))
    }
    if (req.method === "POST" && pathname === "/agent/v1/timeline/master") {
      const body = (await req.json().catch(() => null)) as { preset?: string; with_cover?: boolean } | null
      const presetId = (body?.preset ?? "landscape_169") as MasterPresetId
      if (!(presetId in MASTER_PRESETS)) return jsonError(400, `unknown preset: ${body?.preset}（可選：${Object.keys(MASTER_PRESETS).join("/")}）`, "bad_request", "bad_request")
      return Response.json(await masterExport(sid, presetId, body?.with_cover !== false))
    }
    return jsonError(404, "unknown timeline route", "not_found", "not_found")
  } catch (e) {
    if (e instanceof TimelineBlockedError) {
      return Response.json({ error: e.message, blocked: e.blocked, reason: "locked" }, { status: 409 })
    }
    if (e instanceof TimelineNotFoundError) return jsonError(404, e.message, "not_found", "timeline_version_not_found")
    if (e instanceof TimelineValidationError) return jsonError(400, e.message, "bad_request", "timeline_invalid_op")
    return jsonError(500, e instanceof Error ? e.message : String(e), "server_error", "timeline_error")
  }
}
async function handleConfirmRequest(req: Request): Promise<Response> {  let body: {
    session_id?: string
    request_id?: string
    amount_coins?: number
    description?: string
    model?: string
    task_id?: string
  }
  try {
    body = (await req.json()) as {
      session_id?: string
      request_id?: string
      amount_coins?: number
      description?: string
      model?: string
      task_id?: string
    }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, request_id } = body
  if (!session_id || !request_id) {
    return jsonError(400, "session_id and request_id are required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")

  // Idempotent by request_id. A re-post of a live request must NOT supersede it:
  // superseding used to resolve the earlier waiter to false, which with a polling
  // caller would read as "user denied" even though nobody had answered yet.
  const settled = state.resolvedConfirms.get(request_id)
  if (settled) return Response.json({ status: settled.outcome, request_id })
  if (state.pendingConfirms.has(request_id)) {
    return Response.json({ status: "pending", request_id }, { status: 202 })
  }

  const amount = typeof body.amount_coins === "number" ? body.amount_coins : 0
  const description = typeof body.description === "string" ? body.description : ""

  // 互动模式=auto：扣费确认不经用户，注册即批准（settleConfirm 内部落账+emit
  // confirm.resolved；工具下一次轮询 /internal/confirm-status 直接拿到 approved）。
  // 不 emit confirm.request（用户不看确认卡）。余额不足仍会被预检/结算拒掉，
  // 402 预算闸与批间 midBatchBudgetGate 不受影响（系统级安全，不是提问）。
  if (normalizeUserSettings(loadUserSettings(state.apiKey)).interaction_mode === "auto") {
    state.pendingConfirms.set(request_id, {
      timer: setTimeout(() => {}, 0),
      ledger: { amount_coins: amount, task_id: body.task_id, model: body.model },
    })
    settleConfirm(state, request_id, "approved")
    return Response.json({ status: "approved", request_id })
  }

  const timer = setTimeout(() => {
    // Expiry is a real outcome and must be announced. The old code only deleted
    // the entry, so the frontend's confirm card stayed on screen forever with no
    // way to tell it had already been decided against.
    settleConfirm(state, request_id, "expired")
  }, CONFIRM_TIMEOUT_MS)
  state.pendingConfirms.set(request_id, {
    timer,
    ledger: { amount_coins: amount, task_id: body.task_id, model: body.model },
  })

  // Surface the billing request to the frontend, then return immediately.
  // This request does NOT block for the answer: CONFIRM_TIMEOUT_MS (15 min)
  // exceeds both Bun's idleTimeout ceiling (255s) and the caller's abort, so
  // the tool polls /internal/confirm-status instead.
  emitToSession(state, "confirm.request", { request_id, amount_coins: amount, description })

  return Response.json({ status: "pending", request_id }, { status: 202 })
}

/**
 * Move a confirm from pending to resolved, announce it, and bill it.
 * Single path for all three ways a confirm can end (user answer, expiry,
 * session teardown) so none of them can forget to emit confirm.resolved.
 */
function settleConfirm(state: SessionState, requestId: string, outcome: ConfirmOutcome): boolean {
  const pending = state.pendingConfirms.get(requestId)
  if (!pending) return false
  clearTimeout(pending.timer)
  state.pendingConfirms.delete(requestId)

  state.resolvedConfirms.set(requestId, { outcome, resolvedAt: Date.now() })
  if (state.resolvedConfirms.size > CONFIRM_RESOLVED_CAP) {
    const oldest = state.resolvedConfirms.keys().next()
    if (!oldest.done) state.resolvedConfirms.delete(oldest.value)
  }

  const approved = outcome === "approved"
  emitToSession(state, "confirm.resolved", { request_id: requestId, approved })

  if (approved) {
    if (pending.ledger) {
      void appendLedgerFor(state, {
        kind: "confirm",
        event: "approved",
        cost_coins: pending.ledger.amount_coins,
        task_id: pending.ledger.task_id,
        model: pending.ledger.model,
      })
    }
    void emitQuotaChanged(state)
    // 2026-08-29 整改：批量執行 confirm 批准 → 觸發續跑（非阻塞設計的另一半）。
    // 未註冊回調的 confirm（image_* 單筆等）不受影響。
    const wfCont = wfGenerateContinuations.get(requestId)
    if (wfCont) {
      wfGenerateContinuations.delete(requestId)
      workflowGenerateApproved.set(wfCont.wfid, { amount: wfCont.amount, nodes: wfCont.nodes }) // 本批（節點數）已批；擴計畫須重批
      // 修 2：批量批准額記入 billing 真值——節點失敗時據此寫 refund 終態行，
      // workflow_status 據此回真值對象。
      workflowBilling.set(wfCont.wfid, {
        confirmed_coins: wfCont.amount,
        refunded_coins: 0,
        billing_status: "confirmed",
      })
      runWfGenerate(wfCont.state, wfCont.wfid)
    }
  }
  return true
}

/** Poll target for the tool: has the user answered this confirm yet? */
async function handleConfirmStatus(req: Request): Promise<Response> {
  let body: { session_id?: string; request_id?: string }
  try {
    body = (await req.json()) as { session_id?: string; request_id?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, request_id } = body
  if (!session_id || !request_id) {
    return jsonError(400, "session_id and request_id are required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  // A vanished session means the session was deleted or reaped out from under
  // the tool. That is a denial, not an unknown: nothing may be spent for a
  // session that no longer exists.
  if (!state) return Response.json({ status: "denied", request_id, reason: "session_gone" })

  const settled = state.resolvedConfirms.get(request_id)
  if (settled) return Response.json({ status: settled.outcome, request_id })
  if (state.pendingConfirms.has(request_id)) {
    return Response.json({ status: "pending", request_id }, { status: 202 })
  }
  // Neither pending nor recently resolved: the answer aged out of the retention
  // window, or this id was never registered. Fail closed.
  return Response.json({ status: "denied", request_id, reason: "unknown_request" })
}

async function handleResumeSession(req: Request): Promise<Response> {
  let body: { session_id?: string; content?: string }
  try {
    body = (await req.json()) as { session_id?: string; content?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, content } = body
  if (!session_id || typeof content !== "string" || content.trim() === "") {
    return jsonError(400, "session_id and content are required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  // Async, same reason as handleSendMessage: the poller must not be held open
  // for the length of an LLM turn.
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ ...beastAgentField(state), parts: [{ type: "text", text: content }] }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode resume failed: ${res.status}`, "backend_error", "backend_error")
    }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  // 抖動重試記賬（與 handleSendMessage 同款）：resume 輪同樣可能抖動早死。
  state.lastPromptBody = { ...beastAgentField(state), parts: [{ type: "text", text: content }] }
  state.turnGen = (state.turnGen ?? 0) + 1
  state.turnTextChars = 0
  state.turnReasoningChars = 0
  state.turnRetries = 0
  state.turnAborted = false
  state.retryQueued = false
  state.turnUpstreamError = null
  // R2-A 看門狗：resume 輪同樣要兜 turn 未啟動。
  state.turnToolStarted = false
  state.watchdogRetried = false
  // 修 1：resume 開新輪，舊死亡宣告作廢（撤回幀不嫁接到新輪）。
  state.deathDeclared = false
  // R8-B 工單 #4：resume 輪同樣重置 question 答覆標記。
  state.questionAnsweredThisTurn = false
  armWatchdogTimer(state)
  return Response.json({ ok: true })
}

async function handleSessionKey(req: Request): Promise<Response> {
  let body: { session_id?: string }
  try {
    body = (await req.json()) as { session_id?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id } = body
  if (!session_id) {
    return jsonError(400, "session_id is required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  if (state) {
    const user_id = await hashKey(state.apiKey)
    return Response.json({ ok: true, api_key: state.apiKey, user_id })
  }
  // 死线③（片 AN，评测 REPORT S2）：子代理 opencode session 只在 subagent 运行时
  // 注册表（byChildOc）里，主 sessions 表查无记录 → 工具侧 resolveKey 全挂。
  // 最小修：命中活跃子会话时继承父会话 apiKey（同一用户，计费口径不变）。
  const parentKey = subagentParentApiKey(session_id)
  if (parentKey) {
    const user_id = await hashKey(parentKey)
    return Response.json({ ok: true, api_key: parentKey, user_id })
  }
  return jsonError(404, "session not found", "not_found", "not_found")
}

// 0831：本輪任務登記表端點（給工具讀的權威 ID 來源）。鑑權/防呆逐字對齊 /internal/session-key：
// 同處 /internal/ loopback 門內、同一 resolveSession 查找、同 jsonError 防呆；僅回應換成 tasks 契約。
async function handleSessionTasks(req: Request): Promise<Response> {
  let body: { session_id?: string }
  try {
    body = (await req.json()) as { session_id?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id } = body
  if (!session_id) {
    return jsonError(400, "session_id is required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  if (!state) return Response.json({ ok: false, error: "session not found", tasks: [] }, { status: 404 })
  return Response.json({ ok: true, tasks: [...state.sessionTasks.values()] })
}

// ---- 任务失败 fan-out（poller 经 /internal/emit 调）----
// 与 emitImageDone 对称：SSE 帧 + 畫布節點 error 態 + ledger。前端 Settler
// 用 task_id（或按序）把 loading 節點置 error，resume 的 agent 文案講人話。
function emitImageFailed(
  state: SessionState,
  task_id: string,
  reason: string,
  refunded: boolean,
): void {
  // 0831：任務終態登記（失敗）。task 可能不在登記表（重啟丟內存態），不可假設存在。
  const t = state.sessionTasks.get(task_id)
  if (t) {
    t.status = "failed"
  }
  // S5a：失敗原因人話化（原文保留），SSE 幀與畫布 errorDetails 補 human_message。
  const human = humanMessageFor(reason, undefined)
  emitToSession(state, "image.failed", { task_id, reason, refunded, human_message: human })
  const unitId = task_id ? state.canvasUnitByTask.get(task_id) : undefined
  if (unitId) {
    emitToSession(state, "canvas.node.updated", {
      unit_id: unitId,
      node_id: `${unitId}-image`,
      patch: { status: "error", errorDetails: reason, human_message: human },
    })
  }
  void appendLedgerFor(state, {
    kind: "image",
    event: refunded ? "refunded" : "failed",
    task_id,
  })
}

async function handleInternalEmit(req: Request): Promise<Response> {
  let body: { session_id?: string; event?: string; data?: unknown }
  try {
    body = (await req.json()) as { session_id?: string; event?: string; data?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, event, data } = body
  if (!session_id || typeof event !== "string") {
    return jsonError(400, "session_id and event are required", "bad_request", "bad_request")
  }
  if (!INTERNAL_EMIT_ALLOWED.has(event) && !CANVAS_EMIT_ALLOWED.has(event)) {
    return jsonError(400, `event not allowed: ${event}`, "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")

  if (event === "image.done") {
    const d = (data ?? {}) as { url?: string; cost_coins?: number; task_id?: string }
    // Shared deduped path so /internal/emit and the opencode translation can
    // never announce the same url twice in one session. Awaited so the redirect
    // resolution completes before the poller gets its 200 and resumes the
    // session — otherwise the agent could describe an image the UI lacks.
    await emitImageDone(state, d.url ?? "", d.cost_coins, d.task_id)
  } else if (event === "image.failed") {
    const d = (data ?? {}) as { task_id?: string; reason?: string; refunded?: boolean }
    if (d.task_id) emitImageFailed(state, d.task_id, d.reason ?? "生成失敗", d.refunded === true)
  } else if (event === "session.error") {
    const d = (data ?? {}) as { code?: string; message?: string }
    emitSessionError(state, d.code ?? "backend_error", d.message ?? "session error")
  } else if (event === "quota.changed") {
    void emitQuotaChanged(state)
  } else if (event === "tool.result") {
    emitToSession(state, "tool.result", data ?? {})
  } else if (event === "tool.progress") {
    emitToSession(state, "tool.progress", data ?? {})
  } else if (CANVAS_EMIT_ALLOWED.has(event)) {
    // 畫布事件：純透傳，Frontend reducer 決定如何渲染。不做任何加工，
    // 保留 data 原樣。這讓 opencode 的 canvas_* 工具可以直接 speak 畫布
    // 指令給前端，而不需要透過 message.delta 繞一圈。
    emitToSession(state, event, data ?? {})
  }
  return Response.json({ ok: true })
}

/**
 * POST /agent/v1/optimize-prompt — 同步影片 prompt 優化。
 *
 * 這是 Image Studio 的「隱形提示詞導演」後端：generate-videos 進上游前，
 * 把用戶短 prompt + 金礦工業級導演規則送給 opencode（deepseek）大腦，
 * 同步拿回優化稿。與 agent 對話 session 完全隔離：每次請求建一個臨時
 * opencode session，用完即刪，不進 sessions 池、不開 SSE 流。
 *
 * body: { prompt: string, duration_seconds?: number, generate_audio?: boolean }
 * 回應: 200 { ok, prompt, model } / 502 { ok:false, ... }（上游不可用）
 *
 * 規則來源：Higgsfield Hell Grind 95 分鐘長片 pipeline + Seedance 2.0 官方
 * prompt 架構（OSideMedia/higgsfield-ai-prompt-skill，MIT）——31 子 skill 的
 * 共通核心全文編譯進 system prompt，一次讀完，不需 agent 多步思考。
 */

// 金礦工業級規則全文。用戶輸入可能只是「幫我生成浩克對戰蜘蛛俠的電影」這種
// 一句話抽象請求——規則負責把它變成可用 production prompt。
const OPTIMIZE_DIRECTOR_PREFIX = `You are a professional video and image prompt director trained on the Higgsfield Hell Grind 95-minute feature film pipeline and Seedance 2.0 production prompt rules.

Turn the user's request into ONE production-ready generation prompt. The user may be a non-expert writing one vague sentence — you must still produce a complete, usable prompt. Output ONLY the generated prompt, no preamble, no commentary, no markdown.

THE SIX-SLOT FORMULA (every prompt must contain all six, in this order):
[Camera movement] + [Subject] + [Action] + [Setting] + [Style] + [Lighting]
If the user's input is missing slots, fill them with the most effective defaults for the scene type. 50-80 words is the sweet spot for a single shot.

BLOCK SCAFFOLD (for multi-shot / long-form work):
SCENE CONTEXT → ACTIVE REFERENCES → LOCATION MAP → FIRST FRAME/BLOCKING → FORMAT MODE → OPTICS → CAMERA → ACTION → PERFORMANCE → PHYSICS → LIGHTING → COLOR GRADE → WARDROBE → AUDIO → STYLE → OUTPUT SETTINGS → POSITIVE LOCKS. Write only the blocks the shot needs. 2000+ words is fine here — structure replaces the word cap.

HARD RULES (each one exists because a shot failed without it):
1. POSITIVE PHRASING ONLY. Never write negative instructions ("does not", "no X"). Declare what IS true. Seedance parses every token as a positive instruction. Short lock tails inside a positive declaration ("Stable composition, no flicker") are fine.
2. ANTI-SLOP. Replace empty adjectives with named referents: "cinematic" -> a lighting setup or lens spec ("golden-hour backlight", "anamorphic 2.39:1 flare"); "epic" -> "large-scale"; "fast" -> describe physics ("feet striking hard, each stride at full extension"); "beautiful"/"high quality" -> delete, describe the specific visual.
3. EMOTION = MUSCLE. Never write emotion labels ("she looks scared"). Write "jaw clenches, nostrils flare, shallow breath, shoulders pull inward". One visible micro-event every 1-2 seconds (a blink, a breath, a nostril move). Layered emotion: dominant state in the face, underlying state in breath/posture/hands, the tell in the eyes.
4. NAME THE CAMERA WITH AN ENDPOINT. Not "the camera moves" but "slow dolly-in, ending on her hands around the cup". One primary move per shot, max one texture modifier ("slightly handheld"). Camera matches emotion: jittery handheld for anger, smooth breathing for calm, static slow push for revelation.
5. ONE PRIMARY ACTION per clip, 1-2 secondary max. Chain 2-3 connected actions in one direction so motion spends the whole clip. A deliberate there-and-back is two shots, never one prompt. Never let a short action finish early.
6. AGE-BLIND. Never describe characters by age (boy/girl/child/kid/teen/young/little). Use role, clothing, action. The content filter tightens sharply the moment it reads a minor.
7. IP AND REAL PEOPLE. Never name copyrighted characters (Hulk, Spider-Man, etc.) or real celebrities. Describe them by their defining visual traits, role, and actions instead: "an enormous green-skinned muscle-bound figure whose rage grows as it fights" / "a slight acrobatic hero in red-and-blue body armor who webs and swings". This is mandatory even when the user named the IP directly.
8. FOV IN DEGREES ONLY (for multishot): 180 fisheye / 107 ultra-wide arch / 84 wide group / 63 observational / 47 neutral / 29 portrait / 18 close portrait / 12 tele-detail / 8 extreme. Add "no drift mid-segment".
9. MEASURABLE LANGUAGE. Speed in km/h. Fog/haze in % and meters. Giant scale via human-height comparison ("as tall as four humans stacked"). Left/right always from the camera. White balance fixed in Kelvin (3200K/4000K/5600K/8500K). Mass and size in real units so gravity reads correctly.
10. HOMOGRAPH TRAP. If a word has a second physical reading the model may take it: tearing (rip/cry), shoot, duck, bolt, draw, wave, charge, rock, drop, fire, strike, break, pound, snap. Replace with phrasing only ONE thing can look like: "wind tearing at her coat" -> "wind whipping violently at her coat".
11. END WITH A QUALITY TAIL if video: "Stable composition, no flicker, detailed texture preserved." Audio: "SFX only, no music" unless the user asked for a soundtrack.
12. CUT DISCIPLINE. Keep one continuous shot unless the scene demands a cut. If a cut is needed, name the type (HARD CUT / SMASH CUT / MATCH CUT / REVERSE CUT) and timing. Every cut changes BOTH shot size AND camera character (double-contrast rule). Never repeat either across a cut.
13. POSITIVE LOCKS for multi-shot: "The set contains only what is described. Character identity and environment stay identical across every cut. No extra people, no duplicated furniture." For 2+ characters write real heights to prevent equalization drift.

WHEN THE USER IS VAGUE (they will be — they are a non-expert):
- Infer the scene type, pick the right template, and produce a complete prompt anyway.
- Decide camera, lighting, and style from the mood of the request.
- If they named a copyrighted hero, rewrite per rule 7 — never paste the IP name.
- If they described a shot type (battle, chase, dialogue, horror, product), use the strongest expected structure for that type.

Translate any Chinese user input to English in the output prompt.

USER:`
async function handleOptimizePrompt(key: string, req: Request): Promise<Response> {
  let body: { prompt?: string; duration_seconds?: number; generate_audio?: boolean }
  try {
    body = (await req.json()) as { prompt?: string; duration_seconds?: number; generate_audio?: boolean }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
  if (!prompt) return jsonError(400, "prompt is required", "bad_request", "bad_request")

  // 開一個一次性 opencode session（與對話 pool 無關）。
  let session: { id?: string }
  try {
    const res = await fetch(`${OPENCODE_URL}/session`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return jsonError(502, `opencode create session failed: ${res.status}`, "backend_error", "backend_error")
    session = (await res.json()) as { id?: string }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  if (!session.id) return jsonError(502, "opencode did not return a session id", "backend_error", "backend_error")

  const sessionId = session.id
  try {
    const content = `${OPTIMIZE_DIRECTOR_PREFIX}\n\n${prompt}`

    const res = await fetch(`${OPENCODE_URL}/session/${sessionId}/message`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ parts: [{ type: "text", text: content }] }),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode optimize failed: ${res.status}`, "backend_error", "backend_error")
    }

    const payload = (await res.json()) as { info?: { modelID?: string }; parts?: Array<{ type?: string; text?: string }> }
    // 最後一個 text part = 最終答案。opencode 同步 message 的 parts 順序是
    // step-start → text → step-finish，通常只有一個 text。
    const texts = (payload.parts ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text ?? "")
    const optimized = texts.length > 0 ? texts[texts.length - 1].trim() : ""
    if (!optimized) {
      return jsonError(502, "opencode returned no text", "backend_error", "backend_error")
    }
    return Response.json({ ok: true, prompt: optimized, model: payload.info?.modelID ?? "unknown" })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  } finally {
    // 一次性 session，事後必刪。
    await fetch(`${OPENCODE_URL}/session/${sessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {})
  }
}

const EXTRACT_LESSONS_PREFIX = `You are a memory curator for an AI image-generation assistant.
Your ONLY job: given a conversation transcript between a user and the assistant, extract up to 6 durable lessons about THIS USER that would help a future session serve them better without re-asking.

Rules:
- Lessons must be about the user's stable preferences, working habits, specs, style, workflow, or recurring corrections.
- One lesson per line. Each lesson is ONE short sentence (under 40 words), imperative-ish or declarative, e.g. "User batches 4 images at a time and wants them all in one canvas" or "User prefers 4:5 aspect ratio for product shots".
- Never invent facts not supported by the transcript.
- Skip one-time requests, greetings, and anything non-durable.
- Output ONLY the lessons, one per line, no preamble, no numbering, no markdown.`

async function handleExtractLessons(key: string, req: Request): Promise<Response> {
  let body: { transcript?: string; max_lessons?: number }
  try {
    body = (await req.json()) as { transcript?: string; max_lessons?: number }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : ""
  if (!transcript) return jsonError(400, "transcript is required", "bad_request", "bad_request")
  if (transcript.length > 100_000) return jsonError(400, "transcript too large", "bad_request", "bad_request")
  const maxLessons = Math.min(Math.max(Number(body.max_lessons) || 6, 1), 8)

  // 一次性 opencode session（与对话 pool 无关），同步取结果后即删。
  let session: { id?: string }
  try {
    const res = await fetch(`${OPENCODE_URL}/session`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return jsonError(502, `opencode create session failed: ${res.status}`, "backend_error", "backend_error")
    session = (await res.json()) as { id?: string }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  if (!session.id) return jsonError(502, "opencode did not return a session id", "backend_error", "backend_error")

  const sessionId = session.id
  try {
    const content = `${EXTRACT_LESSONS_PREFIX}\n\n<transcript>\n${transcript}\n</transcript>\n\n提取该用户的教训,每行一条。`
    const res = await fetch(`${OPENCODE_URL}/session/${sessionId}/message`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ parts: [{ type: "text", text: content }] }),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode extract failed: ${res.status}`, "backend_error", "backend_error")
    }
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    const raw = texts.length > 0 ? texts[texts.length - 1] : ""
    const lessons = raw
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter((l) => l.length > 0)
      .slice(0, maxLessons)
    if (lessons.length === 0) {
      return jsonError(502, "opencode returned no lessons", "backend_error", "backend_error")
    }
    return Response.json({ ok: true, lessons })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  } finally {
    await fetch(`${OPENCODE_URL}/session/${sessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {})
  }
}

// ─────────────────────────── 全局記憶接線（PRD P0-4，2026-09-15）───────────────────────────
// 契約 = MEMORY-INTERFACES.md §3.5/§3.6/§4/§7/§8 + PRD §6。memory-gate/memory-batch/
// memory-recall 三模組已落位且邏輯凍結（單測 50 綠），本檔只接線不動其邏輯。
// 本區內容：注入塊組裝純函式（§4）、批次 deps 與定時器（§3.5/§8）、每回合召回
// prefetch（§7）、三個端點（batch-run / memory-trace / memory-recall）。
// 憑據紀律：MEMORY_INGEST_SECRET 與簽名值永不寫進 log／回應。

// §6.1 預算表：L0 2400、L1 800（system，首回合）；召回前綴 1800 由 renderRecallPrefix
// 自行封頂；合計硬上限 5000（R1 尺可斷言）。
const MEMORY_L0_BUDGET = 2400
const MEMORY_L1_BUDGET = 800
const MEMORY_INJECTION_TOTAL_BUDGET = 5000
const MEMORY_PRIVATE_DOCS_MAX = 8 // 契約 §4：私有 active docs 注入 ≤8
const MEMORY_TRUNC_MARK = "（已截斷）" // 契約 §4 截斷標記
const MEMORY_RECALL_PREFETCH_TTL_MS = 5 * 60 * 1000 // 預取候選保鮮期（§7 prefetch）
const MEMORY_ASSISTANT_HEAD_CHARS = 200 // §7 query 的 assistant 頭部長度

function clampMemoryChars(text: string, cap: number): string {
  if (text.length <= cap) return text
  return text.slice(0, Math.max(0, cap - MEMORY_TRUNC_MARK.length)) + MEMORY_TRUNC_MARK
}

/**
 * 契約 §4 注入塊組裝（純函式；PRD §9 R1 注入形狀尺的可測面）：
 * L0 私有塊 = 既有 user_profile/lessons（D2 文案）+ memory_docs（≤8，§4 索引行格式），
 * 2400 字元硬上限，超限截斷尾標「（已截斷）」；
 * L1 共享目錄塊 = memory_index_md，800 字元，末尾帶 memory_recall 使用指引
 * （MEMORY_SHARED_ENABLED=false → 零注入，§8）。
 * 合計 5000 字元為代碼級 assert：單塊封頂後理論不可達（2400+800≤3200），
 * 觸發即不變量被破壞——誠實記 error 並強制截尾，用戶回合不燒。
 */
function buildMemoryInjectionBlocks(
  userMemory: SessionState["userMemory"],
  sharedEnabled: boolean,
): { lines: string[]; trace: { private_docs: string[]; shared_index_chars: number } } {
  const l0Parts: string[] = []
  const privateDocs: string[] = []
  if (userMemory) {
    const up = userMemory.user_profile ?? {}
    if (Object.keys(up).length > 0) {
      const fields = Object.entries(up)
        .map(([k, v]) => {
          const val = Array.isArray(v) ? v.join("、") : String(v ?? "")
          return `- ${k}: ${val}`
        })
        .join("\n")
      l0Parts.push(`以下是这个账户已确认的画像（来自之前的会话）：\n${fields}`)
    }
    const lessons = userMemory.lessons ?? []
    if (lessons.length > 0) {
      // D2（PRD §2.2）：舊文案「（已被確認）」屬虛假陳述（生產 0 筆 confirmed），契約 §4 欽定中性文案。
      l0Parts.push(`以下是这个账户从过往合作中提炼的教训（仅供参考，可能已过期，冲突以现场为准）：\n${lessons.map((l) => `- ${l}`).join("\n")}`)
    }
    const docs = Array.isArray(userMemory.memory_docs) ? userMemory.memory_docs.slice(0, MEMORY_PRIVATE_DOCS_MAX) : []
    for (const d of docs) {
      const domain = typeof d.domain === "string" && d.domain ? d.domain : "general"
      const slug = typeof d.slug === "string" && d.slug ? d.slug : "doc"
      // §4 索引行格式：`- [domain] slug — description` + 正文縮排。
      l0Parts.push(`- [${domain}] ${slug} — ${String(d.description ?? "")}\n   ${String(d.body ?? "")}`)
      privateDocs.push(typeof d.id === "string" && d.id ? d.id : slug)
    }
  }
  const lines: string[] = []
  let sharedIndexChars = 0
  if (l0Parts.length > 0) lines.push(clampMemoryChars(l0Parts.join("\n"), MEMORY_L0_BUDGET))
  const indexMd = typeof userMemory?.memory_index_md === "string" ? userMemory.memory_index_md.trim() : ""
  if (sharedEnabled && indexMd) {
    const l1 = clampMemoryChars(
      `以下是本平台积累的领域知识目录（仅供参考，可能已过期，冲突以现场为准）：\n${indexMd}\n（模型可调用 memory_recall 工具读取全部正文）`,
      MEMORY_L1_BUDGET,
    )
    lines.push(l1)
    sharedIndexChars = l1.length // trace 口徑＝實際注入 L1 塊字元數（預算消耗面）
  }
  const total = lines.reduce((n, s) => n + s.length, 0)
  if (total > MEMORY_INJECTION_TOTAL_BUDGET) {
    console.error(`[memory-inject] BUDGET ASSERT: total=${total} > ${MEMORY_INJECTION_TOTAL_BUDGET} — force clamp`)
    const kept: string[] = []
    let used = 0
    for (const line of lines) {
      if (used + line.length > MEMORY_INJECTION_TOTAL_BUDGET) break
      kept.push(line)
      used += line.length
    }
    return { lines: kept, trace: { private_docs: privateDocs, shared_index_chars: sharedIndexChars } }
  }
  return { lines, trace: { private_docs: privateDocs, shared_index_chars: sharedIndexChars } }
}

/** §3.6 形狀 trace：首個觀測點（注入或召回命中）落地時建立。 */
function ensureMemoryTrace(state: SessionState): NonNullable<SessionState["memoryTrace"]> {
  if (!state.memoryTrace) {
    state.memoryTrace = {
      private_docs: [],
      shared_recalled: [],
      shared_index_chars: 0,
      injected_at: new Date().toISOString(),
    }
  }
  return state.memoryTrace
}

/** 召回命中寫入 trace.shared_recalled。id 取自 memoryDocIds 旁表（模組 toRecallableDocs 剝 id，不動其邏輯）；缺則以 slug 兜底（偏離點已回報）。 */
function appendMemoryRecallTrace(state: SessionState, refs: Array<{ domain: string; slug: string }>): void {
  if (refs.length === 0) return
  const trace = ensureMemoryTrace(state)
  for (const r of refs) {
    const id = memoryDocIds.get(`${r.domain}/${r.slug}`) ?? r.slug
    if (!trace.shared_recalled.includes(id)) trace.shared_recalled.push(id)
  }
  const RECALL_TRACE_CAP = 32
  if (trace.shared_recalled.length > RECALL_TRACE_CAP) {
    trace.shared_recalled.splice(0, trace.shared_recalled.length - RECALL_TRACE_CAP)
  }
}

/** §7 召回輔助：累積本輪 assistant 正文頭部（只需前 200 字元，填滿即停，成本 O(1)）。 */
function noteAssistantHeadForRecall(state: SessionState, text: string): void {
  if (!text) return
  const cur = state.turnAssistantHead ?? ""
  if (cur.length >= MEMORY_ASSISTANT_HEAD_CHARS) return
  state.turnAssistantHead = (cur + text).slice(0, MEMORY_ASSISTANT_HEAD_CHARS)
}

// ── 召回語料與 prefetch（契約 §3.3/§7）────────────────────────────────────

// export 端點的 id 旁表：CorpusCache 的 toRecallableDocs 只留四欄，trace 需要真 id；
// 在 fetchExport（本檔所有）解析時順手收錄，key=`domain/slug`。有界：超 5000 整表重清
// （CorpusCache TTL 5 分鐘自然全量重拉回填）。
const memoryDocIds = new Map<string, string>()

/** 簽名 GET export（§3：GET 無 body → 空 bytes 驗簽）。CorpusCache 傳入的 headers 已含同款簽名，這裡按本檔 env 快照重建以明確 fail-fast。 */
async function memoryFetchExport(pathWithQuery: string, headers: Record<string, string>): Promise<unknown> {
  if (!MEMORY_INGEST_SECRET) throw new Error("MEMORY_INGEST_SECRET 未配置")
  const res = await fetch(`${MEMORY_INGEST_BASE_URL}${pathWithQuery}`, {
    headers: { ...headers, [MEMORY_SIGNATURE_HEADER]: signEmptyMemoryBody(MEMORY_INGEST_SECRET) },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`memory export HTTP ${res.status}`)
  const payload = (await res.json()) as unknown
  const list = (payload as { docs?: unknown })?.docs
  if (Array.isArray(list)) {
    if (memoryDocIds.size > 5000) memoryDocIds.clear()
    for (const raw of list) {
      const d = raw as Record<string, unknown>
      if (typeof d?.id === "string" && typeof d?.domain === "string" && typeof d?.slug === "string") {
        memoryDocIds.set(`${d.domain}/${d.slug}`, d.id)
      }
    }
  }
  return payload
}

// 語料 TTL 5 分鐘（§3.3 默認）；secret provider 顯式指向本檔 env 快照。
const memorySharedCorpus = new CorpusCache(memoryFetchExport, 5 * 60 * 1000, () => MEMORY_INGEST_SECRET)

interface MemoryRecallPrefetchEntry {
  prefix: string
  docRefs: Array<{ domain: string; slug: string }>
  at: number
}
// prefetch 緩存 Map<sessionId,{prefix,at}>（§7）：5 分鐘 TTL，隨會話銷毀清理（teardownSession）。
const memoryRecallPrefetch = new Map<string, MemoryRecallPrefetchEntry>()
const memoryRecallInflight = new Set<string>()

function memoryRecallActive(): boolean {
  return MEMORY_RECALL_ENABLED && MEMORY_SHARED_ENABLED
}

/** 回合開始取預取候選（讀即棄：回合結束重算，防舊候選殭屍注入）。null=miss → 本回合不注入、異步補算。 */
function takeMemoryRecallPrefix(sessionId: string): MemoryRecallPrefetchEntry | null {
  if (!memoryRecallActive()) return null
  const rec = memoryRecallPrefetch.get(sessionId)
  if (!rec) return null
  memoryRecallPrefetch.delete(sessionId)
  if (Date.now() - rec.at > MEMORY_RECALL_PREFETCH_TTL_MS) return null
  return rec
}

/** §7 prefetch：上一回合 session.idle 後台算好 top-3 候選（用戶路徑零新增延遲）。 */
async function scheduleMemoryRecallPrefetch(state: SessionState): Promise<void> {
  if (!memoryRecallActive()) return
  if (memoryRecallInflight.has(state.sessionId)) return
  memoryRecallInflight.add(state.sessionId)
  try {
    const query = buildRecallQuery(state.lastUserMessage ?? "", state.turnAssistantHead ?? "")
    const docs = await memorySharedCorpus.get("shared")
    const hits = recallTop(query, docs, { minScore: MEMORY_RECALL_MIN_SCORE }) // top-3 = BM25_DEFAULT_K 默認（§7）
    memoryRecallPrefetch.set(state.sessionId, {
      prefix: renderRecallPrefix(hits.map((h) => h.doc)),
      docRefs: hits.map((h) => ({ domain: h.doc.domain, slug: h.doc.slug })),
      at: Date.now(),
    })
  } catch (e) {
    // 失敗是常態（secret 未配／端點未上線），不刷 log；debug 級可查。
    console.debug(`[memory-recall] prefetch failed session=${state.sessionId}: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    memoryRecallInflight.delete(state.sessionId)
  }
}

// ── 批次接線（契約 §3.5/§8；輪子表 §10）──────────────────────────────────

// PRD §5.2 條件③：知識型（外部信息攝入）工具集，排序加權用。
const KNOWLEDGE_TOOL_NAMES = new Set(["search_web", "vision_analyze", "asset_search", "image_get_result"])

/** transcriptOf：複用 handleTranscript 的 fetch 形狀（opencode GET /session/:id/message），渲染成純文本。 */
async function memoryTranscriptOf(opencodeSessionId: string): Promise<string> {
  const res = await fetch(`${OPENCODE_URL}/session/${encodeURIComponent(opencodeSessionId)}/message`, {
    headers: opencodeHeaders(),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`memory transcript fetch HTTP ${res.status}`)
  const msgs = (await res.json()) as Array<Record<string, any>>
  const lines: string[] = []
  for (const m of Array.isArray(msgs) ? msgs.slice(-200) : []) {
    const role = m?.info?.role === "user" ? "user" : "assistant"
    for (const p of Array.isArray(m?.parts) ? m.parts : []) {
      if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
        lines.push(`${role}: ${p.text.trim()}`)
      } else if (p?.type === "tool" && typeof p.tool === "string") {
        const status = typeof p?.state?.status === "string" ? p.state.status : "unknown"
        lines.push(`${role} [tool ${p.tool} ${status}]`)
      }
    }
  }
  const transcript = lines.join("\n")
  // 上限比照輪子 100k 量級再收斂（curator 輸入面）；超長取尾——最近回合最有價值。
  return transcript.length > 60_000 ? transcript.slice(-60_000) : transcript
}

/** 逐會話訊息計數（PRD §5.2 條件②③）。失敗＝計不出 → 全 0，篩選自然放棄。 */
async function memorySessionCounts(
  opencodeSessionId: string,
): Promise<{ userMessages: number; successfulToolCalls: number; knowledgeToolCalls: number }> {
  let userMessages = 0
  let successfulToolCalls = 0
  let knowledgeToolCalls = 0
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${encodeURIComponent(opencodeSessionId)}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { userMessages: 0, successfulToolCalls: 0, knowledgeToolCalls: 0 }
    const msgs = (await res.json()) as Array<Record<string, any>>
    for (const m of Array.isArray(msgs) ? msgs : []) {
      if (m?.info?.role === "user") userMessages += 1
      for (const p of Array.isArray(m?.parts) ? m.parts : []) {
        if (p?.type === "tool" && p?.state?.status === "completed") {
          successfulToolCalls += 1
          if (KNOWLEDGE_TOOL_NAMES.has(String(p.tool ?? ""))) knowledgeToolCalls += 1
        }
      }
    }
  } catch {
    return { userMessages: 0, successfulToolCalls: 0, knowledgeToolCalls: 0 }
  }
  return { userMessages, successfulToolCalls, knowledgeToolCalls }
}

/** listSessions：loopback GET /session（opencode 目錄）＋ sessions.db 反查 ownerKey（hashKey 同算法）。 */
async function memoryListSessions(): Promise<MemorySessionRecord[]> {
  const res = await fetch(`${OPENCODE_URL}/session`, {
    headers: opencodeHeaders(),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`memory listSessions HTTP ${res.status}`)
  const dir = (await res.json()) as Array<Record<string, any>>
  const nowMs = Date.now()
  const out: MemorySessionRecord[] = []
  const needCounts: MemorySessionRecord[] = []
  for (const s of Array.isArray(dir) ? dir : []) {
    const id = typeof s?.id === "string" ? s.id : ""
    if (!id) continue
    const parentId = typeof s?.parentID === "string" && s.parentID ? s.parentID : null
    const time = s?.time as { created?: number; updated?: number } | undefined
    const updatedAt =
      typeof time?.updated === "number" ? time.updated : typeof time?.created === "number" ? time.created : undefined
    const rec: MemorySessionRecord = { id, parentId, updatedAt }
    try {
      const row = loadSessionByOpencodeId(id) // 只讀 DB row，不走 findSessionByOpenCodeId（那會把會話殭屍復活進內存）
      if (row?.apiKey) rec.ownerKey = await hashKey(row.apiKey)
    } catch {
      /* ownerKey 缺失 → private 無處安放（批次按 g4_no_owner 記帳） */
    }
    // 計數只補非 subagent 且 48 小時內（UTC）有動的會話：批次條件②的門檻篩選需要計數，
    // 更舊的計數缺也過不了門檻——避免全目錄逐會話 message GET（R5 尺：批次窗口不擠壓主對話）。
    // 手動指定 session_ids 重跑不依賴計數（批次在該路徑不看門檻）。
    if (!parentId && typeof updatedAt === "number" && nowMs - updatedAt <= 48 * 3600_000) {
      needCounts.push(rec)
    }
    out.push(rec)
  }
  // 併發上限 4：背景計算，讓主鏈路先走。
  for (let i = 0; i < needCounts.length; i += 4) {
    const chunk = needCounts.slice(i, i + 4)
    const counts = await Promise.all(chunk.map((r) => memorySessionCounts(r.id)))
    chunk.forEach((r, j) => {
      r.userMessages = counts[j].userMessages
      r.successfulToolCalls = counts[j].successfulToolCalls
      r.knowledgeToolCalls = counts[j].knowledgeToolCalls
    })
  }
  return out
}

/** callLlm = handleExtractLessons 三段骨架逐行複製（契約 §10 輪子表）。白名單：prompt 直傳、超時 120s→180s、函式名／回傳純文本；模型與通道同輪子常量（不帶 model 欄，opencode 默認路由）。 */
async function memoryCallLlm(prompt: string): Promise<string> {
  // 一次性 opencode session（與對話 pool 無關），同步取結果後即刪。
  let session: { id?: string }
  try {
    const res = await fetch(`${OPENCODE_URL}/session`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`opencode create session failed: ${res.status}`)
    session = (await res.json()) as { id?: string }
  } catch {
    throw new Error("opencode backend unreachable")
  }
  if (!session.id) throw new Error("opencode did not return a session id")
  const opencodeSessionId = session.id
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${opencodeSessionId}/message`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
      signal: AbortSignal.timeout(180000), // 白名單改動：curator 全文輸入，窗口放寬到 180s
    })
    if (!res.ok) throw new Error(`opencode curator call failed: ${res.status}`)
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    return texts.length > 0 ? texts[texts.length - 1] : ""
  } finally {
    await fetch(`${OPENCODE_URL}/session/${opencodeSessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {})
  }
}

/** ingest/review 送出（§3.1/§3.2＋P1-1 review 端點，同一 HMAC 簽名通道）。headers 由 memory-batch 按「將送出的精確 raw bytes」算好簽名傳入，這裡防衛性重簽同一串（同算法同值）；非 2xx throw（批次落 pending 指數退避）。 */
async function memoryPostIngest(
  pathOnly: string,
  rawBody: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  if (!MEMORY_INGEST_SECRET) throw new Error("MEMORY_INGEST_SECRET 未配置")
  const res = await fetch(`${MEMORY_INGEST_BASE_URL}${pathOnly}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
      [MEMORY_SIGNATURE_HEADER]: signMemoryBytes(rawBody, MEMORY_INGEST_SECRET),
    },
    body: rawBody, // 原樣位元組串，嚴禁重新序列化（簽名即失效）
    signal: AbortSignal.timeout(30_000),
  })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* 非 JSON 回應 → null；成敗以 status 為準 */
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`memory ingest HTTP ${res.status}`)
  return { status: res.status, json }
}

/**
 * verifier/oracle 一次性 LLM 呼叫＝memoryCallLlm 三段骨架逐行複製（契約 §10 輪子表）。
 * 白名單改動：① 簽名加 model 參數（G8/抽檢「換模型」）；② message body 附
 * `model: {providerID, modelID}`（既有輪走 opencode 默認路由，此輪必須指定另一模型），
 * 字串以 bindingRef 解析 `provider/model`，解析不了即 throw（fail-fast 誠實報錯）；
 * ③ 錯誤訊息以 label 區分。通道與超時同輪子（建/刪 10s、呼叫 180s）。
 */
async function memoryCallLlmWithModel(prompt: string, model: string, label: string): Promise<string> {
  const ref = bindingRef(model)
  if (!ref) throw new Error(`memory ${label}: invalid model ref (expect provider/model)`)
  // 一次性 opencode session（與對話 pool 無關），同步取結果後即刪。
  let session: { id?: string }
  try {
    const res = await fetch(`${OPENCODE_URL}/session`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`opencode create session failed: ${res.status}`)
    session = (await res.json()) as { id?: string }
  } catch {
    throw new Error("opencode backend unreachable")
  }
  if (!session.id) throw new Error("opencode did not return a session id")
  const opencodeSessionId = session.id
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${opencodeSessionId}/message`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
        model: { providerID: ref.providerID, modelID: ref.modelID },
      }),
      signal: AbortSignal.timeout(180000), // 白名單改動：curator 全文輸入，窗口放寬到 180s
    })
    if (!res.ok) throw new Error(`opencode ${label} call failed: ${res.status}`)
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    return texts.length > 0 ? texts[texts.length - 1] : ""
  } finally {
    await fetch(`${OPENCODE_URL}/session/${opencodeSessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {})
  }
}

const memoryBatch = createMemoryBatch({
  listSessions: memoryListSessions,
  transcriptOf: memoryTranscriptOf,
  callLlm: memoryCallLlm,
  callVerifierLlm: (prompt, model) => memoryCallLlmWithModel(prompt, model, "verifier"),
  callOracleLlm: (prompt, model) => memoryCallLlmWithModel(prompt, model, "oracle"),
  postIngest: memoryPostIngest,
  env: {
    MEMORY_INGEST_SECRET,
    MEMORY_BATCH_ENABLED: process.env.MEMORY_BATCH_ENABLED,
    MEMORY_BATCH_MAX_SESSIONS: process.env.MEMORY_BATCH_MAX_SESSIONS,
    MEMORY_BATCH_MAX_LLM: process.env.MEMORY_BATCH_MAX_LLM,
    MEMORY_SHARED_ENABLED: process.env.MEMORY_SHARED_ENABLED,
    MEMORY_VERIFIER_MODEL,
    MEMORY_ORACLE_MODEL,
    MEMORY_STATE_DIR: process.env.MEMORY_STATE_DIR,
  },
  now: () => new Date(),
})

/** §3.5 手動批次觸發（過 isLoopback 門後進入）。body {dry_run, session_ids, date} 透傳 runBatch，回 §3.5 報告形狀。 */
async function handleMemoryBatchRunInternal(req: Request): Promise<Response> {
  let body: { dry_run?: boolean; session_ids?: string[]; date?: string }
  try {
    body = (await req.json()) as { dry_run?: boolean; session_ids?: string[]; date?: string }
  } catch {
    body = {}
  }
  try {
    const report = await memoryBatch.runBatch({
      dryRun: body.dry_run === true,
      sessionIds: Array.isArray(body.session_ids) ? body.session_ids.map((s) => String(s)) : undefined,
      date: typeof body.date === "string" ? body.date : undefined,
    })
    return Response.json(report)
  } catch (e) {
    // runBatch 的拒絕原因（總開關未開／參數非法）原樣透傳——誠實報錯，不造假 200。
    const msg = e instanceof Error ? e.message : String(e)
    return jsonError(409, `memory batch failed: ${msg}`, "memory_batch_failed", "memory_batch_failed")
  }
}

/** §3.6 注入 trace（R2 尺觀測點）。尚無 trace（未注入／重啟丟失）→ 空形狀、injected_at=null。 */
async function handleMemoryTrace(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  return Response.json(
    state.memoryTrace ?? { private_docs: [], shared_recalled: [], shared_index_chars: 0, injected_at: null },
  )
}

/**
 * memory_recall 工具後端（PRD §6.2；【契約外新增路由】，已隨本片回報）。
 * 從共享語料跑 §7 召回，回 {results:[{doc:{slug,domain,description,body},score}],count}。
 * limit 默認 5、上限 10；minScore=MEMORY_RECALL_MIN_SCORE；共享關 → 空 results。
 */
async function handleMemoryRecallSearch(key: string, req: Request): Promise<Response> {
  void key // 同族鑑權口徑：Bearer 閘門已在上游驗過，此端點無 session 維度，不需 key 數據面
  let body: { query?: string; domain?: string; limit?: number }
  try {
    body = (await req.json()) as { query?: string; domain?: string; limit?: number }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const query = typeof body.query === "string" ? body.query.slice(0, 500) : ""
  if (!query.trim()) return jsonError(400, "query is required", "bad_request", "bad_request")
  if (!MEMORY_SHARED_ENABLED) return Response.json({ results: [], count: 0 })
  let docs: RecallableDoc[]
  try {
    docs = await memorySharedCorpus.get("shared")
  } catch (e) {
    console.error(`[memory-recall] corpus fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    return jsonError(502, "memory corpus unavailable", "backend_error", "backend_error")
  }
  if (typeof body.domain === "string" && body.domain.trim()) {
    const dm = body.domain.trim()
    docs = docs.filter((d) => d.domain === dm)
  }
  const k = Math.min(Math.max(Number.parseInt(String(body.limit ?? ""), 10) || 5, 1), 10)
  const hits = recallTop(query, docs, { minScore: MEMORY_RECALL_MIN_SCORE, k })
  const results = hits.map((h) => ({
    doc: { slug: h.doc.slug, domain: h.doc.domain, description: h.doc.description, body: h.doc.body },
    score: h.score,
  }))
  // 工具端 memory_recall_impl 解析 body.results ?? body.docs（頂層陣列=直接拋 upstream_bad_response）
  return Response.json({ results, count: results.length })
}

// ── 批次 ticker（60s；輪子＝本檔既有 setInterval 寫法）─────────────────────
// 條件（§8）：MEMORY_BATCH_ENABLED && UTC 時 == MEMORY_BATCH_HOUR_UTC && 游標日期<今日。
// 「游標日期」以進程內 volatile 閘實裝＝最近一次批次嘗試日的 UTC 日期：memory-batch 的
// 游標檔只有會話維度去重、未暴露批次日期維度；嘗試即置位防同小時 60 連發，失敗當日由
// 運維經 POST /internal/memory/batch-run 手動重跑。每 tick 順帶 drainPending()
// （pending 重發指數退避；無 pending 檔時 noop，總開關 off 也照跑——殘留檔要有人收）。
let memoryBatchLastRunDate = ""
setInterval(() => {
  void (async () => {
    try {
      await memoryBatch.drainPending()
    } catch (e) {
      console.error(`[memory-batch] drain tick failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!MEMORY_BATCH_ENABLED) return
    const now = new Date()
    if (now.getUTCHours() !== MEMORY_BATCH_HOUR_UTC) return
    const today = now.toISOString().slice(0, 10)
    if (memoryBatchLastRunDate >= today) return
    memoryBatchLastRunDate = today
    console.log(`[memory-batch] scheduled batch starting (UTC ${MEMORY_BATCH_HOUR_UTC}h ${today})`)
    try {
      const report = await memoryBatch.runBatch({})
      console.log(
        `[memory-batch] scheduled batch done: batch=${report.batch_id} candidates=${report.candidates} passed=${report.passed} stored=${report.stored}`,
      )
    } catch (e) {
      console.error(`[memory-batch] scheduled batch failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  })()
}, 60_000)

// ---- CORS ----

// Explicit allowlist, not "*": these responses are authenticated with a
// sk-biz-* key, and a wildcard origin combined with credentials is exactly the
// configuration browsers refuse (and that would let any site drive a user's
// paid account). Configure via CORS_ORIGINS as a comma-separated list.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "https://image.tinchak0207.xyz")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean)

function corsOriginFor(origin: string | null): string | null {
  if (!origin) return null // same-origin / curl: no CORS headers needed
  const normalized = origin.replace(/\/+$/, "")
  if (CORS_ORIGINS.includes(normalized)) return origin
  if (CORS_ORIGINS.includes("*")) return origin // echo the caller, never literal "*"
  // local dev: 192.168.*, localhost, 127.0.0.1
  if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(normalized)) return origin
  return null
}

function corsHeaders(allowedOrigin: string | null): Record<string, string> {
  if (!allowedOrigin) return {}
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    // last-event-id must be allowed or SSE resume-after-reconnect fails preflight.
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID",
    "Access-Control-Max-Age": "86400",
    // Varying on Origin keeps a CDN from caching one origin's headers for another.
    Vary: "Origin",
  }
}

// ---- HTTP server ----

// ─── Director（片3，2026-09-02）：/agent/v1/director 家族 ───
// emitter/resolver 注入：复用现有 emitToSession 与 resolveSession，不发明新机制。
setDirectorEmitter((sid, name, data) => {
  const st = resolveSession(sid)
  if (st) emitToSession(st, name, data)
})
setDirectorSessionResolver((sid) => {
  const st = resolveSession(sid)
  return st ? { sessionId: st.sessionId, apiKey: st.apiKey } : undefined
})

const server = Bun.serve({
  port: PORT,
  // Bun's default idleTimeout is 10s, which would kill the long-lived SSE
  // streams this gateway depends on. 255s is Bun's maximum; SSE stays alive
  // past it via the 20s heartbeat.
  //
  // This 255s ceiling is also why confirmation is no longer a blocking request:
  // CONFIRM_TIMEOUT_MS is 15 minutes, which no HTTP request can span, so
  // /internal/confirm-request registers and returns while the tool polls
  // /internal/confirm-status for the answer.
  idleTimeout: 255,
  async fetch(req: Request, srv): Promise<Response> {
    // CORS wrapper: the frontend is served from a different origin (Vercel)
    // than this gateway (VPS behind nginx), so without these headers every
    // browser call fails preflight and the whole frontend integration is dead.
    const origin = req.headers.get("origin")
    const allowed = corsOriginFor(origin)

    // Preflight must be answered BEFORE the auth check — the browser sends
    // OPTIONS with no Authorization header, so a 401 here would block the
    // real request from ever being sent.
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowed) })
    }

    const res = await handleRequest(req, srv)
    if (!allowed) return res
    // Response headers are immutable once constructed, so rebuild. The body is
    // passed through by reference, which keeps SSE streaming intact.
    const headers = new Headers(res.headers)
    for (const [k, v] of Object.entries(corsHeaders(allowed))) headers.set(k, v)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  },
})

async function handleRequest(req: Request, srv: { requestIP: (r: Request) => { address: string } | null }): Promise<Response> {
  {
    const url = new URL(req.url)
    const pathname = url.pathname
    // B5 混音產物靜態服務（無鑑權，鏡像 TTS 音頻公開 blob 模型；MIX_PUBLIC_BASE=/agent/v1/timeline-mix/<sid>/mix.wav）。放在 Bearer 閘門之前。
    {
      const m = pathname.match(/^\/agent\/v1\/timeline-mix\/([A-Za-z0-9_-]+)\/mix\.wav$/)
      if (req.method === "GET" && m) {
        const mixBase = path.resolve(path.join(WORKSPACE_DIR, "timelines"))
        const mixFile = path.resolve(path.join(mixBase, m[1], "mix.wav"))
        if (!mixFile.startsWith(mixBase + path.sep)) {
          return jsonError(400, "invalid path", "bad_request", "bad_request")
        }
        const file = Bun.file(mixFile)
        if (!(await file.exists())) {
          return jsonError(404, "mix not found", "not_found", "not_found")
        }
        return new Response(file, {
          headers: {
            "Content-Type": "audio/wav",
            "Cache-Control": "public, max-age=86400",
          },
        })
      }
    }
    let clientIp: string | null = null
    try {
      clientIp = srv.requestIP(req)?.address ?? null
    } catch {
      clientIp = null
    }

    // TTS 音頻靜態服務（無鑑權，同平台公開 blob 模型）。放在 Bearer 閘門之前。
    {
      const m = pathname.match(/^\/agent\/v1\/audio\/([A-Za-z0-9_.-]+)$/)
      if (req.method === "GET" && m) {
        const fileName = m[1]
        const filePath = path.join(TTS_AUDIO_DIR, fileName)
        if (!path.resolve(filePath).startsWith(path.resolve(TTS_AUDIO_DIR))) {
          return jsonError(400, "invalid path", "bad_request", "bad_request")
        }
        const file = Bun.file(filePath)
        if (!(await file.exists())) {
          return jsonError(404, "audio not found", "not_found", "not_found")
        }
        return new Response(file, {
          headers: {
            "Content-Type": fileName.endsWith(".mp4") ? "video/mp4" : fileName.endsWith(".wav") ? "audio/wav" : "audio/mpeg",
            "Cache-Control": "public, max-age=86400",
          },
        })
      }
    }

    // Health (no auth). Also served under /agent/healthz because nginx proxies
    // /agent/ to this port WITHOUT stripping the prefix, so /healthz alone is
    // not reachable from outside and an external uptime check would get 401.
    if (req.method === "GET" && (pathname === "/healthz" || pathname === "/agent/healthz")) {
      return Response.json({ ok: true, timestamp: new Date().toISOString(), sessions: sessions.size })
    }

    // Internal routes: loopback-only, no API key
    if (pathname.startsWith("/internal/")) {
      if (!isLoopback(clientIp)) {
        return jsonError(403, "internal endpoint only reachable from localhost", "forbidden", "forbidden")
      }
      if (req.method === "POST" && pathname === "/internal/confirm-request") {
        return handleConfirmRequest(req)
      }
      if (req.method === "POST" && pathname === "/internal/confirm-status") {
        return handleConfirmStatus(req)
      }
      if (req.method === "POST" && pathname === "/internal/resume-session") {
        return handleResumeSession(req)
      }
      if (req.method === "POST" && pathname === "/internal/session-key") {
        return handleSessionKey(req)
      }
      if (req.method === "POST" && pathname === "/internal/session-tasks") {
        return handleSessionTasks(req)
      }
      if (req.method === "POST" && pathname === "/internal/emit") {
        return handleInternalEmit(req)
      }
      if (req.method === "GET" && pathname === "/internal/canvas/state") {
        return handleCanvasStateRead(req)
      }
      // Wave C：畫布快照寫入 / 工具快照讀取 / ops 下發 / 回執（皆 loopback）。
      if (req.method === "POST" && pathname === "/internal/canvas/state") {
        return handleCanvasStateWrite(req)
      }
      if (req.method === "GET" && pathname === "/internal/canvas/snapshot") {
        return handleCanvasSnapshotRead(req)
      }
      if (req.method === "POST" && pathname === "/internal/canvas/dispatch-ops") {
        return handleCanvasDispatchOps(req)
      }
      if (req.method === "POST" && pathname === "/internal/canvas/ops-result") {
        return handleCanvasOpsResultInternal(req)
      }
      // 素材入庫：opencode video_upload 工具經此把外部影片/音頻下載進平台存儲。
      if (req.method === "POST" && pathname === "/internal/media/upload") {
        return handleMediaUpload(req)
      }
      // 子代理运行时：派发 + 工具轮询取件（loopback，鉴权同其他 internal 端点）。
      if (req.method === "POST" && pathname === "/internal/subagent/dispatch") {
        return handleSubagentDispatch(req)
      }
      if (req.method === "POST" && pathname === "/internal/subagent/status") {
        return handleSubagentStatus(req)
      }
      // ── 契約 §3.5：記憶批次手動觸發（每日 ticker 之外的運維入口）。──
      // 鑑權＝與現狀同構的 loopback-only 門（本 /internal/ 區塊上層已裁定：既有
      // /internal/* 全部只驗 isLoopback、無 HARNESS key；契約 §3.5 寫的
      // HARNESS_API_KEY 與現場衝突，上層裁決照現場、不加 key——偏離契約處已回報）。
      if (req.method === "POST" && pathname === "/internal/memory/batch-run") {
        return handleMemoryBatchRunInternal(req)
      }
      // 工作流引擎端點：接受 session_id（opencode 或 gateway id）解析 session。
      if (pathname === "/internal/workflow/templates" && req.method === "GET") {
        return workflowServiceTemplates()
      }
      if (pathname.startsWith("/internal/workflow/")) {
        const m = new URL(req.url)
        const sessionId = m.searchParams.get("session_id") || (await req.json().catch(() => ({})))?.session_id || ""
        const session = sessionId ? resolveSession(sessionId) : undefined
        if (!session) return jsonError(404, "session not found", "not_found", "not_found")
        return handleWorkflowInternal(req, session)
      }
      return jsonError(404, "not found", "not_found", "not_found")
    }

    // Ticket-authenticated SSE. Checked before the Bearer gate because the
    // browser EventSource cannot send a header at all; the ticket IS the
    // credential here. Read-only and single-session — see issueSseTicket.
    {
      const m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/events$/)
      if (req.method === "GET" && m) {
        const ticket = url.searchParams.get("ticket")
        if (ticket) {
          const state = redeemSseTicket(ticket, m[1])
          if (!state) return jsonError(401, "invalid or expired SSE ticket", "unauthorized", "unauthorized")
          let lastEventId: number | undefined
          const raw = req.headers.get("last-event-id") || url.searchParams.get("last_event_id")
          if (raw) {
            const n = Number.parseInt(raw, 10)
            if (!Number.isNaN(n)) lastEventId = n
          }
          return openEventStream(state, lastEventId, req)
        }
      }
    }

    // 附件靜態直讀（票據鑑權，與上方 ticket SSE 同理：瀏覽器 <img> 帶不了
    // Authorization 頭）。路徑約束在 UPLOADS_DIR 內防目錄穿越；無效/過期票據
    // 與不存在的文件一律 404，不泄露存在性。
    {
      const m = pathname.match(/^\/agent\/v1\/uploads\/([^/]+)\/([^/]+)$/)
      if (req.method === "GET" && m) {
        const ticket = url.searchParams.get("t") ?? ""
        // decodeURIComponent 可能因畸形 % 序列拋 URIError：整段包裹，異常即 404。
        let sessionId = ""
        let fileName = ""
        try {
          sessionId = decodeURIComponent(m[1])
          fileName = decodeURIComponent(m[2])
        } catch {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        // 穿越防禦：白名單字符集（與 sanitizeUploadName 產物同款 \w.\- 空格，
        // 天然排除 / 與 \）+ 顯式拒 ".." + resolve 前綴兜底（同上傳寫入 L485 寫法）。
        const segSafe = /^[\w.\- ]+$/
        if (!ticket || !redeemUploadTicket(ticket, sessionId) || !segSafe.test(sessionId) || !segSafe.test(fileName) || fileName.includes("..") || sessionId.includes("..")) {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        const filePath = path.join(UPLOADS_DIR, sessionId, fileName)
        if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        const file = Bun.file(filePath)
        if (!(await file.exists())) {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        return new Response(file, {
          headers: { "Content-Type": contentTypeForExt(path.extname(fileName).toLowerCase()) },
        })
      }
    }

    // 瀏覽器原片直傳影片（票據鑑權，與上方附件靜態直讀同理：瀏覽器帶不了
    // Authorization 頭，且原片超過站內代理 body 上限，前端繞開 Vercel 直連網關
    // origin）。讀票復用（redeemUploadTicket 非一次性）；落盤進同一 UPLOADS_DIR
    // 會話目錄，上傳後讀票路由即可直接讀回。不動 4MB attachments 端點。
    {
      const m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/video-upload$/)
      if (req.method === "POST" && m) {
        let sessionId = ""
        try {
          sessionId = decodeURIComponent(m[1])
        } catch {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        const segSafe = /^[\w.\- ]+$/
        const ticket = url.searchParams.get("t") ?? ""
        if (!ticket || !redeemUploadTicket(ticket, sessionId) || !segSafe.test(sessionId) || sessionId.includes("..")) {
          return jsonError(401, "invalid or expired upload ticket", "unauthorized", "unauthorized")
        }
        const ct = req.headers.get("content-type") || ""
        if (!ct.includes("multipart/form-data")) {
          return jsonError(400, "multipart/form-data required", "bad_request", "bad_request")
        }
        try {
          const form = await req.formData()
          const files = form.getAll("file") as File[]
          if (files.length === 0) return jsonError(400, "no file field", "bad_request", "bad_request")
          const file = files[0]
          if (file.size > VIDEO_UPLOAD_MAX_BYTES) {
            return jsonError(413, "video exceeds 100MB limit", "payload_too_large", "payload_too_large")
          }
          const ext = path.extname(file.name).toLowerCase()
          if (!file.type.startsWith("video/") && !VIDEO_UPLOAD_EXTS.has(ext)) {
            return jsonError(415, "only video files accepted", "unsupported_media_type", "unsupported_media_type")
          }
          const safeName = sanitizeUploadName(file.name)
          if (!safeName) {
            return jsonError(400, `disallowed file type: ${path.extname(file.name)}`, "bad_request", "bad_request")
          }
          const uploadDir = path.join(UPLOADS_DIR, sessionId)
          await mkdir(uploadDir, { recursive: true })
          const dest = path.join(uploadDir, safeName)
          if (!path.resolve(dest).startsWith(path.resolve(UPLOADS_DIR))) {
            return jsonError(400, "invalid path", "bad_request", "bad_request")
          }
          await Bun.write(dest, await file.arrayBuffer())
          return Response.json({ ok: true, path: `uploads/${sessionId}/${safeName}`, name: safeName, size: file.size, mime: file.type || "video/mp4" })
        } catch (e) {
          console.error("[gateway] video-upload error:", e)
          return jsonError(500, "video upload failed", "server_error", "server_error")
        }
      }
    }

    // Public routes: require a valid Bearer sk-biz-* key
    const rawKey = getBearer(req)
    if (!rawKey || !rawKey.startsWith("sk-biz-")) {
      return jsonError(401, "missing or invalid API key", "unauthorized", "unauthorized")
    }
    // 2026-09-13 刀3：兩步鑑權改並行。讀碼判定無真依賴——兩者都只吃 rawKey、各打
    // 獨立 PLATFORM_BASE 端點（validate→/v1/models；resolve→/biz/resolve-owner，
    // 後者本身以 Bearer rawKey 自證歸屬），串行只是「先驗權後正典」的順序慣例。
    // 語義恆等：ok=false 仍 401（此時 canonicalKey 棄用）；resolve 對無效 key 只是
    // 拿 non-200 → 負緩存 60s＋fallback rawKey，無副作用。串行 miss 24–533ms×2 →
    // 並行取 max。
    const [keyOk, canonicalKey] = await Promise.all([validateApiKey(rawKey), resolveCanonicalKey(rawKey)])
    if (!keyOk) {
      return jsonError(401, "invalid API key", "unauthorized", "unauthorized")
    }
    // R6 身份正典化：raw B key → 屬主派生 key——直連與 /api/agent/biz 代理從此同一
    // 身份空間（settings/sessions/野獸開關一致）。解析失敗一律 fallback rawKey：
    // 站点抖动不能变成网关故障（负缓存防风暴）。
    const key = canonicalKey

    if (req.method === "GET" && pathname === "/agent/v1/quota") {
      return handleQuota(key)
    }

    // 畫布 workflow 節點操作（rerun/update）：站點 /api/agent/sessions/:id/workflow-node-*
    // 代理進來。/internal/workflow/* 是 loopback-only，Vercel 站點打不進——這裡掛
    // Bearer 家族等價入口（同一 handleWorkflowInternal，endsWith 匹配前綴無關）。
    // 會話歸屬 getOwnedSession 防跨 key 越權；Bun Request.json() 重複讀取有緩存，
    // 與 /internal 家族「先讀 session_id 再交 handler」同款模式。
    if (req.method === "POST" && (pathname.endsWith("/workflow/node/rerun") || pathname.endsWith("/workflow/node/update"))) {
      // Bun Request body 只能讀一次：這裡只准用 query 拿 session_id，body 原樣留給
      // handleWorkflowInternal 再讀（與 /internal 家族 query 優先同款）。
      const wfSid = new URL(req.url).searchParams.get("session_id") || ""
      if (!wfSid) return jsonError(400, "session_id (query) is required", "bad_request", "bad_request")
      const wfState = getOwnedSession(key, wfSid)
      if (!wfState) return jsonError(404, "session not found", "not_found", "not_found")
      return handleWorkflowInternal(req, wfState)
    }

    

// 會話記憶補注（契約 §4）：resume/switch 的老會話事後補上帳戶畫像/教訓與
// memory_docs/memory_index_md。
// D1 修復（2026-09-15 PRD P0-4）：原實作只翻 memoryInjected 這面無人讀的死旗標
// → 對已注入 system 的會話完全無效（與原註釋宣稱相反）。真閘是 vettingInjected：
// 到達時重置為 false，並卸除 onboarding 指引（畫像非空，重建時不該再重複注入）；
// 下一回合按最新記憶重建 system。directiveInjected 刻意不重置——模板指引一次性，
// 重建時不會重複注入。
if (req.method === "POST" && pathname === "/agent/v1/sessions/memory-patch") {
  const body = (await req.json().catch(() => null)) as {
    session_id?: string
    user_profile?: Record<string, unknown>
    lessons?: string[]
    memory_docs?: MemoryDocLite[]
    memory_index_md?: string
  } | null
  const sid = body?.session_id ?? ""
  if (!sid) return jsonError(400, "session_id is required", "bad_request", "bad_request")
  const state = getOwnedSession(key, sid)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const up = body.user_profile ?? {}
  const docs = Array.isArray(body.memory_docs) ? body.memory_docs.slice(0, MEMORY_PRIVATE_DOCS_MAX) : []
  const indexMd = typeof body.memory_index_md === "string" ? body.memory_index_md : ""
  if (Object.keys(up).length > 0 || docs.length > 0 || indexMd.trim().length > 0) {
    state.userMemory = { user_profile: up, lessons: body.lessons ?? [], memory_docs: docs, memory_index_md: indexMd }
    state.vettingInjected = false
    state.profileOnboardingPending = false
    markDirty(state)
    return Response.json({ patched: true, has_profile: true })
  }
  return Response.json({ patched: false, has_profile: false })
}
// 會話目錄：當前 key 的歷史會話列表（對話歷史 dropdown 的數據源）。
if (req.method === "GET" && pathname === "/agent/v1/sessions") {
  // 09-12：零回合會話（預建未用）不出現在目錄；數據保留，按 id 直連仍可達
  // （GET :id / :id/messages / SSE 回放 / DELETE 均不經此過濾，深鏈 switchSession 可用）。
  // 判據=持久化 eventCounter：只有 emit 任何 SSE 幀才會漲，而建號不 emit——
  // 「曾開始過回合」的結構性訊號。刻意不用 lastTurnActiveAt：它是 in-flight 打點、
  // turn 正常結束即清零（L4624 打點/L3975 清零），按它過濾會誤殺全部已完成會話
  // （實測 104 行真會話裡 102 行清零殘留）。過濾放在標題回填之前＝殭屍行不佔回填配額。
  const rows = listSessionRows(key).filter((r) => {
    const live = sessions.get(r.sessionId)
    return (live?.eventCounter ?? r.data.eventCounter ?? 0) > 0
  })
  // 會話摘要標題有界回填（2026-09-12）：idle 掛鉤上線前的存量會話 data 無
  // title；每次調用最多取 10 個缺欄行並發向 opencode 抓（3s 超時），拿到即
  // setRowTitle 落盤＋同步內存態（防在飛的 saveSession 把舊無標題鏡像蓋回去）。
  // 缺 opencode_session_id 的理論上不該存在，一併跳過；失敗靜默 null 不擋目錄。
  const titleMissing = rows.filter((r) => !r.data.title && r.opencodeSessionId).slice(0, 10)
  if (titleMissing.length > 0) {
    await Promise.all(
      titleMissing.map(async (r) => {
        try {
          const title = await fetchOpencodeTitle(r.opencodeSessionId)
          if (!title) return
          r.data.title = title
          const live = sessions.get(r.sessionId)
          if (live) live.sessionTitle = title
          setRowTitle(r.sessionId, title)
        } catch {
          // 靜默降級：目錄返回不受單行回填影響
        }
      }),
    )
  }
  // 0831 歷史會話狀態標識（前端 dropdown 的圓點）：三態優先級
  // waiting（有未答的 question/confirm）> running（turn 在飛 或 有在途生成任務）> idle。
  // pendingQuestions/pendingConfirms 只在記憶體（重啟即清）；lastTurnActiveAt 是持久化
  // 欄位、turn 正常結束清零，但異常死亡的 turn 會留殘值 → 加 15 分鐘窗口，
  // 否則殭屍會話永遠掛著「運轉中」騙用戶。
  const TURN_RUNNING_WINDOW_MS = 15 * 60 * 1000
  return Response.json({
    object: "agent.session.list",
    sessions: rows.map((r) => {
      const live = sessions.get(r.sessionId)
      const waiting = (live?.pendingQuestions?.size ?? 0) + (live?.pendingConfirms?.size ?? 0) > 0
      const startedAt = live?.lastTurnActiveAt ?? r.data.lastTurnActiveAt ?? 0
      const turnInFlight = startedAt > 0 && Date.now() - startedAt < TURN_RUNNING_WINDOW_MS
      const genInFlight = live && live.sessionTasks
        ? [...live.sessionTasks.values()].some((t) => t.status === "queued" || t.status === "running")
        : false
      const status = waiting ? "waiting" : turnInFlight || genInFlight ? "running" : "idle"
      return {
        session_id: r.sessionId,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        last_activity_at: r.data.lastActivityAt ?? r.updatedAt,
        status,
        // 選填欄位契約：舊前端不讀不崩；null=尚未生成（降級時間標籤）。
        title: r.data.title ?? null,
      }
    }),
  })
}

// S7（2026-08-29）：用戶級 settings（key 維度，持久化 sessions.db，重啟不丟）。
// GET 無記錄回默認值 steer/efficient/balanced；POST 同 shape 部分更新，
// 未知欄位/非法值一律 400，不靜默吞。
if (req.method === "GET" && pathname === "/agent/v1/settings") {
  return Response.json({ ...normalizeUserSettings(loadUserSettings(key)), beast_mode: loadUserSettings(key)?.beast_mode === true })
}
if (req.method === "POST" && pathname === "/agent/v1/settings") {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  for (const k of Object.keys(body)) {
    if (k === "beast_mode") {
      if (typeof body[k] !== "boolean") {
        return jsonError(400, `invalid settings field: ${k}`, "bad_request", "bad_request")
      }
      continue
    }
    const allowed = USER_SETTINGS_ENUMS[k as keyof typeof USER_SETTINGS_ENUMS]
    const v = body[k]
    if (!allowed || typeof v !== "string" || !allowed.includes(v)) {
      return jsonError(400, `invalid settings field: ${k}`, "bad_request", "bad_request")
    }
  }
  const next: UserSettingsShape = { ...normalizeUserSettings(loadUserSettings(key)), ...(body as Partial<UserSettingsShape>) }
  // beast_mode sanitize：顯式欄位放行（顯式列出、缺欄=保持現值；枚舉白名單會剝布林欄）。
  if (typeof body.beast_mode === "boolean") next.beast_mode = body.beast_mode
  else delete next.beast_mode
  saveUserSettings(key, next)
  return Response.json(next)
}


    if (req.method === "POST" && pathname === "/agent/v1/sessions") {
      return handleCreateSession(key, req)
    }

    if (req.method === "POST" && pathname === "/agent/v1/optimize-prompt") {
      return handleOptimizePrompt(key, req)
    }

    // TTS（配音）：同步快速調用，不走 poller。上游可用時直接回音頻 URL；
    // 上游不可用時誠實報錯（tts_unavailable），不造假成功。
    if (req.method === "POST" && pathname === "/agent/v1/tts") {
      return handleTts(key, req)
    }

    // 時間線（B1，2026-08-31）：/agent/v1/timeline 家族——session_id 一律走 query
    // （Bun Request body 只能讀一次，workflow 家族同款坑）；鑑權=上游 Bearer 閘門
    // + getOwnedSession 防跨 key 越權，不發明新機制。
    if (pathname === "/agent/v1/timeline" || pathname.startsWith("/agent/v1/timeline/")) {
      return handleTimelineRoutes(key, req, pathname)
    }

    // Director（片3，2026-09-02）：/agent/v1/director 家族——session_id 走 query 或 path，
    // 鑑權同款（Bearer 閘門 + resolveSession + apiKey 比對防跨 key 越權）。
    if (pathname === "/agent/v1/director" || pathname.startsWith("/agent/v1/director/")) {
      return handleDirectorRoutes(key, req, pathname)
    }

    if (req.method === "POST" && pathname === "/agent/v1/extract-lessons") {
      return handleExtractLessons(key, req)
    }

    const tm = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/transcript$/)
    if (req.method === "GET" && tm) {
      return handleTranscript(key, tm[1], req)
    }

    let m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/messages$/)
    if (req.method === "POST" && m) {
      return handleSendMessage(key, m[1], req)
    }
    if (req.method === "GET" && m) {
      return handleGetSessionMessages(key, m[1])
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/events$/)
    if (req.method === "GET" && m) {
      return handleEventStream(key, m[1], req)
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/confirm$/)
    if (req.method === "POST" && m) {
      return handleConfirm(key, m[1], req)
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/question$/)
    if (req.method === "POST" && m) {
      return handleQuestion(key, m[1], req)
    }

    // Mint a query-string credential for EventSource. Authenticated with the
    // Bearer key, so only the session owner can obtain one.
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/sse-ticket$/)
    if (req.method === "POST" && m) {
      if (!getOwnedSession(key, m[1])) return jsonError(404, "session not found", "not_found", "not_found")
      return Response.json({ ticket: issueSseTicket(key, m[1]), expires_in_ms: SSE_TICKET_TTL_MS })
    }

    // 附件直讀票據（2026-08-29）：前端 <img> GET 帶不了 Authorization 頭，
    // 用認證 POST 換一張只讀票據（TTL 1 小時，與 sse-ticket 同構，key 校驗同款）。
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/uploads-ticket$/)
    if (req.method === "POST" && m) {
      if (!getOwnedSession(key, m[1])) return jsonError(404, "session not found", "not_found", "not_found")
      return Response.json({ ticket: issueUploadTicket(m[1]), expires_in_ms: UPLOAD_TICKET_TTL_MS })
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/abort$/)
    if (req.method === "POST" && m) {
      return handleAbortSession(key, m[1])
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)$/)
    if (req.method === "GET" && m) {
      return handleGetSession(key, m[1])
    }
    if (req.method === "DELETE" && m) {
      return handleDeleteSession(key, m[1])
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/attachments$/)
    if (req.method === "POST" && m) {
      return handleAttachmentUpload(key, m[1], req)
    }

    // Wave C：畫布快照上行與 canvas.ops 回執（前端經站點代理呼叫）。
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/canvas\/state$/)
    if (req.method === "POST" && m) {
      return handleCanvasStatePublic(key, m[1], req)
    }
    if (req.method === "GET" && m) {
      return handleCanvasStatePublicGet(key, m[1])
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/canvas\/ops-result$/)
    if (req.method === "POST" && m) {
      return handleCanvasOpsResultPublic(key, m[1], req)
    }

    // ── PRD P0-4（2026-09-15）記憶 trace 與召回路由（認證＝同族 Bearer 閘門）──
    // 契約 §3.6：注入 trace（R2 尺觀測點）；站點 /api/agent/sessions/[id]/memory-trace 只做代理。
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/memory-trace$/)
    if (req.method === "GET" && m) {
      return handleMemoryTrace(key, m[1])
    }
    // 【契約外新增】memory_recall 工具（.opencode/tools 薄入口，PRD §6.2）的取數後端：
    // 從共享語料跑 §7 召回。契約 §3 未列此路由，屬本片新增（已在回報中標明）。
    if (req.method === "POST" && pathname === "/agent/v1/memory/recall") {
      return handleMemoryRecallSearch(key, req)
    }

    return jsonError(404, "not found", "not_found", "not_found")
  }
}

// Heartbeat keeps frontend SSE streams alive and prunes dead clients.
setInterval(() => {
  const ping = encoder.encode(": ping\n\n")
  for (const state of sessions.values()) {
    for (const client of state.clients) {
      try {
        client.controller.enqueue(ping)
      } catch {
        state.clients.delete(client)
      }
    }
  }
}, HEARTBEAT_INTERVAL_MS)

// Idle-session reaper. Sessions were previously freed only by an explicit
// DELETE, so a closed browser tab leaked its SessionState — including a
// 200-frame replay buffer — for the lifetime of the process. A session is
// reaped only when it has NO connected SSE clients AND no activity for
// SESSION_IDLE_TTL_MS, so an active stream or an in-flight generate is never
// collected. Since 2026-08-29 the upstream opencode session is NOT deleted
// here: message history lives there, and deleting it turned revived sessions
// into empty shells. Cleanup rides the 7-day stale sweep and explicit DELETE.
setInterval(() => {
  const now = Date.now()
  for (const [ticket, rec] of sseTickets) {
    if (rec.expiresAt <= now) sseTickets.delete(ticket)
  }
  for (const [ticket, rec] of uploadTickets) {
    if (rec.expiresAt <= now) uploadTickets.delete(ticket)
  }
  for (const [id, state] of sessions) {
    // Drop confirm answers past their retention window so a long-lived session
    // does not accumulate them forever.
    for (const [requestId, rec] of state.resolvedConfirms) {
      if (now - rec.resolvedAt > CONFIRM_RESOLVED_TTL_MS) state.resolvedConfirms.delete(requestId)
    }
    if (state.clients.size > 0) continue
    // A pending confirm pins the session. With CONFIRM_TIMEOUT_MS at 15 min and
    // SESSION_IDLE_TTL_MS at 30 min this cannot pin it forever: the confirm
    // expires first, and the next sweep is free to reap.
    if (state.pendingConfirms.size > 0) continue
    if (state.pendingQuestions.size > 0) continue
    if (now - state.lastActivityAt < SESSION_IDLE_TTL_MS) continue
    const idleMs = now - state.lastActivityAt
    teardownSession(id, state, "idle_timeout", true)
    // 2026-08-29 修復「空殼會話」：閒置回收不再刪 opencode 會話與上傳目錄。
    // 訊息歷史權威在 opencode，DB row（keepRow=true）revive 後靠它回填正文；
    // 之前這裡刪掉 opencode → 恢復出來只有殼沒有內容（天天丟記錄）。
    // opencode/上傳的清理只跟 7 天 stale sweep 與顯式 DELETE 走。
    console.log(`[gateway] reaped idle session ${id} after ${Math.round(idleMs / 1000)}s idle`)
  }
  // DB 孤兒 row 清掃：gateway 重啟後無人 reference 的持久化 row（updated_at 超過
  // 7 天）連同 upstream opencode session 與 uploads 一起回收，避免 sessions.db
  // 無限增長。7 天 >> SESSION_IDLE_TTL_MS：寧可晚刪，不誤刪可恢復的會話。
  // 永久保留默認關閉（SESSION_SWEEP_DAYS=0 → sweepRows=[]）；env>0 恢復 N 天清掃。
  const sweepRows = SESSION_SWEEP_DAYS > 0 ? sweepStaleRows(SESSION_SWEEP_DAYS * 24 * 60 * 60 * 1000) : []
  for (const stale of sweepRows) {
    if (sessions.has(stale.sessionId)) continue // 剛被 lazy reload 回來的不動
    void deleteOpencodeSession(stale.opencodeSessionId)
    const staleUploadDir = path.join(UPLOADS_DIR, stale.sessionId)
    if (existsSync(staleUploadDir)) {
      void rm(staleUploadDir, { recursive: true, force: true }).catch(() => {})
    }
    console.log(`[gateway] swept stale persisted session ${stale.sessionId}`)
  }
}, SESSION_REAP_INTERVAL_MS)

// ── R6（2026-09-10）subagent async 完成喚醒 ─────────────────────────────
// async dispatch 的子代理終態（成功/失敗皆喚）時，把結果摘要以系統消息投進
// 父會話並續 turn。輪子 = workflow 喚醒掃描器的 prompt_async 段（2026-09-01 修 3）：
// beastAgentField 帶 agent 欄＋lastPromptBody 落盤＋turn 計數重置＋watchdog 布哨。
// 冪等：finishRun 的 status 守衛保每 run 只喚一次；本函數 turn 在途（ackTimer
// 掛著）時讓位重試一次（60s），仍掛則放棄——結果留在 completed（10 分鐘 TTL）
// 可被 subagent_status 工具查詢，不重複注入。
async function wakeSessionForSubagent(
  parentState: any,
  run: { id: string; label: string; status: "ok" | "error"; summary: string; error?: string },
): Promise<void> {
  if (!parentState) {
    console.warn("[gateway] subagent wake skipped: parent session gone")
    return
  }
  const shortId = String(run.id).slice(0, 8)
  const deliver = async (state: any): Promise<void> => {
    const verdict = run.status === "ok" ? "完成" : "失败"
    const payload = run.status === "ok" ? run.summary : run.error || run.summary || "未知原因"
    const content =
      `【子代理${verdict}·系统自动唤醒】subagent ${shortId}（label="${run.label}"）已${verdict}。` +
      (run.status === "ok" ? `结果摘要：${payload}` : `失败原因：${payload}`) +
      `\n请基于以上真实结果继续推进（汇总/补派/返工），并向用户简报。若尚有其他子代理在跑，等其余唤醒到齐再汇总（可用 subagent_status 工具查询，禁止 bash sleep 轮询）。`
    const body = { ...beastAgentField(state), parts: [{ type: "text", text: content }] }
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    state.lastPromptBody = body
    state.turnGen = (state.turnGen ?? 0) + 1
    state.turnTextChars = 0
    state.turnReasoningChars = 0
    state.turnRetries = 0
    state.turnAborted = false
    state.retryQueued = false
    state.turnUpstreamError = null
    state.turnToolStarted = false
    state.watchdogRetried = false
    state.questionAnsweredThisTurn = false
    state.deathDeclared = false
    armWatchdogTimer(state)
    console.log(`[gateway] subagent wake resumed: session=${state.sessionId} sub=${shortId} status=${run.status}`)
  }
  try {
    if (parentState.ackTimer != null) {
      console.log(`[gateway] subagent wake deferred (turn in flight): session=${parentState.sessionId} sub=${shortId}`)
      await new Promise((r) => setTimeout(r, 60_000))
      const cur = resolveSession(parentState.sessionId)
      if (!cur || cur.ackTimer != null) {
        console.warn(`[gateway] subagent wake abandoned (turn still in flight): session=${parentState.sessionId} sub=${shortId}`)
        return
      }
    }
    await deliver(parentState)
  } catch (e) {
    console.error(`[gateway] subagent wake dispatch failed: session=${parentState.sessionId} sub=${shortId}:`, e)
  }
}

// 子代理运行时：复用现有 emit/lookup 管道（subagent.* 帧走 emitToSession 出口）。
initSubagent({
  emitToSession,
  resolveSession,
  findSessionByOpenCodeId,
  openCodeUrl: OPENCODE_URL,
  openCodeHeaders: opencodeHeaders,
  // 野獸模式（MOE 改革，2026-09-08）：父會話 settings.beast_mode 布林；dispatch
  // 時快照進 run，任務書頭部注入 Expert 憲法（prompt 約束；物理斷路留樁）。
  beastMode: (parentState: any) => loadUserSettings(parentState?.apiKey)?.beast_mode === true,
  // R6（2026-09-10）async 完成喚醒出口：subagent.ts finishRun 在 async run 終態時
  // 呼叫（成功與失敗皆喚）。輪子見上方 wakeSessionForSubagent（workflow 喚醒同款）。
  wakeParent: wakeSessionForSubagent,
  // 2026-08-31：子代理错误透传 + persona 模型链（与主路径同源，见 subagent.ts 头注）。
  describeError: opencodeErrorMessage,
  subagentModelChain: (parentState: any) => {
    const persona =
      normalizeUserSettings(loadUserSettings(parentState?.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
    const fallbacks = (loadAgentModelRegistry()?.bindings?.fallbacks?.[persona] ?? [])
      .map(bindingRef)
      .filter((r): r is AgentModelRef => r !== null)
    return [personaModel(parentState), ...fallbacks]
  },
})

// Single global connection to opencode's event stream, fanned out per session.
connectOpencode()

console.log(`[gateway] listening on :${server.port}, opencode=${OPENCODE_URL}`)

