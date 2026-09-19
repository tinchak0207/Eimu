// constants-gateway.ts — 從 index.ts 無損抽取（2026-09-19 第一階段）
// 內容：turn 重試/ack/plan/看門狗/心跳/停滯/質詢時序與 env（原 371–518）
//  ＋ 雜項常量/白名單 Set/目錄路徑（原 727–775）

import path from "node:path"

// 抖動重試參數：免費上游模型約三至四成 turn 異常早死（finish=unknown、零文本）。
export const TURN_MAX_RETRIES = Number.parseInt(process.env.TURN_MAX_RETRIES || "4", 10) || 4
export const TURN_RETRY_DELAY_MS = Number.parseInt(process.env.TURN_RETRY_DELAY_MS || "1500", 10) || 1500
// ── P2b（2026-09-11）刀2：空轉止損 ────────────────────────────────
// 連續 N 個「空 step」（該 step 期間無 tool part、無非空正文 text part、
// reasoning 文字空/全空白）視為模型空轉：中止本 turn 並同一輪補一次動作
// 導向重發（僅一次，不循環）。出現 tool/非空正文/非空 reasoning/turn 結束
// → 計數歸零。
export const IDLE_STEP_ABORT_THRESHOLD = 3
export const IDLE_STEP_NUDGE =
  "\n\n（系统提示：上一次生成空转被中止。请立刻发出工具调用开始动作，不要再展开推理。）"
// S6 規格2：用戶消息 ack 上限。R4 實測 30s 檔 ack 落地 33-40s+（timer 30s 起
// 算於 prompt_async 投遞後，再疊加投遞/事件轉譯延遲）——壓到 15s，保證含
// 鏈路延遲也在 30s 線內。環境變量可覆蓋。
export const ACK_DELAY_MS = Number.parseInt(process.env.ACK_DELAY_MS || "15000", 10) || 15_000
// ── 兩段式首字（2026-09-18）：turn.plan 幀 ──────────────────────────────
// 病灶（實測）：重型 turn 首行「可見正文」在 +108.8s，小 session d_first_text_ms
// 3,596–19,388ms——使用者開場乾等。實測可行：從 gateway 直連 provider 打
// /chat/completions，帶 registry digest（1,943 字），首個 content token
// 1,304–1,420ms、完整一行計畫 1,620–1,950ms，併發 4 路無退化。
// 契約取捨：純文字「一行」契約（實測 reasoning_chars=0、首 content 1.3s）；
// 不要用 JSON 契約（會先出 reasoning，首 content 落到 1,865–2,547ms，慢 0.8–1.1s）。
// 路徑取捨：opencode/* 路徑多 ~3s 固定開銷 → 走直連 provider，不經 opencode。
// 計費紅線：ledger 只在 emitImageDone / emitVideoDone / emitAudioDone /
// recordWorkflowRefund / emitImageFailed / confirm-approved 六處寫入，文字回合
// 零 ledger 寫入 → 本調用不重複扣費。**若未來新增「按 token 對用戶計費」，
// 該機制必須顯式排除 turn.plan**（此處是一次不進模型上下文的旁路 LLM 調用）。
export const TURN_PLAN_ENABLED = process.env.TURN_PLAN_ENABLED !== "0"
// 逾時預算（2026-09-18 在 VPS 上以 Bun fetch 實測定案）：關閉思考後
// first_content 1,271ms／total 1,589ms，但**冷連線的 headers 單獨就要 3,197ms**，
// 故給 4s 餘裕而非貼著 1.6s 卡死。舊值 2500 的後果實錘：三名候選全部 timeout
// （hublinuxdo/a6api timeout、chaozhiyuan 403），計畫段整天零輸出。
export const TURN_PLAN_TIMEOUT_MS = Number.parseInt(process.env.TURN_PLAN_TIMEOUT_MS || "4000", 10) || 4_000
// 輸出上限（同日實測定案）：舊值 160 會被 reasoning 吃光 → 串流跑完 chars=0、
// 整個計畫段靜默失效（實錘 `chars=0`）。600 留足 reasoning 殘量。
export const TURN_PLAN_MAX_TOKENS = Number.parseInt(process.env.TURN_PLAN_MAX_TOKENS || "600", 10) || 600
// 關閉思考（同日實測定案）：同一模型、同一 prompt、同樣 max_tokens=600 下
//   reasoning_effort:"none"   → first_content 1,271ms、reasoning 0 字   ← 採用
//   不加參數                  → first_content 2,186ms、reasoning 0 字
//   enable_thinking:false     → first_content 4,195ms、reasoning 354 字
//   /no_think 前綴            → first_content 9,355ms
//   thinking:{type:disabled}  → first_content 7,749ms、reasoning 1,749 字（更慢，勿用）
// 即「關掉思考」不是為了省 token，是為了把首字從 2.2s 拉到 1.3s。上游多為 OpenAI
// 相容 relay，未知欄位一律忽略；設 0 可關（給嚴格校驗的上游當退路）。
export const TURN_PLAN_DISABLE_THINKING = process.env.TURN_PLAN_DISABLE_THINKING !== "0"
export const TURN_PLAN_MAX_CHARS = 160
// 候選鏈上限（2026-09-18）：這一跳是全鏈最延遲敏感的一段，而上游任一渠道
// 403/422/超時都會讓整個計畫段靜默失效。實錘：當日 persona 主模型多次 403、
// registry fallbacks 內兩家 422/503，計畫段整天零輸出而日誌只有一句 skipped。
// 併發打 N 條取最快成功者＝把上游 churn 由後端吸收，且延遲取候選中的最小值。
// 候選來源＝plan_model → persona → default，續以 plan_fallbacks（選配）→ 該
// persona 的 fallbacks。env 可覆寫。
export const TURN_PLAN_MAX_CANDIDATES = Number.parseInt(process.env.TURN_PLAN_MAX_CANDIDATES || "3", 10) || 3
// 實測出來的最優契約，逐字照用（勿改寫：加欄位/換格式都會讓首 content 變慢）。
export const TURN_PLAN_SYSTEM_HEAD =
  "你是执行规划器。根据下列 Expert 注册表，为用户请求写一段给用户看的中文计划。\n" +
  "只输出一行，格式：打算这么做：<做什么>（先派 <expert id>）。\n" +
  "禁止输出任何思考、分析过程、前言或 markdown 围栏。总长不超过 60 字。\n\n"
