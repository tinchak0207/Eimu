import type { CanvasAgentOpsEvent } from "@/lib/canvas/types";
// ─────────────────────────── 事件名

export interface AgentQuestionRequest {
  /** opencode 的 que_* id，回覆必须用这个，不能用 tool callID。 */
  request_id: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
  }>;
}

export interface AgentQuestionReplied {
  request_id: string;
  answer: string;
}

export interface AgentQuestionRejected {
  request_id: string;
  reason: string;
}

export const AGENT_EVENT_NAMES = [
  "message.delta",
  "reasoning.delta",
  "tool.invoke",
  "tool.progress",
  "tool.result",
  "image.done",
  "image.failed",
  "video.done",
  "audio.done",
  "director.done",
  "turn.done",
  "turn.status",
  "turn.plan",
  "context.compacted",
  "confirm.request",
  "confirm.resolved",
  "quota.changed",
  "session.error",
  "session.closed",
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.generating",
  "canvas.node.deleted",
  "canvas.node.disconnected",
  "canvas.derive.started",
  "canvas.budget.updated",
  "canvas.ops",
  "subagent.started",
  "subagent.delta",
  "subagent.done",
  "subagent.tool",
  "question.request",
  "question.replied",
  "question.rejected",
  // REQ-D2（2026-09-22）：steer 回合中引导的状态帧（排队中／已注入／已生效／已中止）。
  "steer.status",
] as const;

export type AgentEventName = (typeof AGENT_EVENT_NAMES)[number];

const EVENT_NAME_SET = new Set<string>(AGENT_EVENT_NAMES);

export function isAgentEventName(name: string): name is AgentEventName {
  return EVENT_NAME_SET.has(name);
}

// ─────────────────────────── 各事件 payload
// 栏位形状逐一对齐网关 emitToSession 的呼叫点（行号为 2026-08-06 的 index.ts）。
/** gateway:477,507 —— 助手文字增量。text 是「这一段新增的字」，不是全文。 */
export interface AgentMessageDelta {
  text: string;
}

/** gateway —— 助手思维链增量（reasoning part）。与 message.delta 同 shape，单独成事件让 UI 区分展示。 */
export interface AgentReasoningDelta {
  text: string;
}

/** gateway:409 —— 工具开始执行。一次 call 只发一次（网关已按 callId 去重）。 */
export interface AgentToolInvoke {
  tool: string;
  /** 参数摘要，网关已截到 500 字并补省略号。可能缺。 */
  args_summary?: string;
}

/** gateway:416,425,1040 —— 工具结束。ok=false 代表失败，cost_coins 只有计费工具才有。 */
export interface AgentToolResult {
  tool: string;
  ok: boolean;
  cost_coins?: number;
  /**
   * gateway（2026-09-18 契约）—— 提交型工具的任务 id。任务已交给上游，
   * 成品稍后由 image/video/audio.done（或 image.failed）带同一个 id 回来。
   */
  task_id?: string;
  /**
   * gateway（2026-09-18 契约）—— true = 任务已提交成功、成品还没到（**中继态**）。
   * 网关只在 `ok && task_id 有值 && 回包没有成品 url` 时带它；缺席一律当 false
   * 处理，行为与旧格式逐位元一致（不带 = 照旧直接结算 ok，不是生成中）。
   */
  artifact_pending?: boolean;
  /**
   * 本机档案授权请求（2026-10-04 缺陷 C）。`local_files` 读取未授权路径时，
   * 装置桥回 `{ok:false,error:{code:"needs_authorization",root,reason,options}}`；
   * 这份载荷**必须**一路带到前端，否则卡片只能看到 ok 而误报「完成」。
   */
  action_required?: string;
  /** 授权根（目录）；选项点击后带它回传。 */
  auth_root?: string;
  /** 三选一选项（允许一次／本会话允许此目录／永久允许）。 */
  auth_options?: AgentToolAuthScope[];
  /** 授权成因（人话，如「尚未授权」「安全文件受保护」）。 */
  auth_reason?: string;
  /**
   * 二进位读取侦测（2026-10-04 缺陷 D）：`read_file` 对二进位档回 200 + 有损文字
   * （含大量 U+FFFD）时，上游若带这些栏位，前端据此**不得把乱码当成功内容**呈现。
   * 栏位缺席时前端另用 preview 的 U+FFFD 比例自行判定（见 detectBinaryText）。
   */
  binary?: boolean;
  truncated?: boolean;
  bytes_read?: number;
  bytes_total?: number;
  /** 内容片段（可选；有才拿来做二进位特征侦测）。 */
  preview?: string;
  /** gateway 附带的人类可读错误（G-FE 合同：中文短句优先渲染）。 */
  error?: {
    code?: string;
    message?: string;
    human_message?: string;
    /** 结构化动作标记；`authorize_local_files` = 需要用户在卡片上选授权范围。 */
    action_required?: string;
    /** `needs_authorization` 时的授权根与三选一选项。 */
    root?: string;
    reason?: string;
    options?: unknown;
  };
}

