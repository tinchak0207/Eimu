// Agent 聊天的线路契约：网关 SSE 事件 → 前端可渲染的模型。
//
// 这个文件是「唯一的事实来源」，对齐 /opt/agent-harness/gateway/index.ts 的
// serializeSse()：每一帧都是 `id: <n>` + `event: <name>` + `data: <json>`，
// 且 data 一律被注入 `event_id`（= 那个 id）。前端只认这里宣告的栏位；
// 网关多送的栏位一律忽略，少送的栏位一律当 undefined 处理，不抛错 ——
// 一个没见过的栏位不该让整个对话白屏。
//
// 站上目前没有任何 SSE 消费者（全站都是轮询），所以没有既有模式可抄；
// 反过来说也没有既有包袱，这里定的形状就是后续所有 agent UI 的地基。

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

// ─────────────────────────── 解析（纯函数，可在 node --test 下测）

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 授权范围白名单（与桌面/网关冻结契约逐字对齐）。 */
const AUTH_SCOPES: readonly AgentToolAuthScope[] = ["once", "session", "permanent"];

/**
 * 宽松解析授权三选一选项。上游可能送 `[{scope:"once"},…]`、`["once",…]` 或
 * `{options:[{scope}]}`。只收白名单 scope、去重、保持契约顺序；解析不出 →
 * 回预设三项（宁可让用户看到标准三选一，也不给一个点无可点的空壳）。
 */
export function parseAuthOptions(v: unknown): AgentToolAuthScope[] {
  const raw = Array.isArray(v)
    ? v
    : v && typeof v === "object" && Array.isArray((v as { options?: unknown }).options)
      ? ((v as { options: unknown[] }).options)
      : [];
  const seen = new Set<AgentToolAuthScope>();
  for (const item of raw) {
    const scope = typeof item === "string" ? item : str((item as { scope?: unknown })?.scope);
    if (scope && (AUTH_SCOPES as readonly string[]).includes(scope)) seen.add(scope as AgentToolAuthScope);
  }
  return seen.size > 0 ? AUTH_SCOPES.filter((s) => seen.has(s)) : [];
}

/**
 * 二进位侦测（2026-10-04 缺陷 D，纯函式）：文字样本中 U+FFFD（替换字元）比例。
 * 二进位档被当文字解码 → 大量位元组落成 U+FFFD（实测 64KB 有 21,386 个）。
 * 只要替换字元占比 ≥ 0.5%（且样本 ≥ 64 字元）即判为二进位，**不得当成功内容呈现**。
 * 这是呈现层的最后一道闸；真正的治本在 read_file（gateway/desktop）侧。
 */
export function detectBinaryText(preview: string | undefined): boolean {
  if (typeof preview !== "string" || preview.length < 64) return false;
  let fffd = 0;
  for (let i = 0; i < preview.length; i += 1) {
    if (preview.charCodeAt(i) === 0xfffd) fffd += 1;
  }
  return fffd / preview.length >= 0.005;
}

/**
 * 宽松解析 string[]（turn.plan.experts）。非阵列 / 过滤后为空 → undefined
 * （呼叫方据此决定「不画晶片」）；逐项非字串或空字串一律剔除，绝不 throw。
 */
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * 宽松解析 image.done 附带的 recipe（VPS gateway 附加的真实生成参数）。
 * 白名单只收四个字符串栏位；非物件 / 非字符串一律忽略，绝不 throw。
 */
function recipe(v: unknown): AgentImageDone["recipe"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const rec = v as Record<string, unknown>;
  const prompt = str(rec.prompt);
  const model = str(rec.model);
  const size = str(rec.size);
  const lora = str(rec.lora);
  if (prompt === undefined && model === undefined && size === undefined && lora === undefined) return undefined;
  return {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(lora !== undefined ? { lora } : {}),
  };
}

/**
 * 宽松解析 director.done 的 plan 栏（白名单四栏位；非物件 / 缺核心栏位一律 null，
 * 绝不 throw —— reset/未初始化时本来就是 null）。
 */
