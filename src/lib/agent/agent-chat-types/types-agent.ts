// ─────────────────────────── 子代理运行与实时转录（网关契约 2026-10-18）
//
// GET /agent/v1/sessions/:id/subagents         → { object, subagents: AgentSubagentRunSummary[] }
// GET /agent/v1/sessions/:id/subagents/:runId  → AgentSubagentTranscriptPage
// POST /agent/v1/sessions/:id/subagents/:runId/stop → { ok:true } | 409 { ok:false, code:"not_running" }
//
// 栏位名是后端合同本身，前端不得另起别名；runId 只是 URL 参数语义（即 summary.id）。

/** 一次子代理工具调用的运行记录（列表端点 tools[]）。 */
export interface AgentSubagentRunTool {
  call_id: string;
  tool: string;
  status: "running" | "ok" | "failed";
  at: number;
  ended_at?: number;
}

/** 子代理产出的附件引用（列表端点 artifacts[]）。 */
export interface AgentSubagentRunArtifact {
  kind: string;
  url: string;
}

/** 转录可用性（列表端点 transcript）。 */
export interface AgentSubagentRunTranscriptInfo {
  available: boolean;
  bytes: number;
  truncated: boolean;
}

/** 列表端点里的一个子代理运行。 */
export interface AgentSubagentRunSummary {
  id: string;
  label: string;
  agent: string;
  status: "running" | "ok" | "error" | "stopped";
  started_at: number;
  last_activity_at: number;
  elapsed_ms: number;
  silent_ms: number;
  tool?: string;
  pending_tools?: number;
  tools: AgentSubagentRunTool[];
  artifacts: AgentSubagentRunArtifact[];
  summary?: string;
  transcript: AgentSubagentRunTranscriptInfo;
}

/**
 * 转录流里的一行。字段随 k 变化，形状即网关合同：
 * text→s（长正文切块时续块带 cont:true，首块不带）；
 * tool→id,name,status；artifact→kind,url；note→name,s；end→status,summary。
 */
export type AgentSubagentTranscriptEntry =
  | { t: number; k: "meta" }
  | { t: number; k: "text"; s: string; cont?: boolean }
  | { t: number; k: "tool"; id: string; name: string; status: "running" | "ok" | "failed" }
  | { t: number; k: "artifact"; kind: string; url: string }
  | { t: number; k: "note"; name: string; s: string }
  | { t: number; k: "end"; status: "running" | "ok" | "error" | "stopped"; summary?: string };

/** 转录分页回应：续拉只认 next_offset，eof 为真后不再请求。 */
export interface AgentSubagentTranscriptPage {
  object: string;
  run_id: string;
  entries: AgentSubagentTranscriptEntry[];
  next_offset: number;
  truncated: boolean;
  eof: boolean;
  size: number;
}
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
