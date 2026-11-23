// opencode 全量历史 → 小程序 transcript 条目（纯函数）。
//
// 真源逐分支照搬 src/lib/agent-chat-history-normalize.ts（494 行）：
//   user.text / user.file / assistant.text / assistant.reasoning /
//   assistant.tool / assistant.file / step-start 等未知 part / system 角色
//   （子代理唤醒）/ 未知角色 / 脏资料。
//
// 为什么需要这层：「回到历史会话」由 GET /api/agent/sessions/[id] 的全量历史
// 重建 transcript，不再依赖网关 ring buffer 回放（长会话会被截断成空白）。
// opencode 的 messages 是 [{info:{id,role,time,tokens},parts:[...]}] 的原始
// shape，与小程序渲染模型（AgentItem）不同构，中间必须有忠实且防炸的映射层。
//
// 平台差异（types.ts 不在本刀所有权内，故按既有判别联合降级）：
//   - 网页版把 user.file 挂在用户气泡的 attachments 上；小程序 AgentItem
//     没有 attachments 栏位，改为按 mime/副档名输出 image / video / audio 卡片
//     （可见内容不丢）；document 类附件无处承载，计入 dropped 统计。
//   - user/assistant/tool/subagent_result 的 seq 栏位小程序类型未声明，时序由
//     数组顺序表达；只有 image/video/audio 需要 seq（「第 N 张」展示序号），
//     与网页版 imageSeq 语义逐字一致。
//
// 纪律：
//   - 纯函数：不碰 React / DOM / Date.now / Math.random，同输入同输出。
//   - 未知 part / 脏资料一律跳过不炸，并计进 droppedParts。
//   - 附件 URL 只收 http(s)：data: base64 严禁进本地存档。

import type { AgentItem } from '../components/agent-chat/types'

type Rec = Record<string, unknown>

/** opencode 原始讯息的最小形状（多余栏位原样忽略）。 */
export interface OpenCodeMessage {
  info?: unknown
  parts?: unknown
}

export interface NormalizeHistoryResult {
  items: AgentItem[]
  /** 被丢弃的 part 总数（未知型别、无公网 URL 的媒体、脏 tool 等）。 */
  droppedParts: number
  /** 丢弃原因分桶，key 为 part 型别或归类标签。 */
  droppedByType: Record<string, number>
}

// ─────────────────────────── 判型小工具