function directorPlan(v: unknown): AgentDirectorDone["plan"] {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const id = str(p.id);
  const name = str(p.name);
  const shotCount = num(p.shot_count);
  if (!id || !name || shotCount === undefined) return null;
  return { id, name, summary: str(p.summary) ?? "", shot_count: shotCount };
}

/** 宽松解析 director.done 的 active_shot 栏。缺核心栏位回 null。 */
function directorActiveShot(v: unknown): AgentDirectorDone["active_shot"] {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const no = num(s.no);
  const name = str(s.name);
  if (no === undefined || !name) return null;
  return {
    no,
    name,
    duration_frames: num(s.duration_frames) ?? 0,
    camera_move: str(s.camera_move) ?? "",
    shot_scale: str(s.shot_scale) ?? null,
  };
}

/** 宽松解析 director.done 的 health.issues（白名单栏位逐项收敛，坏项跳过）。 */
function directorIssues(v: unknown): AgentDirectorDone["health"]["issues"] {
  if (!Array.isArray(v)) return [];
  const out: AgentDirectorDone["health"]["issues"] = [];
  for (const it of v) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const code = str(rec.code);
    const message = str(rec.message);
    const shotId = str(rec.shot_id);
    out.push({
      code: code ?? "",
      message: message ?? "",
      ...(shotId ? { shot_id: shotId } : {}),
    });
  }
  return out;
}

/**
 * 把一帧 SSE 解析成判别联合；任何不合契约的输入回 null（呼叫方直接丢弃该帧）。
 *
 * 为什么「丢弃」而不是「抛错」：SSE 是长连线，一帧坏掉不该让整条流断掉，
 * 更不该让已经渲染好的对话消失。坏帧在此静默落地，序号照样被上层记录，
 * 这样重连时不会反复重放同一帧坏数据。
 */
