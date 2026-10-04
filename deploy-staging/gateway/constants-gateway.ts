// constants-gateway.ts — 从 index.ts 无损抽取（2026-09-19 第一阶段）
// 内容：turn 重试/ack/plan/看门狗/心跳/停滞/质询时序与 env（原 371–518）
//  ＋ 杂项常量/白名单 Set/目录路径（原 727–775）

import path from "node:path"

// 抖动重试参数：免费上游模型约三至四成 turn 异常早死（finish=unknown、零文本）。
// 2026-09-21 暴君裁定：重试预算 4→10——重试期间只播「重试中 (x/N)」进度行、丑错帧
// 不外泄，多换几条线对用户只是进度数字，把「一次事故就吐错误原文」换成「尽量救活」。
export const TURN_MAX_RETRIES = Number.parseInt(process.env.TURN_MAX_RETRIES || "10", 10) || 10
export const TURN_RETRY_DELAY_MS = Number.parseInt(process.env.TURN_RETRY_DELAY_MS || "1500", 10) || 1500
// ── P2b（2026-09-11）刀2：空转止损 ────────────────────────────────
// 连续 N 个「空 step」（该 step 期间无 tool part、无非空正文 text part、
// reasoning 文字空/全空白）视为模型空转：中止本 turn 并同一轮补一次动作
// 导向重发（仅一次，不循环）。出现 tool/非空正文/非空 reasoning/turn 结束
// → 计数归零。
export const IDLE_STEP_ABORT_THRESHOLD = 3
export const IDLE_STEP_NUDGE =
  "\n\n（系统提示：上一次生成空转被中止。请立刻发出工具调用开始动作，不要再展开推理。）"
// S6 规格2：用户消息 ack 上限。R4 实测 30s 档 ack 落地 33-40s+（timer 30s 起
// 算于 prompt_async 投递后，再叠加投递/事件转译延迟）——压到 15s，保证含
// 链路延迟也在 30s 线内。环境变量可覆盖。
export const ACK_DELAY_MS = Number.parseInt(process.env.ACK_DELAY_MS || "15000", 10) || 15_000
// ── 两段式首字（2026-09-18）：turn.plan 帧 ──────────────────────────────
// 病灶（实测）：重型 turn 首行「可见正文」在 +108.8s，小 session d_first_text_ms
// 3,596–19,388ms——使用者开场干等。实测可行：从 gateway 直连 provider 打
// /chat/completions，带 registry digest（1,943 字），首个 content token
// 1,304–1,420ms、完整一行计画 1,620–1,950ms，并发 4 路无退化。
// 契约取舍：纯文字「一行」契约（实测 reasoning_chars=0、首 content 1.3s）；
// 不要用 JSON 契约（会先出 reasoning，首 content 落到 1,865–2,547ms，慢 0.8–1.1s）。
// 路径取舍：opencode/* 路径多 ~3s 固定开销 → 走直连 provider，不经 opencode。
// 计费红线：ledger 只在 emitImageDone / emitVideoDone / emitAudioDone /
// recordWorkflowRefund / emitImageFailed / confirm-approved 六处写入，文字回合
// 零 ledger 写入 → 本调用不重复扣费。**若未来新增「按 token 对用户计费」，
// 该机制必须显式排除 turn.plan**（此处是一次不进模型上下文的旁路 LLM 调用）。
export const TURN_PLAN_ENABLED = process.env.TURN_PLAN_ENABLED !== "0"
// 逾时预算（2026-09-18 在 VPS 上以 Bun fetch 实测定案）：关闭思考后
// first_content 1,271ms／total 1,589ms，但**冷连线的 headers 单独就要 3,197ms**，
// 故给 4s 余裕而非贴著 1.6s 卡死。旧值 2500 的后果实锤：三名候选全部 timeout
// （hublinuxdo/a6api timeout、chaozhiyuan 403），计画段整天零输出。
export const TURN_PLAN_TIMEOUT_MS = Number.parseInt(process.env.TURN_PLAN_TIMEOUT_MS || "4000", 10) || 4_000
// 输出上限（同日实测定案）：旧值 160 会被 reasoning 吃光 → 串流跑完 chars=0、
// 整个计画段静默失效（实锤 `chars=0`）。600 留足 reasoning 残量。
export const TURN_PLAN_MAX_TOKENS = Number.parseInt(process.env.TURN_PLAN_MAX_TOKENS || "600", 10) || 600
// 关闭思考（同日实测定案）：同一模型、同一 prompt、同样 max_tokens=600 下
//   reasoning_effort:"none"   → first_content 1,271ms、reasoning 0 字   ← 采用
//   不加参数                  → first_content 2,186ms、reasoning 0 字
//   enable_thinking:false     → first_content 4,195ms、reasoning 354 字
//   /no_think 前缀            → first_content 9,355ms
//   thinking:{type:disabled}  → first_content 7,749ms、reasoning 1,749 字（更慢，勿用）
// 即「关掉思考」不是为了省 token，是为了把首字从 2.2s 拉到 1.3s。上游多为 OpenAI
// 相容 relay，未知栏位一律忽略；设 0 可关（给严格校验的上游当退路）。
export const TURN_PLAN_DISABLE_THINKING = process.env.TURN_PLAN_DISABLE_THINKING !== "0"
export const TURN_PLAN_MAX_CHARS = 160
// 候选链上限（2026-09-18）：这一跳是全链最延迟敏感的一段，而上游任一渠道
// 403/422/超时都会让整个计画段静默失效。实锤：当日 persona 主模型多次 403、
// registry fallbacks 内两家 422/503，计画段整天零输出而日志只有一句 skipped。
// 并发打 N 条取最快成功者＝把上游 churn 由后端吸收，且延迟取候选中的最小值。
// 候选来源＝plan_model → persona → default，续以 plan_fallbacks（选配）→ 该
// persona 的 fallbacks。env 可覆写。
export const TURN_PLAN_MAX_CANDIDATES = Number.parseInt(process.env.TURN_PLAN_MAX_CANDIDATES || "3", 10) || 3
// 实测出来的最优契约，逐字照用（勿改写：加栏位/换格式都会让首 content 变慢）。
export const TURN_PLAN_SYSTEM_HEAD =
  "你是执行规划器。根据下列 Expert 注册表，为用户请求写一段给用户看的中文计划。\n" +
  "只输出一行，格式：打算这么做：<做什么>（先派 <expert id>）。\n" +
  "禁止输出任何思考、分析过程、前言或 markdown 围栏。总长不超过 60 字。\n\n"