/** 本机文件授权范围（与桌面/网关冻结契约逐字对齐）。 */
export type AgentToolAuthScope = "once" | "session" | "permanent";

/**
 * gateway —— 长耗时工具执行中进度（逐镜/逐项）。由工具每完成一个单元旁路上报，
 * 注入到该 session 的 SSE 流。只回填「同名且仍 running」的工具卡，不改终态。
 * done/total 为真实计数（total 必 >0），label 是给人看的一句话（如「渲染关键帧」）。
 */
export interface AgentToolProgress {
  tool: string;
  done: number;
  total: number;
  label?: string;
}

/** gateway:377 —— 出图完成。网关已按 url 在 session 内去重。 */
export interface AgentImageDone {
  url: string;
  cost_coins?: number;
  task_id?: string;
  /** 真实生成参数（VPS gateway image.done 附加），可用于存为配方资产。 */
  recipe?: { prompt?: string; model?: string; size?: string; lora?: string };
}

/**
 * gateway —— 出片完成（影片生成 / 成片剪接汇出）。与 image.done 同构，
 * 网关按 url 在 session 内去重。media_kind："film"=成片（剪接汇出）、
 * "video"=单段影片生成；缺当 "video"。
 */
export interface AgentVideoDone {
  url: string;
  cost_coins?: number;
  task_id?: string;
  media_kind?: "video" | "film";
}

/**
 * gateway —— 出音频完成（音乐生成 / 语音等音频产物）。与 video.done 同构，
 * 网关按 url 在 session 内去重。media_kind："music"=成曲（音乐产物）、
 * "audio"=单段音频；缺当 "audio"。
 */
export interface AgentAudioDone {
  url: string;
  cost_coins?: number;
  task_id?: string;
  media_kind?: "audio" | "music";
  /** 真实歌名（gateway 可选补栏位；缺省＝由 URL 猜或退化为不带编号的「音频」/「音乐」）。 */
  title?: string;
  /** 封面缩略图 URL（可选；缺省＝不显示封面，绝不拿默认专辑图占位）。 */
  cover?: string;
  /** 歌词对齐状态（可选，如 "aligning" / "ready"）；客户端可选读取，缺字段不崩。 */
  lyric_status?: string;
}

/**
 * gateway director.done —— 导演台工程变更快照（2026-09-02 spec §4 钉死，
 * 与 src/vendor-bridges/gateway/director.ts emitDirectorDone 对齐）。
 * 同一会话反复触发：revision 单调递增，前端只保留 revision 最大的一张活卡。
 * schematic 两栏是服务端预渲染的 <svg> 字串（≤32KB/张）；reset 时 plan/active_shot
 * 为 null、SVG 为空串。
 */
export interface AgentDirectorDone {
  session_id: string;
  /** project.json 版本号，单调递增（reset 后归 0）。 */
  revision: number;
  /** 触发本次变更的操作名（director_upsert_action 等 / "reset"）。 */
  action: string;
  /** 当前活跃方案；未初始化 / reset 时为 null。 */
  plan: { id: string; name: string; summary: string; shot_count: number } | null;
  /** 当前活跃镜头摘要；无方案或无镜头时为 null。 */
  active_shot: {
    no: number;
    name: string;
    duration_frames: number;
    camera_move: string;
    shot_scale: string | null;
  } | null;
  /** 服务端预渲染示意图（俯视图 + 镜头框图），<svg …> 原文字串。 */
  schematic: { top_view_svg: string; camera_view_svg: string };
  /** 分镜健康检查：ok=绿徽章；issues 非空=琥珀徽章带数量。 */
  health: { ok: boolean; issues: Array<{ code: string; message: string; shot_id?: string }> };
  counts: { shots: number; elements: number; actions: number };
}

