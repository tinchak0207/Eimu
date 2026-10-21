import type { AgentDirectorDone, AgentQuestionRequest, AgentSteerStatus, AgentToolAuthScope } from "./types-events";
// ─────────────────────────── 前端渲染模型（transcript）
//
// 对话不是「一串事件」，是「一串可渲染的条目」。事件流会把同一个条目改很多次
// （message.delta 追加文字、tool.result 回填先前的 tool.invoke），所以条目必须
// 有稳定 id，让 React 不会每来一帧就整段重挂。

export type AgentTranscriptItem =
  | AgentUserTurnItem
  | AgentAssistantTextItem
  | AgentToolCallItem
  | AgentImageItem
  | AgentVideoItem
  | AgentAudioItem
  | AgentDirectorItem
  | AgentNoticeItem
  | AgentSubagentItem
  | AgentSubagentReportItem
  | AgentPlanItem;

interface TranscriptItemBase {
  /** React key。同一条目的多次更新必须沿用同一个 id。 */
  id: string;
  /** 产生这条目的首个事件序号，用于稳定排序。使用者自己发的消息用 0。 */
  seq: number;
}

/** 使用者发出的一轮。乐观插入，不等网关回声。 */
export interface AgentUserTurnItem extends TranscriptItemBase {
  kind: "user";
  text: string;
  /** 附件（图／影片）在 step 8 才接，先留位子，避免之后改类型牵动所有渲染。 */
  attachments?: AgentAttachmentRef[];
  /**
   * REQ-D2（2026-09-22）：这条消息是「回合中追加的指引（steer）」时挂状态。
   * 状态值域的权威在网络侧（steer.status 帧），这里只落账：
   * queued=排队中（本回合结束后生效）/ injected=已注入本回合 / applied=已生效 /
   * aborted=已中止（用户按了停止，停止优先）/ failed=未生效 /
   * uncertain=未确认（REQ-D2b：投递已发出但没等到确认，网关**永不自动重发** ⇒ 「未确认·未重送」）。
   */
  steer?: {
    id: string;
    status: AgentSteerStatus;
    position?: number;
    /**
     * 本端入队时刻（epoch ms，收到 queued ack 时打点）。排队的存活上限契约是
     * AGENT_STEER_QUEUE_TTL_MS——`expireQueuedSteers` 用它判断这条还能不能算「排队中」。
     * 缺席（旧存档／SSE 帧建出来的条目）→ 以存档时刻为基准兜底（见 reducer 的 restore）。
     */
    queuedAt?: number;
  };
}
export interface AgentAttachmentRef {
  kind: "image" | "video" | "document";
  /** 图／影片的展示 URL；document 类型是上传 blob 的短暂 URL（如有）。 */
  url?: string;
  /** 附件在网关上的储存路径，[附件] 区块的字面值。 */
  path?: string;
  name?: string;
  mime?: string;
  size?: number;
}

/** 助手文字。streaming 期间 text 会不断变长。 */
export interface AgentAssistantTextItem extends TranscriptItemBase {
  kind: "assistant";
  text: string;
  /** 思维链（reasoning.delta 累积）。streaming 期间可能还在长。UI 可折叠显示。 */
  reasoning?: string;
  /**
   * 思维链起点（epoch ms）：reasoning.delta 首次落到本条目时由 reducer 写入，
   * 已有值不覆盖。只当结算 reasoningMs 的基准，写完保留、不再参与显示。
   */
  reasoningStartedAt?: number;
  /**
   * 思维链总时长（ms）：思考结束时结算一次（正文首个 delta 到达、或串流收尾），
   * 之后不再变。收合行据此显示「已思考 · N 秒」；缺席＝没有可诚实显示的秒数
   * （历史回放重建的条目就没有计时资料，显示「已思考」不编秒数）。
   */
  reasoningMs?: number;
  /** true = 还在收 delta。turn.done 后转 false。 */
  streaming: boolean;
}

