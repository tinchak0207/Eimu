// 小程序端 Agent 会话客户端：建会话 / 列会话 / 发消息 / 确认 / SSE 流 / 轮询兜底。
//
// 契约唯一真源是网页端（照抄、不发明）：
//   src/lib/agent-chat-client/transport.ts       requestSseTicket / buildEventsUrl
//   src/lib/agent-chat-client/session.ts         create / list / send / confirm / history
//   src/lib/agent-chat-types/types-events.ts     SSE 事件名与 data 字段
//
// 小程序没有 EventSource：用 Taro.request({ enableChunked: true }) 拿原始 chunk，
// 由本档自己完成「增量 UTF-8 解码 → SSE 分帧 → JSON 解析」。任何一帧脏数据
// 都只丢该帧，绝不让整条流崩掉。
//
// 本档是纯 TS：不 import React、不碰 DOM/window/document。唯一的平台依赖是
// Taro（网络与定时器在全局可用），便于页面层复用。

import Taro from '@tarojs/taro'
import { consumeTemporaryArmed, markSessionTemporary, setTemporaryArmed } from './agent-temporary-chat'
import { ApiError, BASE_URL, request } from './request'
import { getToken, getUserId } from './storage'
import { normalizeOpenCodeMessages, type OpenCodeMessage } from './agent-history-normalize'
import {
  agentThinkingLevelPatch,
  getAgentSettings,
  readCachedAgentSettings,
  resolveAgentThinkingLevel,
  serverAgentThinkingLevel,
  saveAgentSettings,
  writeCachedAgentThinkingLevel,
  type AgentThinkingLevel,
} from './agent-settings'
import {
  loadSessionTitleOverrides,
  removeSessionTitleOverride,
  saveSessionTitleOverride,
} from './agent-persistence'
import type {
  AgentDirectorPlan,
  AgentDirectorShot,
  AgentItem,
  AgentPendingQuestion,
  AgentQuestionItem,
  AgentSteerStatus,
  AgentSubagentToolEntry,
  AgentToolAuthScope,
} from '../components/agent-chat/types'

// ─────────────────────────── 常量

/** 兜底轮询间隔（与网页端轮询手感一致，800ms）。 */
export const AGENT_POLL_INTERVAL_MS = 800

/** 断线重连退避：1s / 2s / 4s，最多 3 次。 */
const SSE_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000]

/**
 * 首包看门狗：连上后这么久既没有响应头也没有 chunk，判定这条链路在小程序里
 * 不可用（例如平台忽略了 enableChunked），交给页面转轮询。
 */
const SSE_FIRST_RESPONSE_TIMEOUT_MS = 12_000

/**
 * 单条 SSE 请求的存活上限。网关会长时间保持连接，10 分钟后主动断开对我们
 * 无害：断开即按 last_event_id 续传重连，不丢事件。
 */
const SSE_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000

/** 单帧缓冲上限：超过即视为脏流丢弃，防止内存被半帧撑爆。 */
const SSE_MAX_BUFFER_CHARS = 256 * 1024

// ─────────────────────────── 会话与消息

export type AgentSessionStatus = 'running' | 'waiting' | 'idle'

export interface AgentSessionSummary {
  session_id: string
  title?: string
  /** 网关 sessions.status 契约：running | waiting | idle（缺省按 idle）。 */
  status?: AgentSessionStatus
  created_at?: string | number
  /** 最后一次活动时间（相对时间与状态点的显示依据）。 */
  last_activity_at?: string | number
  updated_at?: string | number
}

/** 子代理日志与停止契约逐行复用网页版 session.ts，网络替换为 Taro request。 */
export async function listAgentSubagents(sessionId: string): Promise<import('../components/agent-chat/types').AgentSubagentRunSummary[]> {
  const data = await request<{ subagents?: unknown }>({ path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/subagents` })
  if (!Array.isArray(data.subagents)) return []
  return data.subagents.filter((item): item is import('../components/agent-chat/types').AgentSubagentRunSummary =>
    !!item && typeof item === 'object' && typeof item.id === 'string')
}

export async function readAgentSubagentTranscript(sessionId: string, runId: string, offset?: number): Promise<import('../components/agent-chat/types').AgentSubagentTranscriptPage> {
  const base = typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  const query = typeof offset === 'number' && Number.isFinite(offset) ? `?offset=${base}` : ''
  const data = await request<Record<string, unknown>>({ path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(runId)}${query}` })
  if (!Array.isArray(data.entries)) throw new ApiError('服务器未返回有效的子代理日志。', 0, 'parse_error')
  const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
  return {
    object: typeof data.object === 'string' ? data.object : '',
    run_id: typeof data.run_id === 'string' ? data.run_id : runId,
    entries: data.entries as import('../components/agent-chat/types').AgentSubagentTranscriptEntry[],
    next_offset: number(data.next_offset) ?? base + data.entries.length,
    truncated: data.truncated === true, eof: data.eof === true, size: number(data.size) ?? 0,
  }
}

export async function stopAgentSubagent(sessionId: string, runId: string): Promise<void> {
  await request({ path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(runId)}/stop`, method: 'POST' })
}

/**
 * 列出当前用户的历史会话（服务端按 updated_at 降序，首个即最近会话）。
 * 服务端标题是真源；本地别名只在服务端标题缺失时补位（账号隔离，见 agent-persistence）。
 */
export async function listAgentSessions(): Promise<AgentSessionSummary[]> {
  const data = await request<Record<string, unknown>>({ path: '/api/agent/sessions' })
  const raw = data?.sessions
  if (!Array.isArray(raw)) return []
  const overrides = loadSessionTitleOverrides()
  return raw
    .filter(
      (item): item is AgentSessionSummary =>
        typeof item === 'object' && item !== null && typeof (item as AgentSessionSummary).session_id === 'string',
    )
    .map((item) => {
      const local = overrides[item.session_id]
      return local && !item.title ? { ...item, title: local } : item
    })
}

/** 建一个 agent 会话，回传 session_id（解析方式与网页端 session.ts:97 一致）。 */
export async function createAgentSession(): Promise<string> {
  const temporary = consumeTemporaryArmed()
  let data: Record<string, unknown>
  try {
    data = await request({ path: '/api/agent/sessions', method: 'POST', data: temporary ? { temporary: true } : {} })
  } catch (error) {
    if (temporary) setTemporaryArmed(true)
    throw error
  }
  const sessionId = typeof data?.session_id === 'string' ? data.session_id : ''
  if (!sessionId) {
    if (temporary) setTemporaryArmed(true)
    throw new ApiError('服务器未返回有效的会话 id', 0, 'parse_error')
  }
  if (temporary) markSessionTemporary(sessionId)
  return sessionId
}

/** 会话记忆补注：resume/switch 的老会话补上账户画像（best-effort，失败不打扰）。 */
export async function patchAgentSessionMemory(sessionId: string): Promise<void> {
  try {
    await request({
      path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/memory`,
      method: 'POST',
      data: {},
    })
  } catch {
    // 补不上就算了：下一次建新会话时记忆仍会正常注入。
  }
}

/** 删掉会话，释放上游资源（404 视同已删除，与站点代理的幂等语义一致）。 */
export async function deleteAgentSession(sessionId: string): Promise<void> {
  try {
    await request({
      path: `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
      method: 'DELETE',
    })
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error
  }
  removeSessionTitleOverride(sessionId)
}

/**
 * 重命名会话。
 *
 * 真源端点尚不存在（站点代理 /api/agent/sessions/[id] 只导出 GET/DELETE，
 * 网关无 PATCH），所以先尝试 PATCH；404/405/501（路由未实现）时落回
 * 账号级别的本地标题别名——服务端历史真源不变，只补列表显示。
 * 标题空白＝拒绝（与「清空标题」区分开，清空请用空字串以外的显式删除）。
 */
export async function renameAgentSession(sessionId: string, title: string): Promise<void> {
  const trimmed = title.trim()
  if (!sessionId) throw new ApiError('缺少会话 id', 0, 'bad_request')
  if (!trimmed) throw new ApiError('标题不能为空', 0, 'bad_request')
  try {
    await request({
      path: `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
      method: 'PATCH',
      data: { title: trimmed },
    })
    // 服务端已接受：本地别名不再需要。
    removeSessionTitleOverride(sessionId)
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    const unsupported =
      error.status === 404 || error.status === 405 || error.status === 501 || error.code === 'http_405'
    if (!unsupported) throw error
    saveSessionTitleOverride(sessionId, trimmed)
  }
}

/** 斜杠技能上下文：`name` 来自 SkillSlashMenu（applySkillPick 写入 `/name `）。 */
export type AgentSkillContext = string | { name: string; argument?: string }