function asRecord(value: unknown): Rec | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 只认公网 http(s) URL：data: URI 是 base64，落存档会撑爆本地配额。 */
function isPublicUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)([?#]|$)/i
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)([?#]|$)/i
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|opus)([?#]|$)/i

/** 依 mime（优先）与副档名判媒体三类；判不出回 null。 */
function mediaKind(
  mime: string | undefined,
  name: string | undefined,
  url: string,
): 'image' | 'video' | 'audio' | null {
  if (mime) {
    if (mime.startsWith('image/')) return 'image'
    if (mime.startsWith('video/')) return 'video'
    if (mime.startsWith('audio/')) return 'audio'
  }
  for (const probe of [name, url]) {
    if (!probe) continue
    if (IMAGE_EXT.test(probe)) return 'image'
    if (VIDEO_EXT.test(probe)) return 'video'
    if (AUDIO_EXT.test(probe)) return 'audio'
  }
  return null
}

/** opencode tool part 的 state.status → 小程序状态枚举；判不了回 null（丢弃）。 */
function toolStatus(raw: unknown): 'ok' | 'failed' | 'running' | null {
  switch (raw) {
    case 'completed':
      return 'ok'
    case 'error':
      return 'failed'
    case 'running':
    case 'pending':
      return 'running'
    default:
      return null
  }
}

/** 工具参数摘要：字串直用，其余 JSON 化并截断（与 live 的 args_summary 同量级）。 */
function argsSummary(input: unknown): string | undefined {
  if (typeof input === 'string') return input.length > 200 ? `${input.slice(0, 200)}…` : input
  if (input === null || input === undefined) return undefined
  try {
    const s = JSON.stringify(input)
    return s.length > 200 ? `${s.slice(0, 200)}…` : s
  } catch {
    return undefined
  }
}

/** 失败原因：opencode 的 state.error 多为字串；物件退而取 message。 */
function toolErrorText(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.length > 0) return raw
  const rec = asRecord(raw)
  if (rec) {
    const msg = asString(rec.message)
    if (msg) return msg
  }
  return undefined
}

// ─────────────────────────── 子代理唤醒（历史回放的 system 角色）

// 真源 gateway/index.ts wakeSessionForSubagent；历史读路径已把这类讯息的
// role 改写成 "system"，归一化必须在这一侧还原成 subagent_result 产出卡，
// 否则刷新后子代理完成／失败报告整条消失。
const SUBAGENT_WAKE_RE =
  /^【子代理(完成|失败)·系统自动唤醒】subagent\s+([0-9A-Za-z]+)（label="([^"]*)"）已(?:完成|失败)。(?:结果摘要|失败原因)：/

/** 唤醒讯息尾部固定的续跑指令行（给模型的指令，不是产出内容）。 */
const SUBAGENT_WAKE_TAIL = '请基于以上真实结果继续推进'

function parseSubagentWake(
  text: string,
): { status: 'ok' | 'error'; subagentId: string; label: string; text: string } | null {
  if (!text.startsWith('【子代理完成·系统自动唤醒】') && !text.startsWith('【子代理失败·系统自动唤醒】')) {
    return null
  }
  const fallback = (): { status: 'ok' | 'error'; subagentId: string; label: string; text: string } => ({
    status: text.startsWith('【子代理失败') ? 'error' : 'ok',
    subagentId: /subagent\s+([0-9A-Za-z]+)/.exec(text)?.[1] ?? '',
    label: /label="([^"]*)"/.exec(text)?.[1] ?? '',
    text,
  })
  const m = SUBAGENT_WAKE_RE.exec(text)
  if (m === null) return fallback()
  let body = text.slice(m[0].length)
  const cut = body.indexOf(SUBAGENT_WAKE_TAIL)
  if (cut >= 0) body = body.slice(0, cut)
  return { status: m[1] === '完成' ? 'ok' : 'error', subagentId: m[2] ?? '', label: m[3] ?? '', text: body.trim() }
}

/** 副档名兜底判定 user.file 是否 document（小程序无 attachments 承载）。 */
function fileIsDocument(mime: string | undefined, name: string | undefined, url: string): boolean {
  return mediaKind(mime, name, url) === null
}

// ─────────────────────────── 内部框架段剥离

/** 内部框架段标题行（live 路径真源 gateway/outbound-sanitize.ts）。 */
export const INTERNAL_SECTION_HEADING_RE =
  /^#{1,6}[ \t]*(?:objective|work state|next move|relevant files|important details|completed|active|blocked|progress summary)[ \t]*:?[ \t]*$/i