/** 一次工具调用，从 invoke 到 result 是同一个条目。 */
export interface AgentToolCallItem extends TranscriptItemBase {
  kind: "tool";
  tool: string;
  /** 派遣子代理时，绑定的子代理 id（subagent.started 回填）：状态与子代理卡同源。 */
  subagentId?: string;
  argsSummary?: string;
  /**
   * 卡片状态。`pending` 是**中继态：已提交、成品未到**（tool.result.artifact_pending）
   * —— 提交型生图/生片工具在任务交出去的那一刻不再假报「已完成」，等
   * image/video/audio.done 或 image.failed 到了才转终态。
   *
   * `needs_auth`（2026-10-04 缺陷 C）＝**需要授权**的 action 态：`local_files`
   * 未授权路径回 needs_authorization，卡片必须停在「等用户选授权范围」，绝非「完成」。
   */
  status: "running" | "pending" | "ok" | "failed" | "needs_auth";
  /** 提交型工具的任务 id（tool.result.task_id 回填）：成品/失败事件用它精确配对 pending 卡。 */
  taskId?: string;
  costCoins?: number;
  /** 失败时的人类可读错误（gateway tool.result error.human_message 优先）。 */
  error?: string;
  /**
   * 失败时 gateway 分类出的错误码（tool.result error.code，如 `flowmusic_session_expired`）。
   * 展示层据此渲染分类状态位（不把上游原文直甩到界面）；缺省＝无分类，照旧展示 error 文字。
   */
  errorCode?: string;
  /** 执行中进度（tool.progress 回填）。仅 running 期有意义，终态后忽略。 */
  progress?: { done: number; total: number; label?: string };
  /** 本机档案授权请求载荷（status==="needs_auth" 时必填，供卡片渲染三选一）。 */
  authorization?: AgentToolAuthorization;
  /**
   * 二进位读取侦测（缺陷 D）：true 时卡片显「这是二进制文件，无法当文字读」，
   * 指向附件下载路径，**不把乱码当成功内容**。
   */
  binary?: boolean;
  /** 截断资讯（依实际读到的 bytes 与档案 size 对比；上游带才有）。 */
  readBytes?: number;
  totalBytes?: number;
  truncated?: boolean;
}

/** 本机档案授权请求载荷。 */
export interface AgentToolAuthorization {
  root?: string;
  reason?: string;
  actionRequired?: string;
  options: AgentToolAuthScope[];
}

/** 出图结果。step 6 会在这张卡上挂「存图库／改图／放大／下载」。 */
export interface AgentImageItem extends TranscriptItemBase {
  kind: "image";
  url: string;
  costCoins?: number;
  taskId?: string;
  /** 真实生成参数（来自 image.done 的 recipe），存为配方资产时用。 */
  recipe?: { prompt?: string; model?: string; size?: string; lora?: string };
}

/** 出片结果（影片 / 成片）。卡上挂「存图库／下载」。 */
export interface AgentVideoItem extends TranscriptItemBase {
  kind: "video";
  url: string;
  costCoins?: number;
  taskId?: string;
  /** "film"=成片（剪接汇出）、"video"=单段影片生成。缺当 "video" 展示。 */
  mediaKind?: "video" | "film";
}

/** 出音频结果（音乐 / 语音）。卡上挂「存图库／下载」。 */
export interface AgentAudioItem extends TranscriptItemBase {
  kind: "audio";
  url: string;
  costCoins?: number;
  taskId?: string;
  /** "music"=成曲（音乐产物）、"audio"=单段音频。缺当 "audio" 展示。 */
  mediaKind?: "audio" | "music";
  /** 真实歌名（audio.done.title；缺省时卡片回落 URL 猜测或不带编号的「音频」/「音乐」）。 */
  title?: string;
  /** 封面缩略图 URL（audio.done.cover；缺省＝不显示封面，不占位）。 */
  cover?: string;
  /** 歌词对齐状态（audio.done.lyric_status；如 "aligning"）。 */
  lyricStatus?: string;
}

/**
 * 导演台分镜卡（director.done → 前端唯一活卡）。会话内同槽替换不堆积：
 * 新事件 revision 大者胜，小于等于现有 revision 的迟到帧丢弃。
 * SVG 是服务端预渲染的 <svg> 字串，渲染层转 data:image/svg+xml;base64 img。
 */
export interface AgentDirectorItem extends TranscriptItemBase {
  kind: "director";
  /** 导演工程所属的会话 id（director.done.session_id）。 */
  directorSessionId: string;
  revision: number;
  action: string;
  plan: AgentDirectorDone["plan"];
  activeShot: AgentDirectorDone["active_shot"];
  schematic: AgentDirectorDone["schematic"];
  health: AgentDirectorDone["health"];
  counts: AgentDirectorDone["counts"];
}

/** 系统告知：错误、会话关闭、确认被裁决等需要留痕的事。 */
export interface AgentNoticeItem extends TranscriptItemBase {
  kind: "notice";
  tone: "info" | "error";
  text: string;
  /** 连续同类通知（如人工逐笔同意花费）合并成一条的键；不同键不合并。 */
  dedupeKey?: string;
  /** 已合并的笔数（单条缺省视为 1）。 */
  count?: number;
}

/**
 * 一次子代理运行（started → delta… → done 是同一条目）。不进消息流：
 * 由 AgentSubagentBar 在转录区上方渲染成状态栏（至多 3 张），
 * turn.done 时 reducer 整批清掉。
 */
