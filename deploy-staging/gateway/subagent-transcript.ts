/**
 * subagent-transcript.ts — 子代理转录（用户可观察面）。
 *
 * 与既有 live `.md` 工作日志并存、互不改语义：每 run 一份**追加式 JSONL**，供前端按
 * 绝对字节位移增量拉取（同构 Claude Code DiskTaskOutput：追加写 + 位移读 + 上限淘汰）。
 *
 * 硬约束：
 *   - 只用 node:fs / node:path，无外部依赖；
 *   - 所有写路径同步、按需 mkdir；任何失败只 console.error，绝不向派工/收尾主流程抛错；
 *   - runId 一律经白名单校验后才拼路径，禁止把未校验字符串拼进文件系统路径；
 *   - 文件内字节位移是**绝对**的：淘汰头部时把丢弃字节数累加进旁档 meta.base_offset，
 *     读侧据此换算，offset 不漂移；
 *   - 轮转必须保留首行 meta（归属校验的唯一真源）；旁档另存 parent/label/agent/started_at，
 *     供文件被外部删除后重建与首行缺失时回退。
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"

const DEFAULT_TRANSCRIPT_DIR = "/opt/eimu-harness/workspace/outputs/subagent/transcripts"
const DEFAULT_MAX_BYTES = 4_000_000
const DEFAULT_ENTRY_MAX_BYTES = 32_768
const DEFAULT_READ_MAX_BYTES = 262_144
const MAX_LINE_SCAN_BYTES = 2_000_000
const LIST_MAX = 50
const LIST_END_TAIL_BYTES = 262_144
const META_HEAD_BYTES = 8_192
const FILE_MODE = 0o640
const LOCK_RETRIES = 3
const LOCK_RETRY_MS = 2
const STALE_LOCK_MS = 30_000
const FILE_READ_CHUNK = 1_048_576

/** 唯一的 runId 白名单真源（HTTP 层复用同一常量）。 */
export const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

function transcriptDir(): string {
  const fromEnv = process.env.SUBAGENT_TRANSCRIPT_DIR
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : DEFAULT_TRANSCRIPT_DIR
}