export function parseAgentSseEvent(name: string, rawData: string): AgentSseEvent | null {
  if (!isAgentEventName(name)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const d = parsed as Record<string, unknown>;

  // event_id 缺失是允许的（例如手动 /internal 注入的边角情况），退化成 0 表示
  // 「不参与续传计算」，而不是把整帧丢掉。
  const eventId = num(d.event_id) ?? 0;

  switch (name) {
    case "message.delta": {
      const text = str(d.text);
      if (text === undefined) return null;
      return { name, event_id: eventId, data: { text } };
    }
    case "reasoning.delta": {
      const text = str(d.text);
      if (text === undefined) return null;
      return { name, event_id: eventId, data: { text } };
    }
    case "tool.invoke": {
      const tool = str(d.tool);
      if (!tool) return null;
      return { name, event_id: eventId, data: { tool, args_summary: str(d.args_summary) } };
    }
    case "tool.progress": {
      const tool = str(d.tool);
      const done = num(d.done);
      const total = num(d.total);
      // 进度帧必须自洽：有工具名、done/total 为有限数、total>0、done 非负。
      // 任一不满足直接丢弃（宁可不显示进度，也不显示假的 X/N）。
      if (!tool || done === undefined || total === undefined || total <= 0 || done < 0) return null;
      const label = str(d.label);
      return { name, event_id: eventId, data: { tool, done, total, ...(label ? { label } : {}) } };
    }
    case "tool.result": {
      const tool = str(d.tool);
      if (!tool) return null;
      const rawErr = d.error as
        | { code?: unknown; human_message?: unknown; message?: unknown; action_required?: unknown; root?: unknown; reason?: unknown; options?: unknown }
        | undefined;
      const error =
        rawErr && typeof rawErr === "object"
          ? {
              code: str((rawErr as { code?: unknown }).code),
              message: str(rawErr.message),
              human_message: str(rawErr.human_message),
              action_required: str((rawErr as { action_required?: unknown }).action_required),
              root: str((rawErr as { root?: unknown }).root),
              reason: str((rawErr as { reason?: unknown }).reason),
              options: (rawErr as { options?: unknown }).options,
            }
          : undefined;
      // 授权载荷可能在 error 内，也可能在顶层（不同上游版本）；两处都收。
      const actionRequired = str(d.action_required) ?? error?.action_required;
      const authRoot = str(d.auth_root) ?? error?.root;
      const authReason = str(d.auth_reason) ?? error?.reason;
      const authOptions = parseAuthOptions(d.auth_options ?? error?.options);
      return {
        name,
        event_id: eventId,
        data: {
          tool,
          ok: d.ok === true,
          cost_coins: num(d.cost_coins),
          task_id: str(d.task_id),
          artifact_pending: d.artifact_pending === true,
          error,
          ...(actionRequired ? { action_required: actionRequired } : {}),
          ...(authRoot ? { auth_root: authRoot } : {}),
          ...(authReason ? { auth_reason: authReason } : {}),
          ...(authOptions.length > 0 ? { auth_options: authOptions } : {}),
          ...(d.binary === true ? { binary: true } : {}),
          ...(d.truncated === true ? { truncated: true } : {}),
          ...(num(d.bytes_read) !== undefined ? { bytes_read: num(d.bytes_read) } : {}),
          ...(num(d.bytes_total) !== undefined ? { bytes_total: num(d.bytes_total) } : {}),
          ...(str(d.preview) !== undefined ? { preview: str(d.preview) } : {}),
        },
      };
    }
    case "image.done": {
      const url = str(d.url);
      if (!url) return null;
      return { name, event_id: eventId, data: { url, cost_coins: num(d.cost_coins), task_id: str(d.task_id), recipe: recipe(d.recipe) } };
    }
    case "video.done": {
      const url = str(d.url);
      if (!url) return null;
      const mk = d.media_kind === "film" ? "film" : d.media_kind === "video" ? "video" : undefined;
      return { name, event_id: eventId, data: { url, cost_coins: num(d.cost_coins), task_id: str(d.task_id), ...(mk ? { media_kind: mk } : {}) } };
    }
    case "audio.done": {
      const url = str(d.url);
      if (!url) return null;
      const mk = d.media_kind === "music" ? "music" : d.media_kind === "audio" ? "audio" : undefined;
      // title / cover / lyric_status 是网关可选补栏位：可能还没落地（缺字段一律 undefined，
      // 不崩、不伪造）。空字串视同缺席，避免卡片渲染出空标题/破图。
      const title = str(d.title);
      const cover = str(d.cover);
      const lyricStatus = str(d.lyric_status);
      return {
        name,
        event_id: eventId,
        data: {
          url,
          cost_coins: num(d.cost_coins),
          task_id: str(d.task_id),
          ...(mk ? { media_kind: mk } : {}),
          ...(title ? { title } : {}),
          ...(cover ? { cover } : {}),
          ...(lyricStatus ? { lyric_status: lyricStatus } : {}),
        },
      };
    }
    case "image.failed": {
      // task_id 可能缺（防御性）：帧仍要送达，settler 按序兜底配对。
      return {
        name,
        event_id: eventId,
        data: { task_id: str(d.task_id), reason: str(d.reason), refunded: d.refunded === true, human_message: str(d.human_message) },
      };
    }
    case "director.done": {
      // 契约核心栏位 = session_id + revision（revision 是活卡替换的依据，缺失整帧丢弃）。
      // schematic/health/counts/plan/active_shot 全部走宽松解析：网关少送一律当
      // undefined/null 处理，坏帧不该让整条对话白屏。
      const sid = str(d.session_id);
      const revision = num(d.revision);
      if (!sid || revision === undefined) return null;
      const rawSchematic = d.schematic as Record<string, unknown> | undefined;
      const rawHealth = d.health as Record<string, unknown> | undefined;
      const rawCounts = d.counts as Record<string, unknown> | undefined;
      return {
        name,
        event_id: eventId,
        data: {
          session_id: sid,
          revision,
          action: str(d.action) ?? "",
          plan: directorPlan(d.plan),
          active_shot: directorActiveShot(d.active_shot),
          schematic: {
            top_view_svg: str(rawSchematic?.top_view_svg) ?? "",
            camera_view_svg: str(rawSchematic?.camera_view_svg) ?? "",
          },
          health: {
            ok: rawHealth?.ok === true,
            issues: directorIssues(rawHealth?.issues),
          },
          counts: {
            shots: num(rawCounts?.shots) ?? 0,
            elements: num(rawCounts?.elements) ?? 0,
            actions: num(rawCounts?.actions) ?? 0,
          },
        },
      };
    }
    case "turn.done":
      return { name, event_id: eventId, data: {} as AgentTurnDone };
    case "turn.status": {
      const text = str(d.text);
      if (text === undefined) return null;
      return { name, event_id: eventId, data: { text } };
    }
    case "context.compacted": {
      const trigger = d.trigger === "manual" ? "manual" : "auto";
      return { name, event_id: eventId, data: { trigger, preTokens: num(d.preTokens) } };
    }
    case "turn.plan": {
      // plan 是唯一必需栏位：空字串／缺栏位／非字串一律整帧丢弃（丢半张计画卡
      // 等于画一张空话卡）。其余栏位走白名单宽松解析，坏值折成 undefined 不 throw。
      const plan = str(d.plan);
      if (!plan || plan.trim().length === 0) return null;
      const experts = strArray(d.experts);
      // provisional 预设 true：只有明确 === false 才是 false（缺栏位当「还在进行中」，
      // 这是保守诚实的一侧——计画刚到时本来就还没定案）。
      const sup = d.superseded === true;
      const src = d.source === "model" || d.source === "rule" ? (d.source as "model" | "rule") : undefined;
      return {
        name,
        event_id: eventId,
        data: {
          plan,
          ...(experts ? { experts } : {}),
          provisional: d.provisional !== false,
          ...(src ? { source: src } : {}),
          ...(str(d.model) ? { model: str(d.model) } : {}),
          ...(sup ? { superseded: true } : {}),
        },
      };
    }
    case "confirm.request": {
      const requestId = str(d.request_id);
      const amount = num(d.amount_coins);
      if (!requestId || amount === undefined) return null;
      return { name, event_id: eventId, data: { request_id: requestId, amount_coins: amount, description: str(d.description) } };
    }
    case "confirm.resolved": {
      const requestId = str(d.request_id);
      if (!requestId) return null;
      return { name, event_id: eventId, data: { request_id: requestId, approved: d.approved === true } };
    }
    case "quota.changed": {
      const balance = num(d.balance_coins);
      return {
        name,
        event_id: eventId,
        data: {
          balance_coins: balance ?? null,
          currency: str(d.currency) ?? "coins",
          available: d.available === true,
          ...(typeof d.spendable === "boolean" ? { spendable: d.spendable } : {}),
          reason: str(d.reason),
        },
      };
    }
    case "session.error": {
      return {
        name,
        event_id: eventId,
        data: {
          code: str(d.code) ?? "backend_error",
          message: str(d.message) ?? "会话发生未知错误。",
          human_message: str(d.human_message),
        },
      };
    }
    case "session.closed":
      return { name, event_id: eventId, data: { reason: str(d.reason) } };
    case "canvas.plan":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          tool: str(d.tool) ?? "",
          label: str(d.label) ?? "",
          prompt: str(d.prompt) ?? "",
          model: str(d.model) ?? "",
          size: str(d.size) ?? "",
          count: num(d.count) ?? 1,
          kind: str(d.kind) ?? "image",
          source_image: str(d.source_image) ?? null,
          cost_hint: num(d.cost_hint) ?? null,
        },
      };
    case "canvas.node.created":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          node: (d.node as AgentCanvasNodeCreated["node"]) ?? { id: "", type: "", title: "" },
          ...(str(d.target_kind) ? { target_kind: str(d.target_kind) as "result" } : {}),
        },
      };
    case "canvas.node.updated":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          node_id: str(d.node_id) ?? "",
          patch: (d.patch as Record<string, unknown>) ?? {},
          ...(str(d.url) ? { url: str(d.url) } : {}),
          ...(num(d.cost_coins) !== undefined ? { cost_coins: num(d.cost_coins) } : {}),
        },
      };
    case "canvas.node.connected":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          connection: (d.connection as AgentCanvasNodeConnected["connection"]) ?? { id: "", fromNodeId: "", toNodeId: "" },
          ...(str(d.target_kind) ? { target_kind: str(d.target_kind) as "result" } : {}),
        },
      };
    case "canvas.node.generating":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          node_id: str(d.node_id) ?? "",
          status: str(d.status) ?? "running",
          ...(num(d.progress) !== undefined ? { progress: num(d.progress) } : {}),
        },
      };
    case "canvas.node.deleted":
      return { name, event_id: eventId, data: { unit_id: str(d.unit_id) ?? "", ...(str(d.node_id) ? { node_id: str(d.node_id) } : {}) } };
    case "canvas.node.disconnected":
      return { name, event_id: eventId, data: { unit_id: str(d.unit_id) ?? "", from: str(d.from) ?? "", to: str(d.to) ?? "" } };
    case "canvas.derive.started":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          source_node_id: str(d.source_node_id) ?? "",
          instruction: str(d.instruction) ?? "",
          ...(str(d.interpretation) ? { interpretation: str(d.interpretation) } : {}),
        },
      };
    case "canvas.budget.updated":
      return {
        name,
        event_id: eventId,
        data: {
          ...(str(d.unit_id) ? { unit_id: str(d.unit_id) } : {}),
          used_coins: num(d.used_coins) ?? 0,
          remaining_coins: num(d.remaining_coins) ?? 0,
        },
      };
    case "canvas.ops": {
      const requestId = str(d.request_id);
      const ops = d.ops;
      if (!requestId || !Array.isArray(ops)) return null;
      return {
        name,
        event_id: eventId,
        data: {
          request_id: requestId,
          ops: ops as CanvasAgentOpsEvent["ops"],
          ...(str(d.label) ? { label: str(d.label) } : {}),
        },
      };
    }
    case "subagent.started": {
      const id = str(d.id);
      if (!id) return null;
      return { name, event_id: eventId, data: { id, label: str(d.label) ?? "子任务" } };
    }
    case "subagent.delta": {
      const id = str(d.id);
      if (!id) return null;
      // kind 白名单单值：只认 "reasoning"（思维链）；其余（含缺省）一律当正文。
      // 认不得的值折成 undefined 而不是整帧丢弃——宁可少一个活动字，不少一段交付物。
      const kind = d.kind === "reasoning" ? ("reasoning" as const) : undefined;
      return { name, event_id: eventId, data: { id, text: str(d.text) ?? "", ...(kind ? { kind } : {}) } };
    }
    case "subagent.done": {
      const id = str(d.id);
      // status 是核心栏位：不属于合同值域的帧不合合同，整帧丢弃。
      // stopped＝人工停止成功（2026-09-20 gateway 契约），同为合法核心栏位。
      const status =
        d.status === "ok"
          ? ("ok" as const)
          : d.status === "error"
            ? ("error" as const)
            : d.status === "stopped"
              ? ("stopped" as const)
              : undefined;
      if (!id || !status) return null;
      return { name, event_id: eventId, data: { id, status, summary: str(d.summary) } };
    }
    case "subagent.tool": {
      const id = str(d.id);
      const callId = str(d.call_id);
      const tool = str(d.tool);
      // id / call_id / tool 必须是非空字串，status 必须是合同三值之一；
      // 任一不满足整帧丢弃（既有「宁缺勿假·非法帧一律丢弃」纪律）。
      const status =
        d.status === "running"
          ? ("running" as const)
          : d.status === "ok"
            ? ("ok" as const)
            : d.status === "failed"
              ? ("failed" as const)
              : undefined;
      if (!id || !callId || !tool || !status) return null;
      return { name, event_id: eventId, data: { id, call_id: callId, tool, status } };
    }
    case "question.request": {
      const requestId = str(d.request_id);
      const questions = parseQuestionItems(d.questions);
      if (!requestId || !questions) return null;
      return { name, event_id: eventId, data: { request_id: requestId, questions } };
    }
    case "question.replied": {
      const requestId = str(d.request_id);
      if (!requestId) return null;
      return { name, event_id: eventId, data: { request_id: requestId, answer: str(d.answer) ?? "" } };
    }
    case "question.rejected": {
      const requestId = str(d.request_id);
      if (!requestId) return null;
      return { name, event_id: eventId, data: { request_id: requestId, reason: str(d.reason) ?? "" } };
    }
    case "steer.status": {
      const steerId = str(d.steer_id);
      const status = parseSteerStatus(d.status);
      // 核心栏位（id + 状态）缺一即整帧丢弃：认不得的状态宁可不上屏，不猜。
      if (!steerId || !status) return null;
      const position = num(d.position);
      return {
        name,
        event_id: eventId,
        data: {
          steer_id: steerId,
          status,
          ...(typeof position === "number" ? { position } : {}),
          ...(str(d.text) ? { text: str(d.text) } : {}),
          ...(str(d.reason) ? { reason: str(d.reason) } : {}),
        },
      };
    }
  }
}

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

