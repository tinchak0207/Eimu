// types-gateway.ts — 從 index.ts 無損抽取（2026-09-19 第一階段）
// 內容：會話/確認/問題/SSE/記憶 型別（原 index.ts 95–369）＋ turn metrics 型別（原 5125–5176）

export interface PendingConfirm {
  timer: ReturnType<typeof setTimeout>
  ledger?: { amount_coins: number; task_id?: string; model?: string }
}

export interface PendingQuestion {
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
export type ConfirmOutcome = "approved" | "denied" | "expired"

export interface ResolvedConfirm {
  outcome: ConfirmOutcome
  resolvedAt: number
}

export interface SSEClient {
  controller: ReadableStreamDefaultController<Uint8Array>
}

/** 契約 §4 memory_docs 元素：AgentMemoryDoc 駝峰原樣的注入必需子集（repo 直送，欄位防呆讀取）。 */
export interface MemoryDocLite {
  id?: string
  domain?: string
  slug?: string
  description?: string
  body?: string
  [k: string]: unknown
}

export interface SessionState {
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
  //（pending = 扣住的未完成行；suppress = 正處於內部段中；fence/sawEnglish =
  // 程式碼柵欄狀態與英文壓制旗標，形狀同 outbound-sanitize 的 PartStripState）。
  // 生命週期同 partTextEmitted：session.idle 時 flush 並清空。
  partStripState: Map<string, { pending: string; suppress: boolean; fence: boolean; sawEnglish: boolean }>
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
  // ── 0918 前綴快取修復：尾端注入 payload 的去重指紋（volatile，不持久化）──
  /** 上一次注入到「該輪 user 訊息尾端」的 gateway payload 的 sha256（見
   *  handleSendMessage 的「野獸幀改附尾端」段與 appendSystemPayloadToTurnTail）。
   *  同 byte 不重貼（內容已在歷史中，資訊量不變）→ context 不再每輪固定長
   *  17.2k 字元。volatile：重啟後首輪必重貼一次；壓縮成功後清空（摘要會改寫
   *  歷史，尾端 payload 可能被排除出上下文）。 */
  lastTailPayloadHash?: string
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
  // ── 刀 2（2026-09-15）：機器 critic pass 的逃生閥掃描（皆 volatile，不持久化）──
  /** 本輪 assistant 正文的尾巴（32 字元滾動窗）：跨 chunk 邊界偵測「未經獨立審核」聲明。 */
  criticEscapeTail?: string
  /** 本輪正文已出現「未經獨立審核」自簽聲明 → 機器 critic pass 讓位（逃生閥）。 */
  criticUnreviewedDeclared?: boolean
  // 抖動重試（2026-08-22）：turn 結束但零文本輸出 = 上游模型抖動死亡的特徵，
  // gateway 自動重發同一條 prompt（上限 TURN_MAX_RETRIES）。volatile，不持久化；
  // revive 後為 undefined，讀取處一律帶 ?? 預設值。
  lastPromptBody?: { parts: { type: string; text: string }[]; system?: string; model?: { providerID: string; modelID: string } } | null
  // 修復1（2026-09-19 cn:deepseek-v4.1-flash 死鏈事故）：本輪「實際 dispatch 出去」
  // 的模型（prompt 首投與 failover/jitter 重投都更新）。volatile。降權判定必須用它——
  // lastPromptBody.model 是 turn 起點模型，failover 換模後不回寫，用舊值會把死帳戶
  // 的錯誤記到無辜 provider 頭上（事故實錘：chaozhiyuan 403 五次誤標 hublinuxdo）。
  lastDispatchedModel?: { providerID: string; modelID: string } | null
  turnGen?: number
  turnTextChars?: number
  // 罪狀2 根因修復（2026-08-29）：思維鏈字數。模型推理期間 reasoning.delta
  // 持續到達，此前不計入任何活動判定 → ack/心跳/看門狗/停滯哨在思考期誤判死寂。
  // 與 turnTextChars 同點重置；只進 turnHasActivity，不進零文本抖動重試判定。
  turnReasoningChars?: number
  // 刀 1（2026-09-19）：Jev 測謊閘餵料（volatile，與 criticEscapeTail 同款生命週期）。
  // jevBriefTail＝本輪 message.delta 累積尾段（測謊題的 brief）；jevGateSummaries＝
  // 本輪子代理喚醒摘要頭（含【交付閘門·未達標】標記的事實面）。session.idle 收盤
  // 消費後清空。
  jevBriefTail?: string
  jevGateSummaries?: string[]
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
  /** 修復2（2026-09-19）：S3① 誠實收尾冪等——記「已收尾的 turnGen」。連續兩個
   *  session.idle 都過終局門時只收尾一次（journal 成對 warn 實錘：message.delta＋
   *  turn.done 各發兩次）。存 gen 而非 boolean：跨 turn（含 resume/wake 輪）自然
   *  失效，不需各 turn 起點重置，也不會誤吞下一輪收尾。volatile。 */
  turnExhaustedClosedGen?: number
  /** 修復3a（2026-09-19）：本 turn 已發出的錯誤幀文案（humanize 後）清單——
   *  emitSessionError 同文去重用；turn 起點清空。volatile，有界＝TURN_MAX_RETRIES
   *  ＋少數非重試錯誤，設上限 32 防呆。 */
  turnEmittedErrors?: string[]
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
  /** Phase 0 觀測（2026-09-18）：本輪分段延遲計時檔。volatile，不進持久化
   *  白名單（persistence.serialize 是顯式子集，此欄不落盤）。turn.done 收檔；
   *  未收尾的檔案由 handleAbortSession 或下一輪 beginTurnMetrics 補收。 */
  turnMetrics?: TurnMetricsRecord | null
  /** 兩段式首字（2026-09-18）：本輪 turn.plan 的去重/讓位狀態。volatile，不進
   *  持久化白名單（persistence.serialize 是顯式子集，此欄不落盤）。gen = 已發起
   *  計畫的 turnGen；emittedAt = 幀實際發出的時刻（null = 還在途/已放棄）。 */
  planState?: { gen: number; emittedAt: number | null }
}
export type TurnMetricsEnd = "done" | "aborted" | "superseded"

/** 在途計時檔（volatile）。 */
export type TurnMetricsRecord = {
  sessionId: string
  gen: number
  attempt: number
  t_accept: number
  t_prompt_sent: number | null
  t_last_prompt_sent: number | null
  t_first_reasoning: number | null
  t_first_text: number | null
  t_first_tool: number | null
  /** 兩段式首字（2026-09-18）：turn.plan 幀發出時刻；null = 本輪沒發計畫。 */
  t_first_plan: number | null
  /** compaction 閘擋住本輪 prompt 的時刻；null = 沒被擋（prompt_deferred_ms=0）。 */
  deferredAt: number | null
  providerID: string | null
  modelID: string | null
  contextTokens: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

/** 收檔後的快照（journal 行 + ring 條目，同一形狀）。 */
export type TurnMetricsSnapshot = {
  session: string
  gen: number
  attempt: number
  provider: string | null
  model: string | null
  t_accept: number
  t_prompt_sent: number | null
  t_last_prompt_sent: number | null
  t_first_reasoning: number | null
  t_first_text: number | null
  t_first_tool: number | null
  t_first_plan: number | null
  t_done: number | null
  prompt_deferred_ms: number
  context_tokens: number | null
  cache_read: number | null
  cache_write: number | null
  end: TurnMetricsEnd
  /** 自 t_accept 起算的累積延遲（null = 該里程碑未觀測到）。 */
  d_prompt_ms: number | null
  d_first_reasoning_ms: number | null
  d_first_text_ms: number | null
  d_first_tool_ms: number | null
  d_first_plan_ms: number | null
  d_total_ms: number | null
}