function maxTranscriptBytes(): number {
  const n = Number.parseInt(process.env.SUBAGENT_TRANSCRIPT_MAX_BYTES || "", 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES
}

function maxEntryBytes(): number {
  const n = Number.parseInt(process.env.SUBAGENT_TRANSCRIPT_ENTRY_MAX_BYTES || "", 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ENTRY_MAX_BYTES
}

function safeRunId(runId: unknown): string | null {
  return typeof runId === "string" && RUN_ID_RE.test(runId) ? runId : null
}

function jsonlPath(runId: string): string {
  return join(transcriptDir(), `${runId}.jsonl`)
}

function metaPath(runId: string): string {
  return join(transcriptDir(), `${runId}.meta.json`)
}

function ensureDir(): void {
  mkdirSync(transcriptDir(), { recursive: true })
}

interface TranscriptMeta {
  base_offset: number
  parent?: string
  label?: string
  agent?: string
  started_at?: number
}

function readMetaRecord(runId: string): TranscriptMeta {
  try {
    const parsed = JSON.parse(readFileSync(metaPath(runId), "utf8")) as Record<string, unknown>
    const n = Number(parsed?.base_offset)
    return {
      base_offset: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
      ...(typeof parsed?.parent === "string" ? { parent: parsed.parent } : {}),
      ...(typeof parsed?.label === "string" ? { label: parsed.label } : {}),
      ...(typeof parsed?.agent === "string" ? { agent: parsed.agent } : {}),
      ...(typeof parsed?.started_at === "number" && parsed.started_at > 0 ? { started_at: parsed.started_at } : {}),
    }
  } catch {
    return { base_offset: 0 }
  }
}

function writeMetaRecord(runId: string, patch: Partial<TranscriptMeta>): void {
  const merged = { ...readMetaRecord(runId), ...patch }
  const n = Number(merged.base_offset)
  const next: TranscriptMeta = {
    base_offset: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
    ...(typeof merged.parent === "string" ? { parent: merged.parent } : {}),
    ...(typeof merged.label === "string" ? { label: merged.label } : {}),
    ...(typeof merged.agent === "string" ? { agent: merged.agent } : {}),
    ...(typeof merged.started_at === "number" ? { started_at: merged.started_at } : {}),
  }
  const file = metaPath(runId)
  writeFileSync(file, JSON.stringify(next), { encoding: "utf8", mode: FILE_MODE })
  try {
    chmodSync(file, FILE_MODE)
  } catch {
    /* 权限调整失败不影响写入 */
  }
}

function readBaseOffset(runId: string): number {
  return readMetaRecord(runId).base_offset
}

function readFirstLine(runId: string, fileSize: number): Record<string, unknown> | null {
  if (fileSize <= 0) return null
  const len = Math.min(fileSize, META_HEAD_BYTES)
  const buf = Buffer.alloc(len)
  let fd: number | undefined
  try {
    fd = openSync(jsonlPath(runId), "r")
    const read = readSync(fd, buf, 0, len, 0)
    const text = buf.subarray(0, read).toString("utf8")
    const nl = text.indexOf("\n")
    const line = nl >= 0 ? text.slice(0, nl) : text
    if (!line) return null
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readLastEnd(runId: string, fileSize: number): { status?: string; summary?: string; t?: number } | null {
  if (fileSize <= 0) return null
  const len = Math.min(fileSize, LIST_END_TAIL_BYTES)
  const buf = Buffer.alloc(len)
  let fd: number | undefined
  try {
    fd = openSync(jsonlPath(runId), "r")
    const read = readSync(fd, buf, 0, len, fileSize - len)
    const lines = buf.subarray(0, read).toString("utf8").split("\n")
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.k !== "end") continue
        return {
          ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
          ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
          ...(typeof parsed.t === "number" ? { t: parsed.t } : {}),
        }
      } catch {
        // 非 JSON 行（例如被淘汰截断的头行）跳过
      }
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readRange(file: string, position: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0)
  const buf = Buffer.alloc(length)
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    const read = readSync(fd, buf, 0, length, position)
    return buf.subarray(0, read)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** filePos 是否落在行首：文件头或前一个字节是换行。 */
function isLineStart(file: string, position: number): boolean {
  if (position <= 0) return true
  const buf = Buffer.alloc(1)
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    const read = readSync(fd, buf, 0, 1, position - 1)
    return read === 1 && buf[0] === 0x0a
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/** 单个码点在 JSON 字符串内部的序列化字节数（不含两侧引号；转义字符按膨胀后计）。 */
function jsonCharBytes(ch: string): number {
  return byteLen(JSON.stringify(ch)) - 2
}

/** 按「序列化后字节预算」截断字符串。 */
function truncateJsonText(text: string, budget: number): string {
  if (budget <= 0) return ""
  let out = ""
  let used = 0
  for (const ch of text) {
    const cost = jsonCharBytes(ch)
    if (used + cost > budget) break
    out += ch
    used += cost
  }
  return out
}

/** 按「序列化后字节预算」切块；预算连单个码点都放不下时回空表（交给兜底路径）。 */
function splitJsonText(text: string, budget: number): string[] {
  if (budget <= 0) return []
  const chunks: string[] = []
  let current = ""
  let used = 0
  for (const ch of text) {
    const cost = jsonCharBytes(ch)
    if (used + cost > budget) {
      if (current) {
        chunks.push(current)
        current = ""
        used = 0
      }
      if (cost > budget) return []
    }
    current += ch
    used += cost
  }
  if (current) chunks.push(current)
  return chunks
}

/** 把一条 entry 编码成若干 JSONL 行，保证单行不超过上限、且绝不返回空表。 */
function encodeEntryLines(entry: Record<string, unknown>, limit: number): string[] {
  let raw: string
  try {
    raw = JSON.stringify(entry)
  } catch {
    return []
  }
  if (typeof raw !== "string") return []
  const rawLine = `${raw}\n`
  if (byteLen(rawLine) <= limit) return [rawLine]

  // 正文超限：按 JSON.stringify 之后的字节预算切块（引号/反斜线/换行会膨胀），不丢字。
  if (entry.k === "text" && typeof entry.s === "string") {
    const headEntry: Record<string, unknown> = { ...entry }
    delete headEntry.cont
    const headOverhead = byteLen(`${JSON.stringify({ ...headEntry, s: "" })}\n`)
    const contOverhead = byteLen(`${JSON.stringify({ ...headEntry, s: "", cont: true })}\n`)
    const budget = limit - Math.max(headOverhead, contOverhead)
    if (budget > 0) {
      const chunks = splitJsonText(entry.s, budget)
      if (chunks.length > 0) {
        const lines = chunks.map((s, index) =>
          index === 0
            ? `${JSON.stringify({ ...headEntry, s })}\n`
            : `${JSON.stringify({ ...headEntry, s, cont: true })}\n`,
        )
        if (lines.every((line) => byteLen(line) <= limit)) return lines
      }
    }
    // 极端小上限：至少落一条空正文，绝不静默丢弃整条。
    const textFallback = `${JSON.stringify({ ...headEntry, s: "", truncated: true })}\n`
    if (byteLen(textFallback) <= limit) return [textFallback]
  }

  // 其它 kind：保留形状（前端按 k 渲染），截断可长文字段并标 truncated:true。
  const trimmed: Record<string, unknown> = { ...entry, truncated: true }
  const stringFields = ["s", "summary", "url", "preview"].filter((key) => typeof trimmed[key] === "string")
  const emptyShape: Record<string, unknown> = { ...trimmed }
  for (const key of stringFields) emptyShape[key] = ""
  let budget = limit - byteLen(`${JSON.stringify(emptyShape)}\n`)
  for (const key of stringFields) {
    const value = trimmed[key]
    if (typeof value !== "string") continue
    if (budget <= 0) {
      trimmed[key] = ""
      continue
    }
    const kept = truncateJsonText(value, budget)
    trimmed[key] = kept
    budget -= byteLen(JSON.stringify(kept)) - 2
  }
  const trimmedLine = `${JSON.stringify(trimmed)}\n`
  if (byteLen(trimmedLine) <= limit) return [trimmedLine]

  // 兜底：极长非字符串字段（如超长 id/name）——只留可识别的最小形状。
  const minimalShape: Record<string, unknown> = { t: entry.t, k: entry.k, truncated: true, preview: "" }
  const previewBudget = limit - byteLen(`${JSON.stringify(minimalShape)}\n`)
  minimalShape.preview = truncateJsonText(raw, Math.max(0, previewBudget))
  const minimalLine = `${JSON.stringify(minimalShape)}\n`
  // 极端上限下宁可超限也不能丢条目（调用方会记日志）。
  return [minimalLine]
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 退化为立即重试 */
  }
}

function acquireTrimLock(runId: string): { fd: number; file: string } | null {
  const file = join(transcriptDir(), `${runId}.lock`)
  let reclaimed = false
  for (let i = 0; i < LOCK_RETRIES; i += 1) {
    try {
      const fd = openSync(file, "wx", FILE_MODE)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } catch {
        /* lock 内容仅诊断用 */
      }
      return { fd, file }
    } catch {
      // 只回收明显陈旧的锁（>30s），避免永久关闭轮转；新鲜锁继续退避。
      try {
        const st = statSync(file)
        if (!reclaimed && Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          reclaimed = true
          try {
            unlinkSync(file)
          } catch {
            /* 已被其他进程释放 */
          }
          try {
            const fd = openSync(file, "wx", FILE_MODE)
            try {
              writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
            } catch {
              /* ignore */
            }
            return { fd, file }
          } catch {
            /* 竞态输给别的进程，继续退避 */
          }
        }
      } catch {
        /* 无锁档或已被释放 */
      }
      sleepSync(LOCK_RETRY_MS)
    }
  }
  return null
}

function releaseTrimLock(lock: { fd: number; file: string }): void {
  try {
    closeSync(lock.fd)
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lock.file)
  } catch {
    /* ignore */
  }
}

/** 轮转：临时档 + rename 原子替换；抢不到 lock 就跳过本次裁剪（append 继续）。 */
function maybeTrim(runId: string): void {
  const file = jsonlPath(runId)
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return
  }
  if (size <= maxTranscriptBytes()) return
  const lock = acquireTrimLock(runId)
  if (!lock) return
  let temp: string | null = null
  try {
    const buf = readFileSync(file)
    // 首行 meta 是归属校验（getTranscriptParent／列表）的唯一真源，任何轮转都必须保留。
    const firstNl = buf.indexOf(0x0a)
    const headEnd = firstNl >= 0 ? firstNl + 1 : -1
    if (headEnd <= 0 || buf.indexOf(0x0a, headEnd) === -1) return
    const half = Math.floor(buf.length / 2)
    let cut = buf.indexOf(0x0a, Math.max(half, headEnd))
    // half 之后没有换行（尾部是一整条超长行）→ 退到最后一个换行，仍保证在首行之后。
    if (cut === -1) cut = buf.lastIndexOf(0x0a)
    const start = Math.max(cut >= 0 ? cut + 1 : -1, headEnd)
    if (start <= headEnd || start >= buf.length) return
    const keep = Buffer.concat([buf.subarray(0, headEnd), buf.subarray(start)])
    temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    writeFileSync(temp, keep, { mode: FILE_MODE })
    try {
      chmodSync(temp, FILE_MODE)
    } catch {
      /* 权限调整失败不影响替换 */
    }
    renameSync(temp, file)
    temp = null
    // 绝对位移继续对齐保留的尾部：尾部绝对起点 = oldBase + start，在新档里的下标 = headEnd。
    writeMetaRecord(runId, { base_offset: readBaseOffset(runId) + start - headEnd })
  } catch (trimError) {
    console.error(`[gateway] subagent transcript trim failed (ignored): id=${runId}`, trimError)
  } finally {
    if (temp) {
      try {
        unlinkSync(temp)
      } catch {
        /* 临时档清理失败不影响主流程 */
      }
    }
    releaseTrimLock(lock)
  }
}

/** 外部删除后重建：重建纳入 trim lock（多进程最多写一条 meta）；抢不到锁就不写 meta。 */
function rebuildIfMissing(runId: string): void {
  const file = jsonlPath(runId)
  if (existsSync(file)) return
  const lock = acquireTrimLock(runId)
  // 抢不到锁：让持锁方写 meta，本进程只 append 正文行（meta 行数最多 1）。
  if (!lock) return
  try {
    if (existsSync(file)) return
    const side = readMetaRecord(runId)
    if (!side.parent && !side.label && side.started_at === undefined) {
      closeSync(openSync(file, "a", FILE_MODE))
      try {
        chmodSync(file, FILE_MODE)
      } catch {
        /* ignore */
      }
      return
    }
    const metaLine = `${JSON.stringify({
      t: Date.now(),
      k: "meta",
      parent: side.parent ?? "",
      label: side.label ?? "",
      agent: side.agent ?? null,
      prompt_head: "",
      started_at: side.started_at ?? Date.now(),
    })}\n`
    const fd = openSync(file, "a", FILE_MODE)
    try {
      writeSync(fd, metaLine)
    } finally {
      closeSync(fd)
    }
    try {
      chmodSync(file, FILE_MODE)
    } catch {
      /* ignore */
    }
    // 新档从 0 重新编号；旧读者的旧 offset 会按越界处理，不会错位读到别的条目。
    writeMetaRecord(runId, { base_offset: 0 })
  } finally {
    releaseTrimLock(lock)
  }
}

export interface InitTranscriptInput {
  runId: string
  parentSessionId: string
  label: string
  agent?: string
  prompt?: string
  startedAt?: number
}

/** 建转录：文件已存在则幂等返回（绝不覆盖既有内容），并补齐缺失的旁档归属信息。 */
export function initTranscript(input: InitTranscriptInput): void {
  const runId = safeRunId(input?.runId)
  if (!runId) {
    console.error(`[gateway] subagent transcript init skipped: invalid runId=${String(input?.runId)}`)
    return
  }
  try {
    ensureDir()
    const parent = String(input.parentSessionId ?? "")
    const label = String(input.label ?? "")
    const agent = input.agent ?? ""
    const startedAt = typeof input.startedAt === "number" && input.startedAt > 0 ? input.startedAt : Date.now()
    const file = jsonlPath(runId)
    if (existsSync(file)) {
      const side = readMetaRecord(runId)
      if (!side.parent) writeMetaRecord(runId, { base_offset: side.base_offset, parent, label, agent, started_at: startedAt })
      return
    }
    const entry = {
      t: Date.now(),
      k: "meta",
      parent,
      label,
      agent: input.agent ?? null,
      prompt_head: typeof input.prompt === "string" ? input.prompt.slice(0, 400) : "",
      started_at: startedAt,
    }
    writeFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: FILE_MODE })
    try {
      chmodSync(file, FILE_MODE)
    } catch {
      /* 权限调整失败不影响写入 */
    }
    writeMetaRecord(runId, { base_offset: 0, parent, label, agent, started_at: startedAt })
  } catch (e) {
    console.error(`[gateway] subagent transcript init failed (ignored): id=${runId}`, e)
  }
}