export interface SendMessageOptions {
  /** 技能上下文：发送时补 `/name ` 前缀（已是斜杠开头的正文不重复加）。 */
  skill?: AgentSkillContext
  /** 隐形引导词：网关拼进 system 注入，不进 transcript（session.ts:135）。 */
  sessionDirective?: string
}

/** 把技能上下文合成正文前缀；不是技能命令时原样返回正文。 */
export function composeSkillContent(content: string, skill?: AgentSkillContext): string {
  const text = content.trim()
  const raw = typeof skill === 'string' ? skill : skill?.name
  const name = (raw ?? '').trim().replace(/^\/+/, '')
  if (!name) return text
  if (text.startsWith(`/${name}`)) return text
  const argument = typeof skill === 'object' && skill?.argument ? skill.argument.trim() : ''
  const tail = text || argument
  return tail ? `/${name} ${tail}` : `/${name}`
}

/** 送一条对话消息（中继路径；小程序不用网页端的网关直连腿，少一套凭证分叉）。 */
export async function sendAgentMessage(
  sessionId: string,
  content: string,
  options?: SendMessageOptions | string,
): Promise<void> {
  // 第三参数允许直接传技能名（另一路 agent 的斜杠菜单可能按位置参数调用）。
  const opts: SendMessageOptions | undefined = typeof options === 'string' ? { skill: options } : options
  const trimmed = composeSkillContent(content, opts?.skill)
  if (!trimmed) return
  const body: Record<string, unknown> = { content: trimmed, client_environment: { surface: 'web', local_capabilities: { window_eimu_local: false, local_save: false } } }
  if (typeof opts?.sessionDirective === 'string' && opts.sessionDirective.trim().length > 0) {
    body.session_directive = opts.sessionDirective
  }
  await request({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`,
    method: 'POST',
    data: body,
  })
}

/** 回合中追加指引：queued 与 injected 由网关回执决定，未知响应绝不伪装成功。 */
export type AgentSteerAck =
  | { status: 'injected'; steer_id: string; injected_into?: string[] }
  | { status: 'queued'; steer_id: string; position?: number; deduped?: boolean }
export async function steerAgentSession(sessionId: string, content: string, options?: { steerId?: string }): Promise<AgentSteerAck> {
  const data = await request<Record<string, unknown>>({ path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/steer`, method: 'POST', data: { content: content.trim(), ...(options?.steerId ? { steer_id: options.steerId } : {}) } })
  const steer_id = typeof data.steer_id === 'string' ? data.steer_id : options?.steerId ?? ''
  if (data.status === 'injected') return { status: 'injected', steer_id, ...(Array.isArray(data.injected_into) ? { injected_into: data.injected_into.filter((x): x is string => typeof x === 'string') } : {}) }
  if (data.status === 'queued') return { status: 'queued', steer_id, ...(typeof data.position === 'number' && Number.isFinite(data.position) ? { position: data.position } : {}), ...(data.deduped === true ? { deduped: true } : {}) }
  throw new ApiError('服务器未返回有效的引导状态。', 0, 'parse_error')
}

// 对外导出名（另一路 agent 依赖的稳定签名）。
export const listSessions = listAgentSessions
export const createSession = createAgentSession
export const renameSession = renameAgentSession
export const deleteSession = deleteAgentSession
export const sendMessage = sendAgentMessage

/** 回复一次花费确认（body 形状照 session.ts:234）。 */
export async function resolveAgentConfirm(
  sessionId: string,
  requestId: string,
  approved: boolean,
): Promise<void> {
  await request({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/confirm`,
    method: 'POST',
    data: { request_id: requestId, approved },
  })
}

// ─────────────────────────── SSE 票据

export interface AgentSseTicket {
  ticket: string
  events_url: string
  expires_in_ms?: number
}

/** 取 SSE 只读票；events_url 的主机是 Agent 网关，必须原样使用。 */
export async function requestSseTicket(sessionId: string): Promise<AgentSseTicket> {
  const data = await request<Record<string, unknown>>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/sse-ticket`,
    method: 'POST',
    data: {},
  })
  const ticket = typeof data?.ticket === 'string' ? data.ticket : ''
  const eventsUrl = typeof data?.events_url === 'string' ? data.events_url : ''
  if (!ticket || !eventsUrl) throw new ApiError('服务器未返回有效的 SSE ticket', 0, 'parse_error')
  return {
    ticket,
    events_url: eventsUrl,
    expires_in_ms: typeof data.expires_in_ms === 'number' ? data.expires_in_ms : undefined,
  }
}

/**
 * 组出带 ticket 与续传游标的 SSE URL（照 transport.ts:215 的语义）。
 *
 * 不用 URL 构造器：小程序运行时不一定有 URL；这里按字符串拼，语义与网页端
 * 等价——last_event_id 为 0 也照样带上（网关靠它区分「从头回放」与「不回放」）。
 */
export function buildEventsUrl(eventsUrl: string, ticket: string, lastEventId?: number): string {
  const params = [`ticket=${encodeURIComponent(ticket)}`]
  if (typeof lastEventId === 'number' && Number.isFinite(lastEventId)) {
    params.push(`last_event_id=${Math.max(0, Math.floor(lastEventId))}`)
  }
  const hashIndex = eventsUrl.indexOf('#')
  const base = hashIndex >= 0 ? eventsUrl.slice(0, hashIndex) : eventsUrl
  const separator = base.indexOf('?') >= 0 ? '&' : '?'
  return `${base}${separator}${params.join('&')}`
}

// ─────────────────────────── 历史（初始载入 + 轮询兜底共用）

export interface AgentHistoryMessage {
  role: 'user' | 'assistant'
  text: string
}

/** 全量历史快照：items 已按 opencode 原始 shape 忠实归一化（见 agent-history-normalize）。 */
export interface AgentHistorySnapshot {
  /** 可直接渲染的 transcript 条目（真源归一化，不是简化的 role/text）。 */
  items: AgentItem[]
  /** 原始 opencode messages（轮询签名比对 / 排障用）。 */
  messages: OpenCodeMessage[]
  /** 网关当前事件计数：等价于 SSE 续传游标（>= 它的帧已在历史里）。 */
  eventCounter: number
  replayFirstId: number | null
  /** replay_only＝网关明说全量历史不可得（调用方应按降级路径处理）。 */
  fallback?: 'replay_only'
  /** 被归一化层丢弃的 part 数（排障观测用）。 */
  droppedParts: number
}

/**
 * 把 opencode 原始 messages 归一化成最小 role/text 视图（旧接口，保留兼容）。
 * 新的渲染路径请直接用 fetchAgentHistory().items。
 */
export function parseHistoryMessages(raw: unknown): AgentHistoryMessage[] {
  if (!Array.isArray(raw)) return []
  const out: AgentHistoryMessage[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { info?: unknown; parts?: unknown }
    const info = record.info && typeof record.info === 'object' ? (record.info as { role?: unknown }) : null
    const role = info?.role
    if (role !== 'user' && role !== 'assistant') continue
    const parts = Array.isArray(record.parts) ? record.parts : []
    let text = ''
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const piece = part as { type?: unknown; text?: unknown }
      if (piece.type === 'text' && typeof piece.text === 'string') text += piece.text
    }
    const trimmed = text.trim()
    if (!trimmed) continue
    out.push({ role, text: trimmed })
  }
  return out
}

/**
 * 拉一次会话全量历史（GET /api/agent/sessions/{id}）。
 *
 * 契约：{ messages, event_counter, replay_first_id, fallback?:"replay_only" }。
 * messages / event_counter 不合契约即抛 parse_error（调用方降级）；
 * 逐 part 的脏数据由归一化层吞掉并计数，不炸整份历史。
 */
export async function fetchAgentHistory(sessionId: string): Promise<AgentHistorySnapshot> {
  const data = await request<Record<string, unknown>>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
  })
  if (!Array.isArray(data?.messages)) {
    throw new ApiError('服务器未返回有效的历史消息', 0, 'parse_error')
  }
  const counter = data.event_counter
  if (typeof counter !== 'number' || !Number.isFinite(counter) || counter < 0) {
    throw new ApiError('服务器未返回有效的事件游标', 0, 'parse_error')
  }
  const messages = data.messages as OpenCodeMessage[]
  const normalized = normalizeOpenCodeMessages(messages)
  const replayFirst = data.replay_first_id
  return {
    items: normalized.items,
    messages,
    eventCounter: counter,
    replayFirstId: typeof replayFirst === 'number' && Number.isFinite(replayFirst) ? replayFirst : null,
    ...(data.fallback === 'replay_only' ? { fallback: 'replay_only' as const } : {}),
    droppedParts: normalized.droppedParts,
  }
}