function parseSteerStatus(raw: unknown): AgentSteerStatus | undefined {
  return typeof raw === "string" && (AGENT_STEER_STATUSES as readonly string[]).includes(raw)
    ? (raw as AgentSteerStatus)
    : undefined;
}

function parseQuestionItems(raw: unknown): AgentQuestionRequest["questions"] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: AgentQuestionRequest["questions"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const rec = item as Record<string, unknown>;
    const question = str(rec.question);
    if (!question) return null;
    const optionsRaw = rec.options;
    const options: Array<{ label: string; description?: string }> = [];
    if (Array.isArray(optionsRaw)) {
      for (const opt of optionsRaw) {
        if (!opt || typeof opt !== "object") continue;
        const label = str((opt as Record<string, unknown>).label);
        if (!label) continue;
        const description = str((opt as Record<string, unknown>).description);
        options.push(description ? { label, description } : { label });
      }
    }
    const header = str(rec.header);
    out.push(header ? { question, header, options } : { question, options });
  }
  return out.length > 0 ? out : null;
}

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

// ─────────────────────────── 会话全量历史（GET /api/agent/sessions/[id]）
//
// 网关契约（2026-09-12，另一端并行施工中，本端按此写代码）：
//   { "messages": [<opencode 原始讯息阵列>], "event_counter": <int>,
//     "replay_first_id": <int|null>, "fallback"?: "replay_only" }
//
// opencode 讯息 shape 为 [{info:{id,role,time,tokens},parts:[...]}]，parts
// 是异质阵列（text/reasoning/tool/file，新旧版本还有 step-start 等内部片段），
// 栏位不保证存在——传输层只守「messages 是阵列、event_counter 是有限数」，
// 逐 part 的防呆全部交给 normalizeOpenCodeMessages（跳过不炸、丢弃计数）。

/** opencode 单则讯息的 info。只声明归一化要用、且语义确定的栏位，其余容错。 */
export interface OpenCodeMessageInfo {
  id?: string;
  /** "user" | "assistant"；脏资料可能缺，型别放宽为 string。 */
  role?: string;
  /** epoch 毫秒；time.completed=null 表示这轮还在跑。 */
  time?: { created?: number; completed?: number | null };
  tokens?: Record<string, unknown>;
}

/** opencode 单则讯息：parts 元素形态不一，交由归一化逐个判型。 */
export interface OpenCodeMessage {
  info?: OpenCodeMessageInfo;
  parts?: unknown[];
}

/** 全量历史端点的响应契约（client 已做最小校验后的形状）。 */
export interface AgentSessionHistoryResponse {
  messages: OpenCodeMessage[];
  /** 网关当前事件计数，等价于 SSE 续传游标：重建已涵盖 ≤ counter 的一切。 */
  event_counter: number;
  /** ring buffer 首帧 id；null = 缓冲空。仅供排障参考，重建路径不依赖它。 */
  replay_first_id: number | null;
  /** 网关取不到全量历史、降级为仅 ring 回放时的标记：客户端应放弃重建走全量回放。 */
  fallback?: "replay_only";
}