/** 追加：单条 entry 超过上限时按 kind 切分/截断；轮转保留 meta；任何失败不外抛。 */
export function appendTranscript(runId: string, entry: Record<string, unknown>): void {
  const id = safeRunId(runId)
  if (!id || !entry || typeof entry !== "object") return
  let lines: string[]
  try {
    lines = encodeEntryLines(entry, maxEntryBytes())
  } catch (e) {
    console.error(`[gateway] subagent transcript encode failed (ignored): id=${id}`, e)
    return
  }
  if (lines.length === 0) {
    let bytes = 0
    try {
      bytes = byteLen(JSON.stringify(entry))
    } catch {
      /* 体积仅诊断用 */
    }
    // 绝不静默丢条目：编码失败必须留痕。
    console.error(
      `[gateway] subagent transcript entry dropped: id=${id} kind=${String(entry.k)} bytes=${bytes}`,
    )
    return
  }
  try {
    ensureDir()
    rebuildIfMissing(id)
    maybeTrim(id)
    appendFileSync(jsonlPath(id), lines.join(""))
  } catch (e) {
    console.error(`[gateway] subagent transcript append failed (ignored): id=${id}`, e)
  }
}

export interface TranscriptDelta {
  entries: object[]
  next_offset: number
  truncated: boolean
  eof: boolean
  size: number
  base_offset: number
  missing?: boolean
  skipped?: boolean
}