// ─────────────────────────── 增量 UTF-8 解码

type Utf8ChunkDecoder = (chunk: ArrayBuffer) => string

/**
 * 建一个跨 chunk 有状态的 UTF-8 解码器。
 *
 * 优先 TextDecoder(stream:true)；小程序运行时没有 TextDecoder（或构造失败）
 * 时退回手写解码。两种实现都必须把「被切在两个 chunk 之间的多字节字符」
 * 留到下一块再拼，否则中文会随机变成 U+FFFD。
 */
export function createUtf8Decoder(): Utf8ChunkDecoder {
  const ctor = (globalThis as unknown as { TextDecoder?: new (label?: string) => TextDecoderLike }).TextDecoder
  if (typeof ctor === 'function') {
    try {
      const decoder = new ctor('utf-8')
      return (chunk: ArrayBuffer) => decoder.decode(new Uint8Array(chunk), { stream: true })
    } catch {
      // 构造失败（老运行时）→ 用下面的手写解码。
    }
  }

  let pending: number[] = []

  return (chunk: ArrayBuffer): string => {
    const incoming = new Uint8Array(chunk)
    let bytes: Uint8Array
    if (pending.length > 0) {
      bytes = new Uint8Array(pending.length + incoming.length)
      bytes.set(pending, 0)
      bytes.set(incoming, pending.length)
      pending = []
    } else {
      bytes = incoming
    }

    let out = ''
    let i = 0
    while (i < bytes.length) {
      const b0 = bytes[i]
      if (b0 < 0x80) {
        out += String.fromCharCode(b0)
        i += 1
        continue
      }
      let need = 0
      let codePoint = 0
      if (b0 >= 0xc2 && b0 <= 0xdf) {
        need = 1
        codePoint = b0 & 0x1f
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        need = 2
        codePoint = b0 & 0x0f
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        need = 3
        codePoint = b0 & 0x07
      } else {
        // 非法首字节（含落单的延续字节）：替换符，前进一格。
        out += '\ufffd'
        i += 1
        continue
      }
      // 序列被切在块尾：整段留到下一块（这正是多字节字符跨 chunk 的解法）。
      if (i + need >= bytes.length) break
      let valid = true
      for (let k = 1; k <= need; k += 1) {
        const b = bytes[i + k]
        if ((b & 0xc0) !== 0x80) {
          valid = false
          break
        }
        codePoint = (codePoint << 6) | (b & 0x3f)
      }
      if (!valid) {
        out += '\ufffd'
        i += 1
        continue
      }
      if (codePoint <= 0xffff) {
        out += String.fromCharCode(codePoint)
      } else {
        const v = codePoint - 0x10000
        out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
      }
      i += need + 1
    }

    if (i < bytes.length) pending = Array.from(bytes.slice(i))
    // 残缺字节长期拼不起来说明流已损坏：丢掉并补一个替换符，避免无限囤积。
    if (pending.length > 8) {
      pending = []
      out += '\ufffd'
    }
    return out
  }
}

interface TextDecoderLike {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string
}

// ─────────────────────────── SSE 分帧

export interface SseRawFrame {
  name: string
  /** 帧里的 `id:` 游标；缺失为 null。 */
  id: number | null
  /** 多行 `data:` 已用换行拼接。 */
  data: string
}

/**
 * 建一个有状态的 SSE 分帧器。
 *
 * 规则（EventSource 规范的子集，够用且不猜）：
 *   - 空行分帧；`\r\n`、`\n`、`\r` 三种换行都认，且允许换行被切在两个 chunk 之间；
 *   - 每帧收集 `event:` / `data:` / `id:`；以 `:` 开头的行是注释，忽略；
 *   - `data:` 多行用 `\n` 拼接（JSON 只会是单行，但多行不该崩）；
 *   - 没有 event 名或没有 data 的帧直接丢弃。
 */
export function createSseParser(onFrame: (frame: SseRawFrame) => void): { push: (text: string) => void } {
  let buffer = ''
  let pendingCr = false

  function flushFrame(rawFrame: string): void {
    if (!rawFrame) return
    let name = ''
    let id: number | null = null
    const dataLines: string[] = []
    for (const line of rawFrame.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon >= 0 ? line.slice(0, colon) : line
      let value = colon >= 0 ? line.slice(colon + 1) : ''
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') name = value
      else if (field === 'data') dataLines.push(value)
      else if (field === 'id') {
        const parsed = Number(value)
        if (value.trim() !== '' && Number.isFinite(parsed)) id = parsed
      }
      // retry / 其它字段：小程序自己管重连节奏，忽略。
    }
    if (!name || dataLines.length === 0) return
    onFrame({ name, id, data: dataLines.join('\n') })
  }

  return {
    push(text: string): void {
      if (!text) return
      let chunk = text
      // 上一块以 \r 结尾：把 \r 补回来，跨块的 \r\n 才能被正确折叠。
      if (pendingCr) {
        chunk = `\r${chunk}`
        pendingCr = false
      }
      if (chunk.endsWith('\r')) {
        pendingCr = true
        chunk = chunk.slice(0, -1)
      }
      buffer += chunk.replace(/\r\n?/g, '\n')

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const rawFrame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        flushFrame(rawFrame)
        boundary = buffer.indexOf('\n\n')
      }
      if (buffer.length > SSE_MAX_BUFFER_CHARS) buffer = ''
    },
  }
}

// ─────────────────────────── SSE 事件

export interface AgentSseEvent {
  name: string
  /** 网关单调递增序号；0 = 该帧不参与续传（手动注入的边角）。 */
  eventId: number
  data: Record<string, unknown>
}

export interface AgentStreamOptions {
  /** 续传游标：只能接 > 它的帧。首次连传历史游标（event_counter）。 */
  lastEventId?: number
  onEvent: (event: AgentSseEvent) => void
  /** 首次确认链路真的能收流（包头或首个 chunk）。 */
  onConnected?: () => void
  /** 流彻底不可用（chunked 不支持 / 连续重连失败 / 无响应），只回调一次。 */
  onUnavailable?: (reason: string) => void
}

export interface AgentStreamHandle {
  close: () => void
  /** 是否已经收到过任何 chunk（页面据此判断「发了消息却没有流」）。 */
  hasReceivedChunk: () => boolean
  /** 当前续传游标：页面重开流时必须带它，否则网关会重放已渲染过的 delta。 */
  getCursor: () => number
  /** 流是否已终结（close / onUnavailable 之后为 true）。 */
  isClosed: () => boolean
}

interface RequestTaskLike {
  abort: () => void
  onHeadersReceived?: (callback: (result: unknown) => void) => void
  onChunkReceived?: (callback: (result: { data: ArrayBuffer }) => void) => void
}

function toArrayBuffer(raw: unknown): ArrayBuffer | null {
  if (raw instanceof ArrayBuffer) return raw
  if (raw && typeof raw === 'object') {
    const view = raw as { buffer?: unknown; byteOffset?: unknown; byteLength?: unknown }
    if (view.buffer instanceof ArrayBuffer) {
      const offset = typeof view.byteOffset === 'number' ? view.byteOffset : 0
      const length = typeof view.byteLength === 'number' ? view.byteLength : view.buffer.byteLength - offset
      return view.buffer.slice(offset, offset + length)
    }
  }
  return null
}

/**
 * 连一条 SSE 流：mint 票 → Taro.request(enableChunked) → onChunkReceived 收流。
 *
 * 断线策略：任何 chunk 都算一次成功（退避计数清零）；断开/失败按 1s→2s→4s
 * 重连，最多 3 次，重连带同一个 last_event_id 续传。3 次仍失败、平台不支持
 * chunked、或 12s 内毫无响应 → onUnavailable，页面转 800ms 轮询兜底。
 */