// R2-A 看門狗：prompt_async 送達後 TURN_WATCHDOG_MS 內無 tool.invoke 且無
// message.delta = turn 沒啟動（評測：295s 零幀）。先誠實告警再自動重投一次；
// 再等一輪仍無動靜則判會話損壞，建議新開。環境變量可覆蓋（CI 可調短）。
export const TURN_WATCHDOG_MS = Number.parseInt(process.env.TURN_WATCHDOG_MS || "90000", 10) || 90_000
// R4-A S3①：上游錯誤（session.error 非 tool_error）後的停滯看門狗。R4 實錘：
// compaction+APIError "Input token exceed" 後 turn 空轉 5 分鐘零告警——啟動
// 看門狗因 turn 已有動靜（turnHasActivity）靜默退出，覆蓋不到「中途死亡」。
// 錯誤發生 90s 內 turn 未收尾且無進度 → 告警 + 依抖動重試兜底；再 90s 仍停滯
// → 明確收尾話術 + turn.done。環境變量可覆蓋。
export const TURN_ERROR_WATCHDOG_MS = Number.parseInt(process.env.TURN_ERROR_WATCHDOG_MS || "90000", 10) || 90_000
// N1 規格1：心跳提示延遲——turn 開始後 HEARTBEAT_DELAY_MS 仍無任何
// message.delta 也無 tool.invoke（模型連字都沒吐）時補一條「仍在等待模型响应」。
// 與 S6 ack（30s「收到，正在处理」）錯峰：ack 已發則心跳順延到 45s；每 turn
// 最多 1 條，不刷屏。watchdog（90s）之前的中段窗口由這條填補。
export const HEARTBEAT_DELAY_MS = Number.parseInt(process.env.HEARTBEAT_DELAY_MS || "30000", 10) || 30_000
export const HEARTBEAT_DELAY_AFTER_ACK_MS = Number.parseInt(process.env.HEARTBEAT_DELAY_AFTER_ACK_MS || "45000", 10) || 45_000
// R5-C（2026-08-28）中段停滯哨：turn 已啟動（有過 tool/正文活動）之後，
// MIDTURN_STALL_MS 內零任何新幀（連進度幀都沒有）= 中段凍結。誠實告警 +
// 防風暴單次重投（復用 watchdogRetried 模式）；重投後仍零幀 → 如實收尾 +
// turn.done。時間戳 turnLastFrameAt 由 emitToSession 全量刷新——長工具執行
// 只要有任何幀（tool.result/canvas/文本）就不誤殺，只咬連幀都沒有的凍結。
export const MIDTURN_STALL_MS = Number.parseInt(process.env.MIDTURN_STALL_MS || "90000", 10) || 90_000
// R8-B 工單 #3（2026-08-29）：question pending 心跳週期——pending 期間每 30s
// 一幀用戶可見心跳（R8 實錘：question 卡後 129s 零幀死寂）。
export const QUESTION_HEARTBEAT_MS = Number.parseInt(process.env.QUESTION_HEARTBEAT_MS || "30000", 10) || 30_000
// 片AJ（2026-09-07）：question 卡 3 分鐘無人回覆 → 按推薦方案（各題第一選項）代答繼續，
// 答覆文案標注 assumed——無人值守跑批不再掛死（T4 實錘 question 卡挂死 15+ 分鐘）。
export const QUESTION_ASSUME_MS = Number.parseInt(process.env.QUESTION_ASSUME_MS || "180000", 10) || 180_000
// R8-B 工單 #5：中段靜默通知閾值——turn 進行中 >45s 無正文（message.delta）
// 補一幀用戶可見進度，此後每 45s 續發。與 R5-C 中段停滯哨（90s 零「任何」幀）
// 並存：停滯哨管「全幀死亡」，本通知管「模型活著但用戶看不見」（長推理段）。
export const QUIET_NOTICE_MS = Number.parseInt(process.env.QUIET_NOTICE_MS || "45000", 10) || 45_000