// R2-A 看门狗：prompt_async 送达后 TURN_WATCHDOG_MS 内无 tool.invoke 且无
// message.delta = turn 没启动（评测：295s 零帧）。先诚实告警再自动重投一次；
// 再等一轮仍无动静则判会话损坏，建议新开。环境变量可覆盖（CI 可调短）。
export const TURN_WATCHDOG_MS = Number.parseInt(process.env.TURN_WATCHDOG_MS || "90000", 10) || 90_000
// R4-A S3①：上游错误（session.error 非 tool_error）后的停滞看门狗。R4 实锤：
// compaction+APIError "Input token exceed" 后 turn 空转 5 分钟零告警——启动
// 看门狗因 turn 已有动静（turnHasActivity）静默退出，覆盖不到「中途死亡」。
// 错误发生 90s 内 turn 未收尾且无进度 → 告警 + 依抖动重试兜底；再 90s 仍停滞
// → 明确收尾话术 + turn.done。环境变量可覆盖。
export const TURN_ERROR_WATCHDOG_MS = Number.parseInt(process.env.TURN_ERROR_WATCHDOG_MS || "90000", 10) || 90_000
// N1 规格1：心跳提示延迟——turn 开始后 HEARTBEAT_DELAY_MS 仍无任何
// message.delta 也无 tool.invoke（模型连字都没吐）时补一条「仍在等待模型响应」。
// 与 S6 ack（30s「收到，正在处理」）错峰：ack 已发则心跳顺延到 45s；每 turn
// 最多 1 条，不刷屏。watchdog（90s）之前的中段窗口由这条填补。
export const HEARTBEAT_DELAY_MS = Number.parseInt(process.env.HEARTBEAT_DELAY_MS || "30000", 10) || 30_000
export const HEARTBEAT_DELAY_AFTER_ACK_MS = Number.parseInt(process.env.HEARTBEAT_DELAY_AFTER_ACK_MS || "45000", 10) || 45_000
// R5-C（2026-08-28）中段停滞哨：turn 已启动（有过 tool/正文活动）之后，
// MIDTURN_STALL_MS 内零任何新帧（连进度帧都没有）= 中段冻结。诚实告警 +
// 防风暴单次重投（复用 watchdogRetried 模式）；重投后仍零帧 → 如实收尾 +
// turn.done。时间戳 turnLastFrameAt 由 emitToSession 全量刷新——长工具执行
// 只要有任何帧（tool.result/canvas/文本）就不误杀，只咬连帧都没有的冻结。
export const MIDTURN_STALL_MS = Number.parseInt(process.env.MIDTURN_STALL_MS || "90000", 10) || 90_000
// R8-B 工单 #3（2026-08-29）：question pending 心跳周期——pending 期间每 30s
// 一帧用户可见心跳（R8 实锤：question 卡后 129s 零帧死寂）。
export const QUESTION_HEARTBEAT_MS = Number.parseInt(process.env.QUESTION_HEARTBEAT_MS || "30000", 10) || 30_000
// 片AJ（2026-09-07）：question 卡 3 分钟无人回覆 → 按推荐方案（各题第一选项）代答继续，
// 答覆文案标注 assumed——无人值守跑批不再挂死（T4 实锤 question 卡挂死 15+ 分钟）。
export const QUESTION_ASSUME_MS = Number.parseInt(process.env.QUESTION_ASSUME_MS || "180000", 10) || 180_000