export function connectAgentStream(sessionId: string, options: AgentStreamOptions): AgentStreamHandle {
  const decode = createUtf8Decoder()
  let cursor =
    typeof options.lastEventId === 'number' && Number.isFinite(options.lastEventId)
      ? Math.max(0, Math.floor(options.lastEventId))
      : 0

  let closed = false
  let receivedChunk = false
  let alive = false
  let failures = 0
  let generation = 0
  let task: RequestTaskLike | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null

  const parser = createSseParser((frame) => {
    if (closed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.data)
    } catch {
      // 脏帧（半帧 / 非 JSON）：跳过，不影响后续帧。
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const data = parsed as Record<string, unknown>
    const inlineId =
      typeof data.event_id === 'number' && Number.isFinite(data.event_id) ? (data.event_id as number) : 0
    const eventId = Math.max(frame.id ?? 0, inlineId)
    // 续传防重：eventId 已落在当前游标或之前＝重放帧/重复投递，直接丢弃。
    // eventId=0 是网关手动注入的边角帧（不参与续传），永不拦截。
    if (eventId > 0 && eventId <= cursor) return
    if (eventId > cursor) cursor = eventId
    options.onEvent({ name: frame.name, eventId, data })
  })

  function clearTimers(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }

  function teardownTask(): void {
    const current = task
    task = null
    if (!current) return
    try {
      current.abort()
    } catch {
      // 请求已结束：abort 无效，忽略。
    }
  }

  function markAlive(): void {
    const first = !alive
    alive = true
    failures = 0
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    if (first) options.onConnected?.()
  }

  function giveUp(reason: string): void {
    if (closed) return
    closed = true
    generation += 1
    clearTimers()
    teardownTask()
    options.onUnavailable?.(reason)
  }

  function scheduleReconnect(): void {
    if (closed) return
    generation += 1
    teardownTask()
    if (failures >= SSE_RECONNECT_DELAYS_MS.length) {
      giveUp('reconnect_exhausted')
      return
    }
    const delay = SSE_RECONNECT_DELAYS_MS[failures]
    failures += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void open()
    }, delay)
  }

  async function open(): Promise<void> {
    if (closed) return
    clearTimers()
    const seq = ++generation
    // 每一代连接都重新等待首包：上一代收过 chunk 不代表这一代还活着。
    alive = false

    let ticket: AgentSseTicket
    try {
      ticket = await requestSseTicket(sessionId)
    } catch {
      if (closed || seq !== generation) return
      scheduleReconnect()
      return
    }
    if (closed || seq !== generation) return

    const url = buildEventsUrl(ticket.events_url, ticket.ticket, cursor)
    // SSE 请求只带 ticket（query），不带站内 Authorization / x-user-id。
    // enableChunked / onChunkReceived 在 @tarojs/taro 4.3 的类型里已声明，
    // 但只有 weapp 真机与开发者工具实现；下面仍按结构探测，缺桩就走兜底。
    let requestTask: ReturnType<typeof Taro.request>
    try {
      requestTask = Taro.request({
        url,
        method: 'GET',
        header: { Accept: 'text/event-stream' },
        enableChunked: true,
        timeout: SSE_REQUEST_TIMEOUT_MS,
      })
    } catch {
      giveUp('request_failed')
      return
    }

    const handle = requestTask as unknown as RequestTaskLike
    task = handle

    if (typeof handle.onChunkReceived !== 'function') {
      giveUp('chunk_not_supported')
      return
    }

    handle.onChunkReceived((res) => {
      if (closed || seq !== generation) return
      markAlive()
      receivedChunk = true
      const buffer = toArrayBuffer((res as { data?: unknown })?.data)
      if (!buffer) return
      const text = decode(buffer)
      if (text) parser.push(text)
    })

    if (typeof handle.onHeadersReceived === 'function') {
      handle.onHeadersReceived(() => {
        if (closed || seq !== generation) return
        markAlive()
      })
    }

    // 首包看门狗：既无响应头也无 chunk → 链路在小程序里不可用。
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null
      if (closed || seq !== generation) return
      if (alive) return
      giveUp('no_response')
    }, SSE_FIRST_RESPONSE_TIMEOUT_MS)

    // 请求 Promise：流正常结束（网关轮换/超时）或 HTTP 非 2xx 都会走到这里，
    // 两者都按「断开重连续传」处理；票过期由下一次 open() 重新 mint。
    void (requestTask as unknown as Promise<unknown>)
      .then(() => {
        if (closed || seq !== generation) return
        scheduleReconnect()
      })
      .catch(() => {
        if (closed || seq !== generation) return
        scheduleReconnect()
      })
  }

  void open()

  return {
    close: () => {
      if (closed) return
      closed = true
      generation += 1
      clearTimers()
      teardownTask()
    },
    hasReceivedChunk: () => receivedChunk,
    getCursor: () => cursor,
    isClosed: () => closed,
  }
}

// ─────────────────────────── 轮询兜底

export interface AgentPollingOptions {
  intervalMs?: number
  onSnapshot: (snapshot: AgentHistorySnapshot) => void
  onError?: (error: unknown) => void
}

export interface AgentPollingHandle {
  stop: () => void
  /** 立即拉一次（页面切换兜底时不必等第一个 interval）。 */
  pollNow: () => Promise<void>
}

/**
 * 轮询签名：条目结构与文字尾部 + 事件游标。相同签名不回调，避免每 800ms
 * 无意义 setItems（小程序 setData 比 React 重渲染更贵）。
 */
function historySignature(snapshot: AgentHistorySnapshot): string {
  const parts = snapshot.items.map((item) => {
    switch (item.kind) {
      case 'user':
      case 'assistant':
        return `${item.kind}:${item.id}:${item.text.length}:${item.text.slice(-32)}`
      case 'tool':
        return `tool:${item.id}:${item.status}`
      case 'image':
      case 'video':
      case 'audio':
        return `${item.kind}:${item.id}:${item.seq}`
      default:
        return `${item.kind}:${item.id}`
    }
  })
  return parts.concat(String(snapshot.eventCounter)).join('|')
}

/**
 * 800ms 轮询 GET /api/agent/sessions/{id} 拉对话记录。
 *
 * 只在 SSE 确认不可用时启用，页面对用户不提示降级。内容没变化（签名相同）
 * 不回调，避免每 800ms 无意义重渲染。
 */
export function startAgentPolling(sessionId: string, options: AgentPollingOptions): AgentPollingHandle {
  const interval = options.intervalMs && options.intervalMs > 0 ? options.intervalMs : AGENT_POLL_INTERVAL_MS
  let stopped = false
  let inflight = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let signature: string | null = null

  async function pollOnce(): Promise<void> {
    if (stopped || inflight) return
    inflight = true
    try {
      const snapshot = await fetchAgentHistory(sessionId)
      if (stopped) return
      const nextSignature = historySignature(snapshot)
      if (nextSignature !== signature) {
        signature = nextSignature
        options.onSnapshot(snapshot)
      }
    } catch (error) {
      if (!stopped) options.onError?.(error)
    } finally {
      inflight = false
    }
  }

  function schedule(): void {
    if (stopped) return
    timer = setTimeout(() => {
      timer = null
      void pollOnce().then(schedule, schedule)
    }, interval)
  }

  void pollOnce().then(schedule, schedule)

  return {
    stop: () => {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
    pollNow: pollOnce,
  }
}

// ─────────────────────────── 中止（照 src/lib/agent-chat-client/session.ts:341）

/** 强制中止当前生成轮：POST /api/agent/sessions/{id}/abort。 */
export async function abortAgentSession(sessionId: string): Promise<void> {
  await request({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/abort`,
    method: 'POST',
    data: {},
  })
}

// ─────────────────────────── 思考级别（真源：agent-settings.ts）
//
// 判定与持久化全部委托 agent-settings.ts（白名单 / 默认值 / 三栏映射唯一真源），
// 这里只保留页面已经在用的函数名，避免两套 mapping 漂移。

/** 读当前应显示的思考级别（显式缓存 → 由 settings 反推 → medium）。 */
export function readCachedThinkingLevel(): AgentThinkingLevel {
  return resolveAgentThinkingLevel(readCachedAgentSettings())
}

/** 挂载时回读网关设定并解析级别；任何失败回本地缓存/medium（永不 reject）。 */
export async function fetchAgentThinkingLevel(): Promise<AgentThinkingLevel> {
  const result = await getAgentSettings()
  if (!result.ok) throw new ApiError(result.message, 0, 'settings_unavailable')
  const level = serverAgentThinkingLevel(result.settings)
  writeCachedAgentThinkingLevel(level)
  return level
}

/** 保存级别：本地缓存立即生效，再异步持久化到网关（合并现有设定，保留其它栏位）。 */
export async function saveAgentThinkingLevel(level: AgentThinkingLevel): Promise<void> {
  const result = await saveAgentSettings(agentThinkingLevelPatch(level))
  if (!result.ok) throw new ApiError(result.message, 0, 'settings_save_failed')
  writeCachedAgentThinkingLevel(serverAgentThinkingLevel(result.settings))
}

// 设定 API 对外导出（另一路 agent 依赖）。
export {
  DEFAULT_AGENT_SETTINGS,
  AGENT_SETTINGS_STORAGE_KEY,
  AGENT_THINKING_LEVEL_STORAGE_KEY,
  AGENT_THINKING_LEVELS,
  AGENT_THINKING_LEVEL_SETTINGS,
  COST_MODES,
  INTERACTION_MODES,
  INTERRUPT_MODES,
  PERSONA_MODES,
  agentThinkingLevelPatch,
  getAgentSettings,
  inferAgentThinkingLevel,
  readCachedAgentSettings,
  resolveAgentThinkingLevel,
  sanitizeAgentSettings,
  saveAgentSettings,
  writeCachedAgentSettings,
  writeCachedAgentThinkingLevel,
} from './agent-settings'
export type {
  AgentCostMode,
  AgentInteractionMode,
  AgentInterruptMode,
  AgentPersonaMode,
  AgentSettings,
  AgentThinkingLevel,
} from './agent-settings'

// ─────────────────────────── 问答 / 资产（照 session.ts 与 AgentChatSurface 的既有端点）

/** 回复一次 opencode question（照 src/lib/agent-chat-client/session.ts:242-246）。 */
export async function replyAgentQuestion(
  sessionId: string,
  requestId: string,
  answers: string[][],
): Promise<void> {
  await request({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/question`,
    method: 'POST',
    data: { request_id: requestId, answers },
  })
}

/** 资产包（只取「我的资产」面板要显示的栏位，形状照 src/lib/asset-pack-store.ts:88-96）。 */
export interface AgentAssetPack {
  id: string
  title: string
  digest?: string
  items: Array<{ title?: string }>
  active?: boolean
  tags?: string[]
}

/** 拉资产包列表（AgentChatSurface.session-actions.ts:139：GET /api/assets?q=）。 */
export async function listAgentAssets(query = ''): Promise<AgentAssetPack[]> {
  const trimmed = query.trim()
  const data = await request<Record<string, unknown>>({
    path: trimmed ? `/api/assets?q=${encodeURIComponent(trimmed)}` : '/api/assets',
  })
  const packs = data?.packs
  if (!Array.isArray(packs)) return []
  return packs.filter(
    (pack): pack is AgentAssetPack =>
      typeof pack === 'object' && pack !== null && typeof (pack as AgentAssetPack).id === 'string',
  )
}

/**
 * 使用此包：把该包 active:true 写回（AgentChatSurface.session-actions.ts:209-215）。
 * request.ts 的 HttpMethod 未收录 PUT，这里按同一套鉴权头直连 Taro.request。
 */
export async function activateAgentAssetPack(pack: AgentAssetPack): Promise<boolean> {
  const token = getToken()
  const userId = getUserId()
  if (!token || userId === null) return false
  try {
    const response = await Taro.request({
      url: `${BASE_URL}/api/assets`,
      method: 'PUT',
      header: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-user-id': String(userId),
      },
      data: { ...pack, active: true },
    })
    return response.statusCode >= 200 && response.statusCode < 300
  } catch {
    return false
  }
}