export const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "")
export const OPENCODE_PASSWORD = process.env.OPENCODE_PASSWORD || ""
export const PORT = Number.parseInt(process.env.GATEWAY_PORT || "8081", 10) || 8081
export const PLATFORM_BASE = (process.env.PLATFORM_BASE || "https://image.tinchak0207.xyz").replace(/\/+$/, "")
export const QUOTA_URL = process.env.QUOTA_URL || `${PLATFORM_BASE}/v1/quota`
// ── 全局記憶 env（契約 §8 八條，默認值照表）──────────────────────────────
// 語義解析（envBool/envInt）與 memory-batch.ts 內部保持一致，避免兩側漂移。
export function memoryEnvBool(raw: string | undefined, fallback: boolean): boolean {
  const v = String(raw ?? "").trim().toLowerCase()
  if (v === "") return fallback
  return v === "1" || v === "true" || v === "yes" || v === "on"
}
// HMAC 密鑰（§8 必填側 VPS；缺失時批次拒絕送出、召回拉取 fail-fast，誠實報錯不裸奔）。
export const MEMORY_INGEST_SECRET = process.env.MEMORY_INGEST_SECRET || ""
// 批次總開關（§8 默認 false：先驗通再接；false 時 ticker 不觸發，手動跑只准 dry_run）。
export const MEMORY_BATCH_ENABLED = memoryEnvBool(process.env.MEMORY_BATCH_ENABLED, false)
// 批次觸發時（UTC 小時；§8 默認 20 = UTC+8 04:00）。
export const MEMORY_BATCH_HOUR_UTC = (() => {
  const n = Number.parseInt(process.env.MEMORY_BATCH_HOUR_UTC ?? "20", 10)
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 20
})()
// 共享庫總開關（§8 默認 true；false → 共享目錄零注入、召回零讀、召回路由零命中）。
export const MEMORY_SHARED_ENABLED = memoryEnvBool(process.env.MEMORY_SHARED_ENABLED, true)
// 召回門檻與開關（§7/§8）。
export const MEMORY_RECALL_MIN_SCORE = (() => {
  const n = Number.parseFloat(process.env.MEMORY_RECALL_MIN_SCORE ?? "1.0")
  return Number.isFinite(n) ? n : 1.0
})()
export const MEMORY_RECALL_ENABLED = memoryEnvBool(process.env.MEMORY_RECALL_ENABLED, true)
// 0918 前綴快取修復：尾端注入 payload 的同 byte 去重開關。默認 ON（不重貼）；
// SYSTEM_PAYLOAD_TAIL_DEDUPE=0 時每輪照舊重貼（回退鈕，行為回到「每輪都在」）。
export const SYSTEM_PAYLOAD_TAIL_DEDUPE = process.env.SYSTEM_PAYLOAD_TAIL_DEDUPE !== "0"
// G8 verifier 與 PRD §5.6 oracle 抽檢模型（`provider/model`，契約 §5「換模型」；
// §8 之外的 P1-1 新增 env）。未配置＝該閘跳過，批次報告誠實記 g8_skipped／sampling.skipped。
export const MEMORY_VERIFIER_MODEL = (process.env.MEMORY_VERIFIER_MODEL || "").trim()
export const MEMORY_ORACLE_MODEL = (process.env.MEMORY_ORACLE_MODEL || "").trim()
// 【契約外新增】批次/召回打 Vercel repo 端點（/api/agent/memory/*）的前綴。契約 §8 沒有
// 這條（§3 端點只在 repo 側定義）；默認值與 PLATFORM_BASE 同構，屬本片新增接線參數。
export const MEMORY_INGEST_BASE_URL = (process.env.MEMORY_INGEST_BASE_URL || "https://image.tinchak0207.xyz").replace(/\/+$/, "")
// How long a spend confirmation stays answerable. 15 minutes, not 90 seconds:
// the user may be reading the parameter card, checking their balance, or simply
// away from the tab, and a spend prompt that silently expires under them is
// worse than one that waits. This is NO LONGER bounded by the HTTP layer —
// /internal/confirm-request returns immediately and the tool polls, precisely
// because a request cannot block this long (Bun's idleTimeout maxes at 255s
// and the caller aborts at 150s).
export const CONFIRM_TIMEOUT_MS = Number.parseInt(process.env.CONFIRM_TIMEOUT_MS || "900000", 10) || 900_000
// Keep answered confirmations addressable well past the poll interval so a
// poller that ticks right after resolution still reads the real outcome.
export const CONFIRM_RESOLVED_TTL_MS = 5 * 60 * 1000
export const CONFIRM_RESOLVED_CAP = 200
// S4（2026-08-27）計費確認門檻改金額維度：估算總價 ≥ 此幣數的批量執行
//（workflow generate）必須先過 confirm.request 批准；低於門檻免擾自動跑。
// 舊門檻「單筆工具 >0.1 幣就彈卡」由工具層自帶（image_* 工具），門檻倒掛
//（6.25 幣批量零確認、1 幣重試反而彈卡）正是兩套門檻各管一段造成——
// 統一基準：估算金額。env CONFIRM_THRESHOLD_COINS 可覆蓋。
export const CONFIRM_THRESHOLD_COINS = Number.parseFloat(process.env.CONFIRM_THRESHOLD_COINS || "5") || 5
export const KEY_CACHE_TTL_MS = 5 * 60 * 1000
export const HEARTBEAT_INTERVAL_MS = 20_000
export const REPLAY_BUFFER_SIZE = 1000
export const IMAGE_URL_DEDUP_CAP = 100
export const PART_TEXT_TRACK_CAP = 200
export const TOOL_STATUS_DEDUP_CAP = 500
export const STEP_COST_LOG_CAP = 1000
export const MESSAGE_ROLE_CAP = 400
export const SUPPRESSED_PART_CAP = 500
// Reaper thresholds. A session with no SSE clients and no activity for this
// long is assumed abandoned (closed tab / lost network) and freed.
// 2026-09-12 永久保留改造：默認 TTL 從 30 分鐘放寬到 30 天。reap（keepRow=true）只清內存、
// 不刪數據也不再發 session.closed（見 teardownSession）；正常使用週期內會話基本不會被 reap，
// 內存熱度回收能力保留。env 為逃生口（毫秒）。
export const SESSION_IDLE_TTL_MS = Number.parseInt(process.env.SESSION_IDLE_TTL_MS || "2592000000", 10) || 2_592_000_000
// 2026-09-12 永久保留：7 天 stale sweep（刪 DB row + opencode 會話 + uploads）默認關閉。
// 未設/0 = 永不刪；>0 恢復舊的「N 天未更新即連根刪」能力（env 逃生口）。
export const SESSION_SWEEP_DAYS = Number.parseInt(process.env.SESSION_SWEEP_DAYS || "0", 10) || 0
export const SESSION_REAP_INTERVAL_MS = 60_000
export const LEDGER_PATH = process.env.LEDGER_PATH || "/opt/agent-harness/ledger.jsonl"
// 畫布事件白名單：opencode canvas_* 工具透過 emitEvent 推送的畫布動作/成果事件。
// 這組事件由前端 reducer 接住，驅動畫布渲染（建節點/連線/顯示圖片/預算）。
export const CANVAS_EMIT_ALLOWED = new Set([
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.deleted",
  "canvas.node.generating",
  "canvas.derive.started",
  "canvas.budget.updated",
])