/**
 * gateway（poller 经 /internal/emit）—— 出图失败（refunded / failed / 超时）。
 * 与 image.done 对称：reason 是给人看的一句话，refunded 标记费用是否已退回。
 * human_message（2026-08-27 G-FE 合同）：后端英文黑话→中文短句，渲染层优先取它。
 */
export interface AgentImageFailed {
  task_id?: string;
  reason?: string;
  refunded?: boolean;
  human_message?: string;
}

/** gateway:552 —— 这一轮对话结束（网关发的是空对象）。 */
export type AgentTurnDone = Record<string, never>;

/** 网关系统状态（静默通知/心跳/重投告警）。暂态单行：新状态替换旧状态，真实正文/turn.done 即清，绝不并入正文。 */
export interface AgentTurnStatus {
  text: string;
}

/** 网关 context.compacted 系统边界事件（压缩验证通过、水位推进后才发）。 */
export interface AgentContextCompacted {
  trigger: "auto" | "manual";
  preTokens?: number;
}

/**
 * gateway（2026-09-18 契约，同事在网关端施工）—— 送讯后 ~1.4–2.0s 先到的
 * 「本轮计画」帧：由模型现算的真实计画（不是罐头），让使用者在重型回合
 * 首行正文（可能 +100s）之前就知道助手打算做什么。
 *
 * 为什么独立帧型别而**不**并进 message.delta：借用 message.delta 会让 reducer
 * 把计画塞进同一条 streaming:true 的 assistant 条目，100 秒后重模型正文会物理
 * 接在计画后面，变成一条分不清「计画 vs 答案」的长气泡——把非交付物混进交付物。
 * 所以计画有自己的条目型别（AgentPlanItem）与自己的区块。
 *
 * `plan` 是**唯一必需栏位**：缺它整帧丢弃（见 parseAgentSseEvent）。
 * 其余栏位缺席一律当 undefined/false 处理，行为与没有这帧时逐位元一致。
 */
export interface AgentTurnPlan {
  /** 由模型现算的计画一句话（≤160 字）。唯一的必需栏位。 */
  plan: string;
  /** 命中的专家白名单（≤4）：只在 digest 命中时出现，缺就不画晶片。 */
  experts?: string[];
  /** 预设 true：计画还在进行中，据此显示「（进行中）」。 */
  provisional?: boolean;
  /** 诚实来源标记：模型现算 / 规则兜底。 */
  source?: "model" | "rule";
  /** 产生计画的模型名。只进 console，不进 UI。 */
  model?: string;
  /** 保留栏位：true = 就地换掉既有计画文字（同一 id），预设不出现。 */
  superseded?: boolean;
}

/** gateway:945 —— 要求使用者确认一笔花费。90 秒不回会过期（D-20 要改成 15 分钟）。 */
export interface AgentConfirmRequest {
  request_id: string;
  amount_coins: number;
  description?: string;
}

/** gateway:734 —— 确认已被裁决（可能来自另一个装置，所以 UI 必须跟著收起卡片）。 */
export interface AgentConfirmResolved {
  request_id: string;
  approved: boolean;
  /** 互动模式=auto 的自动放行（网关只在这个路径带 true）：收起卡片但不留 notice。 */
  auto?: boolean;
}

/**
 * gateway:836-840 —— 余额变化。
 * 注意网关刻意不在拿不到余额时发这个事件（见 emitQuotaChanged 的注解），
 * 但 GET /quota 会回 available:false，所以这个类型两种情况都要能表达。
 */
export interface AgentQuotaChanged {
  balance_coins: number | null;
  currency: string;
  available: boolean;
  /** R9-A（gateway quotaPayload）：balance > 0 才可消费；false＝欠费/零余额，缺省＝未知。
   *  available 只表示「余额资料可取得」，负余额时 available 仍为 true。 */
  spendable?: boolean;
  reason?: string;
}

/** gateway:859 —— 会话层错误。不必然终结会话。human_message（G-FE 合同）：中文短句优先渲染。 */
export interface AgentSessionError {
  code: string;
  message: string;
  human_message?: string;
}

/** gateway:776 —— 会话已关闭。终结事件，之后不会再有任何事件。 */
export interface AgentSessionClosed {
  reason?: string;
}

// ─────────────────────────── 画布指挥台事件 payload
// 由 VPS gateway 拦截 image_* 工具自动产生（autoCreateCanvasUnit 系列），
// 前端画布 reducer 消费。与 src/lib/canvas/types.ts 的契约一致（此处只做宽松解析）。