const ANY_HEADING_RE = /^#{1,6}[ \t]/
const FENCE_RE = /^\s*(```|~~~)/

/**
 * assistant 历史文本的内部框架段剥离（live 路径 gateway 出站已剥、历史路径漏）：
 * `## Objective` 等标题行起吞到下一个非内部 markdown 标题或文本结束；
 * 代码栅栏（``` / ~~~）内容直通不判。无内部段时原样返回。
 */
export function stripInternalSections(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  if (!lines.some((l) => INTERNAL_SECTION_HEADING_RE.test(l))) return text
  const out: string[] = []
  let suppress = false
  let fence = false
  for (const line of lines) {
    if (fence) {
      out.push(line)
      if (FENCE_RE.test(line)) fence = false
      continue
    }
    if (FENCE_RE.test(line)) {
      fence = true
      out.push(line)
      continue
    }
    if (suppress) {
      if (ANY_HEADING_RE.test(line) && !INTERNAL_SECTION_HEADING_RE.test(line)) {
        suppress = false
        out.push(line)
      }
      continue
    }
    if (INTERNAL_SECTION_HEADING_RE.test(line)) {
      suppress = true
      continue
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ─────────────────────────── 归一化主体

/**
 * 把 opencode 原始讯息阵列重建为小程序 transcript。
 *
 * 映射表（part.type → item）：
 *   user.text      → 拼接进该轮 user item 的 text
 *   user.file      → image/video/audio 卡片（document/无公网 URL 丢弃计数）
 *   assistant.text → 顺次累积进当前 assistant item（工具/媒体卡会切断段落）
 *   assistant.reasoning → 并入 assistant item 的 reasoning 栏位
 *   assistant.tool → tool item（completed→ok / error→failed / running、pending→running）
 *   assistant.file → image/video/audio item（按 mime/副档名；判不出或无公网 URL 丢弃计数）
 *   system.text    → 仅子代理唤醒骨架还原成 subagent_result，其余丢弃计数
 *   其余（step-start/patch/…）→ 跳过并计数
 */
export function normalizeOpenCodeMessages(messages: readonly unknown[] | null | undefined): NormalizeHistoryResult {
  const items: AgentItem[] = []
  const droppedByType: Record<string, number> = {}
  let droppedParts = 0
  const drop = (type: string): void => {
    droppedParts += 1
    droppedByType[type] = (droppedByType[type] ?? 0) + 1
  }

  let userCount = 0
  // 媒体 seq：该 kind 会话内展示序号（镜像 reducer 的 imageSeq 语义）。
  let imageSeq = 0
  let videoSeq = 0
  let audioSeq = 0
  // 同 kind 同 url 去重（镜像 reducer 的 exists 守卫：重复完成帧不刷两张卡）。
  const seenMedia = new Set<string>()

  /**
   * 落地一张媒体卡。返回 false＝URL 不合法或型别判不出（已计入丢弃）。
   * dedupe=true 时同 kind 同 url 只出一次（用户附件按原样重复上传也应只显示一张）。
   */
  const pushMedia = (url: unknown, mime: string | undefined, filename: string | undefined): boolean => {
    if (!isPublicUrl(url)) {
      drop('file-no-public-url')
      return false
    }
    const kind = mediaKind(mime, filename, url)
    if (kind === null) {
      drop('media-unknown-kind')
      return false
    }
    const dedupeKey = `${kind}:${url}`
    if (seenMedia.has(dedupeKey)) return false
    seenMedia.add(dedupeKey)
    if (kind === 'image') {
      imageSeq += 1
      items.push({ kind: 'image', id: `image-h${items.length + 1}`, seq: imageSeq, url })
    } else if (kind === 'video') {
      videoSeq += 1
      items.push({ kind: 'video', id: `video-h${items.length + 1}`, seq: videoSeq, url })
    } else {
      audioSeq += 1
      items.push({ kind: 'audio', id: `audio-h${items.length + 1}`, seq: audioSeq, url })
    }
    return true
  }

  const pushSubagentReport = (wake: {
    status: 'ok' | 'error'
    subagentId: string
    label: string
    text: string
  }): void => {
    items.push({
      kind: 'subagent_result',
      id: `subagent-report-h${items.length + 1}`,
      subagentId: wake.subagentId,
      label: wake.label,
      status: wake.status,
      text: wake.text,
    })
  }

  for (const rawMsg of Array.isArray(messages) ? messages : []) {
    const msg = asRecord(rawMsg)
    const info = asRecord(msg?.info)
    const role = asString(info?.role)
    const rawParts: unknown = msg?.parts
    const parts = Array.isArray(rawParts) ? (rawParts as unknown[]) : null
    if (!parts) {
      drop('message')
      continue
    }

    if (role === 'user') {
      const texts: string[] = []
      const files: Array<{ mime?: string; filename?: string; url: string }> = []
      for (const rawPart of parts) {
        const part = asRecord(rawPart)
        const type = asString(part?.type) ?? 'malformed'
        if (!part) {
          drop(type)
          continue
        }
        if (type === 'text') {
          // 来源由 gateway 写入，不凭正文标题猜测（用户可能正在引用同一段指令）。
          const source = asRecord(asRecord(part.metadata)?.gateway)?.source
          if (source === 'system-injection' || (part.synthetic === true && source !== 'user-original')) {
            drop('system-injection')
            continue
          }
          const t = asString(part.text)
          if (t && t.trim().length > 0) texts.push(t)
          continue
        }
        if (type === 'file') {
          if (!isPublicUrl(part.url)) {
            drop('file-no-public-url')
            continue
          }
          const mime = asString(part.mime)
          const filename = asString(part.filename)
          if (fileIsDocument(mime, filename, part.url)) {
            // 小程序没有附件胶囊的承载栏位（types.ts 不在本刀所有权内）。
            drop('user-document-attachment')
            continue
          }
          files.push({ ...(mime ? { mime } : {}), ...(filename ? { filename } : {}), url: part.url })
          continue
        }
        drop(type)
      }
      const text = texts.join('\n')

      // 旧版网关历史里唤醒讯息仍是 user role：同样还原成产出卡，绝不画成用户气泡。
      const wake = parseSubagentWake(text)
      if (wake !== null) {
        pushSubagentReport(wake)
        continue
      }

      if (text.length === 0 && files.length === 0) continue
      if (text.length > 0) {
        userCount += 1
        items.push({ kind: 'user', id: `user-${userCount - 1}`, text })
      }
      for (const file of files) pushMedia(file.url, file.mime, file.filename)
      continue
    }

    if (role === 'system') {
      // 只认唤醒骨架 → subagent_result；其余 system 讯息是机制注入，绝不冒充用户气泡。
      const texts: string[] = []
      for (const rawPart of parts) {
        const part = asRecord(rawPart)
        const type = asString(part?.type) ?? 'malformed'
        if (!part) {
          drop(type)
          continue
        }
        if (type === 'text') {
          const t = asString(part.text)
          if (t && t.trim().length > 0) texts.push(t)
          continue
        }
        drop(type)
      }
      const text = texts.join('\n')
      const wake = parseSubagentWake(text)
      if (wake !== null) {
        pushSubagentReport(wake)
        continue
      }
      if (text.trim().length > 0) drop('system-message')
      continue
    }

    if (role !== 'assistant') {
      for (let i = 0; i < parts.length; i += 1) drop('unknown-role')
      continue
    }

    // assistant：text/reasoning 顺次累积；遇到 tool/file 先打断成卡，
    // 保持「文字→工具→文字→图」的原始时序。
    let pendingText: string[] = []
    let pendingReasoning: string[] = []
    const flush = (): void => {
      const text = stripInternalSections(pendingText.join('\n'))
      const reasoning = pendingReasoning.join('\n')
      pendingText = []
      pendingReasoning = []
      if (text.length === 0 && reasoning.length === 0) return
      items.push({
        kind: 'assistant',
        id: `assistant-h${items.length + 1}`,
        text,
        // 历史已定案：false，让后续增量的 message.delta 开新条目而不是
        // 往僵尸气泡里续字。
        streaming: false,
        ...(reasoning.length > 0 ? { reasoning } : {}),
      })
    }

    for (const rawPart of parts) {
      const part = asRecord(rawPart)
      const type = asString(part?.type) ?? 'malformed'
      if (!part) {
        drop(type)
        continue
      }
      if (type === 'text') {
        const t = asString(part.text)
        if (t && t.trim().length > 0) pendingText.push(t)
        continue
      }
      if (type === 'reasoning') {
        const t = asString(part.text)
        if (t && t.trim().length > 0) pendingReasoning.push(t)
        continue
      }
      if (type === 'tool') {
        flush()
        const st = asRecord(part.state)
        const status = toolStatus(st?.status)
        const tool = asString(part.tool) ?? asString(part.name)
        if (!st || status === null || !tool) {
          drop('tool')
          continue
        }
        const item: Extract<AgentItem, { kind: 'tool' }> = {
          kind: 'tool',
          id: `tool-h${items.length + 1}`,
          tool,
          status,
        }
        const summary = argsSummary(st.input)
        if (summary !== undefined) item.argsSummary = summary
        if (status === 'failed') {
          const err = toolErrorText(st.error)
          if (err !== undefined) item.error = err
        }
        items.push(item)
        continue
      }
      if (type === 'file') {
        // 媒体卡会切断文字段落（同 tool 的处理）。
        flush()
        pushMedia(part.url, asString(part.mime), asString(part.filename))
        continue
      }
      // step-start / step-finish / patch / snapshot 等 opencode 内部片段：跳过计数。
      drop(type)
    }
    flush()
  }

  return { items, droppedParts, droppedByType }
}