export const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "")
export const OPENCODE_PASSWORD = process.env.OPENCODE_PASSWORD || ""
export const PORT = Number.parseInt(process.env.GATEWAY_PORT || "8081", 10) || 8081
export const PLATFORM_BASE = (process.env.PLATFORM_BASE || "https://image.tinchak0207.xyz").replace(/\/+$/, "")
export const QUOTA_URL = process.env.QUOTA_URL || `${PLATFORM_BASE}/v1/quota`
// ── 全局记忆 env（契约 §8 八条，默认值照表）──────────────────────────────
// 语义解析（envBool/envInt）与 memory-batch.ts 内部保持一致，避免两侧漂移。
export function memoryEnvBool(raw: string | undefined, fallback: boolean): boolean {
  const v = String(raw ?? "").trim().toLowerCase()
  if (v === "") return fallback
  return v === "1" || v === "true" || v === "yes" || v === "on"
}
// HMAC 密钥（§8 必填侧 VPS；缺失时批次拒绝送出、召回拉取 fail-fast，诚实报错不裸奔）。
export const MEMORY_INGEST_SECRET = process.env.MEMORY_INGEST_SECRET || ""
// 批次总开关（§8 默认 false：先验通再接；false 时 ticker 不触发，手动跑只准 dry_run）。
export const MEMORY_BATCH_ENABLED = memoryEnvBool(process.env.MEMORY_BATCH_ENABLED, false)
// 批次触发时（UTC 小时；§8 默认 20 = UTC+8 04:00）。
export const MEMORY_BATCH_HOUR_UTC = (() => {
  const n = Number.parseInt(process.env.MEMORY_BATCH_HOUR_UTC ?? "20", 10)
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 20
})()
// 共享库总开关（§8 默认 true；false → 共享目录零注入、召回零读、召回路由零命中）。
export const MEMORY_SHARED_ENABLED = memoryEnvBool(process.env.MEMORY_SHARED_ENABLED, true)
// 召回门槛与开关（§7/§8）。
export const MEMORY_RECALL_MIN_SCORE = (() => {
  const n = Number.parseFloat(process.env.MEMORY_RECALL_MIN_SCORE ?? "1.0")
  return Number.isFinite(n) ? n : 1.0
})()
export const MEMORY_RECALL_ENABLED = memoryEnvBool(process.env.MEMORY_RECALL_ENABLED, true)
// 0918 前缀快取修复：尾端注入 payload 的同 byte 去重开关。默认 ON（不重贴）；
// SYSTEM_PAYLOAD_TAIL_DEDUPE=0 时每轮照旧重贴（回退钮，行为回到「每轮都在」）。
export const SYSTEM_PAYLOAD_TAIL_DEDUPE = process.env.SYSTEM_PAYLOAD_TAIL_DEDUPE !== "0"
// G8 verifier 与 PRD §5.6 oracle 抽检模型（`provider/model`，契约 §5「换模型」；
// §8 之外的 P1-1 新增 env）。未配置＝该闸跳过，批次报告诚实记 g8_skipped／sampling.skipped。
export const MEMORY_VERIFIER_MODEL = (process.env.MEMORY_VERIFIER_MODEL || "").trim()
export const MEMORY_ORACLE_MODEL = (process.env.MEMORY_ORACLE_MODEL || "").trim()
// 【契约外新增】批次/召回打 Vercel repo 端点（/api/agent/memory/*）的前缀。契约 §8 没有
// 这条（§3 端点只在 repo 侧定义）；默认值与 PLATFORM_BASE 同构，属本片新增接线参数。
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
// S4（2026-08-27）计费确认门槛改金额维度：估算总价 ≥ 此币数的批量执行
//（workflow generate）必须先过 confirm.request 批准；低于门槛免扰自动跑。
// 旧门槛「单笔工具 >0.1 币就弹卡」由工具层自带（image_* 工具），门槛倒挂
//（6.25 币批量零确认、1 币重试反而弹卡）正是两套门槛各管一段造成——
// 统一基准：估算金额。env CONFIRM_THRESHOLD_COINS 可覆盖。
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
// 2026-09-12 永久保留改造：默认 TTL 从 30 分钟放宽到 30 天。reap（keepRow=true）只清内存、
// 不删数据也不再发 session.closed（见 teardownSession）；正常使用周期内会话基本不会被 reap，
// 内存热度回收能力保留。env 为逃生口（毫秒）。
export const SESSION_IDLE_TTL_MS = Number.parseInt(process.env.SESSION_IDLE_TTL_MS || "2592000000", 10) || 2_592_000_000
// 2026-09-12 永久保留：7 天 stale sweep（删 DB row + opencode 会话 + uploads）默认关闭。
// 未设/0 = 永不删；>0 恢复旧的「N 天未更新即连根删」能力（env 逃生口）。
export const SESSION_SWEEP_DAYS = Number.parseInt(process.env.SESSION_SWEEP_DAYS || "0", 10) || 0
export const SESSION_REAP_INTERVAL_MS = 60_000
export const LEDGER_PATH = process.env.LEDGER_PATH || "/opt/agent-harness/ledger.jsonl"
// 画布事件白名单：opencode canvas_* 工具透过 emitEvent 推送的画布动作/成果事件。
// 这组事件由前端 reducer 接住，驱动画布渲染（建节点/连线/显示图片/预算）。
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

