// types-gateway.ts — 从 index.ts 无损抽取（2026-09-19 第一阶段）
// 内容：会话/确认/问题/SSE/记忆 型别（原 index.ts 95–369）＋ turn metrics 型别（原 5125–5176）
import type { PendingSteer } from "./steer-core.ts"

/** prompt_async 的 content part：文字（type:"text"）或档案（type:"file"）。
 *  2026-10-02 图片入上下文：image/* 以 file part 带 data: URL 进同一请求；
 *  文字成员刻意写成 `{ type: string; text: string }`（非字面量 "text"），
 *  让既有只会产文字 part 的呼叫端与测试型别继续可赋值。 */
export type GatewayPromptPart =
  | { type: string; text: string }
  | { type: "file"; mime: string; filename: string; url: string }

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

/** 契约 §4 memory_docs 元素：AgentMemoryDoc 驼峰原样的注入必需子集（repo 直送，栏位防呆读取）。 */
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
  // 2026-10-02：每会话的网关权威 nonce（12 位 hex）。由 messages-gw.ensureGatewayNonce
  // 惰性产生／校验（!gwNonce 或格式不符即重生成），用于 authorityRule 与
  // TAIL_PAYLOAD_MARKER⟦gw:…⟧——故为可选（未产生前 undefined）。
  gwNonce?: string
  clients: Set<SSEClient>
  pendingConfirms: Map<string, PendingConfirm>
  pendingQuestions: Map<string, PendingQuestion>
  resolvedConfirms: Map<string, ResolvedConfirm>
  eventCounter: number
  replayBuffer: { id: number; frame: Uint8Array; strippable?: boolean }[]
  // Touched by every lookup and every emitted event; drives the idle reaper.
  lastActivityAt: number
  // Per-session translation state for the /event fan-out. All bounded below.
  partTextEmitted: Map<string, { emittedLen: number }>
  // S2b（2026-08-27）：出站文本内部框架段剥离器的逐 part 状态
  //（pending = 扣住的未完成行；suppress = 正处于内部段中；fence/sawEnglish =
  // 程式码栅栏状态与英文压制旗标，形状同 outbound-sanitize 的 PartStripState）。
  // 生命周期同 partTextEmitted：session.idle 时 flush 并清空。
  // 2026-10-04 W：原 t2s（用户书写体决定是否繁→简）已随书写体镜像家族拆除——出口一律简体。
  partStripState: Map<string, { pending: string; suppress: boolean; fence: boolean; sawEnglish: boolean }>
  announcedUrls: Set<string>
  toolStatusSeen: Set<string>
  toolInvokeSeen: Set<string>
  stepCostLogged: Set<string>
  messageRole: Map<string, string>
  suppressedParts: Set<string>
  // 画布摘要：前端每次发讯息时上送的最新画布状态（节点/连线/预算），
  // 供前端接续画布/稽核用。deepseek 不读这个——它完全不知道画布存在。
  canvasSummary?: unknown
  canvasSummaryAt?: number
  // 画布持久快照（2026-08-27）：canvas.node.* 事件套用后的完整节点/连线状态。
  // 随 session 防抖落盘；重启懒加载时回灌 canvasStates，支撑 /internal/canvas/snapshot。
  canvasSnapshot?: { nodes?: unknown[]; connections?: unknown[]; [k: string]: unknown }
  // 工作流持久快照（2026-08-27，与 canvasSnapshot 同构）：workflow 状态变更时
  // 由 WorkflowService.onDirty 镜像进 session（防抖落盘）；重启懒加载时回灌
  // workflowService 的 workflows Map——画布能恢复、工作流也能，行为一致。
  workflowSnapshot?: Record<string, unknown>
  // 自动制画布：opencode image_* 工具的活跃单元追踪。
  // deepseek 只提交生图/改图请求，gateway 拦截其参数自动建画布：
  //   工具 callID → 画布单元 id（running 阶段建立）
  //   task_id    → 画布单元 id（submit 完成后挂取，供完成事件关联）
  canvasUnitByCall: Map<string, string>
  canvasUnitByTask: Map<string, string>
  // 0831：本轮生成任务登记（权威 task_id 来源，供 /internal/session-tasks 读）。
  sessionTasks: Map<string, { task_id: string; label?: string; status: string; url?: string; submitted_at: number }>
  // 意图审查政策只在 session 首次 send 时注入（system 栏位），之后不再重复，
  // 避免每次讯息都带同一段 system 造成 token 膨胀。
  // D1 修复（2026-09-15 PRD P0-4）：本旗标同时是 L0/L1 记忆块的注入闸——
  // memory-patch 到达时重置为 false，下一回合按最新记忆重建 system。
  // 原 memoryInjected「死旗标」（只写不读、真闸是这里）已从型别与全部写入点移除。
  vettingInjected: boolean
  // L0 账户级记忆：本站会话创建时上送的 user_profile + lessons，加上 2026-09-15
  // 契约 §4 扩充的 memory_docs（私有 active docs ≤8）与 memory_index_md（共享索引行）。
  // 首条消息时拼进 system 注入，之后不再重复，避免 token 膨胀。
  // 两个新栏位是 userMemory 物件内的额外键：persistence 白名单整包透传 userMemory，
  // 重启 revive 不丢（memoryInjected 栏位删除对 persistence 亦无感）。
  userMemory?: {
    user_profile: Record<string, unknown>
    lessons: string[]
    /** 契约 §1 AgentMemoryDoc 的驼峰原样子集（repo payload 直送）。 */
    memory_docs?: MemoryDocLite[]
    /** 契约 §4 L1 共享索引行（≤800 字元）。 */
    memory_index_md?: string
  }
  /** 账户无画像：开场用选择题采集（question 工具）。 */
  profileOnboardingPending: boolean
  // 2026-08-25 模板隐形注入：站点点模板卡时上送的引导指示，随首条讯息 system 注入。
  // 不进 transcript、用户不可见；注入一次即弃（directiveInjected），换模板可覆盖重注。
  sessionDirective?: string
  directiveInjected?: boolean
  // ── 0918 前缀快取修复：尾端注入 payload 的去重指纹（volatile，不持久化）──
  /** 上一次注入到「该轮 user 讯息尾端」的 gateway payload 的 sha256（见
   *  handleSendMessage 的「野兽帧改附尾端」段与 appendSystemPayloadToTurnTail）。
   *  同 byte 不重贴（内容已在历史中，资讯量不变）→ context 不再每轮固定长
   *  17.2k 字元。volatile：重启后首轮必重贴一次；压缩成功后清空（摘要会改写
   *  历史，尾端 payload 可能被排除出上下文）。 */
  lastTailPayloadHash?: string
  // 滚动摘要压缩水位：上次 opencode summarize 后的讯息数与时间（持久化）。
  // 触发条件 = 讯息数 ≥ SESSION_COMPACT_THRESHOLD 且自上次压缩新增 ≥ 半个阈值。
  compact?: { lastCount: number; at: number }
  /** 2026-10-02：模板偏离 token（网关签发、单次核销、TTL 15 分）。落持久层＝跨 agent-gateway 重启存活。 */
  tplDeviateToken?: { token: string; at: number } | null
  /** 已上报过 turn.status 的 compaction part id（2026-10-02 压缩可见化去重，volatile）。 */
  compactionNotified?: Set<string>
  /** 已发过 context.compacted 边界事件的摘要讯息去重键（2026-10-02 压缩语义化，volatile）。
   *  键＝摘要讯息 id，无 id 时退化成 trigger:preTokens；防止同一份摘要反覆重跑时重复上屏边界事件。 */
  // ── PRD P0-4（2026-09-15）记忆 trace 与召回辅助（皆 volatile，不入持久化白名单）──
  /** §3.6 形状：注入trace，供 GET /agent/v1/sessions/:id/memory-trace（R2 尺观测点）。
   *  重启即丢属已知限制（持久化白名单在 persistence.ts，非本片工作对象）。 */
  memoryTrace?: {
    private_docs: string[]
    shared_recalled: string[]
    shared_index_chars: number
    injected_at: string
  }
  /** §7 召回 query 的「上一轮 assistant 文本」：只留前 200 字元，turn 起点重置。 */
  turnAssistantHead?: string
  // ── 刀 2（2026-09-15）：机器 critic pass 的逃生阀扫描（皆 volatile，不持久化）──
  /** 本轮 assistant 正文的尾巴（32 字元滚动窗）：跨 chunk 边界侦测「未经独立审核」声明。 */
  criticEscapeTail?: string
  /** 本轮正文已出现「未经独立审核」自签声明 → 机器 critic pass 让位（逃生阀）。 */
  criticUnreviewedDeclared?: boolean
  // 抖动重试（2026-08-22）：turn 结束但零文本输出 = 上游模型抖动死亡的特征，
  // gateway 自动重发同一条 prompt（上限 TURN_MAX_RETRIES）。volatile，不持久化；
  // revive 后为 undefined，读取处一律带 ?? 预设值。
  lastPromptBody?: { parts: GatewayPromptPart[]; system?: string; model?: { providerID: string; modelID: string } } | null
  // 修复1（2026-09-19 cn:deepseek-v4.1-flash 死链事故）：本轮「实际 dispatch 出去」
  // 的模型（prompt 首投与 failover/jitter 重投都更新）。volatile。降权判定必须用它——
  // lastPromptBody.model 是 turn 起点模型，failover 换模后不回写，用旧值会把死帐户
  // 的错误记到无辜 provider 头上（事故实锤：chaozhiyuan 403 五次误标 hublinuxdo）。
  lastDispatchedModel?: { providerID: string; modelID: string } | null
  // 黏性渠道（2026-09-21 暴君裁定）：failover 换模后轮子产出真实正文＝该渠道被实证可用，
  // 钉死在本 session，下一轮起 personaModel() 直接返回它，不再每轮重跑死主模型重试链；
  // 下一次 failover 排队时解除（自我修复）。volatile，不进快照。
  stickyModel?: { providerID: string; modelID: string; persona: "efficient" | "thoughtful" } | null
  turnGen?: number
  turnTextChars?: number
  // 罪状2 根因修复（2026-08-29）：思维链字数。模型推理期间 reasoning.delta
  // 持续到达，此前不计入任何活动判定 → ack/心跳/看门狗/停滞哨在思考期误判死寂。
  // 与 turnTextChars 同点重置；只进 turnHasActivity，不进零文本抖动重试判定。
  turnReasoningChars?: number
  // 刀 1（2026-09-19）：Jev 测谎闸喂料（volatile，与 criticEscapeTail 同款生命周期）。
  // jevBriefTail＝本轮 message.delta 累积尾段（测谎题的 brief）；jevGateSummaries＝
  // 本轮子代理唤醒摘要头（含【交付闸门·未达标】标记的事实面）。session.idle 收盘
  // 消费后清空。
  jevBriefTail?: string
  jevGateSummaries?: string[]
  turnRetries?: number
  turnAborted?: boolean
  /**
   * 本轮中止的来源（D2-1b 修复，2026-09-23）：
   *   "user"   用户按了停止（session-read.handleAbortSession）→ 待投 steer 全数作废。
   *   "system" 内部断路器（空转止损 triggerIdleStepBreaker）自行中止并同轮重投
   *            → 用户没有叫停，排队中的指引不因此失效，等下一次收尾照常投递。
   * volatile（不落盘，与 turnAborted 同步生命周期）；缺席一律按 "user" 保守处置
   * （见 steer-core.abortIsUserStop）。
   */
  turnAbortSource?: "user" | "system"
  retryQueued?: boolean
  // ── REQ-D2（2026-09-22）：steer 回合中引导 ──
  /** 本回合排队中的引导语（FIFO；纯代数在 steer-core.ts，接线在 steer-gw.ts）。
   *  回合收尾时投递成下一回合；用户中止则全数作废（停止优先）。volatile。
   *  每条带 deadline（STEER_QUEUE_TTL_MS）：逾时不投递、落 failed 终态，
   *  前端以同一个 TTL 自行翻「未能送达」——重启后不得留下永久「排队中」。 */
  pendingSteers?: PendingSteer[]
  // ── P2b（2026-09-11）：空转止损（全部 volatile，不持久化）──
  /** 本 turn 连续空 step 计数。 */
  idleSteps?: number
  /** 当前是否处于一个未收尾的 step（step-start 置位 / step-finish 清位）。 */
  stepOpen?: boolean
  /** 当前 step 是否出现过 tool part。 */
  stepNoopTool?: boolean
  stepHasTool?: boolean
  /** 当前 step 是否出现过非空正文 text part。 */
  stepHasText?: boolean
  /** 当前 step 是否出现过非空（trim 后）reasoning 文字。 */
  stepHasReasoning?: boolean
  /** 本 turn 是否已因空转中止并补发动作导向提示（同 turn 仅一次）。 */
  idleNudgeSent?: boolean
  /** 2026-10-02：自上次动作以来的 reasoning 累计（无工具长推理断路器，见 reasoning-cap.ts）。 */
  reasonSinceActionChars?: number
  reasonSinceActionAt?: number
  /** 2026-10-02：turn.plan 点名的专家 id + 本轮 subagent.started 计数（收盘对账，见 plan-promise.ts）。 */
  planExperts?: string[]
  turnSubagentStarts?: number
  /** 2026-10-02 C 方案：收盘记录的「未兑现开场计画」专家 id（计画点名但整轮零派遣）。
   *  下一轮 messages-gw 组 promptBody.system 时一次性注入事实并清除；volatile，不进持久化。 */
  pendingUnfulfilledPlan?: string[]
  // 2026-08-31 failover：本轮上游模型错误原文（非 tool_error/非 Aborted）。
  // emitSessionError 记入，turn 起点清空；idle 收尾时非空即接管换模重试
  //（jitter 只管零正文轮，mid-turn 断线此前无人接手）。volatile，不持久化。
  turnUpstreamError?: string | null
  // ── N1（2026-08-27）：死寂窗口补口 ─────────────────────────────
  // 规格1：30s 心跳提示（「模型在憋大招」，与 S6 ack 的「收到」错峰）。
  // 每 turn 最多 1 条，volatile。
  heartbeatSent?: boolean
  heartbeatTimer?: ReturnType<typeof setTimeout> | null
  // 规格3：重启斩 turn 重投——turn 开始时打点（持久化，重启后判断
  // 「重启前是否有 in-flight turn」的唯一依据；turn 正常结束（idle 正常路径
  // 发出 turn.done）时清零）。持久化栏位 → persistence.ts 需同步。
  lastTurnActiveAt?: number
  // ── S6（2026-08-27）：异步心跳汇报制 ─────────────────────────────
  // 规格2：用户消息 30s ack。prompt_async 送达后启动 timer；30s 内 turn
  // 没产出任何文本 delta（turnTextChars 停 0）就先发一条短 ack。volatile。
  ackTimer?: ReturnType<typeof setTimeout> | null
  ackSent?: boolean
  // ── R2-A（2026-08-27）：turn 启动看门狗 ──────────────────────────
  // 用户消息送达后 turn 必须「动起来」（tool.invoke 或 message.delta 二选一）。
  // 评测实锤：压缩后的长会话 prompt_async 202 但 turn 永不启动，上游连
  // session.idle 都不发——抖动重试（只挂在 idle 上）永远等不到。看门狗以
  // 「turn 有无动静」为准，覆盖 idle 永不到达的死亡路径。volatile。
  watchdogTimer?: ReturnType<typeof setTimeout> | null
  /** 本轮 turn 是否出现过 tool.invoke（handleToolPartUpdate 置位）。volatile。 */
  turnToolStarted?: boolean
  /** 看门狗是否已重投过一次（只重投一次，防风暴）。volatile。 */
  watchdogRetried?: boolean
  /** 修 1（2026-09-01）：watchdog 已宣告死亡（道歉 + turn.done）。volatile。
   *  置位后若内容帧仍到达（重投 retry 开始产出 = 僵尸还魂），emitToSession
   *  统一通道会先发一条一次性撤回帧（「后端无响应是误判」）再放行内容帧，
   *  用户不再看到「宣告死亡 + 静默还魂」并存。新 turn 起点（发消息/resume）
   *  与撤回发出时清位。 */
  deathDeclared?: boolean
  // ── R5-C（2026-08-28）：中段停滞哨 + 恢复轮标记（全部 volatile）──
  /** turn 内最后一次任意帧打点（emitToSession 全量刷新），中段冻结判定依据。 */
  turnLastFrameAt?: number
  /** 中段停滞哨 timer。volatile。 */
  midturnStallTimer?: ReturnType<typeof setTimeout> | null
  /** 中段停滞哨是否已重投过一次（防风暴，每 turn 一次）。volatile。 */
  midturnStallRetried?: boolean
  /** 本轮是否为恢复轮（watchdog 重投/redrive/中段哨重投）——收尾兜底结语用。 */
  recoveryRound?: boolean
  // ── R4-A（2026-08-28）：三死线修复的新增状态（全部 volatile，不进持久化白名单）──
  // S3①：上游错误后停滞看门狗。emitSessionError 布哨、session.idle 撤哨。
  errorStallTimer?: ReturnType<typeof setTimeout> | null
  /** S3①：错误后告警帧是否已发（每 turn 一条，防刷屏）。 */
  errorStallAlerted?: boolean
  /** 修复2（2026-09-19）：S3① 诚实收尾幂等——记「已收尾的 turnGen」。连续两个
   *  session.idle 都过终局门时只收尾一次（journal 成对 warn 实锤：message.delta＋
   *  turn.done 各发两次）。存 gen 而非 boolean：跨 turn（含 resume/wake 轮）自然
   *  失效，不需各 turn 起点重置，也不会误吞下一轮收尾。volatile。 */
  turnExhaustedClosedGen?: number
  /** 修复3a（2026-09-19）：本 turn 已发出的错误帧文案（humanize 后）清单——
   *  emitSessionError 同文去重用；turn 起点清空。volatile，有界＝TURN_MAX_RETRIES
   *  ＋少数非重试错误，设上限 32 防呆。 */
  turnEmittedErrors?: string[]
  /** S3①：turn 内最后一次进度打点（message.delta / tool 帧刷新），停滞判定依据。 */
  turnProgressAt?: number
  /** S1：本 turn 是否已发过「英文内部思考已略去」提示（每 turn 一条）。 */
  englishNoticeSent?: boolean
  /** S8：本 turn 内到达终态的节点清单（id+status 去重，上限 64）。 */
  turnTerminalNodes?: { id: string; status: string }[]
  /** S8：本 turn 是否已发过任何主动汇报帧（emitAgentNotice 置位）。 */
  turnNoticeSent?: boolean
  /** S3②：重启恢复时暂存的中断告知——恢复瞬间常无 SSE 客户端，等接入时补投。 */
  pendingRestoreNotice?: { text: string; at: number }
  // 规格3：质询期间冻结大额自动开跑。最后一条用户消息命中质询样式且
  // assistant 尚未回覆（turn 未结束）期间，视频类 workflow generate 挂起。
  // volatile；pendingVideoWorkflows 记录被冻结的 workflowId（回覆完成后放行）。
  lastUserMessage?: string
  lastUserAt?: number
  pendingVideoWorkflows?: string[]
  // 规格1：节点终态汇报去重（同一节点同一终态只汇报一次，rerun 后会再触发）。
  nodeTerminalReported?: Set<string>
  // ── R8-B（2026-08-29）工单 #2/#3/#4/#5 新增状态（全部 volatile）──
  /** 工单 #3：question pending 心跳 timer（每 30s 一帧用户可见心跳）。 */
  questionHeartbeatTimer?: ReturnType<typeof setTimeout> | null
  /** 片AJ：question 3 分钟超时代答 timer（手动答覆/跳过/会话拆除时清）。 */
  questionAssumeTimer?: ReturnType<typeof setTimeout> | null
  /** 工单 #5：turn 内最后一次模型正文（message.delta）打点——静默通知判定依据。 */
  lastUserVisibleAt?: number
  /** 工单 #9：session.idle 在 question pending 期间到达 → 冻结旗标（答覆后复位）。 */
  turnFrozenByQuestion?: boolean
  /** 工单 #4：本 turn 是否答覆过 question（恢复轮结语让位，防「要继续跑吗」自我推翻）。 */
  questionAnsweredThisTurn?: boolean
  // ── 会话摘要标题（2026-09-12）──
  /** opencode 在首条用户消息后异步生成的会话标题；null/undef=尚未生成。
   *  session.idle 钩子经 fetchOpencodeTitle 抓取，占位标题（"New session - …"）
   *  不落入此栏。随防抖落盘（persistence.serialize → data.title）。 */
  sessionTitle?: string | null
  /** idle 标题抓取的一次性重试计时器（2s/8s/20s，拿到即全部 clear）。 */
  titleFetchTimers?: ReturnType<typeof setTimeout>[]
  /** Phase 0 观测（2026-09-18）：本轮分段延迟计时档。volatile，不进持久化
   *  白名单（persistence.serialize 是显式子集，此栏不落盘）。turn.done 收档；
   *  未收尾的档案由 handleAbortSession 或下一轮 beginTurnMetrics 补收。 */
  turnMetrics?: TurnMetricsRecord | null
  /** 两段式首字（2026-09-18）：本轮 turn.plan 的去重/让位状态。volatile，不进
   *  持久化白名单（persistence.serialize 是显式子集，此栏不落盘）。gen = 已发起
   *  计画的 turnGen；emittedAt = 帧实际发出的时刻（null = 还在途/已放弃）。 */
  planState?: { gen: number; emittedAt: number | null }
}
export type TurnMetricsEnd = "done" | "aborted" | "superseded"