// ─────────────────────────── SSE 数据解析（事件名与栏位以 types-events.ts 为唯一真源）
//
// 网页端把「事件 → 可渲染条目」的规则写在 src/lib/agent-chat-reducer/：
//   reduce-messages.ts  消息 / 工具 / 媒体 / 计划 / 通知 / 会话终结
//   reduce-runs.ts      subagent.started / delta / done / tool
//   actions.ts          steer.status
// 小程序沿用同一套规则，只裁掉本页不渲染的栏位（seq / recipe / 画布事件）。

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readArray(source: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = source[key]
  return Array.isArray(value) ? value : undefined
}

function readObject(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key]
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function readBool(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return typeof value === 'boolean' ? value : undefined
}

/** 事件条目的稳定 id（reduce-core.ts:7-9：`<kind>-<event_id>`）。 */
function eventItemId(kind: string, eventId: number): string {
  return `${kind}-${eventId}`
}

/** 多行文本的最后一个非空行（reduce-core.ts:79-85）。 */
export function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) return lines[i]
  }
  return ''
}

/** 思维链计时结算（reduce-core.ts:35-38）。 */
function settleReasoningMs(
  item: Extract<AgentItem, { kind: 'assistant' }>,
  now: number,
): number | undefined {
  if (item.reasoningStartedAt === undefined || item.reasoningMs !== undefined) return undefined
  return Math.max(0, now - item.reasoningStartedAt)
}

type ToolItem = Extract<AgentItem, { kind: 'tool' }>

/** reduce-core.ts:51-74：成品/失败事件结算 pending 工具卡（task_id 精确 → 最旧兜底）。 */
function settlePendingToolItems(
  items: AgentItem[],
  taskId: string | undefined,
  status: 'ok' | 'failed',
  errorText?: string,
): AgentItem[] {
  let fallback = -1
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]
    if (it.kind !== 'tool' || it.status !== 'pending') continue
    if (taskId !== undefined && it.taskId === taskId) {
      const next = items.slice()
      next[i] = { ...it, status, ...(errorText !== undefined ? { error: errorText } : {}) }
      return next
    }
    if (fallback < 0) fallback = i
  }
  if (fallback < 0) return items
  const target = items[fallback]
  if (target.kind !== 'tool') return items
  return items.map((it, i) => (i === fallback ? { ...target, status, ...(errorText !== undefined ? { error: errorText } : {}) } : it))
}

/** reduce-core.ts:97-114：收尾停 streaming、running 工具判死（pending 不判死）。 */
function settleItems(items: AgentItem[]): AgentItem[] {
  return items.map((it) => {
    if (it.kind === 'assistant' && it.streaming) {
      const reasoningMs = settleReasoningMs(it, Date.now())
      return reasoningMs === undefined
        ? { ...it, streaming: false }
        : { ...it, streaming: false, reasoningMs }
    }
    if (it.kind === 'tool' && it.status === 'running') return { ...it, status: 'failed' as const }
    return it
  })
}

/** reduce-runs.ts:192-215：已定态子代理条目转存产出卡（running 原样保留）。 */
function retireSubagentItems(items: AgentItem[]): AgentItem[] {
  return items.map((it) => {
    if (it.kind !== 'subagent' || it.status === 'running') return it
    const full = (it.text ?? '').trim()
    const summary = it.summary?.trim() ?? ''
    const text = summary.length > full.length ? summary : full
    return {
      kind: 'subagent_result' as const,
      id: `${it.id}-result`,
      subagentId: it.subagentId,
      label: it.label,
      status: it.status,
      text,
    }
  })
}

/** reduce-runs.ts:14-28：把 started 的子代理绑到最近一张未绑定的派遣工具卡。 */
function linkDispatchToolItem(items: AgentItem[], subagentId: string): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]
    if (it.kind === 'tool' && it.tool === 'subagent_dispatch' && it.status === 'running' && it.subagentId === undefined) {
      items[i] = { ...it, subagentId }
      return true
    }
  }
  return false
}

/** reduce-runs.ts:39-56：子代理定案时同步结算绑定的派遣工具卡（F1）。 */
function settleLinkedDispatchTool(items: AgentItem[], subagentId: string, outcome: 'ok' | 'error' | 'stopped'): void {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]
    if (it.kind !== 'tool' || it.subagentId !== subagentId) continue
    if (outcome !== 'error') {
      if (it.status !== 'running') return
      items[i] = { ...it, status: 'ok' }
      return
    }
    if (it.status === 'failed') return
    items[i] = { ...it, status: 'failed' }
    return
  }
}

/** sse-parse.ts:21-33：授权三选一；缺省由渲染层回落三档全列。 */
function parseAuthOptions(value: unknown): AgentToolAuthScope[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { options?: unknown }).options)
      ? ((value as { options: unknown[] }).options)
      : []
  const seen = new Set<AgentToolAuthScope>()
  for (const entry of raw) {
    const scope = typeof entry === 'string' ? entry : readString(entry as Record<string, unknown>, 'scope')
    if (scope === 'once' || scope === 'session' || scope === 'permanent') seen.add(scope)
  }
  return (['once', 'session', 'permanent'] as const).filter((scope) => seen.has(scope))
}

/** sse-parse.ts:41-48：二进位读取侦测（U+FFFD 占比 ≥0.5% 且样本 ≥64 字元）。 */
function detectBinaryText(preview: unknown): boolean {
  if (typeof preview !== 'string' || preview.length < 64) return false
  let replacement = 0
  for (let i = 0; i < preview.length; i += 1) {
    if (preview.charCodeAt(i) === 0xfffd) replacement += 1
  }
  return replacement / preview.length >= 0.005
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return out.length > 0 ? out : undefined
}

