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
  | { kind: 'image'; id: string; url: string; costCoins?: number; taskId?: string; seq: number }
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
