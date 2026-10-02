// 2026-10-01 replayBuffer 文字幀合併（思維鏈卡頓審計第 3 項）。
//
// 病灶：reasoning.delta / message.delta 幾乎逐 token 一幀，REPLAY_BUFFER_SIZE=1000
// 只夠裝 ~1000 個 token——一輪長思考就把 tool/canvas 等狀態幀全擠出緩衝，前端
// 斷線重連（Last-Event-ID）補不回完整思維鏈與正文。
//
// 修法：只在「replay 緩衝」這一層把連續同名純文字幀合成一個條目（直播客戶端仍逐幀
// 收到，零行為變化）。條目保留每段的 event id，重連時 Last-Event-ID 若落在合併段
// 中間，只補發該 id 之後的後綴——既不丟字也不重字。frame 惰性生成（追加只推陣列，
// 不在熱路徑重編碼整段，避免 O(n²)）。
//
// 本模組零 import（persistence ↔ sse-core ↔ sessions-core 已有循環，不再加邊）。

const enc = new TextEncoder()

/** 單條目合併上限（字元）：超過就開新條目，避免單幀過大。 */
export const REPLAY_MERGE_MAX_CHARS = 65536

function serialize(name: string, text: string, eventId: number): Uint8Array {
  const payload = JSON.stringify({ text, event_id: eventId })
  return enc.encode(`id: ${eventId}\nevent: ${name}\ndata: ${payload}\n\n`)
}

/** 可合併＝message.delta / reasoning.delta 且載荷只有 text 一個字串欄位。 */
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

  /** 整段幀（event_id＝最後一段 id）。惰性編碼、快取到下次 append。 */
  get frame(): Uint8Array {
    if (!this.cache) this.cache = serialize(this.name, this.texts.join(""), this.id)
    return this.cache
  }

  /** 最早一段的 id（replay_first_id 用）。 */
  get firstId(): number {
    return this.ids[0]
  }

  /** Last-Event-ID 落在本條目中間時：只補 afterId 之後的段。 */
  suffixFrame(afterId: number): Uint8Array {
    const k = this.ids.findIndex((i) => i > afterId)
    if (k <= 0) return this.frame
    return serialize(this.name, this.texts.slice(k).join(""), this.id)
  }

  /** 持久化形狀：段長（全文已在 frame 裡，不重存）。 */
  toPersisted(): { name: string; ids: number[]; lens: number[] } {
    return { name: this.name, ids: [...this.ids], lens: this.texts.map((t) => t.length) }
  }

  /** 由持久化的 frame 字串 + 段長還原；任何不一致回 null（呼叫方退回普通幀）。 */
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

/** replayBuffer 追加入口：文字幀併入尾條目，其餘幀原樣入列。
 *
 * `strippable=false` = 網關主動發出的耐久幀（工作流終態通報等，非模型產生）。
 * 這類幀永不與模型文字幀合併、也永不被 N2 strip 剝除——必須獨立成條目，
 * 晚重連（Last-Event-ID 續傳）時原樣回放。見 sse-core.stripStaleTurnTextFromReplay。 */
export function appendReplayFrame(
  buf: { id: number; frame: Uint8Array; strippable?: boolean }[],
  name: string,
  data: unknown,
  id: number,
  frame: Uint8Array,
  strippable = true,
): void {
  // 只有文字幀（message/reasoning.delta）需要帶耐久標記；其餘幀（turn.done/
  // canvas.* 等）本就不在 strip 範圍，照舊原樣入列，避免給每幀都加旗標。
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
 * N2 strip（stripStaleTurnTextFromReplay）的可剝判定——純函數，零依賴，可單測。
 * 只有模型產生的文字幀可剝（避免重投後整段重放舊文案）；
 * 網關主動發出的耐久幀（`strippable=false`，工作流終態通報等）永不剝，
 * 否則晚重連的 client 看不到通報（wf_muqfkhw7_1 事故根因）。
 */
export function isStrippableReplayEntry(f: { frame: Uint8Array; strippable?: boolean }): boolean {
  if (f instanceof MergedReplayFrame) return true // 合併條目只會是模型 message/reasoning.delta
  if (f.strippable === false) return false
  // 幀文本形如 "id: N\nevent: NAME\ndata: {...}\n\n"——事件名在第二行。
  const head = dec.decode(f.frame.subarray(0, Math.min(f.frame.length, 64)))
  const evMatch = head.match(/^id: \d+\nevent: ([a-z.]+)\n/)
  if (!evMatch) return false
  const ev = evMatch[1]
  return ev === "message.delta" || ev === "reasoning.delta"
}
