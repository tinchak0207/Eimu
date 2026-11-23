/** 小程序端可渲染条目（字段照网页端 reducer 的判别联合裁到本页要用的子集）。 */
export type AgentItem =
  | {
      kind: 'user'
      id: string
      text: string
      /** REQ-D2：回合中追加的指引（steer）状态徽章（steer.status 帧回填）。 */
      steer?: { id: string; status: AgentSteerStatus; position?: number }
    }
  | {
      kind: 'assistant'
      id: string
      text: string
      reasoning?: string
      reasoningStartedAt?: number
      reasoningMs?: number
      streaming?: boolean
    }
  | {
      kind: 'plan'
      id: string
      text: string
      experts?: string[]
      provisional?: boolean
      collapsed?: boolean
    }
  | {
      kind: 'tool'
      id: string
      tool: string
      /** 派遣子代理时绑定的子代理 id（subagent.started 回填，types-core.ts:89-90）。 */
      subagentId?: string
      /** tool.invoke.args_summary：锚定卡据此念回参数（types-core.ts:91）。 */
      argsSummary?: string
      status: 'running' | 'pending' | 'ok' | 'failed' | 'needs_auth'
      progress?: { done: number; total: number; label?: string }
      error?: string
      errorCode?: string
      costCoins?: number
      taskId?: string
      /** 本机档案授权载荷（types-core.ts:113-132）。小程序只渲染、按钮置灰。 */
      authorization?: AgentToolAuthorization
      binary?: boolean
      readBytes?: number
      totalBytes?: number
      truncated?: boolean
    }
  | { kind: 'image'; id: string; url: string; costCoins?: number; taskId?: string; seq: number; recipe?: { prompt?: string; model?: string; size?: string; lora?: string } }
  | {
      kind: 'video'
      id: string
      url: string
      costCoins?: number
      taskId?: string
      mediaKind?: 'video' | 'film'
      seq: number
    }
  | {
      kind: 'audio'
      id: string
      url: string
      costCoins?: number
      taskId?: string
      mediaKind?: 'audio' | 'music'
      title?: string
      cover?: string
      lyricStatus?: string
      seq: number
    }
  | {
      kind: 'director'
      id: string
      directorSessionId: string
      revision: number
      action: string
      plan: AgentDirectorPlan | null
      activeShot: AgentDirectorShot | null
      schematic: { top_view_svg: string; camera_view_svg: string }
      health: { ok: boolean; issues: Array<{ code: string; message: string; shot_id?: string }> }
      counts: { shots: number; elements: number; actions: number }
    }
  | {
      kind: 'notice'
      id: string
      tone: 'info' | 'error'
      text: string
      /** 连续同类通知合并的键（types-core.ts:194）。 */
      dedupeKey?: string
      count?: number
    }
  | {
      kind: 'subagent'
      id: string
      subagentId: string
      label: string
      lastLine: string
      activity?: string
      text?: string
      status: 'running' | 'ok' | 'error' | 'stopped'
      summary?: string
      tools?: AgentSubagentToolEntry[]
    }
  | {
      kind: 'subagent_result'
      id: string
      subagentId: string
      label: string
      status: 'ok' | 'error' | 'interrupted' | 'stopped'
      text: string
    }

export type AgentSteerStatus =
  | 'queued'
  | 'injected'
  | 'applied'
  | 'aborted'
  | 'failed'
  | 'uncertain'

/** 本机文件授权范围（types-events.ts:169）。 */
export type AgentToolAuthScope = 'once' | 'session' | 'permanent'

export interface AgentToolAuthorization {
  root?: string
  reason?: string
  actionRequired?: string
  options: AgentToolAuthScope[]
}

export interface AgentSubagentToolEntry {
  callId: string
  tool: string
  status: 'running' | 'ok' | 'failed'
}

export interface AgentDirectorPlan {
  id: string
  name: string
  summary: string
  shot_count: number
}

export interface AgentDirectorShot {
  no: number
  name: string
  duration_frames: number
  camera_move: string
  shot_scale: string | null
}

export interface AgentPendingConfirm {
  requestId: string
  amountCoins: number
  description?: string
  resolving?: boolean
}

export interface AgentQuestionOption {
  label: string
  description?: string
}

export interface AgentQuestionItem {
  question: string
  header?: string
  options: AgentQuestionOption[]
}

/** 待回答的 opencode question（types-core.ts:279-283）。 */
export interface AgentPendingQuestion {
  requestId: string
  questions: AgentQuestionItem[]
  seq: number
}

export type AgentConnection = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export type ThinkingLevel = 'low' | 'medium' | 'high' | 'extreme'

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  extreme: '极限',
}

export const THINKING_LEVEL_HINTS: Record<ThinkingLevel, string> = {
  low: '更快、更省，适合简单需求',
  medium: '速度与质量兼顾',
  high: '先充分思考再动手，更全面',
  extreme: '最高质量、开启野兽模式',
}

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