// 2026-10-02 补齐遗漏：audio.done 与 video.done 同类事件、同一条内部路由，本就该并列放行——
// 此前不在白名单＝遗漏（opencode 工具链 emitEvent 端已放行 audio.done，网关这头不放行会让
// 工具推的事件在路由层被 400 丢弃＝no-op）。非新增攻击面：/internal/emit 只绑 127.0.0.1:8081
// 内网（VPS ufw 8081/tcp ALLOW 172.16.0.0/12，非公网可达）。
export const INTERNAL_EMIT_ALLOWED = new Set(["image.done", "video.done", "audio.done", "image.failed", "session.error", "quota.changed", "tool.result", "tool.progress"])

export const WORKSPACE_DIR = "/opt/agent-harness/workspace"
export const UPLOADS_DIR = path.join(WORKSPACE_DIR, "uploads")
// TTS 音频落盘与对外 URL 基址：文件存 gateway 本地静态目录，
// 公网走 nginx 已有的 /agent/ 反代（store.tinchak0207.xyz/agent/* → 本网关）。
export const TTS_AUDIO_DIR = path.join(WORKSPACE_DIR, "tts-audio")
export const TTS_PUBLIC_BASE = (process.env.TTS_PUBLIC_BASE || "https://store.tinchak0207.xyz/agent/v1/audio").replace(/\/+$/, "")
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024 // 4MB per file
export const VIDEO_UPLOAD_MAX_BYTES = 100 * 1024 * 1024 // 100MB per file（浏览器原片直传）
export const VIDEO_UPLOAD_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v"])
export const ALLOWED_UPLOAD_EXTS = new Set([
  ".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".json",
  ".csv", ".xml", ".yaml", ".yml", ".png", ".jpg", ".jpeg",
  ".webp", ".gif", ".mp4", ".mov", ".m4v", ".webm", ".zip",
  // 音频附件（本地参考素材：翻唱 source_audio 等）。与 two-phase-upload.ts 的
  // ALLOWED_UPLOAD_CONTENT_TYPES（audio/mpeg|wav|mp4|aac）对齐，另补 flac/ogg
  // （contentTypeForExt 本就有对应 mime）。只增音频，不放宽其他型别。
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
])