/** 解析 question.request（types-events.ts:8-16）；缺 request_id 或 questions 整帧丢弃。 */
export function parseQuestionRequest(data: Record<string, unknown>): AgentPendingQuestion | null {
  const requestId = readString(data, 'request_id')
  const rawQuestions = readArray(data, 'questions')
  if (!requestId || !rawQuestions) return null
  const questions: AgentQuestionItem[] = []
  for (const entry of rawQuestions) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const question = readString(record, 'question')
    if (!question) continue
    const rawOptions = readArray(record, 'options') ?? []
    const options = rawOptions
      .filter((option): option is Record<string, unknown> => !!option && typeof option === 'object')
      .map((option) => {
        const label = readString(option, 'label')
        const description = readString(option, 'description')
        return { label, ...(description ? { description } : {}) }
      })
      .filter((option) => option.label.length > 0)
    const header = readString(record, 'header')
    questions.push({ question, ...(header ? { header } : {}), options })
  }
  if (questions.length === 0) return null
  return {
    requestId,
    questions,
    seq: typeof data.event_id === 'number' ? data.event_id : 0,
  }
}

/** 解析 turn.plan（types-events.ts:273-292）：plan 是唯一必需栏位。 */
export interface ParsedTurnPlan {
  plan: string
  experts?: string[]
  provisional?: boolean
  superseded: boolean
}

export function parseTurnPlan(data: Record<string, unknown>): ParsedTurnPlan | null {
  const plan = readString(data, 'plan')
  if (!plan.trim()) return null
  const experts = strArray(data.experts)
  const provisional = readBool(data, 'provisional')
  return {
    plan,
    ...(experts ? { experts } : {}),
    ...(provisional !== undefined ? { provisional } : {}),
    superseded: readBool(data, 'superseded') === true,
  }
}

/** 解析 steer.status（types-events.ts:391-400）。 */
export interface ParsedSteerStatus {
  steerId: string
  status: AgentSteerStatus
  position?: number
}

const STEER_STATUSES: readonly AgentSteerStatus[] = [
  'queued',
  'injected',
  'applied',
  'aborted',
  'failed',
  'uncertain',
]

export function parseSteerStatus(data: Record<string, unknown>): ParsedSteerStatus | null {
  const steerId = readString(data, 'steer_id')
  const status = readString(data, 'status')
  if (!steerId || !STEER_STATUSES.includes(status as AgentSteerStatus)) return null
  const position = readNumber(data, 'position')
  return {
    steerId,
    status: status as AgentSteerStatus,
    ...(position !== undefined ? { position } : {}),
  }
}

/** 解析 quota.changed（types-events.ts:311-320）。 */
export interface ParsedQuotaChanged {
  balanceCoins: number | null
  currency: string
  available: boolean
  spendable?: boolean
  reason?: string
}

export function parseQuotaChanged(data: Record<string, unknown>): ParsedQuotaChanged | null {
  const raw = data.balance_coins
  // 缺字段 / 非数字且非 null → 整帧丢弃；null = 上游明说余额未知。
  if (raw !== null && !(typeof raw === 'number' && Number.isFinite(raw))) return null
  const balanceCoins = raw as number | null
  const currency = readString(data, 'currency') || 'coin'
  const spendable = readBool(data, 'spendable')
  const reason = readString(data, 'reason')
  return {
    balanceCoins,
    currency,
    available: data.available === true,
    ...(spendable !== undefined ? { spendable } : {}),
    ...(reason ? { reason } : {}),
  }
}

/** 解析 video.done / audio.done（types-events.ts:225-253）。 */
export interface ParsedMediaDone {
  url: string
  costCoins?: number
  taskId?: string
  mediaKind?: string
  title?: string
  cover?: string
  lyricStatus?: string
}

export function parseMediaDone(data: Record<string, unknown>): ParsedMediaDone | null {
  const url = readString(data, 'url')
  if (!url) return null
  const costCoins = readNumber(data, 'cost_coins')
  const taskId = readString(data, 'task_id')
  const mediaKind = readString(data, 'media_kind')
  const title = readString(data, 'title')
  const cover = readString(data, 'cover')
  const lyricStatus = readString(data, 'lyric_status')
  return {
    url,
    ...(costCoins !== undefined ? { costCoins } : {}),
    ...(taskId ? { taskId } : {}),
    ...(mediaKind ? { mediaKind } : {}),
    ...(title ? { title } : {}),
    ...(cover ? { cover } : {}),
    ...(lyricStatus ? { lyricStatus } : {}),
  }
}

/** 解析 director.done（types-events.ts:262-288）：plan/active_shot 可 null。 */
export interface ParsedDirectorDone {
  sessionId: string
  revision: number
  action: string
  plan: AgentDirectorPlan | null
  activeShot: AgentDirectorShot | null
  schematic: { top_view_svg: string; camera_view_svg: string }
  health: { ok: boolean; issues: Array<{ code: string; message: string; shot_id?: string }> }
  counts: { shots: number; elements: number; actions: number }
}

export function parseDirectorDone(data: Record<string, unknown>): ParsedDirectorDone | null {
  const sessionId = readString(data, 'session_id')
  const revision = readNumber(data, 'revision')
  if (!sessionId || revision === undefined) return null
  const planRaw = readObject(data, 'plan')
  const plan: AgentDirectorPlan | null = planRaw
    ? {
        id: readString(planRaw, 'id'),
        name: readString(planRaw, 'name'),
        summary: readString(planRaw, 'summary'),
        shot_count: readNumber(planRaw, 'shot_count') ?? 0,
      }
    : null
  const shotRaw = readObject(data, 'active_shot')
  const activeShot: AgentDirectorShot | null = shotRaw
    ? {
        no: readNumber(shotRaw, 'no') ?? 0,
        name: readString(shotRaw, 'name'),
        duration_frames: readNumber(shotRaw, 'duration_frames') ?? 0,
        camera_move: readString(shotRaw, 'camera_move'),
        shot_scale: readString(shotRaw, 'shot_scale') || null,
      }
    : null
  const schematicRaw = readObject(data, 'schematic')
  const healthRaw = readObject(data, 'health')
  const countsRaw = readObject(data, 'counts')
  const issuesRaw = healthRaw ? readArray(healthRaw, 'issues') ?? [] : []
  return {
    sessionId,
    revision,
    action: readString(data, 'action'),
    plan,
    activeShot,
    schematic: {
      top_view_svg: schematicRaw ? readString(schematicRaw, 'top_view_svg') : '',
      camera_view_svg: schematicRaw ? readString(schematicRaw, 'camera_view_svg') : '',
    },
    health: {
      ok: healthRaw ? healthRaw.ok === true : true,
      issues: issuesRaw
        .filter((issue): issue is Record<string, unknown> => !!issue && typeof issue === 'object')
        .map((issue) => {
          const shotId = readString(issue, 'shot_id')
          return {
            code: readString(issue, 'code'),
            message: readString(issue, 'message'),
            ...(shotId ? { shot_id: shotId } : {}),
          }
        }),
    },
    counts: {
      shots: countsRaw ? readNumber(countsRaw, 'shots') ?? 0 : 0,
      elements: countsRaw ? readNumber(countsRaw, 'elements') ?? 0 : 0,
      actions: countsRaw ? readNumber(countsRaw, 'actions') ?? 0 : 0,
    },
  }
}

/** SUBAGENT_TOOL_CAP（reduce-runs.ts:130）。 */
const SUBAGENT_TOOL_CAP = 6

/** steer 终态冻结（reduce-core.ts:121-129）。 */
function isSteerTerminal(status: AgentSteerStatus): boolean {
  return status === 'applied' || status === 'aborted' || status === 'failed' || status === 'injected' || status === 'uncertain'
}

/**
 * SSE 事件 → 可渲染条目。纯函数；不认识的帧原样返回输入阵列。
 * 规则逐条照 src/lib/agent-chat-reducer/（行号见各分支注释）。
 */