/** 按绝对字节位移增量读；只消费完整行；行首非法则回放；超长行保证游标推进。 */
export function readTranscriptDelta(runId: string, offset: number, readMaxBytes = DEFAULT_READ_MAX_BYTES): TranscriptDelta {
  const id = safeRunId(runId)
  const requested = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  if (!id) {
    return { entries: [], next_offset: requested, truncated: false, eof: true, size: 0, base_offset: 0, missing: true }
  }
  const file = jsonlPath(id)
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return { entries: [], next_offset: requested, truncated: false, eof: true, size: 0, base_offset: 0, missing: true }
  }
  const base = readBaseOffset(id)
  let filePos: number
  let truncated = false
  let badLineStart = false
  if (requested < base) {
    filePos = 0
    truncated = true
  } else {
    filePos = Math.min(requested - base, size)
    // 位移落在行中间（含多字节 UTF-8 字符中间）：不允许静默吞行，按 truncated 从 0 回放。
    if (filePos > 0 && filePos < size && !isLineStart(file, filePos)) {
      filePos = 0
      truncated = true
      badLineStart = true
    }
  }
  const want = Number.isFinite(readMaxBytes) && readMaxBytes > 0 ? Math.floor(readMaxBytes) : DEFAULT_READ_MAX_BYTES
  let chunk: Buffer = Buffer.alloc(0)
  let consumed = 0
  let skipped = false
  if (filePos < size) {
    chunk = readRange(file, filePos, Math.min(want, size - filePos))
    const nl = chunk.lastIndexOf(0x0a)
    consumed = nl >= 0 ? nl + 1 : 0
    if (consumed === 0 && chunk.length > 0 && filePos + chunk.length >= size) {
      // 文件以合法 JSON 结束但没有尾换行：按完整条目返回，游标推到 size。
      try {
        const parsed = JSON.parse(chunk.toString("utf8"))
        if (parsed && typeof parsed === "object") consumed = chunk.length
      } catch {
        /* 半行：保持现状（eof:false），等后续写入补全 */
      }
    }
    if (consumed === 0 && chunk.length > 0 && filePos + chunk.length < size) {
      // 已读满 want 且块内无换行：继续向后找这一行的结尾（最多再扫 MAX_LINE_SCAN_BYTES）。
      const scanStart = filePos + chunk.length
      const scanEnd = Math.min(size, scanStart + MAX_LINE_SCAN_BYTES)
      const extra = readRange(file, scanStart, scanEnd - scanStart)
      const found = extra.indexOf(0x0a)
      if (found >= 0) {
        chunk = Buffer.concat([chunk, extra.subarray(0, found + 1)])
        consumed = chunk.length
      } else if (scanEnd >= size) {
        // 直到 EOF 都没有换行：整段无法解析，跳过（游标推进到 EOF）。
        skipped = true
        filePos = size
        chunk = Buffer.alloc(0)
        consumed = 0
      } else {
        // 单行超过 2MB：跳到该行之后的下一个换行（或 EOF），保证 next_offset 必定推进。
        skipped = true
        let pos = scanEnd
        let nextNl = -1
        while (pos < size) {
          const block = readRange(file, pos, Math.min(FILE_READ_CHUNK, size - pos))
          if (block.length === 0) break
          const idx = block.indexOf(0x0a)
          if (idx >= 0) {
            nextNl = pos + idx
            break
          }
          pos += block.length
        }
        if (nextNl < 0) {
          filePos = size
          chunk = Buffer.alloc(0)
          consumed = 0
        } else {
          filePos = nextNl + 1
          chunk = readRange(file, filePos, Math.min(want, size - filePos))
          const nlAfter = chunk.lastIndexOf(0x0a)
          consumed = nlAfter >= 0 ? nlAfter + 1 : 0
        }
      }
    }
  }
  const entries: object[] = []
  if (consumed > 0) {
    const text = chunk.subarray(0, consumed).toString("utf8")
    for (const line of text.split("\n")) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === "object") entries.push(parsed as object)
      } catch {
        // 坏行跳过：读接口不得因单行损坏整体失败
      }
    }
  }
  // 越界 offset 按请求值保持单调；行中位移回放按实际推进（否则会原地重放永不前进）。
  const advanced = base + filePos + consumed
  const nextOffset = badLineStart ? advanced : Math.max(requested, advanced)
  return {
    entries,
    next_offset: nextOffset,
    truncated,
    eof: nextOffset >= base + size,
    size,
    base_offset: base,
    ...(skipped ? { skipped: true } : {}),
  }
}