/** gateway autoCreateCanvasUnit —— 一次生成请求的计画卡。 */
export interface AgentCanvasPlan {
  unit_id: string;
  tool: string;
  label: string;
  prompt: string;
  model: string;
  size: string;
  count: number;
  kind: string;
  source_image: string | null;
  cost_hint: number | null;
}

export interface AgentCanvasNodeCreated {
  unit_id: string;
  node: {
    id: string;
    type: string;
    title: string;
    metadata?: Record<string, unknown>;
  };
  target_kind?: "result";
}

export interface AgentCanvasNodeUpdated {
  unit_id: string;
  node_id: string;
  patch: Record<string, unknown>;
  url?: string;
  cost_coins?: number;
}

export interface AgentCanvasNodeConnected {
  unit_id: string;
  connection: { id: string; fromNodeId: string; toNodeId: string };
  target_kind?: "result";
}

export interface AgentCanvasNodeGenerating {
  unit_id: string;
  node_id: string;
  status: string;
  progress?: number;
}

export interface AgentCanvasNodeDeleted {
  unit_id: string;
  node_id?: string;
}

export interface AgentCanvasNodeDisconnected {
  unit_id: string;
  from: string;
  to: string;
}

export interface AgentCanvasDeriveStarted {
  unit_id: string;
  source_node_id: string;
  instruction: string;
  interpretation?: string;
}

export interface AgentCanvasBudgetUpdated {
  unit_id?: string;
  used_coins: number;
  remaining_coins: number;
}

// ─────────────────────────── 子代理（subagent）事件 payload
// 2026-08-29 合同（网关已上线实弹验证）：shape 定死，网关多送的栏位忽略、
// 少送的当 undefined。三帧用 id 关联同一次子代理运行；delta.text 是增量不是全文。

/** 子代理开始运行。label 是给人看的短标签（如「搜索素材」）。 */
export interface AgentSubagentStarted {
  id: string;
  label: string;
}

/**
 * 子代理输出增量。只保留末行渲染，原文不囤在前端。
 *
 * kind（2026-09-11 跨片契约，网关侧同批上线）：缺省 = 正文（交付物）；
 * "reasoning" = 思维链（只是「子代理在工作」的活动信号）。reasoning 只喂子任务卡
 * 的**活动流**，绝不并入 text —— text 会被产出卡当全文带走，混入思考就是谎报交付物。
 */
export interface AgentSubagentDelta {
  id: string;
  text: string;
  kind?: "reasoning";
}

/** 子代理收尾。summary ≤600 字，只在卡内截断显示。 */
export interface AgentSubagentDone {
  id: string;
  /** stopped＝人工停止成功（gateway stop 闸送出），中性收尾，不是失败。 */
  status: "ok" | "error" | "stopped";
  summary?: string;
}

/**
 * 子代理内部的工具状态（2026-10-05 网关新帧）。补足「子代理在跑什么」——
 * 此前子代理跑长工具期间前端只有跑马灯，用户误以为卡死。
 * 同一 call_id 只在状态变化时由网关发帧；delta/done 的契约不变。
 */
export interface AgentSubagentTool {
  /** 子代理 run id，与 subagent.started/delta/done 同源。 */
  id: string;
  /** 工具调用 id：同一调用的状态更新靠它归并。 */
  call_id: string;
  /** 工具名原文（渲染时经 toolDisplayName() 转人话，不在前端造假名）。 */
  tool: string;
  status: "running" | "ok" | "failed";
}

// ─────────────────────────── 判别联合

interface WithEventId {
  /** 网关注入的单调递增序号，断线重连靠它续传（Last-Event-ID / ?last_event_id=）。 */
  event_id: number;
}