export interface AgentSubagentItem extends TranscriptItemBase {
  kind: "subagent";
  /** 网关侧子代理 id（三帧用它关联；与条目本身的 id 分名，避免撞 React key）。 */
  subagentId: string;
  label: string;
  /** 流式最后一行：delta 并入后只留非空末行（置顶跑马灯用，F4 的预览层）。 */
  lastLine: string;
  /**
   * 活动流（2026-09-11 S2）：所有 delta（含 reasoning）append 累积，跑马灯专读它。
   * 与 text 的关系是 activity ⊇ text —— reasoning 只进这里。跑马灯的目的只是让
   * 用户感知「子代理在工作」，所以思考同样算活动，不必是交付物。
   */
  activity?: string;
  /** 全文（delta 增量累积，模型层不截断——F4：渲染层才截断 + 可展开）。 */
  text?: string;
  status: "running" | "ok" | "error" | "stopped";
  summary?: string;
  /**
   * 子代理内部的工具活动（2026-10-05 subagent.tool 帧回填）。只保留最近几条，
   * 用途是让用户看到「它正在跑什么」——running 的排前面，settled 的留一条做上下文。
   */
  tools?: AgentSubagentToolEntry[];
}

/** 子代理工具活动的渲染条目（由 AgentSubagentTool 帧归并而成）。 */
export interface AgentSubagentToolEntry {
  callId: string;
  tool: string;
  status: "running" | "ok" | "failed";
}
/**
 * 回合收尾后的子代理产出卡（F3）。subagent 条目退场时，有 summary/全文的
 * 转存成这条持久条目留在 transcript 里：中止不再把 1082 字产出一起删掉。
 * text 是全文，渲染层截断预览 + 整行点击展开（F4）。
 */
export interface AgentSubagentReportItem extends TranscriptItemBase {
  kind: "subagent_result";
  /** 原 subagent id（同一子代理的产出与它的状态栏可对照）。 */
  subagentId: string;
  label: string;
  /** running 中就被收尾（中止）= interrupted；人工停止成功 = stopped，均非失败。 */
  status: "ok" | "error" | "interrupted" | "stopped";
  /** 全文（summary 或串流全文，取较完整者），模型层不截断。 */
  text: string;
}

/**
 * 本轮计画卡（turn.plan → 独立的「计划」区块）。
 *
 * 刻意不并进 assistant 条目：计画不是交付物，答案才是。混进同一条 streaming
 * 气泡后，100 秒后才到的正文会物理接在计画后面，使用者无从分辨哪段是答案。
 * 第一条 message.delta 到达时本卡自动收合成一行（reducer 负责，见 reduceTurnPlan /
 * reduceMessageDelta），但使用者手动展开过就永不再自动收起（渲染层负责）。
 */
export interface AgentPlanItem extends TranscriptItemBase {
  kind: "plan";
  /** 计画全文（模型现算，≤160 字）。 */
  text: string;
  /** 命中的专家白名单（≤4）。缺席 = 不画晶片。 */
  experts?: string[];
  /** true = 计画还在进行中（显示「（进行中）」）。 */
  provisional?: boolean;
  /** true = 收合成一行（正文截 40 字）。初始 false。 */
  collapsed?: boolean;
}

/** 待裁决的花费确认。不进 transcript，单独浮在输入区上方（随时只有 0..n 张）。 */
export interface AgentPendingConfirm {
  requestId: string;
  amountCoins: number;
  description?: string;
  seq: number;
}

/** 待回答的 opencode question。不进 transcript，浮在输入区上方。 */
export interface AgentPendingQuestion {
  requestId: string;
  questions: AgentQuestionRequest["questions"];
  seq: number;
}

export interface AgentQuotaState {
  balanceCoins: number | null;
  currency: string;
  available: boolean;
  /** false＝余额 ≤ 0（欠费），可取得但不可消费；缺省＝未知（见 AgentQuotaChanged.spendable）。 */
  spendable?: boolean;
  reason?: string;
}

/** 整个聊天区的可渲染状态。reducer 的输出，元件的输入。 */
export interface AgentChatState {
  items: AgentTranscriptItem[];
  pendingConfirms: AgentPendingConfirm[];
  pendingQuestions: AgentPendingQuestion[];
  quota: AgentQuotaState | null;
  /** 最后见过的事件序号，重连时当 last_event_id 续传。 */
  lastEventId: number;
  /** true = 助手正在产出（收到过 delta / tool 事件，还没 turn.done）。 */
  turnActive: boolean;
  /** 网关暂态状态行（turn.status 事件）。真实正文/图片结果/turn.done 会清掉它。 */
  turnStatus?: string;
  /** 会话已终结（session.closed）。之后所有输入都该被禁掉。 */
  closed: boolean;
  closedReason?: string;
}

export const EMPTY_AGENT_CHAT_STATE: AgentChatState = {
  items: [],
  pendingConfirms: [],
  pendingQuestions: [],
  quota: null,
  lastEventId: 0,
  turnActive: false,
  closed: false,
};