export interface TranscriptListItem {
  runId: string
  label: string
  agent: string | null
  startedAt: number
  size: number
  baseOffset: number
  updatedAt: number
  endStatus?: string
  summary?: string
  endAt?: number
}

const parentConflictWarned = new Set<string>()

/** 首行 parent 与旁档 parent 不一致：只记一次，不复述内容、不改返回形状。 */
function warnParentConflict(runId: string, headParent?: string, sideParent?: string): void {
  if (headParent === undefined || sideParent === undefined || headParent === sideParent) return
  if (parentConflictWarned.has(runId)) return
  parentConflictWarned.add(runId)
  if (parentConflictWarned.size > 500) {
    const first = parentConflictWarned.values().next().value
    if (typeof first === "string") parentConflictWarned.delete(first)
  }
  console.warn(`[gateway] subagent transcript parent mismatch: id=${runId} head=${headParent} sidecar=${sideParent}`)
}

/** 扫描目录，按首行 meta.parent 过滤；首行缺失时回退旁档。mtime 倒序，最多 50 条。 */
export function listTranscriptsForParent(parentSessionId: string): TranscriptListItem[] {
  if (typeof parentSessionId !== "string" || !parentSessionId) return []
  let names: string[]
  try {
    names = readdirSync(transcriptDir())
  } catch {
    return []
  }
  const rows: Array<{ runId: string; size: number; mtime: number }> = []
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue
    const runId = name.slice(0, -".jsonl".length)
    if (!safeRunId(runId)) continue
    try {
      const st = statSync(join(transcriptDir(), name))
      if (!st.isFile()) continue
      rows.push({ runId, size: st.size, mtime: st.mtimeMs })
    } catch {
      // 单个文件读取失败不挡列表
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  const out: TranscriptListItem[] = []
  for (const row of rows) {
    if (out.length >= LIST_MAX) break
    const head = readFirstLine(row.runId, row.size)
    const side = readMetaRecord(row.runId)
    const headIsMeta = head !== null && head.k === "meta"
    const headParent = headIsMeta && typeof head.parent === "string" ? head.parent : undefined
    warnParentConflict(row.runId, headParent, side.parent)
    const parent = headParent ?? side.parent
    if (parent !== parentSessionId) continue
    const label = headIsMeta && typeof head.label === "string" ? head.label : side.label ?? ""
    const agent = headIsMeta && typeof head.agent === "string" ? head.agent : side.agent ?? ""
    const startedRaw = headIsMeta && typeof head.started_at === "number" ? head.started_at : side.started_at
    const end = readLastEnd(row.runId, row.size)
    out.push({
      runId: row.runId,
      label,
      agent,
      startedAt: typeof startedRaw === "number" && startedRaw > 0 ? startedRaw : row.mtime,
      size: row.size,
      baseOffset: side.base_offset,
      updatedAt: row.mtime,
      ...(end?.status ? { endStatus: end.status } : {}),
      ...(end?.summary ? { summary: end.summary } : {}),
      ...(typeof end?.t === "number" ? { endAt: end.t } : {}),
    })
  }
  return out
}

/** 列表合并 live run 用：是否有转录、字节数、是否已发生头部淘汰。 */
export function getTranscriptInfo(runId: string): { available: boolean; bytes: number; truncated: boolean } {
  const id = safeRunId(runId)
  if (!id) return { available: false, bytes: 0, truncated: false }
  try {
    const st = statSync(jsonlPath(id))
    return { available: st.isFile(), bytes: st.isFile() ? st.size : 0, truncated: readBaseOffset(id) > 0 }
  } catch {
    return { available: false, bytes: 0, truncated: false }
  }
}

/** 归属校验：优先首行 meta.parent；首行缺失/损坏时回退旁档。 */
export function getTranscriptParent(runId: string): string | undefined {
  const id = safeRunId(runId)
  if (!id) return undefined
  let size = 0
  try {
    size = statSync(jsonlPath(id)).size
  } catch {
    return readMetaRecord(id).parent
  }
  const head = readFirstLine(id, size)
  const sideParent = readMetaRecord(id).parent
  const headParent = head && head.k === "meta" && typeof head.parent === "string" ? head.parent : undefined
  warnParentConflict(id, headParent, sideParent)
  return headParent ?? sideParent
}