/** 在途计时档（volatile）。 */
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
  /** 两段式首字（2026-09-18）：turn.plan 帧发出时刻；null = 本轮没发计画。 */
  t_first_plan: number | null
  /** compaction 闸挡住本轮 prompt 的时刻；null = 没被挡（prompt_deferred_ms=0）。 */
  deferredAt: number | null
  providerID: string | null
  modelID: string | null
  contextTokens: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

/** 收档后的快照（journal 行 + ring 条目，同一形状）。 */
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
  /** 自 t_accept 起算的累积延迟（null = 该里程碑未观测到）。 */
  d_prompt_ms: number | null
  d_first_reasoning_ms: number | null
  d_first_text_ms: number | null
  d_first_tool_ms: number | null
  d_first_plan_ms: number | null
  d_total_ms: number | null
}

/**
 * 任务状态单一枚举真源（0920 收口）。
 * 现场值域（grep 实证）：subagent.ts SubagentRun/SubagentResult 与 subagent.done
 * 事件只出 running/ok/error/stopped；workflow-gw 的节点 patch 终态只出 error/
 * running（pending/success 是画布节点域、building/partial/failed 是工作流级域、
 * succeeded/cancelled 是上游域，均不属本枚举）。
 * 血泪：停止曾复用 error 一行省事 → 使用者看到红字「失败」的假判定
 * （见 memory stopped-status-not-failure-0920）。
 */
export type TaskStatus = "running" | "ok" | "error" | "stopped"

/** 任务状态语义表：UI 标签、是否失败、如何结算工具卡。 */
export const TASK_STATUS_SEMANTICS: Record<TaskStatus, { uiLabel: string; isFailure: boolean; settlesToolCard: "ok" | "fail" | "none" }> = {
  ok: { uiLabel: "成功", isFailure: false, settlesToolCard: "ok" },
  error: { uiLabel: "失败", isFailure: true, settlesToolCard: "fail" },
  stopped: { uiLabel: "已停止", isFailure: false, settlesToolCard: "none" },
  running: { uiLabel: "进行中", isFailure: false, settlesToolCard: "none" },
}

/** 型别守卫：unknown 收窄到 TaskStatus。 */
export function isTaskStatus(v: unknown): v is TaskStatus {
  return v === "running" || v === "ok" || v === "error" || v === "stopped"
}