export function reduceAgentItems(items: AgentItem[], event: AgentSseEvent): AgentItem[] {
  const data = event.data ?? {}
  const eventId = event.eventId
  switch (event.name) {
    // reduce-messages.ts:7-44
    case 'message.delta': {
      const text = readString(data, 'text')
      if (!text) return items
      const next = items.slice()
      const last = next[next.length - 1]
      if (last && last.kind === 'assistant' && last.streaming) {
        const reasoningMs = settleReasoningMs(last, Date.now())
        next[next.length - 1] =
          reasoningMs === undefined
            ? { ...last, text: last.text + text }
            : { ...last, text: last.text + text, reasoningMs }
        return next
      }
      for (let i = 0; i < next.length; i += 1) {
        const it = next[i]
        if (it.kind === 'plan' && it.collapsed === false) next[i] = { ...it, collapsed: true }
      }
      next.push({ kind: 'assistant', id: eventItemId('assistant', eventId), text, streaming: true })
      return next
    }
    // reduce-messages.ts:46-72
    case 'reasoning.delta': {
      const text = readString(data, 'text')
      if (!text) return items
      const next = items.slice()
      const last = next[next.length - 1]
      if (last && last.kind === 'assistant' && last.streaming) {
        next[next.length - 1] = {
          ...last,
          reasoning: (last.reasoning ?? '') + text,
          ...(last.reasoningStartedAt === undefined ? { reasoningStartedAt: Date.now() } : {}),
        }
        return next
      }
      next.push({
        kind: 'assistant',
        id: eventItemId('assistant', eventId),
        text: '',
        reasoning: text,
        reasoningStartedAt: Date.now(),
        streaming: true,
      })
      return next
    }
    // reduce-messages.ts:74-94
    case 'tool.invoke': {
      const tool = readString(data, 'tool')
      if (!tool) return items
      const next = items.slice()
      const last = next[next.length - 1]
      if (last && last.kind === 'assistant') {
        const reasoningMs = settleReasoningMs(last, Date.now())
        if (reasoningMs !== undefined) next[next.length - 1] = { ...last, reasoningMs }
      }
      const argsSummary = readString(data, 'args_summary')
      next.push({
        kind: 'tool',
        id: eventItemId('tool', eventId),
        tool,
        ...(argsSummary ? { argsSummary } : {}),
        status: 'running',
      })
      return next
    }
    // reduce-messages.ts:96-109
    case 'tool.progress': {
      const tool = readString(data, 'tool')
      const done = readNumber(data, 'done')
      const total = readNumber(data, 'total')
      if (!tool || done === undefined || total === undefined || total <= 0) return items
      const label = readString(data, 'label')
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const it = items[i]
        if (it.kind === 'tool' && it.tool === tool && it.status === 'running') {
          const next = items.slice()
          next[i] = { ...it, progress: { done, total, ...(label ? { label } : {}) } }
          return next
        }
      }
      return items
    }
    // reduce-messages.ts:111-197
    case 'tool.result': {
      const tool = readString(data, 'tool')
      if (!tool) return items
      const error = readObject(data, 'error') ?? {}
      const needsAuth =
        readString(error, 'code') === 'needs_authorization' ||
        readString(error, 'action_required') === 'authorize_local_files' ||
        readString(data, 'action_required') === 'authorize_local_files'
      const authOptions = parseAuthOptions(data.auth_options)
      const authRoot = readString(data, 'auth_root') || readString(error, 'root')
      const authReason = readString(data, 'auth_reason') || readString(error, 'reason')
      const actionRequired = readString(error, 'action_required') || readString(data, 'action_required')
      const authorization = needsAuth
        ? {
            ...(authRoot ? { root: authRoot } : {}),
            ...(authReason ? { reason: authReason } : {}),
            ...(actionRequired ? { actionRequired } : {}),
            options: authOptions,
          }
        : undefined
      const binary = data.binary === true || detectBinaryText(data.preview)
      const ok = data.ok === true
      const artifactPending = data.artifact_pending === true
      const errText = !ok && !needsAuth
        ? readString(error, 'human_message') || readString(error, 'message') || undefined
        : undefined
      const errCode = !ok && !needsAuth ? readString(error, 'code') || undefined : undefined
      const status: ToolItem['status'] = needsAuth ? 'needs_auth' : !ok ? 'failed' : artifactPending ? 'pending' : 'ok'
      const costCoins = readNumber(data, 'cost_coins')
      const taskId = readString(data, 'task_id') || undefined
      const readBytes = readNumber(data, 'bytes_read')
      const totalBytes = readNumber(data, 'bytes_total')
      const truncated = readBool(data, 'truncated')
      const next = items.slice()
      let target = -1
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const it = next[i]
        if (it.kind === 'tool' && it.tool === tool && it.status === 'running') {
          target = i
          break
        }
      }
      if (target >= 0) {
        const existing = next[target] as ToolItem
        next[target] = {
          ...existing,
          status,
          ...(costCoins !== undefined ? { costCoins } : {}),
          ...(errText ? { error: errText } : {}),
          ...(errCode ? { errorCode: errCode } : {}),
          ...(authorization ? { authorization } : {}),
          ...(binary ? { binary: true } : {}),
          ...(readBytes !== undefined ? { readBytes } : {}),
          ...(totalBytes !== undefined ? { totalBytes } : {}),
          ...(truncated !== undefined ? { truncated } : {}),
          ...(taskId ? { taskId } : {}),
        }
        return next
      }
      next.push({
        kind: 'tool',
        id: eventItemId('tool', eventId),
        tool,
        status,
        ...(costCoins !== undefined ? { costCoins } : {}),
        ...(errText ? { error: errText } : {}),
        ...(errCode ? { errorCode: errCode } : {}),
        ...(authorization ? { authorization } : {}),
        ...(binary ? { binary: true } : {}),
        ...(readBytes !== undefined ? { readBytes } : {}),
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
        ...(taskId ? { taskId } : {}),
      })
      return next
    }
    // reduce-messages.ts:198-221
    case 'image.done': {
      const url = readString(data, 'url')
      if (!url) return items
      const settled = settlePendingToolItems(items, readString(data, 'task_id') || undefined, 'ok')
      if (settled.some((it) => it.kind === 'image' && it.url === url)) return settled
      const costCoins = readNumber(data, 'cost_coins')
      const taskId = readString(data, 'task_id') || undefined
      const rawRecipe = readObject(data, 'recipe')
      const recipe = rawRecipe && typeof rawRecipe.prompt === 'string' && typeof rawRecipe.model === 'string' ? { prompt: rawRecipe.prompt, model: rawRecipe.model, ...(typeof rawRecipe.lora === 'string' ? { lora: rawRecipe.lora } : {}), ...(rawRecipe.loraModelVersionIds ? { loraModelVersionIds: rawRecipe.loraModelVersionIds } : {}), ...(typeof rawRecipe.size === 'string' ? { size: rawRecipe.size } : {}) } : undefined
      return [
        ...settled,
        {
          kind: 'image',
          id: eventItemId('image', eventId),
          url,
          seq: items.filter((it) => it.kind === 'image').length + 1,
          ...(recipe ? { recipe } : {}),
          ...(costCoins !== undefined ? { costCoins } : {}),
          ...(taskId ? { taskId } : {}),
        },
      ]
    }
    // reduce-messages.ts:223-244（video.done）
    case 'video.done': {
      const parsed = parseMediaDone(data)
      if (!parsed) return items
      const settled = settlePendingToolItems(items, parsed.taskId, 'ok')
      if (settled.some((it) => it.kind === 'video' && it.url === parsed.url)) return settled
      const mediaKind = parsed.mediaKind === 'film' ? 'film' : parsed.mediaKind === 'video' ? 'video' : undefined
      return [
        ...settled,
        {
          kind: 'video',
          id: eventItemId('video', eventId),
          url: parsed.url,
          seq: items.filter((it) => it.kind === 'video').length + 1,
          ...(parsed.costCoins !== undefined ? { costCoins: parsed.costCoins } : {}),
          ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
          ...(mediaKind ? { mediaKind } : {}),
        },
      ]
    }
    // reduce-messages.ts:246-271（audio.done）
    case 'audio.done': {
      const parsed = parseMediaDone(data)
      if (!parsed) return items
      const settled = settlePendingToolItems(items, parsed.taskId, 'ok')
      if (settled.some((it) => it.kind === 'audio' && it.url === parsed.url)) return settled
      const mediaKind = parsed.mediaKind === 'music' ? 'music' : parsed.mediaKind === 'audio' ? 'audio' : undefined
      return [
        ...settled,
        {
          kind: 'audio',
          id: eventItemId('audio', eventId),
          url: parsed.url,
          seq: items.filter((it) => it.kind === 'audio').length + 1,
          ...(parsed.costCoins !== undefined ? { costCoins: parsed.costCoins } : {}),
          ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
          ...(mediaKind ? { mediaKind } : {}),
          ...(parsed.title ? { title: parsed.title } : {}),
          ...(parsed.cover ? { cover: parsed.cover } : {}),
          ...(parsed.lyricStatus ? { lyricStatus: parsed.lyricStatus } : {}),
        },
      ]
    }
    // reduce-messages.ts:280-325（director.done：同槽按 revision 替换）
    case 'director.done': {
      const parsed = parseDirectorDone(data)
      if (!parsed) return items
      const next = items.slice()
      let existing = -1
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const it = next[i]
        if (it.kind === 'director' && it.directorSessionId === parsed.sessionId) {
          existing = i
          break
        }
      }
      if (existing >= 0) {
        const prev = next[existing]
        if (prev.kind === 'director') {
          if (parsed.revision > prev.revision || parsed.action === 'reset') {
            next[existing] = {
              ...prev,
              revision: parsed.revision,
              action: parsed.action,
              plan: parsed.plan,
              activeShot: parsed.activeShot,
              schematic: parsed.schematic,
              health: parsed.health,
              counts: parsed.counts,
            }
            return next
          }
          return items
        }
      }
      next.push({
        kind: 'director',
        id: eventItemId('director', eventId),
        directorSessionId: parsed.sessionId,
        revision: parsed.revision,
        action: parsed.action,
        plan: parsed.plan,
        activeShot: parsed.activeShot,
        schematic: parsed.schematic,
        health: parsed.health,
        counts: parsed.counts,
      })
      return next
    }
    // reduce-messages.ts:327-343
    case 'image.failed': {
      const taskId = readString(data, 'task_id') || undefined
      const reason = readString(data, 'reason')
      const human = readString(data, 'human_message')
      const refunded = data.refunded === true
      const text = refunded
        ? `这张图没排上队，费用已退回${reason ? `（${reason}）` : ''}。`
        : `这张图生成失败${reason ? `（${reason}）` : ''}。`
      const settled = settlePendingToolItems(items, taskId, 'failed', human || undefined)
      return [...settled, { kind: 'notice', id: eventItemId('notice', eventId), tone: 'error', text }]
    }
    // reduce-messages.ts:350-353 + reduce-runs.ts:192-215
    case 'turn.done':
      return retireSubagentItems(settleItems(items))
    // reduce-messages.ts:375-403
    case 'turn.plan': {
      const parsed = parseTurnPlan(data)
      if (!parsed) return items
      const next = items.slice()
      if (parsed.superseded) {
        for (let i = next.length - 1; i >= 0; i -= 1) {
          const it = next[i]
          if (it.kind === 'plan') {
            next[i] = {
              ...it,
              text: parsed.plan,
              ...(parsed.experts ? { experts: parsed.experts } : {}),
              ...(parsed.provisional !== undefined ? { provisional: parsed.provisional } : {}),
            }
            return next
          }
        }
      }
      next.push({
        kind: 'plan',
        id: eventItemId('plan', eventId),
        text: parsed.plan,
        ...(parsed.experts ? { experts: parsed.experts } : {}),
        ...(parsed.provisional !== undefined ? { provisional: parsed.provisional } : {}),
        collapsed: false,
      })
      return next
    }
    // reduce-messages.ts:454-485
    case 'confirm.resolved': {
      if (data.auto === true) return items
      const approved = data.approved === true
      const dedupeKey = approved ? 'confirm-approved' : 'confirm-denied'
      const last = items[items.length - 1]
      if (last && last.kind === 'notice' && last.dedupeKey === dedupeKey) {
        const count = (last.count ?? 1) + 1
        return [
          ...items.slice(0, -1),
          { ...last, count, text: approved ? `已同意 ${count} 笔花费。` : `已拒绝 ${count} 笔花费。` },
        ]
      }
      return [
        ...items,
        {
          kind: 'notice',
          id: eventItemId('notice', eventId),
          tone: 'info',
          text: approved ? '已同意该笔花费。' : '已拒绝该笔花费。',
          dedupeKey,
          count: 1,
        },
      ]
    }
    // reduce-messages.ts:428-439
    case 'question.replied': {
      const answer = readString(data, 'answer')
      return [
        ...items,
        {
          kind: 'notice',
          id: eventItemId('notice', eventId),
          tone: 'info',
          text: answer ? `已选择：${answer}` : '已回答该问题。',
        },
      ]
    }
    // reduce-messages.ts:441-452
    case 'question.rejected': {
      const reason = readString(data, 'reason')
      return [
        ...items,
        { kind: 'notice', id: eventItemId('notice', eventId), tone: 'info', text: reason || '该问题已取消。' },
      ]
    }
    // reduce-messages.ts:507-521
    case 'session.error': {
      const text = readString(data, 'human_message') || readString(data, 'message') || '会话出错了'
      return [...retireSubagentItems(items), { kind: 'notice', id: eventItemId('notice', eventId), tone: 'error', text }]
    }
    // reduce-messages.ts:544-552
    case 'session.closed':
      return [
        ...retireSubagentItems(settleItems(items)),
        { kind: 'notice', id: eventItemId('notice', eventId), tone: 'info', text: '会话已结束。' },
      ]
    // reduce-runs.ts:57-83
    case 'subagent.started': {
      const id = readString(data, 'id')
      const label = readString(data, 'label')
      if (!id || !label) return items
      const next = items.slice()
      linkDispatchToolItem(next, id)
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const it = next[i]
        if (it.kind === 'subagent' && it.subagentId === id) {
          if (it.label === label) return next
          next[i] = { ...it, label }
          return next
        }
      }
      next.push({
        kind: 'subagent',
        id: eventItemId('subagent', eventId),
        subagentId: id,
        label,
        lastLine: '',
        status: 'running',
      })
      return next
    }
    // reduce-runs.ts:85-125
    case 'subagent.delta': {
      const id = readString(data, 'id')
      const text = readString(data, 'text')
      if (!id || !text) return items
      const isReasoning = readString(data, 'kind') === 'reasoning'
      const next = items.slice()
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const it = next[i]
        if (it.kind === 'subagent' && it.subagentId === id) {
          if (it.status !== 'running') return items
          const activity = (it.activity ?? '') + text
          if (isReasoning) {
            next[i] = { ...it, activity }
            return next
          }
          const full = (it.text ?? '') + text
          next[i] = { ...it, text: full, lastLine: lastNonEmptyLine(full), activity }
          return next
        }
      }
      next.push({
        kind: 'subagent',
        id: eventItemId('subagent', eventId),
        subagentId: id,
        label: '子任务',
        lastLine: isReasoning ? '' : lastNonEmptyLine(text),
        ...(isReasoning ? {} : { text }),
        activity: text,
        status: 'running',
      })
      return next
    }
    // reduce-runs.ts:132-149
    case 'subagent.tool': {
      const id = readString(data, 'id')
      const callId = readString(data, 'call_id')
      const tool = readString(data, 'tool')
      const status = readString(data, 'status')
      if (!id || !callId || !tool || (status !== 'running' && status !== 'ok' && status !== 'failed')) return items
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const it = items[i]
        if (it.kind !== 'subagent' || it.subagentId !== id) continue
        if (it.status !== 'running') return items
        const prev = it.tools ?? []
        const index = prev.findIndex((entry) => entry.callId === callId)
        const entry: AgentSubagentToolEntry = { callId, tool, status }
        const tools = index >= 0 ? prev.map((item, j) => (j === index ? entry : item)) : [...prev, entry]
        const next = items.slice()
        next[i] = { ...it, tools: tools.slice(-SUBAGENT_TOOL_CAP) }
        return next
      }
      return items
    }
    // reduce-runs.ts:151-178
    case 'subagent.done': {
      const id = readString(data, 'id')
      const status = readString(data, 'status')
      if (!id || (status !== 'ok' && status !== 'error' && status !== 'stopped')) return items
      const summary = readString(data, 'summary')
      const next = items.slice()
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const it = next[i]
        if (it.kind === 'subagent' && it.subagentId === id) {
          next[i] = { ...it, status, ...(summary ? { summary } : {}) }
          settleLinkedDispatchTool(next, id, status)
          return next
        }
      }
      next.push({
        kind: 'subagent',
        id: eventItemId('subagent', eventId),
        subagentId: id,
        label: '子任务',
        lastLine: '',
        status,
        ...(summary ? { summary } : {}),
      })
      settleLinkedDispatchTool(next, id, status)
      return next
    }
    // 以下两帧不改条目：question.request 由 parseQuestionRequest 落 pendingQuestions，
    // quota.changed 由 parseQuotaChanged 更新余额（页面层消费）。
    case 'question.request':
    case 'quota.changed':
      return items
    // actions.ts:50-72
    case 'steer.status': {
      const parsed = parseSteerStatus(data)
      if (!parsed) return items
      let touched = false
      const next = items.map((item) => {
        if (item.kind !== 'user' || !item.steer || item.steer.id !== parsed.steerId) return item
        if (isSteerTerminal(item.steer.status)) return item
        touched = true
        return {
          ...item,
          steer: {
            id: parsed.steerId,
            status: parsed.status,
            ...(parsed.position !== undefined ? { position: parsed.position } : {}),
          },
        }
      })
      return touched ? next : items
    }
    default:
      return items
  }
}