export const INTERNAL_EMIT_ALLOWED = new Set(["image.done", "video.done", "image.failed", "session.error", "quota.changed", "tool.result", "tool.progress"])

export const WORKSPACE_DIR = "/opt/agent-harness/workspace"
export const UPLOADS_DIR = path.join(WORKSPACE_DIR, "uploads")
// TTS 音頻落盤與對外 URL 基址：文件存 gateway 本地靜態目錄，
// 公網走 nginx 已有的 /agent/ 反代（store.tinchak0207.xyz/agent/* → 本網關）。
export const TTS_AUDIO_DIR = path.join(WORKSPACE_DIR, "tts-audio")
export const TTS_PUBLIC_BASE = (process.env.TTS_PUBLIC_BASE || "https://store.tinchak0207.xyz/agent/v1/audio").replace(/\/+$/, "")
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024 // 4MB per file
export const VIDEO_UPLOAD_MAX_BYTES = 100 * 1024 * 1024 // 100MB per file（瀏覽器原片直傳）
export const VIDEO_UPLOAD_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v"])
export const ALLOWED_UPLOAD_EXTS = new Set([
  ".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".json",
  ".csv", ".xml", ".yaml", ".yml", ".png", ".jpg", ".jpeg",
  ".webp", ".gif", ".mp4", ".mov", ".m4v", ".webm", ".zip",
])