export type AgentSseEvent = WithEventId &
  (
    | { name: "message.delta"; data: AgentMessageDelta }
    | { name: "reasoning.delta"; data: AgentReasoningDelta }
    | { name: "tool.invoke"; data: AgentToolInvoke }
    | { name: "tool.progress"; data: AgentToolProgress }
    | { name: "tool.result"; data: AgentToolResult }
    | { name: "image.done"; data: AgentImageDone }
    | { name: "image.failed"; data: AgentImageFailed }
    | { name: "video.done"; data: AgentVideoDone }
    | { name: "audio.done"; data: AgentAudioDone }
    | { name: "director.done"; data: AgentDirectorDone }
    | { name: "turn.done"; data: AgentTurnDone }
    | { name: "turn.status"; data: AgentTurnStatus }
    | { name: "context.compacted"; data: AgentContextCompacted }
    | { name: "turn.plan"; data: AgentTurnPlan }
    | { name: "confirm.request"; data: AgentConfirmRequest }
    | { name: "confirm.resolved"; data: AgentConfirmResolved }
    | { name: "quota.changed"; data: AgentQuotaChanged }
    | { name: "session.error"; data: AgentSessionError }
    | { name: "session.closed"; data: AgentSessionClosed }
    | { name: "canvas.plan"; data: AgentCanvasPlan }
    | { name: "canvas.node.created"; data: AgentCanvasNodeCreated }
    | { name: "canvas.node.updated"; data: AgentCanvasNodeUpdated }
    | { name: "canvas.node.connected"; data: AgentCanvasNodeConnected }
    | { name: "canvas.node.generating"; data: AgentCanvasNodeGenerating }
    | { name: "canvas.node.deleted"; data: AgentCanvasNodeDeleted }
    | { name: "canvas.node.disconnected"; data: AgentCanvasNodeDisconnected }
    | { name: "canvas.derive.started"; data: AgentCanvasDeriveStarted }
    | { name: "canvas.budget.updated"; data: AgentCanvasBudgetUpdated }
    | { name: "canvas.ops"; data: CanvasAgentOpsEvent }
    | { name: "subagent.started"; data: AgentSubagentStarted }
    | { name: "subagent.delta"; data: AgentSubagentDelta }
    | { name: "subagent.done"; data: AgentSubagentDone }
    | { name: "subagent.tool"; data: AgentSubagentTool }
    | { name: "question.request"; data: AgentQuestionRequest }
    | { name: "question.replied"; data: AgentQuestionReplied }
    | { name: "steer.status"; data: AgentSteerStatusEvent }
    | { name: "question.rejected"; data: AgentQuestionRejected }
  );
/**
 * steer 状态值域的唯一权威（与网关 steer-core.ts 的 SteerStatus 逐字对齐）。
 *
 * uncertain（REQ-D2b，2026-09-23）：**未确认**——网关投递已发出但没等到确认
 * （进程中断于投递与确认之间／重启后恢复）。它不是 failed：「不知道送没送到」与
 * 「确知没送到」是两件事，混为一谈就是把不确定说成事实。网关契约是**永不自动重发**，
 * 所以徽章显示「未确认·未重送」，且此态是终态（迟到的帧不得改写）。
 */
export const AGENT_STEER_STATUSES = ["queued", "injected", "applied", "aborted", "failed", "uncertain"] as const;
export type AgentSteerStatus = (typeof AGENT_STEER_STATUSES)[number];

/**
 * 「排队中」徽章的存活上限（ms）——与网关 steer-core.ts 的 STEER_QUEUE_TTL_MS
 * **必须逐字等值**（有测试钉著两边的字面）。
 *
 * 为什么前端也要有这个时限（D2-3）：网关的 pendingSteers 是 volatile 的——重启／
 * 续期后队列整个消失。此时前端的「排队中」徽章没有任何东西会把它推进终态＝永久假话。
 * 所以前端以同一个 TTL 自行兜底：逾时仍未见终态帧 → 翻「未能送达（未生效）」。
 * 两端都诚实：网关知道的（逾时条目）由网关发 queue_expired，网关不知道的由前端自己收口。
 *
 * D2b（2026-09-23）之后的分工更清楚：重启后网关**记得**那些命令身份（steer_commands 表），
 * 恢复时会补一张 uncertain 帧（「未确认·未重送」）；TTL 只负责「那张帧也没送到／没重连」
 * 这一最后兜底——它是 UI 的时间语义，不是防重复投递的机制（那是 tombstone 的职责）。
 */
export const AGENT_STEER_QUEUE_TTL_MS = 30 * 60 * 1000;
/** steer.status 帧：一条 steer 的状态迁移（前端据 steer_id 挂回那条 user 条目）。 */
export interface AgentSteerStatusEvent {
  steer_id: string;
  status: AgentSteerStatus;
  /** 排队位置（1-based），仅 queued 帧带。 */
  position?: number;
  /** 回显的指引文本，供排障与「排队中」提示展开。 */
  text?: string;
  /** 未生效原因（aborted / delivery_failed / delivery_unwired / queue_expired）。 */
  reason?: string;
}
