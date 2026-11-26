// 2026-10-01 replayBuffer 文字帧合并（思维链卡顿审计第 3 项）。
//
// 病灶：reasoning.delta / message.delta 几乎逐 token 一帧，REPLAY_BUFFER_SIZE=1000
// 只够装 ~1000 个 token——一轮长思考就把 tool/canvas 等状态帧全挤出缓冲，前端
// 断线重连（Last-Event-ID）补不回完整思维链与正文。
//
// 修法：只在「replay 缓冲」这一层把连续同名纯文字帧合成一个条目（直播客户端仍逐帧
// 收到，零行为变化）。条目保留每段的 event id，重连时 Last-Event-ID 若落在合并段
// 中间，只补发该 id 之后的后缀——既不丢字也不重字。frame 惰性生成（追加只推阵列，
// 不在热路径重编码整段，避免 O(n²)）。
//
// 本模组零 import（persistence ↔ sse-core ↔ sessions-core 已有循环，不再加边）。

const enc = new TextEncoder()

/** 单条目合并上限（字元）：超过就开新条目，避免单帧过大。 */
export const REPLAY_MERGE_MAX_CHARS = 65536

function serialize(name: string, text: string, eventId: number): Uint8Array {
  const payload = JSON.stringify({ text, event_id: eventId })
  return enc.encode(`id: ${eventId}\nevent: ${name}\ndata: ${payload}\n\n`)
}

/** 可合并＝message.delta / reasoning.delta 且载荷只有 text 一个字串栏位。 */
export function mergeableReplayText(name: string, data: unknown): string | null {
  if (name !== "message.delta" && name !== "reasoning.delta") return null
  if (!data || typeof data !== "object") return null
  const keys = Object.keys(data as object)
  if (keys.length !== 1 || keys[0] !== "text") return null
  const t = (data as { text?: unknown }).text
  return typeof t === "string" ? t : null
}

export class MergedReplayFrame {
  id: number
  readonly name: string
  readonly ids: number[]
  readonly texts: string[]
  private chars: number
  private cache: Uint8Array | null = null

  constructor(name: string, ids: number[], texts: string[]) {
    this.name = name
    this.ids = ids
    this.texts = texts
    this.id = ids[ids.length - 1]
    this.chars = texts.reduce((n, t) => n + t.length, 0)
  }

  canAppend(name: string, text: string): boolean {
    return name === this.name && this.chars + text.length <= REPLAY_MERGE_MAX_CHARS
  }

  append(id: number, text: string): void {
    this.ids.push(id)
    this.texts.push(text)
    this.id = id
    this.chars += text.length
    this.cache = null
  }

  /** 整段帧（event_id＝最后一段 id）。惰性编码、快取到下次 append。 */
  get frame(): Uint8Array {
    if (!this.cache) this.cache = serialize(this.name, this.texts.join(""), this.id)
    return this.cache
  }

  /** 最早一段的 id（replay_first_id 用）。 */
  get firstId(): number {
    return this.ids[0]
  }

  /** Last-Event-ID 落在本条目中间时：只补 afterId 之后的段。 */
  suffixFrame(afterId: number): Uint8Array {
    const k = this.ids.findIndex((i) => i > afterId)
    if (k <= 0) return this.frame
    return serialize(this.name, this.texts.slice(k).join(""), this.id)
  }

  /** 持久化形状：段长（全文已在 frame 里，不重存）。 */
  toPersisted(): { name: string; ids: number[]; lens: number[] } {
    return { name: this.name, ids: [...this.ids], lens: this.texts.map((t) => t.length) }
  }

  /** 由持久化的 frame 字串 + 段长还原；任何不一致回 null（呼叫方退回普通帧）。 */
  static fromPersisted(frame: string, m: { name?: unknown; ids?: unknown; lens?: unknown }): MergedReplayFrame | null {
    try {
      if (typeof m.name !== "string" || !Array.isArray(m.ids) || !Array.isArray(m.lens)) return null
      if (m.ids.length === 0 || m.ids.length !== m.lens.length) return null
      const line = frame.split("\n").find((l) => l.startsWith("data: "))
      if (!line) return null
      const text = (JSON.parse(line.slice(6)) as { text?: unknown }).text
      if (typeof text !== "string") return null
      const texts: string[] = []
      let off = 0
      for (const len of m.lens as number[]) {
        texts.push(text.slice(off, off + len))
        off += len
      }
      if (off !== text.length) return null
      return new MergedReplayFrame(m.name, (m.ids as number[]).slice(), texts)
    } catch {
      return null
    }
  }
}

/** replayBuffer 追加入口：文字帧并入尾条目，其余帧原样入列。
 *
 * `strippable=false` = 网关主动发出的耐久帧（工作流终态通报等，非模型产生）。
 * 这类帧永不与模型文字帧合并、也永不被 N2 strip 剥除——必须独立成条目，
 * 晚重连（Last-Event-ID 续传）时原样回放。见 sse-core.stripStaleTurnTextFromReplay。 */
export function appendReplayFrame(
  buf: { id: number; frame: Uint8Array; strippable?: boolean }[],
  name: string,
  data: unknown,
  id: number,
  frame: Uint8Array,
  strippable = true,
): void {
  // 只有文字帧（message/reasoning.delta）需要带耐久标记；其余帧（turn.done/
  // canvas.* 等）本就不在 strip 范围，照旧原样入列，避免给每帧都加旗标。
  if (!strippable && (name === "message.delta" || name === "reasoning.delta")) {
    buf.push({ id, frame, strippable: false })
    return
  }
  const text = mergeableReplayText(name, data)
  if (text === null) {
    buf.push({ id, frame })
    return
  }
  const last = buf[buf.length - 1]
  if (last instanceof MergedReplayFrame && last.canAppend(name, text)) {
    last.append(id, text)
    return
  }
  buf.push(new MergedReplayFrame(name, [id], [text]))
}

const dec = new TextDecoder()

/**
 * N2 strip（stripStaleTurnTextFromReplay）的可剥判定——纯函数，零依赖，可单测。
 * 只有模型产生的文字帧可剥（避免重投后整段重放旧文案）；
 * 网关主动发出的耐久帧（`strippable=false`，工作流终态通报等）永不剥，
 * 否则晚重连的 client 看不到通报（wf_muqfkhw7_1 事故根因）。
 */
export function isStrippableReplayEntry(f: { frame: Uint8Array; strippable?: boolean }): boolean {
  if (f instanceof MergedReplayFrame) return true // 合并条目只会是模型 message/reasoning.delta
  if (f.strippable === false) return false
  // 帧文本形如 "id: N\nevent: NAME\ndata: {...}\n\n"——事件名在第二行。
  const head = dec.decode(f.frame.subarray(0, Math.min(f.frame.length, 64)))
  const evMatch = head.match(/^id: \d+\nevent: ([a-z.]+)\n/)
  if (!evMatch) return false
  const ev = evMatch[1]
  return ev === "message.delta" || ev === "reasoning.delta"
}
